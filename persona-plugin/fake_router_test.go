package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeKey is an obviously fake backend key.
const fakeKey = "aiob_test_key_not_real"

// fakeAnswer scripts the fake router's answer to one request.
type fakeAnswer struct {
	errCode        string        // answer ok:false with this code (nothing is sent, the operation id is not used up)
	status         string        // the deliver's settled status instead of delivered ("unknown", "rejected")
	drop           bool          // no answer at all, nothing sent
	sendThenHangup bool          // send and record, then close the connection without answering
	ids            []string      // the settled record also lists these as providerMessageIds
	delay          time.Duration // wait this long before answering (the send is recorded after the wait)
}

type queued struct {
	cursor int64
	raw    json.RawMessage
}

// fakeRouter is an agents-io router as a backend sees it: the console's /ws, host.hello with a backend key, one
// pushed item at a time until it is accepted, deliver with operation ids, message.ack.
type fakeRouter struct {
	t   testing.TB
	srv *httptest.Server

	mu            sync.Mutex
	key, backend  string
	features      []string
	upgradeStatus int
	noBackend     bool   // hello answers as for a host token: no backend block
	access        string // the key's level as hello says it ("read", "readwrite"); empty: a router without key levels
	mute          bool   // connections stop reading: no pongs, no answers
	dropAccepts   int    // accepts to lose: the connection is closed instead of advancing the cursor
	extras        []map[string]any
	hellos        []map[string]any
	queue         []queued
	acked         int64
	nextCursor    int64
	pushes        int
	delivers      []map[string]any
	acks          []map[string]any
	ops           map[string]map[string]any
	sends         int
	connects      int
	onDeliver     func(n int, f map[string]any) *fakeAnswer
	onAck         func(f map[string]any) *fakeAnswer
	conns         map[*websocket.Conn]chan struct{}
	pushConn      *websocket.Conn
	// epoch is the time of the first message, in milliseconds: an hour ago, so the items are recent as a router's are.
	epoch int64
}

func newFakeRouter(t testing.TB) *fakeRouter {
	f := &fakeRouter{t: t, key: fakeKey, backend: "alpha", features: []string{"backends", "deliver.update", "message.ack", "host.takeover", "binding.tag", "blobs"},
		ops: map[string]map[string]any{}, conns: map[*websocket.Conn]chan struct{}{}, nextCursor: 10,
		epoch: time.Now().Add(-time.Hour).UnixMilli()}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() {
		f.dropAll()
		f.srv.Close()
	})
	return f
}

func (f *fakeRouter) url() string { return f.srv.URL }

func (f *fakeRouter) set(change func(f *fakeRouter)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

// dropAll closes every connection, as a router restart does; the queue, the cursor and the operation records stay.
func (f *fakeRouter) dropAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for c, done := range f.conns {
		close(done)
		_ = c.CloseNow()
		delete(f.conns, c)
	}
	f.pushConn = nil
}

func refuse(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":{"code":%q,"message":"refused"}}`, code)
}

func (f *fakeRouter) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.connects++
	status, key := f.upgradeStatus, f.key
	f.mu.Unlock()
	switch {
	case r.URL.Path != "/ws":
		refuse(w, 404, "not_found")
		return
	case status != 0:
		refuse(w, status, "refused")
		return
	case r.Header.Get("Authorization") != "Bearer "+key:
		refuse(w, 401, "unauthorized")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"agents-io.v1"}})
	if err != nil {
		return
	}
	if c.Subprotocol() != "agents-io.v1" {
		_ = c.Close(websocket.StatusPolicyViolation, "subprotocol")
		return
	}
	c.SetReadLimit(4 << 20) // a long answer is one frame
	done := make(chan struct{})
	f.mu.Lock()
	f.conns[c] = done
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		if _, ok := f.conns[c]; ok {
			close(done)
			delete(f.conns, c)
		}
		if f.pushConn == c {
			f.pushConn = nil
		}
		f.mu.Unlock()
		_ = c.CloseNow()
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-done:
			cancel()
		case <-ctx.Done():
		}
	}()
	results := make(chan map[string]any, 16)
	authed := false
	write := func(v any) {
		b, _ := json.Marshal(v)
		wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
		defer wcancel()
		_ = c.Write(wctx, websocket.MessageText, b)
	}
	answer := func(id any, value any) {
		write(map[string]any{"v": 1, "type": "result", "id": id, "ok": true, "value": value})
	}
	fail := func(id any, code string) {
		write(map[string]any{"v": 1, "type": "result", "id": id, "ok": false, "error": map[string]any{"code": code, "message": "refused: " + code}})
	}
	for {
		f.mu.Lock()
		mute := f.mute
		f.mu.Unlock()
		if mute { // a half-open connection: nothing is read, so no pong goes back
			<-ctx.Done()
			return
		}
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		id := m["id"]
		switch m["type"] {
		case "result":
			results <- m
		case "host.hello":
			f.mu.Lock()
			f.hellos = append(f.hellos, m)
			backend, features, noBackend, key, access := f.backend, f.features, f.noBackend, f.key, f.access
			extras := f.extras
			f.mu.Unlock()
			consumer, consuming := m["consumer"].(string)
			switch {
			case authed:
				fail(id, "already_authenticated")
				continue
			case m["token"] != key:
				fail(id, "unauthorized")
				continue
			case consuming && !noBackend && consumer != "backend:"+backend && consumer != backend:
				fail(id, "forbidden")
				continue
			case consuming && !noBackend && access == "read": // a read key observes: it is never the consumer
				fail(id, "forbidden")
				continue
			}
			authed = true
			block := map[string]any{"id": backend}
			if access != "" {
				block["access"] = access
			}
			value := map[string]any{"name": "backend:" + backend, "protocol": 1, "host": false,
				"backend":  block,
				"bindings": map[string]any{"version": nil, "active": false}, "features": features}
			if noBackend {
				value = map[string]any{"name": m["name"], "protocol": 1, "host": consuming,
					"bindings": map[string]any{"version": nil, "active": false}, "features": features}
			}
			if consuming && !noBackend {
				f.mu.Lock()
				if old := f.pushConn; old != nil && old != c {
					if m["takeover"] != true {
						f.mu.Unlock()
						fail(id, "host_connected")
						continue
					}
					if d, ok := f.conns[old]; ok {
						close(d)
						delete(f.conns, old)
					}
					_ = old.CloseNow()
				}
				f.pushConn = c
				value["inbound"] = map[string]any{"consumer": "backend:" + backend, "acked": f.acked, "head": f.nextCursor - 1}
				f.mu.Unlock()
			}
			answer(id, value)
			for _, e := range extras {
				write(e)
			}
			if consuming && !noBackend {
				go f.push(ctx, c, write, results)
			}
		case "deliver":
			if !authed {
				fail(id, "unauthorized")
				continue
			}
			f.mu.Lock()
			f.delivers = append(f.delivers, m)
			n, script := len(f.delivers), f.onDeliver
			f.mu.Unlock()
			var ans *fakeAnswer
			if script != nil {
				ans = script(n, m)
			}
			if ans != nil && ans.drop {
				continue
			}
			if ans != nil && ans.delay > 0 {
				time.Sleep(ans.delay)
			}
			if ans != nil && ans.errCode != "" {
				fail(id, ans.errCode)
				continue
			}
			op, _ := m["operationId"].(string)
			f.mu.Lock()
			rec, known := f.ops[op]
			if known {
				dup := map[string]any{}
				for k, v := range rec {
					dup[k] = v
				}
				dup["duplicate"] = true
				rec = dup
			} else {
				status := "delivered"
				if ans != nil && ans.status != "" {
					status = ans.status
				}
				rec = map[string]any{"operationId": op, "sessionKey": "host:backend:" + f.backend, "route": m["route"], "status": status,
					"attempts": 1, "duplicate": false}
				if status == "delivered" {
					f.sends++
					rec["providerMessageId"] = fmt.Sprintf("pm_%d", f.sends)
					if ans != nil && len(ans.ids) > 0 {
						rec["providerMessageIds"] = ans.ids
					}
				}
				f.ops[op] = rec
			}
			f.mu.Unlock()
			if ans != nil && ans.sendThenHangup {
				return
			}
			answer(id, rec)
		case "message.ack":
			if !authed {
				fail(id, "unauthorized")
				continue
			}
			f.mu.Lock()
			f.acks = append(f.acks, m)
			script := f.onAck
			f.mu.Unlock()
			if script != nil {
				if ans := script(m); ans != nil {
					if ans.errCode != "" {
						fail(id, ans.errCode)
					}
					continue
				}
			}
			answer(id, map[string]any{"messageId": m["messageId"], "state": m["state"]})
		default:
			fail(id, "forbidden")
		}
	}
}

// push is the router's push consumption: one item at a time, the same one again until it is accepted, then the
// cursor advances. A new subscription starts from the acked cursor.
func (f *fakeRouter) push(ctx context.Context, c *websocket.Conn, write func(any), results chan map[string]any) {
	for n := 0; ctx.Err() == nil; n++ {
		f.mu.Lock()
		var next *queued
		for i := range f.queue {
			if f.queue[i].cursor > f.acked {
				next = &f.queue[i]
				break
			}
		}
		current := f.pushConn == c
		f.mu.Unlock()
		if !current {
			return
		}
		if next == nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Millisecond):
			}
			continue
		}
		id := fmt.Sprintf("push-%d-%d", next.cursor, n)
		f.mu.Lock()
		f.pushes++
		f.mu.Unlock()
		write(map[string]any{"v": 1, "type": "inbound", "id": id, "item": next.raw})
		accepted := false
		wait := time.After(2 * time.Second)
	waiting:
		for {
			select {
			case <-ctx.Done():
				return
			case <-wait:
				break waiting
			case res := <-results:
				if res["id"] != id {
					continue
				}
				value, _ := res["value"].(map[string]any)
				accepted = res["ok"] == true && value["accepted"] == true
				break waiting
			}
		}
		if accepted {
			f.mu.Lock()
			if f.dropAccepts > 0 { // the router goes away before it records the accept
				f.dropAccepts--
				f.mu.Unlock()
				_ = c.CloseNow()
				return
			}
			f.acked = next.cursor
			f.mu.Unlock()
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// itemOpt describes a synthetic queue item.
type itemOpt struct {
	msg, conv, kind, thread string
	text                    string
	tag, rule               string
	sender, name            string
	labels                  []string
	unknown                 bool // no principal
	noRoute, self, bot      bool
	click                   bool
	mention                 bool
	url, chatName           string
	blocks                  []map[string]any
}

// add queues one item and answers the id the extension gives it.
func (f *fakeRouter) add(o itemOpt) string {
	def := func(v *string, d string) {
		if *v == "" {
			*v = d
		}
	}
	def(&o.conv, "oc_demo")
	def(&o.kind, "dm")
	def(&o.rule, "to-alpha")
	def(&o.sender, "ou_sender")
	def(&o.name, "Sam Sample")
	f.mu.Lock()
	defer f.mu.Unlock()
	cursor := f.nextCursor
	f.nextCursor += 3 // cursors of one backend are not contiguous
	def(&o.msg, fmt.Sprintf("om_%d", cursor))
	content := o.blocks
	if content == nil {
		content = []map[string]any{{"type": "text", "text": o.text}}
	}
	if o.click {
		content = []map[string]any{{"type": "event", "name": "action", "data": map[string]any{"actionId": "pa:x:allow", "messageId": "pm_1"}}}
	}
	var route any
	if !o.noRoute {
		r := map[string]any{"channel": "demo-chat", "account": "default", "conversationId": o.conv, "replyToMessageId": o.msg}
		if o.thread != "" {
			r["threadId"] = o.thread
		}
		route = r
	}
	var principal any
	if !o.unknown {
		labels := o.labels
		if labels == nil {
			labels = []string{}
		}
		principal = map[string]any{"id": "p_" + o.sender, "labels": labels}
	}
	ctxFacts := map[string]any{}
	if o.chatName != "" {
		ctxFacts["chatName"] = o.chatName
	}
	if o.url != "" {
		ctxFacts["url"] = o.url
	}
	conv := map[string]any{"id": o.conv, "kind": o.kind}
	if o.thread != "" {
		conv["threadId"] = o.thread
	}
	env := map[string]any{"v": 1, "id": o.msg, "channel": "demo-chat", "account": "default", "conversation": conv,
		"sender":  map[string]any{"channelUserId": o.sender, "displayName": o.name, "isBot": o.bot, "evidence": "platform_signed"},
		"content": content, "context": ctxFacts, "replyRoute": route, "sentAt": f.epoch + cursor*1000}
	if o.mention {
		env["mentions"] = []map[string]any{{"id": "ou_me"}}
	}
	ref := "channel:demo-chat/" + o.msg
	item := map[string]any{"cursor": cursor, "channelRef": ref, "account": "default", "bindingId": o.rule, "to": f.backend,
		"input": map[string]any{"inputId": "in_" + o.msg, "content": content, "replyRoute": route, "channelRef": ref,
			"channelContext": ctxFacts,
			"origin": map[string]any{"kind": "human", "principal": principal, "evidence": "platform_signed", "self": o.self,
				"via": "demo-chat:default:" + o.conv, "adapter": "demo"}},
		"envelope": env, "receivedAt": f.epoch + cursor*1000 + 5}
	if o.tag != "" {
		item["tag"] = o.tag
	}
	raw, _ := json.Marshal(item)
	f.queue = append(f.queue, queued{cursor: cursor, raw: raw})
	return "default/" + ref
}

// addRaw queues an item as written, with the next cursor in place of %d.
func (f *fakeRouter) addRaw(format string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	cursor := f.nextCursor
	f.nextCursor += 3
	f.queue = append(f.queue, queued{cursor: cursor, raw: json.RawMessage(fmt.Sprintf(format, cursor))})
	return cursor
}

func (f *fakeRouter) snapshot() (delivers, acks []map[string]any, sends int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.delivers...), append([]map[string]any(nil), f.acks...), f.sends
}

// acksFor are the states message.ack put on one channel message, in order.
func (f *fakeRouter) acksFor(msg string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, a := range f.acks {
		if a["messageId"] == msg {
			out = append(out, fmt.Sprint(a["state"]))
		}
	}
	return out
}
