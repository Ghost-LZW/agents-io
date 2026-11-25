package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The chat round trip: an item tagged chat or guest becomes a message in an assistant conversation, the turn's
// final answer is delivered to the item's reply route through the router, and the channel message is marked. Every
// step writes its state to the journal BEFORE the request that must not be repeated, so a run found mid-request
// after a restart is an unknown outcome and is never sent again.

const (
	// guestMappingMost is how long a guest conversation is reused; the product keeps a guest record for 30 days.
	guestMappingMost = 29 * 24 * time.Hour
	// undecodableMost is how many transcript reads in a row may come back in a shape this program cannot read before
	// the run gives up: asking again gets the same answer.
	undecodableMost = 5
	// fullTriesMost is how often the whole text of a long answer is asked for before the run gives up.
	fullTriesMost = 3
	// scopeWaitMost caps the pause between two tries of a deliver the router refused with route_not_allowed.
	scopeWaitMost = 30 * time.Second
)

// worker starts a run for every conversation that has an item waiting and none under way: one run at a time per
// channel conversation, in arrival order. Nothing is started once the program is stopping.
func (x *app) worker(ctx context.Context) {
	defer x.bg.Done()
	tick := time.NewTicker(x.tm.tick)
	defer tick.Stop()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	x.prune()
	for {
		if ctx.Err() != nil {
			return
		}
		x.schedule(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-x.wakeCh:
		case <-prune.C:
			x.prune()
		}
	}
}

// prune bounds the journal and the mappings (store.prune), at start and every hour.
func (x *app) prune() {
	st := x.store()
	if st == nil {
		return
	}
	dropped, expired := st.prune(time.Now(), x.settings().keep)
	if dropped+expired > 0 {
		log.Printf("journal: %d record(s) dropped, %d old Inbox item(s) closed", dropped, expired)
	}
}

func (x *app) wake() {
	select {
	case x.wakeCh <- struct{}{}:
	default:
	}
}

func (x *app) schedule(ctx context.Context) {
	st := x.store()
	if st == nil {
		return
	}
	heads := map[string]string{}
	var order []string
	for _, rec := range st.all() {
		if rec.State != stateQueued && rec.State != stateRunning {
			continue
		}
		if _, ok := heads[rec.ConvKey]; !ok {
			heads[rec.ConvKey] = rec.ID
			order = append(order, rec.ConvKey)
		}
	}
	for _, key := range order {
		if ctx.Err() != nil {
			return
		}
		// At most runsMost conversations at a time: a backlog pushed after a long outage must not start an assistant
		// process per conversation at once. The rest stay queued; every tick looks again.
		x.mu.Lock()
		busy := x.active[key] || len(x.active) >= max(1, x.tm.runsMost)
		if !busy {
			x.active[key] = true
		}
		x.mu.Unlock()
		if busy {
			continue
		}
		x.runs.Add(1)
		go func(key, id string) {
			defer x.runs.Done()
			x.runItem(ctx, id)
			x.mu.Lock()
			delete(x.active, key)
			x.mu.Unlock()
			if ctx.Err() == nil {
				x.wake()
			}
		}(key, heads[key])
	}
}

// runItem takes one item through its round trip, from wherever the journal says it stands.
func (x *app) runItem(ctx context.Context, id string) {
	st := x.store()
	rec, ok := st.get(id)
	if !ok {
		return
	}
	if rec.State == stateQueued || rec.Run == nil {
		var err error
		rec, err = st.update(id, func(r *itemRec) {
			r.State = stateRunning
			r.Run = &runRec{MsgID: "agentsio-" + short(id), StartedAt: time.Now().UTC()}
		})
		if err != nil {
			_ = sleep(ctx, x.tm.notSentRetry)
			return
		}
	}
	switch rec.Run.State {
	case runOpening:
		// The program stopped while the new conversation was being asked for.
		x.fail(ctx, rec, whyRestartUnsure)
		return
	case runSending:
		// The program stopped while the message was being sent: only the transcript can tell.
		rec, _ = st.update(id, func(r *itemRec) {
			r.Run.State, r.Run.Unsure, r.Run.SentAt = runSent, true, time.Now().UTC()
		})
	}
	if rec.Run.State == "" {
		if rec, ok = x.start(ctx, rec); !ok {
			return
		}
		x.mark(ctx, rec, markWorking)
	}
	if rec.Run.State == runSent {
		if rec, ok = x.watch(ctx, rec); !ok {
			return
		}
	}
	if rec.Run.State == runAnswered || rec.Run.State == runDelivering {
		x.deliverAnswer(ctx, rec)
	}
}

// fail ends a run without an answer in the channel: the item becomes an Inbox thing that needs the owner, with why,
// so nothing is lost silently. Nothing is posted to the channel beyond the failed mark.
func (x *app) fail(ctx context.Context, rec itemRec, why string) {
	st := x.store()
	rec, _ = st.update(rec.ID, func(r *itemRec) {
		r.State, r.Why, r.Inbox.Since = stateFailed, why, time.Now().UTC()
		if r.Run != nil {
			r.Run.Error = why
		}
	})
	x.keepSeq(rec)
	log.Printf("chat: item %s failed (%s)", short(rec.ID)[:12], failKind(why))
	x.mark(ctx, rec, markFailed)
	x.inboxChanged()
}

// failKind is a failure's name for the log (the sentences are for people).
func failKind(why string) string {
	for k, v := range map[string]string{
		"open_unknown": whyOpenUnknown, "send_unknown": whySendUnknown, "not_sent": whyNotSent, "refused": whyRefused,
		"not_found": whyNotFound, "missing": whyMissing, "timeout": whyTimeout, "no_answer": whyNoAnswer,
		"took_over": whyTookOver, "deliver_rejected": whyDeliverReject, "deliver_scope": whyDeliverScope,
		"deliver_unknown": whyDeliverUnsure, "restart_unknown": whyRestartUnsure, "deliver_offline": whyDeliverOffline,
		"unreadable": whyUnreadable, "answer_cut": whyAnswerCut,
	} {
		if v == why {
			return k
		}
	}
	return "other"
}

// keepSeq remembers how far the conversation's transcript was read, so the next run starts after it.
func (x *app) keepSeq(rec itemRec) {
	if rec.Run == nil || rec.Run.SessionID == "" {
		return
	}
	st := x.store()
	if c, ok := st.conv(rec.ConvKey); ok && c.SessionID == rec.Run.SessionID {
		if rec.Run.LastSeq > c.LastSeq {
			c.LastSeq = rec.Run.LastSeq
		}
		c.LastUsedAt = time.Now().UTC()
		_ = st.setConv(rec.ConvKey, c)
	}
}

// toInbox hands an item that cannot go to a conversation to the Inbox (not a failure: nothing was tried).
func (x *app) toInbox(rec itemRec, why string) {
	_, _ = x.store().update(rec.ID, func(r *itemRec) {
		r.State, r.Why, r.Run, r.Inbox.Since = stateInbox, why, nil, time.Now().UTC()
	})
	x.inboxChanged()
}

// start gives the item to the assistant: a new conversation when the channel conversation has none, else a message
// into the one it has. It answers false when the run ended here.
func (x *app) start(ctx context.Context, rec itemRec) (itemRec, bool) {
	st, hub := x.store(), x.hub()
	if hub == nil {
		x.toInbox(rec, whyNoHub)
		return rec, false
	}
	guest := rec.Tag == tagGuest
	text := prompt(rec)
	deadline := time.Now().Add(x.tm.notSentMost)
	wait := x.tm.notSentRetry
	for guest {
		ok, known := hub.guestOK(ctx)
		if ctx.Err() != nil {
			return rec, false
		}
		if known && ok {
			break
		}
		if known {
			// Never opened as an ordinary conversation instead: that one would have the owner's tools and data.
			x.toInbox(rec, whyNoGuest)
			return rec, false
		}
		// The question got no answer (the manager is away, a timeout): that says nothing about guest conversations.
		// Asked again like a start that was not sent; never started as an ordinary conversation meanwhile.
		if time.Now().After(deadline) {
			x.fail(ctx, rec, whyNotSent)
			return rec, false
		}
		if sleep(ctx, wait) != nil {
			return rec, false
		}
		wait = min(wait*2, time.Minute)
	}
	wait = x.tm.notSentRetry
	for {
		if ctx.Err() != nil {
			return rec, false // stopping: nothing is written that would look like a request under way
		}
		conv, mapped := st.conv(rec.ConvKey)
		if mapped && (conv.Guest != guest || guest && time.Since(conv.OpenedAt) > guestMappingMost) {
			mapped = false
		}
		out, renew := outRetry, false
		if !mapped {
			seed := "open/" + rec.ID
			if rec.Run.Reopened {
				seed += "/reopen"
			}
			if rec.Run.OpenTry > 0 {
				seed += "/" + strconv.Itoa(rec.Run.OpenTry)
			}
			var err error
			// The state is written before the request: a crash between the two is an unknown outcome, not a retry.
			if rec, err = st.update(rec.ID, func(r *itemRec) { r.Run.State, r.Run.OpID = runOpening, opUUID(seed) }); err == nil {
				var mid, sid string
				mid, sid, out, renew = hub.open(ctx, text, guest, rec.Run.OpID)
				if ctx.Err() != nil {
					return rec, false
				}
				switch out {
				case outSent:
					now := time.Now().UTC()
					_ = st.setConv(rec.ConvKey, convRec{MachineID: mid, SessionID: sid, Guest: guest, OpenedAt: now, LastUsedAt: now})
					rec, _ = st.update(rec.ID, func(r *itemRec) {
						r.Run.MachineID, r.Run.SessionID, r.Run.Head, r.Run.BaseSeq = mid, sid, true, 0
						r.Run.State, r.Run.SentAt = runSent, now
					})
					log.Printf("chat: item %s opened a conversation (guest=%v)", short(rec.ID)[:12], guest)
					return rec, true
				case outUnknown:
					x.fail(ctx, rec, whyOpenUnknown)
					return rec, false
				case outRefused, outGone:
					x.fail(ctx, rec, whyRefused)
					return rec, false
				}
			}
		} else {
			var err error
			if rec, err = st.update(rec.ID, func(r *itemRec) {
				r.Run.State, r.Run.MachineID, r.Run.SessionID = runSending, conv.MachineID, conv.SessionID
				r.Run.Head, r.Run.BaseSeq = false, conv.LastSeq
			}); err == nil {
				var status int
				var kept bool
				out, status, kept = hub.send(ctx, conv.MachineID, conv.SessionID, text, rec.Run.MsgID)
				if ctx.Err() != nil {
					return rec, false
				}
				if guest && out == outRefused && status == http.StatusForbidden {
					out = outGone // a guest conversation this token may no longer write to: a new one
				}
				switch out {
				case outSent, outUnknown:
					now := time.Now().UTC()
					rec, _ = st.update(rec.ID, func(r *itemRec) {
						r.Run.State, r.Run.SentAt, r.Run.Unsure, r.Run.Kept = runSent, now, out == outUnknown, kept
					})
					log.Printf("chat: item %s sent into its conversation (outcome %s)", short(rec.ID)[:12], out)
					return rec, true
				case outGone:
					// The conversation is no longer there and nothing was delivered: a new one, under a new operation.
					_ = st.dropConv(rec.ConvKey)
					rec, _ = st.update(rec.ID, func(r *itemRec) { r.Run.State, r.Run.Reopened, r.Run.OpenTry = "", true, 0 })
					continue
				case outRefused:
					x.fail(ctx, rec, whyRefused)
					return rec, false
				}
			}
		}
		// Certainly not sent: try again for a while. A start the hub refused with a receipt is replayed to the same
		// operation id, so the next try gets a new one (nothing was started under the old).
		rec, _ = st.update(rec.ID, func(r *itemRec) {
			r.Run.State = ""
			if renew {
				r.Run.OpenTry++
			}
		})
		if time.Now().After(deadline) {
			x.fail(ctx, rec, whyNotSent)
			return rec, false
		}
		if sleep(ctx, wait) != nil {
			return rec, false
		}
		wait = min(wait*2, time.Minute)
	}
}

// findMine is where the run's message is in the transcript: by its client_msg_id; else by the reference in its
// sender line (a node that ties no id to an item, and a conversation's first message, which never carries one);
// else, for a conversation this run opened, the first words of a person's when they come before any answer and carry
// no id of the app's. -1, true: a conversation this run opened whose first message is not listed, everything in it
// up to the next thing a person put in is the run's. A message the agent took in mid-turn says "queued" for good; it
// is in the conversation like any other (the product's channel pipeline reads it the same way).
func findMine(items []hubItem, run *runRec, token string) (int, bool) {
	for i, it := range items {
		if it.ClientMsgID != "" && it.ClientMsgID == run.MsgID {
			return i, true
		}
	}
	for i, it := range items {
		if it.Role == "user" && it.Kind == "text" && strings.Contains(it.Text, token) {
			return i, true
		}
	}
	if !run.Head {
		return 0, false
	}
	for i, it := range items {
		switch {
		case it.Role == "assistant" && it.Kind == "text":
			return -1, true // an answer already: the run's message is not listed
		case !it.typed():
			continue
		case it.ClientMsgID != "" && !strings.HasPrefix(it.ClientMsgID, "start:"), it.Kind != "text":
			return -1, true // sent from the app (its own id, or a picture): not the run's message
		default:
			return i, true
		}
	}
	return -1, true
}

// section is the run's part of the transcript: the items after its message up to the next thing a person put into
// the conversation that the extension did not send (the owner typing in the app or sending a picture; injected
// blocks, other sessions' messages and tool results do not count). cut says there is such a message. Only the
// assistant's words inside the section are ever delivered to the channel, so neither what the owner sent nor the
// answer to it gets there.
func section(items []hubItem, mine int, msgID string) (part []hubItem, cut bool) {
	for i := mine + 1; i < len(items); i++ {
		if it := items[i]; it.typed() && (it.ClientMsgID == "" || it.ClientMsgID != msgID) {
			return items[mine+1 : i], true
		}
	}
	return items[mine+1:], false
}

// finalAnswer is the last words the assistant wrote in the section, and whether the section ends in them.
func finalAnswer(part []hubItem) (answer *hubItem, endsInWords bool) {
	for i := len(part) - 1; i >= 0; i-- {
		if it := part[i]; it.Role == "assistant" && it.Kind == "text" && strings.TrimSpace(it.Text) != "" {
			return &part[i], i == len(part)-1
		}
	}
	return nil, false
}

// watch waits for the turn's result the way the product's own channel pipeline does: find the run's message, wait
// while the conversation is working or awaiting an answer, then take the assistant's last words after it. It
// answers false when the run ended here.
//
// A turn can write thousands of items, so a poll reads only what came after the last one seen and keeps the items
// from the run's message on. Before anything that ends the run (an answer, a failure) the transcript is read once
// more from the run's base, so the decision never rests on a page read minutes ago.
func (x *app) watch(ctx context.Context, rec itemRec) (itemRec, bool) {
	st, hub := x.store(), x.hub()
	if hub == nil {
		x.fail(ctx, rec, whyNoHub)
		return rec, false
	}
	run := rec.Run
	token := refToken(rec)
	limit := x.settings().chatWait
	lastSeq, lastChange := int64(-1), time.Now()
	var idleSince, missingSince time.Time
	var kept []hubItem   // the transcript from the run's message on (from its base until that is found)
	after := run.BaseSeq // how far the transcript was read
	pause := false       // wait a poll before the next pass
	stale := false       // what is known of the transcript was read before a pause
	undecodable, fullTries := 0, 0
	// again reads the transcript from the base without waiting: the next pass may then end the run.
	again := func() { kept, after, stale, pause = nil, run.BaseSeq, false, false }
	// end fails the run, remembering how far the transcript was read.
	end := func(why string) (itemRec, bool) {
		rec, _ = st.update(rec.ID, func(r *itemRec) { r.Run.LastSeq = max(r.Run.LastSeq, run.LastSeq) })
		x.fail(ctx, rec, why)
		return rec, false
	}
	for {
		if pause {
			if sleep(ctx, x.tm.poll) != nil {
				return rec, false
			}
			stale = true
		}
		pause = true
		now := time.Now()
		if now.Sub(run.StartedAt) > limit {
			return end(whyTimeout)
		}
		// The row first, the transcript after: when the row says the turn is over, the transcript read after it is whole.
		row, visible, lookErr := hub.look(ctx, run.MachineID, run.SessionID)
		page, complete, err := hub.items(ctx, run.MachineID, run.SessionID, after)
		if ctx.Err() != nil {
			return rec, false
		}
		if err != nil {
			var he *hubError
			switch {
			case errors.As(err, &he) && (he.status == http.StatusNotFound || he.status == http.StatusGone):
				if missingSince.IsZero() {
					missingSince = now
				}
				if now.Sub(missingSince) > x.tm.missingAfter {
					_ = st.dropConv(rec.ConvKey)
					x.fail(ctx, rec, whyMissing)
					return rec, false
				}
			case errors.Is(err, errUndecodable):
				// Not something to wait out: the same page comes back in the same shape.
				if undecodable++; undecodable >= undecodableMost {
					return end(whyUnreadable)
				}
			}
			continue
		}
		missingSince, undecodable = time.Time{}, 0
		kept = append(kept, page...)
		for _, it := range page {
			after = max(after, it.Seq)
		}
		top := max(run.LastSeq, after)
		if top != lastSeq {
			lastSeq, lastChange = top, now
		}
		run.LastSeq = top
		if !complete {
			pause = false // more to read right away; nothing is decided on a part of the transcript
			continue
		}
		mine, found := findMine(kept, run, token)
		if !found {
			kept = nil // the message is not in what was read: none of it is needed again
			// A message the manager holds is sent when the computer is back, which can take as long as any answer.
			most := x.tm.queuedMost
			if run.Kept {
				most = limit
			}
			if now.Sub(run.SentAt) > most {
				if stale {
					again()
					continue
				}
				if run.Unsure {
					return end(whySendUnknown)
				}
				return end(whyNotFound)
			}
			continue
		}
		if mine > 0 {
			kept, mine = kept[mine:], 0
		}
		part, cut := section(kept, mine, run.MsgID)
		answer, endsInWords := finalAnswer(part)
		// take ends the run with the answer, read in full when the page cut it. A cut answer is never delivered: its
		// last line would be the app's truncation note.
		take := func() (itemRec, bool, bool) {
			text := answer.Text
			if answer.FullSize > 0 {
				full, err := hub.full(ctx, run.MachineID, run.SessionID, answer.ID)
				switch {
				case ctx.Err() != nil:
					return rec, false, true
				case err != nil || strings.TrimSpace(full) == "":
					if fullTries++; fullTries >= fullTriesMost {
						rec, ok := end(whyAnswerCut)
						return rec, ok, true
					}
					return rec, false, false // asked again on the next pass
				}
				text = full
			}
			return x.answered(rec, text, top), true, true
		}
		if cut {
			if stale {
				again()
				continue
			}
			// The owner went on in the app: what the assistant said before that is the answer, if it said anything.
			if answer == nil {
				return end(whyTookOver)
			}
			if rec, ok, over := take(); over {
				return rec, ok
			}
			continue
		}
		if lookErr != nil {
			continue
		}
		busy := visible && row.busy()
		if !visible {
			// The row is not visible to this token: quiet means no new item for a while.
			busy = now.Sub(lastChange) < x.tm.quietGrace
		}
		if busy {
			if visible && !run.Seen {
				run.Seen = true
				rec, _ = st.update(rec.ID, func(r *itemRec) { r.Run.Seen = true })
				run = rec.Run
				run.LastSeq = top
			}
			idleSince = time.Time{}
			continue
		}
		if visible && !run.Seen && now.Sub(run.SentAt) < x.tm.quietGrace {
			continue // not seen working yet: the turn may not have started
		}
		if idleSince.IsZero() {
			idleSince = now
		}
		// A message taken in mid-turn after which nothing was said may still get a turn of its own.
		emptyGrace := x.tm.emptyGrace
		if mine >= 0 && kept[mine].Queued {
			emptyGrace = max(emptyGrace, x.tm.queuedMost)
		}
		switch {
		case answer != nil && (endsInWords || now.Sub(idleSince) >= x.tm.answerSettle):
			if stale {
				again()
				continue
			}
			if rec, ok, over := take(); over {
				return rec, ok
			}
		case answer == nil && now.Sub(idleSince) >= emptyGrace:
			if stale {
				again()
				continue
			}
			return end(whyNoAnswer)
		}
	}
}

func (x *app) answered(rec itemRec, answer string, top int64) itemRec {
	rec, _ = x.store().update(rec.ID, func(r *itemRec) {
		r.Run.State, r.Run.Answer, r.Run.LastSeq = runAnswered, cleanText(answer, 0), top
	})
	x.keepSeq(rec)
	return rec
}

// deliverAnswer sends the answer to the item's reply route. The operation id comes from the item, so asking again
// (after a reconnect, after a restart) never sends twice; a new id is never used for the same answer.
//
// What the router answers decides what happens next, by what it guarantees:
//   - no connection, "stopped" (the router is shutting down) or "unauthorized" (the key was refused): nothing was
//     sent and the operation id is not used up. The same operation is asked again on the next connection, for up to
//     deliverWaitMost;
//   - "route_not_allowed": nothing was sent either. It is the answer for a conversation outside this backend's
//     scope, for a reply target the router no longer accepts, and also while the channel is not running (a router
//     that just came back). Asked again without the reply target, then again for up to scopeRetryMost;
//   - any other refusal cannot change (a malformed frame, a frame this key may not send): the item fails at once;
//   - no answer, "internal" or status unknown: the message may be out. Asked once more, then left.
func (x *app) deliverAnswer(ctx context.Context, rec itemRec) {
	st := x.store()
	if rec.Route == nil || rec.Run.Answer == "" {
		x.fail(ctx, rec, whyNoAnswer)
		return
	}
	op := "reply-" + short(rec.ID)
	rec, _ = st.update(rec.ID, func(r *itemRec) { r.Run.State = runDelivering })
	began := time.Now()
	unsure := 0
	var scopeSince time.Time
	scopeWait := x.tm.unsureRetry
	for {
		rt := x.router()
		if rt == nil || !rt.connected() {
			if time.Since(began) > x.tm.deliverWaitMost {
				x.fail(ctx, rec, whyDeliverOffline)
				return
			}
			if sleep(ctx, x.tm.tick) != nil {
				return
			}
			continue
		}
		res, err := x.deliverOnce(ctx, op, *rec.Route, rec.Run.Answer)
		if ctx.Err() != nil {
			return
		}
		switch code := routerCode(err); {
		case errors.Is(err, errDisconnected):
			continue // nothing was sent
		case code == codeStopped || code == codeUnauthorized:
			if time.Since(began) > x.tm.deliverWaitMost {
				x.fail(ctx, rec, whyDeliverOffline)
				return
			}
			if sleep(ctx, x.tm.unsureRetry) != nil {
				return
			}
			continue
		case code == codeRouteNotAllowed:
			if scopeSince.IsZero() {
				scopeSince = time.Now()
			}
			if time.Since(scopeSince) > x.tm.scopeRetryMost {
				x.fail(ctx, rec, whyDeliverScope)
				return
			}
			if sleep(ctx, scopeWait) != nil {
				return
			}
			scopeWait = min(scopeWait*2, scopeWaitMost)
			continue
		case code != "" && code != codeInternal:
			x.fail(ctx, rec, whyDeliverReject) // an explicit refusal that cannot change: nothing was sent
			return
		case err == nil && res.Status == deliverDelivered:
			rec, _ = st.update(rec.ID, func(r *itemRec) { r.State, r.Run.State, r.Run.Answer = stateDone, "delivered", "" })
			x.keepSeq(rec)
			log.Printf("chat: item %s answered and delivered (duplicate=%v)", short(rec.ID)[:12], res.Duplicate)
			x.mark(ctx, rec, markDone)
			return
		case err == nil && res.Status == deliverRejected:
			x.fail(ctx, rec, whyDeliverReject)
			return
		}
		// No answer, "internal", or status unknown: the message may be out. Ask once more with the same operation id
		// (the router answers what it recorded and never sends again for an id it knows); still unknown is left so.
		if unsure++; unsure >= 2 {
			x.fail(ctx, rec, whyDeliverUnsure)
			return
		}
		if sleep(ctx, x.tm.unsureRetry) != nil {
			return
		}
	}
}
