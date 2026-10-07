# 飞书 / Lark 会议通道调研：转写、视频、文档、会中聊天、语音回复（Codex realtime）

> 调研日期 2026-10-07。只调研，不实现。
> 证据来源（下文用方括号标注）：
> - [botmux]：`scratchpad/repos/botmux` HEAD `32839be`，主要看 `docs/design/2026-06-30-vc-bot-subscriptions-integration.md`、`2026-07-01-vc-bot-realtime-voice.md`、`src/vc-agent/**`、`src/daemon.ts`。这是飞书会议机器人的真实实现，作者在字节内部租户上实测过。
> - [SDK]：`channel/lark-bot/node_modules/@larksuiteoapi/node-sdk` **1.74.0** 的 `types/index.d.ts` 和 `lib/index.js`。
> - [lark-cli]：本机 `lark-cli 1.0.68`，`lark-cli vc --help`，以及它自带的 skill 文档 `lark-cli skills read lark-vc-agent`（含 references）和 `lark-vc`。
> - [open-docs]：`open.feishu.cn/llms.txt` → `llms-docs/zh-CN/llms-video-conferencing.txt`、`llms-minutes.txt`，以及其中几篇 `.md` 文档。
> - [codex-ts]：`codex app-server generate-ts --experimental` 的输出（codex-cli 0.160.1），放在 `scratchpad/codex-ts-exp/`。
> - [codex-bin]：用 `strings` 扫 0.160.1 二进制得到的字符串。
> - [probe]：本次做的实际探测，脚本在 `scratchpad/probe/realtime-probe.mjs`。
> - [create-lark-bot]：npx 缓存里的 create-lark-bot 0.2.2 `dist/`。
>
> 标 **[推测]** 的是没有代码或文档直接证实的判断。

---

## 0. 结论

| 能力 | 平台是否支持 | 走哪个接口 | 延迟 | 本租户能不能用 | 建议 |
|---|---|---|---|---|---|
| (a) 实时转写输入 | **支持**（结构化文本，不是音频） | push：`vc.bot.meeting_activity_v1` → `transcript_received_items`；pull：`GET /open-apis/vc/v1/bots/events` | push 按约 5 秒或 100 条聚合一批 [botmux]，同一句还会被修订；稳定后再用要再等约 5 秒。pull 一般每 10–30 秒拉一次 | 需要 `vc:meeting.bot.join:write` 和 `vc:meeting.meetingevent:read`。create-lark-bot 说本租户目录里有这两项（缺的只有 realtime 和 meeting_assistance），但整个能力还在**灰度**，仍可能返回 `20017 ErrNotInGray` | **MVP 的主输入**。按 `sentence_id` 取最新版本（latest-wins），稳定窗口过后再进 agent |
| (b) 视频输入 | **不支持**（没有任何官方接口给摄像头画面或屏幕共享帧） | 只有事件：`vc.meeting.share_started_v1/ended_v1`（只有元数据），妙享事件（给的是文档 URL） | — | 无 | 实时视频不做。会后可以用妙记或录制拿到视频文件，按固定间隔抽帧，作为 image block 给模型；会中只能让人把截图发到 IM 私聊或群里 |
| (c) 会议相关文档输入 | **支持**（拿到链接后自己去读文档） | 会中：`magic_share_started_items.share_doc{url,title}`，SDK 1.74 还新增了 `document_context_changed_items`（当前章节、评论焦点、元素预览）。会后：`vc +detail` 取 `note_id` / `minute_token`，再读纪要、逐字稿、妙记 transcript | 会中和 (a) 一样走事件；文档内容按需用 docs API 读 | 读文档要 docx/wiki 的读权限，读妙记要 `minutes:minutes.transcript:export`，读录制要 `vc:record:readonly` | 收到妙享事件后读文档，作为 attachment 或 context 给 agent；会议结束后拉逐字稿做最终总结 |
| (d) 会中聊天收发 | **支持** | 收：`chat_received_items`（图片只给占位文本）。发：`POST /open-apis/vc/v1/bots/message`（`msg_type: text\|reaction`, `content`, `uuid` 幂等） | 收和 (a) 一样；发是一次 REST 调用 | 要 `vc:meeting.message:write`，本租户目录里有（同样受灰度限制）；bot 必须在会中 | **MVP 的主输出**。只发 final，而且要短；@bot 或聊天里点名 bot 才触发 |
| (e) 在会议里说话（Codex realtime 生成） | **平台支持，但本租户不可用** | `GET /open-apis/vc/v1/realtime/endpoint?meeting_id=` 拿到 `websocket_url`，然后是三层 protobuf 协议：PCM s16le 24kHz，100ms 一帧；**下行也有会场音频** | 帧级，约 100ms | **需要 `vc:meeting.bot.realtime:write`，本租户的权限目录里没有，所以做不了**；会议侧还要打开「允许 AI 智能体发言」 | 放到 v2。Codex 这边：websocket 传输**必须用 API key**；用 ChatGPT 登录只能走 WebRTC v3，音频要走 RTP 媒体轨（实测）。没有 realtime:write 时退回用会中文本回复 |

还有一点：**原始音频输入**（会场声音）也只能从 realtime WS 的下行 `audio.downstream.delta` 拿 [botmux]，同样被 `realtime:write` 挡住。所以本租户只能拿到平台 ASR 出来的字幕，拿不到声音。

---

## 1. 飞书会议智能体能力面（接口清单）

### 1.1 生命周期

```
用户在会中邀请 bot ── vc.bot.meeting_invited_v1 { meeting{id,meeting_no,topic,host_user}, bot, inviter, invite_time, call_id }
  → POST /open-apis/vc/v1/bots/join { join_type: 1, join_identify: { meeting_no }, password?, call_id? }
       ← { meeting{id,meeting_no,topic,start_time}, join_user{id,user_type} }      # 后续一律用长 meeting.id
  → （会中）vc.bot.meeting_activity_v1 / GET /vc/v1/bots/events / POST /vc/v1/bots/message
  → vc.bot.meeting_ended_v1                     # 会议自然结束后不需要再调 leave [botmux]
  （主动离会）POST /open-apis/vc/v1/bots/leave { meeting_id }
```

- SDK 里的方法是 `client.vc.v1.bot.{join, leave, message, events, eventsWithIterator, userActiveMeeting, realtimeEndpoint}`。`join` 的 doc 注释原文是「**目前智能体入离会能力灰度中**」[SDK]。
- SDK 事件表里还有 `vc.bot.meeting_started_v1` [SDK]，botmux 没有用到。
- 用户本人入会的事件 `vc.meeting.participant_meeting_joined_v1`（用户态）可以作为「要不要拉 bot 来旁听」的候选信号，botmux 收到后会私聊用户发确认卡 [botmux]。
- 发现会议：`GET /vc/v1/bots/user_active_meeting?user_id=`，返回「目标用户在会中、并且 bot 也在会中」的会议 [SDK][lark-cli]。
- 入会失败最常见的是 `121003 no permission`。这个错误通常**不是**缺 scope，而是会议侧条件不满足：没开「允许智能体加入」、会议号或密码错、有等候室、会议未开始 [lark-cli]。
- bot 入会后其他参会人能看到它，它在参会人列表里的 `user_type=10` [botmux]。

### 1.2 会中事件（push 和 pull 的结构一样）

`meeting_activity_items[].activity_event_type` 和各类型的字段：

| 类型 | 字段 |
|---|---|
| `participant_joined` / `participant_left` | `participant{id,user_type,user_role,user_name}`、`join_time` / `leave_time`、`leave_reason` |
| `transcript_received` | `speaker{...}`、`text`、`language`、`start_time_ms`、`end_time_ms`、`sentence_id` |
| `chat_received` | `operator`、`message_id`、`message_type`（3 表示 reaction）、`content`、`send_time` |
| `magic_share_started` / `ended` | `share_id`、`share_doc{url,title}`、`time` |
| `document_context_changed`（SDK 1.74 新增，botmux 还没用） | `share_doc`、`comment_focus{comment_id,focused}`、`section_location{title,level,parent_titles}`、`element_preview{action,element_type,element_token,block_id}` |

实测结论 [botmux §2.3/§7.2]：
- 转写批次之间会有重叠，同一个 `sentence_id` 后到的版本会改写前面的文本。所以转写**不能**用「见过就丢」的方式去重，要按 `sentence_id` 取最新版本（upsert latest-wins）。push 的字幕**没有** `is_final` 或 `revision` 字段，只能用墙钟时间判断稳定（默认 `stabilizeMs=5000`）。chat、participant、magic share 可以见过就丢。
- 会中聊天里的图片等媒体**只有占位文本**，拿不到二进制。
- 用户身份能读事件，不等于应用身份能读。应用身份读要另外申请、发布、安装，还要配数据范围。
- 字段名有个坑：botmux 引用的接入指南说历史上有个拼错的字段 `meeting_actitivty_items`，事件 schema「必须照写」。但 SDK 1.74 的类型写的是正确拼法 `meeting_activity_items`。botmux normalizer 两种都读（`normalizer.ts:292-300`），我们也应该两种都读。
- pull 接口 `GET /vc/v1/bots/events` 的参数是 `meeting_id, page_token, start_time, end_time, page_size(20–100)`。会议结束后有 **5 分钟宽限**：只要 bot 曾经在会中，就还能拉；超过 5 分钟就拉不到了。bot 从没入会过会返回 `10005` [lark-cli]。

### 1.3 会中消息
`POST /open-apis/vc/v1/bots/message { meeting_id, msg_type: "text"|"reaction", content, uuid? }` → `{ uuid }`。reaction 可以用 IM reaction 全集，外加 `VC_CanNotSee/VC_NoSound/VC_LooksGood/VC_SoundsClear` [SDK][lark-cli]。前提：bot 在会中、会议开了智能体开关、有 `vc:meeting.message:write` [lark-cli]。对应的 CLI 是 `lark-cli vc +meeting-message-send`，需要 lark-cli ≥ 1.0.66 [botmux `polling-source.ts:6`]。

### 1.4 实时音频（路径 1）[botmux `src/vc-agent/realtime/*` + 设计文档 §2]
- `GET /open-apis/vc/v1/realtime/endpoint?meeting_id=<id>` 返回 `{ websocket_url, expires_time }`，SDK 里是 `vc.v1.bot.realtimeEndpoint`。botmux 直接连这个 URL，没有额外加鉴权头，所以 URL 里应该自带凭证 [推测]。
- 协议分三层：
  - L1：WebSocket 二进制帧，一条消息就是一个 Frontier 帧。
  - L2：Frontier Frame（proto2）：`seqId(1) logId(2) service(3)=33555721 method(4)=1 payloadEncoding(6)="binary" payloadType(7)="application/x-protobuf" payload(8) logIdNew(9) msgId(11) frameType(12)`。frameType 为 1/2/16/32 的是控制帧，跳过。
  - L3：ClientEvent / ServerEvent（proto3），公共字段是 `type(1) event_id(2) session_id(3) created_at(4)`：
    - 上行：`session.create`（payload 在字段 10，上行和下行各声明一次 `audio/pcm`、`s16le`、`24000`）、`audio.upstream.append`（字段 11，PCM 字节）、`audio.upstream.clear`（12，用来打断）、`session.close`（13，reason=1 user_left）。
    - 下行：`session.created`（10）、`audio.downstream.delta`（20：`track_id, source, pts_ms, duration_ms, delta`）、`session.closed`（30）、`error`（90：`code, message, retryable`）。
- 发音频的节奏：每 100ms 发一帧 4800B（24kHz 单声道 s16le），要按墙钟时间匀速发，不能一次灌进去；还要配合 `bufferedAmount` 做背压（上限 512KB）。
- **只有音频**：`session.create` 的 media 只有两个 audio 字段，下行也只有 `audio.downstream.delta`。从协议形状看拿不到视频 [推测，依据是 botmux 手写的 codec 只覆盖这些字段]。
- botmux 现状：上行用一次性 TTS（sami/openai/minimax）合成 PCM 再按节奏发；下行能解码但**不消费**（不听会场）。对话式的 v1 还没做，回声和打断在设计文档里都列为开放问题。M0「真会能听到 bot」在设计文档里写的是「待真会验证」；后来 #916 把实时语音改成了默认开启 [推测：在字节租户上已经能用]。
- 会议侧开关：要开 AI Summary、「允许智能体加入」、「允许 AI 智能体发言」[botmux §7]。

### 1.5 会后产物（文档、纪要、妙记、录制）
- `lark-cli vc +detail --meeting-ids`（用户身份）返回 `note_id`、`minute_token` [lark-cli]。纪要分 normal 和 unified，用 `note +detail` 拿 `note_doc_token`（AI 纪要）和 `verbatim_doc_token`（逐字稿）。SDK 里有 `GET /vc/v1/notes/:note_id` 和 `/notes/:note_id/unified_note_transcript`。
- 妙记：
  - `GET /minutes/v1/minutes/:token/transcript?need_speaker=&file_format=txt|srt`，权限 `minutes:minutes.transcript:export`，限频 5 次/秒 [open-docs]。
  - `GET /minutes/v1/minutes/:token/media`：返回音视频下载链接，**有效期 1 天**，权限 `minutes:minutes.media:export` [open-docs]。
  - 另外还有 `/artifacts`、`/statistics` [SDK]。
- 录制：要等会议结束并收到 `vc.meeting.recording_ready_v1` 后，才能调 `GET /vc/v1/meetings/:id/recording`，返回妙记 URL 和时长，权限 `vc:record:readonly` [open-docs]。录制事件文档写的是「适用于通过 Open API 预约的会议」[open-docs]。
- 完成通知事件：`vc.note.generated_v1`、`minutes.minute.generated_v1`、`vc.recording.recording_transcript_generated_v1` [SDK][botmux §2.2]。
- `GET /vc/v1/meetings/:id/pull_subtitle?uid=&did=` 的描述是「获取会议或录音字幕」，要求传订阅用户和设备 [SDK]。用途和权限不明，**[推测]** 是给会议室或硬件设备用的，不当主路径。
- 公开的 llms 文档索引里**没有** `vc/v1/bots/*` 和 `realtime/endpoint` 这些页面，按 `server-docs/vc-v1/bot/join.md` 这类地址猜也是 404 [open-docs]。说明这套接口还没公开发布，和灰度的情况一致。

---

## 2. 本租户 scope 目录里没有 `vc:meeting.bot.realtime:write` 和 `audio_video_ai:meeting_assistance` 意味着什么

- 「目录」是什么：create-lark-bot 调开发者后台接口 `POST /developers/v1/scope/all/{appId}` 拿到「这个应用在这个租户里**能申请**的 scope 全集」，再把名字映射成 ID 去申请（`open-platform.js:121`、`console-ops.js:63`）[create-lark-bot]。所以一个 scope 不在目录里，意思是这个租户在开发者后台**根本看不到这个权限**。这和「申请了没批」是两回事。
- 最可能的原因是**灰度白名单**，证据如下：
  - SDK 的 `join` 注释写着「目前智能体入离会能力灰度中」。
  - lark-cli 的 `lark-vc-agent` skill 写着「当前功能正在内测中，仅少数用户可用」。它让用户遇到 `missing required scope(s)` 或 `20017 / ErrNotInGray` 时**加入早鸟群**（`https://go.larkoffice.com/join-chat/2f4nb0e1-fe00-4f67-bed7-25beaf533fbd`），还说「忽略普通权限申请流程」。
  - 公开文档没有收录这些接口。
  - botmux 是在字节内部租户上做的，那边这个 scope 是可见的。
- 付费版本或地区：**没找到证据**。**[推测]** 和版本有关的可能性比灰度低。另外 botmux 注明它的「开放平台自动化只支持 feishu.cn」，`brand: lark` 的国际版 bot 会跳过自动化。国际版有没有这套能力不清楚。
- `audio_video_ai:meeting_assistance`：botmux 只是把它列进了 scope 清单（`src/setup/lark-scopes.json:7`），代码里**没有任何调用依赖它**。**[推测]** 它对应 SDK 里那批 `vc/v1/my_ai_vc_meeting/*`、`my_ai_vc/*` 接口（AI 纪要、分段总结、待办这类会议 AI 助理能力）。这些接口不在本方案的必需路径上，缺了它不影响 (a)–(d)。
- 没有这两个 scope 时**仍然能用的**：入会和离会、会中事件（转写、聊天、参会人、妙享、文档上下文）、会中文本和表情、会后纪要、妙记、录制。前提是 `vc:meeting.bot.join:write`、`vc:meeting.meetingevent:read`、`vc:meeting.message:write` 确实在目录里并且已经授予，还要过灰度。注意这三项自己也属于灰度能力，就算 scope 授予了，接口仍可能返回 `20017`，要用真会验证。
- 没有它们时**做不了的**：会场原始音频输入、bot 在会议里说话。也就是 (e) 整条路，以及任何基于音频的东西（自己做 ASR、声纹、语气判断）。

---

## 3. 各能力的推荐设计

### (a) 实时转写
- 输入源优先用 push（agents-io 的 `channel/lark-bot` 已经用 node-sdk `WSClient`，可以直接注册 `vc.bot.*` 三个事件）。pull（`bots/events` 加 `page_token`）只用来补漏：断线重连、push 丢事件时用。
- 和 botmux 一样分两条 lane：
  - fast lane：未稳定的字幕、聊天里 @bot、点名，用来低延迟判断「可能需要回应」。
  - stable lane：按 `sentence_id` 取最新、稳定窗口过后的句子，用来做摘要和上下文。
- 进 runtime 的方式：转写按时间窗聚合成**不可信的会议数据块**，作为 queue 或 inject 进去，不逐句起 turn（Claude 没有「注入但不起 turn」的能力，所以聚合是必须的）。说话人映射用 participant 快照，把 `speaker.id` 对到 open_id（**[推测]** speaker.id 和 participant.id 是同一个命名空间，需要实测）。
- 延迟预算：平台聚合约 5 秒，加稳定窗口约 5 秒，加 agent 推理。所以「听到问题到回答」至少 10 秒以上。只靠文本做不到实时对话。

### (b) 视频
- 官方能力**一个都没有**：机器人拿不到摄像头流，拿不到屏幕共享帧。realtime WS 只有音频，共享屏幕事件只有元数据。
- 替代方案，按可行性排序：
  1. 妙享（Magic Share）共享的是云文档：用 `share_doc.url` 去读文档内容，用 `document_context_changed` 知道大家正在看哪一节、哪个评论。这比看画面更准。
  2. 会后：妙记或录制里拿到视频（`minutes/:token/media`，链接 1 天有效），用 ffmpeg 抽帧（例如每 10–30 秒一帧，或者按场景切换抽），作为 image block 交给 Claude 或 Codex（Codex 的 `UserInput` 原生支持 `image` / `localImage`）。
  3. 会中让人把截图发到 bot 的 IM 私聊或监听群（会中聊天里的图片 bot 拿不到）。lark-bot 通道已经能下载图片（`im:resource`）。
  4. 在参会人自己的机器上跑一个屏幕采集的伴侣进程，从平台外把帧推给 agent。这完全不经过飞书，隐私和授权要单独设计，不推荐作为第一版。

### (c) 会议文档
- 会中：收到 `magic_share_started` 时拉文档内容。注意 lark-cli skill 明确要求「不能只看标题」，要读最近一次共享的文档。拉到后作为 attachment 或 context 给 agent。`document_context_changed` 用来更新「当前焦点」。
- 会前（**[推测]**，未调研完）：入会时用日程 `calendar +meeting --event-ids` 拿用户绑定的会议纪要文档 `meeting_note`，作为背景材料。
- 会后：等 `vc.note.generated_v1` 或 `minutes.minute.generated_v1` 到达后，拉逐字稿或妙记 transcript 做最终总结。lark-vc skill 要求总结要从原始逐字稿出发，不能直接搬运 AI 纪要。

### (d) 会中聊天
- 收：`chat_received` 里的 @bot 或点名是高置信的触发。reaction（type 3）只当信号，不起 turn。
- 发：`bots/message`。turn 的 final 压成 1–3 句再发，长内容放到监听群卡片里，在会中消息里贴摘要或链接。用 `uuid` 做幂等，按 turnId 派生。
- 和 agents-io 现有的输出档位对应：会中消息算 `final` 档；监听群用 lark-bot 现有的 `card` 档。

### (e) 语音回复（Codex realtime）——v2，前提是先拿到 realtime:write
桥接示意：
```
飞书 realtime WS ──下行 audio.downstream.delta (PCM16 24k, 可能分 track)──▶ [桥] ──▶ Codex thread/realtime/appendAudio (base64 chunk)
飞书 realtime WS ◀──上行 audio.upstream.append (100ms/4800B, 墙钟节奏)── [桥] ◀── thread/realtime/outputAudio/delta
                    audio.upstream.clear ◀── barge-in（会场有人开口 / Codex 的打断事件）
Codex realtime 前台 ──handoff/delegation──▶ 同一个 Codex thread（工具、代码、文档都在这里做）
```
- 有 API key 时：走 websocket 传输，格式最简单，两边都是 base64 PCM，24k 采样率正好对上 **[推测：Codex 侧默认 24k PCM16]**。
- 只有 ChatGPT 登录时：只能走 WebRTC v3。桥里要实现一个 WebRTC peer（例如 `werift` 或 `@roamhq/wrtc`，**[推测]** 选型待验证），做 opus 48k 和 PCM 24k 之间的转码重采样。控制面（transcript、handoff）仍然走 app-server 的通知。
- 要解决的问题：
  - 下行是多 track 的话要先混音 **[推测]**。
  - 回声：bot 自己说的话会不会出现在下行里，未知，要过滤。
  - 打断：要发 `audio.upstream.clear`。
  - 什么时候开口：建议只在被点名或 @bot 时说话，不要自由插话。
  - 降级：说话失败就退回会中文本回复。
- 不用 Codex realtime 的简化版：agent 的 final 文本经过任意 TTS 转成 PCM 24k，再按节奏发出去。这就是 botmux 现在的做法，它只需要 realtime:write，不依赖 OpenAI realtime。

---

## 4. Codex realtime 细节（0.160.1）

### 4.1 接口 [codex-ts]
全部标注 `EXPERIMENTAL`，`initialize` 时要带 `capabilities.experimentalApi: true`。`codex features list` 里 `realtime_conversation` 显示 `stable true`（这是 feature 开关，不是 API 稳定性）。

- client → server：
  - `thread/realtime/start`：参数是 `{ threadId, outputModality: "text"|"audio", transport?: {type:"websocket"} | {type:"webrtc", sdp} | {type:"existingCall", callId}, version?: "v1"|"v2"|"v3", voice?, model?, prompt?, realtimeStartInstructions?, realtimeEndInstructions?, includeStartupContext?, initialItems?(仅 v3, ≤128 条/8192 token), clientManagedHandoffs?, codexResponsesAsItems?, codexResponseHandoffMode?: "thinking"|"commentary"|"bemTags", delegationAckFiller?, backendReasoningStatus?, flushTranscriptTailOnSessionEnd?, realtimeSessionId? }`
  - `thread/realtime/appendAudio { threadId, audio: { data: base64, sampleRate, numChannels, samplesPerChannel|null, itemId|null } }`
  - `thread/realtime/appendText { threadId, text, role: user|developer|assistant }`
  - `thread/realtime/appendSpeech { threadId, text }`：让它把一段文本说出来。如果 realtime 会话已经建好，可以拿来当 TTS 用。
  - `thread/realtime/stop`、`thread/realtime/listVoices`
- server → client：
  - `thread/realtime/started { realtimeSessionId, version }`、`sdp { sdp }`（WebRTC 的 answer）
  - `outputAudio/delta { audio: ThreadRealtimeAudioChunk }`
  - `transcript/delta { role, delta }` 和 `transcript/done { role, text }`
  - `item/started`、`item/completed`，item 的类型有 `realtimeSessionStarted | transcriptSegment{role,text} | bemItemPromoted{turnId,itemId,presentation} | realtimeSessionClosed{outcome}`
  - `item/transcript/delta`、`itemAdded`（原始 JSON）、`error { message }`、`closed { reason }`
- 怎么和 thread 配合：realtime 是一个**挂在 thread 上的语音前台**，背后由 Codex 模型做「delegation」，Codex 的回复再通过 handoff 交回给语音说出来（相关字段是 `codexResponseHandoffMode`、`clientManagedHandoffs`）。工具调用在 Codex thread 里执行，正常走审批和 item 流程。**[推测]** 依据是 v3 数据通道支持的事件里有 `delegation.context.append` 和 `delegation.function_call_output.create`。
- voices（`listVoices` 实测）：v1 有 `juniper maple spruce ember vale breeze arbor sol cove`，默认 `cove`；v2 有 `alloy ash ballad coral echo sage shimmer verse marin cedar`，默认 `marin`。
- 模型名和配置项 [codex-bin]：二进制里能看到 `gpt-realtime-1.5`、`gpt-live-1-codex`，配置项有 `[realtime] version/transport/voice`、`[audio] microphone/speaker`、`experimental_realtime_ws_model`、`experimental_realtime_ws_base_url`、`experimental_realtime_webrtc_call_base_url`、`experimental_realtime_ws_backend_prompt`、`experimental_realtime_ws_startup_context`、`experimental_realtime_start_instructions`。还有协议字符串 `audio/pcm`、`server_vad`、`input_audio_buffer.append`、`conversation.handoff.append`、`/backend-api … realtime/calls`。

### 4.2 实测结果 [probe]
环境：本机 `codex login status` 显示 `Logged in using ChatGPT`（pro），没有 `OPENAI_API_KEY`。每次跑都起一个新的 `codex app-server`（stdio），流程是 `thread/start(ephemeral)`，然后 `thread/realtime/start`，跑完 `stop` 并 kill。没有留下进程（用户原有的 managed daemon 没动）。

| transport / version | 结果 |
|---|---|
| websocket，默认 / v1 / v3 | `start` 先返回 `{}`，随后来一条 `thread/realtime/error: "realtime conversation requires API key auth"`。**ChatGPT 登录不能用 websocket 传输** |
| webrtc，默认 / v1 | 已经到了服务端，被拒：`AVAS requires OpenAI-Alpha: quicksilver=v2`（`invalid_quicksilver_alpha_header`） |
| webrtc v2 | `AVAS realtime calls require realtime v1 or v3` |
| **webrtc v3** | **成功**：收到 `thread/realtime/started {version:"v3"}` 和 `thread/realtime/sdp`（服务端 answer，ice-lite）。我发的是伪造的 SDP，没有真正的 ICE 和媒体，所以收不到音频。在这种模式下调 `appendAudio` 会被拒：`Invalid value: 'input_audio.append'`，服务端列出的可用事件是 `session.update, output_audio.playback.play, session.feedback, input_audio.pause/resume, session.context.append, response.item.create, response.create, delegation.context.append, delegation.function_call_output.create, output_audio.send_dtmf_event, session.close`，之后会话被关闭。`appendText` 和 `appendSpeech` 返回 `{}`，但因为媒体没通，没有观察到任何 transcript 或音频事件 |

还观察到：
- `appendAudio` 的 RPC 返回 `{}` 不代表成功，错误是异步发来的 `error` 通知（`conversation is not running`）。
- 「发 1 秒静音、看 outputAudio」这一步**没有测成**：ws 需要 API key，webrtc 需要真正的 peer。所以「Codex 输出音频的确切采样率」没有实测到，下一步要用 API key 走 ws 再测一次。

结论：
- 想用最简单的 base64 PCM 方式桥接，**需要 OpenAI API key**（Platform 计费）。
- 只有 ChatGPT 订阅的话，要在桥里做真正的 WebRTC：音频走 RTP，控制面走 app-server。工作量明显更大。
- 整套 realtime API 都是 experimental，字段在频繁变（v1/v2/v3、BEM 相关字段），要锁定 codex 版本，每次升级都重新生成类型做比对。

### 4.3 agents-io 现状
`harness/codex/src` 里没有任何 realtime 代码（grep 结果为 0）。`docs/research/codex.md` 只在方法列表里提到 `thread/realtime/*`（exp）。要接入的话，需要在 harness/codex 加一个可选的 realtime 子模块，并且要求 `experimentalApi: true`。

---

## 5. 最小可行第一版（本租户现在就能做，不需要 realtime:write）

1. **channel `lark-meeting`**（或者作为 `channel/lark-bot` 的一个子模式，复用它的 `WSClient` 和凭证）：
   - 订阅 `vc.bot.meeting_invited_v1`、`vc.bot.meeting_activity_v1`、`vc.bot.meeting_ended_v1`。
   - 被邀请就调 `bots/join`（带上 `call_id`），这本身就是显式授权，不用再确认。会话 key 用 `meeting:<meeting.id>`，和 owner 的主会话隔离，参会人默认 `guest` 权限（和 RECOMMENDATION §4.3 一致）。
2. 输入：
   - 转写：按 `sentence_id` 取最新、稳定窗口过后，按约 30 秒的窗口聚合成上下文，标记为不可信数据。
   - 聊天：@bot 或点名 bot 时起 turn，其他只观察。
   - 妙享：读共享文档内容，作为附件给 agent。
   - 断线后用 `bots/events` 加 `page_token` 补拉。
3. 输出：final 压短后用 `bots/message` 发出去；详细内容发到可选的监听群卡片。
4. 会议结束：收到 `meeting_ended` 后清理状态；等纪要或妙记生成事件到了，拉逐字稿做一次最终总结，发给 owner。
5. 声明的 scope：
   - runtime：`vc:meeting.bot.join:write`、`vc:meeting.meetingevent:read`、`vc:meeting.message:write`
   - optional：`minutes:minutes.transcript:export`、`vc:record:readonly`、docx/wiki 读权限
   - 后续阶段：`vc:meeting.bot.realtime:write`
   这些要写进 `requirements.ts` 的风格里，并说明缺了哪个会坏什么。

**v2**（拿到 realtime:write 之后）：先做 TTS 单向播报（botmux 的 M0/M1 路线，最便宜），再做 Codex realtime 双工对话（需要 API key 走 ws，或者自己实现 WebRTC 桥）。

---

## 6. 需要用户去做的事

1. **开发者后台**（应用权限页）：
   - 确认这三个 scope 在目录里、已经申请、已发布版本、已安装到租户：`vc:meeting.bot.join:write`、`vc:meeting.meetingevent:read`、`vc:meeting.message:write`。
   - 配「权限可访问的数据范围」：选「按条件筛选」，条件是「**会议的归属者 包含 与应用的可用范围一致**」[lark-cli]。
2. **事件订阅**（长连接模式）：加上 `vc.bot.meeting_invited_v1`、`vc.bot.meeting_activity_v1`、`vc.bot.meeting_ended_v1`，可选加 `vc.meeting.participant_meeting_joined_v1`、`vc.note.generated_v1`、`minutes.minute.generated_v1`。
3. **会议侧设置**（每场会或租户默认）：开 AI Summary、打开「允许智能体加入」。要说话的话还要打开「允许 AI 智能体发言」。
4. **灰度申请**：加入 lark-cli 文档给的早鸟群，申请 VC Agent 内测权限。一并申请把 `vc:meeting.bot.realtime:write` 加进本租户的 scope 目录（视情况也申请 `audio_video_ai:meeting_assistance`）。这一步决定 (e) 能不能做。
5. **真会验证**（要开工前先做的检查）：在一场真实有人说话、有人发消息的会里，用应用身份入会，确认能收到 `transcript_received` 和 `chat_received` 的条目。如果只拿到元数据、空结果、`app_scope_not_applied` 或 `20017`，就先停下来解决权限问题 [botmux P0-0]。
6. **Codex realtime**：如果要走 ws 方案，需要提供 OpenAI API key，并接受 Platform 计费；否则就要接受 WebRTC 桥的额外工作量。

---

## 7. 未决问题

- `transcript.speaker.id` 能不能稳定映射到 open_id，跨 app 时 open_id 还会变，要处理。
- realtime 下行是不是每个说话人一个 track（字段 `track_id` 和 `source` 是什么意思），bot 自己的声音会不会回到下行。
- `websocket_url` 的 `expires_time` 有多长，过期后要不要重新拿地址、重连。
- 国际版（`open.larksuite.com`）有没有这套 bot 能力。
- `pull_subtitle` 的真实用途和权限。
- 用 API key 走 ws 时，Codex 输出音频的确切采样率和声道（本次没测到）。
- `document_context_changed` 在真实会议里多久触发一次、数据量有多大。
