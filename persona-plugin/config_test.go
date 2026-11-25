package main

import (
	"encoding/json"
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
		if got, source := s.tagFor(tc.tag, tc.rule); got != tc.want || source != tc.source {
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
