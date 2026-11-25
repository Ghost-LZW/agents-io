// Command agents-io is a Persona extension that connects one assistant (one manager) to an agents-io message router
// as one of the router's backends. The router owns the messaging channels: it receives messages from many channels
// and people, stamps who sent each one, routes by its rule table, queues durably per backend and delivers replies
// with idempotent operation ids. This program is the Persona side: it consumes the backend's queue, files items in
// the Inbox or hands them to an assistant conversation (by the tag the router's rule carries), and sends the answer
// back through the router.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/nwverse/persona/sdk/go/ext"
	"github.com/nwverse/persona/sdk/go/wire"
)

//go:embed persona-extension.json
var sourceManifest []byte

// manifest is the runtime manifest: without the source-only catalog fields, which strict older hubs refuse.
var manifest = func() []byte {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(sourceManifest, &fields); err != nil {
		panic(err)
	}
	delete(fields, "icon")
	delete(fields, "tags")
	data, err := json.Marshal(fields)
	if err != nil {
		panic(err)
	}
	return data
}()

var version = func() string {
	var m struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(manifest, &m)
	return m.Version
}()

// contributes is the manifest's contributions, which initialize answers.
var contributes = func() map[string]any {
	var m struct {
		Contributes map[string]any `json:"contributes"`
	}
	if err := json.Unmarshal(manifest, &m); err != nil {
		panic(err)
	}
	return m.Contributes
}()

const extensionID = "agents-io"

// timings are every wait of the program, in one place so tests can shrink them.
type timings struct {
	dial, hello, ack, deliver time.Duration
	pingEvery, pingTimeout    time.Duration
	backoffMin, backoffMax    time.Duration
	stable, refusedRetry      time.Duration

	tick, poll                   time.Duration
	quietGrace, answerSettle     time.Duration
	emptyGrace, queuedMost       time.Duration
	missingAfter                 time.Duration
	notSentRetry, notSentMost    time.Duration
	deliverWaitMost, unsureRetry time.Duration
	scopeRetryMost               time.Duration
	changedDebounce, capsEvery   time.Duration
	hubTimeout                   time.Duration

	// runsMost is not a wait: how many channel conversations may have a round trip under way at once.
	runsMost int
}

// defaultTimings follow the router's own (push answered within 30 s, server ping every 30 s) and the product's
// channel pipeline (QuietGrace 20 s, AnswerSettle 10 s, QueuedMost 10 min, MissingAfter 3 min).
var defaultTimings = timings{
	dial: 20 * time.Second, hello: 15 * time.Second, ack: 15 * time.Second, deliver: 2 * time.Minute,
	pingEvery: 25 * time.Second, pingTimeout: 10 * time.Second,
	backoffMin: time.Second, backoffMax: time.Minute, stable: time.Minute, refusedRetry: time.Minute,
	tick: time.Second, poll: 3 * time.Second,
	quietGrace: 20 * time.Second, answerSettle: 10 * time.Second, emptyGrace: 2 * time.Minute,
	queuedMost: 10 * time.Minute, missingAfter: 3 * time.Minute,
	notSentRetry: 5 * time.Second, notSentMost: 10 * time.Minute,
	deliverWaitMost: time.Hour, unsureRetry: 5 * time.Second, scopeRetryMost: 2 * time.Minute,
	changedDebounce: time.Second, capsEvery: 10 * time.Minute, hubTimeout: 2 * time.Minute,
	runsMost: 4,
}

// app is one run of the program: the settings it was started with (the hub restarts it when they change).
type app struct {
	tm timings

	mu        sync.Mutex
	set       settings
	off       bool   // the connector is turned off: nothing is started
	missing   string // why the settings cannot connect yet
	storeErr  bool
	st        *store
	rt        *router
	api       *hubClient
	lacking   []string // hub scopes not granted
	hubNotify *ext.Hub
	active    map[string]bool // channel conversations with a run under way
	markQuiet map[string]bool // channels whose marks the router refused: said once
	changed   *time.Timer
	// unreadable counts the pushed items this run could not read and filed as placeholders (status says so).
	unreadable int

	wakeCh chan struct{}
	bg     sync.WaitGroup // the worker: once it is over no run is started
	runs   sync.WaitGroup
}

func newApp(tm timings) *app {
	return &app{tm: tm, missing: wordsNotConfigured, active: map[string]bool{}, markQuiet: map[string]bool{},
		wakeCh: make(chan struct{}, 1)}
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("agents-io: ")
	ext.Main(program(newApp(defaultTimings)))
}

func program(x *app) ext.Program {
	return ext.Program{ID: extensionID, Version: version, Manifest: manifest,
		Init: x.init,
		Namespaces: map[string]ext.Handler{
			ext.ConnectorNamespace: ext.Methods{
				"status": ext.Method(func(ctx context.Context, p wire.ConnectorParams) (wire.ConnectorStatus, error) {
					return x.statusNow(), nil
				}),
				"tools.list": ext.Method(func(ctx context.Context, p wire.ConnectorParams) (wire.ConnectorTools, error) {
					return wire.ConnectorTools{Tools: []wire.ConnectorTool{aboutTool}}, nil
				}),
				"tools.call": ext.Method(func(ctx context.Context, p wire.ConnectorCallParams) (wire.ConnectorCallResult, error) {
					if p.Name != toolAboutName {
						return wire.ConnectorCallResult{}, &ext.Error{Message: "unknown tool " + p.Name}
					}
					return wire.ConnectorCallResult{Text: x.about()}, nil
				}),
				"inbox.collect": ext.Method(func(ctx context.Context, p wire.ConnectorParams) (collected, error) {
					return collected{Things: x.collect()}, nil
				}),
				"inbox.reply":  ext.Method(x.reply),
				"inbox.settle": ext.Method(x.settle),
			}.For(connectorID),
			"settings": x.settingsHandler,
		},
	}
}

// collected is inbox.collect's answer.
type collected struct {
	Things []thing `json:"things,omitempty"`
}

func (x *app) init(ctx context.Context, in *ext.Init, hub *ext.Hub) (map[string]any, error) {
	set := settingsOf(in.InitializeParams.Config, in.Secrets)
	x.mu.Lock()
	defer x.mu.Unlock()
	x.set, x.hubNotify = set, hub
	if on, said := in.Active["connectors"]; said && !slices.Contains(on, connectorID) {
		x.off = true
		log.Printf("start: the connector is off")
		return contributes, nil
	}
	if x.missing = set.missing(); x.missing != "" {
		log.Printf("start: not configured")
		return contributes, nil
	}
	dir := in.Info().DataDir
	if dir == "" {
		dir = ext.Env().Data
	}
	st, err := openStore(dir)
	if err != nil {
		x.storeErr = true
		log.Printf("start: the data directory cannot be used")
		return contributes, nil
	}
	x.st = st
	if st.corrupt {
		log.Printf("start: a state file was unreadable and set aside; starting empty for it")
	}
	url, token := in.Hub.URL, in.Hub.Token
	if url == "" || token == "" {
		env := ext.Env()
		url, token = env.HubURL, env.HubToken
	}
	x.lacking = lackingScopes(token, in.Hub.Scopes)
	if url != "" && len(x.lacking) == 0 {
		x.api = newHubClient(url, token, x.tm)
	}
	ws, _ := set.wsURL(os.Getenv)
	x.rt = newRouter(ws, set.key, &http.Client{}, x.tm)
	x.rt.onInbound = x.intake
	x.rt.onUp = x.wake
	log.Printf("start: chat=%v rules(chat=%d guest=%d) journal=%d", x.api != nil, len(set.chatRules), len(set.guestRules), len(st.items))
	go x.rt.run(ctx)
	x.bg.Add(1)
	go x.worker(ctx)
	return contributes, nil
}

func (x *app) settings() settings {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.set
}

func (x *app) store() *store {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.st
}

func (x *app) router() *router {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.rt
}

func (x *app) hub() *hubClient {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.api
}

func (x *app) hubReady() bool { return x.hub() != nil }

// inboxChanged tells the hub the connector's inbox changed, at most once per debounce period.
func (x *app) inboxChanged() {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.hubNotify == nil || x.changed != nil {
		return
	}
	hub := x.hubNotify
	x.changed = time.AfterFunc(x.tm.changedDebounce, func() {
		x.mu.Lock()
		x.changed = nil
		x.mu.Unlock()
		_ = hub.ConnectorChanged(connectorID, wire.ConnectorScopeInbox)
	})
}
