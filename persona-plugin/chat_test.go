package main

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

func routeOf(d map[string]any) map[string]any { r, _ := d["route"].(map[string]any); return r }
func textOf(d map[string]any) string {
	m, _ := d["message"].(map[string]any)
	s, _ := m["text"].(string)
	return s
}

func (f *fakeHub) open(n int) hubOpen {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.opens[n]
}

func (f *fakeHub) send(n int) hubSend {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sends[n]
}

func TestNewConversationRoundTrip(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.say("assistant", "tool_use", "", "")
		s.say("assistant", "text", "the final answer", "")
	}
	id := fr.add(itemOpt{msg: "om_1", text: "what is the plan? " + secretWords, tag: "chat", labels: []string{"owner"}, chatName: "Demo"})
	r := startRig(t, fr, fh)
	rec := r.waitItem(id, stateDone)
	if opens, sends := fh.counts(); opens != 1 || sends != 0 {
		t.Fatalf("%d conversations, %d messages", opens, sends)
	}
	o := fh.open(0)
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(o.opID) || o.opID != opUUID("open/"+id) {
		t.Errorf("operation id = %q", o.opID)
	}
	if _, guest := o.body["guest"]; guest {
		t.Errorf("a chat item opened a guest conversation")
	}
	prompt, _ := o.body["prompt"].(string)
	first, rest, _ := strings.Cut(prompt, "\n")
	// The first line says who sent it and through which channel: the product has no sender field.
	for _, want := range []string{"【渠道消息】", "Sam Sample", "路由认定：主人，凭据 platform_signed", "demo-chat 私聊", "Demo", refToken(rec)} {
		if !strings.Contains(first, want) {
			t.Errorf("the sender line lacks %q: %q", want, first)
		}
	}
	if rest != "\nwhat is the plan? "+secretWords {
		t.Errorf("the message after the sender line = %q", rest)
	}
	conv, ok := r.x.store().conv(demoThread)
	if !ok || conv.MachineID != "m1" || conv.SessionID != "s1" || conv.Guest || conv.LastSeq != 3 {
		t.Errorf("mapping = %+v", conv)
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 1 || sends != 1 {
		t.Fatalf("delivers = %d, platform sends = %d", len(delivers), sends)
	}
	d := delivers[0]
	if d["operationId"] != "reply-"+short(id) || textOf(d) != "the final answer" || routeOf(d)["conversationId"] != "oc_demo" ||
		routeOf(d)["channel"] != "demo-chat" || routeOf(d)["replyToMessageId"] != "om_1" {
		t.Errorf("deliver = %v", d)
	}
	eventually(t, "working then done", func() bool { return strings.Join(fr.acksFor("om_1"), ",") == "working,done" })
	if rec.Run.Answer != "" || rec.Run.State != "delivered" {
		t.Errorf("run = %+v", rec.Run)
	}
	if th := thingOf(r.collect(), demoThread); th != nil {
		t.Errorf("an answered chat item is in the Inbox: %v", th)
	}
}

func TestExistingConversationUsesClientMsgID(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	n := 0
	fh.turn = func(s *fakeSession, text, msgID string) {
		n++
		s.say("assistant", "text", fmt.Sprintf("answer %d", n), "")
	}
	first := fr.add(itemOpt{msg: "om_1", text: "one", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(first, stateDone)
	second := fr.add(itemOpt{msg: "om_2", text: "two", tag: "chat"})
	rec := r.waitItem(second, stateDone)
	if opens, sends := fh.counts(); opens != 1 || sends != 1 {
		t.Fatalf("%d conversations, %d messages; want the second item sent into the first's conversation", opens, sends)
	}
	s := fh.send(0)
	if s.mid != "m1" || s.sid != "s1" || s.body["client_msg_id"] != "agentsio-"+short(second) {
		t.Errorf("send = %+v", s)
	}
	if text, _ := s.body["text"].(string); !strings.HasPrefix(text, "【渠道消息】") || !strings.HasSuffix(text, "\n\ntwo") {
		t.Errorf("text = %q", text)
	}
	if len(s.body) != 2 {
		t.Errorf("the message carries more than text and client_msg_id: %v", s.body)
	}
	if rec.Run.Head || rec.Run.BaseSeq != 2 || rec.Run.MsgID != "agentsio-"+short(second) {
		t.Errorf("run = %+v", rec.Run)
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 2 || sends != 2 || textOf(delivers[0]) != "answer 1" || textOf(delivers[1]) != "answer 2" ||
		delivers[1]["operationId"] != "reply-"+short(second) || routeOf(delivers[1])["replyToMessageId"] != "om_2" {
		t.Errorf("delivers = %v", delivers)
	}
}

func TestBusyThenFinished(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.row.Status = "working"
		s.say("assistant", "text", "let me look into it", "")
		s.say("assistant", "tool_use", "", "")
	}
	id := fr.add(itemOpt{msg: "om_1", text: "question", tag: "chat"})
	r := startRig(t, fr, fh)
	eventually(t, "the turn is watched", func() bool { return r.item(id).Run != nil && r.item(id).Run.Seen })
	steady(t, "nothing is delivered while the conversation works", 150*time.Millisecond, func() bool {
		d, _, _ := fr.snapshot()
		return len(d) == 0 && r.item(id).State == stateRunning
	})
	fh.set(func(f *fakeHub) {
		s := f.session(1)
		s.say("assistant", "text", "partial thought", "")
		s.say("assistant", "tool_use", "", "")
		s.say("assistant", "text", "here is the final answer", "")
		s.row.Status = "idle"
	})
	r.waitItem(id, stateDone)
	time.Sleep(50 * time.Millisecond)
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 1 || sends != 1 || textOf(delivers[0]) != "here is the final answer" {
		t.Errorf("delivers = %v", delivers)
	}
	if got := strings.Join(fr.acksFor("om_1"), ","); got != "working,done" {
		t.Errorf("marks = %s", got)
	}
}

func TestWaitsWhileAwaitingAnswer(t *testing.T) {
	for _, tc := range []struct {
		name string
		wait func(s *fakeSession)
	}{
		{"blocked", func(s *fakeSession) { s.row.Status = "blocked" }},
		{"pending interaction", func(s *fakeSession) { s.row.Status, s.row.PendingInteractions = "idle", 1 }},
		{"starting", func(s *fakeSession) { s.row.Status, s.row.Starting = "idle", true }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			fh.turn = func(s *fakeSession, text, msgID string) {
				tc.wait(s)
				s.say("assistant", "text", "I need your approval to continue", "")
			}
			id := fr.add(itemOpt{text: "do the thing", tag: "chat"})
			r := startRig(t, fr, fh)
			eventually(t, "the turn is watched", func() bool { return r.item(id).Run != nil && r.item(id).Run.Seen })
			steady(t, "nothing is delivered while an answer is awaited", 200*time.Millisecond, func() bool {
				d, _, _ := fr.snapshot()
				return len(d) == 0
			})
			fh.set(func(f *fakeHub) {
				s := f.session(1)
				s.say("assistant", "text", "done, as approved", "")
				s.row = sessionRow{MachineID: s.mid, SessionID: s.sid, Status: "idle"}
			})
			r.waitItem(id, stateDone)
			if delivers, _, _ := fr.snapshot(); len(delivers) != 1 || textOf(delivers[0]) != "done, as approved" {
				t.Errorf("delivers = %v", delivers)
			}
		})
	}
}

// unknownSend opens a conversation with a first item, then scripts the answer to the next message into it.
func unknownSend(t *testing.T, script func(n int, msgID string) (int, string, bool)) (*rig, *fakeRouter, *fakeHub, string) {
	t.Helper()
	fr, fh := newFakeRouter(t), newFakeHub(t)
	first := fr.add(itemOpt{msg: "om_1", text: "one", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(first, stateDone)
	fh.set(func(f *fakeHub) {
		f.onSend = script
		f.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "text", "second answer", "") }
	})
	return r, fr, fh, fr.add(itemOpt{msg: "om_2", text: "two", tag: "chat"})
}

func TestUnknownSendOutcomeIsNotRetried(t *testing.T) {
	r, fr, fh, id := unknownSend(t, func(int, string) (int, string, bool) {
		return 502, `{"error":"node dropped","code":"node_unreachable","delivered":"unknown"}`, false
	})
	eventually(t, "the message was posted", func() bool { return fh.posts("/messages") == 1 })
	// The program restarts while the outcome is open: the new one does not post it again either.
	r.stop()
	r2 := startRig(t, fr, fh, withDir(r.dir))
	rec := r2.waitItem(id, stateFailed)
	time.Sleep(80 * time.Millisecond) // the worker keeps ticking
	if n := fh.posts("/messages"); n != 1 {
		t.Fatalf("%d POSTs for one message whose outcome was unknown", n)
	}
	if n := fh.posts("/conversations"); n != 1 {
		t.Errorf("%d conversations: an unknown send was turned into a start", n)
	}
	if rec.Why != whySendUnknown || !rec.Run.Unsure {
		t.Errorf("record = %+v run %+v", rec, rec.Run)
	}
	// Nothing is lost silently: the item is in the Inbox and needs the owner, and the message says failed.
	th := thingOf(r2.collect(), demoThread)
	if th == nil || th["extra"].(map[string]any)["rule_tier"] != "action" || th["why"] != whySendUnknown || th["last"] != short(id) {
		t.Errorf("Inbox fallback = %v", th)
	}
	eventually(t, "failed mark", func() bool { a := fr.acksFor("om_2"); return len(a) > 0 && a[len(a)-1] == "failed" })
	if delivers, _, _ := fr.snapshot(); len(delivers) != 1 {
		t.Errorf("something was delivered for the failed item: %v", delivers)
	}
}

func TestUnknownSendFoundLaterStillAnswers(t *testing.T) {
	r, fr, fh, id := unknownSend(t, func(int, string) (int, string, bool) {
		return 502, `{"error":"answer lost","code":"node_unreachable","delivered":"unknown"}`, true
	})
	rec := r.waitItem(id, stateDone)
	if n := fh.posts("/messages"); n != 1 {
		t.Errorf("%d POSTs", n)
	}
	if !rec.Run.Unsure {
		t.Errorf("the run does not remember its send was unsure")
	}
	delivers, _, _ := fr.snapshot()
	if len(delivers) != 2 || textOf(delivers[1]) != "second answer" {
		t.Errorf("delivers = %v", delivers)
	}
}

func TestUnknownOpenIsNotRetried(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.onOpen = func(int) (int, string, bool) {
		return 502, `{"error":"cut off","code":"assistant_in_doubt","delivered":"unknown"}`, false
	}
	id := fr.add(itemOpt{msg: "om_1", text: "hello", tag: "chat"})
	r := startRig(t, fr, fh)
	rec := r.waitItem(id, stateFailed)
	time.Sleep(80 * time.Millisecond)
	if n := fh.posts("/conversations"); n != 1 {
		t.Fatalf("%d POSTs for one start whose outcome was unknown", n)
	}
	if rec.Why != whyOpenUnknown {
		t.Errorf("why = %q", rec.Why)
	}
	if _, ok := r.x.store().conv(demoThread); ok {
		t.Errorf("a mapping was kept for a conversation that may not exist")
	}
	if th := thingOf(r.collect(), demoThread); th == nil || th["extra"].(map[string]any)["rule_tier"] != "action" {
		t.Errorf("Inbox fallback = %v", th)
	}
	eventually(t, "failed mark", func() bool { return strings.Join(fr.acksFor("om_1"), ",") == "failed" })
	// The owner answers from the Inbox instead.
	if err := r.reply(demoThread, "by hand", "c-1"); err != nil {
		t.Fatal(err)
	}
	if delivers, _, _ := fr.snapshot(); len(delivers) != 1 || delivers[0]["operationId"] != "inbox-reply-c-1" {
		t.Errorf("delivers = %v", delivers)
	}
}

func TestAssistantOfflineIsRetried(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.onOpen = func(n int) (int, string, bool) {
		if n <= 2 {
			return 503, `{"error":"manager away","code":"assistant_offline"}`, false
		}
		return 0, "", true
	}
	id := fr.add(itemOpt{text: "hello", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	if n := fh.posts("/conversations"); n != 3 {
		t.Fatalf("%d POSTs, want two refused and one taken", n)
	}
	if a, b, c := fh.open(0).opID, fh.open(1).opID, fh.open(2).opID; a != b || b != c {
		t.Errorf("a retried start changed its operation id: %s %s %s", a, b, c)
	}
	if _, _, sends := fr.snapshot(); sends != 1 {
		t.Errorf("platform sends = %d", sends)
	}
}

func TestNotSentGivesUpAfterAWhile(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.onOpen = func(int) (int, string, bool) { return 503, `{"error":"away","code":"assistant_offline"}`, false }
	id := fr.add(itemOpt{text: "hello", tag: "chat"})
	r := startRig(t, fr, fh)
	if rec := r.waitItem(id, stateFailed); rec.Why != whyNotSent {
		t.Errorf("why = %q", rec.Why)
	}
	// A plain refusal is not tried again at all.
	fr2, fh2 := newFakeRouter(t), newFakeHub(t)
	fh2.onOpen = func(int) (int, string, bool) {
		return 400, `{"error":"no","code":"bad_request","delivered":"none"}`, false
	}
	id2 := fr2.add(itemOpt{text: "hello", tag: "chat"})
	r2 := startRig(t, fr2, fh2)
	if rec := r2.waitItem(id2, stateFailed); rec.Why != whyRefused || fh2.posts("/conversations") != 1 {
		t.Errorf("why = %q after %d POSTs", rec.Why, fh2.posts("/conversations"))
	}
}

// TestOwnerTypedMessagesAreNotDelivered: the owner goes on in the same conversation in the app. What they typed, and
// the assistant's answer to it, stay in the app.
func TestOwnerTypedMessagesAreNotDelivered(t *testing.T) {
	for _, head := range []bool{true, false} {
		t.Run(fmt.Sprintf("head=%v", head), func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			script := func(s *fakeSession, text, msgID string) {
				s.say("assistant", "text", "A1 for the channel", "")
				s.say("user", "text", "private words typed in the app", "app-3f0c")
				s.say("assistant", "tool_use", "", "")
				s.say("assistant", "text", "A2 for the owner only", "")
			}
			var id, msg string
			var r *rig
			if head {
				fh.turn = script
				id, msg = fr.add(itemOpt{msg: "om_1", text: "from the channel", tag: "chat"}), "om_1"
				r = startRig(t, fr, fh)
			} else {
				first := fr.add(itemOpt{msg: "om_1", text: "one", tag: "chat"})
				r = startRig(t, fr, fh)
				r.waitItem(first, stateDone)
				fh.set(func(f *fakeHub) { f.turn = script })
				id, msg = fr.add(itemOpt{msg: "om_2", text: "from the channel", tag: "chat"}), "om_2"
			}
			r.waitItem(id, stateDone)
			time.Sleep(80 * time.Millisecond)
			delivers, _, _ := fr.snapshot()
			var mine []map[string]any
			for _, d := range delivers {
				if strings.Contains(textOf(d), "private") || strings.Contains(textOf(d), "A2") {
					t.Fatalf("the owner's side of the conversation reached the channel: %q", textOf(d))
				}
				if routeOf(d)["replyToMessageId"] == msg {
					mine = append(mine, d)
				}
			}
			if len(mine) != 1 || textOf(mine[0]) != "A1 for the channel" {
				t.Errorf("delivers for the item = %v", mine)
			}
			// A later channel message starts after what the owner did; it is answered with its own answer only.
			fh.set(func(f *fakeHub) {
				f.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "text", "A3 for the channel", "") }
			})
			next := fr.add(itemOpt{msg: "om_9", text: "next", tag: "chat"})
			r.waitItem(next, stateDone)
			delivers, _, _ = fr.snapshot()
			if last := delivers[len(delivers)-1]; textOf(last) != "A3 for the channel" {
				t.Errorf("the next item was answered with %q", textOf(last))
			}
		})
	}
}

func TestOwnerTookOverBeforeAnyAnswer(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.say("assistant", "tool_use", "", "")
		s.say("user", "text", "stop, I will handle this myself", "app-77aa")
		s.say("assistant", "text", "understood, leaving it to you", "")
	}
	id := fr.add(itemOpt{msg: "om_1", text: "from the channel", tag: "chat"})
	r := startRig(t, fr, fh)
	rec := r.waitItem(id, stateFailed)
	if rec.Why != whyTookOver {
		t.Errorf("why = %q", rec.Why)
	}
	time.Sleep(60 * time.Millisecond)
	if delivers, _, _ := fr.snapshot(); len(delivers) != 0 {
		t.Errorf("delivered after the owner took over: %v", delivers)
	}
	if th := thingOf(r.collect(), demoThread); th == nil || th["why"] != whyTookOver {
		t.Errorf("Inbox fallback = %v", th)
	}
}

// TestInjectedBlocksDoNotEndTheTurn: a user-role block the product injected is not the owner typing.
func TestInjectedBlocksDoNotEndTheTurn(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.say("assistant", "text", "working on it", "")
		s.say("user", "text", "<system-reminder>context</system-reminder>", "").Injected = true
		s.say("assistant", "text", "the real answer", "")
	}
	id := fr.add(itemOpt{text: "q", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	if delivers, _, _ := fr.snapshot(); len(delivers) != 1 || textOf(delivers[0]) != "the real answer" {
		t.Errorf("delivers = %v", delivers)
	}
}

func TestFindMineAndSection(t *testing.T) {
	run := &runRec{MsgID: "agentsio-abc"}
	token := "ref=0123456789abcdef"
	items := []hubItem{
		{Seq: 1, Role: "user", Kind: "text", Text: "older"},
		{Seq: 2, Role: "assistant", Kind: "text", Text: "older answer"},
		{Seq: 3, Role: "user", Kind: "text", Text: "mine", ClientMsgID: "agentsio-abc"},
		{Seq: 4, Role: "assistant", Kind: "text", Text: "a"},
		{Seq: 5, Role: "assistant", Kind: "tool_use"},
	}
	if i, ok := findMine(items, run, token); !ok || i != 2 {
		t.Errorf("by client_msg_id: %d %v", i, ok)
	}
	part, cut := section(items, 2, run.MsgID)
	if answer, ends := finalAnswer(part); len(part) != 2 || cut || answer == nil || answer.Text != "a" || ends {
		t.Errorf("section: %v cut=%v answer=%v ends=%v", part, cut, answer, ends)
	}
	// A node that ties no id to the item: the reference in the sender line finds it.
	noID := []hubItem{{Seq: 1, Role: "user", Kind: "text", Text: "x"}, {Seq: 2, Role: "user", Kind: "text", Text: "【渠道消息】…｜" + token + "｜…\n\nhi"}}
	if i, ok := findMine(noID, run, token); !ok || i != 1 {
		t.Errorf("by reference: %d %v", i, ok)
	}
	if _, ok := findMine(noID[:1], run, token); ok {
		t.Errorf("found a message that is not there")
	}
	// A conversation this run opened: its first words are the run's; with none listed, everything is.
	head := &runRec{MsgID: "agentsio-abc", Head: true}
	if i, ok := findMine([]hubItem{{Seq: 1, Role: "user", Kind: "text", Text: "rewritten prompt"}, {Seq: 2, Role: "assistant", Kind: "text", Text: "a"}}, head, token); !ok || i != 0 {
		t.Errorf("head: %d %v", i, ok)
	}
	if i, ok := findMine([]hubItem{{Seq: 1, Role: "assistant", Kind: "text", Text: "a"}, {Seq: 2, Role: "user", Kind: "text", Text: "owner"}}, head, token); !ok || i != -1 {
		t.Errorf("head without its first message: %d %v", i, ok)
	}
	// Words typed in the app carry the app's id: they are never taken for the run's first message.
	if i, ok := findMine([]hubItem{{Seq: 1, Role: "user", Kind: "text", Text: "typed in the app", ClientMsgID: "app-1"}, {Seq: 2, Role: "assistant", Kind: "text", Text: "for the owner"}}, head, token); !ok || i != -1 {
		t.Errorf("head, owner first: %d %v", i, ok)
	}
	if i, ok := findMine([]hubItem{{Seq: 1, Role: "user", Kind: "text", Text: "the manager's own first message", ClientMsgID: "start:1"}}, head, token); !ok || i != 0 {
		t.Errorf("head, start id: %d %v", i, ok)
	}
	part, cut = section([]hubItem{{Seq: 1, Role: "assistant", Kind: "text", Text: "a"}, {Seq: 2, Role: "user", Kind: "text", Text: "owner"}, {Seq: 3, Role: "assistant", Kind: "text", Text: "b"}}, -1, run.MsgID)
	if answer, _ := finalAnswer(part); !cut || answer == nil || answer.Text != "a" {
		t.Errorf("section of a head run: cut=%v answer=%v", cut, answer)
	}
	if answer, ends := finalAnswer([]hubItem{{Role: "assistant", Kind: "text", Text: "  "}, {Role: "assistant", Kind: "thinking", Text: "hm"}}); answer != nil || ends {
		t.Errorf("blank text is not an answer: %v", answer)
	}
	// What ends the section: anything a person put in, words or a picture. Not what the product injected (sent as an
	// object, whatever is in it), another session's message, an automated input, a tool result's picture, or a second
	// item of the run's own message.
	object := []byte(`{"kind":"task_notice","state":"done"}`)
	for _, tc := range []struct {
		name string
		it   hubItem
		cut  bool
	}{
		{"typed words", hubItem{Role: "user", Kind: "text", Text: "owner", ClientMsgID: "app-1"}, true},
		{"words without an id", hubItem{Role: "user", Kind: "text", Text: "owner"}, true},
		{"a picture sent as a message", hubItem{Role: "user", Kind: "image"}, true},
		{"injected", hubItem{Role: "user", Kind: "text", Text: "notice", Injected: object}, false},
		{"injected null", hubItem{Role: "user", Kind: "text", Text: "owner", Injected: []byte("null")}, true},
		{"from a peer session", hubItem{Role: "user", Kind: "text", Text: "peer", From: "s9"}, false},
		{"an automated input", hubItem{Role: "user", Kind: "text", Text: "scheduled", Source: []byte(`{"kind":"schedule"}`)}, false},
		{"a tool result's picture", hubItem{Role: "user", Kind: "image", ToolUseID: "toolu_1"}, false},
		{"a tool result", hubItem{Role: "user", Kind: "tool_result", Text: "out"}, false},
		{"the run's own message again", hubItem{Role: "user", Kind: "image", ClientMsgID: run.MsgID}, false},
	} {
		list := []hubItem{{Seq: 1, Role: "user", Kind: "text", Text: "mine", ClientMsgID: run.MsgID}, {Seq: 2, Role: "assistant", Kind: "text", Text: "a"}, tc.it,
			{Seq: 4, Role: "assistant", Kind: "text", Text: "b"}}
		part, cut := section(list, 0, run.MsgID)
		answer, _ := finalAnswer(part)
		if want := map[bool]string{true: "a", false: "b"}[tc.cut]; cut != tc.cut || answer == nil || answer.Text != want {
			t.Errorf("%s: cut=%v answer=%v, want cut=%v answer %q", tc.name, cut, answer, tc.cut, want)
		}
	}
}

func TestDeliverIdempotentAcrossRestart(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	// The router sends the answer and goes away before saying so; it stays away until the program has stopped.
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				go fr.set(func(f *fakeRouter) { f.upgradeStatus = 503 })
				return &fakeAnswer{sendThenHangup: true}
			}
			return nil
		}
	})
	id := fr.add(itemOpt{msg: "om_1", text: "q", tag: "chat"})
	r := startRig(t, fr, fh)
	eventually(t, "the deliver went out", func() bool { d, _, _ := fr.snapshot(); return len(d) == 1 })
	eventually(t, "the router is away", func() bool { return r.status().State != wire.ConnectorStateOk })
	if rec := r.item(id); rec.State != stateRunning || rec.Run.State != runDelivering || rec.Run.Answer != "answer" {
		t.Fatalf("before the restart: %+v %+v", rec, rec.Run)
	}
	r.stop()
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 0 })
	r2 := startRig(t, fr, fh, withDir(r.dir))
	r2.waitItem(id, stateDone)
	delivers, _, sends := fr.snapshot()
	if sends != 1 {
		t.Fatalf("the answer was sent to the platform %d times", sends)
	}
	if len(delivers) != 2 || delivers[0]["operationId"] != delivers[1]["operationId"] || delivers[1]["operationId"] != "reply-"+short(id) {
		t.Errorf("delivers = %v", delivers)
	}
	if opens, msgs := fh.counts(); opens != 1 || msgs != 0 {
		t.Errorf("the assistant was asked again: %d %d", opens, msgs)
	}
}

func TestRouteNotAllowedRetriesWithoutReplyTarget(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if routeOf(m)["replyToMessageId"] != nil { // older than the router remembers
				return &fakeAnswer{errCode: "route_not_allowed"}
			}
			return nil
		}
	})
	id := fr.add(itemOpt{msg: "om_old", text: "q", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 2 || sends != 1 {
		t.Fatalf("delivers = %d, sends = %d; want one retry", len(delivers), sends)
	}
	if delivers[0]["operationId"] != delivers[1]["operationId"] || routeOf(delivers[1])["replyToMessageId"] != nil ||
		routeOf(delivers[1])["conversationId"] != "oc_demo" {
		t.Errorf("retry = %v", delivers[1])
	}
	// A conversation the backend may not send to at all. The router answers the same code while the channel is not
	// running, so the same operation is asked again for a bounded time (never under another id); then the item goes
	// to the Inbox, and nothing is asked after that.
	fr2, fh2 := newFakeRouter(t), newFakeHub(t)
	fr2.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{errCode: "route_not_allowed"} }
	})
	id2 := fr2.add(itemOpt{text: "q", tag: "chat"})
	began := time.Now()
	r2 := startRig(t, fr2, fh2)
	if rec := r2.waitItem(id2, stateFailed); rec.Why != whyDeliverScope {
		t.Errorf("why = %q", rec.Why)
	}
	if took := time.Since(began); took < fastTimings().scopeRetryMost || took > 2*time.Second {
		t.Errorf("gave up after %v, want a bounded wait of about %v", took, fastTimings().scopeRetryMost)
	}
	d, _, sends2 := fr2.snapshot()
	if len(d) < 4 || len(d)%2 != 0 || len(d) > 20 || sends2 != 0 {
		t.Errorf("%d delivers, %d sends; want a few tries, each with and without the reply target, and nothing sent", len(d), sends2)
	}
	for i, m := range d {
		if m["operationId"] != "reply-"+short(id2) || (routeOf(m)["replyToMessageId"] != nil) != (i%2 == 0) {
			t.Errorf("deliver %d = %v", i, m)
		}
	}
	time.Sleep(80 * time.Millisecond)
	if after, _, _ := fr2.snapshot(); len(after) != len(d) {
		t.Errorf("asked again after giving up: %d delivers", len(after))
	}
	if th := thingOf(r2.collect(), demoThread); th == nil || th["why"] != whyDeliverScope {
		t.Errorf("Inbox fallback = %v", th)
	}
}

func TestDeliverUnknownIsNotResentUnderAnotherID(t *testing.T) {
	for name, ans := range map[string]*fakeAnswer{
		"status unknown": {status: "unknown"},
		"internal":       {errCode: "internal"},
		"no answer":      {drop: true},
	} {
		t.Run(name, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			fr.set(func(f *fakeRouter) { f.onDeliver = func(int, map[string]any) *fakeAnswer { return ans } })
			id := fr.add(itemOpt{msg: "om_1", text: "q", tag: "chat"})
			r := startRig(t, fr, fh)
			rec := r.waitItem(id, stateFailed)
			if rec.Why != whyDeliverUnsure {
				t.Errorf("why = %q", rec.Why)
			}
			time.Sleep(60 * time.Millisecond)
			delivers, _, sends := fr.snapshot()
			if len(delivers) != 2 || sends != 0 {
				t.Errorf("%d delivers, %d sends; want asked once more and then left", len(delivers), sends)
			}
			for _, d := range delivers {
				if d["operationId"] != "reply-"+short(id) {
					t.Errorf("another operation id: %v", d["operationId"])
				}
			}
			if th := thingOf(r.collect(), demoThread); th == nil || th["why"] != whyDeliverUnsure {
				t.Errorf("Inbox fallback = %v", th)
			}
		})
	}
	// Rejected is certain: said so, not asked again.
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{status: "rejected"} }
	})
	id := fr.add(itemOpt{text: "q", tag: "chat"})
	r := startRig(t, fr, fh)
	if rec := r.waitItem(id, stateFailed); rec.Why != whyDeliverReject {
		t.Errorf("why = %q", rec.Why)
	}
	if d, _, _ := fr.snapshot(); len(d) != 1 {
		t.Errorf("%d delivers after a rejection", len(d))
	}
}

func TestGuestOpensGuestConversation(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	id := fr.add(itemOpt{msg: "om_1", text: "hello, who is this?", tag: "guest", unknown: true})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	o := fh.open(0)
	guest, _ := o.body["guest"].(map[string]any)
	tools, _ := guest["tools"].([]any)
	if len(tools) != 1 || tools[0] != toolAboutName {
		t.Fatalf("guest = %v", o.body["guest"])
	}
	if prompt, _ := o.body["prompt"].(string); !strings.Contains(prompt, "路由认定：身份未知") {
		t.Errorf("prompt = %q", prompt)
	}
	if conv, _ := r.x.store().conv(demoThread); !conv.Guest {
		t.Errorf("mapping = %+v", conv)
	}
	// The next guest message goes into the same guest conversation.
	second := fr.add(itemOpt{msg: "om_2", text: "again", tag: "guest", unknown: true})
	r.waitItem(second, stateDone)
	if opens, sends := fh.counts(); opens != 1 || sends != 1 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
	// A chat item of the same channel conversation never goes into the guest conversation, nor the other way round.
	third := fr.add(itemOpt{msg: "om_3", text: "as the owner", tag: "chat", labels: []string{"owner"}})
	r.waitItem(third, stateDone)
	if opens, sends := fh.counts(); opens != 2 || sends != 1 {
		t.Errorf("%d conversations, %d messages after a chat item", opens, sends)
	}
	if _, isGuest := fh.open(1).body["guest"]; isGuest {
		t.Errorf("the chat item opened a guest conversation")
	}
	// The hub stops having guest conversations (asked again for every start the cache does not cover).
	fr2, fh2 := newFakeRouter(t), newFakeHub(t)
	fh2.guest = nil
	id2 := fr2.add(itemOpt{text: "hello", tag: "guest"})
	r2 := startRig(t, fr2, fh2)
	rec := r2.waitItem(id2, stateInbox)
	if opens, _ := fh2.counts(); opens != 0 || rec.Why != whyNoGuest {
		t.Errorf("without guest conversations: %d opened, why %q", opens, rec.Why)
	}
	if th := thingOf(r2.collect(), demoThread); th == nil {
		t.Errorf("the guest item is not in the Inbox")
	}
}

func TestSecondItemWaitsForFirstRun(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) { s.row.Status = "working" }
	first := fr.add(itemOpt{msg: "om_1", text: "one", tag: "chat"})
	second := fr.add(itemOpt{msg: "om_2", text: "two", tag: "chat"})
	other := fr.add(itemOpt{msg: "om_x", conv: "oc_other", text: "elsewhere", tag: "chat"})
	r := startRig(t, fr, fh)
	// Another channel conversation is not held up by the first.
	eventually(t, "two conversations opened", func() bool { opens, _ := fh.counts(); return opens == 2 })
	r.waitItem(other, stateRunning)
	steady(t, "the second item waits", 120*time.Millisecond, func() bool {
		_, sends := fh.counts()
		return sends == 0 && r.item(second).State == stateQueued && r.item(first).State == stateRunning
	})
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "text", "answer two", "") }
		s := f.session(1)
		if !strings.HasSuffix(s.items[0].Text, "one") {
			s = f.session(2)
		}
		s.say("assistant", "text", "answer one", "")
		s.row.Status = "idle"
	})
	r.waitItem(first, stateDone)
	r.waitItem(second, stateDone)
	if _, sends := fh.counts(); sends != 1 {
		t.Errorf("messages = %d", sends)
	}
	var texts []string
	delivers, _, _ := fr.snapshot()
	for _, d := range delivers {
		texts = append(texts, textOf(d))
	}
	if strings.Join(texts, "|") != "answer one|answer two" {
		t.Errorf("delivered in order: %v", texts)
	}
}

func TestControlCharactersNeverReachTheHub(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	first := fr.add(itemOpt{msg: "om_1", text: "esc\x1b[2Jape\x00 and\r\nnewline\ttab", name: "Mal\x07lory\u0085", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(first, stateDone)
	second := fr.add(itemOpt{msg: "om_2", text: "bell\x07 again\x7f", tag: "chat"})
	r.waitItem(second, stateDone) // the fake hub refuses control characters as the real one does
	prompt, _ := fh.open(0).body["prompt"].(string)
	if hasControl(prompt) || !strings.HasSuffix(prompt, "esc[2Jape and\nnewline\ttab") || !strings.Contains(prompt, "Mallory") {
		t.Errorf("prompt = %q", prompt)
	}
	if text, _ := fh.send(0).body["text"].(string); hasControl(text) || !strings.HasSuffix(text, "bell again") {
		t.Errorf("text = %q", text)
	}
	// And the assistant's answer is cleaned on its way to the channel.
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "text", "ok\x1b[0m done\r\n", "") }
	})
	third := fr.add(itemOpt{msg: "om_3", text: "x", tag: "chat"})
	r.waitItem(third, stateDone)
	delivers, _, _ := fr.snapshot()
	if got := textOf(delivers[len(delivers)-1]); got != "ok[0m done" {
		t.Errorf("delivered = %q", got)
	}
}

func TestMessageNotFoundGivesUp(t *testing.T) {
	r, fr, fh, id := unknownSend(t, func(int, string) (int, string, bool) { return 200, `{"ok":true}`, false })
	rec := r.waitItem(id, stateFailed)
	if rec.Why != whyNotFound {
		t.Errorf("why = %q", rec.Why)
	}
	delivers, _, _ := fr.snapshot()
	if len(delivers) != 1 {
		t.Errorf("an earlier answer was delivered for a message that never showed up: %v", delivers)
	}
	if n := fh.posts("/messages"); n != 1 {
		t.Errorf("%d POSTs", n)
	}
}

func TestQueuedMessageWaits(t *testing.T) {
	// 202 {"delivered":"later"}: the manager keeps the message; it shows up later and is answered then.
	r, fr, fh, id := unknownSend(t, func(int, string) (int, string, bool) { return 202, `{"delivered":"later","undelivered":{}}`, false })
	eventually(t, "sent", func() bool { rec := r.item(id); return rec.Run != nil && rec.Run.State == runSent })
	if r.item(id).Run.Unsure {
		t.Errorf("a kept message is not an unknown outcome")
	}
	// The manager sends a kept message by itself when the computer is back, which can be long after the time a message
	// normally takes to show up: the run waits for it and holds the conversation's next items.
	later := fr.add(itemOpt{msg: "om_3", text: "three", tag: "chat"})
	r.waitItem(later, stateQueued)
	steady(t, "the run waits for the kept message", 2*fastTimings().queuedMost, func() bool {
		return r.item(id).State == stateRunning && r.item(later).State == stateQueued && fh.posts("/messages") == 1
	})
	fh.set(func(f *fakeHub) { f.onSend = nil })
	fh.set(func(f *fakeHub) {
		s := f.session(1)
		s.say("user", "text", "two", "agentsio-"+short(id))
		s.say("assistant", "text", "late answer", "")
	})
	r.waitItem(id, stateDone)
	delivers, _, _ := fr.snapshot()
	if textOf(delivers[1]) != "late answer" {
		t.Errorf("delivers = %v", delivers)
	}
	r.waitItem(later, stateDone)
	if n := fh.posts("/messages"); n != 2 {
		t.Errorf("%d POSTs, want one per message", n)
	}
}

func TestMissingSessionRowFallsBackToQuietTranscript(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.hidden = true // not visible to this token
		s.say("assistant", "text", "first words", "")
	}
	id := fr.add(itemOpt{text: "q", tag: "chat"})
	r := startRig(t, fr, fh)
	eventually(t, "sent", func() bool { rec := r.item(id); return rec.Run != nil && rec.Run.State == runSent })
	// New items keep arriving: not quiet yet.
	for i := 0; i < 4; i++ {
		time.Sleep(25 * time.Millisecond)
		fh.set(func(f *fakeHub) { f.session(1).say("assistant", "text", fmt.Sprintf("more %d", i), "") })
	}
	if d, _, _ := fr.snapshot(); len(d) != 0 {
		t.Fatalf("delivered while the transcript was still moving: %v", d)
	}
	r.waitItem(id, stateDone)
	if d, _, _ := fr.snapshot(); len(d) != 1 || textOf(d[0]) != "more 3" {
		t.Errorf("delivers = %v", d)
	}
}

func TestSessionGoneOpensANewConversation(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	first := fr.add(itemOpt{msg: "om_1", text: "one", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(first, stateDone)
	fh.set(func(f *fakeHub) { f.session(1).gone = true })
	second := fr.add(itemOpt{msg: "om_2", text: "two", tag: "chat"})
	rec := r.waitItem(second, stateDone)
	if opens, sends := fh.counts(); opens != 2 || sends != 1 {
		t.Fatalf("%d conversations, %d messages", opens, sends)
	}
	if a, b := fh.open(0).opID, fh.open(1).opID; a == b || b != opUUID("open/"+second+"/reopen") {
		t.Errorf("operation ids: %s %s", a, b)
	}
	if conv, _ := r.x.store().conv(demoThread); conv.SessionID != "s2" || !rec.Run.Head {
		t.Errorf("mapping = %+v", conv)
	}
	// A conversation that disappears while its answer is awaited ends the run.
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) { s.gone = true }
	})
	third := fr.add(itemOpt{msg: "om_3", text: "three", tag: "chat"})
	if rec := r.waitItem(third, stateFailed); rec.Why != whyMissing {
		t.Errorf("why = %q", rec.Why)
	}
	if _, ok := r.x.store().conv(demoThread); ok {
		t.Errorf("the mapping to a missing conversation was kept")
	}
}

func TestNoAnswerGivesUp(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "tool_use", "", "") }
	id := fr.add(itemOpt{text: "q", tag: "chat"})
	r := startRig(t, fr, fh)
	if rec := r.waitItem(id, stateFailed); rec.Why != whyNoAnswer {
		t.Errorf("why = %q", rec.Why)
	}
	if d, _, _ := fr.snapshot(); len(d) != 0 {
		t.Errorf("delivers = %v", d)
	}
}

// TestRunFoundMidRequestAfterRestartIsNotResent: the journal says a request was about to be, or was, sent when the
// program stopped. Nothing can tell which, so nothing is sent again.
func TestRunFoundMidRequestAfterRestartIsNotResent(t *testing.T) {
	for _, state := range []string{runOpening, runSending} {
		t.Run(state, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			dir := t.TempDir()
			st, err := openStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			route := replyRoute{Channel: "demo-chat", Account: "default", ConversationID: "oc_demo", ReplyToMessageID: "om_1"}
			id := "default/channel:demo-chat/om_1"
			rec := itemRec{ID: id, Tag: tagChat, ConvKey: demoThread, Channel: "demo-chat", MessageID: "om_1", Text: "q",
				Route: &route, ReceivedAt: time.Now(), State: stateRunning,
				Run: &runRec{MsgID: "agentsio-" + short(id), State: state, MachineID: "m1", SessionID: "s1", StartedAt: time.Now()}}
			if _, err := st.add(rec); err != nil {
				t.Fatal(err)
			}
			if state == runSending {
				fh.sessions["m1/s1"] = &fakeSession{mid: "m1", sid: "s1", row: sessionRow{MachineID: "m1", SessionID: "s1", Status: "idle"}}
				_ = st.setConv(demoThread, convRec{MachineID: "m1", SessionID: "s1"})
			}
			r := startRig(t, fr, fh, withDir(dir))
			got := r.waitItem(id, stateFailed)
			want := map[string]string{runOpening: whyRestartUnsure, runSending: whySendUnknown}[state]
			if got.Why != want {
				t.Errorf("why = %q, want %q", got.Why, want)
			}
			if opens, sends := fh.counts(); opens+sends != 0 {
				t.Errorf("a request found mid-way was sent again: %d %d", opens, sends)
			}
			if th := thingOf(r.collect(), demoThread); th == nil {
				t.Errorf("the item is not in the Inbox")
			}
		})
	}
}

// TestMessageAbsorbedMidTurnIsAnswered: the conversation is working when the next message goes in, so the agent takes
// it in mid-turn. Its item says queued for good; it is in the conversation and its answer is delivered.
func TestMessageAbsorbedMidTurnIsAnswered(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	first := fr.add(itemOpt{msg: "om_1", text: "one", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(first, stateDone)
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) {
			s.items[len(s.items)-1].Queued = true
			s.say("assistant", "tool_use", "", "")
			s.say("assistant", "text", "answer to the absorbed message", "")
		}
	})
	second := fr.add(itemOpt{msg: "om_2", text: "two", tag: "chat"})
	r.waitItem(second, stateDone)
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 2 || sends != 2 || textOf(delivers[1]) != "answer to the absorbed message" {
		t.Errorf("delivers = %v", delivers)
	}
}

// TestDeliverWaitsOutTemporaryRefusals: refusals that say nothing was sent and do not use up the operation id (the
// router is stopping, the key was refused for a moment, the channel is not running yet) are not the end of the
// answer: the same operation is asked again and the answer is delivered once.
func TestDeliverWaitsOutTemporaryRefusals(t *testing.T) {
	for name, script := range map[string]func(n int, m map[string]any) *fakeAnswer{
		"router stopping": func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{errCode: "stopped"}
			}
			return nil
		},
		"key refused for a moment": func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{errCode: "unauthorized"}
			}
			return nil
		},
		"channel not running yet": func(n int, m map[string]any) *fakeAnswer {
			if n <= 4 { // with and without the reply target, twice over
				return &fakeAnswer{errCode: "route_not_allowed"}
			}
			return nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			fr.set(func(f *fakeRouter) { f.onDeliver = script })
			id := fr.add(itemOpt{msg: "om_1", text: "q", tag: "chat"})
			r := startRig(t, fr, fh)
			r.waitItem(id, stateDone)
			delivers, _, sends := fr.snapshot()
			if sends != 1 || len(delivers) < 2 {
				t.Fatalf("%d delivers, %d platform sends; want the answer sent once after the refusal", len(delivers), sends)
			}
			for _, d := range delivers {
				if d["operationId"] != "reply-"+short(id) {
					t.Errorf("another operation id: %v", d["operationId"])
				}
			}
			eventually(t, "working then done", func() bool { return strings.Join(fr.acksFor("om_1"), ",") == "working,done" })
			if th := thingOf(r.collect(), demoThread); th != nil {
				t.Errorf("a delivered answer left an Inbox thing: %v", th)
			}
		})
	}
}

// TestOwnerPictureEndsTheSection: a message the owner sends from the app as a picture alone is a user item of kind
// image. It ends the run's part of the transcript like typed words do; a picture a tool result carries does not.
func TestOwnerPictureEndsTheSection(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.say("assistant", "text", "A1 for the channel", "")
		s.say("user", "image", "", "app-51c2")
		s.say("assistant", "text", "A2 about the owner's picture", "")
	}
	id := fr.add(itemOpt{msg: "om_1", text: "from the channel", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	time.Sleep(60 * time.Millisecond)
	delivers, _, _ := fr.snapshot()
	if len(delivers) != 1 || textOf(delivers[0]) != "A1 for the channel" {
		t.Fatalf("delivers = %v", delivers)
	}
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) {
			s.say("assistant", "text", "looking at the screen", "")
			s.say("assistant", "tool_use", "", "")
			s.say("user", "image", "", "").ToolUseID = "toolu_1"
			s.say("user", "text", "a peer session's note", "").From = "another-session"
			s.say("user", "text", "an automated input", "").Source = "schedule"
			s.say("assistant", "text", "the answer after the screenshot", "")
		}
	})
	next := fr.add(itemOpt{msg: "om_2", text: "next", tag: "chat"})
	r.waitItem(next, stateDone)
	delivers, _, _ = fr.snapshot()
	if got := textOf(delivers[len(delivers)-1]); got != "the answer after the screenshot" {
		t.Errorf("a tool result's picture or an automated input ended the section: delivered %q", got)
	}
}

// TestRefusedStartIsTriedUnderANewOperation: the hub keeps a receipt for a refused start and replays it to the same
// operation id, so a start refused with nothing delivered is asked again under a new one.
func TestRefusedStartIsTriedUnderANewOperation(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.onOpen = func(n int) (int, string, bool) {
		if n == 1 {
			return 409, `{"error":"no launcher","code":"launcher_missing","delivered":"none"}`, false
		}
		return 0, "", true
	}
	id := fr.add(itemOpt{text: "hello", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	if n := fh.posts("/conversations"); n != 2 {
		t.Fatalf("%d POSTs, want the refused one and one that started", n)
	}
	if a, b := fh.open(0).opID, fh.open(1).opID; a != opUUID("open/"+id) || a == b || b != opUUID("open/"+id+"/1") {
		t.Errorf("operation ids: %s %s", a, b)
	}
	if opens := len(fh.sessions); opens != 1 {
		t.Errorf("%d conversations started", opens)
	}
}

// TestGuestWaitsOutACapabilitiesFailure: a capabilities request that fails says nothing about guest conversations.
// The item is neither filed in the Inbox for "no guest conversations" nor opened as an ordinary conversation.
func TestGuestWaitsOutACapabilitiesFailure(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.onCaps = func(n int) (int, string) {
		if n <= 2 {
			return 503, `{"error":"manager away","code":"assistant_offline"}`
		}
		return 0, ""
	}
	id := fr.add(itemOpt{text: "hello", tag: "guest", unknown: true})
	r := startRig(t, fr, fh)
	rec := r.waitItem(id, stateDone)
	if rec.Why != "" {
		t.Errorf("why = %q", rec.Why)
	}
	if opens, _ := fh.counts(); opens != 1 {
		t.Fatalf("%d conversations", opens)
	}
	if _, guest := fh.open(0).body["guest"]; !guest {
		t.Errorf("a guest item was opened as an ordinary conversation")
	}
	// A hub that keeps failing: the item ends in the Inbox as not sent, still never as an ordinary conversation.
	fr2, fh2 := newFakeRouter(t), newFakeHub(t)
	fh2.onCaps = func(int) (int, string) { return 502, `{"error":"bad gateway"}` }
	id2 := fr2.add(itemOpt{text: "hello", tag: "guest", unknown: true})
	r2 := startRig(t, fr2, fh2)
	if rec := r2.waitItem(id2, stateFailed); rec.Why != whyNotSent {
		t.Errorf("why = %q", rec.Why)
	}
	if opens, _ := fh2.counts(); opens != 0 {
		t.Errorf("%d conversations opened without knowing whether guest conversations exist", opens)
	}
}

// TestPollsReadOnlyWhatIsNew: a long turn writes many items. A poll asks only for what came after the last one seen;
// before the answer is taken the transcript is read once more from the run's base.
func TestPollsReadOnlyWhatIsNew(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.row.Status = "working"
		for i := 0; i < 30; i++ {
			s.say("assistant", "tool_use", "", "")
		}
	}
	id := fr.add(itemOpt{msg: "om_1", text: "a long job", tag: "chat"})
	r := startRig(t, fr, fh)
	eventually(t, "several polls", func() bool { return len(fh.itemReads()) >= 6 })
	reads := fh.itemReads()
	if reads[0] != 0 {
		t.Errorf("the first read starts after %d, want the run's base", reads[0])
	}
	for _, after := range reads[1:] {
		if after != 31 {
			t.Fatalf("a poll read from after %d, want only what is new (after 31): %v", after, reads)
		}
	}
	fh.set(func(f *fakeHub) {
		s := f.session(1)
		s.say("assistant", "text", "the answer after the long job", "")
		s.row.Status = "idle"
	})
	r.waitItem(id, stateDone)
	last := fh.itemReads()[len(reads):]
	if len(last) < 2 || last[len(last)-1] != 0 {
		t.Errorf("the answer was taken without reading the transcript again from the base: %v", last)
	}
	if delivers, _, _ := fr.snapshot(); len(delivers) != 1 || textOf(delivers[0]) != "the answer after the long job" {
		t.Errorf("delivers = %v", delivers)
	}
	if conv, _ := r.x.store().conv(demoThread); conv.LastSeq != 32 {
		t.Errorf("mapping = %+v", conv)
	}
}

// TestLongAnswerIsDeliveredWhole: a page cuts a long text and ends it with the app's truncation note. The answer is
// read in full before it is delivered; when that cannot be done nothing is delivered.
func TestLongAnswerIsDeliveredWhole(t *testing.T) {
	whole := strings.Repeat("a long answer. ", 3000) + "the end"
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.say("assistant", "text", "a long answer. …（已截断，共 45007 字节）", "").Full = whole
	}
	id := fr.add(itemOpt{msg: "om_1", text: "tell me everything", tag: "chat"})
	r := startRig(t, fr, fh)
	r.waitItem(id, stateDone)
	delivers, _, _ := fr.snapshot()
	if len(delivers) != 1 || textOf(delivers[0]) != whole {
		t.Fatalf("delivered %d bytes, want the whole %d", len(textOf(delivers[0])), len(whole))
	}
	if fulls := fh.fullReads(); len(fulls) != 1 || fulls[0] != "line 2" {
		t.Errorf("full-text reads = %q", fulls)
	}
	// The whole text cannot be had: the cut one is not delivered.
	fh.set(func(f *fakeHub) { f.fullFails = true })
	next := fr.add(itemOpt{msg: "om_2", text: "again", tag: "chat"})
	rec := r.waitItem(next, stateFailed)
	if rec.Why != whyAnswerCut {
		t.Errorf("why = %q", rec.Why)
	}
	if n := len(fh.fullReads()) - 1; n != fullTriesMost {
		t.Errorf("the whole text was asked for %d times, want %d", n, fullTriesMost)
	}
	time.Sleep(60 * time.Millisecond)
	if delivers, _, _ := fr.snapshot(); len(delivers) != 1 {
		t.Errorf("a cut answer was delivered: %q", textOf(delivers[len(delivers)-1]))
	}
	if th := thingOf(r.collect(), demoThread); th == nil || th["why"] != whyAnswerCut {
		t.Errorf("Inbox fallback = %v", th)
	}
}

// TestUnreadableTranscriptFailsSoon: a transcript page in a shape the program cannot read comes back the same every
// time. The run says so after a few reads, long before the time an answer may take.
func TestUnreadableTranscriptFailsSoon(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.badItems = true
	id := fr.add(itemOpt{msg: "om_1", text: "q", tag: "chat"})
	began := time.Now()
	r := startRig(t, fr, fh)
	rec := r.waitItem(id, stateFailed)
	if rec.Why != whyUnreadable || time.Since(began) > 3*time.Second {
		t.Errorf("why = %q after %v", rec.Why, time.Since(began))
	}
	if n := len(fh.itemReads()); n != 0 {
		t.Errorf("%d pages were read", n)
	}
	if delivers, _, _ := fr.snapshot(); len(delivers) != 0 {
		t.Errorf("delivers = %v", delivers)
	}
	eventually(t, "failed mark", func() bool { a := fr.acksFor("om_1"); return len(a) > 0 && a[len(a)-1] == "failed" })
}

// TestWaitLimitFallsBackToTheInbox: an item that waited for its answer longer than chat_wait_minutes fails with the
// reason and becomes an Inbox thing; one that waited less goes on waiting.
func TestWaitLimitFallsBackToTheInbox(t *testing.T) {
	for _, tc := range []struct {
		name    string
		waited  time.Duration
		timeout bool
	}{
		{"past the limit", 6 * time.Minute, true},
		{"within the limit", 4 * time.Minute, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			dir := t.TempDir()
			st, err := openStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			route := replyRoute{Channel: "demo-chat", Account: "default", ConversationID: "oc_demo", ReplyToMessageID: "om_1"}
			id := "default/channel:demo-chat/om_1"
			since := time.Now().Add(-tc.waited)
			rec := itemRec{ID: id, Tag: tagChat, ConvKey: demoThread, Channel: "demo-chat", ConvKind: "dm", MessageID: "om_1", Text: "q",
				Route: &route, ReceivedAt: since, TakenAt: since, State: stateRunning,
				Run: &runRec{MsgID: "agentsio-" + short(id), State: runSent, MachineID: "m1", SessionID: "s1", StartedAt: since, SentAt: since, Seen: true}}
			if _, err := st.add(rec); err != nil {
				t.Fatal(err)
			}
			_ = st.setConv(demoThread, convRec{MachineID: "m1", SessionID: "s1", OpenedAt: since, LastUsedAt: since})
			s := &fakeSession{mid: "m1", sid: "s1", row: sessionRow{MachineID: "m1", SessionID: "s1", Status: "working"}}
			s.say("user", "text", "q", rec.Run.MsgID)
			s.say("assistant", "text", "still working on it", "")
			s.say("assistant", "tool_use", "", "")
			fh.sessions["m1/s1"] = s
			r := startRig(t, fr, fh, withDir(dir), withConfig("chat_wait_minutes", 5))
			if !tc.timeout {
				eventually(t, "the turn is watched", func() bool { return len(fh.itemReads()) >= 3 })
				steady(t, "the run goes on waiting", 100*time.Millisecond, func() bool { return r.item(id).State == stateRunning })
				return
			}
			got := r.waitItem(id, stateFailed)
			if got.Why != whyTimeout {
				t.Errorf("why = %q", got.Why)
			}
			eventually(t, "failed mark", func() bool { return strings.Join(fr.acksFor("om_1"), ",") == "failed" })
			th := thingOf(r.collect(), demoThread)
			if th == nil || th["why"] != whyTimeout || th["extra"].(map[string]any)["rule_tier"] != "action" {
				t.Errorf("Inbox fallback = %v", th)
			}
			if delivers, _, _ := fr.snapshot(); len(delivers) != 0 {
				t.Errorf("a partial answer was delivered: %v", delivers)
			}
		})
	}
}

// TestRunsAreBounded: a backlog for many channel conversations starts only a few round trips at a time.
func TestRunsAreBounded(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) { s.row.Status = "working" }
	var ids []string
	for i := 0; i < 5; i++ {
		ids = append(ids, fr.add(itemOpt{conv: fmt.Sprintf("oc_%d", i), text: "hello", tag: "chat"}))
	}
	r := startRig(t, fr, fh, withTimings(func(tm *timings) { tm.runsMost = 2 }))
	for _, id := range ids {
		eventually(t, "taken", func() bool { return r.item(id).State != "" })
	}
	eventually(t, "two conversations opened", func() bool { opens, _ := fh.counts(); return opens == 2 })
	steady(t, "the rest wait", 120*time.Millisecond, func() bool {
		opens, _ := fh.counts()
		queued := 0
		for _, id := range ids {
			if r.item(id).State == stateQueued {
				queued++
			}
		}
		return opens == 2 && queued == 3
	})
	// A finished run makes room for the next, in arrival order.
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) { s.say("assistant", "text", "answer", "") }
		for _, s := range f.sessions {
			s.say("assistant", "text", "answer", "")
			s.row.Status = "idle"
		}
	})
	for _, id := range ids {
		r.waitItem(id, stateDone)
	}
	if opens, _ := fh.counts(); opens != 5 {
		t.Errorf("%d conversations", opens)
	}
}
