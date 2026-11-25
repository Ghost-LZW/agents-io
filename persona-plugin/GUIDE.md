# agents-io (message router backend)

[README](README.md) · [Manifest](persona-extension.json)

This extension (id `agents-io`) connects one Persona assistant to an agents-io message router as one of the router's backends. The router owns the messaging channels and decides, by its rule table, which messages this assistant gets; the extension files them in the Inbox or hands them to an assistant conversation and sends the answer back through the router. The [README](../../extensions/agents-io/README.md) describes the behavior in full: tags, the sender line, delivery guarantees, hub scopes and what is not implemented.

This page describes version 0.1.0. Where the manifest shown in the install preview disagrees with this page, the manifest wins.

| Extension point | Contribution | Behavior |
| --- | --- | --- |
| `connectors` | `agentsio` (消息路由（agents-io）) | Capabilities `status`, `tools`, `events`, `inbox`, `settle` and `fallback`: an Inbox source with its own fallback tiers that tells the hub when something new arrived, replies through the router, and one read-only tool. No archive, actions or sign-in. |

## Prerequisites

- An agents-io router whose `host.hello` lists the `backends` feature, with its console reachable from the hub's machine.
- A backend configured on the router for this assistant, and its key.
- A hub that grants the extension `assistant.ask`, `agents.read` and `agents.control`. Guest conversations need a hub and node that support them; the extension asks before each one.

## Set up the router

In generic terms (the router's own documentation has the exact syntax):

1. Add a backend to the router's configuration, one per assistant, and restart the router.
2. Add rules that route to it: a rule names the backend (`to`) and may carry a `tag` of `inbox`, `chat` or `guest`. Route to `chat` only the owner or people the assistant should act for; everyone else to `guest` or `inbox`.
3. Issue the backend's key on the router's machine. It is shown once.
4. Make the console reachable from the hub: behind TLS termination, or on a trusted network only. The key is a bearer credential.

## Set up the extension

Install the extension, then open Settings › Extensions › 消息路由（agents-io）:

1. Fill in the router address (`https://<router address>`, or `http://` for a console without TLS on a trusted network).
2. Paste the backend key. Saving tries the handshake first and refuses settings that do not work, the first time too: neither setting is marked required, so the extension already runs (as not configured) and can check them.
3. Optional: when the router's rules carry no tag, list the rule ids for `chat` and `guest` in the two rule settings.

## Troubleshooting

The connector's status says one sentence. What each means:

| Status | Meaning | What to do |
| --- | --- | --- |
| 还没填路由地址和后端钥匙 (address or key not filled in) | Not configured. | Fill in both. |
| 连不上路由 (cannot reach the router) | No connection: wrong address, router down, or the network is closed. In the hub's sandbox, the address must be the one in the settings. | Check the address and that the console listens where the hub can reach it. |
| 路由拒绝了连接 (the router refused the connection) | The console answered the upgrade with a refusal other than the key: an origin or host name it does not allow. | Allow the host name on the router's console. |
| 路由不认这把后端钥匙 (the router does not accept this backend key) | The key is wrong, rotated or revoked; or the router has no `backends` feature, which refuses every `aiob_` key before any feature list is seen. The extension keeps trying, slowly. | Issue or rotate the key and paste the new one; on a router without backends, upgrade it and configure a backend first. |
| 这把钥匙不是后端钥匙 (this key is not a backend key) | The router answered as for another kind of token, such as its host token. The extension took no role on the router. | Paste the backend's key. |
| 路由没有开启后端功能 (the router has no backends feature) | `host.hello` was answered and did not list `backends` (whatever kind of key got in). | Upgrade the router and configure a backend. |
| 和路由的连接反复被顶掉 (the connection keeps being replaced) | Another program uses the same key. | Give each assistant its own backend and key. |
| 扩展的数据目录读写不了 (the data directory cannot be used) | Items cannot be recorded, so none are accepted; the router keeps them. | Fix the directory; nothing is lost. |
| 扩展没有拿到访问助手的授权 (no authorization to reach the assistant) | A hub scope is missing; `missing_scopes` lists which. Chat and guest items go to the Inbox. | Grant the extension's permissions again. |

A message tagged `chat` that shows up in the Inbox instead carries the reason in the item (for example: the outcome of a send was unknown and it was not resent, or the conversation went on in the app).

A status that is fine and also says 有 N 条路由消息读不出来 (N routed messages could not be read) means the router pushed items in a shape this version does not read. Each left a placeholder in the Inbox with the router's queue cursor; look the message up on the router and upgrade the extension.

## Tests and verification

The extension's tests use a fake router and a fake hub on loopback:

```sh
go test -count=1 ./...   # in persona-plugin/
```

A check against a real router and a sandboxed hub is not part of the repository's tests.
