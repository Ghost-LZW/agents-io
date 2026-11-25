package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode"
)

// fakeHubToken is an obviously fake extension token.
const fakeHubToken = "pext_test_token_not_real"

type hubOpen struct {
	opID string
	body map[string]any
}

type hubSend struct {
	mid, sid string
	body     map[string]any
}

// fakeItem is one transcript item as the fake keeps it. wire is how the hub sends it: empty fields are left out,
// "injected" is an object, and a long text is cut for pages with full_size set.
type fakeItem struct {
	ID          string
	Seq         int64
	Role, Kind  string
	Text        string
	ClientMsgID string
	Queued      bool
	Injected    bool   // a block the product put into the conversation: sent as an object, as the hub does
	From        string // another session's message
	Source      string // an automated input's author kind
	ToolUseID   string
	Full        string // the whole text when Text is the page's cut of it
}

func (it fakeItem) id() string {
	if it.ID != "" {
		return it.ID
	}
	return fmt.Sprintf("line %d", it.Seq) // an id with a character that must be escaped in a path
}

func (it fakeItem) wire(full bool) map[string]any {
	m := map[string]any{"id": it.id(), "seq": it.Seq, "ts": "2026-01-01T00:00:00Z", "role": it.Role, "kind": it.Kind}
	text := it.Text
	if it.Full != "" {
		if full {
			text = it.Full
		} else {
			m["full_size"] = len(it.Full)
		}
	}
	if text != "" {
		m["text"] = text
	}
	if it.ClientMsgID != "" {
		m["client_msg_id"] = it.ClientMsgID
	}
	if it.Queued {
		m["queued"] = true
	}
	if it.Injected {
		m["injected"] = map[string]any{"kind": "task_notice", "state": "done", "title": "background task"}
	}
	if it.From != "" {
		m["from"] = it.From
	}
	if it.Source != "" {
		m["source"] = map[string]any{"kind": it.Source}
	}
	if it.ToolUseID != "" {
		m["tool_use_id"] = it.ToolUseID
	}
	return m
}

type fakeSession struct {
	mid, sid string
	items    []fakeItem
	seq      int64
	row      sessionRow
	hidden   bool // not in the session list
	gone     bool // its routes answer 404
	looks    int
}

// say appends one transcript item.
func (s *fakeSession) say(role, kind, text, msgID string) *fakeItem {
	s.seq++
	s.items = append(s.items, fakeItem{Seq: s.seq, Role: role, Kind: kind, Text: text, ClientMsgID: msgID})
	return &s.items[len(s.items)-1]
}

// fakeHub is the part of the hub's HTTP API the extension uses, with a scripted assistant.
type fakeHub struct {
	t   testing.TB
	srv *httptest.Server

	mu    sync.Mutex
	guest *bool // nil: an older hub, capabilities is 404
	// onCaps scripts the answer to the nth capabilities request (status 0: the default behaviour).
	onCaps func(n int) (status int, body string)
	caps   int
	// receipts are the hub's operation receipts for new conversations: a repeat with the same operation id is
	// answered from the receipt and starts nothing (docs/protocol/protocol.md "Operation receipts" in the product).
	receipts  map[string]hubReceipt
	badItems  bool // the transcript route answers JSON of another shape
	fullFails bool // the full-text route answers 502
	fulls     []string
	reads     []int64 // after_seq of every transcript read
	opens     []hubOpen
	sends     []hubSend
	log       []string
	sessions  map[string]*fakeSession
	seen      map[string]bool // client_msg_ids taken
	pageSize  int
	// onOpen and onSend script the answer to the nth request (status 0: the default behaviour). taken says whether
	// the message goes into the conversation anyway (an answer lost on the way).
	onOpen func(n int) (status int, body string, taken bool)
	onSend func(n int, msgID string) (status int, body string, taken bool)
	// turn scripts what the assistant does with a message that went in; the default answers with one text.
	turn func(s *fakeSession, text, msgID string)
}

type hubReceipt struct {
	status int
	body   string
}

// keepReceipt records what a repeat of the operation is answered: a 400 or 409 is replayed as it was, a success too;
// 503 assistant_offline keeps nothing (nothing reached the assistant); anything else is unknown from then on.
func (f *fakeHub) keepReceipt(opID string, status int, body string) {
	if opID == "" {
		return
	}
	var b struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal([]byte(body), &b)
	switch {
	case status == 503 && b.Code == "assistant_offline":
	case status/100 == 2, status == 400, status == 409:
		f.receipts[opID] = hubReceipt{status, body}
	default:
		f.receipts[opID] = hubReceipt{202, `{"state":"unknown"}`}
	}
}

func newFakeHub(t testing.TB) *fakeHub {
	yes := true
	f := &fakeHub{t: t, guest: &yes, sessions: map[string]*fakeSession{}, seen: map[string]bool{}, pageSize: 100,
		receipts: map[string]hubReceipt{}}
	f.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "text", "answer", "") }
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHub) url() string { return f.srv.URL }

func (f *fakeHub) set(change func(f *fakeHub)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

// session is the nth conversation opened (from 1).
func (f *fakeHub) session(n int) *fakeSession {
	return f.sessions[fmt.Sprintf("m1/s%d", n)]
}

func (f *fakeHub) counts() (opens, sends int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.opens), len(f.sends)
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return true
		}
	}
	return false
}

func (f *fakeHub) serve(w http.ResponseWriter, r *http.Request) {
	reply := func(status int, body string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
	if r.Header.Get("Authorization") != "Bearer "+fakeHubToken {
		reply(401, `{"error":"invalid token","code":"invalid_token","delivered":"none"}`)
		return
	}
	var body map[string]any
	if r.Method == http.MethodPost {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log = append(f.log, r.Method+" "+r.URL.Path)
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/assistant/capabilities":
		f.caps++
		if f.onCaps != nil {
			if status, scripted := f.onCaps(f.caps); status != 0 {
				reply(status, scripted)
				return
			}
		}
		if f.guest == nil {
			reply(404, `{"error":"not found","code":"not_found"}`)
			return
		}
		reply(200, fmt.Sprintf(`{"guest_conversations":%v}`, *f.guest))
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/assistant/conversations":
		opID := r.Header.Get("X-Persona-Op-Id")
		f.opens = append(f.opens, hubOpen{opID: opID, body: body})
		if rc, ok := f.receipts[opID]; ok {
			reply(rc.status, rc.body)
			return
		}
		text, _ := body["prompt"].(string)
		if hasControl(text) {
			reply(403, `{"error":"control characters","code":"terminal_control_refused","delivered":"none"}`)
			return
		}
		status, scripted, taken := 0, "", true
		if f.onOpen != nil {
			status, scripted, taken = f.onOpen(len(f.opens))
		}
		if status != 0 && !taken {
			f.keepReceipt(opID, status, scripted)
			reply(status, scripted)
			return
		}
		s := &fakeSession{mid: "m1", sid: fmt.Sprintf("s%d", len(f.sessions)+1), row: sessionRow{Status: "idle"}}
		s.row.MachineID, s.row.SessionID = s.mid, s.sid
		f.sessions[s.mid+"/"+s.sid] = s
		s.say("user", "text", text, "") // a conversation's first message carries no client_msg_id
		f.turn(s, text, "")
		if status != 0 {
			f.keepReceipt(opID, status, scripted)
			reply(status, scripted)
			return
		}
		started := fmt.Sprintf(`{"session":{"machine_id":%q,"session_id":%q}}`, s.mid, s.sid)
		f.keepReceipt(opID, 200, started)
		reply(200, started)
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/sessions":
		var rows []sessionRow
		for _, s := range f.sessions {
			s.looks++
			if !s.hidden && !s.gone {
				rows = append(rows, s.row)
			}
		}
		b, _ := json.Marshal(map[string]any{"sessions": rows})
		reply(200, string(b))
	case len(parts) == 6 && parts[2] == "sessions" && parts[5] == "messages" && r.Method == http.MethodPost:
		f.sends = append(f.sends, hubSend{mid: parts[3], sid: parts[4], body: body})
		s := f.sessions[parts[3]+"/"+parts[4]]
		text, _ := body["text"].(string)
		msgID, _ := body["client_msg_id"].(string)
		switch {
		case s == nil || s.gone:
			reply(404, `{"error":"no session","code":"no_session","delivered":"none"}`)
			return
		case hasControl(text):
			reply(403, `{"error":"control characters","code":"terminal_control_refused","delivered":"none"}`)
			return
		case strings.HasPrefix(msgID, "start:"):
			reply(400, `{"error":"reserved","code":"client_msg_id_reserved","delivered":"none"}`)
			return
		}
		status, scripted, taken := 0, "", true
		if f.onSend != nil {
			status, scripted, taken = f.onSend(len(f.sends), msgID)
		}
		if taken && !f.seen[msgID] {
			f.seen[msgID] = true
			s.say("user", "text", text, msgID)
			f.turn(s, text, msgID)
		}
		if status != 0 {
			reply(status, scripted)
			return
		}
		reply(200, `{"ok":true}`)
	case len(parts) == 6 && parts[2] == "sessions" && parts[5] == "items" && r.Method == http.MethodGet:
		s := f.sessions[parts[3]+"/"+parts[4]]
		if s == nil || s.gone {
			reply(404, `{"error":"no session","code":"no_session"}`)
			return
		}
		if f.badItems {
			reply(200, `{"items":[{"seq":"not a number","role":7}],"more_after":false}`)
			return
		}
		after, _ := strconv.ParseInt(r.URL.Query().Get("after_seq"), 10, 64)
		f.reads = append(f.reads, after)
		page := []map[string]any{}
		more := false
		for _, it := range s.items {
			if it.Seq <= after {
				continue
			}
			if len(page) == f.pageSize {
				more = true
				break
			}
			page = append(page, it.wire(false))
		}
		b, _ := json.Marshal(map[string]any{"items": page, "more_after": more})
		reply(200, string(b))
	case len(parts) == 8 && parts[2] == "sessions" && parts[5] == "items" && parts[7] == "full" && r.Method == http.MethodGet:
		s := f.sessions[parts[3]+"/"+parts[4]]
		if s == nil || s.gone {
			reply(404, `{"error":"no session","code":"no_session"}`)
			return
		}
		f.fulls = append(f.fulls, parts[6])
		if f.fullFails {
			reply(502, `{"error":"node dropped","code":"node_unreachable"}`)
			return
		}
		for _, it := range s.items {
			if it.id() == parts[6] {
				b, _ := json.Marshal(it.wire(true))
				reply(200, string(b))
				return
			}
		}
		reply(404, `{"error":"no item","code":"not_found"}`)
	default:
		reply(404, `{"error":"not found","code":"not_found"}`)
	}
}

func (f *fakeHub) itemReads() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int64(nil), f.reads...)
}

func (f *fakeHub) fullReads() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.fulls...)
}

// posts counts the logged requests of a method whose path has the suffix.
func (f *fakeHub) posts(suffix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, l := range f.log {
		if strings.HasPrefix(l, "POST ") && strings.HasSuffix(l, suffix) {
			n++
		}
	}
	return n
}
