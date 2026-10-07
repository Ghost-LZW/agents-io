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

Then give the adapter the credentials (`appId`, `appSecret`, `domain` in its config; the aio daemon reads them per channel entry, or from `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` for a single entry). An adapter sends only to routes of the account it was started with (several bots in one daemon each have their own account). The owner key that `defaultPolicy({ owners })` from `@agents-io/session` matches is `lark-bot:<union_id>`, because the adapter identifies senders by `union_id` first (falling back to `open_id`).

## Process rendering

A message that carries `progress` (the session compositor attaches it on `card`/`full` tiers) is rendered natively; `config.process` picks how:

| `process` | Reply card | Thinking / tool calls |
|---|---|---|
| `auto` (default) | status, plan, typewriter answer, buttons, footer | Feishu's native thinking bubble (`message_cot`) while it works in the chat; otherwise collapsible panels on the card |
| `cot` | same | thinking bubble only; if it fails, the process is not shown |
| `panels` | same, plus collapsed thinking and tool-call panels (last `processMaxEntries` entries, `processPanelMaxChars` each) | on the card |
| `off` | the flat text/sections card | not shown |

The reply card is a CardKit card in streaming mode (`cardkit:card:write`): the answer streams with the typewriter effect, other parts update on their own element ids. On failure it degrades per chat (per app for permission errors, for `degradeTtlMs`): streaming → full `card.update` → an ordinary card replaced by `im.message.patch`. Thinking-bubble failures are remembered the same way and never affect the reply card. An answer larger than the card continues in follow-up cards when the turn ends. The bubble is opened on the first process step, so in the chat it appears below the reply card; it settles with the turn (`RUN_FINISHED`).

Buttons in `actions` (approvals, and the stop button `turn:<turnId>:interrupt` when the compositor runs with `interruptButton: true`) come back as `action` events, which `Ingress` turns into `resolve` / `interrupt` commands.

## Card style

`style: 'emoji'` (default) decorates the status line, panel titles and tool lines with icons; `style: 'plain'` uses words only and lets the card header colour carry the status. In the dev gateway: `{ "type": "lark-bot", "config": { "style": "plain" } }`. What the agent sees and how its output is rendered on each channel: [docs/CHANNELS.md](../../docs/CHANNELS.md).
