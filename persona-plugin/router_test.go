package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

func (f *fakeRouter) helloList() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.hellos...)
}

func (f *fakeRouter) connectCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connects
}

func TestConnectHelloAndFeatures(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	st := r.waitState(wire.ConnectorStateOk)
	if st.Account != "backend:alpha" || st.LastSync.IsZero() || st.Error != "" {
		t.Errorf("status = %+v", st)
	}
	hellos := fr.helloList()
	if len(hellos) != 2 {
		t.Fatalf("hellos = %d, want a probe and a consuming one", len(hellos))
	}
	// The probe takes no role: a pasted host token is found out before any hello that would.
	if _, has := hellos[0]["consumer"]; has || hellos[0]["token"] != fakeKey || hellos[0]["name"] != clientName {
		t.Errorf("probe hello = %v", hellos[0])
	}
	if hellos[1]["consumer"] != "backend:alpha" || hellos[1]["takeover"] != true || hellos[1]["token"] != fakeKey {
		t.Errorf("consuming hello = %v", hellos[1])
	}
	for _, h := range hellos {
		if h["v"] != float64(1) || h["id"] == "" {
			t.Errorf("frame without v or id: %v", h)
		}
	}
}

func TestNoBackendsFeatureIsSaid(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) { f.features = []string{"deliver.update", "message.ack"} })
	r := startRig(t, fr, newFakeHub(t))
	var st wire.ConnectorStatus
	eventually(t, "the missing feature is said", func() bool { st = r.status(); return st.Error == wordsNoBackends })
	if st.State != wire.ConnectorStateError || !strings.Contains(st.Error, "backends") {
		t.Errorf("status = %+v", st)
	}
	time.Sleep(100 * time.Millisecond) // several retries
	for _, h := range fr.helloList() {
		if _, has := h["consumer"]; has {
			t.Fatalf("a consuming hello was sent to a router without backends: %v", h)
		}
	}
	// The router is upgraded: the next attempt connects.
	fr.set(func(f *fakeRouter) { f.features = []string{"backends"} })
	r.waitState(wire.ConnectorStateOk)
}

func TestHostTokenIsRefusedLocally(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) { f.noBackend = true })
	r := startRig(t, fr, newFakeHub(t))
	eventually(t, "not a backend key is said", func() bool { return r.status().Error == wordsNotBackend })
	time.Sleep(100 * time.Millisecond)
	for _, h := range fr.helloList() {
		if _, has := h["consumer"]; has {
			t.Fatalf("a consuming hello was sent with a key that is no backend's: %v", h)
		}
	}
}

// A read key (the router's `aio backend key <id> --read`) only observes. The probe's hello says so, and the program
// says so in turn instead of asking to consume and being refused for a reason it could not name.
func TestReadKeyIsSaidAndNeverConsumes(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) { f.access = "read" })
	r := startRig(t, fr, newFakeHub(t))
	var st wire.ConnectorStatus
	eventually(t, "the read key is said", func() bool { st = r.status(); return st.Error == wordsReadKey })
	if st.State != wire.ConnectorStateError || len(st.Guide) == 0 || !strings.Contains(st.Error, "--read") {
		t.Errorf("status = %+v", st)
	}
	time.Sleep(100 * time.Millisecond) // several retries
	for _, h := range fr.helloList() {
		if _, has := h["consumer"]; has {
			t.Fatalf("a consuming hello was sent with a read key: %v", h)
		}
	}
	// The read-write key is put in its place (here: the router answers the other level): the next attempt connects.
	fr.set(func(f *fakeRouter) { f.access = "readwrite" })
	r.waitState(wire.ConnectorStateOk)
}

func TestKeyRefusedAtUpgrade(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) { f.key = "aiob_another_key_not_real" })
	r := startRig(t, fr, newFakeHub(t))
	st := r.waitState(wire.ConnectorStateNotSignedIn)
	if st.Error != wordsKeyRefused || len(st.Guide) == 0 {
		t.Errorf("status = %+v", st)
	}
	n := fr.connectCount()
	eventually(t, "it keeps trying", func() bool { return fr.connectCount() > n+1 })
	if len(fr.helloList()) != 0 {
		t.Errorf("a hello was sent on a refused upgrade")
	}
	// The key is put right on the router (rotated back): it connects.
	fr.set(func(f *fakeRouter) { f.key = fakeKey })
	r.waitState(wire.ConnectorStateOk)
}

func TestKeyRevokedWhileConnected(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	r.waitState(wire.ConnectorStateOk)
	fr.set(func(f *fakeRouter) { f.key = "aiob_rotated_key_not_real" })
	fr.dropAll()
	r.waitState(wire.ConnectorStateNotSignedIn)
}

func TestReconnectsWithBackoff(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	r.waitState(wire.ConnectorStateOk)
	first := r.status().LastSync
	for i := 0; i < 3; i++ {
		n := len(fr.helloList())
		fr.dropAll()
		eventually(t, "reconnected", func() bool { return len(fr.helloList()) > n && r.status().State == wire.ConnectorStateOk })
	}
	if !r.status().LastSync.After(first) {
		t.Errorf("last_sync did not move with the new connection")
	}
	// The backend id is learned once: later connections go straight to the consuming hello.
	hellos := fr.helloList()
	if len(hellos) != 5 {
		t.Errorf("hellos = %d, want 1 probe + 4 consuming", len(hellos))
	}
	// While the router is away the status says so, and the pauses grow up to the limit.
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 503 })
	fr.dropAll()
	st := r.waitState(wire.ConnectorStateError)
	if !strings.Contains(st.Error, "连") {
		t.Errorf("status = %+v", st)
	}
	n := fr.connectCount()
	time.Sleep(400 * time.Millisecond)
	if tries := fr.connectCount() - n; tries < 3 || tries > 25 {
		t.Errorf("%d attempts in 400 ms with a backoff of 10…80 ms", tries)
	}
	fr.set(func(f *fakeRouter) { f.upgradeStatus = 0 })
	r.waitState(wire.ConnectorStateOk)
}

func TestBackoffGrowsAndJitters(t *testing.T) {
	for i := 0; i < 200; i++ {
		if d := jitter(time.Second); d < 800*time.Millisecond || d > 1200*time.Millisecond {
			t.Fatalf("jitter(1s) = %v", d)
		}
	}
}

func TestUnknownFramesAreIgnored(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) {
		f.extras = []map[string]any{
			{"v": 1, "type": "attention.changed", "sessionKey": "s", "attention": map[string]any{}},
			{"v": 1, "type": "policy", "id": "p1", "hook": "route"},
			{"v": 2, "type": "something.new", "id": "x"},
			{"v": 1, "type": "result", "id": "nobody-waits-for-this", "ok": true},
		}
	})
	id := fr.add(itemOpt{text: "hello", tag: "inbox"})
	r := startRig(t, fr, newFakeHub(t))
	r.waitItem(id, stateInbox)
	if st := r.status(); st.State != wire.ConnectorStateOk || st.LastEvent.IsZero() {
		t.Errorf("status = %+v", st)
	}
}

func TestPingKeepsHalfOpenShort(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	r.waitState(wire.ConnectorStateOk)
	n := fr.connectCount()
	// The router's side goes silent without closing: only the client's ping finds out.
	fr.set(func(f *fakeRouter) { f.mute = true })
	fr.dropAll()
	eventually(t, "connected to the silent router", func() bool { return fr.connectCount() > n })
	n = fr.connectCount()
	eventually(t, "the half-open connection was given up", func() bool { return fr.connectCount() > n })
	fr.set(func(f *fakeRouter) { f.mute = false })
	fr.dropAll()
	r.waitState(wire.ConnectorStateOk)
}

func TestSettingsCheck(t *testing.T) {
	fr := newFakeRouter(t)
	x := newApp(fastTimings())
	check := func(url, key string) wire.SettingsCheckResult {
		t.Helper()
		cfg, _ := json.Marshal(map[string]any{"router_url": url})
		raw, _ := json.Marshal(wire.SettingsCheckParams{Config: cfg, Secrets: map[string]string{"backend_key": key}})
		res, err := x.settingsHandler(t.Context(), "check", raw)
		if err != nil {
			t.Fatal(err)
		}
		out := res.(wire.SettingsCheckResult)
		if strings.Contains(out.Error, key) && key != "" {
			t.Errorf("the answer carries the key")
		}
		return out
	}
	if res := check(fr.url(), fakeKey); !res.Ok {
		t.Errorf("good settings refused: %+v", res)
	}
	if hellos := fr.helloList(); len(hellos) != 1 || hellos[0]["consumer"] != nil {
		t.Errorf("the check consumes nothing: %v", hellos)
	}
	if res := check(fr.url(), "aiob_wrong_key_not_real"); res.Ok || res.Error != wordsKeyRefused {
		t.Errorf("wrong key: %+v", res)
	}
	if res := check("ftp://router.example.test", fakeKey); res.Ok || res.Error != wordsAddressForm {
		t.Errorf("bad address: %+v", res)
	}
	// Part of the settings may be saved: nothing to try yet.
	if res := check("", fakeKey); !res.Ok {
		t.Errorf("no address: %+v", res)
	}
	if res := check(fr.url(), ""); !res.Ok {
		t.Errorf("no key: %+v", res)
	}
	fr.set(func(f *fakeRouter) { f.features = []string{"message.ack"} })
	if res := check(fr.url(), fakeKey); res.Ok || res.Error != wordsNoBackends {
		t.Errorf("no backends: %+v", res)
	}
	fr.set(func(f *fakeRouter) { f.features, f.noBackend = []string{"backends"}, true })
	if res := check(fr.url(), fakeKey); res.Ok || res.Error != wordsNotBackend {
		t.Errorf("host token: %+v", res)
	}
	// A read key is refused before it is saved; the level a router of today says for the usual key is not.
	fr.set(func(f *fakeRouter) { f.noBackend, f.access = false, "read" })
	if res := check(fr.url(), fakeKey); res.Ok || res.Error != wordsReadKey {
		t.Errorf("read key: %+v", res)
	}
	fr.set(func(f *fakeRouter) { f.access = "readwrite" })
	if res := check(fr.url(), fakeKey); !res.Ok {
		t.Errorf("read-write key of a router with key levels refused: %+v", res)
	}
	fr.set(func(f *fakeRouter) { f.noBackend, f.upgradeStatus = false, 403 })
	if res := check(fr.url(), fakeKey); res.Ok || res.Error != wordsRefused {
		t.Errorf("refused upgrade: %+v", res)
	}
	dead := newFakeRouter(t)
	url := dead.url()
	dead.srv.Close()
	if res := check(url, fakeKey); res.Ok || res.Error != wordsUnreachable {
		t.Errorf("unreachable: %+v", res)
	}
	if _, err := x.settingsHandler(t.Context(), "nope", nil); err == nil {
		t.Errorf("settings.nope was answered")
	}
}

// TestSettingsCheckThroughTheHub asks settings.check the way the hub does.
func TestSettingsCheckThroughTheHub(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	cfg, _ := json.Marshal(map[string]any{"router_url": fr.url()})
	var res wire.SettingsCheckResult
	if err := r.h.Call("settings.check", wire.SettingsCheckParams{Config: cfg, Secrets: map[string]string{"backend_key": fakeKey}}, &res); err != nil || !res.Ok {
		t.Errorf("settings.check: %+v %v", res, err)
	}
	if err := r.h.Call("settings.check", wire.SettingsCheckParams{Config: cfg, Secrets: map[string]string{"backend_key": "aiob_wrong_key_not_real"}}, &res); err != nil || res.Ok {
		t.Errorf("settings.check with a wrong key: %+v %v", res, err)
	}
}

func TestStatusWhenNotConfiguredOrOff(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t), withConfig("router_url", ""))
	if st := r.status(); st.State != wire.ConnectorStateNotConfigured || st.Error != wordsNoAddress || len(st.Guide) == 0 {
		t.Errorf("no address: %+v", st)
	}
	r = startRig(t, fr, newFakeHub(t), withInit(func(p *wire.InitializeParams) { p.Secrets = nil }))
	if st := r.status(); st.State != wire.ConnectorStateNotConfigured || st.Error != wordsNoKey {
		t.Errorf("no key: %+v", st)
	}
	// The connector is turned off in the app: nothing is started.
	r = startRig(t, fr, newFakeHub(t), withInit(func(p *wire.InitializeParams) { p.Active = map[string][]string{"connectors": {}} }))
	time.Sleep(50 * time.Millisecond)
	if st := r.status(); st.State == wire.ConnectorStateOk || fr.connectCount() != 0 {
		t.Errorf("off: %+v, %d connections", st, fr.connectCount())
	}
}

func TestStatusSaysMissingHubScopes(t *testing.T) {
	fr := newFakeRouter(t)
	fh := newFakeHub(t)
	r := startRig(t, fr, fh, withInit(func(p *wire.InitializeParams) { p.Hub.Scopes = []string{"agents.read"} }))
	st := r.waitState(wire.ConnectorStateNoPermission)
	if st.Error != wordsHubMissing || len(st.MissingScopes) != 2 {
		t.Errorf("status = %+v", st)
	}
	// Without the scopes a chat item is not lost: it goes to the Inbox, and nothing is asked of the hub.
	id := fr.add(itemOpt{text: "hi", tag: "chat"})
	rec := r.waitItem(id, stateInbox)
	if rec.Why != whyNoHub {
		t.Errorf("why = %q", rec.Why)
	}
	if opens, sends := fh.counts(); opens+sends != 0 {
		t.Errorf("the hub was asked without the scopes")
	}
}

// TestKeyNeverInWords holds every sentence the program can show to "no key in it"; the log is held by TestMain.
func TestKeyNeverInWords(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	r.waitState(wire.ConnectorStateOk)
	var seen []string
	note := func() {
		b, _ := json.Marshal(r.status())
		seen = append(seen, string(b))
	}
	note()
	fr.set(func(f *fakeRouter) { f.key = "aiob_changed_key_not_real" })
	fr.dropAll()
	r.waitState(wire.ConnectorStateNotSignedIn)
	note()
	var res wire.ConnectorCallResult
	if err := r.h.Call("connector.tools.call", wire.ConnectorCallParams{Contribution: connectorID, Name: toolAboutName}, &res); err != nil {
		t.Fatal(err)
	}
	seen = append(seen, res.Text)
	for _, s := range seen {
		if strings.Contains(s, fakeKey) || strings.Contains(s, fakeHubToken) || strings.Contains(s, fr.url()) {
			t.Errorf("a secret or the address is in: %s", s)
		}
	}
	if !strings.Contains(logBuf.String(), "router: connected") {
		t.Errorf("the log does not say the connection came up")
	}
}

// TestRouterWithoutBackendsIsSaidWhateverTheKey: a router without the backends feature never answers a backend
// block, so the missing feature is what the status says, not "this is not a backend key".
func TestRouterWithoutBackendsIsSaidWhateverTheKey(t *testing.T) {
	fr := newFakeRouter(t)
	fr.set(func(f *fakeRouter) { f.features, f.noBackend = []string{"deliver.update", "message.ack"}, true })
	r := startRig(t, fr, newFakeHub(t))
	var st wire.ConnectorStatus
	eventually(t, "the missing feature is said", func() bool { st = r.status(); return st.Error == wordsNoBackends })
	if st.State != wire.ConnectorStateError || len(st.Guide) == 0 {
		t.Errorf("status = %+v", st)
	}
	for _, h := range fr.helloList() {
		if _, has := h["consumer"]; has {
			t.Fatalf("a consuming hello was sent: %v", h)
		}
	}
	// The sentence for a refused key names the case that cannot be told apart from it.
	if !strings.Contains(wordsKeyRefused, "backends") || !strings.Contains(wordsKeyRefused, keyPrefix) {
		t.Errorf("wordsKeyRefused = %q", wordsKeyRefused)
	}
}
