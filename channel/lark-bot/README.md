# @agents-io/channel-lark-bot

agents-io channel adapter for the official Feishu/Lark bot platform: events arrive over the SDK's WebSocket long connection (no public URL), messages go out through the REST API.

## Create a bot

Provision the app with [create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot); this package does not create or configure apps. Pass it a custom name and avatar, and request at least what this adapter needs:

- event `im.message.receive_v1`, callback `card.action.trigger`;
- the tenant scopes in `src/requirements.ts` (`TENANT_SCOPES`, also exported). `runtime` scopes are required; `optional` ones enable reading non-@ group messages and attachment download.

`scopesJson()` returns the same list in the console's batch-import format. A test fails if the adapter starts registering an event or callback that is not listed in `requirements.ts`, so the list stays in step with the code.

For example:

```sh
npx github:Ghost-LZW/create-lark-bot#v0.2.3 --name "my agent" --avatar ./avatar.png \
  --preset messaging,contact --write-env .env.live \
  --env-owner-var AGENTS_IO_OWNERS --owner-prefix lark-bot:
npx github:Ghost-LZW/create-lark-bot#v0.2.3 verify --live
```

`messaging` covers every scope, event and callback in `requirements.ts`; `contact` lets the tool resolve your union_id, which it writes as the owner key.

Inbound `merge_forward` messages are expanded with `im.v1.message.get`: the agent receives the child messages in order, with sender IDs and text, rich text, and placeholders for media. Expansion is capped at 100 messages and 16,000 characters. If the bot cannot read the forwarded content, the input says so explicitly. Media in merged-forward child messages are not downloaded by this adapter.

Then give the adapter the credentials (`appId`, `appSecret`, `domain` in its config; the aio daemon reads them per channel entry, or from `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` for a single entry). An adapter sends only to routes of the account it was started with (several bots in one daemon each have their own account). The owner key that `defaultPolicy({ owners })` from `@agents-io/session` matches is `lark-bot:<union_id>`, because the adapter identifies senders by `union_id` first (falling back to `open_id`).

## Process rendering

A message that carries `progress` (the session compositor attaches it on `card`/`full` tiers) is rendered natively; `config.process` picks how:

| `process` | Reply card | Thinking / tool calls |
|---|---|---|
| `auto` (default) | status, plan, typewriter answer, buttons, footer | Feishu's native thinking bubble (`message_cot`) while it works in the chat; otherwise collapsible panels on the card |
| `cot` | same | thinking bubble only; if it fails, the process is not shown |
| `panels` | same, plus collapsed thinking and tool-call panels (last `processMaxEntries` entries, `processPanelMaxChars` each) | on the card |
| `off` | the flat text/sections card | not shown |

The reply card is a CardKit card in streaming mode (`cardkit:card:write`): the answer appears before the collapsed process details and streams with the typewriter effect. In `chat` look, an empty status and footer take no space; a status is inserted when an approval or failure needs explanation. A topic title uses a blue header. CardKit prints one character every 50 ms; text updates default to 1.2 seconds apart, and mutations of one card are serialized with at least 120 ms between requests. CardKit JSON defaults to a 28 KB budget. On failure it degrades per chat (per app for permission errors, for `degradeTtlMs`): streaming → full `card.update` → an ordinary card replaced by `im.message.patch`. Thinking-bubble failures are remembered the same way and never affect the reply card. An answer larger than the card continues in follow-up cards when the turn ends. The bubble can open before the reply card and settles with the turn (`RUN_FINISHED`); a turn that completes before the preview delay gets no bubble.

### Reply timing in the daemon

The daemon waits at least 5 seconds before opening the first reply card, then opens it when answer text arrives. After 2 seconds, native CoT opens if there is reasoning text or a tool call to show. An approval opens the card immediately. The Lark reply card has no Stop button. A turn that finishes before the card opens gets one final reply: prose and ordinary Markdown up to one message (default 4000 characters) use text or a rich-text post; code blocks, tables and longer answers use a card. `openDelayMs` and `previewDelayMs` on the channel entry override the 5-second and 2-second defaults; `openDelayMs: 0` restores immediate cards. The daemon also defaults to `look: "chat"` unless configured otherwise.

The adapter's direct-use defaults remain unchanged. These settings can be adjusted for a bot:

| Setting | Effect |
|---|---|
| `look: 'chat'` | The card is the answer alone: no header (a topic keeps its title), no status line, no elapsed / tool-count footer, no plan once done. A status line appears only while an approval waits, or when the turn failed, was interrupted or has an unknown outcome. Buttons stay. The direct adapter defaults to `console`; the daemon defaults to `chat`. |
| `cotOn: 'tool'` | The thinking bubble opens at the turn's first tool call, so a turn that only thinks and answers shows none. A bubble opened after the reply card sits below it. Default `turn`. |
| `look: 'chat'` (plain replies) | A completed reply within one message, without fenced code, tables or buttons, goes as a text message or rich text (`post`). Other replies use a card. |
| `ackEmoji: { working?, done?, failed? }` | Reactions used to acknowledge inbound messages when the daemon's channel entry sets `ack` (default `OnIt` / `DONE` / `CrossMark`). Needs `im:message.reactions:write_only`; without it a warning is logged once and there are none. |
| `processByChat: { dm?, group? }` | `process` per kind of chat, e.g. `{ "group": "off" }` for no process at all in groups. A chat's kind is learnt from its messages; a chat the bot has not heard from uses `process`. |

For example, to open CoT only on tool calls and disable process rendering in groups:

```jsonc
{ "type": "lark-bot", "ack": true, "config": { "cotOn": "tool", "processByChat": { "group": "off" } } }
```

Buttons in `actions` (approvals, and the stop button `turn:<turnId>:interrupt` when the compositor runs with `interruptButton: true`) come back as `action` events, which `Ingress` turns into `resolve` / `interrupt` commands.

## Card style

`style: 'emoji'` (default) decorates the status line, panel titles and tool lines with icons; `style: 'plain'` uses words only and lets the card header colour carry the status. In the dev gateway: `{ "type": "lark-bot", "config": { "style": "plain" } }`. What the agent sees and how its output is rendered on each channel: [docs/CHANNELS.md](../../docs/CHANNELS.md).
