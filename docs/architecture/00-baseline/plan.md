# 00 · 基线与生产开关 — 执行计划

对应 [spec.md](./spec.md)。本文件只记步骤和状态，不复述设计。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。粗估共约 5–6 人日，每步的估计写在步骤后面。

- [ ] 1. 公开边界与门禁（spec「门禁」「CI 与部署」前两节；约 1.5 人日）。这个 PR 是 00 的第一次推送，公开边界检查必须随它一起进仓库和 CI。开放问题 2 已定：demo 地址只留在 README「在线体验」一节，词表不收它。开工前，owner 已把内容黑名单词表放进本机 `.sensitive-patterns` 和仓库 secret `SENSITIVE_PATTERNS`。按下面的顺序提交，每个提交都要过 pre-commit，不绕过 hook：
  1. 依赖与配置：装 `oxfmt@0.68`、`oxlint@1.83`、`lefthook@2.1`、`@commitlint/cli`、`@commitlint/config-conventional`，都钉精确版本，提交 lockfile；加 `prepare` 脚本并跑 `lefthook install`，实测它在 `docker build` 和 `git archive` 出来的目录里不会让 `pnpm install` 失败；oxfmt、oxlint 的配置文件（`printWidth` 在 100 / 120 / 140 里实测，取首次 diff 最小的，行数记进实施记录；排除 `data/sop.md`、`pnpm-lock.yaml`）；公开边界检查脚本（路径黑名单按 spec 全列，包括 ADR-003 决策 4 的三类：`src/packs/` 下 `travel`、`ecommerce-aftersales` 以外的子目录，根目录的 `tenants/`，`eval/real/`），`lint` 暂时只跑它；`.gitignore` 加 `.sensitive-patterns`；`ci.yml` 注入 `SENSITIVE_PATTERNS`，加钉版本的 gitleaks 一步。`format:check` 仍是占位。对全历史跑一次 gitleaks，结果和 `.gitleaksignore` 每条的理由记进实施记录。
  2. 前缀测试的断言 1、2、4（spec「前缀稳定测试」）：`engine.ts` 导出 `promptPrefix()`，`engine.selftest.ts` 的假模型服务记下原始 body。把这时的 `PREFIX sha256` 记进实施记录，它就是「00 开始前」的值。
  3. `fix(lint): …`：lint 首次命中按 spec 的取舍处理；同一个提交把 `lint` 切成 `oxlint --deny-warnings` 加公开边界检查。
  4. `style: format repo with oxfmt`：只含格式化输出，`format:check` 仍是占位。`public/*.html` 能否纳入，看这一步之后 `pnpm test` 是否全绿。
  5. 把 `format:check` 切成真实命令；把第 4 个提交的 sha 写进 `.git-blame-ignore-revs`；在 `CONTRIBUTING.md` 里写上 `git config blame.ignoreRevsFile .git-blame-ignore-revs`，并保留其中「暂不接受外部 PR，接受时使用 DCO」一段（ADR-003 决策 1 与后续动作，接入 SDD 时已写入）。
  - 第 3、4 个提交之后各跑一次 `pnpm test`，结果不变，`PREFIX sha256` 与第 2 个提交记下的值相同。
  - 合进 `dev` 只能用「Create a merge commit」。合并后在 `dev` 上确认 `.git-blame-ignore-revs` 里的 sha 是 `dev` 的祖先，并跑一次 blame 核对。
  - 手动：在仓库设置里打开 secret scanning 和 push protection，在私有测试仓库里验证一次推送被拒。
  - 对应验收 1a–1d、2、11、10b 的第一个值。
- [ ] 2. 基线补测（spec「不变量」里标「本阶段补」的各条；约 1 人日）。只加断言和仅供测试的导出，不改任何行为；每条新断言先在当前代码上跑绿：
  - `server.selftest.ts`：三个管理写接口的 401（缺凭据、凭据错）、503（没配 `ADMIN_PASS`）、403（带 `sec-fetch-site: cross-site` 头）；三个 LLM 计费读端点的 401、503；`POST /api/chat` 带 `wecom:` 前缀的 id 返回 400；把订单状态直接设成 cancelled 后付款返回 409；对已付款的订单再调一次付款接口，不再推送；`pruneStaleVisitorData` 只清闲置的 `sim-` / simulator 会话，真实企微会话、种子会话、有已付订单的访客会话都在；用 `getOrCreateSession` 造出超过上限的访客会话，淘汰的是最旧的、有已付订单的不动；`freshenDemoData` 只平移种子会话和它们的订单，`DEMO_FRESHEN=0` 时不动。
  - `engine.selftest.ts`：`createQuote` 的算价向量；假模型输出 `**加粗**`、`# 标题`、`- 列表` 时客户收到的正文；已支付的会话调了 `search_routes` 后阶段为 recommend；同一会话并发两条消息，第二条的模型请求里看得到第一条的回复。
  - `adapters/wecom.selftest.ts`：`wechatify` 的向量（含 `# 标题` 和 `#标题`），为此在 `__test` 里加导出。
  - `llm.selftest.ts`：沉默跟进的边界：已转人工、已支付、种子会话、网页访客都不跟，同一阶段只跟一次。
  - 对应验收 3a、14 的一部分。
- [ ] 3. `src/profile.ts` 与 `src/profile-boot.ts`（spec「接口与数据流 · 部署 profile」「部署 profile 与开关」的环境变量、启动、测试隔离；约 0.5 人日）：
  - `resolveProfile`、`capFlags`、`profile()`、`__profileTest`；空串当未设置；`DEMO_FRESHEN` 的读取从 `store.ts` 挪进来，`freshenDemoData` 改读 `seed_freshen`，demo 下行为不变。
  - `server.ts` 在 `import './env.js'` 之后紧接着 `import './profile-boot.js'`：打出一行 profile 和开关，配置错误时打一行原因并退出。
  - 六组自测和 `eval/run.ts` 在 import 业务模块之前设好 `DEPLOY_PROFILE=demo`，并把 `FLAG_*`、`DEMO_FRESHEN` 设成空串。
  - `.env.example` 补 `DEPLOY_PROFILE` 与各个 `FLAG_*`。
  - 解析和封顶的向量写进 `server.selftest.ts`；前缀断言 3（demo 与 prod 相同）写进 `engine.selftest.ts`。切换 profile 的用例结束时调 `__profileTest.reset()`。
  - 对应验收 1e、5。
- [ ] 4. 其余四个布尔开关接到调用点（spec「部署 profile 与开关」的表；约 0.5–1 人日）：
  - `reset_command`：`engine.ts`，关掉时走固定回复，不改任何状态。
  - `anon_readonly_admin`：`server.ts` 的列表路由、`sessionReadAuth`、`/api/usage`。
  - `visitor_simulator`：`server.ts` 的路由和静态页；`sim-` 直读只看这个开关；访客清理不动。
  - `mock_pay`：支付路由，不带凭据返回 404；带凭据并经过 `sameOriginOnly` 仍可付。
  - 每个开关在 prod 下的行为各配一条自测，放进 `server.selftest.ts` / `engine.selftest.ts`；demo 下现有断言零修改。
  - 对应验收 3b–3d、4。
- [ ] 5. AI 显式标识（spec「AI 显式标识」；约 0.25 人日）：
  - 改 `WELCOME_TEXT` / `WELCOME_BACK_TEXT` 的文案，顺带删掉「都记得」（「缺陷修复」4）；改 `chat.html` 的开场。system prompt、`mockChat`、eval `guard-05` 都不动。
  - `__test.WELCOME_BACK_TEXT` 保留原名；`alignSessionForReplay` 同时认新文案和改版前的两段旧文案。
  - `adapters/wecom.selftest.ts` 用假企微服务端断言两段欢迎语的第一句和人工入口。
  - 跑一次前缀测试，`PREFIX sha256` 必须与第 1 步记下的值相同。
  - 手动：企微后台把客服账号名改成含「AI 旅行顾问」。
  - 对应验收 6a、6b、6d。
- [ ] 6. 缺陷修复 1、2、3、5、6（spec「缺陷修复」；约 1 人日）：
  - 非文本分支：记带 msgid 的占位，转人工后静默，重放按 msgid 不重复记；测试放 `adapters/wecom.selftest.ts`，用假企微服务端。
  - `HANDOFF_REQUEST` 和 `dejargon.selftest.ts` 的向量表；`engine.selftest.ts` u2b 用例换一句客户原话。
  - 确定性转人工和重发支付链接两条路径补身份承认；「你是机器人吧？我要投诉」「你是真人吗？转人工」两条向量进 `engine.selftest.ts`。
  - `adapterFor` 的空适配器，以及支付路由在推送失败时记备注（种子会话除外）；测试放 `server.selftest.ts`，在会话上写一个未知的 channel。
  - `handleEnterSession` 的两条路径对已转人工的会话都不发欢迎语；测试放 `adapters/wecom.selftest.ts`。
  - 对应验收 6c、7、8、9。
- [ ] 7. `deploy.sh` 改为按 tag 部署（spec「CI 与部署 · deploy.sh」；约 0.5–1 人日）：
  - 先做手动的一步：在服务器 `.env` 里追加 `DEPLOY_PROFILE=demo`，记进实施记录。
  - 流程按 spec 改：归档目录里跑四个门禁、先查服务器 `.env` 再同步、`NAME` 可覆盖；Dockerfile 加 `ARG APP_REVISION`；`/healthz` 返回 `revision`。
  - 打一个 tag，真实部署一次，把 `/healthz` 的 `revision` 记进实施记录。
  - 部署失败的两种演练都在一次性 clone 里造提交（这个 clone 不装 hook，也不推送）：一个带类型错误的提交打 tag，部署被拒（验收 12c）；一个能过门禁、但容器起不来的提交（例如改坏启动命令）打 tag，用来演练回滚。
  - 回滚演练用旁路实例：换 `NAME`、`REMOTE_DIR`、`HOST_PORT`，旁路 `.env` 只配 `DEPLOY_PROFILE=demo` 和 `ADMIN_PASS`，不配企微凭据。依次部署 tag A、tag B 和起不来的那个 tag，确认回滚后 `revision` 等于 B。演练完删掉旁路容器、镜像和目录。
  - 对应验收 12。
- [ ] 8. README（spec「README」；约 0.25 人日）：
  - 描述当前状态的数字改成现值；横评表和缓存表的表头注明「当时的回归集」。
  - 本地跑法改成四个门禁名；部署一节改成按 tag；加 `DEPLOY_PROFILE` 说明，鉴权表加一列 prod。
  - 「生产化路径」一节指向总参考。
  - 「接入真实企业微信」一节的 1v1 托管改成：1v1 只做会话存档 + AI 辅助、由人点发送；全自动接待只走微信客服。
  - 「在线体验」一节的 demo 地址保留，其余位置不出现生产域名（开放问题 2 已定）。
  - 对应验收 13。
- [ ] 9. 对照 spec 当前全部验收标准逐条验证，把每条的结果记在本文件「验收记录」一节
- [ ] 10. 清理临时探针与测试（包括第 7 步的旁路实例、一次性 clone 和它们的 tag）
- [ ] 11. owner 确认验收通过后，spec 顶部改 `Status: implemented`

进度吃紧时只能砍一项：第 8 步里横评表和缓存表的表头注明。

第 1–7 步不能砍：公开边界推上去之后就洗不掉；格式化越晚越贵；补测和前缀哈希是 01 的对照基准；prod 开关、AI 标识和几处缺陷是本阶段存在的理由；按 tag 部署和 `/healthz` 的 `revision` 是 01 列出的前置条件。

## 实施记录

（按步骤追加：日期、提交、记下的数值（`printWidth` 实测、前缀哈希、gitleaks 结果、`revision`）、以及 spec 没写、此处取定的地方）

## 验收记录

（对照验收标准逐条验证时填写，按子编号：编号 · 通过 / 未通过 · 证据）

## 起草记录（2026-09-25）

- spec 由 Claude Code 按 owner 已拍板的决定起草（决策记录另记）。代码事实已对照 `2ffbc15` 的工作区逐条核过；函数一律按名字引用，因为 `engine.ts` 的行号已经漂移。
- 基线数字（起草时）：`eval/cases.json` 51 条用例，其中 32 条只在真实模型下跑、19 条 mock；100 轮、147 条断言；`data/routes.json` 20 条线路，`data/hotels.json` 23 家酒店。
- 同日按多角度审查修订（spec 仍是 draft，就地改）。主要变化：system prompt 身份那一行不改，00 不改变前缀；`ai_disclosure` 只有 `always`；prod 在 02 之前不接真实客户，成交链路的措辞整体留给 02；公开边界检查挪到第一次推送之前；补了渠道与存储、demo profile、承诺与画像几组不变量；缺陷修复从四处增加到六处。

<!-- 「交接」与「Open」两节在第一次停下时再追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：

## Open
- 与 spec 的分歧、需要 owner 裁决的事
-->
