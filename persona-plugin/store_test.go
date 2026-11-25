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

func placeItem(id, conv, sender, chat string, at time.Time) itemRec {
	return itemRec{ID: id, ConvKey: "demo-chat:default:" + conv, Channel: "demo-chat", Account: "default", ConvID: conv, ConvKind: "group",
		MessageID: "om_" + id, SenderName: sender, ChatName: chat, State: stateInbox, TakenAt: at, ReceivedAt: at,
		Route: &replyRoute{Channel: "demo-chat", Account: "default", ConversationID: conv, ThreadID: "t1", ReplyToMessageID: "om_" + id}}
}

// TestOutboundRoundTrip: the third file keeps the conversations seen, the sends and the ids of what was sent; a send
// found mid-request after a restart is unknown, never unsent.
func TestOutboundRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	st.sawPlace(placeItem("a", "oc_a", "Pat Person", "Room A", now))
	for _, rec := range []sendRec{
		{Op: "send-1", Dest: "d-1", ConvKey: "k", Digest: "x", Outcome: sendSending, At: now},
		{Op: "send-2", Dest: "d-1", ConvKey: "k", Digest: "y", Outcome: sendSending, At: now.Add(time.Second)},
	} {
		if err := st.putSend(rec); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.putSend(sendRec{Op: "send-1"}); err == nil {
		t.Errorf("an operation was recorded twice")
	}
	if err := st.updateSends(func(r *sendRec) bool {
		if r.Op != "send-2" {
			return false
		}
		r.Outcome, r.MessageID = sendDelivered, "pm_1"
		return true
	}); err != nil {
		t.Fatal(err)
	}
	st.noteSent("demo-chat", []string{"pm_1", "", "pm_1", "pm_2"}, now)
	if !st.sentByUs("demo-chat", "pm_1") || !st.sentByUs("demo-chat", "pm_2") || st.sentByUs("other", "pm_1") || st.sentByUs("demo-chat", "") {
		t.Errorf("sentByUs")
	}
	if info, err := os.Stat(filepath.Join(dir, outboundFile)); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("%s: %v %v", outboundFile, info, err)
	}
	if recent := st.recentSends(1); len(recent) != 1 || recent[0].Op != "send-2" {
		t.Errorf("recent = %+v", recent)
	}
	st2, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := st2.place("demo-chat:default:oc_a") // no thread in the key
	if !ok || p.ChatName != "Room A" || p.Sender != "Pat Person" || p.Kind != "group" || p.LastItem != "a" || !p.LastSeen.Equal(now.Round(0)) {
		t.Errorf("place = %+v %v", p, ok)
	}
	one, _ := st2.send("send-1")
	two, _ := st2.send("send-2")
	if one.Outcome != sendUnknown || one.Code != sendCodeRestart || one.SettledAt.IsZero() || two.Outcome != sendDelivered || two.MessageID != "pm_1" {
		t.Errorf("after reopening: %+v %+v", one, two)
	}
	if !st2.sentByUs("demo-chat", "pm_2") || len(st2.sent) != 2 {
		t.Errorf("sent after reopening: %+v", st2.sent)
	}
	if got, ok := st2.reusable("x", now.Add(-time.Minute)); !ok || got.Op != "send-1" {
		t.Errorf("reusable = %+v %v", got, ok)
	}
	if _, ok := st2.reusable("x", now.Add(time.Minute)); ok {
		t.Errorf("reusable ignores since")
	}
	// A send that continued the first one is not where the window starts, and an operation the router settled as
	// unknown is not asked under again.
	if err := st2.putSend(sendRec{Op: "send-3", Digest: "x", SameAs: "send-1", Outcome: sendUnknown, At: now.Add(2 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if _, ok := st2.reusable("x", now.Add(time.Minute)); ok {
		t.Errorf("a send that continued the first one moved the window")
	}
	_ = st2.updateSends(func(r *sendRec) bool { r.Spent = r.Op == "send-1"; return true })
	if got, ok := st2.reusable("x", now.Add(-time.Minute)); ok {
		t.Errorf("a spent operation is offered again: %+v", got)
	}
	// The restart's verdict was written, not only held in memory.
	st3, _ := openStore(dir)
	if again, _ := st3.send("send-1"); again.Outcome != sendUnknown || !again.SettledAt.Equal(one.SettledAt) {
		t.Errorf("the verdict was not written: %+v", again)
	}
}

func TestSendThatCannotBeRecordedIsNotKept(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes anywhere")
	}
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if err := st.putSend(sendRec{Op: "send-1", Outcome: sendSending, At: time.Now()}); err == nil {
		t.Fatalf("a send was recorded in a directory that cannot be written")
	}
	if _, ok := st.send("send-1"); ok {
		t.Errorf("the send stayed in memory")
	}
	if _, broken := st.health(); broken == nil {
		t.Errorf("the failed write is not reported")
	}
}

func TestPruneBoundsOutbound(t *testing.T) {
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	day := 24 * time.Hour
	st.mu.Lock()
	st.sends["old"] = &sendRec{Op: "old", Outcome: sendDelivered, At: now.Add(-40 * day)}
	st.sends["old-unknown"] = &sendRec{Op: "old-unknown", Outcome: sendUnknown, At: now.Add(-40 * day)}
	st.sends["old-sending"] = &sendRec{Op: "old-sending", Outcome: sendSending, At: now.Add(-40 * day)}
	for i := 0; i < sendsMost+20; i++ {
		op := fmt.Sprintf("s-%04d", i)
		st.sends[op] = &sendRec{Op: op, Outcome: sendRefused, At: now.Add(time.Duration(i-sendsMost-100) * time.Second)}
	}
	for i := 0; i < placesMost+5; i++ {
		key := fmt.Sprintf("demo-chat:default:oc_%04d", i)
		st.places[key] = &placeRec{Channel: "demo-chat", Account: "default", ConvID: fmt.Sprintf("oc_%04d", i), LastSeen: now.Add(time.Duration(i-1000) * time.Minute)}
	}
	st.places["gone"] = &placeRec{Channel: "demo-chat", Account: "default", ConvID: "gone", LastSeen: now.Add(-placeKeep - time.Hour)}
	st.mu.Unlock()
	st.noteSent("demo-chat", []string{"pm_old"}, now.Add(-sentKeep-time.Hour))
	st.noteSent("demo-chat", []string{"pm_new"}, now)
	st.prune(now, 30*day)
	st.mu.Lock()
	sends, places := len(st.sends), len(st.places)
	st.mu.Unlock()
	if sends != sendsMost || places != placesMost {
		t.Errorf("%d sends and %d places left, want the caps", sends, places)
	}
	for op, want := range map[string]bool{"old": false, "old-unknown": false, "old-sending": true, "s-0000": false, "s-0020": false, "s-0021": true} {
		if _, ok := st.send(op); ok != want {
			t.Errorf("send %s kept = %v", op, ok)
		}
	}
	for key, want := range map[string]bool{"gone": false, "demo-chat:default:oc_0000": false, "demo-chat:default:oc_0004": false, "demo-chat:default:oc_0005": true} {
		if _, ok := st.place(key); ok != want {
			t.Errorf("place %s kept = %v", key, ok)
		}
	}
	if st.sentByUs("demo-chat", "pm_old") || !st.sentByUs("demo-chat", "pm_new") {
		t.Errorf("sent ids were not bounded by age")
	}
	st.mu.Lock()
	for i := 0; i < sentMost+10; i++ {
		id := fmt.Sprintf("pm_%05d", i)
		st.sent = append(st.sent, sentMsg{Channel: "demo-chat", ID: id, At: now})
		st.sentIdx[sentKey("demo-chat", id)] = true
	}
	st.mu.Unlock()
	st.prune(now, 30*day)
	if len(st.sent) != sentMost || st.sentByUs("demo-chat", "pm_new") || st.sentByUs("demo-chat", "pm_00009") || !st.sentByUs("demo-chat", "pm_00010") {
		t.Errorf("%d sent ids left", len(st.sent))
	}
	st2, err := openStore(st.dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := st2.send("old"); ok || len(st2.sent) != sentMost || len(st2.places) != placesMost {
		t.Errorf("the pruned state was not written")
	}
}

// TestPlacesComeFromAnOlderJournal: a data directory written by a version without outbound.json has its
// conversations as destinations at the first start. An item without a reply route, a placeholder and an echo give
// no label.
func TestPlacesComeFromAnOlderJournal(t *testing.T) {
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	first := placeItem("a1", "oc_a", "Pat Person", "Room A", now.Add(-2*time.Hour))
	second := placeItem("a2", "oc_a", "Kim Person", "Room A2", now.Add(-time.Hour))
	echo := placeItem("a3", "oc_a", "The Account", "", now.Add(-time.Minute))
	echo.State = stateSkipped
	noRoute := placeItem("b1", "oc_b", "x", "", now)
	noRoute.Route = nil
	placeholder := placeItem("c1", "oc_c", "x", "", now)
	placeholder.TagSource = tagSourceUnreadable
	for _, rec := range []itemRec{second, first, echo, noRoute, placeholder} {
		if _, err := st.add(rec); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(dir, outboundFile)); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	st2, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	places := st2.placesAll()
	if len(places) != 1 {
		t.Fatalf("places = %+v", places)
	}
	if p := places[0]; p.ConvID != "oc_a" || p.ChatName != "Room A2" || p.Sender != "Kim Person" || p.LastItem != "a2" || !p.LastSeen.Equal(seenAt(echo)) {
		t.Errorf("place = %+v", p)
	}
	if _, err := os.Stat(filepath.Join(dir, outboundFile)); err != nil {
		t.Errorf("the places were not written: %v", err)
	}
	// Nothing new: the next start writes nothing.
	st3, _ := openStore(dir)
	if st3.outWrites != 0 {
		t.Errorf("a start with nothing new wrote outbound.json %d time(s)", st3.outWrites)
	}
}

func TestCorruptOutboundStartsEmptyAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, outboundFile), []byte(`{"version":1,"sends":{`), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if corrupt, _ := st.health(); !corrupt {
		t.Errorf("an unreadable outbound.json is not reported")
	}
	if _, err := os.Stat(filepath.Join(dir, outboundFile+".corrupt")); err != nil {
		t.Errorf("the unreadable file was not set aside: %v", err)
	}
}

// TestSeenPlaceIsWrittenRarely: an inbound message of a known conversation must not cost a second durable write.
func TestSeenPlaceIsWrittenRarely(t *testing.T) {
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	st.sawPlace(placeItem("a1", "oc_a", "Pat Person", "Room A", now))
	if st.outWrites != 1 {
		t.Fatalf("a new conversation: %d writes", st.outWrites)
	}
	for i := 2; i < 12; i++ {
		st.sawPlace(placeItem(fmt.Sprintf("a%d", i), "oc_a", "Pat Person", "Room A", now.Add(time.Duration(i)*time.Second)))
	}
	if p, _ := st.place("demo-chat:default:oc_a"); st.outWrites != 1 || p.LastItem != "a11" {
		t.Errorf("ten more messages: %d writes, place %+v", st.outWrites, p)
	}
	st.sawPlace(placeItem("a20", "oc_a", "Kim Person", "Room A", now.Add(time.Minute))) // the label changed
	if st.outWrites != 2 {
		t.Errorf("a changed label: %d writes", st.outWrites)
	}
	st.mu.Lock()
	st.placeSaved["demo-chat:default:oc_a"] = time.Now().Add(-placeTouchEvery - time.Minute)
	st.mu.Unlock()
	st.sawPlace(placeItem("a21", "oc_a", "Kim Person", "Room A", now.Add(2*time.Minute)))
	if st.outWrites != 3 {
		t.Errorf("after placeTouchEvery: %d writes", st.outWrites)
	}
}
