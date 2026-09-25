# 00 · 基线与生产开关 — 执行计划

对应 [spec.md](./spec.md)。本文件只记步骤和状态，不复述设计。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。粗估共约 5–6 人日，每步的估计写在步骤后面。

- [x] 1. 公开边界与门禁（spec「门禁」「CI 与部署」前两节；约 1.5 人日）。这个 PR 是 00 的第一次推送，公开边界检查必须随它一起进仓库和 CI。开放问题 2 已定：demo 地址只留在 README「在线体验」一节，词表不收它。开工前，owner 已把内容黑名单词表放进本机 `.sensitive-patterns` 和仓库 secret `SENSITIVE_PATTERNS`。按下面的顺序提交，每个提交都要过 pre-commit，不绕过 hook：
  1. 依赖与配置：装 `oxfmt@0.68`、`oxlint@1.83`、`lefthook@2.1`、`@commitlint/cli`、`@commitlint/config-conventional`，都钉精确版本，提交 lockfile；加 `prepare` 脚本并跑 `lefthook install`，实测它在 `docker build` 和 `git archive` 出来的目录里不会让 `pnpm install` 失败；oxfmt、oxlint 的配置文件（`printWidth` 在 100 / 120 / 140 里实测，取首次 diff 最小的，行数记进实施记录；排除 `data/sop.md`、`pnpm-lock.yaml`）；公开边界检查脚本（路径黑名单按 spec 全列，包括 ADR-003 决策 4 的三类：`src/packs/` 下 `travel`、`ecommerce-aftersales` 以外的子目录，根目录的 `tenants/`，`eval/real/`），`lint` 暂时只跑它；`.gitignore` 加 `.sensitive-patterns`；`ci.yml` 注入 `SENSITIVE_PATTERNS`，加钉版本的 gitleaks 一步。`format:check` 仍是占位。对全历史跑一次 gitleaks，结果和 `.gitleaksignore` 每条的理由记进实施记录。
  2. 前缀测试的断言 1、2、4（spec「前缀稳定测试」）：`engine.ts` 导出 `promptPrefix()`，`engine.selftest.ts` 的假模型服务记下原始 body。把这时的 `PREFIX sha256` 记进实施记录，它就是「00 开始前」的值。
  3. `fix(lint): …`：lint 首次命中按 spec 的取舍处理；同一个提交把 `lint` 切成 `oxlint --deny-warnings` 加公开边界检查。
  4. `style: format repo with oxfmt`：只含格式化输出，`format:check` 仍是占位。`public/*.html` 能否纳入，看这一步之后 `pnpm test` 是否全绿。
  5. 把 `format:check` 切成真实命令；把第 4 个提交的 sha 写进 `.git-blame-ignore-revs`；在 `CONTRIBUTING.md` 里写上 `git config blame.ignoreRevsFile .git-blame-ignore-revs`，并保留其中「暂不接受外部 PR，接受时使用 DCO」一段（ADR-003 决策 1 与后续动作，接入 SDD 时已写入）。
  - 第 3、4 个提交之后各跑一次 `pnpm test`，结果不变，`PREFIX sha256` 与第 2 个提交记下的值相同。
  - 合进 `dev` 只能用「Create a merge commit」。合并后在 `dev` 上确认 `.git-blame-ignore-revs` 里的 sha 是 `dev` 的祖先，并跑一次 blame 核对。
  - 手动：在仓库设置里打开 secret scanning 和 push protection，在私有测试仓库里验证一次推送被拒。
  - 对应验收 1a–1d、2、11、10b 的第一个值。
- [x] 2. 基线补测（spec「不变量」里标「本阶段补」的各条；约 1 人日）。只加断言和仅供测试的导出，不改任何行为；每条新断言先在当前代码上跑绿：
  - `server.selftest.ts`：三个管理写接口的 401（缺凭据、凭据错）、503（没配 `ADMIN_PASS`）、403（带 `sec-fetch-site: cross-site` 头）；三个 LLM 计费读端点的 401、503；`POST /api/chat` 带 `wecom:` 前缀的 id 返回 400；把订单状态直接设成 cancelled 后付款返回 409；对已付款的订单再调一次付款接口，不再推送；`pruneStaleVisitorData` 只清闲置的 `sim-` / simulator 会话，真实企微会话、种子会话、有已付订单的访客会话都在；用 `getOrCreateSession` 造出超过上限的访客会话，淘汰的是最旧的、有已付订单的不动；`freshenDemoData` 只平移种子会话和它们的订单，`DEMO_FRESHEN=0` 时不动。
  - `engine.selftest.ts`：`createQuote` 的算价向量；假模型输出 `**加粗**`、`# 标题`、`- 列表` 时客户收到的正文；已支付的会话调了 `search_routes` 后阶段为 recommend；同一会话并发两条消息，第二条的模型请求里看得到第一条的回复。
  - `adapters/wecom.selftest.ts`：`wechatify` 的向量（含 `# 标题` 和 `#标题`），为此在 `__test` 里加导出。
  - `llm.selftest.ts`：沉默跟进的边界：已转人工、已支付、种子会话、网页访客都不跟，同一阶段只跟一次。
  - 对应验收 3a、14 的一部分。
- [x] 3. `src/profile.ts` 与 `src/profile-boot.ts`（spec「接口与数据流 · 部署 profile」「部署 profile 与开关」的环境变量、启动、测试隔离；约 0.5 人日）：
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

### 第 1 步（2026-09-25，分支 `chore/gates-public-boundary`）

- 提交，按顺序：`33c680e` 依赖与配置、公开边界检查、CI → `a198b74` 前缀断言 1、2、4 → `9fec91c` lint 修复，`lint` 切成真实命令 → `292dc6d` 首次全仓格式化 → `bca5574` `format:check` 切成真实命令、`.git-blame-ignore-revs`。独立验收后又追加了三个修复提交：`a02040c` 边界检查加固、`b5d0751` gitleaks 区间守卫、`b678bd8` 假模型服务按整块解码。每个提交都过了 pre-commit 和 commit-msg，没有绕过 hook。
- 工具版本（精确）：oxfmt 0.68.0、oxlint 1.83.0、lefthook 2.1.14、@commitlint/cli 与 @commitlint/config-conventional 21.2.3、gitleaks 8.30.1（CI 下载 linux_x64 包并校验 sha256 `551f6fc8…70eb`）。
- `printWidth` 实测。首次格式化 diff 的增删行合计（含 `public/*.html`）：100 → 23,516；120 → 19,081；140 → 16,707，取 140。排除 `public/*.html` 之后，`292dc6d` 是 32 个文件、5,633 行增加、2,628 行删除。
- `public/*.html` 不纳入格式化：格式化后 `wecom.selftest.ts` 的「chat.html 有 stripLink()」失败，见 Open。
- `prepare` 是 `if [ -e .git ]; then lefthook install; fi`。`git archive` 解出的目录和 `docker build` 里，`pnpm install --frozen-lockfile` 都成功，`prepare` 什么也不做。lefthook 的 postinstall 由 `pnpm-workspace.yaml` 的 `ignoredBuiltDependencies` 显式忽略。
- 前缀哈希，00 开始前（`a198b74`）：`PREFIX sha256 system=6c202d633b603a0b391634bcaf75da9d3ed42c30f848ad092a2467f713d9a423 tools=64c16fc8f464d5757f02411b7f8a2a6ce6f43da63416283851a6e997819692d1`。lint 修复后（`9fec91c`）、格式化后（`292dc6d`），以及 `bca5574`、`b678bd8`，打印的值都相同，各组结果也相同：wecom 408、dejargon 316、price-guard 403、server 72，eval mock 19/19。
- lint 首次命中 15 处（只开 correctness）：
  - 真问题 7 处，当场修：死函数 `pendingPayLink`、`server.ts` 里没用的 `model`、`store.ts` 里多余的展开、3 处 `/^…/.test` 换成 `startsWith`、selftest 的 `new Array(n)`。
  - `no-control-regex` 8 处是故意写法：出口护栏用 `\u0001–\u0003` 当链接空位记号，用 `\u0000` 包链接占位。逐行豁免并写明理由；其中两处在长链式调用中间，格式化会把正则挪离豁免注释，所以正则原样提成常量 `HAS_HOLE`、`EMPTY_MD_LINK`。
  - 没有关掉任何整条规则。
- gitleaks 全历史（`--log-opts="--all"`，另加 `-m` 各跑一次）：no leaks found，因此没有 `.gitleaksignore`。
- 词表：plan 原写「开工前 owner 已放好」，实际开工时本机和仓库 secret 都没有。本机的 `.sensitive-patterns` 由 Claude Code 按本机配置和私有笔记起草，收录范围另记。仓库 secret `SENSITIVE_PATTERNS` 在第一次推送前按它设置，只放正则行，不放注释和空行：GitHub 会把多行 secret 的每一行都当遮蔽词，单独一个 `#` 的行会把 CI 日志里所有的 `#` 打成 `***`。
- spec 没写、此处取定的地方：
  - 边界检查读 git 索引里的版本（部分暂存时，以要提交的那一份为准）。不在 git 工作区根目录时（例如 `deploy.sh` 的归档目录），改查目录树里 `node_modules` 以外的文件。
  - 路径黑名单多收一项 `.sensitive-patterns`。文件名比较不分大小写。子模块按目录算，所以 `src/packs/<白名单外>`、`tenants` 做成子模块也会被拦。`var/` 只拦仓库根目录，和运行时目录一致。
  - 词表格式：每行一个 JavaScript 正则，区分大小写，带 u 标志；空行和 `#` 开头的行忽略。正则不合法，或者能匹配空串（多半是笔误，例如末尾多了个 `|`）时，只报行号并以 2 退出。词表也查路径，路径里命中的那段打成 `***` 再报。
  - 判断二进制不看 NUL：`src/retrieval.ts` 的字符串字面量里本来就有原始的 NUL/SOH 字节。能按 UTF-8 解码的照常查；解不了的按 latin1 查，ASCII 的域名、IP 照样认得出。
  - `scripts/` 纳入 `tsconfig` 的 include。
  - CI 的 gitleaks：PR 扫 `origin/<base>..HEAD`，扫之前先验 base 存在，因为 8.30.1 遇到不存在的区间也以 0 退出。push 扫 `before..sha`，before 全零或不可达时扫到根。参数带 `-m`（合并提交里才出现的改动也扫）、`-v`、`--redact`。
  - pre-commit 的 `format:check` 查全仓，不只查暂存的文件，比 spec 严，保留。

### 第 2 步（2026-09-25，分支 `test/00-baseline-coverage`）

- 做法：四个自测文件由四个 agent 在各自的 worktree 里并行补断言，再由另外的 agent 逐项做变异测试（故意改坏被测的行为，确认新断言失败，再还原），审查提出的问题修一轮后，cherry-pick 到本分支。提交：`483f59f`、`68bd54c`（server），`ed38e23`、`e1b9b81`（engine），`baffaa4`、`1947ee3`（wecom），`aa8a476`、`46df577`（llm）。
- 只加了断言和一处仅供测试的导出（`adapters/wecom.ts` 的 `__test` 加上 `wechatify`），没有改任何行为，也没有改任何已有断言；改动的只有各组的 PASS 汇总行和 import 行（验收 3a）。
- 断言数：server 72 → 138，wecom 408 → 434；engine 多了 createQuote、去 markdown、同会话串行三块；llm 多了沉默跟进边界一块。PREFIX 哈希不变，完整测试连跑两遍结果相同。
- 「本阶段补」的不变量指向的断言（验收 14 的一部分）：
  - 1 → `engine.selftest.ts`「createQuote 算价向量」一块（最佳季 3 人与 4 人、非最佳季、跨年最佳季、全年同价、上浮后取整、总价）。
  - 6（cancelled）、7 → `server.selftest.ts`「已取消的订单：付款接口返回 409」「已付款的订单再调付款接口：不再推送跟进」。
  - 9（新旅程的正向一半）→ `engine.selftest.ts`「已支付的会话调了 search_routes，视为新旅程，阶段为 recommend」。
  - 20（前面几条边界）→ `llm.selftest.ts`「沉默跟进只追未转人工、未支付、非种子的企微会话……同一阶段只追一次，全程最多 2 次」。另外钉住了 spec 没写的全程上限（`FOLLOWUP_MAX_PER_SESSION` 默认 2）。
  - 21 → `engine.selftest.ts`「只去符号，文字要留着」一组（网页、企微两个渠道）；`adapters/wecom.selftest.ts` 的 `wechatify` 向量表（含「# 标题」和「#标题」，以及不误伤价格、时间、链接、标点的行）。
  - 26 → `engine.selftest.ts`「同一会话并发两条消息，第二条的模型请求里要看得到第一条的回复」。
  - 27 → `server.selftest.ts`「POST /api/chat 带 wecom: 前缀的会话 id 返回 400」。
  - 28 → `server.selftest.ts`「访客清理：……」「访客总量上限：……」两组。
  - 30 → `server.selftest.ts`「种子保鲜：……」一组。
  - 32 → `server.selftest.ts`「管理写接口 …：缺凭据 401 / 凭据错 401 / 服务端没配 ADMIN_PASS 返回 503 / 带 sec-fetch-site: cross-site 返回 403」。
  - 33 → `server.selftest.ts`「LLM 计费读端点 …：缺凭据 401 / 凭据错 401 / 服务端没配 ADMIN_PASS 返回 503 / 不做同源校验」。
- 这里取定的：`ADMIN_PASS`、`DEMO_FRESHEN` 都是用到时才读，测试在进程内临时改、用完恢复；`VISITOR_SESSION_MAX=100`、`DEMO_PRUNE_HOURS=24` 在 import 之前设好。保鲜的正向用例先删掉 `DEMO_FRESHEN`，本机 `.env` 里写着 `DEMO_FRESHEN=0` 也不影响。

### 第 3 步（2026-09-26，分支 `feat/00-deploy-profile`）

- 提交：`cbaabb6` 实现，`b41bf7a` 按对抗审查补测试、修 `.env.example`。
- `src/profile.ts` 是全仓唯一读 `DEPLOY_PROFILE`、`FLAG_*`、`DEMO_FRESHEN` 的地方，也不 import 任何业务模块。`src/profile-boot.ts` 是 `server.ts` 的第二个 import。`freshenDemoData` 改读 `seed_freshen`。
- 这里取定的：
  - 「prod 必须配置 ADMIN_PASS」放在 `profile-boot`，不放进 `resolveProfile`（spec 列出的 `resolveProfile` 抛错条件里没有它）。所以 `__profileTest.use({ DEPLOY_PROFILE: 'prod' })` 不需要带密码。
  - 测试隔离模块是 `src/selftest-env.ts`：六组自测和 `eval/run.ts` 的第一个 import。它把 `PROFILE_ENV_NAMES`（`profile.ts` 导出）全部设成空串，再把 `DEPLOY_PROFILE` 设成 `demo`。
  - 启动日志的格式：`[profile] <名字> · reset_command=on|off … ai_disclosure=always`。拒绝启动时的格式：`[profile] 配置错误，拒绝启动：<原因>`，退出码 1。
  - `.env.example` 不预填 `DEPLOY_PROFILE`（只给注释示例），这样照模板复制出来的服务器 `.env` 过不了第 7 步的「必须显式写明」检查。开关的说明写在单独的注释行：env 文件把 `=` 后面的整行都当成值。
  - 第 2 步的保鲜测试原来靠改 `process.env.DEMO_FRESHEN`，profile 缓存之后改成用 `__profileTest.use` 切换；并补了「seed_freshen 关闭」和「prod 下手动调保鲜」两条。
- 对抗审查：两个审查者（对照 spec 做变异测试；专找边角问题），每条发现再派一个反驳者。成立的 5 条都在 `b41bf7a` 里补上，补完后逐条把变异打回去，确认测试会失败：把 profile-boot 挪到 store 之后、删掉它、启动日志打印默认值而不是生效值、拒绝启动时不写原因、`profile()` 不缓存。
- server 自测 138 → 171 项断言；其余各组和 PREFIX 哈希不变。server 自测多了约 7 秒：配置错误的 5 种情况各起一次真正的 `server.ts` 进程。

## 验收记录

（对照验收标准逐条验证时填写，按子编号：编号 · 通过 / 未通过 · 证据）

第 1 步完成时，由独立 agent 在一次性 clone 里复现（`bca5574`；第 9 步统一复验）：

- 1a · 通过 · 干净 clone 里 `pnpm install` 装上 hook。暂存一个没格式化的 `.ts` 文件后提交，被 pre-commit 的 `oxfmt --check` 拦下；格式化好的改动能提交。
- 1b · 通过 · 51 字符的标题被 commitlint 拒（header-max-length），正好 50 字符的通过。带 `Co-Authored-By: Claude` 的提交被拒，fixup! 和合并形式的提交信息也被 no-ai-coauthor 拒。
- 1c · 通过（本地部分）· 干净 clone 上四个门禁全绿。每个门禁各造一处失败，对应命令都以非零退出；ci.yml 里每个门禁是单独一步，没有 `continue-on-error`。PR 上 CI 变红，待第一次推送后确认。
- 1d · 通过 · `git archive` 解出的目录里 `pnpm install --frozen-lockfile` 成功，`prepare` 什么也不做，四个门禁也全绿。`docker build` 同样成功。
- 2a · 通过 · PR #2 以 merge commit 合进 `dev`（`c9eb37b`）；`git merge-base --is-ancestor 292dc6d origin/dev` 成立，`dev` 上 `.git-blame-ignore-revs` 记的就是它的完整 sha。
- 2b · 通过（分支上）· 用 `--ignore-revs-file` 做 blame，`292dc6d` 改过的行都指回更早的提交（例如 `engine.ts:11` 指回 `2ffbc159`，`README.md:13` 指回 `d71ef1c6`）；`engine.ts` 里仍有 7 行 git 无法对应到更早的行。合并后在 `dev` 上复核：`engine.ts:11`、`README.md:13`、`data/hotels.json:23` 分别指回 `2ffbc159`、`d71ef1c6`、`c8e6ce2`。
- 2c · 通过 · 在 `9fec91c` 上重跑 oxfmt，结果与 `292dc6d` 的树逐字节相同。四个点的 PREFIX 和 49 行结果摘要都相同。
- 10b · 通过（第一个值）· 见实施记录。00 结束时的值由第 9 步补记。
- 10c · 通过 · 把 `data/sop.md` 的一个「。」改成「，」后测试照过，system 哈希变成 `b15209db…157e`，tools 不变。
- 11a · 通过 · 7 个规定路径逐个 `git add -f`，每个都让 `pnpm lint` 失败并列出路径；`src/packs/travel/index.ts` 不命中。补测：大小写变体和子模块也会命中（`a02040c`）。
- 11b · 通过 · 用自造的词表测试：命中只报「文件:行号」；同一行多处命中只报一次；最后一行没有换行、CRLF、中文路径、只在暂存区里的内容都查得到；PNG 不崩。
- 11c · 通过 · 一次性 clone 里造了假 `ghp_` 令牌和假 AWS 密钥，用 CI 同一版本、同一条命令扫描：PR 形式、push 形式、单个 sha 形式都以 1 退出（leaks found: 3），输出里只有 REDACTED。不含假提交的区间以 0 退出。没有推送到任何远端。
- 11d · 通过 · 见实施记录。
- 1e · 通过 · 临时 worktree 里放一份 `.env`（`DEPLOY_PROFILE=prod`、5 个 `FLAG_*=off`、`DEMO_FRESHEN=0`、`ADMIN_PASS`），`pnpm test` 的 50 行结果摘要与没有 `.env` 时逐行相同，自测进程的 profile 仍是 demo（2026-09-26，`cbaabb6`）。
- 5a · 通过 · 真实的 `server.ts` 进程：`DEPLOY_PROFILE=staging`、prod 加 `FLAG_RESET_COMMAND=on`、prod 没配 `ADMIN_PASS`、`FLAG_AI_DISCLOSURE=on_ask`、`DEMO_FRESHEN=0` 加 `FLAG_SEED_FRESHEN=on`，五种都以 1 退出，只有一行原因，没有异常栈。已写进 `server.selftest.ts`。
- 5b · 通过 · 正常启动时第一行是 `[profile] prod · reset_command=off … ai_disclosure=always`，打出的是生效值。已写进 `server.selftest.ts`。
- 11e · 部分通过 · 2026-09-25 经 owner 同意，用 `gh api` 打开了 secret scanning 和 push protection（`security_and_analysis` 两项均为 enabled），当时没有告警。在私有测试仓库里验证推送被拒这一半没有做（owner 没有要求）。

## 起草记录（2026-09-25）

- spec 由 Claude Code 按 owner 已拍板的决定起草（决策记录另记）。代码事实已对照 `2ffbc15` 的工作区逐条核过；函数一律按名字引用，因为 `engine.ts` 的行号已经漂移。
- 基线数字（起草时）：`eval/cases.json` 51 条用例，其中 32 条只在真实模型下跑、19 条 mock；100 轮、147 条断言；`data/routes.json` 20 条线路，`data/hotels.json` 23 家酒店。
- 同日按多角度审查修订（spec 仍是 draft，就地改）。主要变化：system prompt 身份那一行不改，00 不改变前缀；`ai_disclosure` 只有 `always`；prod 在 02 之前不接真实客户，成交链路的措辞整体留给 02；公开边界检查挪到第一次推送之前；补了渠道与存储、demo profile、承诺与画像几组不变量；缺陷修复从四处增加到六处。

## 交接（2026-09-25）

- 已完成：第 1–3 步。第 2 步 PR #3 已合进 `dev`（`8b52437`）；第 3 步在分支 `feat/00-deploy-profile` 上，待合进 `dev`。第 1 步：PR #2 以 merge commit 合进 `dev`（`c9eb37b`），合并后在 `dev` 上核对了 2a、2b；push 触发的 CI 是绿的，gitleaks 扫了 11 个提交，没有发现泄露。
- 半成品：无。
- 阻塞：无。
- 下一步：第 4 步，其余四个布尔开关接到调用点。

## Open

- `public/*.html` 没有纳入格式化。原因是 `server.selftest.ts` 和 `adapters/wecom.selftest.ts` 从页面里抽取脚本源码时，匹配依赖引号风格、缩进和函数签名；格式化后「chat.html 有 stripLink()」失败。要纳入，得先让这两组自测不依赖源码的排版。
- 不变量 1 的「× 0.95 那一步取整」用现有线路数据测不到：20 条线路的 `priceFrom` × 0.95（上浮前后都是）全是整数。要测得加一条测试专用的线路 fixture；现在的向量只覆盖了 × 1.1 之后的取整。

<!-- 「交接」与「Open」两节在第一次停下时再追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：

## Open
- 与 spec 的分歧、需要 owner 裁决的事
-->
