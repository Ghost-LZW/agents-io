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

// The extension's own storage: two JSON files in its data directory. journal.json has one record per queue item the
// router pushed (the dedupe key of the at-least-once contract, and the state of its handling); conversations.json
// maps a channel conversation to the assistant conversation that answers it. Files are 0600 and replaced atomically
// (temporary file, fsync, rename, directory fsync).

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
)

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

// convRec is the assistant conversation that answers one channel conversation.
type convRec struct {
	MachineID  string    `json:"machine_id"`
	SessionID  string    `json:"session_id"`
	Guest      bool      `json:"guest,omitempty"`
	OpenedAt   time.Time `json:"opened_at,omitzero"`
	LastUsedAt time.Time `json:"last_used_at,omitzero"`
	LastSeq    int64     `json:"last_seq,omitempty"`
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
}

// openStore reads the two files. An unreadable one is moved aside (.corrupt) and the store starts empty for it; that
// is reported in the status, since items handled before may then be handled once more.
func openStore(dir string) (*store, error) {
	if dir == "" {
		return nil, errors.New("no data directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &store{dir: dir, items: map[string]*itemRec{}, convs: map[string]convRec{}}
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
		if r.ConvKey == key && (r.State == stateQueued || r.State == stateRunning) {
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
	return dropped, expired
}
