package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/nwverse/persona/sdk/go/ext"
	"github.com/nwverse/persona/sdk/go/wire"
)

const (
	keyPrefix = "aiob_"
	// settingsCheckFor stays under the hub's 10 s wait for settings.check.
	settingsCheckFor = 8 * time.Second
	// sandboxLoopback is the hub machine's loopback as a sandboxed extension reaches it through the hub's egress proxy.
	sandboxLoopback = "host.persona.internal"

	tagInbox = "inbox"
	tagChat  = "chat"
	tagGuest = "guest"

	// tagSourceUnreadable marks the placeholder of an item that could not be read (intakeUnreadable).
	tagSourceUnreadable = "unreadable"
)

// settings are the extension's settings and secret as initialize and settings.check give them.
type settings struct {
	routerURL   string
	key         string
	chatRules   []string
	guestRules  []string
	workingMark bool
	chatWait    time.Duration
	keep        time.Duration
	triageRules string
}

func settingsOf(config json.RawMessage, secrets map[string]string) settings {
	c := struct {
		RouterURL   string   `json:"router_url"`
		ChatRules   []string `json:"chat_rules"`
		GuestRules  []string `json:"guest_rules"`
		WorkingMark *bool    `json:"working_mark"`
		ChatWait    *int     `json:"chat_wait_minutes"`
		KeepDays    *int     `json:"keep_days"`
		TriageRules string   `json:"triage_rules"`
	}{}
	if len(config) > 0 {
		_ = json.Unmarshal(config, &c)
	}
	s := settings{
		routerURL:   strings.TrimSpace(c.RouterURL),
		key:         strings.TrimSpace(secrets["backend_key"]),
		chatRules:   trimmed(c.ChatRules),
		guestRules:  trimmed(c.GuestRules),
		workingMark: c.WorkingMark == nil || *c.WorkingMark,
		chatWait:    time.Duration(clamp(c.ChatWait, 240, 5, 480)) * time.Minute,
		keep:        time.Duration(clamp(c.KeepDays, 30, 7, 90)) * 24 * time.Hour,
		triageRules: triageRulesOf(c.TriageRules),
	}
	return s
}

func trimmed(in []string) []string {
	var out []string
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

func clamp(v *int, def, low, high int) int {
	if v == nil {
		return def
	}
	return min(max(*v, low), high)
}

// missing is the sentence for settings that cannot connect yet, "" when the address and the key are there.
func (s settings) missing() string {
	switch {
	case s.routerURL == "" && s.key == "":
		return wordsNotConfigured
	case s.routerURL == "":
		return wordsNoAddress
	case s.key == "":
		return wordsNoKey
	}
	if _, err := s.wsURL(os.Getenv); err != nil {
		return err.Error()
	}
	return ""
}

// wsURL is the WebSocket address of the router console for the address in the settings: http becomes ws, https
// becomes wss, and an address without a path gets the console's /ws. The setting is an http(s) address because the
// hub's network permission (config:router_url) accepts only those; ws:// and wss:// typed by hand work too. In the
// hub's sandbox an http loopback address is dialed as host.persona.internal: Go never proxies loopback, and the
// sandbox's own loopback is empty.
func (s settings) wsURL(getenv func(string) string) (string, error) {
	u, err := url.Parse(s.routerURL)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return "", errors.New(wordsAddressForm)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return "", errors.New(wordsAddressForm)
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", errors.New(wordsAddressSecrets)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/ws"
	}
	if u.Scheme == "ws" && loopback(u.Hostname()) && (getenv("HTTP_PROXY") != "" || getenv("http_proxy") != "") {
		host := sandboxLoopback
		if port := u.Port(); port != "" {
			host = net.JoinHostPort(sandboxLoopback, port)
		}
		u.Host = host
	}
	return u.String(), nil
}

func loopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// tagFor decides what is done with an item. A tag on the item always decides: one of the three this extension knows
// is followed, any other is the Inbox (a rule whose tag was changed to something new must never keep sending its
// messages into an owner's conversation because its name is still in a list). Only an item without a tag is looked
// up in the rule-name lists of the settings; a rule in neither is the Inbox. source says which of them decided.
func (s settings) tagFor(itemTag, ruleID string) (tag, source string) {
	switch itemTag {
	case tagInbox, tagChat, tagGuest:
		return itemTag, "tag"
	case "":
	default:
		return tagInbox, "unknown_tag"
	}
	if ruleID != "" {
		if slices.Contains(s.chatRules, ruleID) {
			return tagChat, "rule"
		}
		if slices.Contains(s.guestRules, ruleID) {
			return tagGuest, "rule"
		}
	}
	return tagInbox, "default"
}

// settingsHandler answers settings.check: the address and key about to be saved work, before the hub saves them. The
// answer's words are for people and never carry the key; the log has only the kind of failure.
func (x *app) settingsHandler(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if method != "check" {
		return nil, ext.UnknownMethod("settings." + method)
	}
	var in wire.SettingsCheckParams
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, &ext.Error{Message: "params: " + err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, settingsCheckFor)
	defer cancel()
	if why, kind := x.checkSettings(ctx, settingsOf(in.Config, in.Secrets), in); why != "" {
		log.Printf("settings: refused (%s)", kind)
		return wire.SettingsCheckResult{Ok: false, Error: why}, nil
	}
	return wire.SettingsCheckResult{Ok: true}, nil
}

// checkSettings is why the settings cannot be saved and the kind of it for the log, "" when they can. Saving only
// part of them (the address before the key) is fine; what is filled in must work. A key without the usual prefix is
// not refused on its form: the handshake decides.
func (x *app) checkSettings(ctx context.Context, s settings, params wire.SettingsCheckParams) (string, string) {
	if s.routerURL == "" {
		return "", ""
	}
	// With the check's own proxy, loopback is proxied too and the address is dialed as written; without one (an older
	// hub) the check goes out like any other request of the program.
	getenv := os.Getenv
	if params.Proxy != "" {
		getenv = func(string) string { return "" }
	}
	ws, err := s.wsURL(getenv)
	if err != nil {
		return err.Error(), "address"
	}
	if s.key == "" {
		return "", ""
	}
	r := newRouter(ws, s.key, ext.SettingsCheckClient(params), x.tm)
	if _, err := r.probe(ctx); err != nil {
		ph := phaseOf(err)
		return wordsOfPhase(ph), ph
	}
	return "", ""
}
