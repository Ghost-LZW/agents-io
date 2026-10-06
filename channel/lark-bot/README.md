# @agents-io/channel-lark-bot

agents-io channel adapter for the official Feishu/Lark bot platform: events arrive over the SDK's WebSocket long connection (no public URL), messages go out through the REST API.

## Create a bot

`agents-io-lark` creates the bot app for you through the official SDK device flow (OAuth device authorization). No console automation is involved.

```sh
agents-io-lark create                       # credentials -> ~/.config/agents-io/lark/<appId>.json (0600)
agents-io-lark create --brand lark --write-env .env.live
agents-io-lark verify --app-id cli_xxx --live
```

1. `create` prints a QR code (stderr) and its URL. Scan it with the Feishu/Lark app and confirm on the page. The default app name is `agents-io · {user}`; change it with `--name`.
2. The platform returns the app id and secret, plus the scanner's `open_id`. The secret is only written to the file you chose (`--write-credentials <path>`, or `--write-env <file>` which updates `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_DOMAIN`, `AGENTS_IO_OWNERS`); it is never printed. Files are mode 0600, new directories 0700.
3. The scanner's `open_id` is only valid inside the new app, so the tool asks that app (contact API, tenant token) for the user's `union_id` and records `lark-bot:<union_id>` as the owner. That is the key `defaultPolicy({ owners })` from `@agents-io/session` matches, because the adapter identifies senders by `union_id` first. If the lookup fails the owner is left unset; an unverified `open_id` is never saved. Retry later with `agents-io-lark owner --open-id ou_xxx --app-id cli_xxx` once the contact scope is granted.

The needed scopes, events and callbacks are defined once in `src/setup/requirements.ts` and a test fails if the adapter registers a handler that is not listed there. Currently: event `im.message.receive_v1`, callback `card.action.trigger`, and the tenant scopes listed in that file (send/read messages as the bot, receive DMs and @mentions; optional: all group messages, attachment download).

### What is automatic, what may not be

- The app, its bot capability and the credentials are created by the scan.
- Scopes, events and callbacks are sent as additive "addons" in the QR URL. The platform only honours them when its gray-scale for extra config is enabled for your tenant; otherwise they are silently ignored and the default template applies. `verify` will then report missing scopes. Fix it by opening the printed scopes link and pasting the printed JSON into the console's batch import box (permission management), and by checking the event subscription page for `im.message.receive_v1` and the `card.action.trigger` callback.
- Depending on tenant settings, the changes may need a version to be created and published (and admin approval) in the console before they take effect. This cannot be done from the tool.
- `agents-io-lark update --app-id cli_xxx` re-runs the flow for an existing app; you re-authorize the diff on the confirmation page.

### Verify

`agents-io-lark verify [--live] [--json]` reads `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` (or `--credentials <file>` / `--app-id`). It checks, with official APIs only:

| check | how | note |
|---|---|---|
| credentials | `tenant_access_token` | |
| bot | `GET /open-apis/bot/v3/info` | fails when the Bot capability is off |
| scopes | application v6 "get application info" | `unknown` if the app lacks `application:application:self_manage`; never guessed |
| events | not checkable | no official API lists event subscriptions; reported as `unknown` with a link |
| ws | `--live`: starts the WebSocket client and waits for `connected` | skipped otherwise |

Each problem comes with a console deep link (open.feishu.cn or open.larksuite.com) and the scopes JSON for batch import. Exit code is 1 when a check failed; `unknown` does not fail the run.
