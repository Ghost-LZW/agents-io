package main

import (
	"encoding/json"
	"slices"
)

// The frames of the agents-io host protocol a backend uses (the router's docs/HOSTS.md, backend section; exact types
// in its packages/protocol/src/host.ts). Everything decodes leniently: unknown fields are ignored, so a newer router
// keeps working, and the item is also kept as it came.

const (
	protocolV   = 1
	subprotocol = "agents-io.v1"
	clientName  = "persona-agents-io"

	frameHello   = "host.hello"
	frameInbound = "inbound"
	frameResult  = "result"
	frameDeliver = "deliver"
	frameAck     = "message.ack"

	featureBackends = "backends"
	// accessRead is hello's backend.access for a read key: an observer, which this program cannot be.
	accessRead = "read"

	codeForbidden       = "forbidden"
	codeRouteNotAllowed = "route_not_allowed"
	codeUnauthorized    = "unauthorized"
	codeStopped         = "stopped"
	codeHostConnected   = "host_connected"
	codeUnsupported     = "unsupported"
	codeChannelError    = "channel_error"
	codeInternal        = "internal"

	deliverDelivered = "delivered"
	deliverRejected  = "rejected"
	deliverUnknown   = "unknown"

	markWorking = "working"
	markDone    = "done"
	markFailed  = "failed"
)

// frame is the part of any frame the reader needs to hand it on.
type frame struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value"`
	Error *frameError     `json:"error"`
	Item  json.RawMessage `json:"item"`
}

type frameError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// helloResult is the answer to host.hello.
type helloResult struct {
	Name    string `json:"name"`
	Host    bool   `json:"host"`
	Backend *struct {
		ID string `json:"id"`
		// Access is the level of the key: "readwrite", "read" (accessRead), or empty from a router without key levels.
		Access string `json:"access"`
	} `json:"backend"`
	Inbound *struct {
		Consumer string `json:"consumer"`
		Acked    int64  `json:"acked"`
		Head     int64  `json:"head"`
	} `json:"inbound"`
	Features []string `json:"features"`
}

// replyRoute is where a reply goes (the router's ReplyRoute).
type replyRoute struct {
	Channel          string `json:"channel"`
	Account          string `json:"account"`
	ConversationID   string `json:"conversationId"`
	ThreadID         string `json:"threadId,omitempty"`
	ReplyToMessageID string `json:"replyToMessageId,omitempty"`
}

// key is the router's routeKey: the stable key of a conversation, ignoring the reply target.
func (r replyRoute) key() string {
	k := r.Channel + ":" + r.Account + ":" + r.ConversationID
	if r.ThreadID != "" {
		k += ":" + r.ThreadID
	}
	return k
}

// contentBlock is one block of an input's content; which fields are set depends on Type.
type contentBlock struct {
	Type    string         `json:"type"`
	Text    string         `json:"text"`
	Ref     string         `json:"ref"`
	Mime    string         `json:"mime"`
	Name    string         `json:"name"`
	Speaker string         `json:"speaker"`
	URI     string         `json:"uri"`
	Title   string         `json:"title"`
	Data    map[string]any `json:"data"`
}

// origin is who sent an input, as the router stamped it. Clients cannot set it.
type origin struct {
	Kind      string `json:"kind"`
	Principal *struct {
		ID     string   `json:"id"`
		Labels []string `json:"labels"`
	} `json:"principal"`
	Evidence string `json:"evidence"`
	Self     bool   `json:"self"`
}

type inputRecord struct {
	InputID        string         `json:"inputId"`
	Origin         origin         `json:"origin"`
	Content        []contentBlock `json:"content"`
	ReplyRoute     *replyRoute    `json:"replyRoute"`
	ChannelContext map[string]any `json:"channelContext"`
}

type envelope struct {
	ID           string `json:"id"`
	Channel      string `json:"channel"`
	Account      string `json:"account"`
	Conversation struct {
		ID       string `json:"id"`
		Kind     string `json:"kind"`
		ThreadID string `json:"threadId"`
	} `json:"conversation"`
	Sender struct {
		ChannelUserID string `json:"channelUserId"`
		DisplayName   string `json:"displayName"`
		IsBot         bool   `json:"isBot"`
	} `json:"sender"`
	Content  []contentBlock `json:"content"`
	Mentions []struct {
		ID string `json:"id"`
	} `json:"mentions"`
	RootMessageID   string         `json:"rootMessageId"`
	ParentMessageID string         `json:"parentMessageId"`
	Context         map[string]any `json:"context"`
	Admission       string         `json:"admission"`
	SentAt          int64          `json:"sentAt"`
}

// inboundItem is one entry of the backend's queue. The router has no item id field today: ID is read in case a
// later one adds it (itemID).
type inboundItem struct {
	ID         string      `json:"id"`
	Cursor     int64       `json:"cursor"`
	ChannelRef string      `json:"channelRef"`
	Account    string      `json:"account"`
	BindingID  string      `json:"bindingId"`
	Tag        string      `json:"tag"`
	Input      inputRecord `json:"input"`
	Envelope   envelope    `json:"envelope"`
	ReceivedAt int64       `json:"receivedAt"`
}

// renderedMessage is what deliver sends; this version sends words only.
type renderedMessage struct {
	Text string `json:"text"`
}

// deliverResult is the settled record of a deliver.
type deliverResult struct {
	Status             string   `json:"status"`
	ProviderMessageID  string   `json:"providerMessageId"`
	ProviderMessageIDs []string `json:"providerMessageIds"`
	Error              string   `json:"error"`
	Duplicate          bool     `json:"duplicate"`
}

// messageIDs are the platform ids of what was sent: one message, or the several a channel split it into.
func (d deliverResult) messageIDs() []string {
	var out []string
	for _, id := range append([]string{d.ProviderMessageID}, d.ProviderMessageIDs...) {
		if id != "" && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}
