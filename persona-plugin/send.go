package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nwverse/persona/sdk/go/ext"
	"github.com/nwverse/persona/sdk/go/wire"
)

// Sending on the assistant's own initiative: the connector's one write, agentsio_send. The product's protocol lets a
// write happen only in answer to actions.do, which the hub calls after its gate let it through; the manifest's
// confirm_always makes that the owner confirming on their phone, with the card actions.describe gives.
//
// What keeps a message from going out twice:
//   - the operation id the router is asked under comes from the hub's request id, so the same call repeated asks for
//     the same operation, and a repeat is answered from this program's own record without asking the router at all;
//   - the record is written before the request, so a send found mid-request after a restart is unknown, not unsent;
//   - an unknown outcome is never asked again by itself. When the owner confirms the same text to the same place
//     again within sendReuse of the first call, that call asks under the first one's operation id: the router answers
//     what it settled, or sends for the first time. Once the router itself settled that operation as unknown it
//     will never send under it, so from then on the same text confirmed again is a new operation, and the answer
//     says so beforehand.

// sendTextMost is the longest text sent, in characters. A backend cannot read a channel's own limit from the router
// (no frame a backend key may call tells it), so this is a constant inside what the common channels take. A longer
// text is refused, not cut: half a message to a person is worse than none.
const sendTextMost = 2000

type sendArgs struct {
	To      string `json:"to"`
	Text    string `json:"text"`
	ReplyTo string `json:"reply_to"`
}

// sendTool's schema has only snake_case keys: the SDK's test host holds every key of a connector answer to that, so
// the length limit and "no other fields" are said in words and enforced here (planSend, decodeSendArgs), not with
// maxLength and additionalProperties.
var sendTool = wire.ConnectorTool{Name: toolSendName, Description: toolSendDesc, InputSchema: json.RawMessage(
	`{"type":"object","properties":{` +
		`"to":{"type":"string","description":"目的地 id，来自 agentsio_destinations"},` +
		`"text":{"type":"string","description":"要发的文字，最多 2000 个字符"},` +
		`"reply_to":{"type":"string","description":"可选：要回复的那条消息的 ref"}},` +
		`"required":["to","text"]}`)}

// decodeSendArgs reads the arguments strictly: a field this version does not know (a channel, a conversation id,
// attachments) is refused rather than ignored, so nothing the model wrote is silently dropped from what the owner
// confirms.
func decodeSendArgs(raw json.RawMessage) (sendArgs, error) {
	var a sendArgs
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if len(bytes.TrimSpace(raw)) == 0 || dec.Decode(&a) != nil || dec.More() {
		return sendArgs{}, errors.New(wordsSendArgs)
	}
	return a, nil
}

// sendPlan is a send that can be made: where, by which route, as a reply to what, and the text.
type sendPlan struct {
	dest   dest
	route  replyRoute
	reply  *itemRec
	ref    string
	text   string
	digest string
}

// planSend checks the arguments against what this program knows; no network. actions.describe and actions.do share
// it, so the card shows exactly what would be sent.
func (x *app) planSend(raw json.RawMessage) (sendPlan, error) {
	args, err := decodeSendArgs(raw)
	if err != nil {
		return sendPlan{}, err
	}
	text := cleanText(args.Text, 0)
	switch n := utf8.RuneCountInString(text); {
	case n == 0:
		return sendPlan{}, errors.New(wordsSendEmpty)
	case n > sendTextMost:
		return sendPlan{}, fmt.Errorf(wordsSendTooLong, n, sendTextMost)
	}
	d, ok := x.destByID(args.To)
	if !ok {
		return sendPlan{}, errors.New(wordsSendNoDest)
	}
	p := sendPlan{dest: d, text: text, route: replyRoute{Channel: d.Channel, Account: d.Account, ConversationID: d.ConvID}}
	if strings.TrimSpace(args.ReplyTo) != "" {
		rec, ok := x.replyTarget(d, args.ReplyTo)
		if !ok {
			return sendPlan{}, errors.New(wordsSendNoReplyItem)
		}
		// The item's own route: its thread, and the message as the reply target.
		p.route, p.reply, p.ref = *rec.Route, &rec, refOf(args.ReplyTo)
		p.route.ReplyToMessageID = rec.MessageID
	}
	p.digest = short(d.ID + "|" + p.ref + "|" + text)
	return p, nil
}

// sendAllowedNow refuses a send that could not go out now: no connection to the router (nothing is queued for
// later), or more sends than the rate limit allows. The limit counts the store's records, so a restart does not
// reset it; it is what stops a model in a loop from flooding a chat.
func (x *app) sendAllowedNow(p sendPlan) error {
	st, rt := x.store(), x.router()
	if st == nil || rt == nil {
		return errors.New(wordsSendNotReady)
	}
	if !rt.connected() {
		return errors.New(wordsSendOffline)
	}
	now := time.Now()
	recent := st.sendsSince(now.Add(-x.tm.sendWindow)) // newest first
	var same []sendRec
	for _, r := range recent {
		if r.ConvKey == p.dest.key() {
			same = append(same, r)
		}
	}
	var frees time.Time // when the send that fills the limit leaves the window
	switch perDest, inAll := max(1, x.tm.sendPerDest), max(1, x.tm.sendPerWindow); {
	case len(same) >= perDest:
		frees = same[perDest-1].At
	case len(recent) >= inAll:
		frees = recent[inAll-1].At
	default:
		return nil
	}
	after := max(1, int(math.Ceil(frees.Add(x.tm.sendWindow).Sub(now).Seconds())))
	data, _ := json.Marshal(map[string]any{"retry_after": after})
	return &ext.Error{Code: wire.ConnectorErrorCodeRateLimited, Data: data,
		Message: fmt.Sprintf(wordsSendRate, x.tm.sendPerDest, x.tm.sendPerWindow, after)}
}

// describeSend is the phone's card for a send: where it really goes (from this program's own table, not from what
// the model wrote), who will see it, and the whole text. No network. An error refuses the call before the owner is
// asked: there is no point confirming a message that cannot go out.
func (x *app) describeSend(ctx context.Context, p wire.ConnectorCallParams) (wire.ConnectorDescribeResult, error) {
	if p.Name != toolSendName {
		return wire.ConnectorDescribeResult{}, &ext.Error{Message: "unknown action " + p.Name}
	}
	plan, err := x.planSend(p.Args)
	if err == nil {
		err = x.sendAllowedNow(plan)
	}
	if err != nil {
		return wire.ConnectorDescribeResult{}, wireError(err)
	}
	d := plan.dest
	lines := []string{fmt.Sprintf(sendCardTo, d.words(), d.where())}
	if r := plan.reply; r != nil {
		who := fieldSafe(senderOf(*r))
		if who == "" {
			who = "对方"
		}
		lines[0] += fmt.Sprintf(sendCardReply, who, said(*r).UTC().Format(sendCardTime))
	}
	// A name is what the other side chose to be called; who they are is the router's verdict, as in the sender line.
	switch {
	case d.Verdict == "":
	case d.LastFrom == "":
		lines = append(lines, fmt.Sprintf(sendCardVerdict, d.Verdict))
	default:
		lines = append(lines, fmt.Sprintf(sendCardLastFrom, fieldSafe(d.LastFrom), d.Verdict))
	}
	// Two destinations that read the same on this card are told apart by when each was last heard from.
	switch {
	case d.Twins == 0:
	case d.LastSeen.IsZero():
		lines = append(lines, fmt.Sprintf(sendCardTwinsNew, d.Twins))
	default:
		lines = append(lines, fmt.Sprintf(sendCardTwins, d.Twins, d.LastSeen.UTC().Format(sendCardTime)))
	}
	visible := sendVisibleOther
	switch d.Kind {
	case "dm":
		visible = sendVisibleDM
	case "group", "thread":
		// Only the chat's own name names it: a group without one is not called by whoever spoke there last.
		visible = sendVisibleGroupPlain
		if name := fieldSafe(d.Label); name != "" {
			visible = fmt.Sprintf(sendVisibleGroup, name)
		}
	}
	return wire.ConnectorDescribeResult{Action: wire.ConnectorAction{Name: sendActionName, Visible: visible},
		Summary: strings.Join(lines, "\n") + "\n\n" + plan.text}, nil
}

// wireError is an error as the hub gets it: its words, and its code when it has one.
func wireError(err error) error {
	var e *ext.Error
	if errors.As(err, &e) {
		return e
	}
	return &ext.Error{Message: err.Error()}
}

// doSend sends, once the hub's gate let the write through.
func (x *app) doSend(ctx context.Context, p wire.ConnectorDoParams) (wire.ConnectorCallResult, error) {
	none := wire.ConnectorCallResult{}
	if p.Name != toolSendName {
		return none, &ext.Error{Message: "unknown action " + p.Name}
	}
	st := x.store()
	if st == nil {
		return none, &ext.Error{Message: wordsSendNotReady}
	}
	// Without the hub's request id there is nothing to make the send happen once.
	reqID := strings.TrimSpace(p.RequestID)
	if reqID == "" {
		return none, &ext.Error{Message: wordsSendNoRequest}
	}
	op := "send-" + short(reqID)
	release, err := x.takeFlight(ctx, op)
	if err != nil {
		return none, &ext.Error{Message: wordsSendUnknown}
	}
	defer release()
	// The same call again: the first one's answer, from this program's record. The router is not asked.
	if rec, ok := st.send(op); ok {
		return x.sendAnswer(rec)
	}
	plan, err := x.planSend(p.Args)
	if err != nil {
		return none, wireError(err)
	}
	rec, err := x.admitSend(st, op, plan)
	if err != nil {
		return none, wireError(err)
	}
	res, noReply, err := x.deliverOnceWithin(ctx, rec.routerOp(), plan.route, plan.text, x.tm.send)
	outcome, code := sendOutcome(res, err)
	// The router answered with the operation's settled record (not a refusal of the request, not silence). A record
	// that is neither delivered nor rejected is all it will ever say about that operation.
	settled := err == nil
	settle := func(r *sendRec) {
		r.Outcome, r.Code, r.SettledAt = outcome, code, time.Now().UTC()
		r.NoReply, r.Duplicate = noReply && outcome == sendDelivered, res.Duplicate
		r.Spent = settled && outcome == sendUnknown
		if ids := res.messageIDs(); outcome == sendDelivered && len(ids) > 0 {
			r.MessageID = ids[0]
		}
	}
	root := rec.routerOp()
	_ = st.updateSends(func(r *sendRec) bool {
		switch {
		case r.Op == op:
		// The router settled the operation: every earlier send asked under it that was left unknown is as known
		// now as it will get. Delivered or rejected, it has that outcome; unknown, it stays unknown and its
		// operation is not asked under again.
		case settled && r.Outcome == sendUnknown && !r.Spent && r.routerOp() == root:
		default:
			return false
		}
		settle(r)
		return true
	})
	settle(&rec)
	log.Printf("send: %s to %s outcome=%s code=%s continued=%v", op[len("send-"):][:12], plan.dest.ID, outcome, code, rec.SameAs != "")
	return x.sendAnswer(rec)
}

// admitSend counts the send against the rate limit and records it, as one step: of calls that arrive together only
// as many as the limit has room for are recorded, and only a recorded send goes out. The record is written before
// the request that must not be repeated.
func (x *app) admitSend(st *store, op string, plan sendPlan) (sendRec, error) {
	x.sendGate.Lock()
	defer x.sendGate.Unlock()
	if err := x.sendAllowedNow(plan); err != nil {
		return sendRec{}, err
	}
	now := time.Now().UTC()
	rec := sendRec{Op: op, Dest: plan.dest.ID, ConvKey: plan.dest.key(), Label: plan.dest.words(), Named: plan.dest.Name,
		ReplyTo: plan.ref, Digest: plan.digest, TextDigest: textDigest(plan.text), Chars: utf8.RuneCountInString(plan.text),
		Outcome: sendSending, At: now}
	// The same text to the same place, after a send whose outcome is unknown: asked under that send's operation id.
	if prior, ok := st.reusable(plan.digest, now.Add(-x.tm.sendReuse)); ok {
		rec.SameAs = prior.Op
	}
	if err := st.putSend(rec); err != nil {
		log.Printf("send: the record could not be written; nothing is sent")
		return sendRec{}, &ext.Error{Message: wordsSendStore}
	}
	return rec, nil
}

// takeFlight makes one call per operation run at a time: a repeat that arrives while the first is under way waits
// for it, then answers from its record.
func (x *app) takeFlight(ctx context.Context, op string) (release func(), err error) {
	for {
		x.mu.Lock()
		under := x.sendFlight[op]
		if under == nil {
			mine := make(chan struct{})
			x.sendFlight[op] = mine
			x.mu.Unlock()
			return func() {
				x.mu.Lock()
				delete(x.sendFlight, op)
				x.mu.Unlock()
				close(mine)
			}, nil
		}
		x.mu.Unlock()
		select {
		case <-under:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// codeSafe keeps a refusal code the router sent to what a code looks like, for the record, the log and the words.
func codeSafe(code string) string {
	if code == "" || len(code) > 40 || strings.Trim(code, "abcdefghijklmnopqrstuvwxyz0123456789_.-") != "" {
		return "other"
	}
	return code
}

// sendOutcome sorts the router's answer by what it guarantees. A refusal (a code other than "internal") says nothing
// was sent and did not use up the operation id; so does a request that never left. A settled "rejected" is the
// channel refusing. No answer, "internal" and any other status leave the outcome open: the message may be out.
func sendOutcome(res deliverResult, err error) (outcome, code string) {
	switch rc := routerCode(err); {
	case errors.Is(err, errDisconnected):
		return sendRefused, sendCodeDisconnected
	case rc != "" && rc != codeInternal:
		return sendRefused, codeSafe(rc)
	case err != nil:
		return sendUnknown, errKind(err)
	}
	switch res.Status {
	case deliverDelivered:
		return sendDelivered, ""
	case deliverRejected:
		return sendRefused, sendCodeRejected
	}
	return sendUnknown, deliverUnknown
}

// sendAnswer is what the assistant is told about a send, from its record: the first call and every repeat say the
// same. Only a delivered send is a success (the hub's sent-as-user ledger keeps what succeeded); everything else is
// an error in one plain sentence, without the text and without any coordinates.
func (x *app) sendAnswer(rec sendRec) (wire.ConnectorCallResult, error) {
	switch rec.Outcome {
	case sendDelivered:
		text := fmt.Sprintf(wordsSendDelivered, rec.Label)
		if rec.Duplicate && rec.SameAs != "" {
			text = wordsSendWasAlready
		}
		if rec.NoReply {
			text += wordsSendNotAsReply
		}
		out := wire.ConnectorCallResult{Text: text}
		if len(rec.MessageID) <= 200 {
			out.MessageRef = rec.MessageID
		}
		return out, nil
	case sendRefused:
		switch rec.Code {
		case sendCodeDisconnected, codeStopped, codeUnauthorized:
			return wire.ConnectorCallResult{}, &ext.Error{Message: wordsSendOffline}
		case codeRouteNotAllowed:
			backend := backendPlaceholder
			if rt := x.router(); rt != nil {
				if b := rt.state().backend; b != "" {
					backend = b
				}
			}
			return wire.ConnectorCallResult{}, &ext.Error{Message: fmt.Sprintf(wordsSendScope, backend)}
		case sendCodeRejected:
			return wire.ConnectorCallResult{}, &ext.Error{Message: wordsSendRejected}
		}
		return wire.ConnectorCallResult{}, &ext.Error{Message: fmt.Sprintf(wordsSendRefused, rec.Code)}
	}
	if rec.Spent {
		return wire.ConnectorCallResult{}, &ext.Error{Message: wordsSendUnknownSettled}
	}
	return wire.ConnectorCallResult{}, &ext.Error{Message: wordsSendUnknown}
}
