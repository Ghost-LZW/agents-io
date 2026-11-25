package main

import (
	"strings"
	"time"
)

// The Inbox side of Persona's connector protocol, as this extension uses it. Written from the public protocol
// documents (Persona's docs/protocol/connector-protocol.md, "InboxThing", and docs/extensions/extensions.md,
// "Conventional settings" and "General rules for the Inbox"). The SDK's own wire.ConnectorInboxThing has a closed
// extra block, and this extension carries its own facts there, so the thing is declared here.

// inboxTier is one of the Inbox's three tiers.
type inboxTier string

const (
	tierAction inboxTier = "action"
	tierFYI    inboxTier = "fyi"
	tierNoise  inboxTier = "noise"
)

// known says whether the hub has such a tier.
func (t inboxTier) known() bool { return t == tierAction || t == tierFYI || t == tierNoise }

// thing is one entry of connector.inbox.collect's answer: a channel conversation that may need the owner.
type thing struct {
	// Thread is the stable key of the conversation, Kind one of the manifest's kinds, Label the source's short name.
	Thread string `json:"thread"`
	Kind   string `json:"kind"`
	Label  string `json:"label,omitempty"`
	Title  string `json:"title,omitempty"`
	// Sender made the newest step, Preview is that step in a line, Context the conversation as text.
	Sender  string `json:"sender,omitempty"`
	Preview string `json:"preview,omitempty"`
	Context string `json:"context,omitempty"`
	// At is when the newest step happened; a different Last tells the hub there is new activity.
	At   time.Time `json:"at"`
	Last string    `json:"last,omitempty"`
	URL  string    `json:"url,omitempty"`
	// ReplyTo names where a reply goes; CanReply says connector.inbox.reply works for the thread.
	ReplyTo  string `json:"reply_to,omitempty"`
	CanReply bool   `json:"can_reply,omitempty"`
	// Why is the reason shown with the tier.
	Why string `json:"why,omitempty"`
	// Rules are the owner's own triage rules for this source; when set the hub sorts by them alone.
	Rules string `json:"rules,omitempty"`
	// Done ends the hub's open item ("replied").
	Done string `json:"done,omitempty"`
	// Tags say what the thing is about, for muting and rules.
	Tags  []thingTag `json:"tags,omitempty"`
	Extra *extra     `json:"extra,omitempty"`
}

// thingTag is one subject of a thing: Key (chat, sender), the Value it is matched by, the Name people read.
type thingTag struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	Name  string `json:"name,omitempty"`
}

// extra is a thing's extra block: the fallback tier a connector with the capability "fallback" promises on every
// thing, beside the extension's own facts.
type extra struct {
	RuleTier inboxTier `json:"rule_tier,omitempty"`
	Agentsio *facts    `json:"agentsio,omitempty"`
}

const (
	// triageRulesSetting is the conventional setting that holds the owner's triage rules.
	triageRulesSetting = "triage_rules"
	// triageRulesLimit is how many characters of the rules the hub uses.
	triageRulesLimit = 4000
)

// triageRulesOf makes the setting's value the rules a thing carries. The apps' settings field is a single line, so
// the setting's description asks for a written-out \n where a line should break; the result is cut to what the hub
// uses and is "" when nothing is set.
func triageRulesOf(setting string) string {
	rules := strings.TrimSpace(strings.ReplaceAll(setting, `\n`, "\n"))
	if runes := []rune(rules); len(runes) > triageRulesLimit {
		rules = strings.TrimSpace(string(runes[:triageRulesLimit]))
	}
	return rules
}
