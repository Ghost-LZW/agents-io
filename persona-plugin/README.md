# agents-io (message router backend)

A [Persona](https://github.com/nwverse/persona) extension that connects one Persona assistant (one manager) to an [agents-io](#what-it-is) message router as one of the router's **backends**. Messages the router routes to this backend go to the Inbox, or to an assistant conversation whose final answer is delivered back to the channel conversation the message came from.

- [Extension guide](GUIDE.md)
- [The router side: backends, keys, frames](../docs/HOSTS.md)
- [Manifest](persona-extension.json)

This page describes version 0.1.0.

## Build and install

This directory is a Go module of its own (Go 1.27.1 or newer); it is not part of the router's pnpm workspace. Persona's own tooling builds and installs it (see Persona's extension documentation for the details):

```sh
personad extension pack persona-plugin        # builds the binaries the manifest lists and writes the package
personad extension install dir:/path/to/persona-plugin
personad extension dev persona-plugin         # run from source while developing
```

`bin/` and `dist/` are build outputs and are not committed.

## What it is

agents-io is an open-source message router. It owns the messaging channels: it receives messages from many channels and people, stamps who sent each one, routes each by a deterministic rule table, queues it durably per backend (at least once; the queue advances when the backend accepts an item) and delivers replies with idempotent operation ids.

This extension is the Persona side of one backend:

```text
channels ── agents-io router ──(WebSocket /ws, backend key)── this extension ── hub API ── assistant
             rules: to + tag                                   Inbox connector
```

It connects to the router console's `/ws` with the backend's key, says `host.hello`, checks that the router advertises the `backends` feature, and consumes the items the router pushes. What happens to an item is chosen by the **tag** the router's rule gives it.

The extension contributes one connector, `agentsio` (connector ids allow no hyphen), with the capabilities `status`, `tools`, `events`, `inbox`, `settle` and `fallback`.

## Configuration

| Setting | Kind | Meaning |
| --- | --- | --- |
| `router_url` | address | The router console's address: scheme, host and port only, for example `https://<router address>`. The extension connects to its `/ws`. `http://` is accepted because the router console itself speaks plain HTTP (see [Network](#network)). |
| `backend_key` | secret | The key the router issued for this backend (`aio backend key <backend id>` on the router's machine; it looks like `aiob_example_key_not_real`). Stored through the hub's encrypted secret flow, handed to the program at start, never logged. It must be the backend's read-write key (the command without `--read`): the extension consumes, accepts and answers. A read key (`aiobr_…`, `aio backend key <backend id> --read`) only observes: the router says which level a key is when it answers `host.hello`, so the extension refuses a read key when the settings are saved, never asks to consume with one, and the status says it is a read-only key. Do not put the router's host token here: the extension refuses a key that is not a backend's before taking any role on the router. |
| `chat_rules` | list of rule names | Router rule ids whose items are handled as `chat` when the item carries no tag. |
| `guest_rules` | list of rule names | Router rule ids whose items are handled as `guest` when the item carries no tag. |
| `working_mark` | on/off, default on | Ask the router to mark the channel message as working, done or failed (the channel decides how; a channel without marks is skipped quietly). |
| `chat_wait_minutes` | 5–480, default 240 | How long an item waits for the assistant's answer before it falls back to the Inbox. |
| `keep_days` | 7–90, default 30 | How long finished records stay in the extension's journal (the dedupe memory). |
| `triage_rules` | text | The standard per-source Inbox triage rules, as in other Inbox connectors. |

Nothing personal or environment-specific is built in: every address, key and rule name comes from these settings. Saving the settings first tries the real handshake (`settings.check`) and says, in one sentence, when the router cannot be reached, refuses the key, was given a key that is not a backend's or is a backend's read key, or has no `backends` feature.

The address and the key are both needed, but neither is marked `required` in the manifest. The hub does not start an extension that waits for a required setting, and saves those settings unchecked; marked required, the first address and key would never go through the handshake. The program runs without them instead, reports `not_configured` with a setup guide, and accepts a partial save (the address before the key).

A router without the `backends` feature refuses every `aiob_` key before any feature list is seen, so that case reads "the router does not accept this backend key"; the sentence names both causes. A key that does get in on such a router (its host token) reads "the router has no backends feature".

Each manager needs its own backend and its own key. Two installed copies with one key would keep taking the push connection from each other; the status says so when it sees connections that never last.

## Tags

The router's rule that routes an item to this backend may carry a `tag`; the router copies it to the queue item.

| Tag | What the extension does |
| --- | --- |
| `inbox` | Inbox only: the message becomes an Inbox thing. |
| `chat` | An assistant conversation: the message is sent to the assistant **as if the owner said it**, and the final answer is delivered to the channel conversation. |
| `guest` | A guest assistant conversation (the product's guest mode: no built-in tools, none of the owner's data), with the answer delivered the same way. |
| anything else, or none | Inbox only. |

When an item has no tag (an older router, or a rule without one), the rule id carried on the item is looked up in `chat_rules` and `guest_rules`; a rule in neither list is `inbox`. A tag on the item always wins over the lists: a tag this version does not know (`archive`, or `Chat` with a capital) is `inbox` even when the rule's id is in one of the lists, so a rule whose tag changes never keeps sending into an owner's conversation by its name.

**Who should be routed where.** Persona has no sender field: everything this extension sends into a `chat` conversation is treated as the owner speaking, with the owner's tools and data. The only statement of who actually wrote the message is the first line of the text (below). So route to `chat` only the owner, or people the manager is meant to act for; route other people to `guest` or `inbox`. That decision is made in the router's rule table, not here. Message text can still try to instruct the assistant (prompt injection); guest conversations limit what that can reach.

Some items never go to a conversation whatever their tag, and are filed in the Inbox with the reason: an item without a reply route, a message from a bot or from another deployment's agent (a loop guard), a message with nothing readable, a `guest` item on a hub without guest conversations (it is never opened as an ordinary conversation instead). An echo of the deployment's own message and a card click are recorded and skipped.

An item this version cannot read at all (a newer router changed the type of a field) is not accepted without a trace: a placeholder that needs you is filed in the Inbox under one thread, with the router's queue cursor so the message can be looked up on the router, and the connector's status counts them. Its content is not kept.

### The sender line

The text given to the assistant starts with exactly one line, then a blank line, then the message:

```text
【渠道消息】发送者：<display name>（路由认定：<verdict>，凭据 <evidence>）｜渠道：<channel> <kind>「<chat name>」｜ref=<reference>｜你的最终回答会原样发回这个会话
```

The verdict is the router's stamp (owner, known labels, or unknown), not anything the sender wrote. Names are stripped of line breaks, control characters and the line's own punctuation, so a display name cannot start a second line or write a verdict of its own.

## Inbox connector

- `inbox.collect` returns one thing per channel conversation that has open `inbox` items (and items whose round trip failed). `thread` is the conversation reference `channel:account:conversation[:thread]`, a stable dedupe key; `last` changes with every new step of the thread. A step is a message arriving, or a round trip failing: a failure is reported with the time it happened (not the message's own time) and is the thread's newest step even when a later message of the conversation is already in the Inbox, so the hub moves its open item or starts a new one. The thing's time never goes back within a thread.
- An Inbox item older than the hub's seven-day window that the hub does not hold open (it never listed the thread in `inbox.settle`, or stopped that long ago) is closed and no longer collected. The hub never starts an item for a thing that old, and a muted chat or sender, a backlog pushed late, or an item filed while no other thread was open would otherwise be collected for good. The thing carries sender, preview, time, the thread's recent messages as context, `url` only when the channel gave a link, and the channel's facts under `extra.agentsio` (the router strips the platform's raw payload before queueing, so these are the envelope's fields).
- The connector declares `fallback` and gives every thing `extra.rule_tier` itself, so no triage model is needed: direct messages and mail need you, a group message that mentions someone needs you, other group messages and bot messages are for your information, a failed round trip needs you.
- A new item sends `connector.changed {scope: "inbox"}` (at most once a second).
- `inbox.reply` sends the reply through the router's `deliver` with the operation id `inbox-reply-<client_id>`: the same reply asked twice is sent once. An unknown outcome (no answer, the router's `internal`, a settled status of `unknown`) is an error and is not resent; asking again with the same `client_id` asks the router for the settled record. A refusal of the router (`stopped`, `unauthorized`, `route_not_allowed`, `forbidden` and the like) says nothing was sent and is reported as not sent. A reply while the router is unreachable fails at once; nothing is queued for later.
- `inbox.settle` is the hub asking which of its open threads are over. The extension answers for threads it replied to or no longer keeps, and puts the done mark on their messages through `message.ack`. The protocol never says "the owner marked this done"; the extension infers it for a thread the hub listed as open before and no longer lists, and marks that one done too. The mark is cosmetic and can arrive late.
- One read-only tool, `agentsio_about`, says where a conversation's messages come from. It returns no message content. It exists because a guest conversation must name one to eight connector tools.

## Chat round trip

For a `chat` or `guest` item the extension keeps a mapping from the channel conversation to an assistant conversation in its own storage.

1. A channel conversation without a mapping opens a conversation (`POST /api/v1/assistant/conversations`, with an operation id derived from the item); guest conversations are opened in guest mode, after asking `GET /api/v1/assistant/capabilities`. One with a mapping gets a message (`POST /api/v1/sessions/{mid}/{sid}/messages`, with a `client_msg_id` derived from the item).
2. The channel message is marked `working`.
3. The extension finds the turn's result the way the product's own channel pipeline does: it locates the item carrying its `client_msg_id` (for a conversation's first message, which carries none, the reference in the sender line), waits while the conversation is working or awaiting an answer, and takes the assistant's last text after it, by polling `GET /api/v1/sessions/{mid}/{sid}/items?after_seq=`. A message the agent took in mid-turn (its item says `queued` for good) is in the conversation like any other. A poll asks only for what came after the last item seen; before the run ends the transcript is read once more from the run's start. A text the page cut (`full_size`) is read whole from `…/items/{item id}/full`; when that fails the run fails, and a cut answer is never delivered.
4. The answer is delivered to the item's reply route through the router, with the operation id `reply-<hash of the item id>`, and the message is marked `done` or `failed`.

Items of one channel conversation are handled one after another; different conversations run side by side, at most four at a time (a backlog pushed after a long outage does not start an assistant process per conversation at once; the rest wait their turn).

A message into a conversation whose computer is away is kept by the manager (`202 {"delivered":"later"}`) and sent when the computer is back. The run waits for it to show up for as long as `chat_wait_minutes`, and the conversation's next items wait behind it.

**What the owner types in the app stays in the app.** Only the assistant's words between the extension's message and the next thing a person put into the conversation are ever delivered. If the owner writes into the same conversation in the Persona app, or sends a picture there, neither that message nor the answer to it reaches the channel; a turn the owner took over before the assistant said anything ends as failed and appears in the Inbox. What the product itself injects (a background task's notice, a wake-up), another session's message and a tool result's picture do not end the run's part of the conversation.

## Delivery guarantees

- **At least once in, handled once.** An item is accepted (the router's queue advances) only after it is written durably to the extension's journal. A push repeated after a reconnect, a router restart or a restart of the extension is accepted again and not handled again: the journal is keyed by the item's id (the router's own idempotency key: account plus channel message reference).
- **An unknown outcome of a send is never retried automatically.** The run's state is written before each request. Counted as not sent, and tried again for up to ten minutes: `409`, `423` and `429` (refused for now: a draft in the box, a dialog open, busy), `503 assistant_offline`, a 5xx whose body says `delivered: none`, and a failure before any connection existed. Any other 4xx fails at once. Everything else, including a request that was under way when the program stopped, is unknown and is not sent again. For a message into an existing conversation the transcript is still watched for it for ten minutes.
- **A refused start is tried again under a new operation id only when the hub said nothing was delivered.** The hub keeps a receipt for a start and answers a repeat of the same id from it, so a start refused with `delivered: none` (no launcher, no computer) could never succeed under its first id; nothing was started, so a new id (`open/<item>/<n>`) is safe. `503 assistant_offline` keeps no receipt and keeps its id. A refusal that does not say `delivered: none` keeps its id too: the repeat then goes through or answers `unknown`, and an unknown start is not repeated.
- **A capabilities request that fails says nothing about guest conversations.** Only an answer does (`false`, or 404 from an older hub). A `guest` item waits out the failure like a start that was not sent, and is never opened as an ordinary conversation meanwhile.
- **Replies are idempotent.** The operation id of a delivery comes from the item (or from the hub's `client_id`), so asking again after a reconnect or restart never sends twice. A new id is never used for the same answer.
- **An answer waits out refusals that are temporary.** The router's `stopped` (it is shutting down) and `unauthorized` (the key was refused) say nothing was sent and do not use up the operation id: the same operation is asked again on the next connection, for up to an hour. `route_not_allowed` is answered for a conversation outside the backend's scope, for a reply target the router no longer accepts, and also while the channel is not running (a router that just came back): it is asked again without the reply target, then again for up to two minutes, always with the same operation id. Other refusals fail at once.
- **Nothing is lost silently.** Every failed or unknown round trip marks the message failed and turns the item into an Inbox thing that needs you, with the reason. Nothing extra is posted to the channel.

## Hub scopes

The extension asks for the minimum the chat round trip needs, and uses the hub API with its own scoped token:

| Scope | Routes it is used for |
| --- | --- |
| `assistant.ask` | `GET /api/v1/assistant/capabilities` (does the hub have guest conversations), `POST /api/v1/assistant/conversations` (open a conversation with the first message) |
| `agents.read` | `GET /api/v1/sessions` (is the conversation working or awaiting an answer), `GET /api/v1/sessions/{mid}/{sid}/items` (read the turn's result), `GET /api/v1/sessions/{mid}/{sid}/items/{item id}/full` (the whole text of a long answer) |
| `agents.control` | `POST /api/v1/sessions/{mid}/{sid}/messages` (send a message into the mapped conversation) |

Without them the extension still connects and files everything in the Inbox, and its status names the missing scopes.

## Network

`permissions.network` is `config:router_url:http`, `localhost` and `127.0.0.1`: the extension may reach the router address from its settings and nothing else, plus a router on the hub's own machine. Plain `http` is allowed because the router console speaks only HTTP. The key then crosses the network as a bearer in the upgrade request, so **put TLS termination in front of the router or use it only on a trusted network**. In the hub's sandbox the WebSocket upgrade goes through the hub's egress proxy.

## Storage

Two JSON files in the extension's data directory, mode 0600, replaced atomically: `journal.json` (one record per item: who, where, the text capped at 16 KiB, and where its handling stands) and `conversations.json` (channel conversation to assistant conversation). Finished records are dropped after `keep_days`; a running round trip is never dropped, nor an Inbox item the hub holds open. An Inbox item past the hub's seven-day window that the hub does not hold open is closed, then dropped like any finished record. The journal is capped at 5000 records (the oldest finished ones go first, then the oldest Inbox items), and the mapping of a channel conversation nobody wrote in for 180 days is dropped, so the next message there opens a new assistant conversation. This runs at start and every hour. Media is never stored: an image, file or voice message is named in the text as a placeholder. The log has states, counts, short hashes and error codes only: no key, no token, no message text, no names, no addresses.

## One receiver per channel account

If another extension (for example Open Lark) still receives the same channel account, every message is handled twice. The extension cannot detect that. When the router takes over an account, make sure nothing else in Persona consumes it.

## Not implemented in 0.1.0

- Approvals in the channel: a pending permission or question of a conversation is not shown as a card, and a card click is recorded and skipped. A turn that waits for an approval is answered in the Persona app; the run waits meanwhile.
- Media: attachments are named, not fetched, and none are sent.
- Progress cards and streaming: only the final answer is delivered, plus the working / done / failed mark.
- Earlier channel messages as context for a new conversation (`history.read`), pull consumption (`inbound.read` / `inbound.ack`).
- Folding several messages of one conversation into one turn, and a second answer after background work.
- Channel commands (a fresh conversation, stop, status) and a notice in the channel when a round trip fails.
- An age limit for answering: a backlog item is answered however old it is (only the number of round trips at a time is bounded).
- The `inbox_item` UI slot, a tool for the assistant to send messages on its own, backend-to-backend relay, HTTP callbacks from the router.
- More than one router or key per installed copy; translations.

## Tests

Run in this directory; it is a Go module of its own and needs nothing outside it:

```sh
go vet ./...
go test -count=1 ./...
```

Its only dependencies are public modules: Persona's extension SDK (`github.com/nwverse/persona/sdk/go`, MIT) and `github.com/coder/websocket`.

The tests run the program between a fake router (a WebSocket server speaking the backend frames, with a queue that pushes one item at a time until it is accepted) and a fake hub (HTTP, with a scripted assistant). They use synthetic data and obviously fake keys, and need no router, hub or account.
