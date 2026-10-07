# @agents-io/channel-lark-bot

agents-io channel adapter for the official Feishu/Lark bot platform: events arrive over the SDK's WebSocket long connection (no public URL), messages go out through the REST API.

## Create a bot

Provision the app with [create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot); this package does not create or configure apps. Pass it a custom name and avatar, and request at least what this adapter needs:

- event `im.message.receive_v1`, callback `card.action.trigger`;
- the tenant scopes in `src/requirements.ts` (`TENANT_SCOPES`, also exported). `runtime` scopes are required; `optional` ones enable reading non-@ group messages and attachment download.

`scopesJson()` returns the same list in the console's batch-import format. A test fails if the adapter starts registering an event or callback that is not listed in `requirements.ts`, so the list stays in step with the code.

For example:

```sh
npx github:Ghost-LZW/create-lark-bot#v0.2.1 --name "my agent" --avatar ./avatar.png \
  --preset messaging,contact --write-env .env.live \
  --env-owner-var AGENTS_IO_OWNERS --owner-prefix lark-bot:
npx github:Ghost-LZW/create-lark-bot#v0.2.1 verify --live
```

`messaging` covers every scope, event and callback in `requirements.ts`; `contact` lets the tool resolve your union_id, which it writes as the owner key.

Then give the adapter the credentials (`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_DOMAIN`). The owner key that `defaultPolicy({ owners })` from `@agents-io/session` matches is `lark-bot:<union_id>`, because the adapter identifies senders by `union_id` first (falling back to `open_id`).
