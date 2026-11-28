# agents-io (message router backend)

[README](README.md) · [Manifest](persona-extension.json)

This extension (id `agents-io`) connects one Persona assistant to an agents-io message router as one of the router's backends. The router owns the messaging channels and decides, by its rule table, which messages this assistant gets; the extension's own routes, which you edit here, then decide what it does with each: file it in the Inbox, ignore it, hand it to an assistant conversation or to a specific Agent session you named, or, for your own message, start a new Agent session on one of your computers. The answer goes back through the router. The assistant can also send a message on its own initiative, once you confirm it on your phone. The [README](../../extensions/agents-io/README.md) describes the behavior in full: routes, tags, the sender line, starting Agents, delivery guarantees, hub scopes and what is not implemented.

This page describes version 0.4.0. Where the manifest shown in the install preview disagrees with this page, the manifest wins.

| Extension point | Contribution | Behavior |
| --- | --- | --- |
| `connectors` | `agentsio` (消息路由（agents-io）) | Capabilities `status`, `tools`, `actions`, `events`, `inbox`, `settle` and `fallback`: an Inbox source with its own fallback tiers that tells the hub when something new arrived and replies through the router. Two read-only tools (`agentsio_about`, `agentsio_destinations`) and one write, `agentsio_send`, which sends a text message through the router; it is listed under `confirm_always`, so every send is confirmed on your phone. No archive or sign-in. |

## Prerequisites

- An agents-io router whose `host.hello` lists the `backends` feature, with its console reachable from the hub's machine.
- A backend configured on the router for this assistant, and its key.
- A hub that grants the extension `assistant.ask`, `agents.read` and `agents.control` (starting an Agent session is `agents.control` too). Guest conversations need a hub and node that support them; the extension asks before each one.

## Set up the router

In generic terms (the router's own documentation has the exact syntax):

1. Add a backend to the router's configuration, one per assistant, and restart the router.
2. Add rules that route to it: a rule names the backend (`to`) and may carry a `tag` of `inbox`, `chat`, `guest`, `agent:<name>` or `launch:<name>`. You can also route everything of an account to the backend without a tag and decide in the extension's routes (below). Route to `chat` only the owner or people the assistant should act for; everyone else to `guest` or `inbox`. `agent:<name>` types the message straight into an Agent session that may have full access to its computer: use it only for senders you trust as much as yourself, never for people the router marks unknown. `launch:<name>` starts an Agent for the owner's own messages only. The router's identity map must give the label `owner` only to your own accounts.
3. Issue the backend's key on the router's machine. It is shown once.
4. Optional, for messages the assistant sends on its own initiative: the backend may already send to every conversation it was routed a message from. For any other conversation, register it for the backend in the router's configuration (the backend's `routes`: channel, account, conversation id) and name the same conversation in the extension's destinations setting. A router that knows a backend's delivered messages by their id (PB-8 in its documentation) does not route them back to this backend as new ones, so nothing more is needed for that. With an older router, or to cover what such a router cannot know (a send whose outcome stayed unknown; other consumers of the router seeing the echo of a slow send), list the account among the router's own accounts (`policy.selfAccounts`). Mind what that means: every message of that account then counts as the router's own, including what the owner types by hand on a personal account, and reaches only rules that ask for own messages. An entry is `<channel>:<channel user id>`, the id the account's own messages carry as their sender on that channel (for example `demo-chat:ou_example`), not the `account` field of a route or of a destinations line.
5. Make the console reachable from the hub: behind TLS termination, or on a trusted network only. The key is a bearer credential.

## Set up the extension

Install the extension, then open Settings › Extensions › 消息路由（agents-io）:

1. Fill in the router address (`https://<router address>`, or `http://` for a console without TLS on a trusted network).
2. Paste the backend key. Saving tries the handshake first and refuses settings that do not work, the first time too: neither setting is marked required, so the extension already runs (as not configured) and can check them.
3. Optional: when the router's rules carry no tag, list the rule ids for `chat` and `guest` in the two rule settings.
4. Optional: name destinations the assistant may send to, one per line, `<name> = <channel>:<account>:<conversation id>` (for example `Project room = demo-chat:default:oc_example`). Conversations the router already routed messages from need no line. Saving refuses a line that does not read, with its number.

5. Optional: name the Agent sessions a rule may route into, one per line, `<name> = <machine id>/<session id>` (for example `reviewer = mac-1/s-123`); the rule's tag is then `agent:reviewer`. Names use lowercase letters, digits, `-` and `_`. Read the security note in the README's "Routing to a specific Agent session" first. Saving refuses a line that does not read, with its number.
6. Optional: name what your own messages may start, in 可以启动的 Agent, one per line, `<name> = <machine id>/<launcher> [field=value …]`, for example `coder = mac-1/claude host=herdr cwd=~/repos/demo model=sonnet effort=high`. The launcher is one of that computer's launchers; the optional fields are `host`, `cwd`, `model`, `effort`, `permission_mode` and `speed`. Read the security note in the README's "Starting an Agent session" first.
7. Optional: write the extension's own routes in 分流规则, one rule per line, `<rule name>: <conditions> -> <action>`, tried from the top on every message the router hands over, before its tag. For example, on a personal account `personal` of the channel `demo-chat` that you share with the assistant:

   ```text
   ai: channel=demo-chat account=personal from=owner prefix=/ai -> launch:coder
   mine: channel=demo-chat account=personal from=owner -> ignore
   people: channel=demo-chat account=personal kind=dm,other -> inbox
   at-me: channel=demo-chat account=personal kind=group,thread mentions=ou_example -> inbox
   rest: channel=demo-chat account=personal -> ignore
   ```

   Your own messages that start with `/ai` start an Agent with `coder` (the rest of the message is its first prompt, and its answer comes back to that chat; later `/ai` messages there go to the same Agent while it runs); your other messages are ignored; other people's direct messages and group messages that @ you (`ou_example` stands for the account's own user id) go to the Inbox; the rest of that account is ignored. Conditions read the router's facts: `channel`, `account`, `kind`, `conv`, `from` (the router's verdict: `owner`, `known`, `unknown` or a label), `mentions`, `addressed` and `prefix`; `!=` means "not", commas list values. Saving refuses a line that does not read, with its number, a `launch:` rule without `from=owner`, and a rule whose target or launcher is not in the settings.

## Troubleshooting

The connector's status says one sentence. What each means:

| Status | Meaning | What to do |
| --- | --- | --- |
| 还没填路由地址和后端钥匙 (address or key not filled in) | Not configured. | Fill in both. |
| 连不上路由 (cannot reach the router) | No connection: wrong address, router down, or the network is closed. In the hub's sandbox, the address must be the one in the settings. | Check the address and that the console listens where the hub can reach it. |
| 路由拒绝了连接 (the router refused the connection) | The console answered the upgrade with a refusal other than the key: an origin or host name it does not allow. | Allow the host name on the router's console. |
| 路由不认这把后端钥匙 (the router does not accept this backend key) | The key is wrong, rotated or revoked; or the router has no `backends` feature, which refuses every `aiob_` key before any feature list is seen. The extension keeps trying, slowly. | Issue or rotate the key and paste the new one; on a router without backends, upgrade it and configure a backend first. |
| 这把钥匙不是后端钥匙 (this key is not a backend key) | The router answered as for another kind of token, such as its host token. The extension took no role on the router. | Paste the backend's key. |
| 这是一把只读钥匙 (this is a read-only key) | The key is the backend's read key (`aio backend key <backend id> --read`): it only observes, so the extension could neither take messages nor answer them. The extension never asks to consume with it and keeps trying, slowly. | Paste the backend's read-write key (the command without `--read`). |
| 路由没有开启后端功能 (the router has no backends feature) | `host.hello` was answered and did not list `backends` (whatever kind of key got in). | Upgrade the router and configure a backend. |
| 和路由的连接反复被顶掉 (the connection keeps being replaced) | Another program uses the same key. | Give each assistant its own backend and key. |
| 扩展的数据目录读写不了 (the data directory cannot be used) | Items cannot be recorded, so none are accepted; the router keeps them. | Fix the directory; nothing is lost. |
| 扩展没有拿到访问助手的授权 (no authorization to reach the assistant) | A hub scope is missing; `missing_scopes` lists which. Chat, guest and agent items go to the Inbox. | Grant the extension's permissions again. |

What the assistant is told when a send it asked for did not go out, and what to do:

| Answer | Meaning | What to do |
| --- | --- | --- |
| 没有发出（route_not_allowed）(not sent: the router does not allow it) | The router's admin has not registered this conversation for the backend; also answered while the channel is not running, or for a reply target the router no longer accepts. | Register the conversation under the backend's `routes` on the router, or wait for the channel and send again. |
| 没有发出：路由拒绝了这次发送（…）(not sent: the router refused this send, with a code) | The router refused the request with another code, quoted in the brackets. Nothing was sent. | Look the code up in the router's documentation. |
| 结果不明：消息可能已经发出，也可能没有 (outcome unknown) | The router did not answer in time: the message may be out. Nothing is resent by itself. | Look in the channel. Confirming the same text to the same place again within an hour of the first try asks the router about the first send instead of sending a second message. |
| 结果不明：路由自己也说不清 (outcome unknown, and the router cannot tell either) | The router settled the send as unknown and will never send it again. Nothing is resent by itself. | Look in the channel first. If the message is not there, send it again: it goes out as a new message, so if the first one did arrive the other side gets two. |
| 发得太频繁 (too many sends) | More than 3 sends a minute to one destination, or 10 in all. | Wait the seconds it names. |
| 路由现在连不上 (the router cannot be reached) | No connection at that moment. Nothing is queued for later. | Send again once the connector's status is fine. |

The card you confirm for a send says where the message goes, and below that who the router takes the person there for (路由对这个人的认定, or 最近发言 … 路由认定 for a group). A display name is whatever its owner typed: when the verdict is 身份未知 (unknown), the name alone does not make it the person you know. A line starting 注意 means another destination of that channel goes by the same name; check the time it gives, or cancel and say which one you mean. A group without a name is shown as 未命名的群聊, never under the name of whoever spoke there last.

A status that is fine and also says 设置里有 N 行目的地读不出来 (N destination lines could not be read) means the destinations setting was saved without the check and has lines in another form; they are skipped. One that says 近 24 小时主动发出 … (sends of the last 24 hours) counts the sends made, not sent and of unknown outcome.

A message tagged `chat` that shows up in the Inbox instead carries the reason in the item (for example: the outcome of a send was unknown and it was not resent, or the conversation went on in the app).

A message a route or a tag meant for `launch:<name>` that shows up in the Inbox says why: 只有路由认定为主人的消息才能启动 Agent (it is not your own message, as the router sees it: nothing was started), 要启动的 Agent 不在扩展设置的启动方式里 (the name is not in 可以启动的 Agent), 拒绝启动这个 Agent (Persona or the computer refused the start: check the machine id, the launcher and the fields of the line; nothing was started), 启动 Agent 的结果不明 or 扩展重启时正在启动 Agent，结果不明 (the start may have happened: look in Persona; it is never started a second time by itself), or 启动的 Agent 会话不见了 (the session went away before it answered).

A message tagged `agent:<name>` that shows up in the Inbox says why: 标签指定的 Agent 会话目标不在扩展设置里 (the tag names a target the settings do not have, or the name is not written as one: check the rule's tag against the setting, letter for letter), or 指定的 Agent 会话现在用不了 (the session is gone, hidden from extensions, or refused the message: check the machine and session ids of the line; nothing was typed and nothing is tried again).

A status that is fine and also says Agent 会话目标 N 个 counts the configured targets; 其中 M 个上次用时找不到 means M of them had no usable session when a message was last meant for them. 设置里有 N 行 Agent 会话目标读不出来 means the setting was saved without the check and has lines in another form; they are skipped.

A status that is fine and also says 路由规则 N 条，近 24 小时命中：… counts your routes and, for each in its order, the messages it decided in the last day; a rule that never matches may be written wrong (a channel or account name, a `kind` the channel does not use) or sit below one that matches first. 设置里有 N 行路由规则读不出来 means the routes were saved without the check and have lines in another form; they are skipped, and messages fall through to the rules below them. 可以启动的 Agent N 个 counts the launchers; 设置里有 N 行可以启动的 Agent 读不出来 means some lines of that setting are skipped.

A status that is fine and also says 有 N 条路由消息读不出来 (N routed messages could not be read) means the router pushed items in a shape this version does not read. Each left a placeholder in the Inbox with the router's queue cursor; look the message up on the router and upgrade the extension.

## Tests and verification

The extension's tests use a fake router and a fake hub on loopback:

```sh
go test -count=1 ./...   # in persona-plugin/
```

A check against a real router and a sandboxed hub is not part of the repository's tests.
