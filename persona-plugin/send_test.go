package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

// sendRig is the program with one conversation seen (a direct message in oc_demo) and one destination named in the
// settings that the router never routed anything from.
func sendRig(t *testing.T, opts ...func(*rigCfg)) (*rig, *fakeRouter, *fakeHub, itemRec) {
	t.Helper()
	fr, fh := newFakeRouter(t), newFakeHub(t)
	opts = append([]func(*rigCfg){withConfig("destinations", []string{"beta = demo-chat:second:oc_named"})}, opts...)
	r := startRig(t, fr, fh, opts...)
	id := fr.add(itemOpt{msg: "om_1", text: "hello " + secretWords, tag: "inbox"})
	return r, fr, fh, r.waitItem(id, stateInbox)
}

// sendRec is the store's record of the send a request id names.
func (r *rig) sendRec(requestID string) sendRec {
	rec, _ := r.x.store().send("send-" + short(requestID))
	return rec
}

func sameResult(a, b wire.ConnectorCallResult) bool {
	return a.Text == b.Text && a.MessageRef == b.MessageRef
}

func (r *rig) reconnected(hellos int) {
	r.t.Helper()
	eventually(r.t, "connected again", func() bool { return len(r.fr.helloList()) > hellos && r.x.router().connected() })
}

func TestSendToASeenConversation(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	args := map[string]any{"to": demoDest("oc_demo"), "text": "  the meeting moved to three\r\n" + secretWords + "  "}
	clean := "the meeting moved to three\n" + secretWords
	card, err := r.describe(args)
	if err != nil {
		t.Fatal(err)
	}
	// The card says where it really goes, to whom and what the router knows of them, then the whole text.
	first, rest, _ := strings.Cut(card.Summary, "\n\n")
	if first != "发到：Sam Sample（demo-chat 私聊）\n路由对这个人的认定：已知身份，凭据 platform_signed" || rest != clean ||
		card.Action.Visible != sendVisibleDM || card.Action.Name != sendActionName {
		t.Errorf("card = %+v", card)
	}
	if d, _, _ := fr.snapshot(); len(d) != 0 {
		t.Fatalf("describing sent something: %v", d)
	}
	res, err := r.send("req-1", args)
	if err != nil {
		t.Fatal(err)
	}
	if res.MessageRef != "pm_1" || res.Text != "已发出：Sam Sample。" {
		t.Errorf("result = %+v", res)
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 1 || sends != 1 {
		t.Fatalf("%d delivers, %d sends", len(delivers), sends)
	}
	d := delivers[0]
	route := routeOf(d)
	if d["operationId"] != "send-"+short("req-1") || textOf(d) != clean || route["channel"] != "demo-chat" || route["account"] != "default" ||
		route["conversationId"] != "oc_demo" || len(route) != 3 {
		t.Errorf("deliver = %v", d)
	}
	if m, _ := d["message"].(map[string]any); len(m) != 1 {
		t.Errorf("the message carries more than text: %v", m)
	}
	rec := r.sendRec("req-1")
	if rec.Outcome != sendDelivered || rec.MessageID != "pm_1" || rec.Dest != demoDest("oc_demo") || rec.Chars != len([]rune(clean)) ||
		rec.Label != "Sam Sample" || rec.SettledAt.IsZero() || rec.SameAs != "" {
		t.Errorf("record = %+v", rec)
	}
	// The text is nowhere in the store's file.
	if raw, err := os.ReadFile(filepath.Join(r.dir, outboundFile)); err != nil || strings.Contains(string(raw), "meeting") || strings.Contains(string(raw), secretWords) {
		t.Errorf("outbound.json keeps the text (%v)", err)
	}
	got, _ := r.destinations()
	if len(got.RecentSends) != 1 || got.RecentSends[0]["to"] != demoDest("oc_demo") || got.RecentSends[0]["outcome"] != sendDelivered ||
		got.RecentSends[0]["label"] != "Sam Sample" {
		t.Errorf("recent sends = %v", got.RecentSends)
	}
	if st := r.status(); st.State != wire.ConnectorStateOk || st.Via != fmt.Sprintf(wordsSendsVia, 1, 0, 0) {
		t.Errorf("status = %+v", st)
	}
}

func TestSendAsAReply(t *testing.T) {
	r, fr, _, first := sendRig(t)
	other := fr.add(itemOpt{msg: "om_9", conv: "oc_other", kind: "group", chatName: "Other room", thread: "th_1", text: "elsewhere", tag: "inbox"})
	otherRec := r.waitItem(other, stateInbox)
	got, _ := r.destinations()
	var ref string
	for _, d := range got.Destinations {
		if d["id"] == demoDest("oc_demo") {
			ref, _ = d["last_ref"].(string)
		}
	}
	if ref != refToken(first) {
		t.Fatalf("last_ref = %q", ref)
	}
	args := map[string]any{"to": demoDest("oc_demo"), "text": "got it", "reply_to": ref}
	card, err := r.describe(args)
	if err != nil || !strings.Contains(card.Summary, "回复 Sam Sample ") {
		t.Errorf("card = %+v %v", card, err)
	}
	if _, err := r.send("req-1", args); err != nil {
		t.Fatal(err)
	}
	delivers, _, _ := fr.snapshot()
	if route := routeOf(delivers[0]); route["replyToMessageId"] != "om_1" || route["conversationId"] != "oc_demo" {
		t.Errorf("route = %v", route)
	}
	// A reply in a conversation with threads goes to the message's thread; the group's card names the group.
	card, err = r.describe(map[string]any{"to": demoDest("oc_other"), "text": "noted", "reply_to": strings.TrimPrefix(refToken(otherRec), "ref=")})
	if err != nil || card.Action.Visible != "「Other room」里的所有人都看得到" {
		t.Errorf("group card = %+v %v", card, err)
	}
	if _, err := r.send("req-2", map[string]any{"to": demoDest("oc_other"), "text": "noted", "reply_to": refToken(otherRec)}); err != nil {
		t.Fatal(err)
	}
	delivers, _, _ = fr.snapshot()
	if route := routeOf(delivers[1]); route["replyToMessageId"] != "om_9" || route["threadId"] != "th_1" || route["conversationId"] != "oc_other" {
		t.Errorf("thread route = %v", route)
	}
	// A message of another conversation, or one that is not there, is not a reply target here: nothing goes out.
	for _, bad := range []string{refToken(otherRec), "ref=0000000000000000", "om_1"} {
		_, err := r.send("req-bad-"+bad, map[string]any{"to": demoDest("oc_demo"), "text": "x", "reply_to": bad})
		if words, _, _ := saidOf(err); words != wordsSendNoReplyItem {
			t.Errorf("reply_to %q: %v", bad, err)
		}
	}
	if d, _, _ := fr.snapshot(); len(d) != 2 {
		t.Fatalf("%d delivers", len(d))
	}
	// The router no longer takes the reply target: the same operation is asked once more without it, and the answer
	// says the message did not go out as a reply.
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if routeOf(m)["replyToMessageId"] != nil {
				return &fakeAnswer{errCode: "route_not_allowed"}
			}
			return nil
		}
	})
	res, err := r.send("req-3", map[string]any{"to": demoDest("oc_demo"), "text": "again", "reply_to": ref})
	if err != nil || !strings.Contains(res.Text, wordsSendNotAsReply) {
		t.Errorf("without the reply target: %+v %v", res, err)
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 4 || sends != 3 || delivers[2]["operationId"] != delivers[3]["operationId"] || routeOf(delivers[3])["replyToMessageId"] != nil {
		t.Errorf("delivers = %v", delivers[2:])
	}
	if rec := r.sendRec("req-3"); !rec.NoReply || rec.Outcome != sendDelivered {
		t.Errorf("record = %+v", rec)
	}
}

func TestSendToANamedDestination(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	card, err := r.describe(map[string]any{"to": demoDest("oc_named"), "text": "hello"})
	if err == nil {
		t.Fatalf("an id of another account was taken: %+v", card)
	}
	to := destID("demo-chat", "second", "oc_named")
	card, err = r.describe(map[string]any{"to": to, "text": "hello"})
	if err != nil || !strings.HasPrefix(card.Summary, "发到：beta（demo-chat）\n\n") || card.Action.Visible != sendVisibleOther {
		t.Errorf("card = %+v %v", card, err)
	}
	res, err := r.send("req-1", map[string]any{"to": to, "text": "hello"})
	if err != nil || res.Text != "已发出：beta。" {
		t.Fatalf("send = %+v %v", res, err)
	}
	delivers, _, _ := fr.snapshot()
	if route := routeOf(delivers[0]); route["channel"] != "demo-chat" || route["account"] != "second" || route["conversationId"] != "oc_named" || len(route) != 3 {
		t.Errorf("route = %v", route)
	}
	if rec := r.sendRec("req-1"); rec.Named != "beta" || rec.Outcome != sendDelivered {
		t.Errorf("record = %+v", rec)
	}
}

// TestSendRepeatedIsSentOnce: the same call again (the hub's request id is the same) answers the first one's result
// from this program's record; after a restart too; and with the record gone, the router knows the operation.
func TestSendRepeatedIsSentOnce(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	to := destID("demo-chat", "second", "oc_named")
	args := map[string]any{"to": to, "text": "only once"}
	first, err := r.send("req-1", args)
	if err != nil {
		t.Fatal(err)
	}
	// Two at once, then one more: all answered the same, none asks the router.
	done := make(chan wire.ConnectorCallResult, 2)
	for i := 0; i < 2; i++ {
		go func() {
			res, _ := r.send("req-1", args)
			done <- res
		}()
	}
	for i := 0; i < 2; i++ {
		if res := <-done; !sameResult(res, first) {
			t.Errorf("a repeat answered %+v, first %+v", res, first)
		}
	}
	// Even with other arguments: the request id is what names the run.
	if res, err := r.send("req-1", map[string]any{"to": to, "text": "something else"}); err != nil || !sameResult(res, first) {
		t.Errorf("a repeat with other arguments: %+v %v", res, err)
	}
	if d, _, sends := fr.snapshot(); len(d) != 1 || sends != 1 {
		t.Fatalf("%d delivers, %d sends", len(d), sends)
	}
	r.stop()
	named := withConfig("destinations", []string{"beta = demo-chat:second:oc_named"})
	r2 := startRig(t, fr, newFakeHub(t), withDir(r.dir), named)
	r2.waitState(wire.ConnectorStateOk)
	if res, err := r2.send("req-1", args); err != nil || !sameResult(res, first) {
		t.Errorf("after a restart: %+v %v", res, err)
	}
	if d, _, sends := fr.snapshot(); len(d) != 1 || sends != 1 {
		t.Fatalf("after a restart: %d delivers, %d sends", len(d), sends)
	}
	r2.stop()
	// A new data directory has no record: the router is asked under the same operation id and answers what it settled.
	r3 := startRig(t, fr, newFakeHub(t), named)
	r3.waitState(wire.ConnectorStateOk)
	res, err := r3.send("req-1", args)
	if err != nil || res.MessageRef != "pm_1" {
		t.Errorf("with the record gone: %+v %v", res, err)
	}
	d, _, sends := fr.snapshot()
	if len(d) != 2 || sends != 1 || d[1]["operationId"] != d[0]["operationId"] {
		t.Errorf("with the record gone: %d delivers, %d sends", len(d), sends)
	}
	if rec := r3.sendRec("req-1"); !rec.Duplicate || rec.Outcome != sendDelivered {
		t.Errorf("record = %+v", rec)
	}
}

// TestSendRepeatedWhileTheFirstIsUnderWay: a repeat that arrives before the router answered the first call waits for
// it and says the same; the router is asked once.
func TestSendRepeatedWhileTheFirstIsUnderWay(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{delay: 150 * time.Millisecond} }
	})
	args := map[string]any{"to": demoDest("oc_demo"), "text": "only once"}
	type answer struct {
		res wire.ConnectorCallResult
		err error
	}
	first := make(chan answer, 1)
	go func() {
		res, err := r.send("req-1", args)
		first <- answer{res, err}
	}()
	eventually(t, "the first call is at the router", func() bool { d, _, _ := fr.snapshot(); return len(d) == 1 })
	if rec := r.sendRec("req-1"); rec.Outcome != sendSending {
		t.Fatalf("the first call is no longer under way: %+v", rec)
	}
	again, err := r.send("req-1", args)
	one := <-first
	if err != nil || one.err != nil || one.res.MessageRef != "pm_1" || !sameResult(again, one.res) {
		t.Errorf("first %+v %v, repeat %+v %v", one.res, one.err, again, err)
	}
	if d, _, sends := fr.snapshot(); len(d) != 1 || sends != 1 {
		t.Errorf("%d delivers, %d sends", len(d), sends)
	}
}

func TestSendRefused(t *testing.T) {
	r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.sendPerDest, tm.sendPerWindow = 100, 100 }))
	args := map[string]any{"to": demoDest("oc_demo"), "text": "may I? " + secretWords}
	var answer *fakeAnswer
	fr.set(func(f *fakeRouter) { f.onDeliver = func(int, map[string]any) *fakeAnswer { return answer } })
	for i, tc := range []struct {
		ans   fakeAnswer
		code  string
		words string
	}{
		// The router's admin has not allowed this backend to send there: said so, with who can change it.
		{fakeAnswer{errCode: "route_not_allowed"}, "route_not_allowed", fmt.Sprintf(wordsSendScope, "alpha")},
		// Any other refusal is quoted by its code, without a guess at what it means on this router.
		{fakeAnswer{errCode: "forbidden"}, "forbidden", fmt.Sprintf(wordsSendRefused, "forbidden")},
		{fakeAnswer{errCode: "stopped"}, "stopped", wordsSendOffline},
		{fakeAnswer{errCode: "too_many_attachments"}, "too_many_attachments", fmt.Sprintf(wordsSendRefused, "too_many_attachments")},
		{fakeAnswer{errCode: "Something Odd!"}, "other", fmt.Sprintf(wordsSendRefused, "other")},
		{fakeAnswer{status: "rejected"}, sendCodeRejected, wordsSendRejected},
	} {
		answer = &tc.ans
		req := fmt.Sprintf("req-%d", i)
		_, err := r.send(req, args)
		words, _, _ := saidOf(err)
		if words != tc.words || !strings.Contains(words, "没有发出") {
			t.Errorf("%+v: said %q, want %q", tc.ans, words, tc.words)
		}
		if strings.Contains(words, secretWords) || strings.Contains(words, "oc_demo") {
			t.Errorf("the refusal carries the text or the coordinates: %q", words)
		}
		if rec := r.sendRec(req); rec.Outcome != sendRefused || rec.Code != tc.code {
			t.Errorf("%+v: record = %+v", tc.ans, rec)
		}
		// Said again the same, without asking again.
		_, err = r.send(req, args)
		if again, _, _ := saidOf(err); again != words {
			t.Errorf("a repeat said %q", again)
		}
	}
	for _, part := range []string{"route_not_allowed", "管理员", "backends.alpha.routes"} {
		if !strings.Contains(fmt.Sprintf(wordsSendScope, "alpha"), part) {
			t.Errorf("the scope refusal lacks %q", part)
		}
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 6 || sends != 0 {
		t.Fatalf("%d delivers, %d sends", len(delivers), sends)
	}
	// Once the admin allowed it, a new call goes out.
	answer = nil
	if res, err := r.send("req-allowed", args); err != nil || res.MessageRef != "pm_1" {
		t.Errorf("after the refusal was lifted: %+v %v", res, err)
	}
	if st := r.status(); st.Via != fmt.Sprintf(wordsSendsVia, 1, 6, 0) {
		t.Errorf("status = %+v", st)
	}
}

// TestSendUnknownOutcomeIsNotRetried: no answer, "internal" and a settled "unknown" leave the outcome open. It is
// said so, and nothing asks the router again: not the program, not a repeat of the call.
func TestSendUnknownOutcomeIsNotRetried(t *testing.T) {
	for name, tc := range map[string]struct {
		ans   *fakeAnswer
		words string
		spent bool
	}{
		"no answer": {&fakeAnswer{drop: true}, wordsSendUnknown, false},
		"internal":  {&fakeAnswer{errCode: "internal"}, wordsSendUnknown, false},
		// The router's own settled record: it says so, and that the router will not send under that operation.
		"status unknown": {&fakeAnswer{status: "unknown"}, wordsSendUnknownSettled, true},
	} {
		t.Run(name, func(t *testing.T) {
			r, fr, _, _ := sendRig(t)
			fr.set(func(f *fakeRouter) { f.onDeliver = func(int, map[string]any) *fakeAnswer { return tc.ans } })
			args := map[string]any{"to": demoDest("oc_demo"), "text": "did it go?"}
			_, err := r.send("req-1", args)
			if words, _, _ := saidOf(err); words != tc.words || !strings.Contains(words, "结果不明") || !strings.Contains(words, "不会自动重发") {
				t.Fatalf("said %q", words)
			}
			if rec := r.sendRec("req-1"); rec.Outcome != sendUnknown || rec.Code == "" || rec.Spent != tc.spent {
				t.Errorf("record = %+v", rec)
			}
			steady(t, "one deliver and no more", 80*time.Millisecond, func() bool { d, _, _ := fr.snapshot(); return len(d) == 1 })
			_, err = r.send("req-1", args)
			if words, _, _ := saidOf(err); words != tc.words {
				t.Errorf("a repeat said %q", words)
			}
			if d, _, _ := fr.snapshot(); len(d) != 1 {
				t.Errorf("a repeat asked the router again: %d delivers", len(d))
			}
			got, _ := r.destinations()
			if len(got.RecentSends) != 1 || got.RecentSends[0]["outcome"] != sendUnknown {
				t.Errorf("recent sends = %v", got.RecentSends)
			}
			if st := r.status(); st.Via != fmt.Sprintf(wordsSendsVia, 0, 0, 1) {
				t.Errorf("status = %+v", st)
			}
		})
	}
}

// TestSendAgainAfterUnknownContinuesTheSameOperation: the message went out and the answer was lost. When the owner
// confirms the same text to the same place again (a new call, a new request id), the router is asked under the
// first call's operation id and answers its settled record: one message, not two.
func TestSendAgainAfterUnknownContinuesTheSameOperation(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{sendThenHangup: true}
			}
			return nil
		}
	})
	hellos := len(fr.helloList())
	args := map[string]any{"to": demoDest("oc_demo"), "text": "it went out"}
	_, err := r.send("req-1", args)
	if words, _, _ := saidOf(err); words != wordsSendUnknown {
		t.Fatalf("said %q", words)
	}
	r.reconnected(hellos)
	res, err := r.send("req-2", args)
	if err != nil || res.Text != wordsSendWasAlready || res.MessageRef != "pm_1" {
		t.Fatalf("the second call: %+v %v", res, err)
	}
	delivers, _, sends := fr.snapshot()
	if len(delivers) != 2 || sends != 1 || delivers[1]["operationId"] != "send-"+short("req-1") {
		t.Fatalf("%d delivers, %d sends, second operation %v", len(delivers), sends, delivers[1]["operationId"])
	}
	// Both records are settled now, so the same words can be sent again as a new message.
	one, two := r.sendRec("req-1"), r.sendRec("req-2")
	if one.Outcome != sendDelivered || one.MessageID != "pm_1" || two.Outcome != sendDelivered || two.SameAs != "send-"+short("req-1") || !two.Duplicate {
		t.Errorf("records = %+v %+v", one, two)
	}
	if res, err := r.send("req-3", args); err != nil || res.MessageRef != "pm_2" {
		t.Errorf("a later send of the same words: %+v %v", res, err)
	}
	// Another text is another message from the start.
	if d, _, _ := fr.snapshot(); d[2]["operationId"] != "send-"+short("req-3") {
		t.Errorf("third operation = %v", d[2]["operationId"])
	}
}

// TestSendAgainAfterUnknownSendsWhenTheFirstNeverDid: the first request was lost before the router sent anything.
// The second call, under the first one's operation id, is the one that sends.
func TestSendAgainAfterUnknownSendsWhenTheFirstNeverDid(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{drop: true}
			}
			return nil
		}
	})
	args := map[string]any{"to": demoDest("oc_demo"), "text": "it did not go out"}
	if _, err := r.send("req-1", args); err == nil {
		t.Fatal("the lost request was answered")
	}
	res, err := r.send("req-2", args)
	if err != nil || res.Text != "已发出：Sam Sample。" || res.MessageRef != "pm_1" {
		t.Fatalf("the second call: %+v %v", res, err)
	}
	if d, _, sends := fr.snapshot(); len(d) != 2 || sends != 1 || d[1]["operationId"] != d[0]["operationId"] {
		t.Errorf("%d delivers, %d sends", len(d), sends)
	}
	if one := r.sendRec("req-1"); one.Outcome != sendDelivered {
		t.Errorf("the first record = %+v", one)
	}
}

// TestSendAgainLongAfterUnknownIsANewOperation: past sendReuse the same words are a new message.
func TestSendAgainLongAfterUnknownIsANewOperation(t *testing.T) {
	r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.sendReuse = time.Millisecond }))
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{drop: true}
			}
			return nil
		}
	})
	args := map[string]any{"to": demoDest("oc_demo"), "text": "much later"}
	if _, err := r.send("req-1", args); err == nil {
		t.Fatal("the lost request was answered")
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := r.send("req-2", args); err != nil {
		t.Fatal(err)
	}
	if d, _, _ := fr.snapshot(); len(d) != 2 || d[1]["operationId"] != "send-"+short("req-2") {
		t.Errorf("delivers = %v", d)
	}
	if one := r.sendRec("req-1"); one.Outcome != sendUnknown {
		t.Errorf("the first record = %+v", one)
	}
}

// TestSendRateLimit: the fourth send to one destination within the window is refused, before the owner is asked and
// when the hub runs it. The window is a minute, so nothing here depends on how fast the machine is.
// TestSendReuseWindowStartsAtTheFirstCall: the hour in which the same text continues the first operation is counted
// from the first call. A call that continued it and stayed unknown does not start the hour again.
func TestSendReuseWindowStartsAtTheFirstCall(t *testing.T) {
	r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.send = 40 * time.Millisecond }))
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{drop: true} }
	})
	args := map[string]any{"to": demoDest("oc_demo"), "text": "still not there"}
	for _, req := range []string{"req-1", "req-2"} {
		if _, err := r.send(req, args); err == nil {
			t.Fatal("a lost request was answered")
		}
	}
	root := "send-" + short("req-1")
	if two := r.sendRec("req-2"); two.SameAs != root || two.Outcome != sendUnknown {
		t.Fatalf("the second record = %+v", two)
	}
	// The first call is two hours old, the one that continued it half an hour.
	now := time.Now().UTC()
	_ = r.x.store().updateSends(func(rec *sendRec) bool {
		rec.At = now.Add(-30 * time.Minute)
		if rec.Op == root {
			rec.At = now.Add(-2 * time.Hour)
		}
		return true
	})
	fr.set(func(f *fakeRouter) { f.onDeliver = nil })
	res, err := r.send("req-3", args)
	if err != nil || res.MessageRef != "pm_1" {
		t.Fatalf("after the hour: %+v %v", res, err)
	}
	d, _, _ := fr.snapshot()
	if len(d) != 3 || d[0]["operationId"] != root || d[1]["operationId"] != root || d[2]["operationId"] != "send-"+short("req-3") {
		t.Errorf("operations = %v %v %v", d[0]["operationId"], d[1]["operationId"], d[2]["operationId"])
	}
	if three := r.sendRec("req-3"); three.SameAs != "" {
		t.Errorf("the third record = %+v", three)
	}
}

// TestSendAfterTheRouterSettledUnknown: once the router itself settled an operation as unknown it never sends under
// it, so asking again under it could never deliver the message. The answer says the next send is a new message, and
// it is: whether the router said so on the first call, or to a call that continued the first.
func TestSendAfterTheRouterSettledUnknown(t *testing.T) {
	for name, first := range map[string]*fakeAnswer{
		"said on the first call":    {status: "unknown"},
		"said to the one after it":  {status: "unknown", sendThenHangup: true},
		"rejected, the answer lost": {status: "rejected", sendThenHangup: true},
	} {
		t.Run(name, func(t *testing.T) {
			r, fr, _, _ := sendRig(t)
			fr.set(func(f *fakeRouter) {
				f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
					if n == 1 {
						return first
					}
					return nil
				}
			})
			hellos := len(fr.helloList())
			args := map[string]any{"to": demoDest("oc_demo"), "text": "did it go?"}
			_, err := r.send("req-1", args)
			words, _, _ := saidOf(err)
			next := "req-2"
			if first.sendThenHangup {
				// The record exists on the router and its answer was lost: the next call continues the operation and
				// is told what the router settled.
				if words != wordsSendUnknown {
					t.Fatalf("the first call said %q", words)
				}
				r.reconnected(hellos)
				_, err = r.send("req-2", args)
				words, _, _ = saidOf(err)
				if d, _, _ := fr.snapshot(); len(d) != 2 || d[1]["operationId"] != "send-"+short("req-1") {
					t.Fatalf("the second call did not continue the first: %v", d)
				}
				next = "req-3"
			}
			one := r.sendRec("req-1")
			if first.status == "rejected" {
				// The channel rejected it: nothing went out, and the first record says so too.
				if words != wordsSendRejected || one.Outcome != sendRefused || one.Code != sendCodeRejected {
					t.Fatalf("said %q, the first record = %+v", words, one)
				}
			} else if words != wordsSendUnknownSettled || one.Outcome != sendUnknown || !one.Spent {
				t.Fatalf("said %q, the first record = %+v", words, one)
			}
			for _, part := range []string{"确认", "新消息"} {
				if first.status == "unknown" && !strings.Contains(words, part) {
					t.Errorf("the answer lacks %q: %q", part, words)
				}
			}
			before, _, _ := fr.snapshot()
			res, err := r.send(next, args)
			if err != nil || res.MessageRef != "pm_1" || res.Text != "已发出：Sam Sample。" {
				t.Fatalf("the next send: %+v %v", res, err)
			}
			d, _, sends := fr.snapshot()
			if len(d) != len(before)+1 || sends != 1 || d[len(d)-1]["operationId"] != "send-"+short(next) {
				t.Errorf("%d delivers, %d sends, last operation %v", len(d), sends, d[len(d)-1]["operationId"])
			}
		})
	}
}

func TestSendRateLimit(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	to := demoDest("oc_demo")
	for i := 0; i < 3; i++ {
		if _, err := r.send(fmt.Sprintf("req-%d", i), map[string]any{"to": to, "text": fmt.Sprintf("message %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	args := map[string]any{"to": to, "text": "message 3"}
	_, err := r.describe(args)
	if _, code, _ := saidOf(err); code != wire.ConnectorErrorCodeRateLimited {
		t.Errorf("describe over the limit: %v", err)
	}
	_, err = r.send("req-3", args)
	words, code, data := saidOf(err)
	if after, _ := data["retry_after"].(float64); code != wire.ConnectorErrorCodeRateLimited || after < 55 || after > 60 ||
		words != fmt.Sprintf(wordsSendRate, 3, 10, int(after)) || !strings.Contains(words, "没有发出") {
		t.Errorf("over the limit: %q %q %v", words, code, data)
	}
	if d, _, _ := fr.snapshot(); len(d) != 3 {
		t.Fatalf("%d delivers", len(d))
	}
	if rec := r.sendRec("req-3"); rec.Op != "" {
		t.Errorf("a refused call left a record: %+v", rec)
	}
	// Another destination still has room.
	if _, err := r.send("req-other", map[string]any{"to": destID("demo-chat", "second", "oc_named"), "text": "elsewhere"}); err != nil {
		t.Errorf("another destination: %v", err)
	}
	if d, _, _ := fr.snapshot(); len(d) != 4 {
		t.Errorf("%d delivers", len(d))
	}
}

// TestSendRateLimitWindowPasses: once the sends that filled the limit are older than the window, the same call goes
// out. This one needs a short window, and is skipped on a machine too slow for it.
func TestSendRateLimitWindowPasses(t *testing.T) {
	r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.sendWindow = 400 * time.Millisecond }))
	to := demoDest("oc_demo")
	began := time.Now()
	for i := 0; i < 3; i++ {
		if _, err := r.send(fmt.Sprintf("req-%d", i), map[string]any{"to": to, "text": fmt.Sprintf("message %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	args := map[string]any{"to": to, "text": "message 3"}
	_, err := r.send("req-3", args)
	if time.Since(began) > 300*time.Millisecond {
		t.Skip("the machine is too slow for a 400 ms window")
	}
	if _, code, data := saidOf(err); code != wire.ConnectorErrorCodeRateLimited || data["retry_after"] != float64(1) {
		t.Errorf("over the limit: %v %v", code, data)
	}
	// It left no record, so its request id is still new.
	time.Sleep(450 * time.Millisecond)
	if _, err := r.send("req-3", args); err != nil {
		t.Errorf("after the window: %v", err)
	}
	if d, _, _ := fr.snapshot(); len(d) != 4 {
		t.Errorf("%d delivers", len(d))
	}
}

// TestSendRateLimitCountsWhatWasNotSent: a send the router refused, and one whose outcome is unknown, count like one
// that went out. A model that keeps trying a destination it may not send to is what the limit is for.
func TestSendRateLimitCountsWhatWasNotSent(t *testing.T) {
	for name, ans := range map[string]*fakeAnswer{
		"refused":   {errCode: "route_not_allowed"},
		"no answer": {drop: true},
	} {
		t.Run(name, func(t *testing.T) {
			r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.send = 40 * time.Millisecond }))
			fr.set(func(f *fakeRouter) { f.onDeliver = func(int, map[string]any) *fakeAnswer { return ans } })
			to := demoDest("oc_demo")
			for i := 0; i < 3; i++ {
				_, err := r.send(fmt.Sprintf("req-%d", i), map[string]any{"to": to, "text": fmt.Sprintf("attempt %d", i)})
				if _, code, _ := saidOf(err); err == nil || code == wire.ConnectorErrorCodeRateLimited {
					t.Fatalf("attempt %d: %v", i, err)
				}
			}
			if d, _, sends := fr.snapshot(); len(d) != 3 || sends != 0 {
				t.Fatalf("%d delivers, %d sends", len(d), sends)
			}
			args := map[string]any{"to": to, "text": "attempt 3"}
			if _, err := r.describe(args); err == nil {
				t.Errorf("a fourth attempt was put to the owner")
			}
			_, err := r.send("req-3", args)
			if _, code, _ := saidOf(err); code != wire.ConnectorErrorCodeRateLimited {
				t.Errorf("the fourth attempt: %v", err)
			}
			if d, _, _ := fr.snapshot(); len(d) != 3 {
				t.Errorf("the fourth attempt asked the router: %d delivers", len(d))
			}
		})
	}
}

// TestSendsArrivingTogetherStayWithinTheLimit: calls that arrive at the same moment are counted one by one, so no
// more than the limit has room for are recorded (and only a recorded send goes out), however they interleave. The
// calls are let go together right at the step that counts and records, where the window between the two is.
func TestSendsArrivingTogetherStayWithinTheLimit(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	st := r.x.store()
	const calls = 24
	plans := make([]sendPlan, calls)
	for i := range plans {
		raw, _ := json.Marshal(map[string]any{"to": demoDest("oc_demo"), "text": fmt.Sprintf("message %d", i)})
		plan, err := r.x.planSend(raw)
		if err != nil {
			t.Fatal(err)
		}
		plans[i] = plan
	}
	errs := make(chan error, calls)
	start := make(chan struct{})
	var ready sync.WaitGroup
	for i := range plans {
		ready.Add(1)
		go func() {
			ready.Done()
			<-start
			_, err := r.x.admitSend(st, fmt.Sprintf("send-together-%d", i), plans[i])
			errs <- err
		}()
	}
	// Every call is held where it counts the window's sends (the store's lock), then all are let go at once.
	st.mu.Lock()
	ready.Wait()
	close(start)
	time.Sleep(30 * time.Millisecond)
	st.mu.Unlock()
	admitted, limited := 0, 0
	for range plans {
		switch _, code, _ := saidOf(<-errs); code {
		case "":
			admitted++
		case wire.ConnectorErrorCodeRateLimited:
			limited++
		}
	}
	if got := len(st.sendsSince(time.Time{})); admitted != 3 || limited != calls-3 || got != 3 {
		t.Errorf("%d admitted, %d refused for the limit, %d records", admitted, limited, got)
	}
	// The same through the protocol: of calls the hub runs at once, three go out.
	r2, fr2, _, _ := sendRig(t)
	results := make(chan error, 8)
	for i := 0; i < cap(results); i++ {
		go func() {
			_, err := r2.send(fmt.Sprintf("req-%d", i), map[string]any{"to": demoDest("oc_demo"), "text": fmt.Sprintf("message %d", i)})
			results <- err
		}()
	}
	sent := 0
	for i := 0; i < cap(results); i++ {
		if err := <-results; err == nil {
			sent++
		} else if _, code, _ := saidOf(err); code != wire.ConnectorErrorCodeRateLimited {
			t.Errorf("a call failed for another reason: %v", err)
		}
	}
	if d, _, sends := fr2.snapshot(); sent != 3 || len(d) != 3 || sends != 3 {
		t.Errorf("%d sent, %d delivers, %d messages out", sent, len(d), sends)
	}
	if d, _, _ := fr.snapshot(); len(d) != 0 {
		t.Errorf("admitting sent something: %d delivers", len(d))
	}
}

func TestSendRateLimitInAll(t *testing.T) {
	r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.sendPerWindow = 2 }))
	if _, err := r.send("req-1", map[string]any{"to": demoDest("oc_demo"), "text": "one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.send("req-2", map[string]any{"to": destID("demo-chat", "second", "oc_named"), "text": "two"}); err != nil {
		t.Fatal(err)
	}
	_, err := r.send("req-3", map[string]any{"to": demoDest("oc_demo"), "text": "three"})
	_, code, data := saidOf(err)
	if after, _ := data["retry_after"].(float64); code != wire.ConnectorErrorCodeRateLimited || after < 55 || after > 60 {
		t.Errorf("over the limit in all: %v %v", code, data)
	}
	// The limit counts the store's records: a restart does not reset it.
	r.stop()
	r2 := startRig(t, fr, newFakeHub(t), withDir(r.dir), withTimings(func(tm *timings) { tm.sendPerWindow = 2 }))
	r2.waitState(wire.ConnectorStateOk)
	_, err = r2.send("req-4", map[string]any{"to": demoDest("oc_demo"), "text": "four"})
	if _, code, _ := saidOf(err); code != wire.ConnectorErrorCodeRateLimited {
		t.Errorf("after a restart: %v", err)
	}
	if d, _, _ := fr.snapshot(); len(d) != 2 {
		t.Errorf("%d delivers", len(d))
	}
}

func TestSendWhileRouterDown(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 503 })
	fr.dropAll()
	r.waitState(wire.ConnectorStateError)
	args := map[string]any{"to": demoDest("oc_demo"), "text": "are you there"}
	_, err := r.describe(args)
	if words, _, _ := saidOf(err); words != wordsSendOffline {
		t.Errorf("describe while down: %v", err)
	}
	began := time.Now()
	_, err = r.send("req-1", args)
	if words, _, _ := saidOf(err); words != wordsSendOffline || time.Since(began) > time.Second {
		t.Fatalf("send while down: %v after %v", err, time.Since(began))
	}
	if rec := r.sendRec("req-1"); rec.Op != "" {
		t.Errorf("a send that never left has a record: %+v", rec)
	}
	if got, _ := r.destinations(); got.CanSend || len(got.RecentSends) != 0 || len(got.Destinations) != 2 {
		t.Errorf("destinations while down: %+v", got)
	}
	// Nothing is queued for later: after the router is back, no deliver goes out by itself.
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 0 })
	r.waitState(wire.ConnectorStateOk)
	steady(t, "nothing sent later", 80*time.Millisecond, func() bool { d, _, _ := fr.snapshot(); return len(d) == 0 })
}

func TestSendLimits(t *testing.T) {
	r, fr, _, _ := sendRig(t)
	to := demoDest("oc_demo")
	long := strings.Repeat("字", sendTextMost+1)
	for name, tc := range map[string]struct {
		args  map[string]any
		words string
	}{
		"empty":           {map[string]any{"to": to, "text": " \n\t "}, wordsSendEmpty},
		"only controls":   {map[string]any{"to": to, "text": "\x00\x07"}, wordsSendEmpty},
		"too long":        {map[string]any{"to": to, "text": long}, fmt.Sprintf(wordsSendTooLong, sendTextMost+1, sendTextMost)},
		"unknown id":      {map[string]any{"to": "d-000000000000", "text": "x"}, wordsSendNoDest},
		"no id":           {map[string]any{"text": "x"}, wordsSendNoDest},
		"coordinates":     {map[string]any{"to": "demo-chat:default:oc_demo", "text": "x"}, wordsSendNoDest},
		"a conversation":  {map[string]any{"to": to, "text": "x", "conversation_id": "oc_other"}, wordsSendArgs},
		"a channel":       {map[string]any{"to": to, "text": "x", "channel": "demo-chat"}, wordsSendArgs},
		"attachments":     {map[string]any{"to": to, "text": "x", "attachments": []string{"blob_1"}}, wordsSendArgs},
		"text not a text": {map[string]any{"to": to, "text": 7}, wordsSendArgs},
	} {
		_, err := r.describe(tc.args)
		if words, _, _ := saidOf(err); words != tc.words {
			t.Errorf("%s: describe said %q, want %q", name, words, tc.words)
		}
		_, err = r.send("req-"+name, tc.args)
		if words, _, _ := saidOf(err); words != tc.words {
			t.Errorf("%s: send said %q, want %q", name, words, tc.words)
		}
	}
	// The longest text allowed goes out whole.
	most := strings.Repeat("字", sendTextMost)
	if _, err := r.send("req-most", map[string]any{"to": to, "text": most}); err != nil {
		t.Errorf("a text of exactly the limit: %v", err)
	}
	// No request id, no send: nothing would make it happen once.
	raw := []byte(`{"to":"` + to + `","text":"x"}`)
	if _, err := r.x.doSend(t.Context(), wire.ConnectorDoParams{Contribution: connectorID, Name: toolSendName, Args: raw, RequestID: " "}); err == nil || err.Error() != wordsSendNoRequest {
		t.Errorf("without a request id: %v", err)
	}
	if _, err := r.x.doSend(t.Context(), wire.ConnectorDoParams{Contribution: connectorID, Name: "agentsio_other", Args: raw, RequestID: "r"}); err == nil {
		t.Errorf("an unknown action was run")
	}
	if _, err := r.x.doSend(t.Context(), wire.ConnectorDoParams{Contribution: connectorID, Name: toolSendName, RequestID: "r"}); err == nil || err.Error() != wordsSendArgs {
		t.Errorf("without arguments: %v", err)
	}
	delivers, _, _ := fr.snapshot()
	if len(delivers) != 1 || textOf(delivers[0]) != most {
		t.Errorf("%d delivers", len(delivers))
	}
}

const echoID = "default/channel:demo-chat/pm_1"

// TestEchoOfASendIsNotANewMessage: a message this program sent that comes back through the router as an item,
// without the router's own stamp, is known by its platform id: recorded and skipped, never a new inbound message.
func TestEchoOfASendIsNotANewMessage(t *testing.T) {
	r, fr, fh, _ := sendRig(t)
	text := "see you at three"
	if _, err := r.send("req-1", map[string]any{"to": demoDest("oc_demo"), "text": text}); err != nil {
		t.Fatal(err)
	}
	echo := fr.add(itemOpt{msg: "pm_1", tag: "chat", sender: "ou_account", name: "The Account", text: text})
	if rec := r.waitItem(echo, stateSkipped); rec.Why != whySelf || echo != echoID {
		t.Errorf("echo = %+v", rec)
	}
	// A message with another id is a message like any other, whatever it says.
	other := fr.add(itemOpt{msg: "om_7", tag: "chat", text: text})
	r.waitItem(other, stateDone)
	if opens, sends := fh.counts(); opens != 1 || sends != 0 {
		t.Errorf("%d conversations, %d messages: the echo reached the assistant", opens, sends)
	}
	if th := thingOf(r.collect(), demoThread); th == nil || th["last"] == short(echo) {
		t.Errorf("the echo is in the Inbox: %v", th)
	}
	// The echo did not become the conversation's label or its reply target.
	got, _ := r.destinations()
	for _, d := range got.Destinations {
		if d["id"] == demoDest("oc_demo") && (d["label"] != "Sam Sample" || d["last_ref"] != refToken(r.item(other))) {
			t.Errorf("destination after the echo = %v", d)
		}
	}
}

// TestEchoBeforeTheSendIsAnswered: the channel hands the echo to the router before the router answers the send. The
// item waits for the answer of the send under way in its conversation, and is then known.
func TestEchoBeforeTheSendIsAnswered(t *testing.T) {
	r, fr, fh, _ := sendRig(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			fr.add(itemOpt{msg: "pm_1", tag: "chat", sender: "ou_account", name: "The Account", text: "early"})
			return &fakeAnswer{delay: 60 * time.Millisecond}
		}
	})
	if _, err := r.send("req-1", map[string]any{"to": demoDest("oc_demo"), "text": "early"}); err != nil {
		t.Fatal(err)
	}
	if rec := r.waitItem(echoID, stateSkipped); rec.Why != whySelf {
		t.Errorf("echo = %+v", rec)
	}
	steady(t, "the echo never reaches the assistant", 60*time.Millisecond, func() bool { opens, sends := fh.counts(); return opens+sends == 0 })
}

// TestEchoTakenBeforeTheAnswerIsPutRight: when the wait is not long enough, the echo is taken as an Inbox item; the
// send's answer then says whose message it is. The channel shows the text its own way here, so nothing but the
// platform id in the answer tells that the item is the send coming back.
func TestEchoTakenBeforeTheAnswerIsPutRight(t *testing.T) {
	r, fr, _, first := sendRig(t, withTimings(func(tm *timings) { tm.echoWait = 0 }))
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			fr.add(itemOpt{msg: "pm_1", tag: "inbox", sender: "ou_account", name: "The Account", text: "early (as the channel shows it)"})
			// The answer is held until the echo is in the journal.
			for began := time.Now(); r.item(echoID).State != stateInbox && time.Since(began) < 3*time.Second; {
				time.Sleep(2 * time.Millisecond)
			}
			return nil
		}
	})
	if _, err := r.send("req-1", map[string]any{"to": demoDest("oc_demo"), "text": "early"}); err != nil {
		t.Fatal(err)
	}
	if rec := r.item(echoID); rec.State != stateSkipped || rec.Why != whySelf {
		t.Errorf("echo = %+v", rec)
	}
	if th := thingOf(r.collect(), demoThread); th == nil || th["last"] == short(echoID) {
		t.Errorf("the echo is still in the Inbox: %v", th)
	}
	// While it was taken for somebody's message it named the conversation and was its newest message. Neither stays:
	// the destination is called by the person who wrote there, and that person's message is what a reply names.
	check := func(r *rig, when string) {
		t.Helper()
		got, text := r.destinations()
		d := destOf(got, demoDest("oc_demo"))
		if d["label"] != "Sam Sample" || d["last_ref"] != refToken(first) || strings.Contains(text, "The Account") {
			t.Errorf("%s: destination = %v", when, d)
		}
		card, err := r.describe(map[string]any{"to": demoDest("oc_demo"), "text": "next"})
		if err != nil || !strings.HasPrefix(card.Summary, "发到：Sam Sample（demo-chat 私聊）\n") {
			t.Errorf("%s: card = %+v %v", when, card, err)
		}
	}
	check(r, "after the answer")
	r.stop()
	r2 := startRig(t, fr, newFakeHub(t), withDir(r.dir))
	r2.waitState(wire.ConnectorStateOk)
	check(r2, "after a restart")
}

// TestEchoOfASendOfUnknownOutcome: the router sent the message and its answer was lost, so there is no platform id
// to know the echo by. It is known by its conversation and its text, once: not handed to the assistant, whose
// answer would go back to the conversation without anybody confirming it.
func TestEchoOfASendOfUnknownOutcome(t *testing.T) {
	r, fr, fh, _ := sendRig(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(n int, m map[string]any) *fakeAnswer {
			if n == 1 {
				return &fakeAnswer{sendThenHangup: true}
			}
			return nil
		}
	})
	hellos := len(fr.helloList())
	text := "see you at three"
	_, err := r.send("req-1", map[string]any{"to": demoDest("oc_demo"), "text": text})
	if words, _, _ := saidOf(err); words != wordsSendUnknown {
		t.Fatalf("said %q", words)
	}
	r.reconnected(hellos)
	// The same words in another conversation, and other words in this one, are messages like any other.
	elsewhere := fr.add(itemOpt{msg: "om_20", conv: "oc_other", tag: "inbox", sender: "ou_account", name: "The Account", text: text})
	r.waitItem(elsewhere, stateInbox)
	// So are the same words from the person the conversation is with: somebody who wrote there is not our echo.
	theirs := fr.add(itemOpt{msg: "om_21", tag: "inbox", text: text})
	r.waitItem(theirs, stateInbox)
	echo := fr.add(itemOpt{msg: "pm_1", tag: "chat", sender: "ou_account", name: "The Account", text: text})
	if rec := r.waitItem(echo, stateSkipped); rec.Why != whySelf {
		t.Errorf("echo = %+v", rec)
	}
	if opens, sends := fh.counts(); opens+sends != 0 {
		t.Errorf("%d conversations, %d messages: the echo reached the assistant", opens, sends)
	}
	if !r.x.store().sentByUs("demo-chat", "pm_1") {
		t.Errorf("the echo's id is not remembered")
	}
	// The send's outcome is still what the router said of it: unknown.
	if rec := r.sendRec("req-1"); rec.Echo != "pm_1" || rec.Outcome != sendUnknown {
		t.Errorf("the send's record = %+v", rec)
	}
	got, _ := r.destinations()
	if d := destOf(got, demoDest("oc_demo")); d["label"] != "Sam Sample" || d["last_ref"] != refToken(r.item(theirs)) {
		t.Errorf("destination after the echo = %v", d)
	}
	// One send explains one item: the same words again, from the same account, are a message.
	again := fr.add(itemOpt{msg: "om_22", tag: "chat", sender: "ou_account", name: "The Account", text: text})
	r.waitItem(again, stateDone)
	if opens, sends := fh.counts(); opens != 1 || sends != 0 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
}

// TestEchoOfASendOfUnknownOutcomeOnlyForAWhile: long after the send, the same words are a message.
func TestEchoOfASendOfUnknownOutcomeOnlyForAWhile(t *testing.T) {
	r, fr, _, _ := sendRig(t, withTimings(func(tm *timings) { tm.send, tm.echoKeep = 40*time.Millisecond, time.Millisecond }))
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{drop: true} }
	})
	text := "see you at three"
	if _, err := r.send("req-1", map[string]any{"to": demoDest("oc_demo"), "text": text}); err == nil {
		t.Fatal("a lost request was answered")
	}
	time.Sleep(5 * time.Millisecond)
	late := fr.add(itemOpt{msg: "om_30", tag: "inbox", sender: "ou_account", name: "The Account", text: text})
	r.waitItem(late, stateInbox)
}

// TestEchoOfAnAnswerAndOfAReply: the same for the two other ways a message leaves: a conversation's answer and an
// Inbox reply. A channel that split the message into several reports every id.
func TestEchoOfAnAnswerAndOfAReply(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fr.set(func(f *fakeRouter) {
		f.onDeliver = func(int, map[string]any) *fakeAnswer { return &fakeAnswer{ids: []string{"pm_part_a", "pm_part_b"}} }
	})
	r := startRig(t, fr, fh)
	id := fr.add(itemOpt{msg: "om_1", text: "question", tag: "chat"})
	r.waitItem(id, stateDone)
	st := r.x.store()
	for _, sent := range []string{"pm_1", "pm_part_a", "pm_part_b"} {
		if !st.sentByUs("demo-chat", sent) {
			t.Errorf("the answer's id %s is not remembered", sent)
		}
	}
	for _, msg := range []string{"pm_1", "pm_part_b"} {
		echo := fr.add(itemOpt{msg: msg, tag: "chat", sender: "ou_account", name: "The Account", text: "the answer"})
		if rec := r.waitItem(echo, stateSkipped); rec.Why != whySelf {
			t.Errorf("echo of %s = %+v", msg, rec)
		}
	}
	if opens, sends := fh.counts(); opens != 1 || sends != 0 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
	inbox := fr.add(itemOpt{msg: "om_2", conv: "oc_inbox", text: "for the inbox", tag: "inbox"})
	r.waitItem(inbox, stateInbox)
	if err := r.reply("demo-chat:default:oc_inbox", "a reply", "c-1"); err != nil {
		t.Fatal(err)
	}
	if !st.sentByUs("demo-chat", "pm_2") {
		t.Errorf("the reply's id is not remembered")
	}
	echo := fr.add(itemOpt{msg: "pm_2", conv: "oc_inbox", tag: "inbox", sender: "ou_account", name: "The Account", text: "a reply"})
	r.waitItem(echo, stateSkipped)
}
