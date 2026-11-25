package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"unicode/utf8"
)

// What Persona's public documents ask of an extension whose connector has an Inbox (docs/extensions/extensions.md,
// "General rules for the Inbox"; docs/protocol/connector-protocol.md, "InboxThing"), as checks the tests run on the
// manifest and on what connector.inbox.collect answers:
//
//   - the settings have a top-level triage_rules, a string, or the hub refuses to install the extension;
//   - "fallback" is declared only by a connector that declares "inbox";
//   - every thing carries the owner's rules as "rules" when some are set, none otherwise, never more than the hub uses;
//   - a connector with a fallback gives every thing that is not a batch to group a tier the hub knows, in
//     extra.rule_tier or in tier.

// triageRulesIn reads the rules out of a configuration object, as settingsOf does.
func triageRulesIn(config json.RawMessage) string {
	return settingsOf(config, nil).triageRules
}

// checkInboxManifest holds a manifest to the rules above and answers the capabilities of each connector with an Inbox.
func checkInboxManifest(manifest []byte) (map[string][]string, error) {
	var m struct {
		Contributes struct {
			Connectors []struct {
				ID           string   `json:"id"`
				Capabilities []string `json:"capabilities"`
			} `json:"connectors"`
		} `json:"contributes"`
		Configuration struct {
			Properties map[string]struct {
				Type string `json:"type"`
			} `json:"properties"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(manifest, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	var problems []error
	withInbox := map[string][]string{}
	for _, c := range m.Contributes.Connectors {
		switch {
		case slices.Contains(c.Capabilities, "inbox"):
			withInbox[c.ID] = c.Capabilities
		case slices.Contains(c.Capabilities, "fallback"):
			problems = append(problems, fmt.Errorf("connector %s: fallback goes with an inbox", c.ID))
		}
	}
	if len(withInbox) > 0 && m.Configuration.Properties[triageRulesSetting].Type != "string" {
		problems = append(problems, fmt.Errorf("a connector has an inbox: the settings need %s, a string", triageRulesSetting))
	}
	return withInbox, errors.Join(problems...)
}

// checkThings holds collect's things (a JSON array) to the rules above: rules are the rules set ("" for none), and
// fallback says whether the connector declares one.
func checkThings(things []byte, rules string, fallback bool) error {
	var list []struct {
		Thread string          `json:"thread"`
		Rules  string          `json:"rules"`
		Tier   inboxTier       `json:"tier"`
		Group  json.RawMessage `json:"group"`
		Extra  struct {
			RuleTier *inboxTier `json:"rule_tier"`
		} `json:"extra"`
	}
	if err := json.Unmarshal(things, &list); err != nil {
		return fmt.Errorf("things: %w", err)
	}
	var problems []error
	for i, th := range list {
		bad := func(format string, args ...any) {
			problems = append(problems, fmt.Errorf("thing %d (%s): %s", i, th.Thread, fmt.Sprintf(format, args...)))
		}
		if th.Rules != rules {
			bad("rules %q, want %q", th.Rules, rules)
		}
		if utf8.RuneCountInString(th.Rules) > triageRulesLimit {
			bad("rules longer than %d characters", triageRulesLimit)
		}
		if !fallback || len(th.Group) > 0 && string(th.Group) != "null" {
			continue
		}
		switch own := th.Extra.RuleTier; {
		case own != nil && !own.known():
			bad("extra.rule_tier %q is not a tier", *own)
		case own == nil && !th.Tier.known():
			bad("neither extra.rule_tier nor tier, with a fallback declared")
		}
	}
	return errors.Join(problems...)
}
