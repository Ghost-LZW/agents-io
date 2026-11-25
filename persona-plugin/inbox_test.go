package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/exttest"
	"github.com/nwverse/persona/sdk/go/wire"
)

func (r *rig) reply(thread, text, clientID string) error {
	return r.h.Call("connector.inbox.reply", wire.ConnectorInboxReply{Contribution: connectorID, Thread: thread, Text: text, ClientID: clientID}, nil)
}

// settleCall asks inbox.settle. An answer that settles nothing goes through the protocol; one that settles threads
// is asked of the handler directly, because the test host holds every JSON key to snake_case and the protocol keys
// "settled" by thread, which here is a channel conversation reference with colons.
func (r *rig) settleCall(threads ...string) map[string]string {
	r.t.Helper()
	if threads == nil {
		threads = []string{}
	}
	p := wire.ConnectorSettleParams{Contribution: connectorID, Threads: threads}
	res, err := r.x.settle(r.t.Context(), p)
	if err != nil {
		r.t.Fatal(err)
	}
	if len(res.Settled) == 0 {
		var again wire.ConnectorSettled
		if err := r.h.Call("connector.inbox.settle", p, &again); err != nil || len(again.Settled) != 0 {
			r.t.Fatalf("inbox.settle through the protocol: %v %v", again, err)
		}
	}
	return res.Settled
}

func changedEvents(h *exttest.Host) int {
	n := 0
	for _, e := range h.Events() {
		var p wire.ConnectorChangedEvent
		if e.Name == "connector.changed" && json.Unmarshal(e.Params, &p) == nil && p.Contribution == connectorID && p.Scope == "inbox" {
			n++
		}
	}
	return n
}

func TestCollectThings(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	first := fr.add(itemOpt{msg: "om_1", text: "first message", tag: "inbox", chatName: "Demo chat"})
	r.waitItem(first, stateInbox)
	things := r.collect()
	if len(things) != 1 {
		t.Fatalf("things = %v", things)
	}
	last1 := things[0]["last"]
	second := fr.add(itemOpt{msg: "om_2", text: "second message " + secretWords, tag: "inbox", chatName: "Demo chat",
		name: "Robin Example", sender: "ou_robin", url: "https://chat.example.test/m/om_2", unknown: true})
	r.waitItem(second, stateInbox)
	things = r.collect()
	if len(things) != 1 {
		t.Fatalf("two messages of one conversation are %d things", len(things))
	}
	th := things[0]
	// The thread is the channel conversation reference: stable, so the hub adds to the open item.
	if th["thread"] != demoThread || th["kind"] != "dm" || th["label"] != "demo-chat" || th["title"] != "Demo chat" {
		t.Errorf("thing = %v", th)
	}
	if th["sender"] != "Robin Example" || !strings.HasPrefix(th["preview"].(string), "second message") ||
		th["url"] != "https://chat.example.test/m/om_2" || th["can_reply"] != true || th["reply_to"] != "demo-chat · Demo chat" {
		t.Errorf("newest message's fields: %v", th)
	}
	if th["last"] == last1 || th["last"] != short(second) {
		t.Errorf("last did not change with the second message: %v", th["last"])
	}
	if at, _ := time.Parse(time.RFC3339, th["at"].(string)); !at.Equal(r.item(second).SentAt) {
		t.Errorf("at = %v", th["at"])
	}
	ctx := th["context"].(string)
	if !strings.Contains(ctx, "Sam Sample: first message") || !strings.Contains(ctx, "Robin Example: second message") ||
		strings.Index(ctx, "first") > strings.Index(ctx, "second") {
		t.Errorf("context = %q", ctx)
	}
	if _, has := th["tier"]; has {
		t.Errorf("tier is left to the model when there is one: %v", th["tier"])
	}
	ex := th["extra"].(map[string]any)
	if ex["rule_tier"] != "action" {
		t.Errorf("rule_tier = %v", ex["rule_tier"])
	}
	facts := ex["agentsio"].(map[string]any)
	for k, want := range map[string]any{"channel": "demo-chat", "account": "default", "conversation_id": "oc_demo",
		"conversation_kind": "dm", "message_id": "om_2", "channel_ref": "channel:demo-chat/om_2", "rule": "to-alpha",
		"tag": "inbox", "sender_id": "ou_robin", "evidence": "platform_signed"} {
		if facts[k] != want {
			t.Errorf("extra.agentsio.%s = %v, want %v", k, facts[k], want)
		}
	}
	// A thing without a link has no url.
	other := fr.add(itemOpt{conv: "oc_group", kind: "group", text: "team chatter", tag: "inbox"})
	r.waitItem(other, stateInbox)
	g := thingOf(r.collect(), "demo-chat:default:oc_group")
	if g == nil || g["kind"] != "group" || g["extra"].(map[string]any)["rule_tier"] != "fyi" {
		t.Fatalf("group thing = %v", g)
	}
	if _, has := g["url"]; has {
		t.Errorf("url without a link: %v", g["url"])
	}
	// A thread of a group is its own conversation, and a mention needs the owner.
	topic := fr.add(itemOpt{conv: "oc_group", kind: "thread", thread: "omt_1", text: "you there?", tag: "inbox", mention: true})
	r.waitItem(topic, stateInbox)
	tt := thingOf(r.collect(), "demo-chat:default:oc_group:omt_1")
	if tt == nil || tt["kind"] != "group" || tt["extra"].(map[string]any)["rule_tier"] != "action" {
		t.Errorf("topic thing = %v", tt)
	}
}

func TestCollectFollowsTheInboxRules(t *testing.T) {
	for _, rules := range []string{"", "群里没 @ 我的都算噪音\\n其余知悉"} {
		fr := newFakeRouter(t)
		r := startRig(t, fr, newFakeHub(t), withConfig("triage_rules", rules))
		a := fr.add(itemOpt{text: "one", tag: "inbox"})
		b := fr.add(itemOpt{conv: "oc_other", kind: "group", text: "two", bot: true})
		r.waitItem(a, stateInbox)
		r.waitItem(b, stateInbox)
		raw, _ := json.Marshal(r.collect())
		want := triageRulesIn(json.RawMessage(`{"triage_rules":"` + rules + `"}`))
		if err := checkThings(raw, want, true); err != nil {
			t.Errorf("rules %q: %v", rules, err)
		}
		if rules != "" && !strings.Contains(string(raw), `其余知悉`) {
			t.Errorf("the rules are not on the things")
		}
	}
}

// TestProtocolConformanceWithData holds a program that has things to the connector protocol's schema.
func TestProtocolConformanceWithData(t *testing.T) {
	fr := newFakeRouter(t)
	dir := t.TempDir()
	r := startRig(t, fr, newFakeHub(t), withDir(dir))
	id := fr.add(itemOpt{text: "hello", tag: "inbox", url: "https://chat.example.test/m/1", chatName: "Demo",
		blocks: []map[string]any{{"type": "text", "text": "hello"}, {"type": "file", "ref": "sha256:00", "mime": "text/plain", "name": "a.txt"}}})
	r.waitItem(id, stateInbox)
	r.stop()
	cfg, _ := json.Marshal(map[string]any{"router_url": fr.url()})
	x := newApp(fastTimings())
	run := exttest.Serve(t, program(x))
	h := exttest.StartWith(t, manifest, run, func(p *wire.InitializeParams) {
		p.Config, p.Secrets, p.Extension.DataDir = cfg, map[string]string{"backend_key": fakeKey}, dir
	})
	t.Cleanup(func() { _ = run.ToProgram.Close(); <-run.Exited })
	p := wire.ConnectorParams{Contribution: connectorID}
	var st wire.ConnectorStatus
	var tools wire.ConnectorTools
	var things wire.ConnectorCollectResult
	for method, out := range map[string]any{"connector.status": &st, "connector.tools.list": &tools, "connector.inbox.collect": &things} {
		if err := h.Call(method, p, out); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
	}
	if len(things.Things) != 1 || things.Things[0].Thread != demoThread || things.Things[0].Extra == nil || things.Things[0].Extra.RuleTier != "action" {
		t.Errorf("things = %+v", things.Things)
	}
	if len(tools.Tools) != 2 || tools.Tools[0].Name != toolAboutName || tools.Tools[1].Name != toolDestinationsName {
		t.Errorf("tools = %+v", tools.Tools)
	}
}

func TestChangedEventOnNewInboxItem(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	r.waitState(wire.ConnectorStateOk)
	if n := changedEvents(r.h); n != 0 {
		t.Fatalf("%d changed events before anything arrived", n)
	}
	var burst []string
	for i := 0; i < 5; i++ {
		burst = append(burst, fr.add(itemOpt{text: "burst", tag: "inbox"}))
	}
	eventually(t, "connector.changed {scope: inbox}", func() bool { return changedEvents(r.h) >= 1 })
	// The whole burst is taken (each item is two durable writes, which a busy disk makes slow), and its last event
	// is out: the count has stopped moving for several debounce periods.
	for _, id := range burst {
		r.waitItem(id, stateInbox)
	}
	settled := func() int {
		n, since := changedEvents(r.h), time.Now()
		for time.Since(since) < 10*fastTimings().changedDebounce {
			time.Sleep(5 * time.Millisecond)
			if now := changedEvents(r.h); now != n {
				n, since = now, time.Now()
			}
		}
		return n
	}
	before := settled()
	if before > 5 {
		t.Errorf("%d changed events for one burst", before)
	}
	// An echo of the deployment's own message changes nothing in the Inbox.
	id := fr.add(itemOpt{text: "echo", tag: "inbox", self: true})
	r.waitItem(id, stateSkipped)
	if settled() != before {
		t.Errorf("a skipped item woke the hub")
	}
}

func TestReplyUsesClientIDAsOperation(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	a := fr.add(itemOpt{msg: "om_1", text: "question one", tag: "inbox"})
	b := fr.add(itemOpt{msg: "om_2", text: "question two", tag: "inbox"})
	r.waitItem(b, stateInbox)
	if err := r.reply(demoThread, "the answer\x07", "c1d2-0001"); err != nil {
		t.Fatal(err)
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 1 || sends != 1 {
		t.Fatalf("delivers = %d, sends = %d", len(delivers), sends)
	}
	d := delivers[0]
	route := d["route"].(map[string]any)
	if d["operationId"] != "inbox-reply-c1d2-0001" || d["message"].(map[string]any)["text"] != "the answer" ||
		route["channel"] != "demo-chat" || route["account"] != "default" || route["conversationId"] != "oc_demo" ||
		route["replyToMessageId"] != "om_2" {
		t.Errorf("deliver = %v", d)
	}
	th := thingOf(r.collect(), demoThread)
	if th == nil || th["done"] != "replied" {
		t.Errorf("the replied thread is not handed over as done: %v", th)
	}
	// Both messages of the thread get the done mark, once.
	eventually(t, "done marks", func() bool { return len(fr.acksFor("om_1")) == 1 && len(fr.acksFor("om_2")) == 1 })
	if fr.acksFor("om_1")[0] != "done" || fr.acksFor("om_2")[0] != "done" {
		t.Errorf("marks = %v %v", fr.acksFor("om_1"), fr.acksFor("om_2"))
	}
	if r.item(a).Inbox.Done != "replied" || r.item(b).Inbox.Done != "replied" {
		t.Errorf("items are not done")
	}
}

func TestReplyRetrySameClientIDSendsOnce(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	id := fr.add(itemOpt{text: "question", tag: "inbox"})
	r.waitItem(id, stateInbox)
	// The first answer is lost after the router sent the message: the hub is told the outcome is unknown.
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{sendThenHangup: true}
			}
			return nil
		}
	})
	if err := r.reply(demoThread, "answer", "c-7"); err == nil || !strings.Contains(err.Error(), wordsReplyUnknown) {
		t.Fatalf("a lost answer: %v", err)
	}
	if r.item(id).Inbox.Done != "" {
		t.Errorf("an unknown outcome marked the thread done")
	}
	r.waitState(wire.ConnectorStateOk)
	// The hub asks again with the same client_id: the router answers its record, nothing is sent twice.
	eventually(t, "the same reply again", func() bool { return r.reply(demoThread, "answer", "c-7") == nil })
	if err := r.reply(demoThread, "answer", "c-7"); err != nil {
		t.Errorf("a third time: %v", err)
	}
	delivers, _, sends := fr.snapshot()
	if sends != 1 {
		t.Errorf("platform sends = %d, want 1", sends)
	}
	for _, d := range delivers {
		if d["operationId"] != "inbox-reply-c-7" {
			t.Errorf("another operation id: %v", d["operationId"])
		}
	}
	if r.item(id).Inbox.Done != "replied" {
		t.Errorf("the thread is not done after the settled reply")
	}
}

func TestReplyUnknownOutcomeIsAnError(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	id := fr.add(itemOpt{text: "question", tag: "inbox"})
	r.waitItem(id, stateInbox)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{status: "unknown"} }
	})
	err := r.reply(demoThread, "answer", "c-9")
	if err == nil || !strings.Contains(err.Error(), wordsReplyUnknown) {
		t.Fatalf("status unknown: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 1 || sends != 0 || delivers[0]["operationId"] != "inbox-reply-c-9" {
		t.Errorf("delivers = %v", delivers)
	}
	if r.item(id).Inbox.Done != "" {
		t.Errorf("the thread was marked done")
	}
	// Rejected and out-of-scope are said as such.
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{status: "rejected"} }
	})
	if err := r.reply(demoThread, "answer", "c-10"); err == nil || !strings.Contains(err.Error(), wordsReplyRejected) {
		t.Errorf("rejected: %v", err)
	}
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{errCode: "route_not_allowed"} }
	})
	if err := r.reply(demoThread, "answer", "c-11"); err == nil || !strings.Contains(err.Error(), wordsReplyScope) {
		t.Errorf("route_not_allowed: %v", err)
	}
	// No client_id: the operation id is derived from the reply itself, so the same reply is the same operation.
	fr.set(func(f *fakeRouter) { f.onDeliver = nil })
	if err := r.reply(demoThread, "answer", ""); err != nil {
		t.Fatal(err)
	}
	delivers, _, _ = fr.snapshot()
	if op, _ := delivers[len(delivers)-1]["operationId"].(string); !strings.HasPrefix(op, "inbox-reply-") || len(op) != len("inbox-reply-")+32 {
		t.Errorf("derived operation id = %q", op)
	}
}

func TestReplyWhileRouterDown(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	id := fr.add(itemOpt{text: "question", tag: "inbox"})
	r.waitItem(id, stateInbox)
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 503 })
	fr.dropAll()
	r.waitState(wire.ConnectorStateError)
	began := time.Now()
	err := r.reply(demoThread, "answer", "c-1")
	if err == nil || !strings.Contains(err.Error(), wordsReplyOffline) || time.Since(began) > time.Second {
		t.Fatalf("reply while down: %v after %v", err, time.Since(began))
	}
	// Nothing is queued for later: after the router is back, no deliver goes out by itself.
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 0 })
	r.waitState(wire.ConnectorStateOk)
	time.Sleep(60 * time.Millisecond)
	if delivers, _, _ := fr.snapshot(); len(delivers) != 0 {
		t.Errorf("a reply was sent later by itself: %v", delivers)
	}
}

func TestReplyRefusals(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	id := fr.add(itemOpt{text: "question", tag: "inbox"})
	noRoute := fr.add(itemOpt{conv: "oc_watch", text: "observed", tag: "inbox", noRoute: true})
	r.waitItem(id, stateInbox)
	r.waitItem(noRoute, stateInbox)
	err := r.h.Call("connector.inbox.reply", wire.ConnectorInboxReply{Contribution: connectorID, Thread: demoThread, Text: "x",
		Changes: []wire.ConnectorStatusChange{{}}}, nil)
	if err == nil || !strings.Contains(err.Error(), wordsReplyChanges) {
		t.Errorf("changes: %v", err)
	}
	for thread, tc := range map[string]struct{ text, want string }{
		demoThread:                   {"  ", wordsReplyEmpty},
		"demo-chat:default:oc_none":  {"x", wordsReplyNoThread},
		"demo-chat:default:oc_watch": {"x", wordsReplyNoRoute},
	} {
		if err := r.reply(thread, tc.text, "c"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v", thread, err)
		}
	}
	if delivers, _, _ := fr.snapshot(); len(delivers) != 0 {
		t.Errorf("a refused reply reached the router")
	}
}

func TestSettleAnswersAndMarksDone(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	replied := fr.add(itemOpt{msg: "om_r", conv: "oc_replied", text: "to answer", tag: "inbox"})
	filed := fr.add(itemOpt{msg: "om_f", conv: "oc_filed", text: "to file", tag: "inbox"})
	fresh := fr.add(itemOpt{msg: "om_n", conv: "oc_new", text: "just in", tag: "inbox"})
	r.waitItem(fresh, stateInbox)
	tReplied, tFiled, tNew := "demo-chat:default:oc_replied", "demo-chat:default:oc_filed", "demo-chat:default:oc_new"
	// The hub has two of them open; the third it has not collected yet.
	if got := r.settleCall(tReplied, tFiled, "demo-chat:default:oc_forgotten"); len(got) != 1 || got["demo-chat:default:oc_forgotten"] != wordsSettledGone {
		t.Fatalf("settled = %v", got)
	}
	if len(fr.acksFor("om_r"))+len(fr.acksFor("om_f"))+len(fr.acksFor("om_n")) != 0 {
		t.Fatalf("open threads were marked")
	}
	if err := r.reply(tReplied, "answer", "c-1"); err != nil {
		t.Fatal(err)
	}
	// The owner filed oc_filed in the app: the hub no longer lists it.
	got := r.settleCall(tReplied)
	if len(got) != 1 || got[tReplied] != wordsSettledReplied {
		t.Fatalf("settled = %v", got)
	}
	eventually(t, "done marks", func() bool { return len(fr.acksFor("om_f")) == 1 && len(fr.acksFor("om_r")) == 1 })
	if r.item(filed).Inbox.Done != "filed" || !r.item(filed).Inbox.Closed || !r.item(replied).Inbox.Closed {
		t.Errorf("items: %+v %+v", r.item(filed).Inbox, r.item(replied).Inbox)
	}
	// A thread the hub never listed is not closed by its absence.
	if rec := r.item(fresh); rec.Inbox.Done != "" || rec.Inbox.Closed || len(fr.acksFor("om_n")) != 0 {
		t.Errorf("a brand-new thread was closed: %+v", rec.Inbox)
	}
	things := r.collect()
	if len(things) != 1 || things[0]["thread"] != tNew {
		t.Errorf("collect after settling = %v", things)
	}
	// Asked again, nothing is marked twice.
	if got := r.settleCall(tReplied, tNew); got[tReplied] != wordsSettledGone || len(got) != 1 {
		t.Errorf("settled again = %v", got)
	}
	r.settleCall()
	time.Sleep(40 * time.Millisecond)
	if n := len(fr.acksFor("om_f")) + len(fr.acksFor("om_r")); n != 2 {
		t.Errorf("%d done marks, want one per message", n)
	}
	if rec := r.item(fresh); rec.Inbox.Done != "filed" {
		t.Errorf("a thread seen open and then no longer listed is filed: %+v", rec.Inbox)
	}
	// A new message in a filed conversation opens it again.
	again := fr.add(itemOpt{msg: "om_f2", conv: "oc_filed", text: "one more", tag: "inbox"})
	r.waitItem(again, stateInbox)
	if th := thingOf(r.collect(), tFiled); th == nil || th["done"] != nil || th["last"] != short(again) {
		t.Errorf("reopened thing = %v", th)
	}
}

func TestAckUnsupportedIsIgnored(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) {
		f.onAck = func(map[string]any) *fakeAnswer { return &fakeAnswer{errCode: "unsupported"} }
	})
	r := startRig(t, fr, newFakeHub(t))
	a := fr.add(itemOpt{msg: "om_1", text: "q", tag: "inbox"})
	r.waitItem(a, stateInbox)
	if err := r.reply(demoThread, "answer", "c-1"); err != nil {
		t.Fatalf("a channel without marks failed the reply: %v", err)
	}
	if !r.item(a).Inbox.Marked || len(fr.acksFor("om_1")) != 1 {
		t.Errorf("the mark is tried once and then left: %+v, %v", r.item(a).Inbox, fr.acksFor("om_1"))
	}
	// With the marks switched off nothing is asked at all.
	fr2 := newFakeRouter(t)
	r2 := startRig(t, fr2, newFakeHub(t), withConfig("working_mark", false))
	b := fr2.add(itemOpt{msg: "om_2", text: "q", tag: "inbox"})
	r2.waitItem(b, stateInbox)
	if err := r2.reply(demoThread, "answer", "c-2"); err != nil {
		t.Fatal(err)
	}
	if _, acks, _ := fr2.snapshot(); len(acks) != 0 {
		t.Errorf("marks with working_mark off: %v", acks)
	}
}

func TestAboutToolSaysNothingPrivate(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	id := fr.add(itemOpt{text: "private " + secretWords, tag: "inbox"})
	r.waitItem(id, stateInbox)
	var res wire.ConnectorCallResult
	if err := r.h.Call("connector.tools.call", wire.ConnectorCallParams{Contribution: connectorID, Name: toolAboutName}, &res); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Text), &out); err != nil || out["router"] != "已连接" || out["backend"] != "alpha" {
		t.Errorf("about = %s", res.Text)
	}
	if strings.Contains(res.Text, secretWords) || strings.Contains(res.Text, "Sam") {
		t.Errorf("about carries message content")
	}
	if err := r.h.Call("connector.tools.call", wire.ConnectorCallParams{Contribution: connectorID, Name: "nope"}, &res); err == nil {
		t.Errorf("an unknown tool was run")
	}
}

// TestFailedRoundTripMovesTheInboxThing: a round trip that fails is the thread's latest step even when a newer
// message of the same conversation is already in the Inbox. The thing's last and at change with the failure, so the
// hub moves its open item (or starts a new one after the owner filed the earlier message).
func TestFailedRoundTripMovesTheInboxThing(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.row.Status = "working"
		s.say("assistant", "tool_use", "", "")
	}
	began := time.Now().Add(-time.Second)
	b := fr.add(itemOpt{msg: "om_b", text: "for the assistant", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(b, stateRunning)
	c := fr.add(itemOpt{msg: "om_c", text: "straight to the Inbox", tag: "inbox"})
	r.waitItem(c, stateInbox)
	th := thingOf(r.collect(), demoThread)
	if th == nil || th["last"] != short(c) {
		t.Fatalf("before the failure: %v", th)
	}
	// The turn ends without words: the round trip of the earlier message fails.
	fh.set(func(f *fakeHub) { f.session(1).row.Status = "idle" })
	rec := r.waitItem(b, stateFailed)
	th = thingOf(r.collect(), demoThread)
	if th == nil || th["last"] != short(b) || th["why"] != rec.Why || th["extra"].(map[string]any)["rule_tier"] != "action" {
		t.Fatalf("after the failure the thing does not move: %v", th)
	}
	at, _ := time.Parse(time.RFC3339Nano, th["at"].(string))
	if at.Before(began) || at.After(time.Now().Add(time.Second)) {
		t.Errorf("at = %v, want the time of the failure", th["at"])
	}
	if !strings.HasPrefix(th["preview"].(string), "for the assistant") {
		t.Errorf("preview = %v", th["preview"])
	}
	// A message after the failure is the newest step again.
	d := fr.add(itemOpt{msg: "om_d", text: "one more", tag: "inbox"})
	r.waitItem(d, stateInbox)
	if th = thingOf(r.collect(), demoThread); th == nil || th["last"] != short(d) || th["why"] != rec.Why {
		t.Errorf("a later message: %v", th)
	}
}

// TestReplyRefusedIsNotSent: a refusal of the router says nothing was sent and does not use up the operation id. It
// is reported as not sent (never as "outcome unknown"), and the same reply sent again goes out once.
func TestReplyRefusedIsNotSent(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	id := fr.add(itemOpt{text: "question", tag: "inbox"})
	r.waitItem(id, stateInbox)
	for code, want := range map[string]string{"stopped": wordsReplyOffline, "unauthorized": wordsReplyOffline, "forbidden": wordsReplyRefused,
		"invalid_frame": wordsReplyRefused} {
		fr.set(func(f *fakeRouter) {
			f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{errCode: code} }
		})
		r.waitState(wire.ConnectorStateOk)
		err := r.reply(demoThread, "answer", "c-21")
		if err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), wordsReplyUnknown) {
			t.Errorf("%s: %v, want %q", code, err, want)
		}
		if r.item(id).Inbox.Done != "" {
			t.Errorf("%s: the thread was marked done", code)
		}
	}
	// "internal" is the one refusal after which the message may be out.
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{errCode: "internal"} }
	})
	r.waitState(wire.ConnectorStateOk)
	if err := r.reply(demoThread, "answer", "c-22"); err == nil || !strings.Contains(err.Error(), wordsReplyUnknown) {
		t.Errorf("internal: %v", err)
	}
	fr.set(func(f *fakeRouter) { f.onDeliver = nil })
	eventually(t, "the same reply again", func() bool { return r.reply(demoThread, "answer", "c-21") == nil })
	if _, _, sends := fr.snapshot(); sends != 1 {
		t.Errorf("platform sends = %d", sends)
	}
}

// TestOldInboxItemsAreNotCollectedForGood: an Inbox item older than the hub's window that the hub does not hold open
// is closed at start and no longer collected; one the hub still lists stays, and the listing is remembered.
func TestOldInboxItemsAreNotCollectedForGood(t *testing.T) {
	fr := newFakeRouter(t)
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old := now.Add(-inboxWindow - time.Hour)
	seed := func(id, conv string, inbox inboxRec) {
		rec := itemRec{ID: id, Tag: tagInbox, ConvKey: "demo-chat:default:" + conv, Channel: "demo-chat", ConvKind: "dm", ConvID: conv,
			SenderName: "Robin Example", Text: "old words", ReceivedAt: old, SentAt: old, TakenAt: old, State: stateInbox, Inbox: inbox}
		if _, err := st.add(rec); err != nil {
			t.Fatal(err)
		}
	}
	seed("muted", "oc_muted", inboxRec{})                                                          // the hub never listed it
	seed("held", "oc_held", inboxRec{SeenOpen: true, ListedAt: now.Add(-listedEvery - time.Hour)}) // the hub holds it open
	seed("dropped", "oc_dropped", inboxRec{SeenOpen: true, ListedAt: old})                         // filed with no settle after
	r := startRig(t, fr, newFakeHub(t), withDir(dir))
	eventually(t, "old items closed", func() bool { return r.item("muted").Inbox.Closed && r.item("dropped").Inbox.Closed })
	if rec := r.item("muted"); rec.Inbox.Done != "expired" || rec.Inbox.Marked {
		t.Errorf("muted = %+v", rec.Inbox)
	}
	things := r.collect()
	if len(things) != 1 || things[0]["thread"] != "demo-chat:default:oc_held" {
		t.Fatalf("collect = %v", things)
	}
	// The hub lists the held thread again: that is written down, at most now and then.
	if got := r.settleCall("demo-chat:default:oc_held"); len(got) != 0 {
		t.Errorf("settled = %v", got)
	}
	listed := r.item("held").Inbox.ListedAt
	if now.Sub(listed) > time.Minute {
		t.Errorf("listed_at = %v", listed)
	}
	r.settleCall("demo-chat:default:oc_held")
	if again := r.item("held").Inbox.ListedAt; !again.Equal(listed) {
		t.Errorf("listed_at was written again right away: %v then %v", listed, again)
	}
	if dropped, expired := r.x.store().prune(time.Now(), 30*24*time.Hour); dropped+expired != 0 {
		t.Errorf("an item the hub holds open was touched: %d %d", dropped, expired)
	}
	// A thread whose items are all closed is over when the hub asks.
	if got := r.settleCall("demo-chat:default:oc_muted"); got["demo-chat:default:oc_muted"] != wordsSettledGone {
		t.Errorf("settled = %v", got)
	}
}
