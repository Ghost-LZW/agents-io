package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

// hubScopes are the hub scopes the chat round trip needs (permissions.hub in the manifest).
var hubScopes = []string{"agents.control", "agents.read", "assistant.ask"}

func notConfigured(why string) wire.ConnectorStatus {
	return wire.ConnectorStatus{State: wire.ConnectorStateNotConfigured, Error: why, Guide: setupGuide}
}

// statusNow is the connector's status, from memory: the hub asks often.
func (x *app) statusNow() wire.ConnectorStatus {
	x.mu.Lock()
	off, missing, storeErr, st, rt, unreadable := x.off, x.missing, x.storeErr, x.st, x.rt, x.unreadable
	badDests, agents, badAgents := len(x.set.badDests), len(x.set.agents), len(x.set.badAgents)
	routes, badRoutes := x.set.routes, len(x.set.badRoutes)
	launchers, badLaunchers := len(x.set.launchers), len(x.set.badLaunchers)
	agentMiss := 0
	for _, a := range x.set.agents {
		if x.agentMiss[a.Name] {
			agentMiss++
		}
	}
	lacking := slices.Clone(x.lacking)
	hubOK := x.api != nil
	x.mu.Unlock()
	switch {
	case off:
		return wire.ConnectorStatus{State: wire.ConnectorStateNotConfigured, Error: wordsOff}
	case missing != "":
		return notConfigured(missing)
	case storeErr || st == nil || rt == nil:
		return wire.ConnectorStatus{State: wire.ConnectorStateError, Error: wordsStoreBroken}
	}
	s := rt.state()
	corrupt, broken := st.health()
	switch s.phase {
	case phaseOK:
	case phaseKeyRefused:
		return wire.ConnectorStatus{State: wire.ConnectorStateNotSignedIn, Error: wordsKeyRefused, Guide: setupGuide}
	case phaseNotBackend, phaseReadKey, phaseNoBackends:
		return wire.ConnectorStatus{State: wire.ConnectorStateError, Error: wordsOfPhase(s.phase), Guide: setupGuide}
	default:
		words := wordsOfPhase(s.phase)
		if s.flapping {
			words = wordsFlapping
		} else if s.phase == phaseLost || s.phase == phaseUnreachable {
			words += "（从 " + s.since.UTC().Format("01-02 15:04") + " UTC 起）"
		}
		return wire.ConnectorStatus{State: wire.ConnectorStateError, Error: words, LastSync: s.connectedAt}
	}
	if broken != nil {
		return wire.ConnectorStatus{State: wire.ConnectorStateError, Error: wordsStoreBroken}
	}
	if !hubOK || len(lacking) > 0 {
		return wire.ConnectorStatus{State: wire.ConnectorStateNoPermission, Error: wordsHubMissing, MissingScopes: lacking,
			Account: "backend:" + s.backend, LastSync: s.connectedAt}
	}
	out := wire.ConnectorStatus{State: wire.ConnectorStateOk, Account: "backend:" + s.backend, LastSync: s.connectedAt,
		LastEvent: s.lastItem}
	// Via is everything worth knowing while the state is fine, a clause each.
	var notes []string
	switch {
	case corrupt:
		notes = append(notes, wordsStoreCorrupt)
	case unreadable > 0:
		notes = append(notes, fmt.Sprintf(wordsUnreadableVia, unreadable))
	}
	if badDests > 0 {
		notes = append(notes, fmt.Sprintf(wordsBadDestsVia, badDests))
	}
	if badAgents > 0 {
		notes = append(notes, fmt.Sprintf(wordsBadAgentsVia, badAgents))
	}
	// The targets, and how many of their sessions were not there when a message was last meant for them.
	switch {
	case agentMiss > 0:
		notes = append(notes, fmt.Sprintf(wordsAgentsMissVia, agents, agentMiss))
	case agents > 0:
		notes = append(notes, fmt.Sprintf(wordsAgentsVia, agents))
	}
	if badLaunchers > 0 {
		notes = append(notes, fmt.Sprintf(wordsBadLaunchersVia, badLaunchers))
	}
	if launchers > 0 {
		notes = append(notes, fmt.Sprintf(wordsLaunchersVia, launchers))
	}
	// The routes, and how many items each decided in the last day, in their order.
	if badRoutes > 0 {
		notes = append(notes, fmt.Sprintf(wordsBadRoutesVia, badRoutes))
	}
	if len(routes) > 0 {
		counts := st.matchCounts(time.Now().Add(-24 * time.Hour))
		parts := make([]string, 0, len(routes))
		for _, r := range routes {
			parts = append(parts, fmt.Sprintf("%s %d", r.Name, counts[r.Name]))
		}
		notes = append(notes, fmt.Sprintf(wordsRoutesVia, len(routes), strings.Join(parts, "、")))
	}
	var sent, notSent, unsure int
	for _, r := range st.sendsSince(time.Now().Add(-24 * time.Hour)) {
		switch r.Outcome {
		case sendDelivered:
			sent++
		case sendRefused:
			notSent++
		default:
			unsure++
		}
	}
	if sent+notSent+unsure > 0 {
		notes = append(notes, fmt.Sprintf(wordsSendsVia, sent, notSent, unsure))
	}
	if len(notes) > 1 {
		for i := range notes {
			notes[i] = strings.TrimSuffix(notes[i], "。")
		}
	}
	out.Via = strings.Join(notes, "；")
	return out
}

// lackingScopes are the scopes of hubScopes the hub did not grant. A hub that lists no scopes at all (an older one)
// with a token is taken as granting them.
func lackingScopes(token string, granted []string) []string {
	if token == "" {
		return slices.Clone(hubScopes)
	}
	if len(granted) == 0 {
		return nil
	}
	var lack []string
	for _, s := range hubScopes {
		if !slices.Contains(granted, s) {
			lack = append(lack, s)
		}
	}
	return lack
}
