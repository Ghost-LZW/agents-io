package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRouterAddressForms(t *testing.T) {
	none := func(string) string { return "" }
	proxied := func(name string) string {
		if name == "HTTP_PROXY" {
			return "http://127.0.0.1:3128"
		}
		return ""
	}
	for _, tc := range []struct {
		in     string
		getenv func(string) string
		want   string
	}{
		{"https://router.example.test", none, "wss://router.example.test/ws"},
		{"https://router.example.test/", none, "wss://router.example.test/ws"},
		{"https://router.example.test:8443/console/ws", none, "wss://router.example.test:8443/console/ws"},
		{"http://127.0.0.1:8787", none, "ws://127.0.0.1:8787/ws"},
		{"ws://router.example.test:8787", none, "ws://router.example.test:8787/ws"},
		{"wss://router.example.test", none, "wss://router.example.test/ws"},
		// In the hub's sandbox, the machine's loopback is reached under another name.
		{"http://127.0.0.1:8787", proxied, "ws://host.persona.internal:8787/ws"},
		{"http://localhost:8787", proxied, "ws://host.persona.internal:8787/ws"},
		{"http://[::1]:8787", proxied, "ws://host.persona.internal:8787/ws"},
		{"http://router.example.test:8787", proxied, "ws://router.example.test:8787/ws"},
		{"https://127.0.0.1:8787", proxied, "wss://127.0.0.1:8787/ws"},
	} {
		got, err := settings{routerURL: tc.in}.wsURL(tc.getenv)
		if err != nil || got != tc.want {
			t.Errorf("%s: %q %v, want %q", tc.in, got, err, tc.want)
		}
	}
	for _, bad := range []string{"", "router.example.test", "ftp://router.example.test", "https://me:pw@router.example.test",
		"https://router.example.test/?key=x", "https://router.example.test/#x", "https://", "://x"} {
		if got, err := (settings{routerURL: bad}).wsURL(none); err == nil {
			t.Errorf("%q was accepted as %q", bad, got)
		}
	}
}

func TestTagFor(t *testing.T) {
	s := settingsOf(json.RawMessage(`{"chat_rules":["owner-dm"," both "],"guest_rules":["visitors","both"]}`), nil)
	if _, target, _ := s.tagFor("chat", "owner-dm"); target != "" {
		t.Errorf("a chat tag has a target %q", target)
	}
	for _, tc := range []struct{ tag, rule, want, source string }{
		{"inbox", "owner-dm", "inbox", "tag"}, // the item's tag wins over the rule lists
		{"chat", "", "chat", "tag"},
		{"guest", "x", "guest", "tag"},
		{"agent", "x", "inbox", "unknown_tag"}, // a tag this version does not know
		{"Chat", "x", "inbox", "unknown_tag"},
		{"", "owner-dm", "chat", "rule"},
		{"", "visitors", "guest", "rule"},
		{"", "both", "chat", "rule"},                  // in both lists: chat
		{"agent", "visitors", "inbox", "unknown_tag"}, // an unknown tag is the Inbox even on a listed rule
		{"archive", "owner-dm", "inbox", "unknown_tag"},
		{"Guest", "both", "inbox", "unknown_tag"},
		{"", "other", "inbox", "default"},
		{"", "", "inbox", "default"},
	} {
		if got, _, source := s.tagFor(tc.tag, tc.rule); got != tc.want || source != tc.source {
			t.Errorf("tagFor(%q, %q) = %s (%s), want %s (%s)", tc.tag, tc.rule, got, source, tc.want, tc.source)
		}
	}
}

func TestSettingsDefaultsAndLimits(t *testing.T) {
	s := settingsOf(json.RawMessage(`{"router_url":" https://router.example.test "}`), map[string]string{"backend_key": " " + fakeKey + "\n"})
	if s.routerURL != "https://router.example.test" || s.key != fakeKey || !s.workingMark || s.chatWait != 240*time.Minute ||
		s.keep != 30*24*time.Hour || s.triageRules != "" || s.missing() != "" {
		t.Errorf("defaults: %+v", s)
	}
	s = settingsOf(json.RawMessage(`{"working_mark":false,"chat_wait_minutes":1,"keep_days":9999,"triage_rules":"a\\nb"}`), nil)
	if s.workingMark || s.chatWait != 5*time.Minute || s.keep != 90*24*time.Hour || s.triageRules != "a\nb" {
		t.Errorf("limits: %+v", s)
	}
	for _, tc := range []struct {
		s    settings
		want string
	}{
		{settings{}, wordsNotConfigured},
		{settings{key: fakeKey}, wordsNoAddress},
		{settings{routerURL: "https://router.example.test"}, wordsNoKey},
		{settings{routerURL: "ftp://router.example.test", key: fakeKey}, wordsAddressForm},
	} {
		if got := tc.s.missing(); got != tc.want {
			t.Errorf("missing(%+v) = %q", tc.s, got)
		}
	}
}

func TestParseDestinations(t *testing.T) {
	good, bad := parseDestinations([]string{
		"  Project room = demo-chat:default:oc_example ",
		"",
		"mail = demo-mail:work:thread:2026:11@example.test", // the conversation id keeps its colons
		"beta=demo-chat:second:oc_beta",
	})
	want := []destination{
		{"Project room", "demo-chat", "default", "oc_example"},
		{"mail", "demo-mail", "work", "thread:2026:11@example.test"},
		{"beta", "demo-chat", "second", "oc_beta"},
	}
	if len(bad) != 0 || len(good) != len(want) {
		t.Fatalf("good = %+v, bad = %+v", good, bad)
	}
	for i, d := range good {
		if d != want[i] {
			t.Errorf("line %d = %+v, want %+v", i+1, d, want[i])
		}
		if id := d.id(); !strings.HasPrefix(id, "d-") || len(id) != 14 || strings.Contains(id, d.ConvID) {
			t.Errorf("id = %q", id)
		}
	}
	if good[0].id() == good[2].id() || good[0].id() != destID("demo-chat", "default", "oc_example") {
		t.Errorf("ids are not a function of the coordinates")
	}
	for line, why := range map[string]string{
		"no equals sign demo-chat:default:oc_x":                 wordsDestForm,
		"alpha ＝ demo-chat:default:oc_x":                        wordsDestForm, // a full-width sign is not read: the words say half-width
		"alpha = demo-chat:default":                             wordsDestForm,
		"alpha = demo-chat::oc_x":                               wordsDestForm,
		" = demo-chat:default:oc_x":                             wordsDestForm,
		"alpha = :default:oc_x":                                 wordsDestForm,
		strings.Repeat("n", 41) + " = demo-chat:default:x":      wordsDestName,
		"alpha = demo chat:default:oc_x":                        wordsDestPart,
		"alpha = demo-chat:de fault:oc_x":                       wordsDestPart,
		"alpha = " + strings.Repeat("c", 65) + ":default:x":     wordsDestPart,
		"alpha = demo-chat:default:oc x":                        wordsDestConv,
		"alpha = demo-chat:default:" + strings.Repeat("c", 257): wordsDestConv,
		"alpha = demo-chat:default:" + fakeKey:                  wordsDestSecret,
		"AIOB_x = demo-chat:default:oc_x":                       wordsDestSecret,
		"alpha = https://router.example.test:default:oc_x":      wordsDestSecret,
	} {
		good, bad := parseDestinations([]string{"ok = demo-chat:default:oc_ok", line})
		if len(good) != 1 || len(bad) != 1 || bad[0].Line != 2 || bad[0].Why != why {
			t.Errorf("%q: good %d, bad %+v, want %q", line, len(good), bad, why)
		}
		for _, p := range bad {
			if strings.Contains(p.Why, fakeKey) {
				t.Errorf("the reason repeats the line")
			}
		}
	}
	// A name is unique whatever its case, and a conversation has one name.
	_, bad = parseDestinations([]string{"Alpha = demo-chat:default:oc_a", "alpha = demo-chat:default:oc_b", "beta = demo-chat:default:oc_a"})
	if len(bad) != 2 || bad[0] != (destProblem{2, wordsDestNameTwice}) || bad[1] != (destProblem{3, wordsDestConvTwice}) {
		t.Errorf("duplicates: %+v", bad)
	}
	var many []string
	for i := 0; i < destsMost+3; i++ {
		many = append(many, fmt.Sprintf("n%d = demo-chat:default:oc_%d", i, i))
	}
	good, bad = parseDestinations(many)
	if len(good) != destsMost || len(bad) != 1 || bad[0] != (destProblem{destsMost + 1, wordsDestTooMany}) {
		t.Errorf("too many: %d good, bad %+v", len(good), bad)
	}
	s := settingsOf(json.RawMessage(`{"destinations":["alpha = demo-chat:default:oc_a","nonsense"]}`), nil)
	if len(s.dests) != 1 || len(s.badDests) != 1 || s.badDests[0].Line != 2 {
		t.Errorf("settings: %+v %+v", s.dests, s.badDests)
	}
}
