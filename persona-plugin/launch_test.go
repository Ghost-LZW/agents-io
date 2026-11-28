package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

// coderLauncher is the launcher most tests configure, and aiRoute the owner's trigger that uses it.
const (
	coderLauncher = "coder = mac-1/claude host=herdr cwd=~/repos/demo model=sonnet effort=high permission_mode=acceptEdits speed=fast"
	aiRoute       = "ai: from=owner prefix=/ai -> launch:coder"
)

func withLaunchers(lines ...string) func(*rigCfg) { return withConfig("launchers", lines) }

func TestParseLaunchers(t *testing.T) {
	good, bad := parseLaunchers([]string{
		"  " + coderLauncher + " ",
		"",
		"plain=mac-2/codex",
		"slash = mac-3/claude-opus model=vendor/model-1 cwd=/srv/work_tree",
	})
	want := []launcher{
		{Name: "coder", MachineID: "mac-1", Launcher: "claude", Host: "herdr", Cwd: "~/repos/demo", Model: "sonnet", Effort: "high",
			PermissionMode: "acceptEdits", Speed: "fast"},
		{Name: "plain", MachineID: "mac-2", Launcher: "codex"},
		{Name: "slash", MachineID: "mac-3", Launcher: "claude-opus", Model: "vendor/model-1", Cwd: "/srv/work_tree"},
	}
	if len(bad) != 0 || len(good) != len(want) {
		t.Fatalf("good = %+v, bad = %+v", good, bad)
	}
	for i, l := range good {
		if l != want[i] {
			t.Errorf("line %d = %+v, want %+v", i+1, l, want[i])
		}
	}
	for line, why := range map[string]string{
		"no equals sign mac-1/claude":          wordsLauncherForm,
		"a = mac-1":                            wordsLauncherForm,
		"a = mac-1/":                           wordsLauncherForm,
		"a = /claude":                          wordsLauncherForm,
		"a =":                                  wordsLauncherForm,
		" = mac-1/claude":                      wordsLauncherForm,
		"Coder = mac-1/claude":                 wordsLauncherName,
		"co der = mac-1/claude":                wordsLauncherName,
		"a = mac?1/claude":                     wordsLauncherPart,
		"a = ../claude":                        wordsLauncherPart,
		"a = mac-1/" + strings.Repeat("l", 65): wordsLauncherPart,
		"a = " + strings.Repeat("m", 129) + "/claude":      wordsLauncherPart,
		"a = mac-1/claude tier=dev":                        wordsLauncherField, // the start request takes no tier
		"a = mac-1/claude host":                            wordsLauncherField,
		"a = mac-1/claude Host=herdr":                      wordsLauncherField,
		"a = mac-1/claude host=herdr host=orca":            wordsLauncherFieldTwice,
		"a = mac-1/claude host=":                           wordsLauncherValue,
		"a = mac-1/claude host=Herdr":                      wordsLauncherValue,
		"a = mac-1/claude speed=slow":                      wordsLauncherValue,
		"a = mac-1/claude effort=very high":                wordsLauncherField, // "high" is read as a field
		"a = mac-1/claude permission_mode=accept;rm":       wordsLauncherValue,
		"a = mac-1/claude cwd=" + strings.Repeat("c", 513): wordsLauncherValue,
		"a = mac-1/" + fakeKey:                             wordsLauncherSecret,
		"a = mac-1/claude cwd=https://example.test/x":      wordsLauncherSecret,
	} {
		good, bad := parseLaunchers([]string{"ok = mac-0/claude", line})
		if len(good) != 1 || len(bad) != 1 || bad[0].Line != 2 || bad[0].Why != why {
			t.Errorf("%q: good %d, bad %+v, want %q", line, len(good), bad, why)
		}
		for _, p := range bad {
			if strings.Contains(p.Why, fakeKey) {
				t.Errorf("the reason repeats the line")
			}
		}
	}
	_, bad = parseLaunchers([]string{"a = mac-1/claude", "a = mac-2/codex", "b = mac-1/claude"})
	if len(bad) != 1 || bad[0] != (destProblem{2, wordsLauncherNameTwice}) {
		t.Errorf("duplicates: %+v", bad) // two names for one launcher are fine: they may differ in their fields
	}
	var many []string
	for i := 0; i < launchersMost+3; i++ {
		many = append(many, fmt.Sprintf("l%d = mac-1/claude", i))
	}
	good, bad = parseLaunchers(many)
	if len(good) != launchersMost || len(bad) != 1 || bad[0] != (destProblem{launchersMost + 1, wordsLauncherTooMany}) {
		t.Errorf("too many: %d good, bad %+v", len(good), bad)
	}
	s := settingsOf(json.RawMessage(`{"launchers":["coder = mac-1/claude","nonsense"]}`), nil)
	if len(s.launchers) != 1 || len(s.badLaunchers) != 1 || s.badLaunchers[0].Line != 2 {
		t.Errorf("settings: %+v %+v", s.launchers, s.badLaunchers)
	}
	if k := launchKey("coder", demoThread); k != "launch/coder/"+demoThread || strings.HasPrefix(demoThread, "launch/") {
		t.Errorf("launchKey = %q", k)
	}
}

func TestTagForLaunch(t *testing.T) {
	s := settingsOf(json.RawMessage(`{"chat_rules":["owner-dm"],"launchers":["coder = mac-1/claude"]}`), nil)
	for _, tc := range []struct{ tag, rule, want, target, source string }{
		{"launch:coder", "", "launch", "coder", "tag"},
		{"launch:coder", "owner-dm", "launch", "coder", "tag"},
		{"launch:nobody", "owner-dm", "inbox", "", "unknown_launcher"}, // never a conversation instead
		{"launch:", "", "inbox", "", "unknown_launcher"},
		{"launch:Coder", "", "inbox", "", "unknown_launcher"},
		{"launch:mac-1/claude", "", "inbox", "", "unknown_launcher"},
		{"launch", "owner-dm", "inbox", "", "unknown_tag"},
		{"", "coder", "inbox", "", "default"},
	} {
		if got, target, source := s.tagFor(tc.tag, tc.rule); got != tc.want || target != tc.target || source != tc.source {
			t.Errorf("tagFor(%q, %q) = %s %q (%s), want %s %q (%s)", tc.tag, tc.rule, got, target, source, tc.want, tc.target, tc.source)
		}
	}
}

// TestLaunchRoundTrip: the owner's trigger starts an Agent session with the launcher's line and the message as its
// first prompt, and the turn's final answer goes back to the conversation. Later messages of that conversation go
// into the same session; another conversation gets its own; a session that has stopped is followed by a new one.
func TestLaunchRoundTrip(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) {
		s.say("assistant", "tool_use", "", "")
		s.say("assistant", "text", "fixed: "+text[strings.LastIndex(text, "\n")+1:], "")
	}
	id := fr.add(itemOpt{msg: "om_1", text: "/ai fix the build " + secretWords, labels: []string{"owner"}, chatName: "Demo"})
	r := startRig(t, fr, fh, withLaunchers(coderLauncher), withRoutes(aiRoute, "mine: from=owner -> ignore"))
	rec := r.waitItem(id, stateDone)
	if rec.Tag != tagLaunch || rec.Target != "coder" || rec.Matched != "ai" || rec.Text != "fix the build "+secretWords {
		t.Errorf("item = %+v", rec)
	}
	start, n := fh.started(0)
	if n != 1 {
		t.Fatalf("%d starts", n)
	}
	if start.opID != opUUID("launch/"+id) {
		t.Errorf("operation id %q", start.opID)
	}
	want := map[string]any{"machine_id": "mac-1", "launcher": "claude", "host": "herdr", "cwd": "~/repos/demo", "model": "sonnet",
		"effort": "high", "permission_mode": "acceptEdits", "speed": "fast", "client_msg_id": "agentsio-" + short(id), "prompt": prompt(rec)}
	if fmt.Sprint(start.body) != fmt.Sprint(want) {
		t.Errorf("start body = %v\nwant %v", start.body, want)
	}
	if first, rest, _ := strings.Cut(fmt.Sprint(start.body["prompt"]), "\n"); !strings.HasPrefix(first, "【渠道消息】发送者：") ||
		!strings.Contains(first, "路由认定：主人") || rest != "\nfix the build "+secretWords {
		t.Errorf("prompt = %q", start.body["prompt"])
	}
	if opens, sends := fh.counts(); opens != 0 || sends != 0 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
	delivers, _, _ := fr.snapshot()
	if len(delivers) != 1 || delivers[0]["operationId"] != "reply-"+short(id) || textOf(delivers[0]) != "fixed: fix the build "+secretWords ||
		routeOf(delivers[0])["conversationId"] != "oc_demo" {
		t.Fatalf("delivers = %v", delivers)
	}
	eventually(t, "working then done", func() bool { return strings.Join(fr.acksFor("om_1"), ",") == "working,done" })
	if rec.Run.MachineID != "mac-1" || rec.Run.SessionID != "a1" || !rec.Run.Head {
		t.Errorf("run = %+v", rec.Run)
	}
	st := r.x.store()
	if conv, ok := st.conv(launchKey("coder", demoThread)); !ok || conv.SessionID != "a1" || conv.LastSeq != 3 {
		t.Errorf("mapping = %+v %v", conv, ok)
	}
	if _, ok := st.conv(demoThread); ok {
		t.Errorf("a launch item mapped its conversation as a chat")
	}

	// The next trigger of the same conversation goes into that session, with its own message id.
	next := fr.add(itemOpt{msg: "om_2", text: "/ai and the tests", labels: []string{"owner"}})
	if rec := r.waitItem(next, stateDone); rec.Run.SessionID != "a1" || rec.Run.Head || rec.Run.BaseSeq != 3 {
		t.Errorf("second run = %+v", rec.Run)
	}
	if _, n := fh.started(0); n != 1 {
		t.Errorf("%d starts", n)
	}
	if s := fh.send(0); s.mid != "mac-1" || s.sid != "a1" || s.body["client_msg_id"] != "agentsio-"+short(next) ||
		!strings.HasSuffix(fmt.Sprint(s.body["text"]), "\n\nand the tests") {
		t.Errorf("send = %+v", s)
	}
	// The owner's other messages are ignored by the next rule: nothing goes in.
	plain := fr.add(itemOpt{msg: "om_3", text: "just a note", labels: []string{"owner"}})
	r.waitItem(plain, stateSkipped)

	// Another conversation: a session of its own.
	other := fr.add(itemOpt{msg: "om_4", conv: "oc_b", text: "/ai over here", labels: []string{"owner"}})
	if rec := r.waitItem(other, stateDone); rec.Run.SessionID != "a2" {
		t.Errorf("other conversation: %+v", rec.Run)
	}

	// The first session has stopped (the list says so): the next trigger starts a new one, not a message.
	fh.set(func(f *fakeHub) { f.sessions["mac-1/a1"].row.Status = "offline" })
	again := fr.add(itemOpt{msg: "om_5", text: "/ai once more", labels: []string{"owner"}})
	if rec := r.waitItem(again, stateDone); rec.Run.SessionID != "a3" || !rec.Run.Head {
		t.Errorf("after the stop: %+v", rec.Run)
	}
	// Stopped, and the list did not say so yet: the hub refuses the message (nothing typed), and a new one starts.
	fh.set(func(f *fakeHub) { f.sessions["mac-1/a3"].stopped = true })
	last := fr.add(itemOpt{msg: "om_6", text: "/ai and again", labels: []string{"owner"}})
	if rec := r.waitItem(last, stateDone); rec.Run.SessionID != "a4" {
		t.Errorf("after the refusal: %+v", rec.Run)
	}
	if _, n := fh.started(0); n != 4 {
		t.Errorf("%d starts", n)
	}
	if conv, _ := st.conv(launchKey("coder", demoThread)); conv.SessionID != "a4" {
		t.Errorf("mapping = %+v", conv)
	}
	want2 := fmt.Sprintf(wordsLaunchersVia, 1) + "；" + fmt.Sprintf(wordsRoutesVia, 2, "ai 5、mine 1")
	if got := r.waitState(wire.ConnectorStateOk); got.Via != want2 {
		t.Errorf("status = %q, want %q", got.Via, want2)
	}
}

// TestLaunchOnlyForTheOwner: whatever the routes or the tag say, only the owner's own message starts anything. Any
// other is the Inbox, with the reason; nothing is started and nothing is typed.
func TestLaunchOnlyForTheOwner(t *testing.T) {
	for _, tc := range []struct {
		name string
		item itemOpt
		why  string
	}{
		{"unknown sender", itemOpt{unknown: true}, whyLaunchNotOwner},
		{"a known label", itemOpt{labels: []string{"family"}}, whyLaunchNotOwner},
		{"known without labels", itemOpt{}, whyLaunchNotOwner},
		{"a name that says owner", itemOpt{unknown: true, name: "owner"}, whyLaunchNotOwner},
		{"a bot stamped as the owner", itemOpt{labels: []string{"owner"}, bot: true}, whyLoopGuard},
		{"no reply route", itemOpt{labels: []string{"owner"}, noRoute: true}, whyNoRoute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			tc.item.msg, tc.item.text, tc.item.tag = "om_1", "/ai rm -rf ~", "launch:coder"
			id := fr.add(tc.item)
			r := startRig(t, fr, fh, withLaunchers(coderLauncher))
			rec := r.waitItem(id, stateInbox)
			if rec.Why != tc.why || rec.Tag != tagLaunch {
				t.Errorf("tag %q why %q, want %q", rec.Tag, rec.Why, tc.why)
			}
			steady(t, "nothing is started", 80*time.Millisecond, func() bool {
				_, n := fh.started(0)
				opens, sends := fh.counts()
				return n+opens+sends == 0
			})
			if th := thingOf(r.collect(), demoThread); th == nil || tc.why == whyLaunchNotOwner && th["why"] != tc.why {
				t.Errorf("thing = %v", th)
			}
		})
	}
	// The owner's item tagged launch:<name> by the router's own rule starts one, as a route does.
	fr, fh := newFakeRouter(t), newFakeHub(t)
	id := fr.add(itemOpt{msg: "om_1", text: "start please", tag: "launch:coder", labels: []string{"owner"}})
	r := startRig(t, fr, fh, withLaunchers(coderLauncher))
	if rec := r.waitItem(id, stateDone); rec.TagSource != "tag" || rec.Text != "start please" {
		t.Errorf("tagged: %+v", rec)
	}
	// A tag naming a launcher the settings do not have is the Inbox with the reason.
	unknown := fr.add(itemOpt{msg: "om_2", conv: "oc_b", text: "x", tag: "launch:nobody", labels: []string{"owner"}})
	if rec := r.waitItem(unknown, stateInbox); rec.Why != whyLaunchUnknown || rec.Tag != tagInbox {
		t.Errorf("unknown launcher: %+v", rec)
	}
	if _, n := fh.started(0); n != 1 {
		t.Errorf("%d starts", n)
	}
}

// TestLaunchRedeliveredItemStartsOnce: the router pushes the same item again (it went away before it recorded the
// accept, and once more after this program restarted): it is taken once and starts one session.
func TestLaunchRedeliveredItemStartsOnce(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fr.set(func(f *fakeRouter) { f.dropAccepts = 2 })
	id := fr.add(itemOpt{msg: "om_1", text: "/ai go", labels: []string{"owner"}})
	dir := t.TempDir()
	r := startRig(t, fr, fh, withDir(dir), withLaunchers(coderLauncher), withRoutes(aiRoute))
	r.waitItem(id, stateDone)
	eventually(t, "pushed again", func() bool { fr.mu.Lock(); defer fr.mu.Unlock(); return fr.pushes >= 3 })
	r.stop()
	fr.set(func(f *fakeRouter) { f.acked = 0 }) // a router that lost its cursor pushes everything again
	r = startRig(t, fr, fh, withDir(dir), withLaunchers(coderLauncher), withRoutes(aiRoute))
	eventually(t, "accepted again", func() bool { fr.mu.Lock(); defer fr.mu.Unlock(); return fr.acked > 0 })
	steady(t, "one start, one answer", 100*time.Millisecond, func() bool {
		_, n := fh.started(0)
		d, _, _ := fr.snapshot()
		return n == 1 && len(d) == 1
	})
}

// TestLaunchFoundMidStartAfterRestartIsNotRepeated: the journal says a start was about to be, or was, asked for when
// the program stopped. The session may be running: it is never started again, and the item needs the owner.
func TestLaunchFoundMidStartAfterRestartIsNotRepeated(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	route := replyRoute{Channel: "demo-chat", Account: "default", ConversationID: "oc_demo", ReplyToMessageID: "om_1"}
	id := "default/channel:demo-chat/om_1"
	if _, err := st.add(itemRec{ID: id, Tag: tagLaunch, Target: "coder", TagSource: tagSourceRoute, Matched: "ai", ConvKey: demoThread,
		Channel: "demo-chat", MessageID: "om_1", Text: "go", Route: &route, ReceivedAt: time.Now(), State: stateRunning,
		Known: true, SenderLabels: []string{"owner"},
		Run: &runRec{MsgID: "agentsio-" + short(id), State: runLaunching, OpID: opUUID("launch/" + id), StartedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	r := startRig(t, fr, fh, withDir(dir), withLaunchers(coderLauncher), withRoutes(aiRoute))
	if rec := r.waitItem(id, stateFailed); rec.Why != whyLaunchRestartUnsure {
		t.Errorf("why = %q", rec.Why)
	}
	steady(t, "nothing is started", 80*time.Millisecond, func() bool { _, n := fh.started(0); return n == 0 })
	if th := thingOf(r.collect(), demoThread); th == nil || th["why"] != whyLaunchRestartUnsure {
		t.Errorf("thing = %v", th)
	}
}

// TestLaunchOutcomes: a start whose answer says nothing started is tried again under a new operation id (the hub
// replays a start's receipt, a refusal too); one refused for good fails at once; one whose outcome is not known is
// never asked again.
func TestLaunchOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		script func(n int) (int, string, bool)
		state  string
		why    string
		starts int
		ops    int // distinct operation ids
	}{
		{"manager away, then back", func(n int) (int, string, bool) {
			if n == 1 {
				return 503, `{"error":"away","code":"assistant_offline"}`, false
			}
			return 0, "", true
		}, stateDone, "", 2, 2},
		{"computer offline, then back", func(n int) (int, string, bool) {
			if n <= 2 {
				return 503, `{"error":"offline","code":"node_unreachable","retryable":true,"delivered":"none"}`, false
			}
			return 0, "", true
		}, stateDone, "", 3, 3},
		{"the launcher is not on that computer", func(n int) (int, string, bool) {
			return 400, `{"error":"launcher_not_on_machine","code":"bad_request"}`, false
		}, stateFailed, whyLaunchRefused, 1, 1},
		{"the node refuses", func(n int) (int, string, bool) {
			return 409, `{"error":"no herdr","code":"engine_missing"}`, false
		}, stateFailed, whyLaunchRefused, 1, 1},
		{"another manager's computer", func(n int) (int, string, bool) {
			return 403, `{"error":"not yours","code":"other_manager"}`, false
		}, stateFailed, whyLaunchRefused, 1, 1},
		{"the node timed out", func(n int) (int, string, bool) {
			return 502, `{"error":"timeout","code":"timeout"}`, true
		}, stateFailed, whyLaunchUnsure, 1, 1},
		{"a pending receipt", func(n int) (int, string, bool) {
			return 202, `{"state":"pending"}`, true
		}, stateFailed, whyLaunchUnsure, 1, 1},
		{"started, and it did not say where", func(n int) (int, string, bool) {
			return 200, `{"session":{}}`, true
		}, stateFailed, whyLaunchUnsure, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr, fh := newFakeRouter(t), newFakeHub(t)
			fh.onStart = tc.script
			id := fr.add(itemOpt{msg: "om_1", text: "/ai go", labels: []string{"owner"}})
			r := startRig(t, fr, fh, withLaunchers(coderLauncher), withRoutes(aiRoute))
			rec := r.waitItem(id, tc.state)
			if rec.Why != tc.why {
				t.Errorf("why = %q, want %q", rec.Why, tc.why)
			}
			steady(t, "no more starts", 80*time.Millisecond, func() bool { _, n := fh.started(0); return n == tc.starts })
			ops := map[string]bool{}
			for i := 0; i < tc.starts; i++ {
				s, _ := fh.started(i)
				ops[s.opID] = true
				if s.body["client_msg_id"] != "agentsio-"+short(id) {
					t.Errorf("start %d: client_msg_id %v", i, s.body["client_msg_id"])
				}
			}
			if len(ops) != tc.ops {
				t.Errorf("%d operation ids, want %d", len(ops), tc.ops)
			}
			if tc.state == stateFailed {
				if d, _, _ := fr.snapshot(); len(d) != 0 {
					t.Errorf("delivers = %v", d)
				}
				if th := thingOf(r.collect(), demoThread); th == nil || th["why"] != tc.why {
					t.Errorf("thing = %v", th)
				}
			}
		})
	}
}

// TestLaunchWithoutAnAnswerWaitsLikeAnyTurn: a session that works is waited for, and its answer is taken once it is
// over. A launched session that disappears ends the run with its own reason, and the next trigger starts anew.
func TestLaunchWithoutAnAnswerWaitsLikeAnyTurn(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.turn = func(s *fakeSession, text, msgID string) { s.row.Status = "working" }
	id := fr.add(itemOpt{msg: "om_1", text: "/ai long job", labels: []string{"owner"}})
	r := startRig(t, fr, fh, withLaunchers(coderLauncher), withRoutes(aiRoute))
	eventually(t, "seen working", func() bool { rec := r.item(id); return rec.Run != nil && rec.Run.Seen })
	steady(t, "nothing delivered while it works", 100*time.Millisecond, func() bool { d, _, _ := fr.snapshot(); return len(d) == 0 })
	fh.set(func(f *fakeHub) {
		s := f.sessions["mac-1/a1"]
		s.say("assistant", "text", "done at last", "")
		s.row.Status = "idle"
	})
	r.waitItem(id, stateDone)
	if d, _, _ := fr.snapshot(); len(d) != 1 || textOf(d[0]) != "done at last" {
		t.Errorf("delivers = %v", d)
	}
	fh.set(func(f *fakeHub) {
		f.turn = func(s *fakeSession, text, msgID string) { s.gone = true }
	})
	gone := fr.add(itemOpt{msg: "om_2", conv: "oc_b", text: "/ai vanish", labels: []string{"owner"}})
	if rec := r.waitItem(gone, stateFailed); rec.Why != whyLaunchGone {
		t.Errorf("why = %q", rec.Why)
	}
	if _, ok := r.x.store().conv(launchKey("coder", "demo-chat:default:oc_b")); ok {
		t.Errorf("the mapping of a session that is gone is kept")
	}
}

// TestBadLauncherLinesAreSkippedAtStart: a configuration saved without the check starts anyway; the lines that do not
// read are skipped and counted, and the settings check refuses them with their number.
func TestBadLauncherLinesAreSkippedAtStart(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	id := fr.add(itemOpt{text: "/ai go", labels: []string{"owner"}})
	r := startRig(t, fr, fh, withLaunchers("nonsense", coderLauncher), withRoutes(aiRoute))
	r.waitItem(id, stateDone)
	want := fmt.Sprintf(wordsBadLaunchersVia, 1) + "；" + fmt.Sprintf(wordsLaunchersVia, 1) + "；" + fmt.Sprintf(wordsRoutesVia, 1, "ai 1")
	if got := r.waitState(wire.ConnectorStateOk); got.Via != want {
		t.Errorf("status = %q, want %q", got.Via, want)
	}
	cfg, _ := json.Marshal(map[string]any{"launchers": []string{coderLauncher, "b = mac-1/claude tier=dev"}})
	var res wire.SettingsCheckResult
	if err := r.h.Call("settings.check", wire.SettingsCheckParams{Config: cfg}, &res); err != nil {
		t.Fatal(err)
	}
	if res.Ok || !strings.Contains(res.Error, "第 2 行") || !strings.Contains(res.Error, wordsLauncherField) {
		t.Errorf("check = %+v", res)
	}
}

// TestClassifyStart pins how a start's answer is read: only an answer that says nothing started is tried again, a
// refusal for good is never tried again, and everything else is unknown.
func TestClassifyStart(t *testing.T) {
	ans := func(status int, body string) hubAnswer {
		a := hubAnswer{status: status, raw: []byte(body)}
		_ = json.Unmarshal(a.raw, &a.body)
		return a
	}
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{200, `{"session":{"machine_id":"m","session_id":"s"}}`, outSent},
		{202, `{"state":"pending"}`, outUnknown},
		{202, `{"state":"unknown"}`, outUnknown},
		{200, `{"delivered":"unknown"}`, outUnknown},
		{503, `{"code":"assistant_offline"}`, outRetry},
		{503, `{"code":"node_unreachable","retryable":true,"delivered":"none"}`, outRetry},
		{503, `{"code":"terminal_not_ready"}`, outRetry},
		{503, `{"code":"no database"}`, outUnknown},
		{502, `{"code":"timeout"}`, outUnknown},
		{502, `{"code":"internal","delivered":"none"}`, outRetry},
		{429, `{"code":"rate_limited"}`, outRetry},
		{400, `{"code":"bad_request"}`, outRefused},
		{403, `{"code":"terminal_control_refused","delivered":"none"}`, outRefused}, // asking again is refused again
		{404, `{"error":"unknown machine"}`, outRefused},
		{409, `{"code":"engine_missing"}`, outRefused},
		{409, `{"code":"machine_pending"}`, outRefused},
	} {
		if got := classifyStart(ans(tc.status, tc.body), nil); got != tc.want {
			t.Errorf("%d %s = %s, want %s", tc.status, tc.body, got, tc.want)
		}
	}
	if got := classifyStart(hubAnswer{}, fmt.Errorf("read: %w", errLost)); got != outUnknown {
		t.Errorf("a lost answer = %s", got)
	}
}

// TestLaunchLineChangedStartsANewSession: a conversation's session is used again only while the launcher's line says
// what it said when the session started. The same line after a restart goes on in it; a changed line (another model
// here) starts a new one. A session this token may no longer read is followed by a new one too.
func TestLaunchLineChangedStartsANewSession(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	dir := t.TempDir()
	run := func(line, msg string) itemRec {
		t.Helper()
		id := fr.add(itemOpt{msg: msg, text: "/ai " + msg, labels: []string{"owner"}})
		r := startRig(t, fr, fh, withDir(dir), withLaunchers(line), withRoutes(aiRoute))
		defer r.stop()
		return r.waitItem(id, stateDone)
	}
	if rec := run("coder = mac-1/claude model=sonnet", "om_1"); rec.Run.SessionID != "a1" {
		t.Fatalf("first: %+v", rec.Run)
	}
	if rec := run("coder = mac-1/claude  model=sonnet", "om_2"); rec.Run.SessionID != "a1" || rec.Run.Head {
		t.Errorf("same line: %+v", rec.Run) // the same fields, however spaced
	}
	if rec := run("coder = mac-1/claude model=opus", "om_3"); rec.Run.SessionID != "a2" || !rec.Run.Head {
		t.Errorf("changed line: %+v", rec.Run)
	}
	if s, n := fh.started(1); n != 2 || s.body["model"] != "opus" {
		t.Errorf("starts = %d, second %v", n, s.body)
	}
	fh.set(func(f *fakeHub) { f.sessions["mac-1/a2"].hiddenTo = true })
	if rec := run("coder = mac-1/claude model=opus", "om_4"); rec.Run.SessionID != "a3" {
		t.Errorf("hidden: %+v", rec.Run)
	}
	if opens, sends := fh.counts(); opens != 0 || sends != 1 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
}

func TestCutFold(t *testing.T) {
	for _, tc := range []struct {
		text, p, rest string
		ok            bool
	}{
		{"/AI fix", "/ai", " fix", true},
		{"ÄBC rest", "äbc", " rest", true},
		{"Kx", "k", "x", true}, // the Kelvin sign folds to k, in another number of bytes
		{"助手 帮我", "助手", " 帮我", true},
		{"助", "助手", "", false},
		{"/a", "/ai", "", false},
		{"\xff/ai", "/ai", "", false},
	} {
		if rest, ok := cutFold(tc.text, tc.p); rest != tc.rest || ok != tc.ok {
			t.Errorf("cutFold(%q, %q) = %q %v", tc.text, tc.p, rest, ok)
		}
	}
}
