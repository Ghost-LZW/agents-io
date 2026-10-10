# 怎样跑测试

> 决定 14（`docs/design/locus/DECISIONS.md`）：测试按不变量组织。复查与分类依据见 `docs/design/test-suite-review/`。承诺清单是 `docs/INVARIANTS.md`。真实平台与守护进程的手工步骤见 `docs/E2E.md`。

## 四层

层由文件后缀决定（`vitest.config.ts` 的 `projects`）：

| 层 | 文件 | 内容 | 命令 | 何时跑 |
|---|---|---|---|---|
| `core` | `*.test.ts` | 守着 INVARIANTS 里某条承诺的测试；每个测试名都带 `#编号` | `pnpm test:core` | 每次改动 |
| `local` | `*.local.test.ts` | 功能路径上便宜的测试（渲染、配置解析、适配器内部映射），没有承诺 | `pnpm test:local` | 与 core 一起 |
| `e2e` | `*.e2e.test.ts` | 起子进程、靠真实计时或轮询、跨很多层的冒烟；同样带编号 | `pnpm test:e2e` | 合并到 `main` 之前 |
| `live` | `*.live.test.ts` | 真实飞书、IMAP、Claude Code、Codex；没有对应环境变量时跳过 | `pnpm test:live` | 改通道或 harness 适配器、发布前，手动 |

`pnpm test` = core + local。测试直接跑源码（vitest 把 `@agents-io/*` 指向各包的 `src/`；起子进程的 fixture 用 `scripts/source-loader.mjs`），不需要先 `pnpm build`。live 的门：`LARK_APP_ID` + `LARK_APP_SECRET` + `LARK_TEST_CHAT_ID`、`MAIL_LIVE_IMAP_HOST`、`AGENTS_IO_LIVE_CLAUDE=1`、`AGENTS_IO_LIVE_CODEX=1`。

## 标签

- 测试名末尾写它守着的编号，可以多个：`it('close rejects queued inputs … #IN-1 #RS-6', …)`。失败报告里直接看到打破了哪条承诺。
- 按编号选：`npx vitest run --project core -t '#IN-1\b'`（`\b` 让 `#IN-1` 不命中 `#IN-10`）；不带 `--project` 时 core 与 e2e 一起选。
- 已知不成立的路径写成 `it.fails('… #IN-1', …)`，上面一行注释写它对应 INVARIANTS 的哪一条"不成立"。现在它"按预期失败"所以是绿的；有人修好了，它变红：把它改成 `it`，并改 INVARIANTS 的状态。
- 没法测的承诺先写 `it.todo('… #ID')`，让缺口在报告里可见。

## 对照脚本

`scripts/invariants.mjs` 只读文本，不跑测试：

- `pnpm invariants:check`：标签指向不存在的编号；没有任何测试的编号；core 里没有标签的测试；标了"不成立"却没有 `it.fails` 的编号；INVARIANTS 里引用了、但已经不存在的测试名。现在只警告（退出码 0），积压清完后改为报错。
- `pnpm invariants:affected [文件…]`：不给文件时取相对 `main` 的改动。按 INVARIANTS 各条"实现"里写的文件找出受影响的编号，列出每个编号在各层的测试数，打印要跑的 vitest 命令；没有任何编号提到的源文件也列出来（要么它不承担承诺，要么清单漏了一条）。
- `node scripts/invariants.mjs list [编号…]`：每个编号下的测试。

## 给改 agents-io 的人和 agent 的规则

1. 改之前：`pnpm invariants:affected <要改的文件>`，读命中的那几节 INVARIANTS。
2. 改完：总是跑受影响编号的 core 测试（`affected` 打印的命令），再跑 `pnpm test`（core + local，几秒）。
3. **core 红了 = 可能打破了一条承诺。** 先读那条不变量。是有意改变承诺的，先改 INVARIANTS（和相关决定），再改测试；不允许只改断言让它变绿。确实是测试写错了的，要能说清为什么。
4. **local 红了 = 一个细节变了。** 确认是有意改的，就删掉或重写这个测试；它不是信任的来源。
5. `affected` 命中的编号在 e2e 里有测试，或改动碰了传输与生命周期代码（`packages/daemon/src/gateway.ts`、`channel/jsonl-bridge/src`、`harness/*/src`）：跑 `pnpm test:e2e`。合并到 `main` 前无论如何跑一次。
6. 改了通道或 harness 适配器：列出要跑的 live 项（`pnpm test:live` 加对应环境变量、`aio e2e --only …`、`docs/E2E.md` 的手工步骤）交给人，写明没跑。
7. 新承诺：先在 INVARIANTS 写一节、给编号，再写带标签的测试。新功能没有承诺的，测试放 `*.local.test.ts`。
8. 发现一条不成立的路径：先写 `it.fails`，在 INVARIANTS 的"不成立"里记一条，再决定修不修。
