package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The launch round trip: an item whose action is "launch:<name>" starts a new Agent session on a paired computer
// with the launcher the line of that name gives, the item's text (with the sender line) as its first prompt. The
// turn's final answer goes back to the item's reply route the way an agent target's does. Later launch items of the
// same channel conversation (thread included) and the same launcher go into that session while it is alive; once it
// has stopped the next one starts a new session.
//
// Only the owner's own message starts anything (launchAllowed): whatever the routes or the tag say, any other item is
// the Inbox with the reason. A start is never made twice: the item's journal record is the dedupe of the queue's
// redelivery, the start's operation id comes from the item, the run's state is written before the request, and a
// start whose answer was lost is an unknown outcome that is never repeated.

// Launchers: what a "launch:<name>" item starts. One line each, "<name> = <machine id>/<launcher> [field=value …]".
// The launcher is a name in that computer's launcher list (Settings › Launchers of the computer); the optional fields
// are the hub's own start fields (POST /api/v1/sessions), so one name binds the computer, the harness and the model.
// The hub's start request takes no tier preset at the version this was written for: a preset is spelled out here.
const (
	launchersMost   = 32
	launchersKey    = "launchers"
	launcherMost    = 64
	launcherCwdMost = 512
)

type launcher struct {
	Name, MachineID, Launcher string
	Host, Cwd, Model, Effort  string
	PermissionMode, Speed     string
}

// launcherFields are the optional fields of a line, by the hub's names, and what each accepts.
var launcherFields = map[string]func(string) bool{
	"host":            func(v string) bool { return len(v) <= 32 && lowerWord(v) },
	"cwd":             func(v string) bool { return len(v) <= launcherCwdMost },
	"model":           func(v string) bool { return len(v) <= 128 },
	"effort":          func(v string) bool { return len(v) <= 32 && lowerWord(v) },
	"permission_mode": func(v string) bool { return len(v) <= 40 && asciiName(v) },
	"speed":           func(v string) bool { return v == "standard" || v == "fast" || v == "ultrafast" },
}

// lowerWord: a lowercase letter, then lowercase letters, digits, "-" and "_".
func lowerWord(s string) bool {
	return s != "" && s[0] >= 'a' && s[0] <= 'z' && !strings.ContainsFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_')
	})
}

// asciiName: letters, digits, "-" and "_" (a permission mode is written in camel case: acceptEdits).
func asciiName(s string) bool {
	return s != "" && !strings.ContainsFunc(s, func(r rune) bool { return !(asciiWord(r) || r == '-' || r == '_') })
}

func (s settings) launcher(name string) (launcher, bool) {
	for _, l := range s.launchers {
		if l.Name == name {
			return l, true
		}
	}
	return launcher{}, false
}

// parseLaunchers reads the setting's lines, like parseAgentTargets.
func parseLaunchers(lines []string) (good []launcher, bad []destProblem) {
	names := map[string]bool{}
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		n := i + 1
		if len(good) >= launchersMost {
			bad = append(bad, destProblem{n, wordsLauncherTooMany})
			break
		}
		l, why := parseLauncher(line)
		if why == "" && names[l.Name] {
			why = wordsLauncherNameTwice
		}
		if why != "" {
			bad = append(bad, destProblem{n, why})
			continue
		}
		names[l.Name] = true
		good = append(good, l)
	}
	return good, bad
}

func parseLauncher(line string) (launcher, string) {
	if lower := strings.ToLower(line); strings.Contains(lower, keyPrefix) || strings.Contains(line, "://") {
		return launcher{}, wordsLauncherSecret
	}
	name, rest, ok := strings.Cut(line, "=")
	fields := strings.Fields(rest)
	if !ok || len(fields) == 0 {
		return launcher{}, wordsLauncherForm
	}
	mid, which, ok := strings.Cut(fields[0], "/")
	l := launcher{Name: strings.TrimSpace(name), MachineID: mid, Launcher: which}
	switch {
	case !ok || l.Name == "" || l.MachineID == "" || l.Launcher == "":
		return launcher{}, wordsLauncherForm
	case !agentName(l.Name):
		return launcher{}, wordsLauncherName
	case !idPart(l.MachineID) || len(l.Launcher) > launcherMost || !plainValue(l.Launcher):
		return launcher{}, wordsLauncherPart
	}
	seen := map[string]bool{}
	for _, f := range fields[1:] {
		key, value, ok := strings.Cut(f, "=")
		check := launcherFields[key]
		switch {
		case !ok || check == nil:
			return launcher{}, wordsLauncherField
		case seen[key]:
			return launcher{}, wordsLauncherFieldTwice
		case value == "" || !plainValue(value) || !check(value):
			return launcher{}, wordsLauncherValue
		}
		seen[key] = true
		switch key {
		case "host":
			l.Host = value
		case "cwd":
			l.Cwd = value
		case "model":
			l.Model = value
		case "effort":
			l.Effort = value
		case "permission_mode":
			l.PermissionMode = value
		case "speed":
			l.Speed = value
		}
	}
	return l, ""
}

// digest names what the line says, so a session started with another version of it is not taken for this one's.
func (l launcher) digest() string {
	return short(strings.Join([]string{"launcher", l.MachineID, l.Launcher, l.Host, l.Cwd, l.Model, l.Effort, l.PermissionMode, l.Speed}, "\x00"))[:16]
}

// launchAllowed is the hard rule: the router stamped the sender as the owner.
func launchAllowed(rec itemRec) bool {
	return rec.Known && slices.Contains(rec.SenderLabels, fromOwner)
}

// launchKey is the key the session a launcher started for a channel conversation is kept under in the conversation
// mapping. A channel conversation's own key never starts with it.
func launchKey(name, convKey string) string { return tagLaunch + "/" + name + "/" + convKey }

// startLaunch hands the item to the session its conversation's launcher started, or starts one. It answers false
// when the run ended here.
func (x *app) startLaunch(ctx context.Context, rec itemRec) (itemRec, bool) {
	st, hub := x.store(), x.hub()
	if hub == nil {
		x.toInbox(rec, whyNoHub)
		return rec, false
	}
	l, ok := x.settings().launcher(rec.Target)
	switch {
	case !ok:
		// The settings changed while the item waited: nothing was tried.
		x.toInbox(rec, whyLaunchUnknown)
		return rec, false
	case !launchAllowed(rec):
		x.toInbox(rec, whyLaunchNotOwner)
		return rec, false
	}
	key := rec.seqKey()
	text := prompt(rec)
	deadline := time.Now().Add(x.tm.notSentMost)
	wait := x.tm.notSentRetry
	undecodable := 0
	look := true // whether the session's row is to be looked at before the next try (not again while paging)
	alive := true
	for {
		if ctx.Err() != nil {
			return rec, false
		}
		conv, mapped := st.conv(key)
		if mapped && (conv.MachineID != l.MachineID || conv.Line != l.digest()) {
			mapped = false // the line now says something else (another computer, launcher, model…): a session of its own
		}
		if mapped && look {
			look = false
			row, visible, err := hub.look(ctx, conv.MachineID, conv.SessionID)
			alive = !(err == nil && visible && row.stopped())
		}
		if !alive {
			mapped = false
		}
		if ctx.Err() != nil {
			return rec, false
		}
		out := outRetry
		renew := false
		if !mapped {
			// The mapping is replaced only by a session that did start: a start that could not be made leaves the
			// conversation's session as it was for the next try.
			seed := "launch/" + rec.ID
			if rec.Run.Reopened {
				seed += "/again"
			}
			if rec.Run.OpenTry > 0 {
				seed += "/" + strconv.Itoa(rec.Run.OpenTry)
			}
			var err error
			// The state is written before the request: a crash between the two is an unknown outcome, never a second start.
			if rec, err = st.update(rec.ID, func(r *itemRec) { r.Run.State, r.Run.OpID = runLaunching, opUUID(seed) }); err == nil {
				var mid, sid string
				mid, sid, out, renew = hub.launch(ctx, l, text, rec.Run.MsgID, rec.Run.OpID)
				if ctx.Err() != nil {
					return rec, false
				}
				switch out {
				case outSent:
					now := time.Now().UTC()
					_ = st.setConv(key, convRec{MachineID: mid, SessionID: sid, Line: l.digest(), OpenedAt: now, LastUsedAt: now})
					rec, _ = st.update(rec.ID, func(r *itemRec) {
						r.Run.MachineID, r.Run.SessionID, r.Run.Head, r.Run.BaseSeq = mid, sid, true, 0
						r.Run.State, r.Run.SentAt = runSent, now
					})
					log.Printf("launch: item %s started an Agent session", short(rec.ID)[:12])
					return rec, true
				case outUnknown:
					x.fail(ctx, rec, whyLaunchUnsure)
					return rec, false
				case outRefused, outGone:
					x.fail(ctx, rec, whyLaunchRefused)
					return rec, false
				}
			}
		} else {
			// Into the session this conversation's launcher started: read to its end first, like an agent target.
			page, complete, err := hub.items(ctx, conv.MachineID, conv.SessionID, conv.LastSeq)
			if ctx.Err() != nil {
				return rec, false
			}
			for _, it := range page {
				conv.LastSeq = max(conv.LastSeq, it.Seq)
			}
			var he *hubError
			switch {
			case errors.As(err, &he) && (he.status == http.StatusNotFound || he.status == http.StatusGone || he.status == http.StatusForbidden):
				// Not there any more, or no longer this token's to read: nothing was typed, a new session.
				_ = st.dropConv(key)
				rec, _ = st.update(rec.ID, func(r *itemRec) { r.Run.Reopened, r.Run.OpenTry = true, 0 })
				continue
			case errors.Is(err, errUndecodable):
				if undecodable++; undecodable >= undecodableMost {
					x.fail(ctx, rec, whyUnreadable)
					return rec, false
				}
			case err != nil:
			case !complete:
				_ = st.setConv(key, conv)
				continue
			default:
				conv.LastUsedAt = time.Now().UTC()
				var werr error
				if werr = st.setConv(key, conv); werr == nil {
					rec, werr = st.update(rec.ID, func(r *itemRec) {
						r.Run.State, r.Run.MachineID, r.Run.SessionID = runSending, conv.MachineID, conv.SessionID
						r.Run.Head, r.Run.BaseSeq = false, conv.LastSeq
					})
				}
				if werr == nil {
					var kept, stopped bool
					out, kept, stopped = hub.sendTo(ctx, conv.MachineID, conv.SessionID, text, rec.Run.MsgID)
					if ctx.Err() != nil {
						return rec, false
					}
					switch {
					case stopped, out == outGone:
						// The session has stopped (or is gone) and took nothing: the next start is a new session.
						_ = st.dropConv(key)
						rec, _ = st.update(rec.ID, func(r *itemRec) { r.Run.State, r.Run.Reopened, r.Run.OpenTry = "", true, 0 })
						log.Printf("launch: item %s found its session stopped; starting a new one", short(rec.ID)[:12])
						continue
					case out == outSent || out == outUnknown:
						now := time.Now().UTC()
						rec, _ = st.update(rec.ID, func(r *itemRec) {
							r.Run.State, r.Run.SentAt, r.Run.Unsure, r.Run.Kept = runSent, now, out == outUnknown, kept
						})
						log.Printf("launch: item %s sent into its session (outcome %s)", short(rec.ID)[:12], out)
						return rec, true
					case out == outRefused:
						x.fail(ctx, rec, whyRefused)
						return rec, false
					}
				}
			}
		}
		// Certainly not sent, and not started: try again for a while. A start the hub refused with a receipt is replayed
		// to the same operation id, so the next try gets a new one (nothing was started under the old).
		look, alive = true, true
		rec, _ = st.update(rec.ID, func(r *itemRec) {
			r.Run.State = ""
			if renew {
				r.Run.OpenTry++
			}
		})
		if time.Now().After(deadline) {
			x.fail(ctx, rec, whyNotSent)
			return rec, false
		}
		if sleep(ctx, wait) != nil {
			return rec, false
		}
		wait = min(wait*2, time.Minute)
	}
}
