package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"
)

// The extension's own storage: three JSON files in its data directory. journal.json has one record per queue item
// the router pushed (the dedupe key of the at-least-once contract, and the state of its handling); conversations.json
// maps a channel conversation to the assistant conversation that answers it; outbound.json has what sending on the
// assistant's own initiative needs (the conversations seen, the sends made, the platform ids of the messages this
// program sent). Files are 0600 and replaced atomically (temporary file, fsync, rename, directory fsync).

const (
	journalFile = "journal.json"
	convsFile   = "conversations.json"
	// journalMost bounds the journal whatever the retention says.
	journalMost = 5000
	textMost    = 16 << 10
	// inboxWindow is the hub's own: a thing older than this never starts an Inbox item there, so an item this old
	// that the hub does not hold open is over.
	inboxWindow = 7 * 24 * time.Hour
	// listedEvery is how often an open item's ListedAt is written again while the hub keeps listing its thread.
	listedEvery = 6 * time.Hour
	// convKeep is how long the mapping of a channel conversation nobody wrote in is kept.
	convKeep = 180 * 24 * time.Hour

	outboundFile = "outbound.json"
	// sendsMost, placesMost and sentMost bound outbound.json whatever the retention says.
	sendsMost  = 500
	placesMost = 500
	sentMost   = 2000
	// placeKeep is how long a conversation nobody wrote in stays a destination (the router's permission to send
	// there does not expire; the list must still end somewhere).
	placeKeep = 180 * 24 * time.Hour
	// sentKeep is how long the platform id of a message this program sent is remembered, to know its echo.
	sentKeep = 7 * 24 * time.Hour
	// placeTouchEvery is how often a known conversation's last-seen time is written again: not once per message.
	placeTouchEvery = time.Hour
)

// Outcomes of a send the assistant asked for.
const (
	sendSending   = "sending"   // written before the request; found after a restart it is unknown
	sendDelivered = "delivered" // the router settled it as delivered
	sendRefused   = "refused"   // nothing was sent: Code says who refused
	sendUnknown   = "unknown"   // the message may be out; never sent again by itself

	sendCodeRestart      = "restart"      // the program stopped while the request was under way
	sendCodeRejected     = "rejected"     // the channel rejected the message
	sendCodeDisconnected = "disconnected" // the connection went before anything was written
)

// placeRec is a channel conversation the router routed a message from: somewhere this backend may send to. The key
// is channel:account:conversation, the grain of the router's send scope (no thread).
type placeRec struct {
	Channel  string    `json:"channel"`
	Account  string    `json:"account"`
	ConvID   string    `json:"conv_id"`
	Kind     string    `json:"kind,omitempty"`
	ChatName string    `json:"chat_name,omitempty"`
	Sender   string    `json:"sender,omitempty"`    // display name of the last person who wrote there
	Verdict  string    `json:"verdict,omitempty"`   // the router's verdict on that person, in words (stamp)
	LastItem string    `json:"last_item,omitempty"` // the newest item with a message id: what a reply can name
	LastSeen time.Time `json:"last_seen,omitzero"`
}

// sendRec is one send the assistant asked for, keyed by the operation its request id gives. The text is never kept:
// only its length and a digest of destination, reply target and text.
type sendRec struct {
	Op        string `json:"op"`
	Dest      string `json:"dest"`
	ConvKey   string `json:"conv_key"`
	Label     string `json:"label,omitempty"`
	Named     string `json:"named,omitempty"`
	ReplyTo   string `json:"reply_to,omitempty"`
	Digest    string `json:"digest"`
	Chars     int    `json:"chars"`
	Outcome   string `json:"outcome"`
	Code      string `json:"code,omitempty"`
	MessageID string `json:"message_id,omitempty"`
	NoReply   bool   `json:"no_reply,omitempty"`  // the router refused the reply target; sent as a plain message
	Duplicate bool   `json:"duplicate,omitempty"` // the router answered a record it had already settled
	// SameAs: the operation the router was asked under, when that is an earlier send of the same text whose outcome
	// was unknown (the router then answers its settled record, or sends for the first time: never twice).
	SameAs string `json:"same_as,omitempty"`
	// Spent: the router itself settled the operation as unknown. Asking again under it only answers that, so the
	// same text confirmed again is a new operation.
	Spent bool `json:"spent,omitempty"`
	// TextDigest is a digest of the text alone, and Echo the platform id of the item taken for this send's echo:
	// how the message is known when it comes back after an answer that never said which message it became.
	TextDigest string    `json:"text_digest,omitempty"`
	Echo       string    `json:"echo,omitempty"`
	At         time.Time `json:"at"`
	SettledAt  time.Time `json:"settled_at,omitzero"`
}

// routerOp is the operation id the router was asked under.
func (r sendRec) routerOp() string {
	if r.SameAs != "" {
		return r.SameAs
	}
	return r.Op
}

// sentMsg is a message this program sent, by its id on the platform: the same message coming back through the
// router as an item is its echo.
type sentMsg struct {
	Channel string    `json:"channel"`
	ID      string    `json:"id"`
	At      time.Time `json:"at"`
}

type outboundDoc struct {
	Version int                  `json:"version"`
	Places  map[string]*placeRec `json:"places"`
	Sends   map[string]*sendRec  `json:"sends"`
	Sent    []sentMsg            `json:"sent"`
}

// Item states.
const (
	stateInbox   = "inbox"        // an Inbox thing, nothing more to do by itself
	stateQueued  = "chat_queued"  // waits for its turn in an assistant conversation
	stateRunning = "chat_running" // its turn is under way (run says where)
	stateDone    = "done"         // answered and delivered
	stateFailed  = "failed"       // the round trip failed: shown in the Inbox instead
	stateSkipped = "skipped"      // nothing to do (an echo, a click)
)

type attachment struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
	Mime string `json:"mime,omitempty"`
	Ref  string `json:"ref,omitempty"`
}

// inboxRec is an item's life as an Inbox thing.
type inboxRec struct {
	// Since: when the item became an Inbox thing, for one that did not arrive as one (a round trip that failed, a
	// start that could not be made). It is the thread's step from then on: the thing's time, and its order.
	Since time.Time `json:"since,omitzero"`
	// SeenOpen: the hub listed the thread as open in an inbox.settle call while this item was open. ListedAt: when
	// it last did (written at most every listedEvery).
	SeenOpen bool      `json:"seen_open,omitempty"`
	ListedAt time.Time `json:"listed_at,omitzero"`
	// Done: "replied" (answered through inbox.reply), "filed" (the hub stopped listing it) or "expired" (older than
	// the hub's window and not held open by the hub).
	Done   string    `json:"done,omitempty"`
	DoneAt time.Time `json:"done_at,omitzero"`
	// Closed: the hub knows it is over; it is no longer collected.
	Closed bool `json:"closed,omitempty"`
	// Marked: the done mark was put on the channel message (once).
	Marked bool `json:"marked,omitempty"`
}

// Run states.
const (
	runOpening    = "opening"    // POST /assistant/conversations is about to be, or was, sent
	runLaunching  = "launching"  // POST /sessions (a new Agent session) is about to be, or was, sent
	runSending    = "sending"    // POST …/messages is about to be, or was, sent
	runSent       = "sent"       // the assistant has the message; its answer is awaited
	runAnswered   = "answered"   // the answer is known and not delivered yet
	runDelivering = "delivering" // deliver was sent to the router
)

// runRec is one round trip through an assistant conversation.
type runRec struct {
	MsgID     string    `json:"msg_id"`
	OpID      string    `json:"op_id,omitempty"`
	MachineID string    `json:"machine_id,omitempty"`
	SessionID string    `json:"session_id,omitempty"`
	Head      bool      `json:"head,omitempty"`
	BaseSeq   int64     `json:"base_seq,omitempty"`
	State     string    `json:"state,omitempty"`
	OpenTry   int       `json:"open_try,omitempty"` // starts refused with a receipt: the next one needs a new operation id
	Unsure    bool      `json:"unsure,omitempty"`   // the send's outcome is unknown: only the transcript can tell
	Kept      bool      `json:"kept,omitempty"`     // the manager holds the message and sends it by itself later
	Seen      bool      `json:"seen,omitempty"`     // the conversation was seen working since the send
	Reopened  bool      `json:"reopened,omitempty"`
	StartedAt time.Time `json:"started_at,omitzero"`
	SentAt    time.Time `json:"sent_at,omitzero"`
	LastSeq   int64     `json:"last_seq,omitempty"`
	Answer    string    `json:"answer,omitempty"`
	NoReplyTo bool      `json:"no_reply_to,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// itemRec is one queue item as the extension keeps it: the facts it needs to show, answer and mark the message, and
// where its handling stands.
type itemRec struct {
	ID         string    `json:"id"`
	Cursor     int64     `json:"cursor,omitempty"`
	Rule       string    `json:"rule,omitempty"`
	Tag        string    `json:"tag"`
	TagSource  string    `json:"tag_source,omitempty"`
	Target     string    `json:"target,omitempty"`     // the agent target's or the launcher's name, for agent and launch
	Matched    string    `json:"matched,omitempty"`    // the extension's own route that decided, by its name
	ReceivedAt time.Time `json:"received_at,omitzero"` // when the router received it (the router's clock)
	SentAt     time.Time `json:"sent_at,omitzero"`
	TakenAt    time.Time `json:"taken_at,omitzero"` // when this program journaled it

	Channel    string `json:"channel,omitempty"`
	Account    string `json:"account,omitempty"`
	ConvID     string `json:"conv_id,omitempty"`
	ThreadID   string `json:"thread_id,omitempty"`
	ConvKind   string `json:"conv_kind,omitempty"`
	ConvKey    string `json:"conv_key"`
	MessageID  string `json:"message_id,omitempty"`
	ChannelRef string `json:"channel_ref,omitempty"`
	RootID     string `json:"root_message_id,omitempty"`
	ParentID   string `json:"parent_message_id,omitempty"`

	SenderID     string   `json:"sender_id,omitempty"`
	SenderName   string   `json:"sender_name,omitempty"`
	SenderLabels []string `json:"sender_labels,omitempty"`
	Known        bool     `json:"known,omitempty"` // the router stamped a principal
	Evidence     string   `json:"evidence,omitempty"`
	IsBot        bool     `json:"is_bot,omitempty"`
	Addressed    bool     `json:"addressed,omitempty"` // mentions someone, or the channel says it is addressed to us
	ChatName     string   `json:"chat_name,omitempty"`

	Text        string            `json:"text,omitempty"`
	Attachments []attachment      `json:"attachments,omitempty"`
	URL         string            `json:"url,omitempty"`
	Context     map[string]string `json:"context,omitempty"`
	Route       *replyRoute       `json:"route,omitempty"`

	State string   `json:"state"`
	Why   string   `json:"why,omitempty"`
	Inbox inboxRec `json:"inbox,omitzero"`
	Run   *runRec  `json:"run,omitempty"`
}

func (r itemRec) clone() itemRec {
	r.SenderLabels = slices.Clone(r.SenderLabels)
	r.Attachments = slices.Clone(r.Attachments)
	if r.Context != nil {
		c := make(map[string]string, len(r.Context))
		for k, v := range r.Context {
			c[k] = v
		}
		r.Context = c
	}
	if r.Route != nil {
		rt := *r.Route
		r.Route = &rt
	}
	if r.Run != nil {
		run := *r.Run
		r.Run = &run
	}
	return r
}

// seqKey is the key of the mapping the item's round trip keeps its transcript bookkeeping under: the channel
// conversation's for chat and guest, the target's for agent (two channel conversations may share one target), the
// launcher's and the channel conversation's for launch (each conversation has its own started session).
func (r itemRec) seqKey() string {
	switch r.Tag {
	case tagAgent:
		return agentKey(r.Target)
	case tagLaunch:
		return launchKey(r.Target, r.ConvKey)
	}
	return r.ConvKey
}

// open says whether the item is, or should be, an open Inbox thing.
func (r itemRec) open() bool {
	return (r.State == stateInbox || r.State == stateFailed) && r.Inbox.Done == "" && !r.Inbox.Closed
}

// stepAt is when the item became the newest step of its thread, by this program's clock: its arrival here, or the
// moment it turned into an Inbox thing after a detour through a conversation. Not the router's time of receipt: an
// item pushed late (a backlog) is still what happened last here.
func (r itemRec) stepAt() time.Time {
	switch {
	case !r.Inbox.Since.IsZero():
		return r.Inbox.Since
	case !r.TakenAt.IsZero():
		return r.TakenAt
	}
	return r.ReceivedAt
}

// finished says whether nothing more will happen to the item by itself (so it may be pruned once old).
func (r itemRec) finished() bool {
	switch r.State {
	case stateDone, stateSkipped:
		return true
	case stateInbox, stateFailed:
		return r.Inbox.Done != "" || r.Inbox.Closed
	}
	return false
}

// convRec is the assistant conversation that answers one channel conversation. An agent target has one too, under
// agentKey(name): the session its line named when it was last used and how far that session's transcript was read
// (nothing is ever opened for it).
type convRec struct {
	MachineID  string    `json:"machine_id"`
	SessionID  string    `json:"session_id"`
	Guest      bool      `json:"guest,omitempty"`
	OpenedAt   time.Time `json:"opened_at,omitzero"`
	LastUsedAt time.Time `json:"last_used_at,omitzero"`
	LastSeq    int64     `json:"last_seq,omitempty"`
	// Line: for a session a launcher started, a digest of the launcher's line it was started with (launcher.digest).
	Line string `json:"line,omitempty"`
}

type journalDoc struct {
	Version int                 `json:"version"`
	Items   map[string]*itemRec `json:"items"`
}

type convsDoc struct {
	Version int                `json:"version"`
	Convs   map[string]convRec `json:"convs"`
}

type store struct {
	dir string

	mu      sync.Mutex
	items   map[string]*itemRec
	convs   map[string]convRec
	corrupt bool  // a file was unreadable at start and set aside
	broken  error // the last write failed

	places     map[string]*placeRec
	sends      map[string]*sendRec
	sent       []sentMsg
	sentIdx    map[string]bool      // channel NUL id
	placeSaved map[string]time.Time // when a place was last written
	outWrites  int                  // how often outbound.json was written
}

// openStore reads the three files. An unreadable one is moved aside (.corrupt) and the store starts empty for it; that
// is reported in the status, since items handled before may then be handled once more.
func openStore(dir string) (*store, error) {
	if dir == "" {
		return nil, errors.New("no data directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &store{dir: dir, items: map[string]*itemRec{}, convs: map[string]convRec{}, places: map[string]*placeRec{},
		sends: map[string]*sendRec{}, sentIdx: map[string]bool{}, placeSaved: map[string]time.Time{}}
	var j journalDoc
	switch err := readState(filepath.Join(dir, journalFile), &j); {
	case err == errCorrupt:
		s.corrupt = true
	case err != nil:
		return nil, err
	}
	for id, rec := range j.Items {
		if rec != nil && id != "" {
			rec.ID = id
			s.items[id] = rec
		}
	}
	var c convsDoc
	switch err := readState(filepath.Join(dir, convsFile), &c); {
	case err == errCorrupt:
		s.corrupt = true
	case err != nil:
		return nil, err
	}
	for k, v := range c.Convs {
		s.convs[k] = v
	}
	var o outboundDoc
	switch err := readState(filepath.Join(dir, outboundFile), &o); {
	case err == errCorrupt:
		s.corrupt = true
	case err != nil:
		return nil, err
	}
	dirty := false
	for k, p := range o.Places {
		if p != nil && k != "" {
			s.places[k] = p
		}
	}
	for op, r := range o.Sends {
		if r == nil || op == "" {
			continue
		}
		r.Op = op
		// A send found mid-request: the message may be out. The same rule as a chat run found mid-request.
		if r.Outcome == sendSending {
			r.Outcome, r.Code, r.SettledAt = sendUnknown, sendCodeRestart, time.Now().UTC()
			dirty = true
		}
		s.sends[op] = r
	}
	for _, m := range o.Sent {
		if m.Channel != "" && m.ID != "" && !s.sentIdx[sentKey(m.Channel, m.ID)] {
			s.sent = append(s.sent, m)
			s.sentIdx[sentKey(m.Channel, m.ID)] = true
		}
	}
	// The journal's conversations are destinations too: a data directory of a version without outbound.json, or
	// messages taken since the places were last written.
	journal := make([]*itemRec, 0, len(s.items))
	for _, rec := range s.items {
		journal = append(journal, rec)
	}
	sort.Slice(journal, func(i, j int) bool { return seenAt(*journal[i]).Before(seenAt(*journal[j])) })
	for _, rec := range journal {
		if _, changed, _ := s.foldPlace(*rec); changed {
			dirty = true
		}
	}
	if dirty {
		_ = s.saveOutbound()
	}
	return s, nil
}

var errCorrupt = errors.New("state file is not readable JSON")

// readState reads a state file into v. A missing file is empty; one that is not JSON is moved aside and reported.
func readState(path string, v any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	if json.Unmarshal(data, v) != nil {
		_ = os.Rename(path, path+".corrupt")
		return errCorrupt
	}
	return nil
}

// writeState replaces a state file atomically and durably.
func writeState(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// saveItems writes the journal; the caller holds mu.
func (s *store) saveItems() error {
	err := writeState(filepath.Join(s.dir, journalFile), journalDoc{Version: 1, Items: s.items})
	s.broken = err
	return err
}

func (s *store) saveConvs() error {
	err := writeState(filepath.Join(s.dir, convsFile), convsDoc{Version: 1, Convs: s.convs})
	s.broken = err
	return err
}

// health is what the status says about the storage: whether a file was set aside at start, and the last write error.
func (s *store) health() (corrupt bool, broken error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.corrupt, s.broken
}

func (s *store) has(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items[id] != nil
}

// add keeps a new item durably. It answers false when the item is already there (nothing is changed), and an error
// when it could not be written (it is then not kept in memory either, so the router's next push is taken as new).
func (s *store) add(rec itemRec) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.items[rec.ID] != nil {
		return false, nil
	}
	r := rec.clone()
	s.items[rec.ID] = &r
	if err := s.saveItems(); err != nil {
		delete(s.items, rec.ID)
		return false, err
	}
	return true, nil
}

func (s *store) get(id string) (itemRec, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.items[id]
	if r == nil {
		return itemRec{}, false
	}
	return r.clone(), true
}

// update changes one item and writes the journal. The change stays in memory when the write fails (the next write
// carries it); the error is reported so a caller about to do something that must not be repeated can stop.
func (s *store) update(id string, change func(*itemRec)) (itemRec, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.items[id]
	if r == nil {
		return itemRec{}, errors.New("no such item")
	}
	change(r)
	err := s.saveItems()
	return r.clone(), err
}

// updateAll changes every item change says it changed, with one write.
func (s *store) updateAll(change func(*itemRec) bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, r := range s.items {
		if change(r) {
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.saveItems()
}

// all are the items, oldest first (by the router's cursor, then by arrival).
func (s *store) all() []itemRec {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]itemRec, 0, len(s.items))
	for _, r := range s.items {
		out = append(out, r.clone())
	}
	sort.Slice(out, func(i, j int) bool { return before(out[i], out[j]) })
	return out
}

func before(a, b itemRec) bool {
	if !a.ReceivedAt.Equal(b.ReceivedAt) {
		return a.ReceivedAt.Before(b.ReceivedAt)
	}
	if a.Cursor != b.Cursor {
		return a.Cursor < b.Cursor
	}
	return a.ID < b.ID
}

// matchCounts are how many items each of the extension's routes decided that this program took at or after since.
func (s *store) matchCounts(since time.Time) map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]int{}
	for _, r := range s.items {
		if r.Matched != "" && !r.TakenAt.Before(since) {
			out[r.Matched]++
		}
	}
	return out
}

func (s *store) conv(key string) (convRec, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.convs[key]
	return c, ok
}

func (s *store) setConv(key string, c convRec) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.convs[key] = c
	return s.saveConvs()
}

func (s *store) dropConv(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.convs[key]; !ok {
		return nil
	}
	delete(s.convs, key)
	return s.saveConvs()
}

// busyLocked says whether a channel conversation has an item waiting for, or in, a round trip; the caller holds mu.
func (s *store) busyLocked(key string) bool {
	for _, r := range s.items {
		if (r.ConvKey == key || r.seqKey() == key) && (r.State == stateQueued || r.State == stateRunning) {
			return true
		}
	}
	return false
}

// prune bounds what the extension keeps, whatever the hub does:
//   - an open Inbox item older than the hub's window that the hub does not hold open (it never listed the thread in
//     inbox.settle, or stopped doing so that long ago) is over: "expired". The hub never starts an item for a thing
//     that old, and several ordinary paths leave an item open here for good (a muted chat or sender, a backlog pushed
//     late, an item filed while no other thread was open);
//   - finished items older than keep are dropped;
//   - beyond journalMost the oldest finished items go, then the oldest Inbox items;
//   - the mapping of a channel conversation unused for convKeep is dropped.
//
// An item on its way through a conversation is never touched. It answers how many items were dropped and how many
// expired.
func (s *store) prune(now time.Time, keep time.Duration) (dropped, expired int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.items {
		if r.open() && now.Sub(r.stepAt()) > inboxWindow && now.Sub(r.Inbox.ListedAt) > inboxWindow {
			r.Inbox.Done, r.Inbox.DoneAt, r.Inbox.Closed = "expired", now.UTC(), true
			expired++
		}
	}
	var done, inbox []*itemRec
	for id, r := range s.items {
		switch {
		case r.finished() && now.Sub(r.ReceivedAt) > keep:
			delete(s.items, id)
			dropped++
		case r.finished():
			done = append(done, r)
		case r.State == stateInbox || r.State == stateFailed:
			inbox = append(inbox, r)
		}
	}
	if over := len(s.items) - journalMost; over > 0 {
		sort.Slice(done, func(i, j int) bool { return before(*done[i], *done[j]) })
		sort.Slice(inbox, func(i, j int) bool { return before(*inbox[i], *inbox[j]) })
		for _, r := range append(done, inbox...)[:min(over, len(done)+len(inbox))] {
			delete(s.items, r.ID)
			dropped++
		}
	}
	if dropped+expired > 0 {
		_ = s.saveItems()
	}
	convs := 0
	for key, c := range s.convs {
		used := c.LastUsedAt
		if c.OpenedAt.After(used) {
			used = c.OpenedAt
		}
		if !used.IsZero() && now.Sub(used) > convKeep && !s.busyLocked(key) {
			delete(s.convs, key)
			convs++
		}
	}
	if convs > 0 {
		_ = s.saveConvs()
	}
	s.pruneOutbound(now, keep)
	return dropped, expired
}

func sentKey(channel, id string) string { return channel + "\x00" + id }

// saveOutbound writes outbound.json; the caller holds mu.
func (s *store) saveOutbound() error {
	err := writeState(filepath.Join(s.dir, outboundFile), outboundDoc{Version: 1, Places: s.places, Sends: s.sends, Sent: s.sent})
	s.broken = err
	if err == nil {
		s.outWrites++
	}
	return err
}

// seenAt is when this program took an item, for a place's last-seen time.
func seenAt(rec itemRec) time.Time {
	at := rec.TakenAt
	if at.IsZero() {
		at = rec.ReceivedAt
	}
	return at.UTC().Round(0)
}

// foldPlace takes an item into the places; the caller holds mu (or nobody else has the store yet). Only an item with
// a reply route counts: that is what gives the backend the router's permission to send there. An item that was
// skipped (an echo of our own message, a card click) moves the last-seen time and nothing else, so our own name never
// becomes the conversation's label. An item older than what the place already has changes nothing. It answers the
// place's key, whether anything changed, and whether what changed is more than the time and the newest item.
func (s *store) foldPlace(rec itemRec) (key string, changed, significant bool) {
	r := rec.Route
	// An item a route ignores is as if it had not been routed here: its conversation does not become a destination.
	if r == nil || r.Channel == "" || r.ConversationID == "" || rec.TagSource == tagSourceUnreadable || rec.Tag == actionIgnore {
		return "", false, false
	}
	key = destKey(r.Channel, r.Account, r.ConversationID)
	at := seenAt(rec)
	p := s.places[key]
	fresh := p == nil
	switch {
	case fresh:
		p = &placeRec{Channel: r.Channel, Account: r.Account, ConvID: r.ConversationID}
		s.places[key] = p
	case at.Before(p.LastSeen):
		return key, false, false
	}
	old := *p
	p.LastSeen = at
	if rec.ConvKind != "" {
		p.Kind = rec.ConvKind
	}
	if rec.ChatName != "" {
		p.ChatName = rec.ChatName
	}
	if rec.State != stateSkipped {
		if rec.SenderName != "" {
			p.Sender, p.Verdict = rec.SenderName, stamp(rec)
		}
		if rec.MessageID != "" {
			p.LastItem = rec.ID
		}
	}
	return key, fresh || *p != old, fresh || p.Kind != old.Kind || p.ChatName != old.ChatName || p.Sender != old.Sender || p.Verdict != old.Verdict
}

// placeKeyOf is the place an item belongs to: its reply route's conversation, else the envelope's.
func placeKeyOf(rec itemRec) string {
	if r := rec.Route; r != nil {
		return destKey(r.Channel, r.Account, r.ConversationID)
	}
	return destKey(rec.Channel, rec.Account, rec.ConvID)
}

// relabelPlace takes again from the journal what a place has from its messages: the last sender, the router's
// verdict on them, and the newest message a reply can name. It is for when an item that gave them turned out to be
// our own message (skipEchoes). With no message of somebody else left in the journal the place has none of the
// three: no name is better than our own. The caller holds mu; it answers whether the place changed.
func (s *store) relabelPlace(key string) bool {
	p := s.places[key]
	if p == nil {
		return false
	}
	newer := func(a, b *itemRec) bool {
		if at, bt := seenAt(*a), seenAt(*b); !at.Equal(bt) {
			return at.After(bt)
		}
		return before(*b, *a)
	}
	var from, last *itemRec
	for _, r := range s.items {
		if r.Route == nil || r.State == stateSkipped || r.TagSource == tagSourceUnreadable || placeKeyOf(*r) != key {
			continue
		}
		if r.SenderName != "" && (from == nil || newer(r, from)) {
			from = r
		}
		if r.MessageID != "" && (last == nil || newer(r, last)) {
			last = r
		}
	}
	old := *p
	p.Sender, p.Verdict, p.LastItem = "", "", ""
	if from != nil {
		p.Sender, p.Verdict = from.SenderName, stamp(*from)
	}
	if last != nil {
		p.LastItem = last.ID
	}
	return *p != old
}

// sawPlace remembers the conversation of an item just taken. Memory always has it; the file is written for a new
// conversation, a changed label, or once in placeTouchEvery (an inbound message must not cost a second fsync). A
// write that fails loses nothing that matters: the journal has the item, and the next start folds it in again.
func (s *store) sawPlace(rec itemRec) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key, changed, significant := s.foldPlace(rec)
	if !changed {
		return
	}
	now := time.Now()
	if !significant && now.Sub(s.placeSaved[key]) < placeTouchEvery {
		return
	}
	if s.saveOutbound() == nil {
		s.placeSaved[key] = now
	}
}

func (s *store) placesAll() []placeRec {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]placeRec, 0, len(s.places))
	for _, p := range s.places {
		out = append(out, *p)
	}
	return out
}

func (s *store) place(key string) (placeRec, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.places[key]
	if p == nil {
		return placeRec{}, false
	}
	return *p, true
}

// putSend keeps a new send durably, before the request that must not be repeated. When it cannot be written it is
// not kept in memory either, and the caller does not send.
func (s *store) putSend(rec sendRec) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sends[rec.Op] != nil {
		return errors.New("the send is already recorded")
	}
	r := rec
	s.sends[rec.Op] = &r
	if err := s.saveOutbound(); err != nil {
		delete(s.sends, rec.Op)
		return err
	}
	return nil
}

// updateSends changes every send change says it changed, with one write. Like update, a change stays in memory when
// the write fails.
func (s *store) updateSends(change func(*sendRec) bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, r := range s.sends {
		if change(r) {
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.saveOutbound()
}

func (s *store) send(op string) (sendRec, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.sends[op]
	if r == nil {
		return sendRec{}, false
	}
	return *r, true
}

// sendsSince are the sends asked at or after t, newest first.
func (s *store) sendsSince(t time.Time) []sendRec {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []sendRec
	for _, r := range s.sends {
		if !r.At.Before(t) {
			out = append(out, *r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.After(out[j].At)
		}
		return out[i].Op < out[j].Op
	})
	return out
}

// recentSends are the newest n sends.
func (s *store) recentSends(n int) []sendRec {
	all := s.sendsSince(time.Time{})
	return all[:min(n, len(all))]
}

// reusable is the send whose operation the same destination, reply target and text is asked under again: the newest
// one first asked at or after since (under its own operation id, so a call that continued it does not move the
// window) whose outcome is unknown and whose operation the router has not settled as unknown.
func (s *store) reusable(digest string, since time.Time) (sendRec, bool) {
	for _, r := range s.sendsSince(since) {
		if r.Digest == digest && r.Outcome == sendUnknown && r.SameAs == "" && !r.Spent {
			return r, true
		}
	}
	return sendRec{}, false
}

// claimEcho says whether an item is the echo of a send whose answer never said which message it became, and takes
// it for that send: a send into the item's conversation, of exactly the item's text, asked at or after since, whose
// outcome is unknown (or still open) and that no item was taken for yet. One send explains one item. An item of
// somebody the journal has another message from in that conversation is theirs, whatever it says.
func (s *store) claimEcho(convKey, textDigest, senderID, messageID string, since time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var send *sendRec
	for _, r := range s.sends {
		if r.ConvKey != convKey || r.TextDigest == "" || r.TextDigest != textDigest || r.Echo != "" || r.At.Before(since) ||
			r.Outcome != sendUnknown && r.Outcome != sendSending {
			continue
		}
		if send == nil || r.At.Before(send.At) {
			send = r
		}
	}
	if send == nil {
		return false
	}
	if senderID != "" {
		for _, r := range s.items {
			if r.SenderID == senderID && r.State != stateSkipped && placeKeyOf(*r) == convKey {
				return false
			}
		}
	}
	send.Echo = messageID
	_ = s.saveOutbound()
	return true
}

// noteSent remembers the platform ids of a message this program sent.
func (s *store) noteSent(channel string, ids []string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	added := false
	for _, id := range ids {
		if channel == "" || id == "" || s.sentIdx[sentKey(channel, id)] {
			continue
		}
		s.sent = append(s.sent, sentMsg{Channel: channel, ID: id, At: at.UTC()})
		s.sentIdx[sentKey(channel, id)] = true
		added = true
	}
	if added {
		_ = s.saveOutbound()
	}
}

// sentByUs says whether a channel message is one this program sent.
func (s *store) sentByUs(channel, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return id != "" && s.sentIdx[sentKey(channel, id)]
}

// skipEchoes turns items that are the echo of a message this program sent, and were taken before the send's answer
// said so, into skipped ones: only those nothing has been done with yet (in the Inbox, or waiting for a turn). Such
// an item was taken as somebody's message, so its conversation may be called by our own name and offer our own
// message as a reply target: the place takes both again from the messages that are left.
func (s *store) skipEchoes(channel string, ids []string) (changed int) {
	if len(ids) == 0 {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var places []string
	for _, r := range s.items {
		if r.Channel == channel && r.MessageID != "" && slices.Contains(ids, r.MessageID) &&
			(r.State == stateQueued || r.State == stateInbox && r.TagSource != tagSourceUnreadable) {
			r.State, r.Why = stateSkipped, whySelf
			changed++
			if key := placeKeyOf(*r); r.Route != nil && !slices.Contains(places, key) {
				places = append(places, key)
			}
		}
	}
	if changed == 0 {
		return 0
	}
	_ = s.saveItems()
	relabeled := false
	for _, key := range places {
		if s.relabelPlace(key) {
			relabeled = true
		}
	}
	if relabeled {
		_ = s.saveOutbound()
	}
	return changed
}

// pruneOutbound bounds outbound.json; the caller holds mu. A settled send older than keep goes (one under way never
// does), a conversation not seen for placeKeep, a sent message's id after sentKeep; beyond the caps the oldest go.
func (s *store) pruneOutbound(now time.Time, keep time.Duration) {
	changed := false
	var settled []*sendRec
	for op, r := range s.sends {
		switch {
		case r.Outcome == sendSending:
		case now.Sub(r.At) > keep:
			delete(s.sends, op)
			changed = true
		default:
			settled = append(settled, r)
		}
	}
	if over := len(s.sends) - sendsMost; over > 0 {
		sort.Slice(settled, func(i, j int) bool { return settled[i].At.Before(settled[j].At) })
		for _, r := range settled[:min(over, len(settled))] {
			delete(s.sends, r.Op)
			changed = true
		}
	}
	var places []string
	for key, p := range s.places {
		if now.Sub(p.LastSeen) > placeKeep {
			delete(s.places, key)
			delete(s.placeSaved, key)
			changed = true
			continue
		}
		places = append(places, key)
	}
	if over := len(places) - placesMost; over > 0 {
		sort.Slice(places, func(i, j int) bool { return s.places[places[i]].LastSeen.Before(s.places[places[j]].LastSeen) })
		for _, key := range places[:over] {
			delete(s.places, key)
			delete(s.placeSaved, key)
			changed = true
		}
	}
	kept := s.sent[:0:0]
	for _, m := range s.sent {
		if now.Sub(m.At) <= sentKeep {
			kept = append(kept, m)
		}
	}
	if over := len(kept) - sentMost; over > 0 {
		kept = kept[over:]
	}
	if len(kept) != len(s.sent) {
		s.sent, changed = kept, true
		s.sentIdx = map[string]bool{}
		for _, m := range kept {
			s.sentIdx[sentKey(m.Channel, m.ID)] = true
		}
	}
	if changed {
		_ = s.saveOutbound()
	}
}
