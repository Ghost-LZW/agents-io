package main

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Routes: the extension's own rules, in the routes setting, one per line. The router's admin decides what reaches
// this backend; these rules decide what the extension does with it. They are tried in order on every routed item
// before its tag, and the first that matches decides. An item no rule matches is handled as before: its tag, then the
// rule-name lists.
//
// A line is "<name>: <conditions> -> <action>". Conditions are separated by spaces and must all hold; each is
// "<key>=<value>[,<value>…]" (one of the values) or "<key>!=<value>[,<value>…]" (none of them). No condition at
// all, or "*", matches every item. They read only facts the item really carries: the channel, the account, the kind
// and id of the conversation, the router's verdict on the sender, the platform's @-mentions and the channel's
// "addressed" hint, and the beginning of the text. Never anything the sender wrote about who they are.
const (
	routesMost      = 32
	routeNameMost   = 32
	routeValueMost  = 256
	routePrefixMost = 32
	routesKey       = "routes"

	// actionIgnore is the action that records an item and does nothing else: never filed, never answered.
	actionIgnore = "ignore"

	condChannel   = "channel"
	condAccount   = "account"
	condKind      = "kind"
	condConv      = "conv"
	condFrom      = "from"
	condMentions  = "mentions"
	condAddressed = "addressed"
	condPrefix    = "prefix"

	// The router's verdicts a from condition can name besides a label: the owner, anybody with a principal, nobody.
	fromOwner   = "owner"
	fromKnown   = "known"
	fromUnknown = "unknown"
)

// convKinds are the conversation kinds of the router's envelope.
var convKinds = []string{"dm", "group", "thread", "meeting", "call", "mail", "other"}

type routeCond struct {
	Key    string
	Not    bool
	Values []string
}

// routeRule is one line of the routes setting that reads. Action is inbox, chat, guest, ignore, agent or launch;
// Target is the agent target's or the launcher's name for the last two.
type routeRule struct {
	Name   string
	Conds  []routeCond
	Action string
	Target string
	Line   int // its number in the setting, as the form shows it
}

// prefixes are the values of the rule's prefix condition (none when it has none).
func (r routeRule) prefixes() []string {
	for _, c := range r.Conds {
		if c.Key == condPrefix {
			return c.Values
		}
	}
	return nil
}

// ownerOnly says whether the rule matches only items whose sender the router stamped as the owner.
func (r routeRule) ownerOnly() bool {
	for _, c := range r.Conds {
		if c.Key == condFrom && !c.Not && slices.Equal(c.Values, []string{fromOwner}) {
			return true
		}
	}
	return false
}

// parseRoutes reads the setting's lines, like parseDestinations: empty lines are skipped and the reasons never repeat
// the line's text.
func parseRoutes(lines []string) (good []routeRule, bad []destProblem) {
	names := map[string]bool{}
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		n := i + 1
		if len(good) >= routesMost {
			bad = append(bad, destProblem{n, wordsRouteTooMany})
			break
		}
		r, why := parseRoute(line)
		r.Line = n
		if why == "" && names[r.Name] {
			why = wordsRouteNameTwice
		}
		if why != "" {
			bad = append(bad, destProblem{n, why})
			continue
		}
		names[r.Name] = true
		good = append(good, r)
	}
	return good, bad
}

func parseRoute(line string) (routeRule, string) {
	if lower := strings.ToLower(line); strings.Contains(lower, keyPrefix) || strings.Contains(line, "://") {
		return routeRule{}, wordsRouteSecret
	}
	name, rest, ok := strings.Cut(line, ":")
	arrow := strings.LastIndex(rest, "->")
	if !ok || arrow < 0 {
		return routeRule{}, wordsRouteForm
	}
	r := routeRule{Name: strings.TrimSpace(name)}
	if !agentName(r.Name) {
		return routeRule{}, wordsRouteName
	}
	action := strings.TrimSpace(rest[arrow+2:])
	switch {
	case action == tagInbox || action == tagChat || action == tagGuest || action == actionIgnore:
		r.Action = action
	case strings.HasPrefix(action, tagAgentPrefix) && agentName(strings.TrimPrefix(action, tagAgentPrefix)):
		r.Action, r.Target = tagAgent, strings.TrimPrefix(action, tagAgentPrefix)
	case strings.HasPrefix(action, tagLaunchPrefix) && agentName(strings.TrimPrefix(action, tagLaunchPrefix)):
		r.Action, r.Target = tagLaunch, strings.TrimPrefix(action, tagLaunchPrefix)
	default:
		return routeRule{}, wordsRouteAction
	}
	fields := strings.Fields(rest[:arrow])
	if len(fields) == 1 && fields[0] == "*" {
		fields = nil
	}
	seen := map[string]bool{}
	for _, f := range fields {
		c, why := parseCond(f)
		if why == "" && seen[c.Key] {
			why = wordsRouteCondTwice
		}
		if why != "" {
			return routeRule{}, why
		}
		seen[c.Key] = true
		r.Conds = append(r.Conds, c)
	}
	// A rule that starts an Agent says in its own line that it is the owner's: the hard rule (launchAllowed) holds
	// whatever the line says, and the line cannot pretend otherwise.
	if r.Action == tagLaunch && !r.ownerOnly() {
		return routeRule{}, wordsRouteLaunchOwner
	}
	return r, ""
}

func parseCond(f string) (routeCond, string) {
	key, value, ok := strings.Cut(f, "=")
	if !ok {
		return routeCond{}, wordsRouteCond
	}
	c := routeCond{Key: key}
	if k, cut := strings.CutSuffix(key, "!"); cut {
		c.Key, c.Not = k, true
	}
	for _, v := range strings.Split(value, ",") {
		if v == "" || len(v) > routeValueMost || strings.ContainsFunc(v, func(r rune) bool {
			return unicode.IsControl(r) || r == utf8.RuneError
		}) {
			return routeCond{}, wordsRouteValue
		}
		c.Values = append(c.Values, v)
	}
	switch c.Key {
	case condChannel, condAccount, condConv, condMentions:
	case condFrom:
		for _, v := range c.Values {
			if utf8.RuneCountInString(v) > 40 {
				return routeCond{}, wordsRouteValue
			}
		}
	case condKind:
		for _, v := range c.Values {
			if !slices.Contains(convKinds, v) {
				return routeCond{}, wordsRouteKind
			}
		}
	case condAddressed:
		if c.Not || len(c.Values) != 1 || c.Values[0] != "yes" && c.Values[0] != "no" {
			return routeCond{}, wordsRouteAddressed
		}
	case condPrefix:
		if c.Not {
			return routeCond{}, wordsRoutePrefix
		}
		for _, v := range c.Values {
			if utf8.RuneCountInString(v) > routePrefixMost {
				return routeCond{}, wordsRoutePrefix
			}
		}
	default:
		return routeCond{}, wordsRouteKey
	}
	return c, ""
}

// routeFacts are what a route's conditions are read against: the item as the router queued it.
type routeFacts struct {
	channel, account, kind, conv string
	known                        bool
	labels                       []string
	mentions                     []string
	addressed                    bool
	content                      []contentBlock
}

func routeFactsOf(it inboundItem, rec itemRec) routeFacts {
	f := routeFacts{channel: rec.Channel, account: rec.Account, kind: rec.ConvKind, conv: rec.ConvID, known: rec.Known,
		labels: rec.SenderLabels, addressed: it.Envelope.Admission == "dispatch", content: it.Input.Content}
	if len(f.content) == 0 {
		f.content = it.Envelope.Content
	}
	for _, m := range it.Envelope.Mentions {
		if m.ID != "" {
			f.mentions = append(f.mentions, m.ID)
		}
	}
	return f
}

// route is the first rule that matches, and the item's content with the matched prefix taken out of it.
func (s settings) route(f routeFacts) (routeRule, []contentBlock, bool) {
	for _, r := range s.routes {
		if content, ok := r.match(f); ok {
			return r, content, true
		}
	}
	return routeRule{}, nil, false
}

// match says whether every condition holds. With a prefix condition it also answers the content without the prefix.
func (r routeRule) match(f routeFacts) ([]contentBlock, bool) {
	content := f.content
	for _, c := range r.Conds {
		var hit bool
		switch c.Key {
		case condChannel:
			hit = slices.Contains(c.Values, f.channel)
		case condAccount:
			hit = slices.Contains(c.Values, f.account)
		case condKind:
			hit = slices.Contains(c.Values, f.kind)
		case condConv:
			hit = slices.Contains(c.Values, f.conv)
		case condMentions:
			hit = slices.ContainsFunc(c.Values, func(v string) bool { return slices.Contains(f.mentions, v) })
		case condAddressed:
			hit = f.addressed == (c.Values[0] == "yes")
		case condFrom:
			hit = slices.ContainsFunc(c.Values, func(v string) bool {
				switch v {
				case fromOwner:
					return slices.Contains(f.labels, fromOwner)
				case fromKnown:
					return f.known
				case fromUnknown:
					return !f.known
				}
				return slices.Contains(f.labels, v)
			})
		case condPrefix:
			var stripped []contentBlock
			for _, p := range c.Values {
				if stripped, hit = stripPrefix(f.content, p); hit {
					break
				}
			}
			if hit {
				content = stripped
			}
		}
		if hit == c.Not {
			return nil, false
		}
	}
	return content, true
}

// stripPrefix looks for p at the start of the message's own words: its first text block that is not empty (a quote or
// a picture before it does not count), after leading spaces, compared without case. A prefix that ends in a letter or
// a digit must not run on into another one ("/ai" is not the start of "/aim", and is of "/ai修一下"). It answers the
// content with the prefix and the spaces after it taken out; a text block left empty is dropped.
func stripPrefix(content []contentBlock, p string) ([]contentBlock, bool) {
	for i, b := range content {
		if b.Type != "text" || strings.TrimSpace(b.Text) == "" {
			continue
		}
		rest, ok := cutFold(strings.TrimLeftFunc(b.Text, unicode.IsSpace), p)
		if !ok {
			return nil, false
		}
		last, _ := utf8.DecodeLastRuneInString(p)
		next, _ := utf8.DecodeRuneInString(rest)
		if rest != "" && asciiWord(last) && asciiWord(next) {
			return nil, false
		}
		out := slices.Clone(content)
		if rest = strings.TrimLeftFunc(rest, unicode.IsSpace); rest == "" {
			out = slices.Delete(out, i, i+1)
		} else {
			out[i].Text = rest
		}
		return out, true
	}
	return nil, false
}

// cutFold is text after p when text starts with p, compared a character at a time without case.
func cutFold(text, p string) (string, bool) {
	for _, pr := range p {
		tr, size := utf8.DecodeRuneInString(text)
		if size == 0 || tr != pr && !strings.EqualFold(string(tr), string(pr)) {
			return "", false
		}
		text = text[size:]
	}
	return text, true
}

func asciiWord(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
}

// checkRouteTargets is why a rule that reads cannot be saved: its action names an agent target or a launcher the
// settings do not have. A configuration saved without the check keeps such a rule; an item it matches goes to the
// Inbox with the reason, as an item whose tag names a target the settings do not have.
func (s settings) checkRouteTargets() (int, string) {
	for _, r := range s.routes {
		switch {
		case r.Action == tagAgent:
			if _, ok := s.agentTarget(r.Target); !ok {
				return r.Line, wordsRouteNoAgent
			}
		case r.Action == tagLaunch:
			if _, ok := s.launcher(r.Target); !ok {
				return r.Line, wordsRouteNoLauncher
			}
		}
	}
	return 0, ""
}
