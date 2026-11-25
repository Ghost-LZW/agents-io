package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

// Where the assistant may send a message on its own initiative. A destination is a channel conversation (channel,
// account, conversation: the grain of the router's send scope), from one of two places: a conversation the router
// routed a message from (the store's places), or one the owner named in the settings. The assistant only ever sees
// and names a destination by its id; the coordinates never leave this program, and a model cannot type them.

const (
	// destsListMost bounds the list: the named ones, then the conversations seen most recently.
	destsListMost   = 100
	recentSendsMost = 10

	sourceSeen  = "seen"
	sourceNamed = "named"
	sourceBoth  = "seen+named"
)

// dest is one destination as the program knows it.
type dest struct {
	ID, Source, Name         string
	Channel, Account, ConvID string
	Kind                     string
	// Label is the conversation's own name: a chat's name, and for a direct message without one the display name of
	// the person in it. A group is never labeled by who spoke there last: that is LastFrom, a person and not the
	// place. Verdict is the router's verdict on the last person who wrote there (for a direct message labeled by
	// its person: on that person), since a display name is whatever its owner typed.
	Label, LastFrom, Verdict string
	LastRef                  string
	LastSeen                 time.Time
	// Twins counts the other destinations of the same channel that go by one of this one's names.
	Twins int
}

func (d dest) key() string { return destKey(d.Channel, d.Account, d.ConvID) }

// words is what a destination is called in a record and on the phone's card: the owner's name for it, and the
// conversation's own when it has one. One without either is said to have no name, by its kind.
func (d dest) words() string {
	name, label := fieldSafe(oneLine(d.Name, destNameMost)), fieldSafe(d.Label)
	switch {
	case name != "" && label != "" && name != label:
		return name + "（" + label + "）"
	case name != "":
		return name
	case label != "":
		return label
	}
	if kind := kindWords[d.Kind]; kind != "" {
		return fmt.Sprintf(sendNoLabelKind, kind)
	}
	return sendNoLabel
}

// names are what a destination can be meant by: its words, the owner's name for it, its own name.
func (d dest) names() []string {
	var out []string
	for _, n := range []string{d.words(), fieldSafe(oneLine(d.Name, destNameMost)), fieldSafe(d.Label)} {
		if n = strings.ToLower(n); n != "" && !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out
}

// where is the channel and the kind of conversation, in words.
func (d dest) where() string {
	out := fieldSafe(oneLine(d.Channel, 40))
	if kind := kindWords[d.Kind]; kind != "" {
		out += " " + kind
	}
	return out
}

// dests are the destinations: the named ones first, in the settings' order, then the conversations seen, newest
// first. A conversation that is both is one entry.
func (x *app) dests() []dest {
	set, st := x.settings(), x.store()
	var out []dest
	at := map[string]int{}
	for _, d := range set.dests {
		at[d.key()] = len(out)
		out = append(out, dest{ID: d.id(), Source: sourceNamed, Name: d.Name, Channel: d.Channel, Account: d.Account, ConvID: d.ConvID})
	}
	if st == nil {
		return out
	}
	places := st.placesAll()
	sort.Slice(places, func(i, j int) bool {
		if !places[i].LastSeen.Equal(places[j].LastSeen) {
			return places[i].LastSeen.After(places[j].LastSeen)
		}
		return destKey(places[i].Channel, places[i].Account, places[i].ConvID) < destKey(places[j].Channel, places[j].Account, places[j].ConvID)
	})
	for _, p := range places {
		d := dest{ID: destID(p.Channel, p.Account, p.ConvID), Source: sourceSeen, Channel: p.Channel, Account: p.Account,
			ConvID: p.ConvID, Kind: p.Kind, Label: p.ChatName, LastFrom: p.Sender, Verdict: p.Verdict, LastSeen: p.LastSeen}
		if d.Label == "" && d.Kind == "dm" {
			d.Label, d.LastFrom = p.Sender, ""
		}
		if p.Sender == "" {
			d.Verdict = ""
		} else if d.Verdict == "" {
			d.Verdict = verdictNone // a record from before verdicts were kept
		}
		// The newest message is offered as a reply target only while the journal still has it.
		if rec, ok := st.get(p.LastItem); ok && rec.Route != nil && rec.MessageID != "" {
			d.LastRef = refToken(rec)
		}
		if i, named := at[d.key()]; named {
			d.Source, d.Name = sourceBoth, out[i].Name
			out[i] = d
			continue
		}
		if len(out) < destsListMost {
			out = append(out, d)
		}
	}
	// Destinations of one channel that share a name are marked: a name alone does not say which one is meant.
	byName := map[string][]int{}
	for i, d := range out {
		for _, n := range d.names() {
			k := strings.ToLower(d.Channel) + "\x00" + n
			byName[k] = append(byName[k], i)
		}
	}
	for i, d := range out {
		var twins []int
		for _, n := range d.names() {
			for _, j := range byName[strings.ToLower(d.Channel)+"\x00"+n] {
				if j != i && !slices.Contains(twins, j) {
					twins = append(twins, j)
				}
			}
		}
		out[i].Twins = len(twins)
	}
	return out
}

func (x *app) destByID(id string) (dest, bool) {
	id = strings.TrimSpace(id)
	for _, d := range x.dests() {
		if d.ID == id && id != "" {
			return d, true
		}
	}
	return dest{}, false
}

// refOf reads a message reference as the assistant writes it: the sender line's "ref=<16 hex>", or the hex alone.
func refOf(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "ref=")
	if len(s) != 16 || strings.Trim(s, "0123456789abcdef") != "" {
		return ""
	}
	return s
}

// replyTarget is the item a reply names: one this program received in the destination's conversation, with a
// message id and a reply route (what the router accepts as a reply target).
func (x *app) replyTarget(d dest, ref string) (itemRec, bool) {
	st := x.store()
	if ref = refOf(ref); ref == "" || st == nil {
		return itemRec{}, false
	}
	for _, rec := range st.all() {
		r := rec.Route
		if r == nil || rec.MessageID == "" || destKey(r.Channel, r.Account, r.ConversationID) != d.key() {
			continue
		}
		if short(rec.ID)[:16] == ref {
			return rec, true
		}
	}
	return itemRec{}, false
}

var destinationsTool = wire.ConnectorTool{Name: toolDestinationsName, Description: toolDestinationsDesc,
	InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)}

// destinationsText is the read tool's answer. No account, no conversation id, no message text: ids, names and times.
// Names other people chose (a chat's name, a display name) are stripped as in the sender line, and come with the
// router's verdict on the person, which nobody but the router wrote.
func (x *app) destinationsText() string {
	type destOut struct {
		ID       string `json:"id"`
		Source   string `json:"source"`
		Name     string `json:"name,omitempty"`
		Channel  string `json:"channel"`
		Kind     string `json:"kind,omitempty"`
		Label    string `json:"label,omitempty"`
		LastFrom string `json:"last_from,omitempty"`
		Verdict  string `json:"sender_verdict,omitempty"`
		Same     bool   `json:"same_label,omitempty"`
		LastSeen string `json:"last_seen,omitempty"`
		LastRef  string `json:"last_ref,omitempty"`
		Note     string `json:"note,omitempty"`
	}
	type sendOut struct {
		To      string `json:"to"`
		Label   string `json:"label,omitempty"`
		At      string `json:"at"`
		Outcome string `json:"outcome"`
		Code    string `json:"code,omitempty"`
	}
	state, backend, up := "未连接", "", false
	if rt := x.router(); rt != nil {
		if s := rt.state(); s.phase == phaseOK {
			state, backend, up = "已连接", s.backend, rt.connected()
		}
	}
	out := struct {
		Router       string         `json:"router"`
		Backend      string         `json:"backend"`
		CanSend      bool           `json:"can_send"`
		Destinations []destOut      `json:"destinations"`
		RecentSends  []sendOut      `json:"recent_sends"`
		Limits       map[string]any `json:"limits"`
		Note         string         `json:"note"`
	}{Router: state, Backend: backend, CanSend: up, Destinations: []destOut{}, RecentSends: []sendOut{},
		Limits: map[string]any{"text_chars": sendTextMost, "per_destination_per_minute": x.tm.sendPerDest,
			"per_minute": x.tm.sendPerWindow, "attachments": false},
		Note: destinationsNote}
	for _, d := range x.dests() {
		o := destOut{ID: d.ID, Source: d.Source, Name: fieldSafe(oneLine(d.Name, destNameMost)), Channel: fieldSafe(oneLine(d.Channel, 40)),
			Kind: kindWords[d.Kind], Label: fieldSafe(d.Label), LastFrom: fieldSafe(d.LastFrom), Verdict: d.Verdict,
			Same: d.Twins > 0, LastRef: d.LastRef}
		if !d.LastSeen.IsZero() {
			o.LastSeen = d.LastSeen.UTC().Format(time.RFC3339)
		}
		if d.Source == sourceNamed {
			o.Note = destinationNamedOnly
		}
		out.Destinations = append(out.Destinations, o)
	}
	if st := x.store(); st != nil {
		for _, r := range st.recentSends(recentSendsMost) {
			out.RecentSends = append(out.RecentSends, sendOut{To: r.Dest, Label: r.Label, At: r.At.UTC().Format(time.RFC3339),
				Outcome: r.Outcome, Code: r.Code})
		}
	}
	b, _ := json.Marshal(out)
	return string(b)
}
