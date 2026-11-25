package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/exttest"
	"github.com/nwverse/persona/sdk/go/wire"
)

// logBuf collects everything the program logs during the tests: TestMain checks that no secret is ever in it.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

var logBuf = &syncBuf{}

// TestMain clears the environment's http proxy (the fakes listen on loopback, and with a proxy set the router's
// loopback address is dialed as host.persona.internal), and holds the whole run's log to "no secret, no message
// text".
func TestMain(m *testing.M) {
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		_ = os.Unsetenv(name)
	}
	log.SetFlags(0)
	log.SetOutput(logBuf)
	code := m.Run()
	out := logBuf.String()
	for _, secret := range []string{fakeKey, fakeHubToken, secretWords, "Sam Sample"} {
		if strings.Contains(out, secret) {
			fmt.Fprintf(os.Stderr, "the log contains %q\n", secret)
			code = 1
		}
	}
	os.Exit(code)
}

// secretWords is in the text of test messages: it must never reach the log.
const secretWords = "confidential-words-7731"

func fastTimings() timings {
	ms := time.Millisecond
	return timings{
		dial: 2 * time.Second, hello: time.Second, ack: 300 * ms, deliver: 300 * ms,
		pingEvery: 40 * ms, pingTimeout: 150 * ms,
		backoffMin: 10 * ms, backoffMax: 80 * ms, stable: 10 * time.Second, refusedRetry: 30 * ms,
		tick: 5 * ms, poll: 10 * ms,
		quietGrace: 60 * ms, answerSettle: 40 * ms, emptyGrace: 150 * ms,
		queuedMost: 250 * ms, missingAfter: 100 * ms,
		notSentRetry: 10 * ms, notSentMost: 400 * ms,
		deliverWaitMost: 2 * time.Second, unsureRetry: 20 * ms, scopeRetryMost: 200 * ms,
		changedDebounce: 10 * ms, capsEvery: time.Hour, hubTimeout: 2 * time.Second,
		runsMost: 4,
	}
}

// rig is the program between a fake router and a fake hub, started as the hub starts it.
type rig struct {
	t   *testing.T
	fr  *fakeRouter
	fh  *fakeHub
	x   *app
	h   *exttest.Host
	run exttest.Run
	dir string

	stopOnce sync.Once
}

type rigCfg struct {
	config map[string]any
	dir    string
	tm     timings
	adjust func(*wire.InitializeParams)
}

func withConfig(k string, v any) func(*rigCfg) { return func(c *rigCfg) { c.config[k] = v } }
func withDir(dir string) func(*rigCfg)         { return func(c *rigCfg) { c.dir = dir } }
func withTimings(change func(*timings)) func(*rigCfg) {
	return func(c *rigCfg) { change(&c.tm) }
}
func withInit(adjust func(*wire.InitializeParams)) func(*rigCfg) {
	return func(c *rigCfg) { c.adjust = adjust }
}

func startRig(t *testing.T, fr *fakeRouter, fh *fakeHub, opts ...func(*rigCfg)) *rig {
	t.Helper()
	cfg := rigCfg{config: map[string]any{"router_url": fr.url()}, tm: fastTimings()}
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.dir == "" {
		cfg.dir = t.TempDir()
	}
	r := &rig{t: t, fr: fr, fh: fh, x: newApp(cfg.tm), dir: cfg.dir}
	r.run = exttest.Serve(t, program(r.x))
	raw, _ := json.Marshal(cfg.config)
	r.h = exttest.StartWith(t, manifest, r.run, func(p *wire.InitializeParams) {
		p.Config = raw
		p.Secrets = map[string]string{"backend_key": fakeKey}
		p.Extension.DataDir = cfg.dir
		if fh != nil {
			p.Hub.URL, p.Hub.Token, p.Hub.Scopes = fh.url(), fakeHubToken, hubScopes
		}
		if cfg.adjust != nil {
			cfg.adjust(p)
		}
	})
	t.Cleanup(r.stop)
	return r
}

// stop ends the program as the hub does (its input closes) and waits for its runs.
func (r *rig) stop() { r.stopOnce.Do(r.stopNow) }

func (r *rig) stopNow() {
	_ = r.run.ToProgram.Close()
	select {
	case <-r.run.Exited:
	case <-time.After(5 * time.Second):
		r.t.Errorf("the program did not exit")
	}
	// The worker first: once it is over no run is started, so waiting for the runs cannot race with one starting.
	done := make(chan struct{})
	go func() { r.x.bg.Wait(); r.x.runs.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		r.t.Errorf("runs did not end")
	}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(3 * time.Millisecond)
	}
	t.Fatalf("never: %s", what)
}

// steady holds that ok stays true for a while.
func steady(t *testing.T, what string, d time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !ok() {
			t.Fatalf("did not hold: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *rig) status() wire.ConnectorStatus {
	r.t.Helper()
	var st wire.ConnectorStatus
	if err := r.h.Call("connector.status", wire.ConnectorParams{Contribution: connectorID}, &st); err != nil {
		r.t.Fatal(err)
	}
	return st
}

func (r *rig) waitState(state string) wire.ConnectorStatus {
	r.t.Helper()
	var st wire.ConnectorStatus
	eventually(r.t, "status "+state, func() bool { st = r.status(); return st.State == state })
	return st
}

// item is the journal's record of an item ({} when it has none).
func (r *rig) item(id string) itemRec {
	st := r.x.store()
	if st == nil {
		return itemRec{}
	}
	rec, _ := st.get(id)
	return rec
}

func (r *rig) waitItem(id, state string) itemRec {
	r.t.Helper()
	var rec itemRec
	eventually(r.t, "item "+state, func() bool { rec = r.item(id); return rec.State == state })
	return rec
}

// collected is inbox.collect through the protocol, as generic JSON.
func (r *rig) collect() []map[string]any {
	r.t.Helper()
	var res struct {
		Things []map[string]any `json:"things"`
	}
	if err := r.h.Call("connector.inbox.collect", wire.ConnectorParams{Contribution: connectorID}, &res); err != nil {
		r.t.Fatal(err)
	}
	return res.Things
}

func thingOf(things []map[string]any, thread string) map[string]any {
	for _, t := range things {
		if t["thread"] == thread {
			return t
		}
	}
	return nil
}

const demoThread = "demo-chat:default:oc_demo"
