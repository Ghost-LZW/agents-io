# agents-io (message router backend)

A [Persona](https://github.com/nwverse/persona) extension that connects one Persona assistant (one manager) to an [agents-io](#what-it-is) message router as one of the router's **backends**. Messages the router routes to this backend go to the Inbox, or to an assistant conversation whose final answer is delivered back to the channel conversation the message came from. The assistant can also send a message on its own initiative, through the router, once the owner confirms it.

- [Extension guide](GUIDE.md)
- [The router side: backends, keys, frames](../docs/HOSTS.md)
- [Manifest](persona-extension.json)

This page describes version 0.2.0.

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

The extension contributes one connector, `agentsio` (connector ids allow no hyphen), with the capabilities `status`, `tools`, `actions`, `events`, `inbox`, `settle` and `fallback`.

## Configuration

| Setting | Kind | Meaning |
| --- | --- | --- |
| `router_url` | address | The router console's address: scheme, host and port only, for example `https://<router address>`. The extension connects to its `/ws`. `http://` is accepted because the router console itself speaks plain HTTP (see [Network](#network)). |
| `backend_key` | secret | The key the router issued for this backend (`aio backend key <backend id>` on the router's machine; it looks like `aiob_example_key_not_real`). Stored through the hub's encrypted secret flow, handed to the program at start, never logged. It must be the backend's read-write key (the command without `--read`): the extension consumes, accepts and answers. A read key (`aiobr_…`, `aio backend key <backend id> --read`) only observes: the router says which level a key is when it answers `host.hello`, so the extension refuses a read key when the settings are saved, never asks to consume with one, and the status says it is a read-only key. Do not put the router's host token here: the extension refuses a key that is not a backend's before taking any role on the router. |
| `chat_rules` | list of rule names | Router rule ids whose items are handled as `chat` when the item carries no tag. |
| `guest_rules` | list of rule names | Router rule ids whose items are handled as `guest` when the item carries no tag. |
| `destinations` | list of lines, at most 32 | Named destinations the assistant may send to before the router ever routed a message from them, one per line: `<name> = <channel>:<account>:<conversation id>`, for example `Project room = demo-chat:default:oc_example`. See [Named destinations](#named-destinations). No secrets belong here, and a line that looks like a key or an address is refused. |
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

**Who should be routed where.** Persona has no sender field: everything this extension sends into a `chat` conversation is treated as the owner speaking, with the owner's tools and data (the send tool included: a person routed to `chat` can ask the assistant to message another conversation, and the owner's confirmation on their phone is what stands between that request and a message). The only statement of who actually wrote the message is the first line of the text (below). So route to `chat` only the owner, or people the manager is meant to act for; route other people to `guest` or `inbox`. That decision is made in the router's rule table, not here. Message text can still try to instruct the assistant (prompt injection); guest conversations limit what that can reach.

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
- Two read-only tools. `agentsio_about` says where a conversation's messages come from; it returns no message content, and exists because a guest conversation must name one to eight connector tools (it is the only one a guest conversation gets). `agentsio_destinations` lists where the assistant can send (below).

## Sending on the assistant's own initiative

Besides answering what was routed to it, the assistant can send a text message to a channel conversation by itself: to reach a person or another assistant through a channel. Two connector tools do it.

| Tool | Kind | What it does |
| --- | --- | --- |
| `agentsio_destinations` | read (`tools.list` / `tools.call`) | Lists the destinations, the last sends and their outcomes, and the limits. No arguments. |
| `agentsio_send` | write (`actions.list` / `actions.describe` / `actions.do`) | Sends `text` to the destination `to`, optionally as a reply to the message `reply_to`. |

**The owner confirms every send.** The product's connector protocol lets a write happen only in answer to `actions.do`, which the hub calls after its write gate let the call through. The manifest lists `agentsio_send` under `confirm_always`, so no allow rule can turn the gate into "always allow": each send is confirmed on the owner's phone, on a card that shows where the message really goes (from the extension's own table, not from what the model wrote), who the router takes the person there for, who will see it, and the whole text ([the card](#the-confirmation-card)). The tools are not offered to coding agents (`agent_tools` is not declared) and a guest conversation cannot name them.

**Destinations.** A destination is a channel conversation: channel, account and conversation id, the grain of the router's send scope. The assistant never sees or types those. `agentsio_destinations` gives each destination an opaque id (`d-` and twelve hex digits, derived from the coordinates), and `agentsio_send` accepts only an id that is in the list at that moment; any other argument (a channel, a conversation id, attachments) is refused. The list has:

- the conversations the router routed a message from, with a reply route (`source: "seen"`): the channel, the kind of conversation, `label` (the chat's own name; for a direct message without one, the display name of the person in it), `last_from` (the display name of the last person who wrote there, when that is not the label), `sender_verdict` (the router's verdict on that last person, in the sender line's words: owner, known labels or unknown, and the evidence), `same_label`, when a message was last seen, and `last_ref`, the reference of the newest message that can be replied to. These are remembered in the extension's own storage for 180 days after the last message, longer than the journal keeps the messages, because the router's permission to send there does not expire;
- the named destinations of the settings (`source: "named"`, or `"seen+named"` when the conversation is both).

It returns no account, no conversation id and no message text. Names other people chose are stripped as in the sender line. At most 100 destinations are listed: the named ones, then the conversations seen most recently.

**A name is not an identity.** A label or `last_from` is whatever the other side typed as its display name, and every conversation the router routed a message from is in the list, a stranger's direct message tagged `inbox` included. So:

- a group or thread without a name has no label. It is never called by whoever spoke there last: that person is `last_from`, and the list and the card say "a group without a name";
- every seen destination carries the router's verdict on the last person who wrote there (for a direct message: on the person it is with). The verdict is the router's stamp, kept with the conversation in the extension's storage, so it outlives the journal like the label does. A stranger who takes the display name of somebody the owner knows is still listed as unknown;
- destinations of one channel that go by the same name (the owner's name for one, a chat's name, a person's display name, compared without case) are marked `same_label: true`, and the tool's note tells the assistant to ask the owner which one is meant when it cannot tell.

### The confirmation card

`actions.describe` answers the card the owner confirms. Its first lines come from the extension's own records, never from the model's arguments:

```text
发到：<the owner's name for it, the chat's name, or the person>（<channel> <kind>）；回复 <who> <time> 的消息
路由对这个人的认定：<verdict>                     a direct message labeled by its person
最近发言：<display name>（路由认定：<verdict>）     any other conversation
注意：这个渠道里还有 N 个显示名相同的目的地；这一个最近一次来消息是 <time>

<the whole text>
```

The reply clause, the verdict line and the warning appear only when they apply; a named destination nothing was received from has no verdict, and its warning says it has not been heard from. The card's `visible` field says who will see the message: the other person of a direct message, everybody in the named group, or "everybody in this group" for a group without a name.

### Named destinations

A conversation the backend was never routed a message from can be named in the `destinations` setting. **Naming it here is not enough: the router's admin must also register the same conversation for this backend, under `backends.<backend id>.routes` in the router's configuration** (channel, account and conversation id, compared field by field). Until then the router answers `route_not_allowed` and the send says so.

A line is `<name> = <channel>:<account>:<conversation id>`, split at the first `=` and the first two `:` after it, so a conversation id may contain colons; a channel or account name with a colon or a space cannot be written this way. The name is one to 40 characters and unique whatever its case; channel and account are at most 64 characters, the conversation id at most 256, none with spaces; a conversation has one name; a line containing `aiob_` or `://` is refused, so a key or an address pasted here never gets saved. `settings.check` refuses the first line that does not read, with its number, before anything is saved (whether or not an address is filled in). A configuration saved without the check (an older hub) starts anyway: the lines that do not read are skipped and the connector's status counts them.

The assistant can propose changes to this list like to any other plain setting; a conversation the router's admin did not register still cannot be sent to.

### What a send does

`reply_to` takes the reference from a sender line (`ref=<16 hex digits>`, or the digits alone) or a destination's `last_ref`. It must name a message the extension received in that destination's conversation and still has in its journal; the message then goes out on that message's reply route (its thread included). Without `reply_to` the message goes to the conversation itself, outside any thread.

The message goes out with the router's `deliver`. Its operation id is `send-<hash of the hub's request id>`, and the router sends at most once per operation id:

- the same call repeated (the hub's `request_id` is the same) is answered from the extension's own record with the first call's result, and the router is not asked at all; a repeat that arrives while the first is under way waits for it. This holds across a restart, and if the record is gone the router itself answers the settled operation;
- the record is written before the request, so a send found mid-request after a restart is an unknown outcome, not an unsent message;
- a call without a request id is refused: nothing would make it happen once.

The answer says plainly which of three things happened:

| Outcome | Meaning | What the assistant is told |
| --- | --- | --- |
| delivered | The router settled the operation as delivered. | Success, with the destination's label; the platform's message id goes to the hub's sent-as-user ledger as `message_ref`. |
| refused (not sent) | The router refused the request (nothing was sent, the operation id is not used up), the channel rejected the message, or the connection was gone before anything was written. | An error in one sentence. `route_not_allowed`: the router's admin has not allowed this backend to send there (or the reply target is no longer accepted, or the channel is not running): it names `backends.<id>.routes`. `stopped`, `unauthorized`: the router cannot be reached now. Any other code is quoted. |
| unknown | No answer within 45 seconds, the router's `internal`, or a settled status of `unknown`: the message may be out. | An error saying so, that nothing is resent, and to check in the channel. |

A reply target the router refuses with `route_not_allowed` is asked once more, under the same operation id, without the reply target (as for answers); the result then says the message did not go out as a reply. Nothing else is retried: two requests of 45 seconds end before the hub's two-minute wait for a connector call does, so the extension is the one that says "unknown". Everything but a delivered send is reported as an error, so the hub's ledger has only what was really sent; the extension's own records show the rest, in `agentsio_destinations` (`recent_sends`: destination id, label, time, outcome, code; never the text) and in the connector's status (sends, not sent and unknown outcomes of the last 24 hours).

**After an unknown outcome.** The outcome is never asked for again by itself. When the owner confirms the same text to the same destination (and the same reply target) again within an hour of the first call, that new call asks the router under the first call's operation id: the router answers the record it settled ("it had gone out; not sent again", or the channel's rejection, which then is the first call's outcome too) or sends for the first time. So "unknown, try again" cannot produce two messages. The hour is counted from the first call; a call that continued it and stayed unknown does not start it again. After the hour, or with another text, it is a new message.

One case ends the continuation early. When the router itself answers that the operation is settled as `unknown` (it sent, or tried to, and could not record or learn what happened), it will never send under that operation again, so asking under it could only repeat "unknown" and the text could never go out. The answer then says so: the router cannot tell either and will not send again; the owner should look in the channel first; a next send of the same text is a new message, and if the first one did go out the other side gets two. From then on the same text confirmed again goes out under its own operation id. The decision to send again is the owner's, on the card, after that warning.

**Limits.**

- Text only, at most 2000 characters after control characters are removed. A backend key cannot read a channel's own limit from the router, so this is a constant; a longer text is refused, never cut. A channel with a lower limit splits or rejects the message itself, and the outcome says what happened.
- At most 3 sends a minute to one destination and 10 a minute in all, counted from the extension's records (a restart does not reset it; refused and unknown attempts count). Beyond that the call is refused with the code `rate_limited` and `retry_after`, before the owner is asked. Counting and recording a send are one step, so calls the hub runs at the same moment cannot all find room.
- While the connection to the router is down a send is refused at once, also before the owner is asked. Nothing is queued: no send goes out later by itself, not after a reconnect and not after a restart.
- The extension cannot ask the router where it may send. A destination in the list can have lost its permission (the admin removed the route or forgot the backend's conversations) or its channel may not be running; the send finds out and says so.

**Guidance for the assistant** is in the two tools' descriptions, which travel with the tools: use them to reach a person or another assistant through a channel; say whose assistant is writing and for whom; never claim in a message that the owner approved or agreed to something; do not use the tool to repeat an answer in a routed conversation, whose final answer is delivered anyway; report `route_not_allowed` honestly; never rephrase and resend after an unknown outcome. The answer of `agentsio_destinations` carries a note of its own: names are what the other side chose, `sender_verdict` is the router's word, somebody whose verdict is unknown is not to be taken for a person the owner knows by the name alone, a group without a label is not to be called by `last_from`, and with `same_label` the owner is asked which one is meant.

### Own messages coming back

A channel may report the account's own messages as inbound ones, so a message the extension sent can come back through the router as a queue item.

- **The router does this itself now.** A router that keeps the promise PB-8 of its `docs/INVARIANTS.md` (see "自己发的消息回来" in `docs/HOSTS.md` §4.12) knows a message this backend delivered by its platform message id when the channel hands it back, with no configuration: every message of a delivery the channel split, and a message later edited. Such an item is never queued for the backend that sent it, whatever its rules say, and it is not somebody speaking: the router stamps it as its own (`origin.self`, no principal) and routes it only to rules that ask for own messages (`match.includeSelf`), so another backend sees it only if its rule asks, as a stamped item. The admin sees why in the router's `explain` (`echoOf`, and `own_echo` on the skipped rule). The router also covers the echo that arrives before the send was answered: while a deliver of this backend into a conversation is under way, an inbound message of that conversation waits a short time for it to settle (two seconds by default), and after that the router still keeps the message from this backend, and only from it, until the deliver has settled; then it drops the item if it is the delivered message and queues it otherwise. So a message this backend delivered with a known outcome is not queued for it, however long the send took; another person's message that arrives during a slow send reaches the extension once the send is over.
- The router knows its own inputs two more ways, as before: `policy.selfAccounts` (the account's own user id) and, for a turn of its own host, its outbound index. One that does arrive stamped is recorded and skipped, as before. Listing the account in `policy.selfAccounts` is no longer needed for the echoes of this backend's delivers, and it means more than that: every message of that account is then the router's own, including what the owner types by hand on a personal account. List it when that is what is wanted, or to cover what the router cannot know by id (below). An entry there is `<channel>:<channel user id>`, the id the account's own messages carry as their sender on that channel (for example `demo-chat:ou_example`). It is **not** the `account` of a destinations line or of a route (`demo-chat:default` names the router's channel entry and matches no sender).
- The extension's own recognition stays, for what the router cannot do. It is the only defense against a router from before PB-8 (which routes the echo as an ordinary message of that account), and with a newer router it covers the cases the router states as not known: a deliver the router itself settled as unknown (it recorded no message id for it), and a channel that gives the router no platform evidence or gives the echo another id than the one the send was answered with. With a router that keeps PB-8 the three steps below seldom see anything; they cost nothing then.
- The extension remembers the platform ids of every message it delivered (an answer, an Inbox reply, a send; for seven days), the same evidence the router uses. An item whose channel and message id match is recorded and skipped: it is not filed in the Inbox, not handed to a conversation, and does not become a destination's label or reply target.
- A channel may hand the echo to the router before the router answers the send. An item of a conversation that has a deliver under way waits up to three seconds for the answer before it is judged; one taken earlier than that (still in the Inbox, or waiting for its turn) is turned into a skipped one when the answer arrives. Having been taken as somebody's message, it may have named the conversation and become its newest message; the conversation then takes its label, verdict and reply target again from the messages of other people the journal still has (none of the three when there is none: no name rather than the account's own).
- A send the assistant asked for whose answer never came (the outcome is unknown, or the request is still open) has no id to be known by. Its echo is known by the conversation and the text instead: an item of the same conversation with exactly the text that was sent, arriving within ten minutes of the send, is recorded and skipped, and its message id is remembered like a delivered one's. One send explains one item, and an item from somebody the journal has another message from in that conversation is never taken for an echo, whatever it says. The send's own outcome stays unknown: this is a guess about an item, not the router's word about the send. It can be wrong one way: a person who never wrote in that conversation (or whose messages the journal no longer has) and sends exactly the same text within those minutes is skipped. The item is in the journal as skipped; it is not in the Inbox.

Not recognized: an echo whose text the channel shows differently from what was sent when the send's outcome is unknown or the channel gives the echo another id than the one the send was answered with; the echo of an answer or an Inbox reply (not a send the assistant asked for) whose outcome stayed unknown; and an echo whose round trip had already started by the time the send was answered. If a rule tags those `chat`, the assistant may answer its own message once; the answer's echo is then known. With a router that keeps PB-8 most of this is closed on the router's side: it knows the echo by the id it recorded for the deliver, whether or not its answer ever reached the extension, whatever the text looks like and whichever kind of send it was, and it holds an echo that comes before the send is recorded. What remains with such a router: a deliver the router itself settled as unknown (it has no id for it), and an echo the channel gives another id than the one the send was answered with. `policy.selfAccounts` on the router covers both. (The echo of a send slower than the router's short wait is still kept from this backend; other consumers of the router may see it as an ordinary message of that account, which `policy.selfAccounts` also covers.)

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
- **A send the assistant asks for goes out at most once.** Its operation id comes from the hub's request id; a repeat is answered from the extension's record; an unknown outcome is not retried, and the same text confirmed again within an hour continues the first operation instead of starting a second ([above](#what-a-send-does)).
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

Three JSON files in the extension's data directory, mode 0600, replaced atomically: `journal.json` (one record per item: who, where, the text capped at 16 KiB, and where its handling stands), `conversations.json` (channel conversation to assistant conversation) and `outbound.json` (below). Finished records are dropped after `keep_days`; a running round trip is never dropped, nor an Inbox item the hub holds open. An Inbox item past the hub's seven-day window that the hub does not hold open is closed, then dropped like any finished record. The journal is capped at 5000 records (the oldest finished ones go first, then the oldest Inbox items), and the mapping of a channel conversation nobody wrote in for 180 days is dropped, so the next message there opens a new assistant conversation. This runs at start and every hour.

`outbound.json` has what sending needs: the conversations seen (coordinates, kind, chat name, the last sender's display name and the router's verdict on them, the newest message's reference, when last seen; written for a new conversation or a changed label or verdict and otherwise at most once an hour, and rebuilt from the journal at start, which is also how a data directory of 0.1.0 gets them), one record per send (destination id, operation id, outcome, refusal code, the platform's message id, times, the text's length, a digest of destination, reply target and text and a digest of the text alone, and the id of the item taken for its echo; **never the text**), and the platform ids of the messages the extension delivered. Settled sends are dropped after `keep_days` and capped at 500, conversations after 180 days without a message and capped at 500, message ids after seven days and capped at 2000. A file that cannot be read is set aside as `.corrupt` like the others, and the status says so.

Media is never stored: an image, file or voice message is named in the text as a placeholder. The log has states, counts, short hashes and error codes only: no key, no token, no message text, no names, no addresses.

## One receiver per channel account

If another extension (for example Open Lark) still receives the same channel account, every message is handled twice. The extension cannot detect that. When the router takes over an account, make sure nothing else in Persona consumes it.

## Not implemented in 0.2.0

- Approvals in the channel: a pending permission or question of a conversation is not shown as a card, and a card click is recorded and skipped. A turn that waits for an approval is answered in the Persona app; the run waits meanwhile.
- Media: attachments are named, not fetched, and none are sent (not by `agentsio_send` either).
- Progress cards and streaming: only the final answer is delivered, plus the working / done / failed mark.
- Earlier channel messages as context for a new conversation (`history.read`), pull consumption (`inbound.read` / `inbound.ack`).
- Folding several messages of one conversation into one turn, and a second answer after background work.
- Channel commands (a fresh conversation, stop, status) and a notice in the channel when a round trip fails.
- An age limit for answering: a backlog item is answered however old it is (only the number of round trips at a time is bounded).
- Sending: editing or taking back a sent message (`deliver.update`, the connector's `recall`), a send into a named thread that is not a reply, addressing a person rather than a conversation, a channel's real text limit, asking the router afterwards what became of an unknown send, the two tools for coding agents. A person's identity beyond the router's verdict on the last sender of a conversation: the extension does not verify who is in a conversation, and a group's members are not listed.
- An instructions or skill contribution for the assistant: the guidance is in the tool descriptions only.
- The `inbox_item` UI slot, backend-to-backend relay, HTTP callbacks from the router.
- More than one router or key per installed copy; translations.

## Tests

Run in this directory; it is a Go module of its own and needs nothing outside it:

```sh
gofmt -l .
go vet ./...
go test -count=1 ./...
```

Its only dependencies are public modules: Persona's extension SDK (`github.com/nwverse/persona/sdk/go`, MIT) and `github.com/coder/websocket`.

The tests run the program between a fake router (a WebSocket server speaking the backend frames, with a queue that pushes one item at a time until it is accepted) and a fake hub (HTTP, with a scripted assistant). They use synthetic data and obviously fake keys, and need no router, hub or account.
