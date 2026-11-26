package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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
	// tagAgent is the tag of an item routed straight to a named Agent session: the router writes "agent:<name>".
	tagAgent       = "agent"
	tagAgentPrefix = tagAgent + ":"

	// tagSourceUnreadable marks the placeholder of an item that could not be read (intakeUnreadable).
	tagSourceUnreadable = "unreadable"
	// tagSourceUnknownAgent marks an item tagged "agent:<name>" whose name is malformed or not in the settings.
	tagSourceUnknownAgent = "unknown_agent"
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
	// dests are the named destinations that read well; badDests are the lines that do not (settings.check refuses
	// them, a start with them skips them and the status counts them).
	dests    []destination
	badDests []destProblem
	// agents are the named Agent sessions an "agent:<name>" item is typed into; badAgents are the lines that do not
	// read (treated like badDests).
	agents    []agentTarget
	badAgents []destProblem
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
		Dests       []string `json:"destinations"`
		Agents      []string `json:"agent_targets"`
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
	s.dests, s.badDests = parseDestinations(c.Dests)
	s.agents, s.badAgents = parseAgentTargets(c.Agents)
	return s
}

// Agent targets: Agent sessions on a paired computer that a router rule may route a message straight into, with the
// tag "agent:<name>". One line each, "<name> = <machine id>/<session id>". The name is what the router's admin
// writes in the tag, so its alphabet is small; the ids are the hub's and are only ever compared and put in a path.
const (
	agentTargetsMost = 32
	agentNameMost    = 32
	agentPartMost    = 128
	agentTargetsKey  = "agent_targets"
)

type agentTarget struct{ Name, MachineID, SessionID string }

// agentKey is the key an agent target's transcript bookkeeping is kept under in the conversation mapping. A channel
// conversation's key always has colons and a target name never does, so the two cannot meet.
func agentKey(name string) string { return tagAgent + "/" + name }

// agentLane is what serializes runs into one Agent session, whatever channel conversation they come from.
func (a agentTarget) lane() string { return "session/" + a.MachineID + "/" + a.SessionID }

// agentName says whether s is a target name: lowercase letters, digits, "-" and "_", 1 to agentNameMost characters.
func agentName(s string) bool {
	if s == "" || len(s) > agentNameMost {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// agentTarget is the target of that name.
func (s settings) agentTarget(name string) (agentTarget, bool) {
	for _, a := range s.agents {
		if a.Name == name {
			return a, true
		}
	}
	return agentTarget{}, false
}

// parseAgentTargets reads the setting's lines, like parseDestinations: empty lines are skipped and the reasons
// never repeat the line's text.
func parseAgentTargets(lines []string) (good []agentTarget, bad []destProblem) {
	names, sessions := map[string]bool{}, map[string]bool{}
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		n := i + 1
		if len(good) >= agentTargetsMost {
			bad = append(bad, destProblem{n, wordsAgentTooMany})
			break
		}
		a, why := parseAgentTarget(line)
		switch {
		case why != "":
		case names[a.Name]:
			why = wordsAgentNameTwice
		case sessions[a.lane()]:
			why = wordsAgentSessionTwice
		}
		if why != "" {
			bad = append(bad, destProblem{n, why})
			continue
		}
		names[a.Name], sessions[a.lane()] = true, true
		good = append(good, a)
	}
	return good, bad
}

func parseAgentTarget(line string) (agentTarget, string) {
	if lower := strings.ToLower(line); strings.Contains(lower, keyPrefix) || strings.Contains(line, "://") {
		return agentTarget{}, wordsAgentSecret
	}
	name, rest, ok := strings.Cut(line, "=")
	if !ok {
		return agentTarget{}, wordsAgentForm
	}
	mid, sid, ok := strings.Cut(strings.TrimSpace(rest), "/")
	if !ok {
		return agentTarget{}, wordsAgentForm
	}
	a := agentTarget{Name: strings.TrimSpace(name), MachineID: strings.TrimSpace(mid), SessionID: strings.TrimSpace(sid)}
	// An id is put into a request path as one segment: no slash, no space, no control character, and not a segment
	// a path would resolve away.
	part := func(s string) bool {
		return len(s) <= agentPartMost && s != "." && s != ".." && !strings.ContainsFunc(s, func(r rune) bool {
			return unicode.IsControl(r) || unicode.IsSpace(r) || r == utf8.RuneError || r == '/' || r == '\\' || r == '?' || r == '#' || r == '%'
		})
	}
	switch {
	case a.Name == "" || a.MachineID == "" || a.SessionID == "":
		return agentTarget{}, wordsAgentForm
	case !agentName(a.Name):
		return agentTarget{}, wordsAgentName
	case !part(a.MachineID) || !part(a.SessionID):
		return agentTarget{}, wordsAgentPart
	}
	return a, ""
}

// Named destinations: places the assistant may send to before the router ever routed a message from them. One line
// each, "<name> = <channel>:<account>:<conversation id>". They name a conversation and nothing else: the router's
// admin decides whether this backend may send there (backends.<id>.routes), and no line may carry a key or an address.
const (
	destsMost       = 32
	destNameMost    = 40
	destPartMost    = 64
	destConvMost    = 256
	destinationsKey = "destinations"
)

type destination struct{ Name, Channel, Account, ConvID string }

func (d destination) key() string { return destKey(d.Channel, d.Account, d.ConvID) }
func (d destination) id() string  { return destID(d.Channel, d.Account, d.ConvID) }

// destKey is a conversation as the router's send scope sees it: channel, account and conversation, no thread.
func destKey(channel, account, conv string) string { return channel + ":" + account + ":" + conv }

// destID is the id the assistant names a destination by. It says nothing about the coordinates and changes when
// they do, so a name that now points elsewhere is a new id.
func destID(channel, account, conv string) string {
	return "d-" + short("dest|" + channel + "|" + account + "|" + conv)[:12]
}

// destProblem is one line of the setting that cannot be read: its number as the form shows it, and why.
type destProblem struct {
	Line int
	Why  string
}

// parseDestinations reads the setting's lines. Empty lines are skipped. The reasons never repeat the line's text.
func parseDestinations(lines []string) (good []destination, bad []destProblem) {
	names, keys := map[string]bool{}, map[string]bool{}
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		n := i + 1
		if len(good) >= destsMost {
			bad = append(bad, destProblem{n, wordsDestTooMany})
			break
		}
		d, why := parseDestination(line)
		switch {
		case why != "":
		case names[strings.ToLower(d.Name)]:
			why = wordsDestNameTwice
		case keys[d.key()]:
			why = wordsDestConvTwice
		}
		if why != "" {
			bad = append(bad, destProblem{n, why})
			continue
		}
		names[strings.ToLower(d.Name)], keys[d.key()] = true, true
		good = append(good, d)
	}
	return good, bad
}

func parseDestination(line string) (destination, string) {
	if lower := strings.ToLower(line); strings.Contains(lower, keyPrefix) || strings.Contains(line, "://") {
		return destination{}, wordsDestSecret
	}
	name, rest, ok := strings.Cut(line, "=")
	if !ok {
		return destination{}, wordsDestForm
	}
	parts := strings.SplitN(strings.TrimSpace(rest), ":", 3)
	if len(parts) != 3 {
		return destination{}, wordsDestForm
	}
	d := destination{Name: strings.TrimSpace(name), Channel: strings.TrimSpace(parts[0]), Account: strings.TrimSpace(parts[1]),
		ConvID: strings.TrimSpace(parts[2])}
	plain := func(s string, spaces bool) bool {
		return !strings.ContainsFunc(s, func(r rune) bool {
			return unicode.IsControl(r) || r == utf8.RuneError || (!spaces && unicode.IsSpace(r))
		})
	}
	switch {
	case d.Name == "" || d.Channel == "" || d.Account == "" || d.ConvID == "":
		return destination{}, wordsDestForm
	case utf8.RuneCountInString(d.Name) > destNameMost || !plain(d.Name, true):
		return destination{}, wordsDestName
	case len(d.Channel) > destPartMost || len(d.Account) > destPartMost || !plain(d.Channel, false) || !plain(d.Account, false):
		return destination{}, wordsDestPart
	case len(d.ConvID) > destConvMost || !plain(d.ConvID, false):
		return destination{}, wordsDestConv
	}
	return d, ""
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
//
// "agent:<name>" is the tag agent with the target of that name, when the settings have one. A name that is malformed
// or not in the settings is the Inbox, with a source of its own so the item says why; "agent" alone names nothing and
// is an unknown tag. No rule list stands in for an agent tag: only the router's rule can name a target.
func (s settings) tagFor(itemTag, ruleID string) (tag, target, source string) {
	if name, ok := strings.CutPrefix(itemTag, tagAgentPrefix); ok {
		if _, known := s.agentTarget(name); known && agentName(name) {
			return tagAgent, name, "tag"
		}
		return tagInbox, "", tagSourceUnknownAgent
	}
	switch itemTag {
	case tagInbox, tagChat, tagGuest:
		return itemTag, "", "tag"
	case "":
	default:
		return tagInbox, "", "unknown_tag"
	}
	if ruleID != "" {
		if slices.Contains(s.chatRules, ruleID) {
			return tagChat, "", "rule"
		}
		if slices.Contains(s.guestRules, ruleID) {
			return tagGuest, "", "rule"
		}
	}
	return tagInbox, "", "default"
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
	// The destinations and the agent targets first, whatever else is filled in: they need no connection to be read.
	if len(s.badDests) > 0 {
		p := s.badDests[0]
		return fmt.Sprintf(wordsDestLine, p.Line, p.Why), destinationsKey
	}
	if len(s.badAgents) > 0 {
		p := s.badAgents[0]
		return fmt.Sprintf(wordsAgentLine, p.Line, p.Why), agentTargetsKey
	}
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
