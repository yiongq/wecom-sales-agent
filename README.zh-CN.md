# wecom-sales-agent

[English](README.md) | 简体中文

企业微信里的 AI 销售助手：AI 在微信客服或网页里接待客户，问清需求、按产品库推荐和报价、建单、跟进；价格、订单、链接和转人工由代码决定和核对，模型只负责理解需求、选用工具和组织话术。

同一套引擎按租户隔离，行业逻辑以行业包接入，品牌、话术与产品库走配置。仓库带两个公开参考包：定制游与工业品询价。客户要真人、投诉，或提出系统兑现不了的要求时，AI 转给顾问；顾问在成员工作台接手、沿原渠道回复、审批报价、确认收款。

Node 22 · Hono · TypeScript（`tsx` 直接运行）· PostgreSQL 17 + pgvector · Vite + React 后台 · MIT 许可。

**进度**：阶段 00–10 已 `implemented` 并发版（最新为 `demo-v10`：09 报价审批、10 工业品询价包与演示租户）。路线见 [架构总参考](docs/architecture/master-reference.md)。

## 在线体验

| 入口                                                   | 说明                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**免登录体验**](https://travel.yiongspace.com/try)    | 一键开通一个只属于你的临时租户，示例会话、订单、产品库都是副本，直接进成员工作台。可以用自己的微信扫码当一回客户，也可以在网页模拟器里聊。最长保留 24 小时，闲置 2 小时或主动结束时整租户删除 |
| [登录页 / 成员工作台](https://travel.yiongspace.com/)  | 成员账号登录后处理客户会话：接手、回复、交还 AI、确认价格与收款                                                                                                                               |
| [网页模拟器](https://travel.yiongspace.com/chat.html)  | 扮演客户走一遍问需、推荐、报价、下单与模拟支付；访客的模型调用按日封顶，超出后切到离线脚本                                                                                                    |
| [销售作战室](https://travel.yiongspace.com/admin.html) | 免登录只读：实时看演示种子和同一浏览器里自己刚聊的会话                                                                                                                                        |

以上入口都是定制游演示租户。品牌「云途定制旅行」与 `data/` 下的线路、酒店、价格都是虚构的（见 [data/README.md](data/README.md)）；工业品询价包的产品库也是合成数据。支付为页面模拟，不扣款，不是微信支付。

## 核心设计

1. **租户强制隔离，进程内也一样。** 每张带 `tenant_id` 的表都开 PostgreSQL 行级安全并 FORCE（登录表按 [ADR-001](docs/adr/adr-001-postgres-drizzle.md) 例外），[自测](src/db/db.selftest.ts)从系统目录找表，新表漏开就失败；三个数据库角色都是 `NOBYPASSRLS`（[roles.sql](deploy/db-init/roles.sql)）。进程内 600 多处模块级状态在 [state-manifest.ts](src/tenancy/state-manifest.ts) 逐条登记归属，未登记的过不了 `pnpm lint`；[隔离自测](src/tenancy/sandbox/isolation.selftest.ts)在同一沙箱进程里把租户开到 2 个再删回 0 个，期间交错对话不串数据。
2. **一个部署，按 Host 路由多个租户。** 同一镜像跑两个服务：宿主进程装 standard 租户，有多个时严格按 Host 匹配，每个租户都要有自己的 `public_host`（[hosts.ts](src/tenancy/hosts.ts)）；沙箱进程同时托管多个临时租户，到期整租户删除（[05 spec](docs/architecture/05-tenancy-sandbox/spec.md)）。演示环境里定制游与工业品询价两个演示租户共用一个部署（[10 spec](docs/architecture/10-industrial-rfq-pack/spec.md) R16）。
3. **金额与链接由程序核验。** 报价只由报价工具按产品库与固定规则计算；回复里的金额发出前要追溯到产品库或本会话的工具结果，「叁万捌仟」「38k」、全角数字先归一再核（[money.ts](src/core/parse/money.ts)），追溯不到的发不出去。站内链接按包登记，只放行本会话订单与本轮真正生成的文档，模型编的域名一律剥掉（[site-links.ts](src/core/site-links.ts)、[link-whitelist.ts](src/core/guards/link-whitelist.ts)）。
4. **报价单先审批再外发。** 包可以让自己建的通用单带审批状态。没批准的报价单，链接到不了客户手里，页面不显示金额，任何订单入口都不能确认或标记已付；顾问在工作台批准后系统推送报价单 `/quote/<订单号>`，驳回则作废并转人工（[09 spec](docs/architecture/09-quote-approval/spec.md)）。
5. **行业逻辑在包里，核心不认识具体行业。** 核心代码 import 某个行业包过不了 lint（[check-boundaries.ts](scripts/check-boundaries.ts)）。[定制游包](src/packs/travel)检索线路、报价、出方案书；[工业品询价包](src/packs/industrial)做型号归一、阶梯价与起订量、多行询价、报价单缺省人审（[ADR-005](docs/adr/adr-005-industrial-reference-pack.md)）。两种配置（文件与 PGlite 数据库）各跑 900 条 v2 回归、8742 项断言、快照 0 处差异，旅游的前缀字节不变（[10 plan](docs/architecture/10-industrial-rfq-pack/plan.md)）。
6. **转人工由规则触发，顾问接手优先。** 紧急情况、负面情绪、交互失败三类由规则判定，紧急情况直接回固定话术、不经过模型（[trigger-rules.ts](src/handoff/trigger-rules.ts)）；顾问接手后，进行中那一轮的 AI 回复不再发出，重启重放也不补发（[02 spec](docs/architecture/02-conversations-workbench/spec.md)）。
7. **选型和成本由评测决定。** 模型选型做过三轮评测，每一轮都推翻了原先的判断：摆线路命中率最高、成本低 46% 的候选因 17% 的轮次超过 8 秒没有采用；之后改为引擎预取、减少往返，现用模型复测首轮超 8 秒为 0（[模型选型](docs/guides/model-selection.md)）。前缀缓存让同一套回归的花费从 ¥2.52 降到 ¥0.80，输入缓存命中率 94.2%（[前缀缓存](docs/guides/prefix-cache.md)）。

## 架构

```text
客户触点                                   同一镜像两个服务：APP_ROLE=host | APP_ROLE=sandbox
  微信客服（回调 + sync_msg，轮询兜底）──┐
  网页渠道 /w/<key> ──────────────────────┼─▶ 按 Host 找租户（public_host；沙箱租户在进程内）
  网页模拟器 /chat.html（仅宿主）────────┘            │
                                                      ▼
  engine（核心，不认识具体行业）
    ├─ 引擎预取 ─▶ 模型工具循环 ─▶ 本租户行业包的工具
    │                               ├─ travel：search_routes · search_hotels · get_route_detail
    │                               │          create_quote · generate_proposal · create_order
    │                               └─ industrial：find_parts · quote_items · create_quote_sheet
    ├─ 出口护栏流水线：金额出处 · 站内链接登记 · 形状 · 注入 · 包自己的政策与承诺检查
    ├─ 确定性转人工与固定回复（handoff_to_human 两个包都有）
    └─ 阶段与画像按实际工具调用回推

  客户页（原生 HTML）  /pay/<订单号> · /proposal/…（旅游）· /quote/<订单号>（09）· /privacy
  成员后台 /console/（Vite + React）── console-api ── 接手 · 回复 · 审批报价 · 确认收款 · 改 SOP 与产品库
  演示作战室 /admin.html ── 旧接口（demo 匿名只读）

  PostgreSQL 17 + pgvector（FORCE RLS）
    配置与版本（SOP、产品库、policy、知识库）· 会话与只追加的消息 · 订单与报价单
    channel_inbox（企微入站与 cursor）· jobs（跟进、转人工通知、保留期清理）· turn_traces · guard_events · usage_daily
  文件模式：CONFIG_SOURCE=file 读 data/，SESSION_STORE=file 写 var/（离线冒烟与自测用）
```

钱、订单、链接与转人工都在确定性代码里，模型拿不到改它们的路径。SOP、固定要求与工具定义在同一 SOP 版本内字节不变，逐轮状态单独成一条消息，所以前缀缓存能命中。数据库存储也不等于能多副本：identity map、串行锁与若干限流计数仍在进程内，当前必须单实例运行。细节见 [运行机制与可靠性](docs/guides/how-it-works.md)。

## 目录结构

```text
src/core/        引擎、护栏流水线、金额解析、站内链接、模型客户端（不含行业代码）
src/packs/       行业包：travel/、industrial/ 与注册表
src/tenancy/     租户运行时、按 Host 路由、状态登记、沙箱进程
src/adapters/    渠道接入（企微、网页渠道、模拟器）
src/db/          Drizzle schema、数据访问、RLS 自测
console/         成员后台（Vite + React），挂在 /console/
public/          手写页面：模拟器、网页渠道、支付、方案书、报价单、体验入口、作战室
data/            演示 SOP 与产品库；data/packs/industrial/ 是工业包的合成数据
eval/            回归用例（v1 与 v2）、模拟客户目标、模型横评脚本
deploy/          Compose、数据库初始化、备份、主机巡检、回滚检查；deploy.sh 在根目录
scripts/         lint 与 test 背后的仓库检查、CI 分片、压测、演示数据
docs/            spec 与 plan、ADR、指南（中文）
```

每个 `*.selftest.ts` 放在它覆盖的代码旁边；测试是普通的 tsx 脚本。

## 快速开始

使用 Node 22、pnpm 10（精确版本见 `package.json` 的 `packageManager`）。

```bash
pnpm install
```

离线冒烟：不调真实模型，用文件配置与文件会话存储。

```bash
DEPLOY_PROFILE=demo CONFIG_SOURCE=file SESSION_STORE=file LLM_MOCK=1 pnpm start
```

启动后打开本机 3200 端口的 `/chat.html` 扮演客户，`/admin.html` 看作战室；回复里的 `/pay/<订单号>` 是模拟收银台。接真实模型时复制 `.env.example` 为 `.env` 并填模型凭据；成员后台 `/console/` 要数据库配置与账号，见 [本地跑法与门禁](docs/guides/local-dev.md)。

四个门禁，git hook、CI 和部署都只调这几个名字：

```bash
pnpm format:check   # oxfmt
pnpm lint           # oxlint + 公开边界、模块边界、迁移、后台源码、租户状态登记检查
pnpm typecheck      # 服务端与 console 两份 tsc --noEmit
pnpm test           # 锁定套件、各模块自测、两种配置的 mock 回归、字体与后台构建产物检查
```

`pnpm test` 不需要外部 Postgres，数据库相关自测用 PGlite。真实模型回归另跑 `eval/run.ts`（不设 `LLM_MOCK`），会产生费用，不进 CI。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，给编码 agent 的规则见 [AGENTS.md](AGENTS.md)。

## 文档

运维与机制（中文）：

| 文档                                              | 内容                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [运行机制与可靠性](docs/guides/how-it-works.md)   | 一轮对话怎么跑、护栏、确定性转人工、企微去重与恢复、报价审批 |
| [模型选型与路由](docs/guides/model-selection.md)  | 三轮选型评测、引擎预取、对冲、换供应商                       |
| [成本优化：前缀缓存](docs/guides/prefix-cache.md) | 请求排序、历史窗口按块推进、命中率与计价                     |
| [可观测性与隐私](docs/guides/observability.md)    | trace、运行数字、告警、OTel、保留期                          |
| [本地跑法与门禁](docs/guides/local-dev.md)        | 启动方式、门禁、锁定套件、部署 profile                       |
| [后台、账号与权限](docs/guides/console-access.md) | 作战室与成员工作台的鉴权、角色权限表                         |
| [部署](docs/guides/deployment.md)                 | 按 tag 部署、回滚检查、多租户 Host、切换存储                 |
| [接入真实企业微信](docs/guides/wecom.md)          | 微信客服通道与后台配置顺序                                   |
| [生产化路径](docs/guides/production-path.md)      | 当前实现与多副本等后续边界                                   |

设计与决策（中文）：

| 文档                                                | 内容                                         |
| --------------------------------------------------- | -------------------------------------------- |
| [架构总参考](docs/architecture/master-reference.md) | 定位、已定决策、分阶段路线                   |
| [docs/architecture/](docs/architecture/)            | 各阶段 spec 与 plan（00–10），以 Status 为准 |
| [docs/adr/](docs/adr/)                              | 跨阶段的技术选型                             |
| [规格驱动开发](docs/spec-driven-dev.md)             | spec、plan 与评审流程                        |

## 许可

[MIT](LICENSE)。随仓库分发的第三方内容（字体、图标等）及其许可见 [NOTICE](NOTICE)。市场、定价与客户相关事项另记，不在本仓库。
