package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The hub's HTTP API, with the extension's scoped token (permissions.hub: assistant.ask, agents.read,
// agents.control; starting an Agent session is agents.control too). The token is never logged. Requests go through
// the default transport, so the sandbox's proxy applies.

const hubReadMost = 32 << 20

// hubError is the hub's answer to a call that failed.
type hubError struct {
	status    int
	code      string
	delivered string
}

func (e *hubError) Error() string { return fmt.Sprintf("hub answered %d %s", e.status, e.code) }

type hubClient struct {
	base, token string
	http        *http.Client
	capsEvery   time.Duration

	mu      sync.Mutex
	guest   bool
	guestAt time.Time
}

func newHubClient(base, token string, tm timings) *hubClient {
	if base == "" || token == "" {
		return nil
	}
	return &hubClient{base: strings.TrimRight(base, "/"), token: token, capsEvery: tm.capsEvery,
		http: &http.Client{Timeout: tm.hubTimeout}}
}

// hubAnswer is what a call got: the status and the fields the outcome is read from.
type hubAnswer struct {
	status int
	body   struct {
		Code      string `json:"code"`
		Delivered string `json:"delivered"`
		State     string `json:"state"`
	}
	raw []byte
}

func (h *hubClient) do(ctx context.Context, method, path string, query url.Values, header map[string]string, in any) (hubAnswer, error) {
	var ans hubAnswer
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return ans, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, body)
	if err != nil {
		return ans, err
	}
	if query != nil {
		req.URL.RawQuery = query.Encode()
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := h.http.Do(req)
	if err != nil {
		return ans, err
	}
	defer resp.Body.Close()
	ans.status = resp.StatusCode
	ans.raw, err = io.ReadAll(io.LimitReader(resp.Body, hubReadMost))
	_ = json.Unmarshal(ans.raw, &ans.body)
	if err != nil { // the answer began and was cut off
		return ans, err
	}
	return ans, nil
}

// errUndecodable: the hub answered 2xx with a body this program cannot read. Asking again gets the same answer, so a
// caller counts these instead of waiting them out.
var errUndecodable = errors.New("hub: the answer is not in a shape this program reads")

// get is a read: an error for anything but 2xx.
func (h *hubClient) get(ctx context.Context, path string, query url.Values, out any) error {
	ans, err := h.do(ctx, http.MethodGet, path, query, nil, nil)
	if err != nil {
		return err
	}
	if ans.status/100 != 2 {
		return &hubError{status: ans.status, code: ans.body.Code, delivered: ans.body.Delivered}
	}
	if out != nil {
		if json.Unmarshal(ans.raw, out) != nil {
			return errUndecodable
		}
	}
	return nil
}

// guestOK says whether the hub has guest conversations: asked before every guest start that the cache does not
// cover. known is false when the question could not be answered (the manager is away, a timeout): that says nothing
// about guest conversations and is not remembered. Only an answer is: "false", or 404 from an older hub, which would
// ignore "guest" and start an ordinary conversation.
func (h *hubClient) guestOK(ctx context.Context) (ok, known bool) {
	h.mu.Lock()
	if !h.guestAt.IsZero() && time.Since(h.guestAt) < h.capsEvery {
		defer h.mu.Unlock()
		return h.guest, true
	}
	h.mu.Unlock()
	var caps struct {
		Guest bool `json:"guest_conversations"`
	}
	err := h.get(ctx, "/api/v1/assistant/capabilities", nil, &caps)
	var he *hubError
	switch {
	case err == nil:
		ok = caps.Guest
	case errors.As(err, &he) && he.status == http.StatusNotFound:
		ok = false
	default:
		return false, false
	}
	h.mu.Lock()
	h.guest, h.guestAt = ok, time.Now()
	h.mu.Unlock()
	return ok, true
}

// Outcomes of a write whose repetition matters.
const (
	outSent    = "sent"    // the assistant has it
	outRetry   = "retry"   // certainly not sent, and worth trying again
	outRefused = "refused" // certainly not sent, and trying again would be refused again
	outGone    = "gone"    // certainly not sent: the conversation is no longer there
	outUnknown = "unknown" // it may have been sent: never sent again automatically
)

// classify reads the outcome of a send (a new conversation, or a message into one) from the hub's answer. Only an
// answer that says nothing was delivered, or a failure before any connection existed, is "not sent". Everything else
// that is not a success is unknown, and an unknown send is never repeated.
func classify(ans hubAnswer, err error) string {
	if err != nil {
		var op *net.OpError
		if errors.As(err, &op) && op.Op == "dial" {
			return outRetry
		}
		var dns *net.DNSError
		if errors.As(err, &dns) {
			return outRetry
		}
		return outUnknown
	}
	b := ans.body
	switch {
	case b.Delivered == "unknown" || b.Code == "assistant_in_doubt" || b.Code == "send_in_doubt":
		return outUnknown
	case ans.status == http.StatusAccepted:
		if b.Delivered == "later" { // the manager keeps it and sends it once by itself
			return outSent
		}
		return outUnknown // an operation receipt that is pending or unknown is not a delivery
	case ans.status/100 == 2:
		return outSent
	case b.Delivered == "yes":
		return outSent
	case ans.status == http.StatusServiceUnavailable && b.Code == "assistant_offline":
		return outRetry
	case ans.status == http.StatusNotFound || ans.status == http.StatusGone:
		if b.Delivered == "" || b.Delivered == "none" {
			return outGone
		}
		return outUnknown
	case ans.status == http.StatusConflict || ans.status == http.StatusLocked || ans.status == http.StatusTooManyRequests:
		return outRetry // explicitly refused for now (a draft in the box, a dialog open, busy)
	case ans.status/100 == 4:
		return outRefused
	case b.Delivered == "none":
		return outRetry
	}
	return outUnknown
}

// replayed says whether the hub keeps a receipt for a start it refused and answers a repeat of the same operation id
// from it: every refusal that states nothing was delivered, except 503 assistant_offline, which keeps none because
// nothing reached the assistant (the product's protocol.md, "Operation receipts"). Such a start can only be tried
// again under a new operation id; that is safe because the hub said nothing was started. A refusal that does not say
// so keeps its id: the repeat then either goes through or answers "unknown", and an unknown start is never repeated.
func replayed(ans hubAnswer) bool {
	return ans.body.Delivered == "none" && !(ans.status == http.StatusServiceUnavailable && ans.body.Code == "assistant_offline")
}

// opUUID is a UUID-shaped operation id derived from a seed (version 5 layout over SHA-1), so the same item always
// names the same operation.
func opUUID(seed string) string {
	sum := sha1.Sum([]byte("agents-io/" + seed))
	b := sum[:16]
	b[6] = b[6]&0x0f | 0x50
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// open starts a new assistant conversation with its first message. guest starts a guest conversation, which may use
// only the one tool named. renew: the start was not sent, and trying again needs a new operation id (replayed).
func (h *hubClient) open(ctx context.Context, text string, guest bool, opID string) (mid, sid, outcome string, renew bool) {
	body := map[string]any{"prompt": text}
	if guest {
		body["guest"] = map[string]any{"tools": []string{toolAboutName}}
	}
	ans, err := h.do(ctx, http.MethodPost, "/api/v1/assistant/conversations", nil, map[string]string{"X-Persona-Op-Id": opID}, body)
	outcome = classify(ans, err)
	if outcome != outSent {
		if outcome == outGone { // nothing to be gone for a start: a 404 here is a hub without the route
			outcome = outRefused
		}
		return "", "", outcome, outcome == outRetry && err == nil && replayed(ans)
	}
	var res struct {
		Session struct {
			MachineID string `json:"machine_id"`
			SessionID string `json:"session_id"`
		} `json:"session"`
	}
	_ = json.Unmarshal(ans.raw, &res)
	if res.Session.MachineID == "" || res.Session.SessionID == "" {
		return "", "", outUnknown, false // started, and it did not say where
	}
	return res.Session.MachineID, res.Session.SessionID, outSent, false
}

// classifyStart reads the outcome of starting an Agent session (POST /api/v1/sessions). It is stricter than classify:
// a start the hub accepted runs to its end even when the answer is lost, so only an answer that says nothing started
// is "not sent". The hub keeps a receipt of every start it answered and replays it to the same operation id, so a
// start tried again always needs a new one (renew).
//   - 200 with the session: started;
//   - 202 (the receipt is pending or unknown), delivered "unknown", any other 5xx, no answer: unknown;
//   - 503 with assistant_offline, node_unreachable or terminal_not_ready, delivered "none", 429, or no connection at
//     all: not started, worth trying again;
//   - any other 4xx (unknown computer, a launcher, model or field the hub refuses, another manager's computer, a
//     computer not confirmed yet, the node refusing the start): not started, and asking again is refused again.
func classifyStart(ans hubAnswer, err error) string {
	if err != nil {
		var op *net.OpError
		var dns *net.DNSError
		if errors.As(err, &op) && op.Op == "dial" || errors.As(err, &dns) {
			return outRetry
		}
		return outUnknown
	}
	b := ans.body
	switch {
	case b.Delivered == "unknown":
		return outUnknown
	case ans.status == http.StatusOK:
		return outSent
	case ans.status/100 == 2:
		return outUnknown
	case ans.status == http.StatusTooManyRequests:
		return outRetry
	case ans.status/100 == 4:
		return outRefused
	case ans.status == http.StatusServiceUnavailable &&
		(b.Code == "assistant_offline" || b.Code == "node_unreachable" || b.Code == "terminal_not_ready"),
		b.Delivered == "none":
		return outRetry
	}
	return outUnknown
}

// launch starts a new Agent session with the launcher's line and the first prompt. msgID ties the first message to
// the transcript (the node puts it on the first matching user item); opID makes the start happen once.
func (h *hubClient) launch(ctx context.Context, l launcher, text, msgID, opID string) (mid, sid, outcome string, renew bool) {
	body := map[string]any{"machine_id": l.MachineID, "launcher": l.Launcher, "prompt": text, "client_msg_id": msgID}
	for k, v := range map[string]string{"host": l.Host, "cwd": l.Cwd, "model": l.Model, "effort": l.Effort,
		"permission_mode": l.PermissionMode, "speed": l.Speed} {
		if v != "" {
			body[k] = v
		}
	}
	ans, err := h.do(ctx, http.MethodPost, "/api/v1/sessions", nil, map[string]string{"X-Persona-Op-Id": opID}, body)
	outcome = classifyStart(ans, err)
	if outcome != outSent {
		return "", "", outcome, outcome == outRetry
	}
	var res struct {
		Session struct {
			MachineID string `json:"machine_id"`
			SessionID string `json:"session_id"`
		} `json:"session"`
	}
	_ = json.Unmarshal(ans.raw, &res)
	if res.Session.SessionID == "" {
		return "", "", outUnknown, false // started, and it did not say where
	}
	if res.Session.MachineID == "" {
		res.Session.MachineID = l.MachineID
	}
	return res.Session.MachineID, res.Session.SessionID, outSent, false
}

// codeAgentStopped is the hub's refusal of a message to an Agent that has stopped: nothing was typed, and it takes
// none until somebody resumes it.
const codeAgentStopped = "agent_stopped"

// sendTo is send for a session this program started: it also says when the session has stopped (nothing typed).
func (h *hubClient) sendTo(ctx context.Context, mid, sid, text, msgID string) (outcome string, kept, stopped bool) {
	ans, err := h.do(ctx, http.MethodPost, sessionPath(mid, sid)+"/messages", nil, nil,
		map[string]any{"text": text, "client_msg_id": msgID})
	if err == nil && ans.status/100 == 4 && ans.body.Code == codeAgentStopped && ans.body.Delivered != "yes" && ans.body.Delivered != "unknown" {
		return outRefused, false, true
	}
	outcome = classify(ans, err)
	return outcome, outcome == outSent && ans.status == http.StatusAccepted && ans.body.Delivered == "later", false
}

func sessionPath(mid, sid string) string {
	return "/api/v1/sessions/" + url.PathEscape(mid) + "/" + url.PathEscape(sid)
}

// send puts a message into an existing conversation. client_msg_id lets the hub drop a repetition and lets the
// message be found in the transcript. No operation header: on this route it would override the body's id. kept: the
// manager holds the message and sends it by itself later (202 delivered "later"), which may be long after.
func (h *hubClient) send(ctx context.Context, mid, sid, text, msgID string) (outcome string, status int, kept bool) {
	ans, err := h.do(ctx, http.MethodPost, sessionPath(mid, sid)+"/messages", nil, nil,
		map[string]any{"text": text, "client_msg_id": msgID})
	outcome = classify(ans, err)
	return outcome, ans.status, outcome == outSent && ans.status == http.StatusAccepted && ans.body.Delivered == "later"
}

// sessionRow is what the session list says about a conversation.
type sessionRow struct {
	MachineID           string `json:"machine_id"`
	SessionID           string `json:"session_id"`
	Status              string `json:"status"`
	Starting            bool   `json:"starting"`
	PendingInteractions int    `json:"pending_interactions"`
}

// busy: the turn is under way or waits for an answer (a permission card, a question).
func (s sessionRow) busy() bool {
	return s.Status == "working" || s.Status == "blocked" || s.Starting || s.PendingInteractions > 0
}

// stopped: no live agent, only a transcript (offline), or one a restart of its computer cut off (interrupted). Either
// takes no message until somebody resumes it.
func (s sessionRow) stopped() bool {
	return !s.Starting && (s.Status == "offline" || s.Status == "interrupted")
}

// look reads the conversation's row. found is false when the list does not have it (not visible to this token, or
// gone); an error is a failed read.
func (h *hubClient) look(ctx context.Context, mid, sid string) (row sessionRow, found bool, err error) {
	var list struct {
		Sessions []sessionRow `json:"sessions"`
	}
	err = h.get(ctx, "/api/v1/sessions", url.Values{"machine_id": {mid}, "session_id": {sid}, "summary": {"1"}}, &list)
	var he *hubError
	if errors.As(err, &he) && he.status/100 == 4 && he.status != http.StatusUnauthorized && he.status != http.StatusForbidden &&
		he.status != http.StatusTooManyRequests {
		// A hub that does not know the filter: the whole list.
		list.Sessions = nil
		err = h.get(ctx, "/api/v1/sessions", nil, &list)
	}
	if err != nil {
		return row, false, err
	}
	for _, s := range list.Sessions {
		if s.MachineID == mid && s.SessionID == sid {
			return s, true, nil
		}
	}
	return row, false, nil
}

// hubItem is one item of a conversation's transcript, the fields this program reads (the product's proto.Item).
// "injected" and "source" are objects on the wire; only whether they are there matters here, so they are kept raw
// and no change of their inner shape can break the page's decoding.
type hubItem struct {
	ID          string          `json:"id"`
	Seq         int64           `json:"seq"`
	Role        string          `json:"role"`
	Kind        string          `json:"kind"`
	Text        string          `json:"text"`
	ClientMsgID string          `json:"client_msg_id"`
	Queued      bool            `json:"queued"`
	FullSize    int64           `json:"full_size"`
	ToolUseID   string          `json:"tool_use_id"`
	From        string          `json:"from"`
	Injected    json.RawMessage `json:"injected"`
	Source      json.RawMessage `json:"source"`
}

func present(raw json.RawMessage) bool {
	v := bytes.TrimSpace(raw)
	return len(v) > 0 && !bytes.Equal(v, []byte("null"))
}

// typed says whether the item is something a person put into the conversation: words, or a picture sent as a message
// (a picture a tool result carries has the user role too, and a tool_use_id). Not a block the product injected (a
// task's notice, a wake-up), not another session's message, not an automated input.
func (it hubItem) typed() bool {
	if it.Role != "user" || present(it.Injected) || it.From != "" || present(it.Source) {
		return false
	}
	return it.Kind == "text" || it.Kind == "image" && it.ToolUseID == ""
}

// itemPagesMost bounds one read of the transcript; a longer one goes on from where this one stopped.
const itemPagesMost = 50

// items reads the transcript after a seq, following more_after. complete is false when the page limit was reached
// with more to read: what came back is then not the transcript's end.
func (h *hubClient) items(ctx context.Context, mid, sid string, after int64) (out []hubItem, complete bool, err error) {
	for page := 0; page < itemPagesMost; page++ {
		var res struct {
			Items     []hubItem `json:"items"`
			MoreAfter bool      `json:"more_after"`
		}
		q := url.Values{"after_seq": {strconv.FormatInt(after, 10)}, "lazy_images": {"1"}}
		if err := h.get(ctx, sessionPath(mid, sid)+"/items", q, &res); err != nil {
			return out, false, err
		}
		out = append(out, res.Items...)
		if !res.MoreAfter || len(res.Items) == 0 {
			return out, true, nil
		}
		after = res.Items[len(res.Items)-1].Seq
	}
	return out, false, nil
}

// full is an item's whole text: a page cuts a long text and says so with full_size.
func (h *hubClient) full(ctx context.Context, mid, sid, itemID string) (string, error) {
	var it hubItem
	if err := h.get(ctx, sessionPath(mid, sid)+"/items/"+url.PathEscape(itemID)+"/full", nil, &it); err != nil {
		return "", err
	}
	return it.Text, nil
}
