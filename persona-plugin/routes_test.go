package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/sdk/go/wire"
)

func withRoutes(lines ...string) func(*rigCfg) { return withConfig("routes", lines) }

func TestParseRoutes(t *testing.T) {
	good, bad := parseRoutes([]string{
		"  ai: channel=demo-chat account=default from=owner prefix=/ai -> launch:coder ",
		"",
		"mine: from=owner -> ignore",
		"people: kind=dm,other from!=owner -> inbox",
		"at-me: kind=group,thread mentions=ou_example,ou_other -> inbox",
		"bots: addressed=yes conv!=oc_a,oc_b -> chat",
		"rest: -> ignore",
		"all_2: * -> guest",
		"review:from=family->agent:reviewer",
	})
	type ruleWant struct {
		Name   string
		Conds  []routeCond
		Action string
		Target string
	}
	want := []ruleWant{
		{"ai", []routeCond{{condChannel, false, []string{"demo-chat"}}, {condAccount, false, []string{"default"}},
			{condFrom, false, []string{"owner"}}, {condPrefix, false, []string{"/ai"}}}, tagLaunch, "coder"},
		{"mine", []routeCond{{condFrom, false, []string{"owner"}}}, actionIgnore, ""},
		{"people", []routeCond{{condKind, false, []string{"dm", "other"}}, {condFrom, true, []string{"owner"}}}, tagInbox, ""},
		{"at-me", []routeCond{{condKind, false, []string{"group", "thread"}}, {condMentions, false, []string{"ou_example", "ou_other"}}}, tagInbox, ""},
		{"bots", []routeCond{{condAddressed, false, []string{"yes"}}, {condConv, true, []string{"oc_a", "oc_b"}}}, tagChat, ""},
		{"rest", nil, actionIgnore, ""},
		{"all_2", nil, tagGuest, ""},
		{"review", []routeCond{{condFrom, false, []string{"family"}}}, tagAgent, "reviewer"},
	}
	if len(bad) != 0 || len(good) != len(want) {
		t.Fatalf("good = %+v, bad = %+v", good, bad)
	}
	for i, r := range good {
		if r.Line == 0 {
			t.Errorf("rule %d has no line number", i+1)
		}
		if fmt.Sprint(ruleWant{r.Name, r.Conds, r.Action, r.Target}) != fmt.Sprint(want[i]) {
			t.Errorf("rule %d = %+v, want %+v", i+1, r, want[i])
		}
	}
	for line, why := range map[string]string{
		"no colon -> inbox":                    wordsRouteForm,
		"name: from=owner":                     wordsRouteForm, // no arrow
		"name: from=owner → inbox":             wordsRouteForm, // not the half-width arrow
		"from=owner -> inbox":                  wordsRouteForm, // no name: the first colon is too late
		"Name: -> inbox":                       wordsRouteName,
		"my rule: -> inbox":                    wordsRouteName,
		"规则: -> inbox":                         wordsRouteName,
		strings.Repeat("n", 33) + ": -> inbox": wordsRouteName,
		"a: -> archive":                        wordsRouteAction,
		"a: -> Inbox":                          wordsRouteAction,
		"a: -> agent":                          wordsRouteAction,
		"a: -> agent:":                         wordsRouteAction,
		"a: -> agent:Reviewer":                 wordsRouteAction,
		"a: -> agent:mac-1/s-1":                wordsRouteAction,
		"a: from=owner -> launch:":             wordsRouteAction,
		"a: -> inbox chat":                     wordsRouteAction,
		"a: owner -> inbox":                    wordsRouteCond,
		"a: from = owner -> inbox":             wordsRouteCond, // spaces separate conditions
		"a: sender=ou_x -> inbox":              wordsRouteKey,
		"a: Kind=dm -> inbox":                  wordsRouteKey,
		"a: kind=dm,,group -> inbox":           wordsRouteValue,
		"a: kind= -> inbox":                    wordsRouteValue,
		"a: conv=" + strings.Repeat("c", 257) + " -> inbox":  wordsRouteValue,
		"a: from=" + strings.Repeat("l", 41) + " -> inbox":   wordsRouteValue,
		"a: kind=private -> inbox":                           wordsRouteKind,
		"a: addressed=true -> inbox":                         wordsRouteAddressed,
		"a: addressed!=yes -> inbox":                         wordsRouteAddressed,
		"a: addressed=yes,no -> inbox":                       wordsRouteAddressed,
		"a: prefix!=/ai -> inbox":                            wordsRoutePrefix,
		"a: prefix=" + strings.Repeat("p", 33) + " -> inbox": wordsRoutePrefix,
		"a: kind=dm kind=group -> inbox":                     wordsRouteCondTwice,
		"a: kind=dm kind!=group -> inbox":                    wordsRouteCondTwice,
		"a: prefix=/ai -> launch:coder":                      wordsRouteLaunchOwner, // a launch rule says it is the owner's
		"a: from=owner,family -> launch:coder":               wordsRouteLaunchOwner,
		"a: from!=owner -> launch:coder":                     wordsRouteLaunchOwner,
		"a: conv=" + fakeKey + " -> inbox":                   wordsRouteSecret,
		"a: conv=https://hub.example.test -> inbox":          wordsRouteSecret,
		"a: -> inbox " + strings.ToUpper(fakeKey[:5]):        wordsRouteSecret,
	} {
		good, bad := parseRoutes([]string{"ok: -> inbox", line})
		if len(good) != 1 || len(bad) != 1 || bad[0].Line != 2 || bad[0].Why != why {
			t.Errorf("%q: good %d, bad %+v, want %q", line, len(good), bad, why)
		}
		for _, p := range bad {
			if strings.Contains(p.Why, fakeKey) {
				t.Errorf("the reason repeats the line")
			}
		}
	}
	_, bad = parseRoutes([]string{"a: -> inbox", "a: kind=dm -> chat", "b: -> inbox"})
	if len(bad) != 1 || bad[0] != (destProblem{2, wordsRouteNameTwice}) {
		t.Errorf("duplicates: %+v", bad)
	}
	var many []string
	for i := 0; i < routesMost+3; i++ {
		many = append(many, fmt.Sprintf("r%d: conv=oc_%d -> inbox", i, i))
	}
	good, bad = parseRoutes(many)
	if len(good) != routesMost || len(bad) != 1 || bad[0] != (destProblem{routesMost + 1, wordsRouteTooMany}) {
		t.Errorf("too many: %d good, bad %+v", len(good), bad)
	}
	s := settingsOf(json.RawMessage(`{"routes":["a: -> inbox","nonsense"]}`), nil)
	if len(s.routes) != 1 || len(s.badRoutes) != 1 || s.badRoutes[0].Line != 2 {
		t.Errorf("settings: %+v %+v", s.routes, s.badRoutes)
	}
}

func textBlocks(texts ...string) []contentBlock {
	var out []contentBlock
	for _, t := range texts {
		out = append(out, contentBlock{Type: "text", Text: t})
	}
	return out
}

func TestRouteMatching(t *testing.T) {
	s := settingsOf(json.RawMessage(`{"routes":[
		"ai: channel=demo-chat account=default from=owner prefix=/ai,/AGENT -> launch:coder",
		"mine: channel=demo-chat account=default from=owner -> ignore",
		"people: channel=demo-chat kind=dm,other -> inbox",
		"at-me: channel=demo-chat kind=group,thread mentions=ou_me -> inbox",
		"bot-at: channel=bot-chat addressed=yes -> chat",
		"family: from=family,friends conv!=oc_noisy -> guest",
		"strangers: from=unknown -> inbox",
		"rest: channel=demo-chat -> ignore"],
		"launchers":["coder = mac-1/claude"]}`), nil)
	if len(s.badRoutes) != 0 || len(s.routes) != 8 {
		t.Fatalf("routes %+v bad %+v", s.routes, s.badRoutes)
	}
	owner := routeFacts{channel: "demo-chat", account: "default", kind: "group", conv: "oc_a", known: true, labels: []string{"owner"}}
	other := routeFacts{channel: "demo-chat", account: "default", kind: "other", conv: "oc_b", known: true, labels: []string{"family"}}
	stranger := routeFacts{channel: "demo-chat", account: "default", kind: "group", conv: "oc_c"}
	with := func(f routeFacts, change func(*routeFacts)) routeFacts { change(&f); return f }
	for _, tc := range []struct {
		name string
		f    routeFacts
		want string
		text string // the first text block handed on, for a prefix rule
	}{
		{"the owner's trigger", with(owner, func(f *routeFacts) { f.content = textBlocks("  /ai fix the build") }), "ai", "fix the build"},
		{"no space after it", with(owner, func(f *routeFacts) { f.content = textBlocks("/ai修一下") }), "ai", "修一下"},
		{"any case", with(owner, func(f *routeFacts) { f.content = textBlocks("/Ai fix") }), "ai", "fix"},
		{"the second prefix", with(owner, func(f *routeFacts) { f.content = textBlocks("/agent look") }), "ai", "look"},
		{"a quote before it", with(owner, func(f *routeFacts) {
			f.content = append([]contentBlock{{Type: "quote", Text: "earlier"}}, textBlocks("/ai answer that")...)
		}), "ai", "> earlier\nanswer that"},
		{"the prefix alone", with(owner, func(f *routeFacts) { f.content = textBlocks("/ai") }), "ai", ""},
		{"a longer word", with(owner, func(f *routeFacts) { f.content = textBlocks("/aim high") }), "mine", ""},
		{"not at the start", with(owner, func(f *routeFacts) { f.content = textBlocks("hey /ai fix") }), "mine", ""},
		{"no text", with(owner, func(f *routeFacts) { f.content = []contentBlock{{Type: "image", Name: "x.png"}} }), "mine", ""},
		{"the owner on another account", with(owner, func(f *routeFacts) { f.account = "work"; f.content = textBlocks("/ai x") }), "rest", ""},
		{"somebody's direct message", other, "people", ""},
		{"a direct message kind", with(other, func(f *routeFacts) { f.kind = "dm" }), "people", ""},
		{"a group with an @ of the account", with(stranger, func(f *routeFacts) { f.mentions = []string{"ou_x", "ou_me"} }), "at-me", ""},
		{"a topic with an @ of the account", with(stranger, func(f *routeFacts) { f.kind = "thread"; f.mentions = []string{"ou_me"} }), "at-me", ""},
		{"a group with an @ of somebody else", with(stranger, func(f *routeFacts) { f.mentions = []string{"ou_x"} }), "strangers", ""},
		{"a stranger's trigger is not the owner's", with(stranger, func(f *routeFacts) { f.content = textBlocks("/ai rm -rf") }), "strangers", ""},
		{"the channel's addressed hint", routeFacts{channel: "bot-chat", kind: "group", addressed: true}, "bot-at", ""},
		{"not addressed", routeFacts{channel: "bot-chat", kind: "group", known: true, labels: []string{"friends"}}, "family", ""},
		{"a label, in a listed conversation", routeFacts{channel: "x", conv: "oc_noisy", known: true, labels: []string{"friends"}}, "", ""},
		{"unknown", routeFacts{channel: "x"}, "strangers", ""},
		{"known without a label", routeFacts{channel: "x", known: true}, "", ""},
	} {
		r, content, ok := s.route(tc.f)
		if r.Name != tc.want || ok != (tc.want != "") {
			t.Errorf("%s: matched %q (%v), want %q", tc.name, r.Name, ok, tc.want)
			continue
		}
		if r.prefixes() == nil {
			continue
		}
		text, _, _ := renderText(content)
		if text != tc.text {
			t.Errorf("%s: the text handed on is %q, want %q", tc.name, text, tc.text)
		}
		// The item's own content is never changed in place.
		if first := tc.f.content[len(tc.f.content)-1].Text; !strings.Contains(strings.ToLower(first), "/a") {
			t.Errorf("%s: the item's content was changed: %q", tc.name, first)
		}
	}
	// known, and a label literally named like a verdict word, are verdicts first.
	k := settingsOf(json.RawMessage(`{"routes":["k: from=known -> chat"]}`), nil)
	if _, _, ok := k.route(routeFacts{known: true}); !ok {
		t.Errorf("from=known does not match a principal without labels")
	}
	if _, _, ok := k.route(routeFacts{}); ok {
		t.Errorf("from=known matched an unknown sender")
	}
}

// TestRoutesDecideBeforeTheTag: the extension's routes are tried first, in order, on every item; an item no rule
// matches is decided by its tag and the rule lists as before.
func TestRoutesDecideBeforeTheTag(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	fh.agentSession("mac-1", "s-123")
	mine := fr.add(itemOpt{msg: "om_1", conv: "oc_self", text: "a note to myself " + secretWords, tag: "chat", labels: []string{"owner"}})
	dm := fr.add(itemOpt{msg: "om_2", conv: "oc_dm", kind: "other", text: "hi there", tag: "chat"})
	atMe := fr.add(itemOpt{msg: "om_3", conv: "oc_group", kind: "group", text: "@me look", mention: true, unknown: true})
	noise := fr.add(itemOpt{msg: "om_4", conv: "oc_group", kind: "group", text: "lunch?", tag: "chat", unknown: true})
	review := fr.add(itemOpt{msg: "om_5", conv: "oc_rev", text: "review please", labels: []string{"family"}})
	elsewhere := fr.add(itemOpt{msg: "om_6", conv: "oc_x", kind: "group", text: "untouched", tag: "chat"})
	r := startRig(t, fr, fh, withAgents(reviewerTarget), withRoutes(
		"mine: conv!=oc_x from=owner -> ignore",
		"review: from=family -> agent:reviewer",
		"people: kind=dm,other -> inbox",
		"at-me: kind=group mentions=ou_me -> inbox",
		"rest: conv!=oc_x -> ignore",
	))
	rec := r.waitItem(mine, stateSkipped)
	if rec.Matched != "mine" || rec.Tag != actionIgnore || rec.TagSource != tagSourceRoute || rec.Why != whyIgnored || rec.Text != "" {
		t.Errorf("ignored: %+v", rec)
	}
	if rec := r.waitItem(dm, stateInbox); rec.Matched != "people" || rec.Tag != tagInbox || rec.TagSource != tagSourceRoute {
		t.Errorf("dm: %+v", rec)
	}
	if rec := r.waitItem(atMe, stateInbox); rec.Matched != "at-me" {
		t.Errorf("at-me: %+v", rec)
	}
	if rec := r.waitItem(noise, stateSkipped); rec.Matched != "rest" || rec.Why != whyIgnored {
		t.Errorf("noise: %+v", rec)
	}
	if rec := r.waitItem(review, stateDone); rec.Matched != "review" || rec.Tag != tagAgent || rec.Target != "reviewer" {
		t.Errorf("review: %+v", rec)
	}
	// No rule matched: the item's tag decides, as before.
	if rec := r.waitItem(elsewhere, stateDone); rec.Matched != "" || rec.Tag != tagChat || rec.TagSource != "tag" {
		t.Errorf("elsewhere: %+v", rec)
	}
	if opens, sends := fh.counts(); opens != 1 || sends != 1 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
	// Ignored items are not in the Inbox, not destinations, and the journal does not keep their words.
	things := r.collect()
	for _, th := range things {
		if th["thread"] == "demo-chat:default:oc_self" || strings.Contains(fmt.Sprint(th), "lunch?") {
			t.Errorf("an ignored item is in the Inbox: %v", th)
		}
	}
	if thingOf(things, "demo-chat:default:oc_dm") == nil || thingOf(things, "demo-chat:default:oc_group") == nil {
		t.Errorf("things = %v", things)
	}
	if _, ok := r.x.store().place(destKey("demo-chat", "default", "oc_self")); ok {
		t.Errorf("an ignored conversation became a destination")
	}
	raw, _ := json.Marshal(r.x.store().all())
	if strings.Contains(string(raw), secretWords) {
		t.Errorf("the journal kept an ignored item's words")
	}
	// An item pushed again is still taken once.
	if got := r.x.store().matchCounts(time.Time{}); got["mine"] != 1 || got["rest"] != 1 || got["people"] != 1 || got["at-me"] != 1 || got["review"] != 1 {
		t.Errorf("counts = %v", got)
	}
	st := r.waitState(wire.ConnectorStateOk)
	want := fmt.Sprintf(wordsAgentsVia, 1) + "；" + fmt.Sprintf(wordsRoutesVia, 5, "mine 1、review 1、people 1、at-me 1、rest 1")
	if st.Via != want {
		t.Errorf("status = %q, want %q", st.Via, want)
	}
}

// TestRoutePrefixIsTakenOut: the words that chose a prefix rule are not handed on; a message that is nothing else is
// one with nothing readable.
func TestRoutePrefixIsTakenOut(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	ask := fr.add(itemOpt{msg: "om_1", text: "  /bot what is up", labels: []string{"owner"}})
	bare := fr.add(itemOpt{msg: "om_2", conv: "oc_b", text: "/bot", labels: []string{"owner"}})
	r := startRig(t, fr, fh, withRoutes("bot: from=owner prefix=/bot -> chat"))
	rec := r.waitItem(ask, stateDone)
	if rec.Text != "what is up" {
		t.Errorf("text = %q", rec.Text)
	}
	if open := fh.open(0); !strings.HasSuffix(fmt.Sprint(open.body["prompt"]), "\n\nwhat is up") {
		t.Errorf("prompt = %q", open.body["prompt"])
	}
	if rec := r.waitItem(bare, stateInbox); rec.Why != whyEmpty || rec.Matched != "bot" {
		t.Errorf("bare: %+v", rec)
	}
}

// TestRoutePrefixSkipsMediaPlaceholders: a channel's text for media it could not download is not the sender's words,
// so a quoted message's failed picture before "/ai …" does not hide the prefix (and is kept in what is handed on).
func TestRoutePrefixSkipsMediaPlaceholders(t *testing.T) {
	ph := contentBlock{Type: "text", Text: "[file a.mp4 not downloaded: larger than 20971520 bytes]"}
	img := contentBlock{Type: "text", Text: " [image not downloaded: no url] "}
	quote := contentBlock{Type: "quote", Text: "earlier"}
	for _, tc := range []struct {
		name    string
		content []contentBlock
		ok      bool
		rest    string
	}{
		{"quote, placeholder, command", []contentBlock{quote, ph, {Type: "text", Text: "/ai transcribe this"}}, true, "transcribe this"},
		{"placeholder first", []contentBlock{img, {Type: "text", Text: "/ai look"}}, true, "look"},
		{"placeholder only", []contentBlock{ph}, false, ""},
		{"words that look like one", []contentBlock{{Type: "text", Text: "[note not downloaded: see] /ai x"}}, false, ""},
		{"own words without the prefix", []contentBlock{ph, {Type: "text", Text: "hello /ai"}}, false, ""},
	} {
		out, ok := stripPrefix(tc.content, "/ai")
		if ok != tc.ok {
			t.Errorf("%s: ok = %v", tc.name, ok)
			continue
		}
		if !ok {
			continue
		}
		if got := out[len(out)-1].Text; got != tc.rest {
			t.Errorf("%s: rest = %q", tc.name, got)
		}
		if len(out) != len(tc.content) {
			t.Errorf("%s: blocks = %d, want %d (placeholders kept)", tc.name, len(out), len(tc.content))
		}
	}
}

// TestSettingsCheckRefusesBadRoutes: a route line that cannot be read, or that names a target or a launcher the
// settings do not have, is refused before anything is saved, with its number.
func TestSettingsCheckRefusesBadRoutes(t *testing.T) {
	fr := newFakeRouter(t)
	r := startRig(t, fr, newFakeHub(t))
	check := func(config map[string]any) wire.SettingsCheckResult {
		t.Helper()
		cfg, _ := json.Marshal(config)
		var res wire.SettingsCheckResult
		if err := r.h.Call("settings.check", wire.SettingsCheckParams{Config: cfg, Secrets: map[string]string{"backend_key": fakeKey}}, &res); err != nil {
			t.Fatal(err)
		}
		return res
	}
	for _, tc := range []struct {
		config map[string]any
		why    string
	}{
		{map[string]any{"router_url": fr.url(), "routes": []string{"a: -> inbox", "b: conv=" + fakeKey + " -> inbox"}}, wordsRouteSecret},
		{map[string]any{"routes": []string{"a: -> inbox", "b: kind=private -> inbox"}}, wordsRouteKind}, // no address yet
		{map[string]any{"routes": []string{"a: -> inbox", "b: -> agent:reviewer"}}, wordsRouteNoAgent},
		{map[string]any{"routes": []string{"a: -> inbox", "b: from=owner -> launch:coder"}}, wordsRouteNoLauncher},
		{map[string]any{"routes": []string{"a: -> inbox", "b: -> launch:coder"}, "launchers": []string{"coder = mac-1/claude"}}, wordsRouteLaunchOwner},
	} {
		res := check(tc.config)
		if res.Ok || !strings.Contains(res.Error, "路由规则第 2 行") || !strings.Contains(res.Error, tc.why) || strings.Contains(res.Error, fakeKey) {
			t.Errorf("%v: %+v", tc.config["routes"], res)
		}
	}
	before := fr.connectCount()
	good := map[string]any{"router_url": fr.url(), "agent_targets": []string{reviewerTarget}, "launchers": []string{"coder = mac-1/claude"},
		"routes": []string{"ai: from=owner prefix=/ai -> launch:coder", "r: from=family -> agent:reviewer", "rest: -> ignore"}}
	if res := check(good); !res.Ok {
		t.Errorf("good routes: %+v", res)
	}
	if fr.connectCount() == before {
		t.Errorf("good routes did not go on to the handshake")
	}
}

// TestBadRouteLinesAreSkippedAtStart: a configuration saved without the check starts anyway. A line that does not
// read is skipped and counted; a rule whose target the settings do not have sends what it matches to the Inbox with
// the reason, never past it to a later rule.
func TestBadRouteLinesAreSkippedAtStart(t *testing.T) {
	fr, fh := newFakeRouter(t), newFakeHub(t)
	toAgent := fr.add(itemOpt{msg: "om_1", text: "for an agent", labels: []string{"family"}})
	toLaunch := fr.add(itemOpt{msg: "om_2", conv: "oc_b", text: "/ai go", labels: []string{"owner"}})
	r := startRig(t, fr, fh, withRoutes("nonsense", "r: from=family -> agent:nobody", "ai: from=owner prefix=/ai -> launch:nobody", "rest: -> ignore"))
	if rec := r.waitItem(toAgent, stateInbox); rec.Why != whyAgentUnknown || rec.Matched != "r" {
		t.Errorf("agent: %+v", rec)
	}
	if rec := r.waitItem(toLaunch, stateInbox); rec.Why != whyLaunchUnknown || rec.Matched != "ai" || rec.Tag != tagInbox {
		t.Errorf("launch: %+v", rec)
	}
	want := fmt.Sprintf(wordsBadRoutesVia, 1) + "；" + fmt.Sprintf(wordsRoutesVia, 3, "r 1、ai 1、rest 0")
	if got := r.waitState(wire.ConnectorStateOk); got.Via != want {
		t.Errorf("status = %q, want %q", got.Via, want)
	}
	if opens, sends := fh.counts(); opens+sends != 0 {
		t.Errorf("%d conversations, %d messages", opens, sends)
	}
	// Both need the owner: a rule meant them for somebody nobody is.
	for _, thread := range []string{demoThread, "demo-chat:default:oc_b"} {
		if th := thingOf(r.collect(), thread); th == nil || th["extra"].(map[string]any)["rule_tier"] != string(tierAction) {
			t.Errorf("thing %s = %v", thread, th)
		}
	}
}

// TestRoutesSettingIsDeclared keeps the setting as the form shows it, with the manifest's own bound.
func TestRoutesSettingIsDeclared(t *testing.T) {
	var m struct {
		Configuration struct {
			Properties map[string]struct {
				Type        string `json:"type"`
				MaxItems    int    `json:"maxItems"`
				Description string `json:"description"`
				Items       struct {
					Type string `json:"type"`
				} `json:"items"`
			} `json:"properties"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(sourceManifest, &m); err != nil {
		t.Fatal(err)
	}
	for key, parts := range map[string][]string{
		routesKey:    {"->", "from=owner", "prefix=", "ignore", "launch:"},
		launchersKey: {"=", "launch:", "主人"},
	} {
		p := m.Configuration.Properties[key]
		if p.Type != "array" || p.Items.Type != "string" || p.MaxItems != 32 {
			t.Errorf("%s = %+v", key, p)
		}
		for _, want := range parts {
			if !strings.Contains(p.Description, want) {
				t.Errorf("%s: the description lacks %q", key, want)
			}
		}
	}
	if !slices.Contains([]int{routesMost, launchersMost}, 32) {
		t.Errorf("bounds")
	}
}
