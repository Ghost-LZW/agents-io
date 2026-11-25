package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/nwverse/persona/sdk/go/ext"
	"github.com/nwverse/persona/sdk/go/wire"
)

const (
	connectorID = "agentsio"
	// repliedFor is how long a replied thread is still handed over as done, for a hub that has not settled it.
	repliedFor  = 24 * time.Hour
	contextMost = 20
)

// facts are the channel's facts about the newest message of a thing, under extra.agentsio. The router strips the
// platform's raw payload before queueing, so these are the envelope's and the context's fields.
type facts struct {
	Channel          string        `json:"channel,omitempty"`
	Account          string        `json:"account,omitempty"`
	ConversationID   string        `json:"conversation_id,omitempty"`
	ConversationKind string        `json:"conversation_kind,omitempty"`
	ThreadID         string        `json:"thread_id,omitempty"`
	MessageID        string        `json:"message_id,omitempty"`
	ChannelRef       string        `json:"channel_ref,omitempty"`
	Rule             string        `json:"rule,omitempty"`
	Tag              string        `json:"tag,omitempty"`
	SenderID         string        `json:"sender_id,omitempty"`
	SenderLabels     []string      `json:"sender_labels,omitempty"`
	Evidence         string        `json:"evidence,omitempty"`
	RootMessageID    string        `json:"root_message_id,omitempty"`
	ParentMessageID  string        `json:"parent_message_id,omitempty"`
	Attachments      []attachment  `json:"attachments,omitempty"`
	Context          []contextFact `json:"context,omitempty"`
}

// contextFact is one of the channel's small facts. They are a list, not an object: the channel chooses the names,
// and the hub's protocol wants snake_case keys.
type contextFact struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// thingKind is the manifest's kind for a conversation kind.
func thingKind(convKind string) string {
	switch convKind {
	case "dm":
		return "dm"
	case "group", "thread":
		return "group"
	case "mail":
		return "mail"
	}
	return "other"
}

// ruleTier is the tier the extension's own rules give an item, used when no model sorts it.
func ruleTier(rec itemRec) (inboxTier, string) {
	switch {
	case rec.State == stateFailed, rec.TagSource == tagSourceUnreadable:
		return tierAction, rec.Why
	case rec.IsBot:
		return tierFYI, whyBot
	case rec.ConvKind == "dm" || rec.ConvKind == "mail":
		return tierAction, whyDM
	case rec.Addressed:
		return tierAction, whyAddressed
	}
	return tierFYI, whyGroup
}

// when is the time of the item's step in its thread: when the message was sent, or, for an item that became an
// Inbox thing later (a failed round trip), when that happened. The hub takes a thing as new activity only when its
// time is not before what it already has for the thread.
func when(rec itemRec) time.Time {
	switch {
	case !rec.Inbox.Since.IsZero():
		return rec.Inbox.Since
	case !rec.SentAt.IsZero():
		return rec.SentAt
	}
	return rec.ReceivedAt
}

// said is when the message itself was sent, for the thread's text.
func said(rec itemRec) time.Time {
	if !rec.SentAt.IsZero() {
		return rec.SentAt
	}
	return rec.ReceivedAt
}

func senderOf(rec itemRec) string {
	if rec.SenderName != "" {
		return rec.SenderName
	}
	return oneLine(rec.SenderID, 80)
}

// collect are the Inbox things: one per channel conversation that has open items (messages routed to the Inbox, and
// those whose round trip through a conversation failed), and for a day the conversations just replied to, as done.
func (x *app) collect() []thing {
	st := x.store()
	if st == nil {
		return nil
	}
	now := time.Now()
	byConv := map[string][]itemRec{}
	var order []string
	for _, rec := range st.all() {
		if rec.State == stateSkipped || rec.ConvKey == "" {
			continue
		}
		if byConv[rec.ConvKey] == nil {
			order = append(order, rec.ConvKey)
		}
		byConv[rec.ConvKey] = append(byConv[rec.ConvKey], rec)
	}
	rules := x.settings().triageRules
	var things []thing
	for _, key := range order {
		all := byConv[key]
		var open, replied []itemRec
		for _, rec := range all {
			switch {
			case rec.open():
				open = append(open, rec)
			case (rec.State == stateInbox || rec.State == stateFailed) && rec.Inbox.Done == "replied" && !rec.Inbox.Closed &&
				now.Sub(rec.Inbox.DoneAt) < repliedFor:
				replied = append(replied, rec)
			}
		}
		shown := open
		if len(shown) == 0 {
			shown = replied
		}
		if len(shown) == 0 {
			continue
		}
		// The newest step, not the newest arrival: a round trip that failed after a later message arrived is what
		// happened last, and the thing's last and at must change with it or the hub ignores the failure.
		sort.SliceStable(shown, func(i, j int) bool { return shown[i].stepAt().Before(shown[j].stepAt()) })
		newest := shown[len(shown)-1]
		tier, why := ruleTier(newest)
		// The thing's time never goes back within a thread: a message pushed late was sent before a failure that is
		// already known, and the hub would take the older time for an earlier step read again.
		at := when(newest)
		// A thread with a failed round trip needs the owner even when its newest message alone would not.
		for _, rec := range shown {
			if rec.State == stateFailed {
				tier, why = tierAction, rec.Why
			}
			if t := when(rec); t.After(at) {
				at = t
			}
		}
		title := newest.ChatName
		if title == "" {
			title = senderOf(newest)
		}
		t := thing{
			Thread: key, Kind: thingKind(newest.ConvKind), Label: oneLine(newest.Channel, 40), Title: title,
			Sender: senderOf(newest), Preview: oneLine(newest.Text, 200), Context: threadText(all),
			At: at, Last: short(newest.ID), URL: newest.URL, Why: why, Rules: rules,
			Tags:  []thingTag{{Key: "chat", Value: key, Name: title}},
			Extra: &extra{RuleTier: tier, Agentsio: factsOf(newest)},
		}
		if newest.SenderID != "" {
			t.Tags = append(t.Tags, thingTag{Key: "sender", Value: newest.SenderID, Name: senderOf(newest)})
		}
		if newest.Route != nil {
			t.CanReply, t.ReplyTo = true, oneLine(newest.Channel, 40)+" · "+title
		}
		if len(open) == 0 {
			t.Done = "replied"
		}
		things = append(things, t)
	}
	return things
}

// threadText is the conversation as the journal has it, a line a message, oldest first.
func threadText(all []itemRec) string {
	if len(all) > contextMost {
		all = all[len(all)-contextMost:]
	}
	var lines []string
	for _, rec := range all {
		lines = append(lines, said(rec).UTC().Format("2006-01-02 15:04")+" "+senderOf(rec)+": "+oneLine(rec.Text, 500))
	}
	return strings.Join(lines, "\n")
}

func factsOf(rec itemRec) *facts {
	f := &facts{Channel: rec.Channel, Account: rec.Account, ConversationID: rec.ConvID, ConversationKind: rec.ConvKind,
		ThreadID: rec.ThreadID, MessageID: rec.MessageID, ChannelRef: rec.ChannelRef, Rule: rec.Rule, Tag: rec.Tag,
		SenderID: rec.SenderID, SenderLabels: rec.SenderLabels, Evidence: rec.Evidence, RootMessageID: rec.RootID,
		ParentMessageID: rec.ParentID, Attachments: rec.Attachments}
	keys := make([]string, 0, len(rec.Context))
	for k := range rec.Context {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		f.Context = append(f.Context, contextFact{Name: k, Value: rec.Context[k]})
	}
	return f
}

// threadItems are a conversation's items that are Inbox things (open or done), oldest first.
func threadItems(st *store, thread string) []itemRec {
	var out []itemRec
	for _, rec := range st.all() {
		if rec.ConvKey == thread && (rec.State == stateInbox || rec.State == stateFailed) && !rec.Inbox.Closed {
			out = append(out, rec)
		}
	}
	return out
}

// reply sends the owner's reply through the router. The operation id comes from the hub's client_id, so the same
// reply asked twice is sent once: the router answers the settled record for an id it knows.
func (x *app) reply(ctx context.Context, p wire.ConnectorInboxReply) (ext.Empty, error) {
	text := cleanText(p.Text, 0)
	if len(p.Changes) > 0 {
		return ext.Empty{}, errors.New(wordsReplyChanges)
	}
	if text == "" {
		return ext.Empty{}, errors.New(wordsReplyEmpty)
	}
	st, rt := x.store(), x.router()
	if st == nil {
		return ext.Empty{}, errors.New(wordsStoreBroken)
	}
	items := threadItems(st, p.Thread)
	if len(items) == 0 {
		return ext.Empty{}, errors.New(wordsReplyNoThread)
	}
	newest := items[len(items)-1]
	if newest.Route == nil {
		return ext.Empty{}, errors.New(wordsReplyNoRoute)
	}
	if rt == nil || !rt.connected() {
		return ext.Empty{}, errors.New(wordsReplyOffline)
	}
	op := "inbox-reply-" + p.ClientID
	if strings.TrimSpace(p.ClientID) == "" {
		op = "inbox-reply-" + short(p.Thread+"|"+p.Last+"|"+text)
	}
	res, err := x.deliverOnce(ctx, op, *newest.Route, text)
	// A refusal says nothing was sent and does not use up the operation id: it is reported as not sent, so the owner
	// can send again. Only no answer, "internal" and an unknown status leave the outcome open.
	switch code := routerCode(err); {
	case errors.Is(err, errDisconnected), code == codeStopped, code == codeUnauthorized:
		return ext.Empty{}, errors.New(wordsReplyOffline)
	case code == codeRouteNotAllowed:
		return ext.Empty{}, errors.New(wordsReplyScope)
	case code != "" && code != codeInternal:
		log.Printf("inbox: reply refused (%s)", errKind(err))
		return ext.Empty{}, errors.New(wordsReplyRefused)
	case err != nil:
		log.Printf("inbox: reply outcome unknown (%s)", errKind(err))
		return ext.Empty{}, errors.New(wordsReplyUnknown)
	}
	switch res.Status {
	case deliverDelivered:
	case deliverRejected:
		return ext.Empty{}, errors.New(wordsReplyRejected)
	default:
		return ext.Empty{}, errors.New(wordsReplyUnknown)
	}
	now := time.Now().UTC()
	_ = st.updateAll(func(r *itemRec) bool {
		if r.ConvKey != p.Thread || !r.open() {
			return false
		}
		r.Inbox.Done, r.Inbox.DoneAt = "replied", now
		return true
	})
	x.markThread(ctx, p.Thread, "replied")
	x.inboxChanged()
	return ext.Empty{}, nil
}

// deliverOnce is a deliver that, when the router says the reply target is outside what this backend may reply to,
// asks once more for the same operation without the reply target (the router allows sending to the conversation; a
// refused request does not use up the operation id).
func (x *app) deliverOnce(ctx context.Context, op string, route replyRoute, text string) (deliverResult, error) {
	rt := x.router()
	if rt == nil {
		return deliverResult{}, errDisconnected
	}
	res, err := rt.deliver(ctx, op, route, text)
	if routerCode(err) == codeRouteNotAllowed && route.ReplyToMessageID != "" {
		route.ReplyToMessageID = ""
		res, err = rt.deliver(ctx, op, route, text)
	}
	return res, err
}

// errKind is an error's kind for the log: never its words.
func errKind(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, errDisconnected):
		return "disconnected"
	case errors.Is(err, errLost):
		return "no_answer"
	case routerCode(err) != "":
		return routerCode(err)
	}
	return "error"
}

// markThread puts the done mark on the channel messages of a thread's items that ended with done and have none yet.
// Best effort, once per item.
func (x *app) markThread(ctx context.Context, thread, done string) {
	st := x.store()
	if st == nil {
		return
	}
	for _, rec := range st.all() {
		if rec.ConvKey != thread || rec.Inbox.Done != done || rec.Inbox.Marked {
			continue
		}
		if x.mark(ctx, rec, markDone) {
			_, _ = st.update(rec.ID, func(r *itemRec) { r.Inbox.Marked = true })
		}
	}
}

// mark asks the router to put a handling mark on an item's channel message. It answers whether there is nothing more
// to try (marked, or the channel has no marks); false only when the router could not be asked now.
func (x *app) mark(ctx context.Context, rec itemRec, state string) bool {
	if !x.settings().workingMark || rec.Route == nil || rec.MessageID == "" {
		return true
	}
	rt := x.router()
	if rt == nil {
		return false
	}
	err := rt.mark(ctx, *rec.Route, rec.MessageID, state)
	switch {
	case err == nil:
		return true
	case errors.Is(err, errDisconnected), errors.Is(err, errLost):
		return false
	}
	// unsupported, route_not_allowed, channel_error: said once per channel, then ignored.
	x.mu.Lock()
	first := !x.markQuiet[rec.Channel]
	x.markQuiet[rec.Channel] = true
	x.mu.Unlock()
	if first {
		log.Printf("mark: the router answered %s; marks on this channel are skipped quietly from now on", errKind(err))
	}
	return true
}

// settle answers the hub's question: which of the threads it still has open are over. A thread is over when the
// journal no longer has it, or when all its items were replied to. The hub is never told "the owner marked this
// done" by the protocol; that is inferred here: an item whose thread the hub listed as open before and no longer
// lists was filed in the app, so it is closed and its channel message gets the done mark.
func (x *app) settle(ctx context.Context, p wire.ConnectorSettleParams) (wire.ConnectorSettled, error) {
	st := x.store()
	out := wire.ConnectorSettled{Settled: map[string]string{}}
	if st == nil {
		return out, nil
	}
	listed := map[string]bool{}
	for _, t := range p.Threads {
		listed[t] = true
	}
	openIn := map[string]bool{}
	known := map[string]bool{}
	for _, rec := range st.all() {
		if rec.State != stateInbox && rec.State != stateFailed || rec.Inbox.Closed {
			continue
		}
		known[rec.ConvKey] = true
		if rec.open() {
			openIn[rec.ConvKey] = true
		}
	}
	for t := range listed {
		switch {
		case !known[t]:
			out.Settled[t] = wordsSettledGone
		case !openIn[t]:
			out.Settled[t] = wordsSettledReplied
		}
	}
	var filed, replied []string
	now := time.Now().UTC()
	_ = st.updateAll(func(r *itemRec) bool {
		if r.State != stateInbox && r.State != stateFailed || r.Inbox.Closed {
			return false
		}
		switch {
		case listed[r.ConvKey] && r.open():
			// The hub holds the thread open. That is remembered with its time (written again only now and then), so an
			// old item the hub still lists is never taken for one it dropped (store.prune).
			if r.Inbox.SeenOpen && now.Sub(r.Inbox.ListedAt) < listedEvery {
				return false
			}
			r.Inbox.SeenOpen, r.Inbox.ListedAt = true, now
		case listed[r.ConvKey]: // done, and the hub now knows
			r.Inbox.Closed = true
			replied = append(replied, r.ConvKey)
		case r.open() && r.Inbox.SeenOpen: // the hub had it open and no longer does
			r.Inbox.Done, r.Inbox.DoneAt, r.Inbox.Closed = "filed", now, true
			filed = append(filed, r.ConvKey)
		default:
			return false
		}
		return true
	})
	for _, t := range replied {
		x.markThread(ctx, t, "replied")
	}
	for _, t := range filed {
		x.markThread(ctx, t, "filed")
	}
	if len(filed) > 0 {
		log.Printf("inbox: %d item(s) filed in the app are closed", len(filed))
	}
	return out, nil
}

var aboutTool = wire.ConnectorTool{Name: toolAboutName, Description: toolAboutDesc,
	InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)}

// about is the one tool's answer: where the conversation's messages come from and that the answer is delivered by
// the extension. No message content, no address, no key. The tool exists because a guest conversation must name one
// to eight connector tools.
func (x *app) about() string {
	state := "未连接"
	backend := ""
	if rt := x.router(); rt != nil {
		if s := rt.state(); s.phase == phaseOK {
			state, backend = "已连接", s.backend
		}
	}
	out := map[string]any{
		"router":  state,
		"backend": backend,
		"note":    "这段对话里以「【渠道消息】」开头的消息由 agents-io 路由从外部渠道转来，第一行写明了发送者和渠道。你的最终回答会由扩展自动发回原会话，不需要也不能自己再发一次。",
	}
	b, _ := json.Marshal(out)
	return string(b)
}
