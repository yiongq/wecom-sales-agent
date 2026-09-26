# 00 · 基线与生产开关

Status: implemented
Phase: 0 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」
Owner: architecture decided by the owner (decision records tracked privately, 另记); implementation in Claude Code / Codex
Revisions: 2026-09-25 首版草稿经多角度对抗审查后就地修订（尚无代码依赖）。主要改动：system prompt 身份那一行不改（原方案改成「自我介绍时说 AI 旅行顾问」），00 不改变前缀；`ai_disclosure` 只有 `always`（原另有 `on_ask`）；prod 在 02 之前不接真实客户，成交链路措辞整体留给 02；公开边界检查挪到第一次推送之前，路径黑名单补上 ADR-003 决策 4 的三类（`src/packs/` 白名单以外的子目录、根目录 `tenants/`、`eval/real/`）；补了渠道与存储、demo profile、承诺与画像几组不变量；缺陷修复从四处增加到六处；README 一节补上「1v1 只做会话存档 + AI 辅助」的改法，开放问题 2（demo 域名）改为已定；非目标里品牌名参数化与租户设置改属 03、`admin.html` 自动弹登录框改属 02（原都写属于 01），与 01 spec 的交接表一致。2026-09-25 owner 确认后翻为 ready。2026-09-26 第 9 步验收：「不变量」一节把「本阶段补 / 本阶段新增」改成指向 00 期间加上的具体测试（验收 14），35–39 补上箭头；条文本身不变。2026-09-26 owner 确认验收通过，翻为 implemented。

## 背景与问题

wecom-sales-agent 现在是一个单实例 demo：Node 22 + Hono + TypeScript，tsx 直跑，会话和订单放在进程内的 Map 里，再落盘到 `var/*.json`，前端是 `public/` 下手写的 HTML，对外品牌是虚构的「云途定制旅行」。它要演进成通用、能接多个客户的产品，路线见总参考。`main` 上的 `demo-v1` 标签是演进前的基线。动工前的初始规格存档在 [initial-spec.md](./initial-spec.md)，其中不少内容已被实现迭代掉了，当前事实以代码和本 spec 为准。

01 起每个阶段都会动引擎、存储和后台。00 不加业务功能，只把之后改起来代价很大的东西先定下来：

- **行为基线。** 现有的可靠性设计散在三处：README「可靠性设计」、6 组 selftest（上千条断言语句）、`eval/cases.json`（51 条用例、147 条断言，mock 下跑其中 19 条）。目前没有一张「哪些行为不许变」的清单，01 换存储、换配置来源时，唯一的保障就是测试碰巧还是绿的。本 spec 把这些行为写成不变量，每条指向守着它的测试；还没有测试守着的，本阶段补上。
- **公开边界与门禁。** 仓库是公开的，推上去的东西自己洗不掉（PR 的 refs 也会留下），所以路径黑名单、内容黑名单和密钥扫描要在 00 第一次推送之前就位。四个门禁名已经在 `package.json` 里，但 `format:check` 和 `lint` 还只是占位。首次全仓格式化几乎会碰到每一行，拖得越晚，blame 越难追，合并冲突也越多。
- **demo 与生产的分界。** demo 实例有几样行为会伤到真实客户：「重置」口令会清空聊天并删掉订单（包括已付款的），后台匿名可读，任何人都能点模拟支付，网页访客可以随意聊。演示离不开它们，所以不删，而是收进 `DEPLOY_PROFILE` 开关，prod 下封顶。
- **几处缺陷和一句不实承诺**，见「缺陷修复」。
- **前缀字节。** 前缀缓存（README「成本优化：前缀缓存」）要求 system prompt 和 tools 逐字节不变。01 要把 SOP 挪进数据库，届时拿来对照的就是本阶段记下的哈希。00 自己不改前缀。
- **部署来源。** `deploy.sh` 现在 rsync 的是本地工作区，线上跑的代码可能从没提交过；部署前的 typecheck 查的也是工作区，而不是要部署的那一版。

## 目标

1. 行为基线：现有行为写成本 spec「不变量」一节，每条指向现有 selftest 的断言文字或 eval 用例 id；标了「本阶段补」的，在本阶段补上测试。
2. 公开边界：`pnpm lint` 和 CI 拦下敏感路径和「另记」类内容，CI 扫描密钥。这些都在 00 第一次推送之前就位。
3. 门禁接上真实工具（oxfmt、oxlint、lefthook、commitlint）。首次全仓格式化单独成一个提交，并写进 `.git-blame-ignore-revs`。
4. 加上 `DEPLOY_PROFILE=demo|prod` 和开关。demo 下，除 AI 显式标识和「缺陷修复」外，行为不变；prod 下开关封顶。
5. 修「缺陷修复」列出的六处问题。
6. 前缀稳定测试：断言多轮、多渠道、两种 profile 下 system prompt 和 tools 逐字节不变，并记下两段哈希。00 结束时的哈希与 00 开始前相同。
7. `deploy.sh` 改成从 git tag 部署，四个门禁在归档出来的目录里跑。
8. README 里过时的数字、本地跑法和部署方式改成现状，「生产化路径」一节指向总参考。

## 非目标

- 跟进消息过出口护栏，以及识别「别发了」这类拒绝（属于阶段 02）。
- 付款确认（`notifyPaid`）不看会话是否已转人工，照样推送并把阶段改成 paid（属于阶段 02，和跟进消息一起定）。
- 人工回复即接管；`/api/sessions/:id/reply` 校验会话是否已被接管（属于阶段 02）。
- 人工回复和 AI 回复从同一个客服账号发出，账号名改成含「AI 旅行顾问」之后，客户分不清哪条是真人回的（属于阶段 02，和人工回复一起定，例如给人工回复加「【顾问】」前缀）。
- 报价快照：方案书按快照渲染，调价后已发出的链接不变价（属于阶段 02）。
- prod 的收款流程（属于阶段 02）。包括「顾问锁价后发收款方式」、后台的「确认收款」界面，以及 prod 下整条成交链路的措辞：`/pay` 页、企微支付卡片、重发支付链接、成单安全网、跟进模板的 closing 段、SOP 的 closing 段和「付款只走官方支付链接」那句。另外，prod 下要不要保留「带管理凭据可以标记已付」，00 先保留，由 02 定。见「mock_pay 与 prod 的真实客户」。
- 转人工时即时推送给顾问（属于阶段 02）。
- 「重置」只对白名单生效、不删已付订单：demo 下现有行为（`engine.selftest.ts` E6）不变（属于阶段 02，随会话入库一起定）。
- `admin.html` 在列表返回 401 时自动弹出登录框（属于阶段 02，对齐 `admin.html` 与后台时一起改，见 [01 spec](../01-pg-config-console/spec.md)「从 00 与总参考接过来的事项」）。00 的 prod 下，未登录打开后台列表是空的，点「登录」后正常。
- Postgres、配置入库、SOP 版本与发布闸、cookie 会话鉴权、后台 SSE（`/api/admin/stream`）鉴权、compose 编排（属于阶段 01）。
- 品牌名参数化、租户设置即 `capFlags` 的接线（属于阶段 03，见 01 spec 同一张表）。00 没有租户设置，只交付它将来要经过的封顶函数 `capFlags`。
- 网页渠道转正：prod 的网页渠道需要新的 channel 名和会话 id 前缀（属于阶段 04）。本阶段 prod 直接关掉网页模拟器。
- 多租户、渠道层 v2、行业包抽取（属于阶段 04）；知识库与售后（属于阶段 03）。
- eval 用例格式升级，例如注入模型输出、pass^k（阶段未定）。
- 总参考列在阶段 0 的「横评原始数据迁出临时目录」和项目记忆的保全，在仓库外完成，不设验收（另记）。
- prod 下有意保持匿名可达的接口：`/pay/:orderId` 和 `GET /api/orders/:id`（支付页凭订单号读单）、`/proposal/*` 和 `/api/proposal/*`（发出去的方案书）、`/wecom/callback`（企微回调，自带签名校验）、`/kf-qr.png`（客服入口）、`/healthz`，以及 `/api/admin/stream`（只推变更信号，01 加鉴权）。

## 接口与数据流

### 部署 profile

```ts
// src/profile.ts —— 全仓唯一读取 DEPLOY_PROFILE、FLAG_* 与旧变量 DEMO_FRESHEN 的地方
export type DeployProfileName = 'demo' | 'prod';

export interface DeployFlags {
  reset_command: boolean; // 「重置」口令
  anon_readonly_admin: boolean; // 后台匿名只读：种子会话 + 请求者本人的访客会话
  seed_freshen: boolean; // 种子演示数据的时间保鲜
  visitor_simulator: boolean; // 网页模拟器：匿名访客聊天、SSE 与 sim- 会话直读
  mock_pay: boolean; // 不带管理凭据也能调用的模拟支付
  ai_disclosure: 'always'; // AI 显式标识。00 只有这一个取值，见「AI 显式标识」
}

export interface DeployProfile {
  readonly name: DeployProfileName;
  readonly flags: Readonly<DeployFlags>;
}

export const DEMO_DEFAULTS: Readonly<DeployFlags>;
/** prod 下每个开关最宽能取到的值；prod 的默认值就是它 */
export const PROD_CEILING: Readonly<DeployFlags>;

export class ProfileConfigError extends Error {}

/**
 * 从环境变量解析。空串一律当未设置。
 * 遇到非法值、prod 下越过封顶、DEMO_FRESHEN=0 与 FLAG_SEED_FRESHEN=on 同时出现，抛 ProfileConfigError
 */
export function resolveProfile(env: Readonly<Record<string, string | undefined>>): DeployProfile;

/** 把请求的开关值压进 profile 允许的范围。租户设置（03）只能经由它生效 */
export function capFlags(name: DeployProfileName, requested: Partial<DeployFlags>): DeployFlags;

/** 当前进程的 profile：首次调用时解析 process.env，之后缓存 */
export function profile(): DeployProfile;

/** 仅供自测：在同一进程里切换 profile */
export const __profileTest: {
  use(env: Record<string, string | undefined>): void;
  reset(): void;
};
```

```ts
// src/profile-boot.ts —— 只有副作用。server.ts 在 import './env.js' 之后紧接着 import 它
// 调用 profile()，用一行日志打出 profile 名和六个开关的生效值；
// 抛 ProfileConfigError 时打印原因并 process.exit(1)
```

- 宽严顺序：布尔开关 `false` 比 `true` 严。`capFlags('prod', x)` 的每一项都取 `x` 与 `PROD_CEILING` 中更严的那个；`capFlags('demo', x)` 就是 `{ ...DEMO_DEFAULTS, ...x }`。
- 调用点在用到时读 `profile().flags.<名字>`，不在模块加载时拷进常量，这样自测可以在同一进程里切换 profile。
- `store.ts` 在模块加载时就会跑保鲜和清理，因此会触发第一次解析。`profile-boot` 必须排在任何会 import `store` 的模块之前：配置错误时，进程先打出一行原因再退出，而不是在 import 链里抛出异常栈。

### 引擎与渠道的新出口

```ts
// src/engine.ts
/** 发给模型的固定前缀：system 是请求里第一条 system 消息的全文，tools 是 JSON.stringify(toolDefs) */
export function promptPrefix(): { system: string; tools: string };

// src/server.ts（模块内）
/** 'wecom' → wecomAdapter；'simulator' → simulatorAdapter；其余 → 推送一律失败的空适配器，并记一条 error 日志，不抛 */
function adapterFor(channel: string): ChannelAdapter;

// src/types.ts
export interface ChatMessage {
  // …现有字段不变
  /** 企微非文本消息的占位带上原消息的 msgid，重放时据此判断是否已经记过。01 迁入时保留 */
  msgid?: string;
}
```

## 门禁

四个名字是唯一接口。hook、CI 和 Claude Code 的 Stop hook 只调这四个名字，背后接什么工具只在 `package.json` 里改：

| 名字           | 背后                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `format:check` | `oxfmt --check`（oxfmt 0.68）                                                    |
| `lint`         | `oxlint --deny-warnings`（oxlint 1.83），后面接公开边界检查（见「CI 与部署」）   |
| `typecheck`    | `tsc --noEmit`（不变）                                                           |
| `test`         | 6 组 selftest 依次跑，再跑 `LLM_MOCK=1 eval/run.ts`（已串好，不变；不迁 vitest） |

- lefthook 2.1：pre-commit 跑 `format:check`、`lint`、`typecheck`；commit-msg 跑 commitlint（Conventional Commits，标题不超过 50 字符）和 AI co-author 署名拦截。
- `prepare` 脚本负责装 hook。Docker 构建和 `git archive` 出来的目录都会跑 `pnpm install`，而这两处都没有 `.git`，所以 `prepare` 在这种目录里必须什么也不做，并且不能让安装失败。
- 镜像会因此多装这几个 devDependency（Dockerfile 用的是 `--prod=false`）。这可以接受，01 换多阶段构建时一并处理。
- 格式化配置对齐现有代码风格，让首次 diff 尽量小：单引号，保留分号；`printWidth` 在 100、120、140 里实测，取首次 diff 行数最少的那个。
- 格式化排除 `data/sop.md` 和 `pnpm-lock.yaml`。`sop.md` 的字节就是 system prompt 的一部分。`public/*.html` 能否纳入，要看格式化之后 `pnpm test` 是否仍然全绿：`server.selftest.ts` 和 `adapters/wecom.selftest.ts` 都会从页面里抽取脚本源码，匹配时依赖引号风格、缩进和函数签名。不通过就排除，并记进 plan 的 Open。
- 首次格式化单独成一个提交，只含格式化器的输出。紧接着的下一个提交把 `format:check` 切成真实命令，把格式化提交的 sha 写进 `.git-blame-ignore-revs`，并在 `CONTRIBUTING.md` 里写上 `git config blame.ignoreRevsFile .git-blame-ignore-revs`。每个脚本从占位切成真实命令的时机，都要让每一个提交都过得了 pre-commit，不绕过 hook（顺序见 plan 第 1 步）。
- 这个 PR 合进 `dev` 时只能用「Create a merge commit」。squash 和 GitHub 的「Rebase and merge」都会生成新的 sha，忽略表随之失效。合并后在 `dev` 上核对一次。

**lint 首次跑出的问题怎么处理。** 取舍如下：

- 00 只开 oxlint 默认的 correctness 类别，加 `--deny-warnings`，suspicious、pedantic、style 都不开。00 的目的是让门禁成真，不是整仓重构；correctness 命中的多半是真问题（未用的变量、不可达的代码、恒真的比较），值得修。
- 真问题当场修。修复和格式化分开提交（`fix(lint): …`），不进 `.git-blame-ignore-revs`，因为这些是语义改动。每个修复提交都跑完整的 `pnpm test`。
- 故意的写法逐行豁免并写明理由：`// oxlint-disable-next-line <rule> -- <理由>`。例如出口护栏用 `\u0001`–`\u0003` 控制字符当链接空位记号，会命中 `no-control-regex`。
- 某条规则的命中全是故意写法、并且超过 10 处时，在配置里关掉这条规则，写明理由，并记进 plan 的 Open，01 结束前复查。
- 不为 lint 改任何护栏正则或话术的语义：lint 修复前后，`pnpm test` 的结果和前缀哈希都不变。

## 部署 profile 与开关

| 开关                  | demo 默认 | prod 封顶 | 关掉后可观察的行为                                                                                                                                                                                                                             | 代码位置                                                                                                                   |
| --------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `reset_command`       | 开        | 关        | 「重置 / 重新开始 / 重来 / 清空会话 / reset」按普通客户消息入库。已转人工时照常静默；否则回一句固定话术「想换方向或改订单，直接告诉我新的需求就行～」，不调模型。阶段、画像、订单和转人工状态都不变                                            | `engine.ts` `handleMessageInner` 开头的重置分支                                                                            |
| `anon_readonly_admin` | 开        | 关        | 不带有效管理凭据时，`GET /api/sessions`、`GET /api/orders`、`GET /api/usage`、`GET /api/sessions/<种子 id>` 一律 401                                                                                                                           | `server.ts` 的列表路由、`sessionReadAuth`、`/api/usage`                                                                    |
| `seed_freshen`        | 开        | 关        | 种子会话（`wecom:cust_*`）和它们订单的时间戳不再平移                                                                                                                                                                                           | `store.ts` `freshenDemoData`                                                                                               |
| `visitor_simulator`   | 开        | 关        | `POST /api/chat`、`GET /api/stream/:id`、`GET /api/sessions/sim-…`、`/chat.html`、`/guide.html` 返回 404，`/` 改跳 `/admin.html`。没有访客，访客 LLM 预算闸不再触发，`/healthz` 的 `visitorLLM` 照常输出。访客会话清理不归这个开关管，始终运行 | `server.ts` 对应路由与静态托管；`budget.ts` `tryReserveVisitorLLM` 和 `engine.ts` 的访客预算分支不用改，入口关掉后就走不到 |
| `mock_pay`            | 开        | 关        | 不带管理凭据的 `POST /api/orders/:id/pay` 返回 404，订单状态不变。带凭据（并经过 `sameOriginOnly`）仍能标记已付，并触发 `notifyPaid`。`/pay` 页、支付卡片和话术都不变，见下文「mock_pay 与 prod 的真实客户」                                   | `server.ts` 支付路由                                                                                                       |
| `ai_disclosure`       | `always`  | `always`  | 00 只有 `always`，见「AI 显式标识」                                                                                                                                                                                                            | `adapters/wecom.ts` 两段欢迎语；`public/chat.html` 的开场                                                                  |

- `sim-` 会话能不能凭 id 直读，只由 `visitor_simulator` 决定；`anon_readonly_admin` 只管列表、`/api/usage` 和种子 id 的直读。

环境变量：

| 变量                                                                                                             | 取值            | 未设置或空串时      | 其他情况                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLOY_PROFILE`                                                                                                 | `demo` / `prod` | 按 `demo`           | 非法值启动失败                                                                                                                 |
| `FLAG_RESET_COMMAND`、`FLAG_ANON_READONLY_ADMIN`、`FLAG_SEED_FRESHEN`、`FLAG_VISITOR_SIMULATOR`、`FLAG_MOCK_PAY` | `on` / `off`    | 取 profile 的默认值 | 非法值启动失败；prod 下设 `on` 也启动失败                                                                                      |
| `FLAG_AI_DISCLOSURE`                                                                                             | `always`        | `always`            | 其他任何值启动失败（00 不提供 `on_ask`）                                                                                       |
| `DEMO_FRESHEN`（旧变量）                                                                                         | `0`             | 不影响              | `0` 等价于 `FLAG_SEED_FRESHEN=off`；和 `FLAG_SEED_FRESHEN=on` 同时出现时启动失败；其他值照旧忽略。现网 `.env` 里的这一项不用改 |

启动：

- `profile-boot` 用一行日志打出 profile 名和六个开关的实际生效值。
- 以下情况一律启动失败，日志写明原因：`DEPLOY_PROFILE` 或 `FLAG_*` 取了非法值；prod 下试图放宽某个开关；prod 下没配 `ADMIN_PASS`；`DEMO_FRESHEN` 与 `FLAG_SEED_FRESHEN` 冲突。prod 没有匿名只读，没配密码的后台什么都看不到，也接管不了会话，这样的实例不如不起。启动失败会被部署的健康检查拦下，并回滚到 `:prev`。demo 下没配 `ADMIN_PASS` 仍维持现状：读可用，写返回 503。
- 运行时未设 `DEPLOY_PROFILE` 按 demo 处理，这样零配置克隆、六组自测和 eval 都照旧可用。生产实例的防线放在部署上：`deploy.sh` 要求服务器 `.env` 显式写明 `DEPLOY_PROFILE`。现网 demo 运行时不受影响，但部署前要在服务器 `.env` 里补一行 `DEPLOY_PROFILE=demo`。

测试隔离：`env.ts` 会用本机 `.env` 补上缺失的变量，所以本机 `.env` 里的 `DEPLOY_PROFILE`、`FLAG_*` 会让自测跑在别的 profile 下。六组自测和 `eval/run.ts` 在 import 业务模块之前，一律把 `DEPLOY_PROFILE` 设成 `demo`，把所有 `FLAG_*` 和 `DEMO_FRESHEN` 设成空串（例如第一个 import 一个只设环境变量的模块）。要测 prod 的用例用 `__profileTest.use` 切换，结束时调 `reset()`。

### mock_pay 与 prod 的真实客户

整条成交链路都默认 `/pay` 页能付款：SOP 的 closing 段、`create_order` 返回的 `payUrl`、成单安全网、重发支付链接、企微的支付卡片、跟进模板的 closing 段，以及 `/pay` 页本身。

00 在 prod 下只做一件不能让步的事：**匿名请求永远无法把订单标成已付款。** 链路的其余部分原样不动，所以 prod 的前缀与 demo 相同。

这条链路在 prod 下不能给真实客户用：

- 客户付不了款，而话术正相反。SOP 让 AI 说「付款只走我们发给您的官方支付链接」；客户说「链接打不开」时，引擎会确定性地把同一条链接再发一遍，工具描述还规定这种情况不转人工。结果是客户想付却付不了，也没人接手。
- 需要人接手的地方都没有通知顾问的通道：转人工，以及「缺陷修复」2 放宽后客户直接说「人工 / 真人」。企微只允许在客户最后一条消息之后 48 小时内主动发消息，顾问没盯着后台，这单就永久丢了。

因此定一条运行规则：**02 交付收款流程和转人工即时推送之前，prod 实例只用于验收和预演，只接内部测试用的客服账号，不对真实客户开放入口。** 这与路线一致：第一个真实客户是 02 的试点。02 在放开真实流量之前，要把「非目标」里列出的成交链路措辞一起改掉，并解决「官方支付链接」那句与收款方式的冲突。

「带管理凭据可以标记已付」在 00 保留：没有界面，供验收和预演时手工确认收款，并让 `notifyPaid` 这条链路在 prod 下能被验收。去留由 02 的收款流程 spec 定。

### AI 显式标识

`ai_disclosure=always`（00 唯一的取值，demo 和 prod 都是）时：

- 企微的首次欢迎语 `WELCOME_TEXT` 和老客户欢迎语 `WELCOME_BACK_TEXT`，第一句都写明「AI 旅行顾问」，并写明人工入口（回复「人工」即可转真人顾问；总参考把这一项和「缺陷修复」2 一起放在 00）。老客户欢迎语仍以「欢迎回来」开头，删掉不实承诺（「缺陷修复」4）。网页模拟器 `public/chat.html` 的开场用同一口径。
- 客服账号名要在企微后台手动改成含「AI 旅行顾问」。这不是代码改动，列为手动验收项。
- system prompt【硬性要求】里身份那一行逐字节不变：主动自我介绍时不提 AI，被问就如实承认。被问身份就承认的代码兜底（`IDENTITY_QUESTION` / `IDENTITY_ANSWER`）保留，并补上它漏掉的两条路径（「缺陷修复」5）。
- 依据是 owner 定的做法：账号名加欢迎语首句写明 AI，对话中不反复自称 AI。欢迎语不在会话历史里：企微的 `send_msg_on_event` 不入库，网页的开场只在前端。如果改身份那一行，让模型「自我介绍时说 AI 旅行顾问」，客户回一句「你好」，模型就会再介绍一遍。
- 因此 `mockChat` 的开场和 eval 的 `guard-05-no-ai-opening` 都不改：它们守的是「模型的回复不主动自称 AI」，这条仍然成立。
- 欢迎语的渲染由 `adapters/wecom.selftest.ts` 的假企微服务端断言。`__test.WELCOME_BACK_TEXT` 保留原名，值是新文案，所以现有 W1 用例一行不改。`alignSessionForReplay` 在识别欢迎语时，除了新文案，也认改版前的两段旧文案：上线当次重启正好是在途重放发生的时候，会话里存着的还是旧文案。

## 缺陷修复

1. **转人工后，客户发非文本消息仍会收到自动回复。** `adapters/wecom.ts` `handleCustomerMessage` 的非文本分支在进引擎之前就发了提示并返回，既不看 `handedOver`，也不入库，后台看不到客户发过图片。改为：
   - 非文本消息一律在会话里记一条客户消息占位：`[图片]` `[语音]` `[视频]` `[文件]` `[链接]` `[位置]`，其他类型记 `[其他消息：<msgtype>]`。占位带上原消息的 `msgid`。会话不存在就建一个，因为客户发了内容就算开口了。
   - 已转人工：只记占位，不发任何内容。
   - 未转人工：照旧发提示，提示本身也作为 AI 消息记进会话。
   - 启动重放时，按 `msgid` 判断这条消息的占位是否已经记过，不比对占位文本：连着发的两张图片，占位文本一模一样。
2. **`HANDOFF_REQUEST` 认不出「人工」的几种说法。** 按下表修改 `engine.ts` 的 `HANDOFF_REQUEST` / `isHandoffIntent`，向量加进 `dejargon.selftest.ts` 的「必须转 / 不该转」两张表：

   | 单独发这一句                                                           | 期望                                             |
   | ---------------------------------------------------------------------- | ------------------------------------------------ |
   | `人工`、`人工！`、`找人工`、`人工服务`、`接人工`、`真人`、`要真人`     | 转人工                                           |
   | `你是真人还是机器人？`、`你是真人吗`、`你是人工智能吗`、`有真人导游吗` | 不转（身份问题走身份兜底，问服务角色不等于要人） |
   | `三亚有人工沙滩吗`、`西湖是人工湖吗`、`那边人工费贵吗`                 | 不转（旅行话题里的「人工」）                     |

   `engine.selftest.ts` 里 u2b 用例的客户原话「要真人」会因此走确定性转人工，假模型的脚本用不完，断言失败。把原话换成一句不会触发确定性转人工的说法（例如「能让顾问直接跟我聊吗」），保留它原本要测的「只剩许诺时换成顾问会联系」。这是本阶段唯一一处改动现有断言的地方。

3. **`adapterFor` 遇到未知渠道时默认走模拟器。** 模拟器在没有 SSE 连接时 `push` 返回 true，于是后台显示「已回复」，实际什么也没发出去。改成返回一个推送一律失败的空适配器，并记一条点名渠道和会话的 error 日志。不能 throw：`POST /api/orders/:id/pay` 在 `markOrderPaid` 之后才调它，抛出会让一个已经付款成功的请求返回 500。支付路由在推送失败时往会话里记一条系统备注，与 `/reply` 的现有做法一致；种子会话（`wecom:cust_*`）除外，它们对应的企微客户是编造的，推送必然失败，公开演示的种子会话里不能因此多出失败备注。
4. **老客户欢迎语里「咱们之前聊的内容我都记得」是不实承诺。** 会话不超过 30 条时，引擎把整段历史交给模型；超过后最多交 39 条（`historyWindow`）。超过 400 条的会话会被裁到 300 条，「重置」还会清空历史。新文案不承诺记忆。
5. **身份兜底漏了两条提前返回的路径。** 兜底只在走模型那条路径的末尾执行；确定性转人工（`isHandoffIntent` → `handoffReply`）和重发支付链接（`resendPayReply`）都在它之前就返回了。实测「你是机器人吧？我要投诉」和「你是真人吗？转人工」都转了人工，回复里都没有 AI 字样。改为：这两条路径同样在客户这句命中 `IDENTITY_QUESTION`、回复里又没有 AI 字样时，把 `IDENTITY_ANSWER` 放在回复最前面。
6. **已转人工的客户再次进入会话，仍会收到 AI 的欢迎语。** `handleEnterSession` 的两条路径（`welcome_code` 首次欢迎、老客户补发）都不看 `handedOver`。欢迎语会邀请客户跟 AI 聊，而 AI 此时不会再回复。改为：会话已转人工时两条路径都不发，只记一行日志。

## 前缀稳定测试

写在 `engine.selftest.ts`，接在现有 L2/L3/L6/L7 那一段后面。本机假模型服务记下每个请求的原始 body。跑一段不少于 5 轮的对话，阶段从 greeting 推进到 quote，其中包含：一轮预取；一轮工具调用；一轮让假模型在同一轮里连续返回 5 次工具调用（`MAX_TOOL_ROUNDS` 是 6），第 6 次请求因此不带 tools；以及在 `wecom:` 渠道的会话上再跑一轮。断言：

1. 每个请求的第一条 system 消息，逐字节等于 `promptPrefix().system`。
2. 每个带 `tools` 的请求，`JSON.stringify(body.tools)` 逐字节等于 `promptPrefix().tools`。
3. 用 `__profileTest` 切到 prod 后，`promptPrefix()` 与 demo 下完全相同。00 里没有任何开关影响前缀。
4. 输出一行 `PREFIX sha256 system=<64 位十六进制> tools=<64 位十六进制>`。

- 打印哈希时读的必须是 `data/sop.md`：测试在 import 引擎之前，把 `SOP_PATH` 设成它的绝对路径，本机 `.env` 覆盖不了。
- 不设静态 golden 常量。改 `sop.md` 的任何一个字都不会让这个测试失败，只会改变打印出来的哈希。00 开始前、格式化和 lint 修复之后、00 结束时，三次打印的值必须相同，都记在 plan 的实施记录里。01 的导入测试在运行时比对「文件渲染 == 数据库渲染」，00 记下的值只用于跨阶段的人工核对。
- 现有的请求形状断言照旧守着其余部分：`engine.selftest.ts`「历史前缀应跨轮稳定」「会话状态应作为 system 消息紧挨在最新客户消息之前」；`llm.selftest.ts`「E11 最后一轮不带 tools / tool_choice」与「11 contextNote / prefetch 的线上位置」两段。

## CI 与部署

### 公开边界检查（进 `pnpm lint`）

一个脚本检查 `git ls-files` 列出的已跟踪和已暂存文件，命中就退出码非 0。放在 `lint` 里，pre-commit 就能在提交前拦住，CI 也走同一个名字。它在 00 第一次推送之前就位（plan 第 1 步）。边界的划分规则见 [ADR-003](../../adr/adr-003-open-core-boundary.md)，下面最后三类路径来自它的决策 4。

**路径黑名单**，命中时列出路径：

- `.env`、`.env.*`（`.env.example` 除外）、`.deploy.env`
- `var/` 下的任何文件
- `*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.bundle`
- 任何位置的 `kf-qr*`（客服二维码编码的就是 open_kfid，等同凭据）
- `.playwright-mcp/`、`scratchpad/`、`*.log`
- `.claude/` 下除 `settings.json` 和 `hooks/` 以外的文件
- `src/packs/` 下白名单以外的子目录。白名单从 00 起写死为 `travel`、`ecommerce-aftersales`；新增公开包要改白名单，并在 PR 里说明
- 仓库根目录的 `tenants/`（后台里合法的租户设置页等代码不在这个位置，不受影响）
- `eval/real/`

**内容黑名单。** 「另记」类内容（真实公司名、真实域名和服务器 IP、私有笔记路径等）的词表本身不能进公开仓库。README「在线体验」一节里的公开 demo 地址不收进词表，见开放问题 2。同一个脚本从环境变量 `SENSITIVE_PATTERNS`（每行一个正则）或被 gitignore 的 `.sensitive-patterns` 文件读取词表；两者都没有时跳过这一项，并打印一行提示。CI 从仓库 secret 注入词表。命中时只报「文件:行号」，不回显命中的内容，因为 CI 日志是公开的。来自 fork 的 PR 拿不到 secret，这一项会跳过。

### 密钥扫描

- CI 加一步 gitleaks（钉版本）：PR 上扫 `base..HEAD` 的提交，push 到 `dev` / `main` 时扫本次推送的提交。本阶段对全历史跑一次，结果记进 plan；误报写进 `.gitleaksignore`，每条带理由。
- 仓库设置里打开 GitHub secret scanning 和 push protection（公开仓库免费）。这是设置而不是代码，列为手动验收项。
- gitleaks 不接进四个门禁名，因为它要看提交区间。本地最常见的事故是把 `.env` 提交进来，这已经由 `lint` 里的路径黑名单兜住。
- 验证扫描真的会失败，不能靠往公开仓库推一个假令牌：PR 的 refs 永久可读，而且 push protection 会先把它拒掉。做法见验收 11c、11e。

### deploy.sh

- 用法 `bash deploy.sh <tag>`。参数必须是本地存在的 tag（`refs/tags/<tag>`）；分支名、提交号或不带参数都拒绝。
- 流程：
  1. `git archive <tag>` 解到临时目录。
  2. 在这个目录里 `pnpm install --frozen-lockfile`，然后依次跑四个门禁；任何一个失败就中止，服务器上什么都不动。
  3. 在服务器上检查 `.env` 存在，并且写明了 `DEPLOY_PROFILE`；缺了就中止，服务器上什么都不动。
  4. 把这个目录同步到服务器（`--delete`，排除 `.env` 和 `var/`）。
  5. 给正在跑的容器所用的镜像打 `:prev`，然后 `docker build --build-arg APP_REVISION=<tag>`。
  6. 换容器，做健康检查；失败就回滚到 `:prev`。现有的回滚逻辑和容器参数原样保留。
- `NAME`、`REMOTE_DIR`、`HOST_PORT` 都能用环境变量覆盖（`NAME` 是新加的），这样可以在同一台服务器上起一个旁路实例演练回滚，不打断线上 demo。旁路实例的 `.env` 不能配企微凭据，否则它会和线上实例抢同一个客服账号的消息。
- 版本号写进镜像：Dockerfile 加 `ARG APP_REVISION` 并设成环境变量，`/healthz` 多返回一个 `revision` 字段。回滚到 `:prev` 后，报出的是上一版的 tag；本地 `pnpm start` 没有这个变量，返回 `"dev"`。
- 这样一来，工作区里未提交的改动永远上不了线，上线的每一版都过了四个门禁。

## README

- 描述当前状态的数字改成现值：`eval/cases.json` 51 条用例、147 条断言，mock 下跑 19 条；本地自测是 6 组。「模型选型」和「前缀缓存」两节里的表格是在当时那一版用例集上测出来的，数字保留，表头注明「当时的回归集」，因为改分母就等于改了测量结果。
- 本地跑法改成四个门禁名；部署一节改成按 tag 部署；新增 `DEPLOY_PROFILE` 的说明，管理面鉴权表加一列 prod。
- 「生产化路径」一节保留原有的判断依据，开头指向 `docs/architecture/master-reference.md` 作为总参考。
- 「接入真实企业微信」一节把「客户加好友 1v1 托管（AI 顶着销售个人身份聊）」写成了生产路径，与总参考「渠道 → 不做」冲突。改成：1v1 只做会话存档 + AI 辅助、由人点发送；全自动接待只走微信客服。
- 「在线体验」一节里的公开 demo 地址保留，这是 AGENTS.md 硬规则 5 允许的唯一例外；README 的其他位置和仓库里的其他文件都不出现生产域名（开放问题 2，已定）。

## 不变量

每条都能写成断言。箭头后是守着它的测试：selftest 按「文件 + 断言文字或场景编号」，eval 按用例 id；带「真实模型」的 eval 用例只在真实模型下跑，不进 CI。起草时标「本阶段补」的，是现有行为但还没有测试守着；标「本阶段新增」的，是 00 引入的行为。这两类的测试在 00 期间补上，箭头现在指向它们，括注「00 补 / 00 新增」。

交易与价格：

1. 报价金额只由 `createQuote` 从线路的 `priceFrom` 算出，规则只有写死的两条：出发月份在最佳季时，每人价取 `round(priceFrom × 1.1)`；4 人及以上，每人价再取 `round(× 0.95)`；不在最佳季或全年同价的线路不上浮；总价等于每人价 × 人数。模型不参与算钱。→ eval `guard-08b-holiday-date`（17,380 = 15,800 × 1.1）、`guard-08c-offpeak-note`；`guard-11-no-made-up-price-rules`（真实模型）；`engine.selftest.ts`「createQuote 算价向量」一块（00 补）：「最佳季 3 人：每人 16800 × 1.1 = 18480，总价 × 3」「最佳季 4 人：每人 18480 × 0.95 = 17556，总价 × 4」「不在最佳季（7 月）不上浮」「全年同价的线路不上浮」「每人价取整：26800 × 1.1 = 29480，总价 88440」「最佳季 4 人：先 round(10001 × 1.1) = 11001，再 round(× 0.95) = 10451」。
2. 发给客户的正文里，每个金额都追溯得到出处：报价规则、本会话出现过的线路的工具结果，或客户原话（且不在成交语境里）。追不到出处的那一句要么删掉，要么换成核价话术，永远不会原样发出。→ `price-guard.selftest.ts`「拦得住：编造的价格」「放得过：真实报价与合法档位话术」「P1 编造样本（本会话从没出现过松赞线）被拦」；`engine.selftest.ts` E1、V1–V4。
3. 模型自己编的价格规则、预算判断和稀缺说法（儿童价、「比国庆便宜」「在您预算内」、名额紧张……），对不上工具结果就删掉那一句，其余照发。做不到的服务承诺（开专票、资金监管、机票代订）换成「由顾问确认」的口径，「电话联系」改成「在微信上联系」。→ `engine.selftest.ts` V5「儿童价 / 编造稀缺的句子删掉」、V6「对得上的比价保留、编的理由删掉」、V7「超了预算还说「在您预算内」：删掉」「create_quote 带 withinBudget:false 与每人差额」、V8「专票不许答应」「不许说电话联系」；`price-guard.selftest.ts`「规则词 / 预算判断 / 服务承诺」一节。
4. 成单安全网：客户这句是短句（不超过 40 字）并明确要下单、已有报过价的线路、能从客户原话里解析出出发日期，而模型这一轮没调 `create_order` 时，引擎自己建单，并改写回复，带上真实的 `payUrl`。客户在还价、在给别人另订，或最近说的人数和报价对不上时，安全网不兜底。→ `engine.selftest.ts` R1「还价不能按原价兜底建单」「真要下单照常兜底」、W9「「挺实惠的，就订这个」兜底建单」、W2、W11；`flow-01-happy`（真实模型）。
5. 订单幂等：同线路、同人数、同日期已有待付款单时，再次下单复用原单并说明是复用，不新建。改人数或日期重新下单时，同线路旧的待付款单作废；已付款的单不动。→ `engine.selftest.ts`「重复下单指令不应新建订单」「应复用原订单的支付链接」、R2「旧的待付款单要作废」、R3「复用要带 reused 和说明」；eval `robust-04-resend-pay`；`robust-02-repeat-order`（真实模型）。
6. 被替代或已取消的订单不能再付，付款接口返回 409，订单状态不变；已付款的单不能被替代。目前代码里没有把订单改成 cancelled 的路径，这条守的是判断本身。→ `server.selftest.ts`「被替代的旧单：付款接口拒绝」「被替代的旧单：状态不变成已付」「已付款的单不能被替代」；「已取消的订单：付款接口返回 409」「已取消的订单：状态仍是 cancelled、没有付款时间」（00 补，测试里直接把订单状态设成 cancelled）。
7. 对已付款的订单再调一次付款接口，不改订单，也不再推送一次跟进。→ `server.selftest.ts`「已付款的订单再调付款接口：订单不变（仍已付、付款时间不变）」「已付款的订单再调付款接口：不再推送跟进」（00 补）。

链接：

8. 客户收到的正文里，只可能留下两种站内链接：本会话里未被替代的订单的 `/pay/<订单号>`；以及本轮真调过 `generate_proposal`、线路 id 也对得上的 `/proposal/<线路>/<人数>[/<日期>]`。带域名的 URL 先剥成路径再判断；其余的一律抹掉，包括外部链接、编造的域名、半截或变体的路径。→ `engine.selftest.ts` E13、X4「「/p/ord_…」换成真支付链接，半截路径不留」、X2；eval `guard-03-fake-link`；`guard-09-fake-domain`（真实模型）。

阶段、日期与参数：

9. 销售阶段只从本轮实际执行过的工具调用推出来：`create_order` 推到 closing；`create_quote`、`generate_proposal` 推到 quote；`search_routes`、`get_route_detail`、`search_hotels` 推到 recommend。客户一开口至少是 discovery。推出的阶段和当前阶段取较大的那个，不回退。例外：客户原话里的异议（已建过单的不再回落到异议）、转人工、重置、支付；已支付的会话本轮调了 `get_route_detail` 以外的工具时，视为新旅程，从 discovery 重推；后台交还 AI 时，恢复接管前的阶段，有已付订单时恢复成 paid。→ `engine.selftest.ts`「第 1 轮应进入 discovery」到「第 4 轮应进入 closing」、「预取的查询同样推进阶段」、「支付后 stage 应为 paid」、「只查了详情，已支付的客户不能被当成新旅程」、E7；eval `flow-05b-unknown-destination-prefetch`；新旅程的正向一半：`engine.selftest.ts`「已支付的会话调了 search_routes，视为新旅程，阶段为 recommend」（00 补）。
10. 出发日期以客户原话为准。「X月Y号」取未来最近的那一次，节假日也取最近的未来那一次；写明了年份，或说的是「这个月」「今年」而日子已经过去的，不滚到明年，视为无效。客户明说的出发日期已经过去时，不建单，也不按任何日期报价；模型替客户改年份或换日期的调用一律退回；不带日期的报价不受客户顺口提的过去日期影响。只说到节假日或月份的，不写进订单。→ `dejargon.selftest.ts`「客户说的出发日期：节假日 / 相对说法 / 返程与经历 / 改口」向量表；`engine.selftest.ts` D1–D9、E12「不带日期的报价不该被过去日期拦下」、R5「模糊日期不进订单、方案书」；eval `guard-08-past-date`、`guard-08b-holiday-date`。
11. 工具参数里的预算和银发以外的客群只认客户原话：模型自己加的剥掉；客户说了的，以客户说的为准；客户改口，以最新一次为准。银发例外：模型传了就保留并记进画像，客户原话里认得出老人时引擎主动补上，任何情况下都不剥，因为它是唯一的硬安全过滤。→ `engine.selftest.ts` G1–G5、G7、G8；G6「模型传的银发要留着」「模型认出的银发记进画像」「「我们老两口想去四川玩」要按银发查」。

前缀：

12. 同一进程、同一份 SOP 文件下，发给模型的第一条 system 消息，在所有轮次、阶段、渠道和 `DEPLOY_PROFILE` 之间逐字节相同；每个带 tools 的请求，tools 字段逐字节相同。每轮会变的状态只放进一条独立的 system 消息，插在历史之后、最新客户消息之前；上一轮的 system 加历史，是下一轮请求的前缀。→ `engine.selftest.ts`「system prompt 在各轮之间必须逐字节不变」「会话状态不能再拼在 system prompt 里」「历史前缀应跨轮稳定」「会话状态应作为 system 消息紧挨在最新客户消息之前」；`llm.selftest.ts`「E11 最后一轮不带 tools / tool_choice」「11 contextNote / prefetch 的线上位置」；tools 和跨 profile 的部分（00 补，见「前缀稳定测试」）：`engine.selftest.ts`「每个请求的第一条 system 消息都要逐字节等于 promptPrefix().system」「每个带 tools 的请求，tools 都要逐字节等于 promptPrefix().tools」「同一轮第 6 次请求不带 tools」「切到 prod 后 promptPrefix() 要与 demo 下完全相同」。
13. 历史窗口：不超过 30 条时原样返回；超过后按 10 条一块推进，长度在 30–39 之间，最新一条永远不丢。system 消息在进窗口之前就滤掉了，不计入。→ `engine.selftest.ts`「未超上限时应原样返回」「短会话应原样返回」「起点应每 10 轮才移动一次」「最新一条永远不能被丢掉」。

转人工与身份：

14. 转人工后，客户发来的消息（文本和非文本）都入库，但不再触发 AI 回复；客户再次进入会话时也不发欢迎语。模型生成期间被顾问接管的那一轮，回复不发出，也不记成已发。例外只有两条：demo 下「重置」口令照样清空会话并解除转人工（prod 下 `reset_command` 关闭，这条例外随之消失）；付款确认（`notifyPaid`）不看是否已转人工（见非目标）。→ `engine.selftest.ts`「已转人工的会话不再走 LLM」「转人工后 AI 不再应答」、E5「生成期间被接管，AI 回复应静默」「AI 回复不能记成已发出」、E6；eval `guard-06-handoff`、`guard-06c-handoff-plain`；非文本与欢迎语的部分（00 新增，「缺陷修复」1、6）：`adapters/wecom.selftest.ts`「已转人工：客户发图片、语音、文件，收不到任何回复」「已转人工的客户再次进入（带 welcome_code）：收不到欢迎语」「已转人工的客户再次进入（老客户补发）：收不到欢迎语」「已转人工的客户再次进入：会话里不多出欢迎语」。
15. 客户明确要人工、投诉或要退款时，引擎直接转人工，不等模型调工具；打消疑虑的提问、身份问题和旅行话题里的「人工」不转。→ `dejargon.selftest.ts`「转人工安全网：投诉要转，打消疑虑的提问不转」的向量表（00 加入「缺陷修复」2 表里的向量，以及句子里的「找人工 / 接人工 / 人工服务」不转）；eval `guard-06b-trust-question`。
16. AI 作答的每一条回复里，只要客户这句在问身份，就承认自己是 AI；走模型的路径、确定性转人工和重发支付链接都一样。已转人工后的静默轮次不作答，由顾问处理。→ eval `guard-04-identity`；`engine.selftest.ts`「改行程转人工时也要回答身份」「价格兜底替换后也要回答身份」；确定性路径的部分（00 新增，「缺陷修复」5）：`engine.selftest.ts`「「你是机器人吧？我要投诉」转人工的回复第一句要承认是 AI」「「你是真人吗？转人工」转人工的回复第一句要承认是 AI」「重发支付链接的回复第一句要承认是 AI」。
17. 输入看起来是注入，而回复离开了旅行话题或夹带了被劫持的输出时，整条回复换成顾问口吻的拒绝。→ `engine.selftest.ts`「注入残留必须整条换掉」；eval `guard-02-injection`。

承诺与画像：

18. 空头承诺不原样发出：回复承诺改行程、重排或定制时，引擎转人工并删掉承诺那一句；承诺发链接却没调工具时，有报过价的线路就补发真链接，否则以问句收尾；回复说「由顾问确认」却没转人工时，后台记一条待确认，不转人工。→ `engine.selftest.ts` E2「跨问号的改行程承诺也要拦」「空头承诺不能原样发出」、E9、E13、W14「「由顾问确认」记进后台」。
19. 画像里的昵称和头像，永远不进任何发给模型的请求：主对话、后台建议、代拟和沉默跟进都是。→ `engine.selftest.ts`「昵称、头像不能进 prompt」；`llm.selftest.ts`「L7 后台建议 / 代拟 / 沉默跟进的画像同样走白名单」。
20. 沉默跟进只发给未转人工、未支付、非种子的企微会话，而且最后一条消息得是 AI 发的；同一阶段只跟一次；先记账再推送，推送途中停机不会重发。→ `llm.selftest.ts`「F1 先记账再推送：推送超过停机宽限期也不会重发，推送失败退账」「F1 停机等进行中的跟进推送与记账完成，不再推下一条」；前面几条边界（00 补）：`llm.selftest.ts`「已转人工的会话不跟进（人工在跟，AI 不插嘴）」「已支付的会话不跟进」「种子演示会话（wecom:cust_*）不跟进」「网页访客会话（sim- / simulator 渠道）不跟进」「最后一条是客户发的不跟进（那是该回复，不是跟进）」「同一阶段只跟一次：第二轮扫描不再推」。

输出：

21. 引擎出口去掉 `**` 加粗、行首「# 」（井号后带空格）的标题和行首的 `-` / `*` 列表符。企微渠道另外去掉不带空格的 `#标题`、斜体、代码围栏、行内代码和当列表符用的 emoji；网页渠道不做这一层，可能留下不带空格的 `#标题`。→ eval `talk-04-no-markdown`（mock 脚本本身不产 markdown，这条断言几乎恒真）；00 补：`engine.selftest.ts`「<渠道>：** 加粗符号不能发给客户」「<渠道>：行首「# 」标题符号不能发给客户」「<渠道>：行首的 - / * 列表符不能发给客户」「<渠道>：只去符号，文字要留着」（网页、企微各一遍）；`adapters/wecom.selftest.ts` 的 `wechatify` 向量表「去 markdown：…」（含 `# 标题` 和 `#标题`）与「去 markdown 不误伤正文：…」。

渠道与存储：

22. 企微消息按 msgid 去重，已处理表随 cursor 一起落盘；正常停机后重启不重复回复。→ `adapters/wecom.selftest.ts`「正常停机后重启不重复回复」「冷启动：跳过的旧消息记为已处理」。
23. 状态文件缺失或损坏时按冷启动处理：不回复启动前很久的消息，不给很久以前扫过码的人补发欢迎语，启动前 10 分钟内的消息照常回复；有 cursor 的正常重启，积压的消息照常回复。→ `adapters/wecom.selftest.ts` W3 各条，如「冷启动（无状态文件）：启动前很久的客户消息不回复」「状态文件损坏按冷启动处理」「有 cursor 时积压的旧消息照常回复」。
24. 同一客户的回复按顺序发出，前一条没发完，后一条不抢先；一个客户卡住，不拖慢别的客户，也不拖慢新客户的欢迎语。→ W2「跨批次不排队：A 的回复卡住时 B 照常收到回复、新客户照常收到欢迎语」「同客户保序：前一条卡住时后一条不抢发」。
25. 优雅停机时，等进行中的回复发完再退出，停机期间到达的消息留给新进程。超时退出后，未完成的消息按原文重放：回复已经生成的，原样重发，不再跑一轮模型；客户消息不重复入库；重放有次数上限。SIGTERM 等停机钩子跑完后，以 143 退出。→ W1「优雅停机：等进行中的回复发完才返回」「停机期间到达的消息不认领（留给新进程）」「回复已生成则原样重发、不再跑一轮 LLM」「重放不重复记客户消息」「重放次数到上限的消息不再重放」「SIGTERM 退出码为 143」。
26. 同一会话的消息串行处理（企微和网页都是），跨会话并发。→ `engine.selftest.ts`「同一会话并发两条消息，第二条的模型请求里要看得到第一条的回复」（00 补）。
27. `POST /api/chat` 只接受 `sim-` 开头的会话 id，带其他前缀返回 400，网页端写不进企微会话。→ `server.selftest.ts`「POST /api/chat 带 wecom: 前缀的会话 id 返回 400」「POST /api/chat 带其他前缀或格式不对的会话 id 返回 400」（00 补）。
28. 访客清理（按闲置时长，以及按总量上限淘汰）只动 `sim-` 开头且 channel 为 simulator 的会话，有已付订单的不删；真实企微会话和种子会话永远不清。清理不归任何开关管。→ `server.selftest.ts`（00 补）「访客清理：闲置的 sim- 网页访客会话被删」「访客清理：有已付订单的访客会话不删」「访客清理：闲置的真实企微会话连同订单都在」「访客清理：闲置的种子会话不删」「访客总量上限：超出一个只淘汰一个（最旧的）」「访客总量上限：有已付订单的访客会话不淘汰（哪怕最旧）」「访客清理（prod）：闲置的 sim- 访客会话照样被清理」。

demo profile：

29. demo 下，「重置」口令在企微和网页都生效：清空消息、画像和订单（包括已付的），解除转人工，阶段回到 greeting。→ `engine.selftest.ts` E6；eval `robust-03-reset`。
30. 种子保鲜只平移 `wecom:cust_*` 会话和它们订单的时间戳：最新一条落在约 5 分钟前，相对间隔不变，其他会话不碰。`DEMO_FRESHEN=0` 或 `seed_freshen` 关闭时不平移。→ `server.selftest.ts`（00 补）「种子保鲜：DEMO_FRESHEN=0 时不平移」「种子保鲜：seed_freshen 关闭时不平移」「种子保鲜：最新一条种子会话落在约 5 分钟前」「种子保鲜：种子会话与消息整体平移，相对间隔不变」「种子保鲜：真实客户、网页访客的会话与订单不动」。

管理面：

31. 不带有效管理凭据时，会话和订单列表只含种子会话（`wecom:cust_*`）和请求者本人的访客会话（`x-sim-session` 请求头里的满熵 id 完全一致才算）。过滤发生在服务端，其他会话连原文都不会进响应体。真实客户的会话不能凭 id 匿名直读。→ `server.selftest.ts`「未带凭据：会话列表只有种子」「访客 B：看得到种子 + 自己，看不到 A」「访客 B 的响应体不含别人的原话」「查询参数带凭据不生效」「旧版短 id 不被列表认作本人」「真实客户会话未登录直读 401」。
32. 管理写操作（`POST /api/sessions/:id/handoff`、`/resume`、`/reply`）：凭据错误或缺失返回 401；服务端没配 `ADMIN_PASS` 返回 503；请求带 `Sec-Fetch-Site` 且不是 `same-origin` / `none` 时返回 403，不带这个头的放行。没有任何环境变量能放行写操作。→ `server.selftest.ts`（00 补）「管理写接口 <操作>：缺凭据 401」「……：凭据错 401」「……：服务端没配 ADMIN_PASS 返回 503」「……：带 sec-fetch-site: cross-site 返回 403（凭据对也拦）」「……：凭据对、不带 sec-fetch-site 头的放行」。
33. 走 LLM 计费的读端点（`GET /api/insights`、`/api/sessions/:id/suggestion`、`/api/sessions/:id/draft`）：凭据错误或缺失返回 401，没配 `ADMIN_PASS` 返回 503；不做同源校验。→ `server.selftest.ts`「AI 洞察未登录 401」，以及（00 补）「LLM 计费读端点 <端点>：缺凭据 401」「……：凭据错 401」「……：服务端没配 ADMIN_PASS 返回 503」「……：不做同源校验（凭据对、带 cross-site 照常 200）」。
34. 后台 SSE、`/api/usage` 和 `/healthz` 里不含会话 id、订单号或客户原文。→ `server.selftest.ts`「SSE 不含会话 id / 订单号 / 原文」「/api/usage 不含会话 id / 原文」「/healthz 不含会话 id / 原文」。

开关与本阶段新增的行为（测试随实现一起加）：

35. demo 下各开关的生效值等于 `DEMO_DEFAULTS`，除非 `FLAG_*` 显式修改。prod 下每个开关的生效值都不比 `PROD_CEILING` 宽，任何环境变量或 `capFlags` 的输入都放宽不了。→ `server.selftest.ts`「profile：什么都不设按 demo，开关取 demo 默认值」「profile：demo 下 FLAG_* 可以单独关掉某个开关」「profile：prod 的默认值就是封顶值（全关）」「profile：prod 下试图打开开关，解析失败（ProfileConfigError）」「capFlags：prod 下任何输入都放宽不了」。
36. prod 下，不带管理凭据的请求不能把订单标成已付，也删不掉企微会话的订单。订单只经 `create_order` 新建，或作废同会话同线路的待付款单；只经带凭据的支付接口标成已付。→ `server.selftest.ts`「mock_pay 关（<配置>）：<匿名 / 凭据错>付款返回 404，订单仍是待支付」「mock_pay 关（<配置>）：带凭据的付款标成已付，并推送一次跟进」；`engine.selftest.ts` E6p「prod 下<渠道>重置不删已付订单」「prod 下<渠道>重置不动订单列表」。
37. `adapterFor` 对任何渠道名都返回一个适配器，从不抛异常；未知渠道的 `push` 返回 false。→ `server.selftest.ts`「未知渠道（9a）：付款接口返回 200，订单变成已付」「未知渠道（9a）：付款时打一条点名渠道和会话的 error」「企微渠道的会话（种子与真实客户）都走企微适配器，不落进未知渠道兜底」。
38. 客户进入企微会话时收到的欢迎语，第一句都写明「AI 旅行顾问」，并写明人工入口；老客户欢迎语不承诺记得之前的对话。→ `adapters/wecom.selftest.ts`「新客户欢迎语：第一句写明「AI 旅行顾问」，正文写明回复「人工」即可转真人顾问」「老客户欢迎语：以「欢迎回来」开头，第一句写明「AI 旅行顾问」，正文写明人工入口」「老客户欢迎语：不承诺记得之前的对话」。
39. 企微的非文本消息在会话里记一条带 msgid 的占位；同一 msgid 只记一次。→ `adapters/wecom.selftest.ts`「已转人工：会话里多出对应的占位，各带原消息的 msgid，其他类型记「[其他消息：类型]」」「连着发两张不同的图片：各记一条占位」「同一条图片消息被启动重放，占位只有一条」「重放按 msgid 判断：占位文本相同的前一张图片不算这张记过」。

## 验收标准

编号带字母的，验收记录按子编号逐条填写。

1. 门禁
   - 1a. 在干净的 clone 上 `pnpm install` 之后，提交一个没格式化的文件，被 pre-commit 拦下。
   - 1b. 提交信息标题 51 个字符，或者带 AI co-author 署名，被 commit-msg 拦下。
   - 1c. 干净的 clone 上四个门禁全绿；任何一个门禁失败时，PR 的 CI 检查为红。
   - 1d. 没有 `.git` 的目录里（镜像构建、`git archive` 解出的目录）`pnpm install` 成功。
   - 1e. 本机 `.env` 里写着 `DEPLOY_PROFILE=prod` 和几个 `FLAG_*` 时，`pnpm test` 的结果与没有 `.env` 时相同。
2. 首次格式化
   - 2a. 首次格式化在 `dev` 上是单独一个提交，只含格式化输出，它的 sha 列在 `.git-blame-ignore-revs` 里。
   - 2b. `git blame --ignore-revs-file .git-blame-ignore-revs` 对被它改过的行，给出的是格式化之前的提交。
   - 2c. 格式化和 lint 修复前后，前缀哈希相同，`pnpm test` 的结果相同。
3. demo（不设 `DEPLOY_PROFILE`，或设为 `demo`）
   - 3a. 现有 selftest 和 eval 的断言原样通过；唯一改动的，是 `engine.selftest.ts` u2b 用例的客户原话（「缺陷修复」2）。
   - 3b. 企微和网页上发「重置」，都会清空会话和订单、解除转人工。
   - 3c. 种子会话和订单的时间戳在保鲜之后平移到最新一条约 5 分钟前；设 `DEMO_FRESHEN=0` 时不动。
   - 3d. 网页模拟器能聊，模拟支付能付，后台匿名只读照旧。
   - 3e. 与改动前相比，客户能看到的变化只有 AI 显式标识和「缺陷修复」1–6。
4. prod
   - 4a. 发「重置」：之前的历史消息全部保留、顺序不变；这一句和一条固定回复追加在后面，没有调模型；订单、阶段、画像和转人工状态都不变。会话已转人工时，没有回复。
   - 4b. 匿名的 `GET /api/sessions`、`/api/orders`、`/api/usage`、`/api/sessions/<种子 id>` 返回 401；打开 `admin.html` 点「登录」并输入凭据后，能看到全部会话。
   - 4c. 匿名的 `POST /api/orders/:id/pay` 返回 404，订单仍是待支付；带管理凭据的同一请求能把订单标成已付，并推送跟进消息。
   - 4d. `POST /api/chat`、`GET /api/stream/:id`、`GET /api/sessions/sim-…`、`/chat.html`、`/guide.html` 返回 404，`/` 跳到 `/admin.html`。
   - 4e. prod 进程启动后，以及手动调用保鲜例程之后，种子会话和订单的时间戳都不变。
   - 4f. 闲置的 `sim-` 访客会话照样被清理。
5. 启动
   - 5a. `DEPLOY_PROFILE=staging`；`DEPLOY_PROFILE=prod` 加 `FLAG_RESET_COMMAND=on`；`DEPLOY_PROFILE=prod` 但没配 `ADMIN_PASS`；`FLAG_AI_DISCLOSURE=on_ask`；`DEMO_FRESHEN=0` 加 `FLAG_SEED_FRESHEN=on`：这五种情况下，进程都以非零退出码退出，日志用一行写明原因，没有未捕获的异常栈。
   - 5b. 正常启动时，日志用一行列出 profile 名和六个开关的生效值。
6. AI 显式标识
   - 6a. 企微新客户进入会话收到的欢迎语，和老客户再次进入收到的欢迎语，第一句都含「AI 旅行顾问」，正文里都写明回复「人工」可转真人顾问；老客户欢迎语不再含「都记得」。
   - 6b. 网页模拟器的开场含「AI 旅行顾问」。
   - 6c. 已转人工的客户再次进入会话，收不到任何消息。
   - 6d. 手动：企微后台的客服账号名含「AI 旅行顾问」。
7. 非文本消息
   - 7a. 已转人工的会话收到图片、语音、文件时，客户收不到任何回复，后台会话里多出对应的 `[图片]` 类占位。
   - 7b. 未转人工时，客户照常收到提示，占位和提示都在会话里；此前没有会话的客户，由此建出一个会话。
   - 7c. 客户连着发两张不同的图片，各记一条占位；同一条消息被启动重放，占位只有一条。
8. 转人工与身份
   - 8a. 「缺陷修复」2 表里的每一句，单独发出后都得到表里期望的结果。
   - 8b. 客户发「你是机器人吧？我要投诉」和「你是真人吗？转人工」：会话都转了人工，回复的第一句承认自己是 AI。
9. 未知渠道
   - 9a. 会话的 channel 是未知值时，`POST /api/orders/:id/pay` 返回 200，订单变成已付，服务端日志里有一条点名这个渠道的 error，会话里记了推送失败的备注，进程没有抛出未捕获异常。
   - 9b. 同样的会话上，`POST /api/sessions/:id/reply` 返回 `ok: false`，会话里记了「未能发送」。
   - 9c. demo 下为种子会话的待付款单付款，会话里不出现推送失败的备注。
10. 前缀
    - 10a. 多轮、两个渠道、两种 profile 下，每个请求的第一条 system 消息，以及每个带 tools 的请求的 tools，都与 `promptPrefix()` 逐字节相同。
    - 10b. 自测输出里有 `PREFIX sha256` 行；00 开始前、格式化和 lint 修复之后、00 结束时三次的值相同，记在 plan 里。
    - 10c. 临时改动 `data/sop.md` 的一个字后再跑，测试仍然通过，只是打印出的哈希变了。
11. 公开边界
    - 11a. 往分支里加入 `.env`、`var/x.json`、`a.pem`、`kf-qr.png`、`src/packs/foo/index.ts`、`tenants/x.json` 或 `eval/real/x.json` 中的任何一个，`pnpm lint` 失败并列出路径；加入 `src/packs/travel/index.ts` 不命中。
    - 11b. 配了内容黑名单时，命中会让 `pnpm lint` 失败，输出里只有「文件:行号」，不出现命中的词。
    - 11c. 在一次性的本地 clone 上造一个含假令牌的提交，用 CI 里钉死的同一版本 gitleaks、同一条命令扫描，退出码非 0；输出记进验收记录。假令牌不推到任何远端。
    - 11d. 全历史扫描的结果记在 plan 里。
    - 11e. 手动：仓库设置里 secret scanning 和 push protection 已开启；另在一个私有测试仓库里推一次假令牌，推送被拒。
12. 部署
    - 12a. `bash deploy.sh` 不带参数、带分支名、带提交号、带不存在的 tag，都会拒绝，服务器上什么都不变。
    - 12b. 服务器 `.env` 里没有 `DEPLOY_PROFILE` 时拒绝部署，旧容器照常运行。
    - 12c. tag 指向的提交有类型错误，而工作区里已经修好时，部署被拒，服务器上什么都不变。
    - 12d. 工作区里未提交的改动不出现在线上。
    - 12e. 部署成功后，`/healthz` 的 `revision` 等于这个 tag。
    - 12f. 在旁路实例上，先后部署 tag A、tag B，再部署一个起不来的版本：健康检查失败后自动回滚，`/healthz` 的 `revision` 回到 B。线上 demo 全程不中断。
13. README
    - 13a. 描述当前状态的用例数、断言数与 `eval/cases.json` 一致。
    - 13b. 本地跑法用四个门禁名，部署一节写的是按 tag 部署。
    - 13c. 「生产化路径」一节指向总参考。
    - 13d. 配好内容黑名单的词表时，`pnpm lint` 对 README 没有命中。
    - 13e. 「接入真实企业微信」一节不再把以销售个人身份托管 1v1 私聊写成生产路径，写明 1v1 只做会话存档 + AI 辅助、由人点发送，全自动接待只走微信客服。
    - 13f. demo 域名只出现在 README「在线体验」一节，README 其他位置和仓库里的其他已跟踪文件都搜不到它。
14. 「不变量」一节里标「本阶段补」和「本阶段新增」的每一条，都已指向一条具体的测试。

## 开放问题

1. **运行时未设 `DEPLOY_PROFILE` 按 demo 处理，生产实例忘了配会有风险（已定，2026-09-26）。** 加上：配了企微凭据（`WECOM_CORP_ID`、`WECOM_APP_SECRET`、`WECOM_KF_OPEN_KFID` 任一）却没设 `DEPLOY_PROFILE`，不论哪种配置模式都拒绝启动（`src/profile.ts` 的 `resolveProfile`，由 `profile-boot` 打出原因后退出）。没配企微凭据时仍按 demo，零配置克隆、自测、eval 不受影响。DB 模式缺 `DEPLOY_PROFILE` 原本就以 `env_invalid` 拒绝启动（01 验收 13）。
2. **README「在线体验」里的线上演示域名（已定，2026-09-25）。** 保留。README「在线体验」一节里的公开 demo 地址是 AGENTS.md 硬规则 5 允许的唯一例外，README 其他位置和仓库里的其他文件都不得出现生产域名。依据：硬规则 5 已把这个地址列为唯一例外；它本来就是对外公开的演示入口，换成占位，README 就没有在线体验入口了。据此，内容黑名单的词表不收 demo 域名，只收其余的生产域名和服务器 IP；demo 域名不出现在别处，由验收 13f 核对。
3. **lint 规则类别。** 00 只开 correctness。suspicious 等类别什么时候开，看 00 验收后各类别在全仓的命中数，01 开工前定。
4. **非文本占位在未转人工时也会进入模型历史**（一条 `[图片]`，加一条提示回复）。mock 回归测不出它对真实模型话术的影响；要不要跑一次真实模型回归，由 owner 在 00 验收时定。

## 被否决的方案

- **静态 golden 常量**（`eval/golden/prefix.json`，prod 再存一份）：`sop.md` 改得很勤，常量会不停失效，大家会养成顺手更新它的习惯，最后它什么也守不住。改为运行时断言「多轮之间不变」，再打印哈希。
- **system prompt 身份那一行改成「自我介绍时说 AI 旅行顾问」**：欢迎语不在会话历史里，模型会在欢迎语之后再介绍一遍自己，每个新会话里 AI 身份说两遍，和「对话中不反复自称」相悖；前缀也会因此变一次，而这一行影响每一段真实对话，只能靠真实模型回归验证。账号名加欢迎语首句已经构成显式标识。
- **00 提供 `ai_disclosure=on_ask`**：身份那一行不变之后，`on_ask` 唯一的作用是换回不带 AI 的企微欢迎语，而企微欢迎语只在接了真实客服账号的实例上发出，也就是正好让公开实例一个环境变量就关掉强制标识。
- **`adapterFor` 遇到未知渠道就 throw**：支付接口在 `markOrderPaid` 之后才调它，抛出会让一个已付款的请求返回 500。
- **prod 下 `/pay` 页直接 404**：预演时整条成交链路都会断在错误页；页面留着，至少还能核对订单信息。
- **prod 保留匿名模拟支付，页面标「测试」**：只要匿名请求能把订单标成已付，prod 的订单数据就不可信，真实客户也可能以为自己已经付过款了。
- **00 就按开关改 prod 的订单确认页、支付卡片和确定性话术**：02 之前 prod 不接真实客户，没人会看到；02 做收款流程时这些措辞还要按真实的收款方式再改一遍。
- **00 就把收款改成「顾问锁价后发收款方式」**：要同时改工具返回、SOP 的 closing 段、引擎兜底和支付卡片，prod 的前缀也会跟着变，这就是 02 收款流程的全部工作量。
- **访客清理跟着 `visitor_simulator` 一起关**：清理本来就是白名单式的，碰不到真实客户；绑在一起的话，demo 临时关掉网页聊天，存量访客会话就再也不清，prod 沿用旧 `var/` 时残留的 `sim-` 会话和订单会一直计入经营数据。
- **运行时未设 `DEPLOY_PROFILE` 默认按 prod**：零配置克隆、六组自测、eval 和现网 demo 会一起变成 prod 行为。改为运行时默认 demo，由部署脚本强制显式配置。
- **prod 下遇到越过封顶的 `FLAG_*` 只警告、然后忽略**：静默忽略会让人以为开关是开着的。启动失败则会被部署时的健康检查拦下并回滚。
- **把内容黑名单词表提交进仓库**：词表本身就是要保护的内容。
- **首次格式化连 `sop.md` 一起格式化**：它的字节就是 system prompt 的一部分。
- **新增第七组 `profile.selftest.ts`**：门禁里的 `test` 是 owner 确认过的「六组 selftest 加 eval」。profile 的断言按行为能被观察到的位置，分进 server、engine、wecom 三组。
- **lint 一次开全部类别，再逐条修**：上千处命中会把 00 拖成一次重构，还很可能改到护栏正则。**反过来先全关、以后再开**：门禁就名存实亡，和占位没有区别。
- **00 就换成 compose 编排**：01 引入 Postgres 时再换。`deploy.sh` 会因此改两遍，这个代价可以接受；现在就定 compose，等于在还没有数据库的时候设计数据库的编排。
