package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	rec := itemRec{ID: "a", ConvKey: "k", State: stateQueued, Route: &replyRoute{Channel: "c"}, SenderLabels: []string{"x"}}
	if added, err := st.add(rec); !added || err != nil {
		t.Fatalf("add: %v %v", added, err)
	}
	if added, err := st.add(rec); added || err != nil {
		t.Fatalf("the same id was added twice: %v %v", added, err)
	}
	if _, err := st.update("a", func(r *itemRec) { r.State, r.Run = stateRunning, &runRec{MsgID: "m", State: runSending} }); err != nil {
		t.Fatal(err)
	}
	if err := st.setConv("k", convRec{MachineID: "m1", SessionID: "s1", LastSeq: 7}); err != nil {
		t.Fatal(err)
	}
	// What a caller gets is a copy.
	got, _ := st.get("a")
	got.Run.State, got.Route.Channel, got.SenderLabels[0] = "changed", "changed", "changed"
	if again, _ := st.get("a"); again.Run.State != runSending || again.Route.Channel != "c" || again.SenderLabels[0] != "x" {
		t.Errorf("the store's record was changed through a copy: %+v", again)
	}
	st2, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	back, ok := st2.get("a")
	conv, hasConv := st2.conv("k")
	if !ok || back.State != stateRunning || back.Run == nil || back.Run.State != runSending || !hasConv || conv.LastSeq != 7 {
		t.Errorf("after reopening: %+v %+v", back, conv)
	}
	for _, name := range []string{journalFile, convsFile} {
		if info, err := os.Stat(filepath.Join(dir, name)); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v %v", name, info, err)
		}
		if _, err := os.Stat(filepath.Join(dir, name+".tmp")); err == nil {
			t.Errorf("%s.tmp was left behind", name)
		}
	}
}

func TestCorruptJournalStartsEmptyAndSaysSo(t *testing.T) {
	fr := newFakeRouter(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, journalFile), []byte(`{"version":1,"items":{"a":`), 0o600); err != nil {
		t.Fatal(err)
	}
	r := startRig(t, fr, newFakeHub(t), withDir(dir))
	st := r.waitState(wire.ConnectorStateOk)
	if st.Via != wordsStoreCorrupt {
		t.Errorf("status = %+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, journalFile+".corrupt")); err != nil {
		t.Errorf("the unreadable journal was not set aside: %v", err)
	}
	id := fr.add(itemOpt{text: "after", tag: "inbox"})
	r.waitItem(id, stateInbox)
	if len(journalOnDisk(t, dir)) != 1 {
		t.Errorf("the new journal does not have the new item")
	}
}

// TestPruneKeepsOpenAndRunning: an item on its way through a conversation is never dropped, and neither is an Inbox
// item the hub holds open, however old. An Inbox item older than the hub's window that the hub does not hold open is
// over: the hub never starts an item for a thing that old, so without this the journal and inbox.collect would grow
// for good (a muted chat, a backlog pushed late, an item filed while no other thread was open).
func TestPruneKeepsOpenAndRunning(t *testing.T) {
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	day := 24 * time.Hour
	old := now.Add(-40 * day)
	for _, rec := range []itemRec{
		{ID: "old-done", State: stateDone, ReceivedAt: old},
		{ID: "old-skipped", State: stateSkipped, ReceivedAt: old},
		{ID: "old-replied", State: stateInbox, ReceivedAt: old, Inbox: inboxRec{Done: "replied"}},
		// The hub listed these threads as open a day ago: it still holds them.
		{ID: "old-open", State: stateInbox, ReceivedAt: old, Inbox: inboxRec{SeenOpen: true, ListedAt: now.Add(-day)}},
		{ID: "old-failed-open", State: stateFailed, ReceivedAt: old, Inbox: inboxRec{SeenOpen: true, ListedAt: now.Add(-day)}},
		{ID: "old-queued", State: stateQueued, ReceivedAt: old},
		{ID: "old-running", State: stateRunning, ReceivedAt: old, Run: &runRec{State: runSent}},
		{ID: "new-done", State: stateDone, ReceivedAt: now},
		// Never listed by the hub (muted, or older than its window when it arrived), and past the window.
		{ID: "old-unlisted", State: stateInbox, ReceivedAt: old},
		{ID: "week-unlisted", State: stateInbox, ReceivedAt: now.Add(-8 * day)},
		// Listed once, then filed in the app with no settle call after it: the hub stopped holding it long ago.
		{ID: "week-dropped", State: stateFailed, ReceivedAt: now.Add(-20 * day), Inbox: inboxRec{SeenOpen: true, ListedAt: now.Add(-9 * day)}},
		// An old message whose round trip failed just now is a new step.
		{ID: "old-failed-now", State: stateFailed, ReceivedAt: now.Add(-8 * day), Inbox: inboxRec{Since: now.Add(-time.Hour)}},
		{ID: "new-open", State: stateInbox, ReceivedAt: now.Add(-6 * day)},
	} {
		if _, err := st.add(rec); err != nil {
			t.Fatal(err)
		}
	}
	dropped, expired := st.prune(now, 30*day)
	if dropped != 4 || expired != 3 {
		t.Errorf("dropped %d and expired %d, want 4 and 3", dropped, expired)
	}
	for _, id := range []string{"old-open", "old-failed-open", "old-queued", "old-running", "new-done", "old-failed-now", "new-open"} {
		if rec, ok := st.get(id); !ok || rec.Inbox.Closed {
			t.Errorf("%s was dropped or closed: %+v", id, rec.Inbox)
		}
	}
	for _, id := range []string{"old-done", "old-skipped", "old-replied", "old-unlisted"} {
		if st.has(id) {
			t.Errorf("%s was kept", id)
		}
	}
	// Past the window and within the retention: closed (no longer collected), kept as dedupe memory.
	for _, id := range []string{"week-unlisted", "week-dropped"} {
		if rec, ok := st.get(id); !ok || rec.Inbox.Done != "expired" || !rec.Inbox.Closed || rec.open() || !rec.finished() {
			t.Errorf("%s: %+v", id, rec.Inbox)
		}
	}
	// A second pass changes nothing.
	if dropped, expired := st.prune(now, 30*day); dropped+expired != 0 {
		t.Errorf("a second pass dropped %d and expired %d", dropped, expired)
	}
}

// TestPruneBoundsTheJournalAndTheMappings: beyond journalMost the oldest finished records go first, then the oldest
// Inbox items; a mapping nobody used for convKeep goes unless its conversation has an item under way.
func TestPruneBoundsTheJournalAndTheMappings(t *testing.T) {
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	// Filled in memory: a write per record would take a while and says nothing more.
	st.mu.Lock()
	for i := 0; i < journalMost+30; i++ {
		rec := &itemRec{ID: fmt.Sprintf("open-%05d", i), State: stateInbox, ReceivedAt: now.Add(time.Duration(i-journalMost-100) * time.Second),
			Inbox: inboxRec{SeenOpen: true, ListedAt: now}}
		st.items[rec.ID] = rec
	}
	for i := 0; i < 10; i++ {
		rec := &itemRec{ID: fmt.Sprintf("done-%02d", i), State: stateDone, ReceivedAt: now.Add(-time.Minute)}
		st.items[rec.ID] = rec
	}
	st.items["running"] = &itemRec{ID: "running", ConvKey: "busy", State: stateRunning, ReceivedAt: now.Add(-48 * time.Hour), Run: &runRec{State: runSent}}
	long := now.Add(-convKeep - time.Hour)
	st.convs["unused"] = convRec{MachineID: "m1", SessionID: "s1", OpenedAt: long, LastUsedAt: long}
	st.convs["busy"] = convRec{MachineID: "m1", SessionID: "s2", OpenedAt: long, LastUsedAt: long}
	st.convs["recent"] = convRec{MachineID: "m1", SessionID: "s3", OpenedAt: long, LastUsedAt: now.Add(-time.Hour)}
	st.mu.Unlock()
	dropped, _ := st.prune(now, 30*24*time.Hour)
	if want := 41; dropped != want {
		t.Errorf("dropped %d, want %d", dropped, want)
	}
	st.mu.Lock()
	left := len(st.items)
	st.mu.Unlock()
	if left != journalMost {
		t.Errorf("%d records left, want the cap of %d", left, journalMost)
	}
	if st.has("done-00") || st.has("done-09") || st.has("open-00000") || st.has("open-00030") || !st.has("open-00031") || !st.has("running") {
		t.Errorf("the wrong records went")
	}
	if _, ok := st.conv("unused"); ok {
		t.Errorf("a mapping unused for longer than convKeep was kept")
	}
	for _, key := range []string{"busy", "recent"} {
		if _, ok := st.conv(key); !ok {
			t.Errorf("the mapping %q was dropped", key)
		}
	}
	st2, err := openStore(st.dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := st2.conv("unused"); ok || !st2.has("running") || st2.has("done-00") {
		t.Errorf("the pruned state was not written")
	}
}
