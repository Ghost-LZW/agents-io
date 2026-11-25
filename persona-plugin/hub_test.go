package main

import (
	"context"
	"errors"
	"net"
	"regexp"
	"testing"
	"time"
)

func TestClassifySendOutcome(t *testing.T) {
	ans := func(status int, code, delivered, state string) hubAnswer {
		a := hubAnswer{status: status}
		a.body.Code, a.body.Delivered, a.body.State = code, delivered, state
		return a
	}
	for _, tc := range []struct {
		name string
		ans  hubAnswer
		err  error
		want string
	}{
		{"ok", ans(200, "", "", ""), nil, outSent},
		{"kept by the manager", ans(202, "", "later", ""), nil, outSent},
		{"receipt pending", ans(202, "", "", "pending"), nil, outUnknown},
		{"receipt unknown", ans(202, "", "", "unknown"), nil, outUnknown},
		{"bare 202", ans(202, "", "", ""), nil, outUnknown},
		{"in doubt", ans(502, "assistant_in_doubt", "unknown", ""), nil, outUnknown},
		{"send in doubt", ans(409, "send_in_doubt", "unknown", ""), nil, outUnknown},
		{"delivered unknown", ans(502, "node_unreachable", "unknown", ""), nil, outUnknown},
		{"bare 502", ans(502, "", "", ""), nil, outUnknown},
		{"bare 500", ans(500, "", "", ""), nil, outUnknown},
		{"bare 503", ans(503, "", "", ""), nil, outUnknown},
		{"bare 504", ans(504, "", "", ""), nil, outUnknown},
		{"manager offline", ans(503, "assistant_offline", "", ""), nil, outRetry},
		{"node offline, nothing typed", ans(503, "node_unreachable", "none", ""), nil, outRetry},
		{"draft in the box", ans(409, "input_draft", "none", ""), nil, outRetry},
		{"busy", ans(429, "", "", ""), nil, outRetry},
		{"reached the agent, then failed", ans(500, "", "yes", ""), nil, outSent},
		{"no such session", ans(404, "no_session", "none", ""), nil, outGone},
		{"gone", ans(410, "gone", "", ""), nil, outGone},
		{"bad request", ans(400, "", "none", ""), nil, outRefused},
		{"control characters", ans(403, "terminal_control_refused", "none", ""), nil, outRefused},
		{"refused start, nothing delivered", ans(409, "launcher_missing", "none", ""), nil, outRetry},
		{"dialog open", ans(423, "", "", ""), nil, outRetry},
		{"not permitted", ans(403, "forbidden", "none", ""), nil, outRefused},
		{"never connected", hubAnswer{}, &net.OpError{Op: "dial", Err: errors.New("refused")}, outRetry},
		{"no such host", hubAnswer{}, &net.DNSError{Err: "no such host"}, outRetry},
		{"cut off after the request was written", hubAnswer{}, &net.OpError{Op: "read", Err: errors.New("reset")}, outUnknown},
		{"timeout", hubAnswer{}, context.DeadlineExceeded, outUnknown},
		{"cut off mid-answer", ans(200, "", "", ""), errors.New("unexpected EOF"), outUnknown},
	} {
		if got := classify(tc.ans, tc.err); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestOperationIDIsAStableUUID(t *testing.T) {
	a, b := opUUID("open/default/channel:demo-chat/om_1"), opUUID("open/default/channel:demo-chat/om_1")
	c := opUUID("open/default/channel:demo-chat/om_1/reopen")
	if a != b || a == c || !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(a) {
		t.Errorf("op ids: %s %s %s", a, b, c)
	}
}

func TestHubReads(t *testing.T) {
	fh := newFakeHub(t)
	tm := fastTimings()
	h := newHubClient(fh.url(), fakeHubToken, tm)
	if newHubClient("", fakeHubToken, tm) != nil || newHubClient(fh.url(), "", tm) != nil {
		t.Errorf("a client without an address or a token")
	}
	ctx := t.Context()
	mid, sid, out, renew := h.open(ctx, "first", false, opUUID("x"))
	if out != outSent || mid != "m1" || sid != "s1" || renew {
		t.Fatalf("open: %s %s %s", mid, sid, out)
	}
	fh.set(func(f *fakeHub) {
		f.pageSize = 2
		s := f.session(1)
		for i := 0; i < 5; i++ {
			s.say("assistant", "text", "more", "")
		}
	})
	items, complete, err := h.items(ctx, mid, sid, 1)
	if err != nil || !complete || len(items) != 6 || items[0].Seq != 2 || items[5].Seq != 7 {
		t.Errorf("paged items: %d %v %v", len(items), complete, err)
	}
	// A transcript longer than one read's page limit is not taken for whole.
	fh.set(func(f *fakeHub) {
		f.pageSize = 1
		s := f.session(1)
		for i := 0; i < itemPagesMost+5; i++ {
			s.say("assistant", "tool_use", "", "")
		}
	})
	part, complete, err := h.items(ctx, mid, sid, 0)
	if err != nil || complete || len(part) != itemPagesMost {
		t.Errorf("a read cut at the page limit: %d items, complete=%v, %v", len(part), complete, err)
	}
	rest, complete, err := h.items(ctx, mid, sid, part[len(part)-1].Seq)
	if err != nil || !complete || rest[len(rest)-1].Seq != int64(7+itemPagesMost+5) {
		t.Errorf("going on from where it stopped: %d items, complete=%v, %v", len(rest), complete, err)
	}
	fh.set(func(f *fakeHub) { f.pageSize = 100 })
	// The wire shape of the product: "injected" and "source" are objects, a long text is cut with full_size.
	fh.set(func(f *fakeHub) {
		s := f.session(1)
		s.say("user", "text", "a task notice", "").Injected = true
		s.say("user", "text", "scheduled", "").Source = "schedule"
		s.say("user", "text", "typed", "app-1")
		long := s.say("assistant", "text", "cut…", "")
		long.Full = "the whole answer"
	})
	tail, _, err := h.items(ctx, mid, sid, int64(7+itemPagesMost+5))
	if err != nil || len(tail) != 4 {
		t.Fatalf("items of the product's shape: %d %v", len(tail), err)
	}
	if tail[0].typed() || tail[1].typed() || !tail[2].typed() || tail[3].FullSize != int64(len("the whole answer")) || tail[3].ID == "" {
		t.Errorf("decoded items = %+v", tail)
	}
	if text, err := h.full(ctx, mid, sid, tail[3].ID); err != nil || text != "the whole answer" {
		t.Errorf("full text: %q %v", text, err)
	}
	if _, err := h.full(ctx, mid, sid, "no such item"); err == nil {
		t.Errorf("the full text of an item that is not there")
	}
	fh.set(func(f *fakeHub) { f.badItems = true })
	if _, _, err := h.items(ctx, mid, sid, 0); !errors.Is(err, errUndecodable) {
		t.Errorf("a page of another shape: %v", err)
	}
	fh.set(func(f *fakeHub) { f.badItems = false })
	row, found, err := h.look(ctx, mid, sid)
	if err != nil || !found || row.Status != "idle" || row.busy() {
		t.Errorf("look: %+v %v %v", row, found, err)
	}
	if _, found, err := h.look(ctx, mid, "s-none"); found || err != nil {
		t.Errorf("look of a conversation that is not listed: %v %v", found, err)
	}
	for _, r := range []sessionRow{{Status: "working"}, {Status: "blocked"}, {Starting: true}, {Status: "idle", PendingInteractions: 1}} {
		if !r.busy() {
			t.Errorf("%+v is not busy", r)
		}
	}
	// Guest conversations: asked once, then from the cache; an older hub (404) has none.
	if ok, known := h.guestOK(ctx); !ok || !known {
		t.Errorf("guest_conversations true was not read")
	}
	fh.set(func(f *fakeHub) { f.guest = nil })
	if ok, known := h.guestOK(ctx); !ok || !known {
		t.Errorf("the answer was not cached")
	}
	h.capsEvery = time.Nanosecond
	time.Sleep(time.Millisecond)
	if ok, known := h.guestOK(ctx); ok || !known {
		t.Errorf("a 404 was read as guest conversations (%v, known %v)", ok, known)
	}
	// A request that fails is no answer, and is not remembered as one.
	h.capsEvery = time.Hour
	h.guestAt = time.Time{}
	fh.set(func(f *fakeHub) {
		yes := true
		f.guest = &yes
		f.onCaps = func(int) (int, string) { return 503, `{"error":"manager away","code":"assistant_offline"}` }
	})
	if ok, known := h.guestOK(ctx); ok || known {
		t.Errorf("a failed capabilities request was read as an answer (%v, known %v)", ok, known)
	}
	fh.set(func(f *fakeHub) { f.onCaps = nil })
	if ok, known := h.guestOK(ctx); !ok || !known {
		t.Errorf("the failure was cached: %v, known %v", ok, known)
	}
	// A wrong token is an error, not an empty answer.
	bad := newHubClient(fh.url(), "pext_wrong_token_not_real", tm)
	if _, _, err := bad.items(ctx, mid, sid, 0); err == nil {
		t.Errorf("items with a wrong token")
	}
}
