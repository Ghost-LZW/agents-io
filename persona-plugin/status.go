package main

import (
	"fmt"
	"slices"

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
	case phaseNotBackend, phaseNoBackends:
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
	switch {
	case corrupt:
		out.Via = wordsStoreCorrupt
	case unreadable > 0:
		out.Via = fmt.Sprintf(wordsUnreadableVia, unreadable)
	}
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
