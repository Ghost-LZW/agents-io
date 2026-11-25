package main

import (
	"encoding/json"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/nwverse/persona/sdk/go/exttest"
	"github.com/nwverse/persona/sdk/go/wire"
)

func TestRuntimeManifestIsTheSourceWithoutCatalogFields(t *testing.T) {
	var src, run map[string]any
	if err := json.Unmarshal(sourceManifest, &src); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(manifest, &run); err != nil {
		t.Fatal(err)
	}
	if src["icon"] == nil || src["tags"] == nil {
		t.Fatalf("the source manifest has an icon and tags")
	}
	delete(src, "icon")
	delete(src, "tags")
	if !reflect.DeepEqual(src, run) {
		t.Errorf("the runtime manifest differs from the source beyond icon and tags")
	}
	var m wire.Manifest
	if err := json.Unmarshal(manifest, &m); err != nil {
		t.Fatalf("wire.Manifest: %v", err)
	}
	if m.ID != extensionID || m.Version != version || version != "0.2.0" {
		t.Errorf("id %q version %q", m.ID, m.Version)
	}
}

func TestManifestFollowsTheRules(t *testing.T) {
	caps, err := checkInboxManifest(sourceManifest)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(caps[connectorID], "fallback") {
		t.Errorf("connector %s declares no fallback", connectorID)
	}
	var m struct {
		Description string `json:"description"`
		Contributes struct {
			Connectors []struct {
				ID           string            `json:"id"`
				Capabilities []string          `json:"capabilities"`
				Kinds        []string          `json:"kinds"`
				Descriptions map[string]string `json:"kind_descriptions"`
			} `json:"connectors"`
		} `json:"contributes"`
		Configuration struct {
			Required   []string `json:"required"`
			Properties map[string]struct {
				Type    string `json:"type"`
				Title   string `json:"title"`
				Format  string `json:"format"`
				Default any    `json:"default"`
			} `json:"properties"`
		} `json:"configuration"`
		Secrets []struct {
			Name, Title string
			Required    bool
		} `json:"secrets"`
		SettingsCheck bool `json:"settings_check"`
		Permissions   struct {
			Hub     []string `json:"hub"`
			Network []string `json:"network"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(sourceManifest, &m); err != nil {
		t.Fatal(err)
	}
	if n := utf8.RuneCountInString(m.Description); n == 0 || n > 120 {
		t.Errorf("description has %d characters", n)
	}
	// Titles name what the user fills in.
	words := regexp.MustCompile(`(?i)(^|[^A-Za-z])(id|token|api|get|post|put|delete|payload)([^A-Za-z]|$)`)
	for name, p := range m.Configuration.Properties {
		if p.Title == "" || words.MatchString(p.Title) {
			t.Errorf("setting %s: title %q", name, p.Title)
		}
	}
	for _, s := range m.Secrets {
		if s.Title == "" || words.MatchString(s.Title) {
			t.Errorf("secret %s: title %q", s.Name, s.Title)
		}
	}
	// Nothing is marked required: the hub does not start an extension that waits for a required setting and saves
	// those settings unchecked, so the first address and key would never go through settings.check. The program
	// reports what is missing itself (not_configured, with the guide).
	if len(m.Secrets) != 1 || m.Secrets[0].Name != "backend_key" || m.Secrets[0].Required {
		t.Errorf("secrets = %+v", m.Secrets)
	}
	if len(m.Configuration.Required) != 0 || !m.SettingsCheck {
		t.Errorf("required = %v, settings_check = %v", m.Configuration.Required, m.SettingsCheck)
	}
	if len(m.Contributes.Connectors) != 1 {
		t.Fatalf("connectors = %+v", m.Contributes.Connectors)
	}
	c := m.Contributes.Connectors[0]
	if c.ID != connectorID || !regexp.MustCompile(`^[a-z][a-z0-9]*$`).MatchString(c.ID) {
		t.Errorf("connector id %q", c.ID)
	}
	// events: the program sends connector.changed, which the connector protocol ties to this capability.
	if want := []string{"status", "tools", "actions", "events", "inbox", "settle", "fallback"}; !slices.Equal(c.Capabilities, want) {
		t.Errorf("capabilities = %v, want %v", c.Capabilities, want)
	}
	for _, k := range []string{"dm", "group", "mail", "other"} {
		if !slices.Contains(c.Kinds, k) || c.Descriptions[k] == "" {
			t.Errorf("kind %s is not declared and described", k)
		}
	}
	// The minimum hub scopes, and nothing else.
	if !slices.Equal(m.Permissions.Hub, hubScopes) {
		t.Errorf("permissions.hub = %v, want %v", m.Permissions.Hub, hubScopes)
	}
	if !slices.Contains(m.Permissions.Network, "config:router_url:http") {
		t.Errorf("permissions.network = %v", m.Permissions.Network)
	}
	// A config: network target must be a uri without a default, or the hub refuses the manifest.
	url := m.Configuration.Properties["router_url"]
	if url.Type != "string" || url.Format != "uri" || url.Default != nil {
		t.Errorf("router_url = %+v", url)
	}
}

// TestTriageRulesSettingIsPinned keeps the conventional setting as the form shows it: a string the hub's limit long,
// with a title, and a description that tells how to write a line break (triageRulesOf reads it that way).
func TestTriageRulesSettingIsPinned(t *testing.T) {
	var m struct {
		Configuration struct {
			Properties map[string]struct {
				Type        string `json:"type"`
				Title       string `json:"title"`
				Description string `json:"description"`
				MaxLength   int    `json:"maxLength"`
			} `json:"properties"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(sourceManifest, &m); err != nil {
		t.Fatal(err)
	}
	p := m.Configuration.Properties[triageRulesSetting]
	if p.Type != "string" || p.Title != "分拣规则" || p.MaxLength != triageRulesLimit {
		t.Errorf("triage_rules = %+v", p)
	}
	for _, part := range []string{"路由消息", "群里没 @ 我的都算噪音", `\n`} {
		if !strings.Contains(p.Description, part) {
			t.Errorf("triage_rules.description lacks %q: %s", part, p.Description)
		}
	}
}

// TestSendIsAGatedWrite: the send is an action (a write the hub runs only after its gate), the manifest makes the
// gate ask the owner every time, and nothing hands the tools to coding agents or sends around the gate.
func TestSendIsAGatedWrite(t *testing.T) {
	var m wire.Manifest
	if err := json.Unmarshal(manifest, &m); err != nil {
		t.Fatal(err)
	}
	c := m.Contributes.Connectors[0]
	if !slices.Equal(c.ConfirmAlways, []string{toolSendName}) || len(c.AgentTools) != 0 || c.SendsAsUser {
		t.Errorf("confirm_always = %v, agent_tools = %v, sends_as_user = %v", c.ConfirmAlways, c.AgentTools, c.SendsAsUser)
	}
	for _, part := range []string{"真实", "确认", "替谁", "批准", "route_not_allowed", "结果不明"} {
		if !strings.Contains(sendTool.Description, part) {
			t.Errorf("the send tool's description lacks %q", part)
		}
	}
	for _, tool := range []wire.ConnectorTool{aboutTool, destinationsTool, sendTool} {
		if !strings.HasPrefix(tool.Name, connectorID+"_") || !json.Valid(tool.InputSchema) {
			t.Errorf("tool %q", tool.Name)
		}
	}
	var raw struct {
		Configuration struct {
			Properties map[string]map[string]any `json:"properties"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(sourceManifest, &raw); err != nil {
		t.Fatal(err)
	}
	d := raw.Configuration.Properties[destinationsKey]
	items, _ := d["items"].(map[string]any)
	_, hasDefault := d["default"]
	if d["type"] != "array" || items["type"] != "string" || d["maxItems"] != float64(destsMost) || hasDefault || len(items) != 1 {
		t.Errorf("destinations = %v", d)
	}
	desc, _ := d["description"].(string)
	for _, part := range []string{"名字 = 渠道:账号:会话", "routes", "不要写钥匙"} {
		if !strings.Contains(desc, part) {
			t.Errorf("destinations.description lacks %q", part)
		}
	}
}

// TestProtocolConformance holds the program to the process protocol and the connector protocol, unconfigured.
func TestProtocolConformance(t *testing.T) {
	exttest.Check(t, manifest, exttest.Serve(t, program(newApp(fastTimings()))))
	exttest.CheckConnectors(t, manifest, exttest.Serve(t, program(newApp(fastTimings()))))
}
