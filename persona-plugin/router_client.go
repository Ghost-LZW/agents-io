package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	mrand "math/rand/v2"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Connection phases, also the kinds the log names.
const (
	phaseConnecting  = "connecting"
	phaseOK          = "ok"
	phaseUnreachable = "unreachable"
	phaseRefused     = "refused"
	phaseKeyRefused  = "key_refused"
	phaseNotBackend  = "not_backend"
	phaseReadKey     = "read_key"
	phaseNoBackends  = "no_backends"
	phaseLost        = "disconnected"
)

// phaseError is a failed connection attempt, by kind. It never carries the key or the address.
type phaseError struct{ phase string }

func (e *phaseError) Error() string { return "router: " + e.phase }

func phaseOf(err error) string {
	var pe *phaseError
	if errors.As(err, &pe) {
		return pe.phase
	}
	return phaseUnreachable
}

func wordsOfPhase(phase string) string {
	switch phase {
	case phaseKeyRefused:
		return wordsKeyRefused
	case phaseNotBackend:
		return wordsNotBackend
	case phaseReadKey:
		return wordsReadKey
	case phaseNoBackends:
		return wordsNoBackends
	case phaseRefused:
		return wordsRefused
	case phaseLost:
		return wordsDisconnected
	case phaseConnecting:
		return wordsConnecting
	}
	return wordsUnreachable
}

// routerError is the router's refusal of one request (result ok:false).
type routerError struct{ Code, Message string }

func (e *routerError) Error() string { return "router answered " + e.Code }

func routerCode(err error) string {
	var re *routerError
	if errors.As(err, &re) {
		return re.Code
	}
	return ""
}

var (
	// errDisconnected: there is no connection, nothing was sent.
	errDisconnected = errors.New("router: not connected")
	// errLost: the request was written and no answer came (the connection ended or the wait ran out): the outcome is
	// unknown.
	errLost = errors.New("router: no answer")
)

// link is one WebSocket connection: writes are serialized, one reader hands results to whoever waits for them.
type link struct {
	c   *websocket.Conn
	wmu sync.Mutex

	mu      sync.Mutex
	pending map[string]chan frame
	closed  chan struct{}
	once    sync.Once
}

func (l *link) shut() {
	l.once.Do(func() {
		close(l.closed)
		_ = l.c.CloseNow()
	})
}

func (l *link) write(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	l.wmu.Lock()
	defer l.wmu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return l.c.Write(ctx, websocket.MessageText, data)
}

// call sends one request and waits for its result.
func (l *link) call(ctx context.Context, typ string, fields map[string]any, wait time.Duration, out any) error {
	id := randomID()
	msg := map[string]any{"v": protocolV, "type": typ, "id": id}
	for k, v := range fields {
		msg[k] = v
	}
	ch := make(chan frame, 1)
	l.mu.Lock()
	l.pending[id] = ch
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.pending, id)
		l.mu.Unlock()
	}()
	select {
	case <-l.closed:
		return errDisconnected
	default:
	}
	if err := l.write(ctx, msg); err != nil {
		l.shut() // a failed write leaves the stream in an unknown state
		return errLost
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case f := <-ch:
		if !f.OK {
			if f.Error == nil {
				return &routerError{Code: codeInternal}
			}
			return &routerError{Code: f.Error.Code, Message: f.Error.Message}
		}
		if out != nil && len(f.Value) > 0 {
			if err := json.Unmarshal(f.Value, out); err != nil {
				return errLost
			}
		}
		return nil
	case <-l.closed:
		return errLost
	case <-t.C:
		return errLost
	case <-ctx.Done():
		return errLost
	}
}

func randomID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// linkState is the connection as the status reads it.
type linkState struct {
	phase       string
	backend     string
	features    []string
	since       time.Time // when the phase began
	connectedAt time.Time
	lastItem    time.Time
	flapping    bool
}

// router is the extension's connection to the agents-io router as one of its backends.
type router struct {
	wsURL, key string
	hc         *http.Client
	tm         timings
	// onInbound takes one pushed item and says whether it is durably taken (accepted).
	onInbound func(ctx context.Context, raw json.RawMessage) bool
	// onUp is called each time the push connection is up.
	onUp func()

	mu      sync.Mutex
	live    *link
	st      linkState
	backend string // learned by the probe; the key does not change while the program runs
}

func newRouter(wsURL, key string, hc *http.Client, tm timings) *router {
	return &router{wsURL: wsURL, key: key, hc: hc, tm: tm, st: linkState{phase: phaseConnecting, since: time.Now()}}
}

func (r *router) state() linkState {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.st
	st.features = slices.Clone(st.features)
	return st
}

func (r *router) setPhase(phase string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.st.phase != phase {
		r.st.phase, r.st.since = phase, time.Now()
		log.Printf("router: %s", phase)
	}
}

func (r *router) connected() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live != nil
}

// open dials the router and starts the connection's reader. The key travels in the Authorization header of the
// upgrade request, never in the address.
func (r *router) open(ctx context.Context, push bool) (*link, error) {
	dctx, cancel := context.WithTimeout(ctx, r.tm.dial)
	defer cancel()
	c, resp, err := websocket.Dial(dctx, r.wsURL, &websocket.DialOptions{
		HTTPClient:   r.hc,
		HTTPHeader:   http.Header{"Authorization": {"Bearer " + r.key}},
		Subprotocols: []string{subprotocol},
	})
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case http.StatusUnauthorized:
				return nil, &phaseError{phaseKeyRefused}
			case http.StatusForbidden, http.StatusBadRequest, http.StatusNotFound:
				return nil, &phaseError{phaseRefused}
			}
		}
		return nil, &phaseError{phaseUnreachable}
	}
	c.SetReadLimit(4 << 20)
	l := &link{c: c, pending: map[string]chan frame{}, closed: make(chan struct{})}
	go r.read(ctx, l, push)
	return l, nil
}

// read is the connection's only reader: it keeps pongs flowing, hands results to their callers and pushed items to
// the handler. Frame types it does not know are ignored, as the protocol asks.
func (r *router) read(ctx context.Context, l *link, push bool) {
	defer l.shut()
	for {
		typ, data, err := l.c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var f frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		switch f.Type {
		case frameResult:
			l.mu.Lock()
			ch := l.pending[f.ID]
			l.mu.Unlock()
			if ch != nil {
				select {
				case ch <- f:
				default:
				}
			}
		case frameInbound:
			if !push || r.onInbound == nil || f.ID == "" {
				continue
			}
			go func(f frame) {
				accepted := r.onInbound(ctx, f.Item)
				if accepted {
					r.mu.Lock()
					r.st.lastItem = time.Now()
					r.mu.Unlock()
				}
				_ = l.write(ctx, map[string]any{"v": protocolV, "type": frameResult, "id": f.ID, "ok": true,
					"value": map[string]any{"accepted": accepted}})
			}(f)
		}
	}
}

// hello says who the connection is. Without push it only asks (no role is taken on the router): the probe. With push
// it consumes the backend's own queue, replacing a half-open connection of the same backend.
func (r *router) hello(ctx context.Context, l *link, backend string) (helloResult, error) {
	fields := map[string]any{"token": r.key, "name": clientName}
	if backend != "" {
		fields["consumer"], fields["takeover"] = "backend:"+backend, true
	}
	var res helloResult
	if err := l.call(ctx, frameHello, fields, r.tm.hello, &res); err != nil {
		switch routerCode(err) {
		case codeUnauthorized:
			return res, &phaseError{phaseKeyRefused}
		case "":
			return res, &phaseError{phaseUnreachable}
		}
		return res, &phaseError{phaseRefused}
	}
	// The feature first: a router without backends never answers a backend block, so the missing feature is what
	// there is to say, whatever kind of key got in.
	if !slices.Contains(res.Features, featureBackends) {
		return res, &phaseError{phaseNoBackends}
	}
	if res.Backend == nil || res.Backend.ID == "" {
		return res, &phaseError{phaseNotBackend}
	}
	// A read key only observes: the router would refuse the consuming hello, every accept and every reply. Said by
	// the probe, so no consuming hello is ever sent with it. A router from before key levels says no access: its
	// keys are all read-write.
	if res.Backend.Access == accessRead {
		return res, &phaseError{phaseReadKey}
	}
	return res, nil
}

// probe connects, says hello without consuming and closes: it learns which backend the key is and whether the router
// has the backends feature. A key that is not a backend's (a host token pasted by mistake) is found out here, before
// any hello that takes a role, so this program can never take the router's host role.
func (r *router) probe(ctx context.Context) (helloResult, error) {
	l, err := r.open(ctx, false)
	if err != nil {
		return helloResult{}, err
	}
	defer l.shut()
	return r.hello(ctx, l, "")
}

// run keeps the push connection up until ctx ends: reconnecting with exponential backoff and jitter, slower while
// the router refuses the key.
func (r *router) run(ctx context.Context) {
	wait := r.tm.backoffMin
	short := 0
	for ctx.Err() == nil {
		up, err := r.session(ctx)
		if ctx.Err() != nil {
			return
		}
		phase := phaseOf(err)
		if up > 0 {
			phase = phaseLost
		}
		switch {
		case up >= r.tm.stable:
			wait, short = r.tm.backoffMin, 0
		case up > 0:
			short++
		}
		r.mu.Lock()
		r.st.flapping = short >= 5
		r.mu.Unlock()
		r.setPhase(phase)
		pause := jitter(wait)
		if phase == phaseKeyRefused || phase == phaseNotBackend || phase == phaseReadKey || phase == phaseNoBackends {
			pause = max(pause, r.tm.refusedRetry)
		}
		wait = min(wait*2, r.tm.backoffMax)
		if sleep(ctx, pause) != nil {
			return
		}
	}
}

func jitter(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.8 + 0.4*mrand.Float64()))
}

// session is one connection's life; it answers how long the push connection was up (0: it never was) and why it
// ended.
func (r *router) session(ctx context.Context) (time.Duration, error) {
	r.mu.Lock()
	backend := r.backend
	r.mu.Unlock()
	if backend == "" {
		res, err := r.probe(ctx)
		if err != nil {
			return 0, err
		}
		backend = res.Backend.ID
		r.mu.Lock()
		r.backend = backend
		r.mu.Unlock()
	}
	l, err := r.open(ctx, true)
	if err != nil {
		return 0, err
	}
	defer l.shut()
	res, err := r.hello(ctx, l, backend)
	if err != nil {
		return 0, err
	}
	if res.Backend.ID != backend { // the key now names another backend: learn it again
		r.mu.Lock()
		r.backend = ""
		r.mu.Unlock()
		return 0, &phaseError{phaseLost}
	}
	began := time.Now()
	r.mu.Lock()
	r.live = l
	r.st.phase, r.st.since, r.st.connectedAt = phaseOK, began, began
	r.st.backend, r.st.features = backend, res.Features
	r.mu.Unlock()
	log.Printf("router: connected (features %d)", len(res.Features))
	defer func() {
		r.mu.Lock()
		if r.live == l {
			r.live = nil
		}
		r.mu.Unlock()
	}()
	if r.onUp != nil {
		r.onUp()
	}
	ping := time.NewTicker(r.tm.pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return time.Since(began), ctx.Err()
		case <-l.closed:
			return time.Since(began), errLost
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, r.tm.pingTimeout)
			err := l.c.Ping(pctx)
			cancel()
			if err != nil {
				return time.Since(began), errLost
			}
		}
	}
}

// request sends one request on the push connection. errDisconnected: nothing was sent. errLost: the outcome is
// unknown. A *routerError is the router's own refusal.
func (r *router) request(ctx context.Context, typ string, fields map[string]any, wait time.Duration, out any) error {
	r.mu.Lock()
	l := r.live
	r.mu.Unlock()
	if l == nil {
		return errDisconnected
	}
	err := l.call(ctx, typ, fields, wait, out)
	if routerCode(err) == codeUnauthorized { // the key was rotated or revoked while connected
		r.setPhase(phaseKeyRefused)
		l.shut()
	}
	return err
}

// deliver sends words to a conversation. The router sends at most once per operation id: asking again with the same
// id answers the settled record.
func (r *router) deliver(ctx context.Context, opID string, route replyRoute, text string) (deliverResult, error) {
	var res deliverResult
	err := r.request(ctx, frameDeliver, map[string]any{"operationId": opID, "route": route,
		"message": renderedMessage{Text: text}}, r.tm.deliver, &res)
	return res, err
}

// mark puts the handling mark on a channel message. Cosmetic: nothing is recorded by the router.
func (r *router) mark(ctx context.Context, route replyRoute, messageID, state string) error {
	route.ReplyToMessageID = ""
	return r.request(ctx, frameAck, map[string]any{"route": route, "messageId": messageID, "state": state}, r.tm.ack, nil)
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
