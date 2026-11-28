package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// itemID is the dedupe key of a queue item: its own id if the router ever sends one, else the account and the channel
// message reference, which is the router's own idempotency key for the queue of one backend.
func itemID(it inboundItem) string {
	if it.ID != "" {
		return it.ID
	}
	ref := it.ChannelRef
	if ref == "" {
		ref = it.Input.InputID
	}
	if ref == "" {
		return ""
	}
	return it.Account + "/" + ref
}

// short is a fixed-length, charset-safe name for an id: operation ids, client message ids and logs use it, never the
// id itself.
func short(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:16])
}

// textDigest names a text without keeping it: what a send is recorded with, and what an item is compared by when it
// may be that send coming back.
func textDigest(text string) string { return short("text|" + cleanText(text, 0)) }

// cleanText makes text safe to hand on: CRLF becomes LF, every control character but newline and tab is removed (the
// hub refuses them from an extension), and it is cut at most bytes on a rune boundary.
func cleanText(s string, most int) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == utf8.RuneError || r == ' ' || r == ' ' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if most > 0 && len(s) > most {
		s = s[:most]
		for len(s) > 0 && !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
		s += "…"
	}
	return s
}

// oneLine is cleanText on one line: a name can never start a second line.
func oneLine(s string, most int) string {
	s = cleanText(s, 0)
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); most > 0 && len(r) > most {
		s = string(r[:most]) + "…"
	}
	return s
}

// renderText is an input's content as words: text as it is, a quote as "> …" lines, media as a named placeholder (no
// bytes are fetched in this version), transcripts and references a line each. It also lists the media, and says
// whether the content is a card click.
func renderText(blocks []contentBlock) (text string, media []attachment, click bool) {
	var parts []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) != "" {
				parts = append(parts, b.Text)
			}
		case "quote":
			lines := strings.Split(strings.TrimSpace(cleanText(b.Text, 2000)), "\n")
			for i := range lines {
				lines[i] = "> " + lines[i]
			}
			parts = append(parts, strings.Join(lines, "\n"))
		case "image", "file", "audio":
			media = append(media, attachment{Type: b.Type, Name: oneLine(b.Name, 120), Mime: oneLine(b.Mime, 80), Ref: oneLine(b.Ref, 200)})
			word := placeholderWords[b.Type]
			if name := oneLine(b.Name, 120); name != "" {
				word += ": " + name
			}
			parts = append(parts, "["+word+"]")
		case "transcript":
			line := oneLine(b.Text, 2000)
			if sp := oneLine(b.Speaker, 60); sp != "" {
				line = sp + ": " + line
			}
			parts = append(parts, line)
		case "ref":
			line := oneLine(b.URI, 500)
			if t := oneLine(b.Title, 120); t != "" {
				line = t + " " + line
			}
			parts = append(parts, line)
		case "event":
			if b.Name == "action" {
				click = true
			}
		}
	}
	return cleanText(strings.Join(parts, "\n"), textMost), media, click
}

func contextString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// normalize is the queue item as the journal keeps it. raw platform data is not there: the router strips it.
func normalize(it inboundItem) itemRec {
	env, in := it.Envelope, it.Input
	rec := itemRec{
		ID: itemID(it), Cursor: it.Cursor, Rule: oneLine(it.BindingID, 200),
		Channel: env.Channel, Account: it.Account, ConvID: env.Conversation.ID, ThreadID: env.Conversation.ThreadID,
		ConvKind: env.Conversation.Kind, MessageID: env.ID, ChannelRef: it.ChannelRef,
		RootID: env.RootMessageID, ParentID: env.ParentMessageID,
		SenderID: env.Sender.ChannelUserID, SenderName: oneLine(env.Sender.DisplayName, 80),
		Evidence: in.Origin.Evidence, IsBot: env.Sender.IsBot || in.Origin.Kind == "agent",
		Addressed: len(env.Mentions) > 0 || env.Admission == "dispatch",
	}
	if rec.Account == "" {
		rec.Account = env.Account
	}
	if it.ReceivedAt > 0 {
		rec.ReceivedAt = time.UnixMilli(it.ReceivedAt).UTC()
	} else {
		rec.ReceivedAt = time.Now().UTC()
	}
	if env.SentAt > 0 {
		rec.SentAt = time.UnixMilli(env.SentAt).UTC()
	}
	if p := in.Origin.Principal; p != nil {
		rec.Known = true
		for _, l := range p.Labels {
			if l = oneLine(l, 40); l != "" {
				rec.SenderLabels = append(rec.SenderLabels, l)
			}
		}
	}
	if r := in.ReplyRoute; r != nil && r.Channel != "" && r.ConversationID != "" {
		route := *r
		rec.Route = &route
		rec.ConvKey = route.key()
	} else {
		rec.ConvKey = replyRoute{Channel: env.Channel, Account: rec.Account, ConversationID: env.Conversation.ID,
			ThreadID: env.Conversation.ThreadID}.key()
	}
	ctx := map[string]any{}
	for k, v := range env.Context {
		ctx[k] = v
	}
	for k, v := range in.ChannelContext {
		ctx[k] = v
	}
	rec.ChatName = oneLine(contextString(ctx, "chatName", "chat_name", "conversationName", "subject", "title"), 80)
	if u := contextString(ctx, "url", "link", "permalink", "messageUrl", "message_url"); strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
		rec.URL = oneLine(u, 1000)
	}
	if len(ctx) > 0 {
		rec.Context = map[string]string{}
		keys := make([]string, 0, len(ctx))
		for k := range ctx {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys[:min(len(keys), 24)] {
			rec.Context[k] = oneLine(fmt.Sprint(ctx[k]), 200)
		}
	}
	content := in.Content
	if len(content) == 0 {
		content = env.Content
	}
	var click bool
	rec.Text, rec.Attachments, click = renderText(content)
	if click {
		rec.State, rec.Why = stateSkipped, whyClick
	}
	if in.Origin.Self {
		rec.State, rec.Why = stateSkipped, whySelf
	}
	return rec
}

// decide says what is done with a new item: the Inbox, an assistant conversation, an Agent session, or nothing.
// The extension's own routes are tried first (an item already known as our own echo or a click is not matched); the
// item's tag and the rule-name lists decide when none matches. Anything that cannot safely go to a conversation
// falls back to the Inbox with the reason.
func decide(rec *itemRec, set settings, it inboundItem, hubOK bool) {
	rec.Tag, rec.Target, rec.TagSource = set.tagFor(it.Tag, rec.Rule)
	if rec.State == stateSkipped {
		return
	}
	if r, content, ok := set.route(routeFactsOf(it, *rec)); ok {
		rec.Matched = r.Name
		rec.Tag, rec.Target, rec.TagSource = set.actionFor(r)
		if r.prefixes() != nil {
			// The words that chose the rule are not part of the message: what is handed on starts after them.
			rec.Text, rec.Attachments, _ = renderText(content)
		}
	}
	if rec.Tag == actionIgnore {
		// Recorded, so the item is not taken again, and skipped: never filed, never answered. Its words are not kept.
		rec.State, rec.Why, rec.Text, rec.Attachments = stateSkipped, whyIgnored, "", nil
		return
	}
	rec.State = stateInbox
	if rec.Tag == tagInbox {
		switch rec.TagSource {
		case tagSourceUnknownAgent:
			// Meant for an Agent session this extension cannot name: said, so the owner sees why it is here.
			rec.Why = whyAgentUnknown
		case tagSourceUnknownLauncher:
			rec.Why = whyLaunchUnknown
		}
		return
	}
	switch {
	case rec.Tag == tagLaunch && !launchAllowed(*rec):
		// The hard rule: only the owner's own message starts anything, whatever the routes or the tag say.
		rec.Why = whyLaunchNotOwner
	case rec.Route == nil:
		rec.Why = whyNoRoute
	case rec.IsBot:
		// A bot or another deployment's agent talking to the assistant, whose answer goes back to it: a loop.
		rec.Why = whyLoopGuard
	case strings.TrimSpace(rec.Text) == "":
		rec.Why = whyEmpty
	case !hubOK:
		rec.Why = whyNoHub
	default:
		rec.State = stateQueued
	}
}

// intake takes one pushed item: the at-least-once contract of the queue. An id the journal already has is accepted
// again and nothing else happens (a push repeated after a reconnect, a router restart or this program's restart). A
// new one is written durably first and accepted only then; when the write fails it is not accepted, and the router
// pushes it again. Handling runs from the journal afterwards.
func (x *app) intake(ctx context.Context, raw json.RawMessage) bool {
	var it inboundItem
	id := ""
	if json.Unmarshal(raw, &it) == nil {
		id = itemID(it)
	}
	if id == "" {
		return x.intakeUnreadable(raw)
	}
	st := x.store()
	if st == nil {
		return false
	}
	if st.has(id) {
		return true
	}
	rec := normalize(it)
	// A message this program sent, coming back as an item: the router stamps the ones it knows for its own (self,
	// above); the ones it does not are known here by the platform id the send was answered with. A send the assistant
	// asked for whose answer never came has no id to be known by: its echo is known by the conversation and the text
	// (store.claimEcho), and its id is remembered from then on.
	if rec.MessageID != "" && rec.State != stateSkipped {
		x.awaitSends(ctx, rec)
		now := time.Now()
		switch {
		case st.sentByUs(rec.Channel, rec.MessageID):
			rec.State, rec.Why = stateSkipped, whySelf
		case st.claimEcho(placeKeyOf(rec), textDigest(rec.Text), rec.SenderID, rec.MessageID, now.Add(-x.tm.echoKeep)):
			st.noteSent(rec.Channel, []string{rec.MessageID}, now)
			log.Printf("echo: item %s is taken for the echo of a send of unknown outcome", short(id)[:12])
			rec.State, rec.Why = stateSkipped, whySelf
		}
	}
	rec.TakenAt = time.Now().UTC()
	decide(&rec, x.settings(), it, x.hubReady())
	added, err := st.add(rec)
	if err != nil {
		log.Printf("intake: the journal could not be written; item %s is not accepted", short(id)[:12])
		return false
	}
	if !added {
		return true
	}
	st.sawPlace(rec)
	if rec.Matched != "" {
		log.Printf("intake: item %s tag=%s(route %s) state=%s", short(id)[:12], rec.Tag, rec.Matched, rec.State)
	} else {
		log.Printf("intake: item %s tag=%s(%s) state=%s", short(id)[:12], rec.Tag, rec.TagSource, rec.State)
	}
	switch rec.State {
	case stateInbox:
		x.inboxChanged()
	case stateQueued:
		x.wake()
	}
	return true
}

// awaitSends waits, for at most echoWait, while a deliver into the item's conversation is under way and the item is
// not yet known for our own: a channel may hand the echo to the router before the router answers the send. What it
// cannot wait out is put right when the send is answered (store.skipEchoes).
func (x *app) awaitSends(ctx context.Context, rec itemRec) {
	key, st := placeKeyOf(rec), x.store()
	for began := time.Now(); time.Since(began) < x.tm.echoWait; {
		x.mu.Lock()
		under := x.sending[key] > 0
		x.mu.Unlock()
		if !under || st.sentByUs(rec.Channel, rec.MessageID) || sleep(ctx, x.tm.tick) != nil {
			return
		}
	}
}

// unreadableThread is the one Inbox thread of the items this program could not read.
const unreadableThread = "agents-io:unreadable"

// intakeUnreadable takes an item that does not decode into inboundItem (a newer router changed a field's type), or
// one without any reference. It will never decode, so holding the queue on it helps nobody; but accepting it without
// a trace would lose a message with the status still fine. What can be recovered leniently (the cursor, the account,
// the channel reference) is journaled as a placeholder Inbox item that needs the owner, and only then is the item
// accepted. The count is in the connector's status.
func (x *app) intakeUnreadable(raw json.RawMessage) bool {
	st := x.store()
	if st == nil {
		return false
	}
	var loose map[string]json.RawMessage
	_ = json.Unmarshal(raw, &loose)
	text := func(key string) string {
		var s string
		_ = json.Unmarshal(loose[key], &s)
		return s
	}
	var cursor int64
	_ = json.Unmarshal(loose["cursor"], &cursor)
	account, ref := oneLine(text("account"), 80), oneLine(text("channelRef"), 200)
	id := text("id")
	switch {
	case id != "":
	case ref != "":
		id = account + "/" + ref // the id a readable copy of the item would have
	case cursor != 0:
		id = fmt.Sprintf("unreadable/cursor-%d", cursor)
	default:
		id = "unreadable/" + short(string(raw))
	}
	if st.has(id) {
		return true
	}
	now := time.Now().UTC()
	rec := itemRec{ID: id, Cursor: cursor, Tag: tagInbox, TagSource: tagSourceUnreadable, ReceivedAt: now, TakenAt: now,
		Channel: extensionID, Account: account, ChannelRef: ref, ConvKind: "other", ConvKey: unreadableThread,
		SenderName: extensionID, ChatName: wordsUnreadableTitle, Text: fmt.Sprintf(wordsUnreadableText, cursor),
		State: stateInbox, Why: whyUnreadableItem}
	if _, err := st.add(rec); err != nil {
		log.Printf("intake: the journal could not be written; an unreadable item is not accepted")
		return false
	}
	x.mu.Lock()
	x.unreadable++
	x.mu.Unlock()
	log.Printf("intake: item %s could not be read; a placeholder is in the Inbox (cursor %d)", short(id)[:12], cursor)
	x.inboxChanged()
	return true
}

// stamp is the router's verdict on the sender, in words.
func stamp(rec itemRec) string {
	who := "身份未知"
	switch {
	case slices.Contains(rec.SenderLabels, "owner"):
		who = "主人"
	case len(rec.SenderLabels) > 0:
		who = "已知身份 " + strings.Join(rec.SenderLabels, "、")
	case rec.Known:
		who = "已知身份"
	}
	if rec.Evidence != "" && rec.Evidence != "none" {
		return who + "，凭据 " + oneLine(rec.Evidence, 30)
	}
	return who + "，无凭据"
}

// senderLine is the first line of what the assistant is given: who sent the message and through which channel, since
// the product has no sender field. It is exactly one line; names are stripped of line breaks, so nothing in a name
// can start a second line that looks like this one. refToken is in it so the message can be found in the transcript.
func senderLine(rec itemRec) string {
	name := fieldSafe(rec.SenderName)
	if name == "" {
		name = fieldSafe(oneLine(rec.SenderID, 80))
	}
	if name == "" {
		name = "未知"
	}
	where := fieldSafe(oneLine(rec.Channel, 40))
	if kind := kindWords[rec.ConvKind]; kind != "" {
		where += " " + kind
	}
	if rec.ChatName != "" {
		where += "「" + fieldSafe(rec.ChatName) + "」"
	}
	return "【渠道消息】发送者：" + name + "（路由认定：" + stamp(rec) + "）｜渠道：" + where + "｜" + refToken(rec) +
		"｜你的最终回答会原样发回这个会话"
}

// refToken names the item in the sender line.
func refToken(rec itemRec) string { return "ref=" + short(rec.ID)[:16] }

// prompt is what the assistant is given for an item.
func prompt(rec itemRec) string {
	return cleanText(senderLine(rec)+"\n\n"+rec.Text, 0)
}

// fieldSafe takes the sender line's own punctuation out of a value a sender controls (a display name, a chat name), so
// a name cannot close its field and write another one, such as the router's verdict.
func fieldSafe(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		switch r {
		case '｜', '|', '【', '】', '（', '）', '「', '」', '：', ':':
			return -1
		}
		return r
	}, s))
}
