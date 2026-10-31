# 14 · 用量限制：硬额度、单客户限速与运行中停用

Status: draft
Revisions: 2026-10-31 起草。
Phase: 8 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」——阶段 8「按信号再定」。
Depends on: [05](../05-tenancy-sandbox/spec.md) R15 的预算接口；[02](../02-conversations-workbench/spec.md) 的转人工与静默；[01](../01-pg-config-console/spec.md) 的 `tenants` 表。
Supersedes in part: [01](../01-pg-config-console/spec.md) 启动步骤里的「拒绝 suspended」与启动错误码 `tenant_suspended`：理由是 05 起一个进程装多个 standard 租户，一个租户停用不该让整个进程起不来，新条文见 R6。
Amends: 只新增。[05](../05-tenancy-sandbox/spec.md) R15：standard 租户在软告警之外多一个硬上限；[01](../01-pg-config-console/spec.md) 的 `tenants` 表加两列；`usage_daily.purpose` 加 `reply`。

**一句话：** 给正式租户加三道闸：按月的 AI 回复额度、按日的模型费用熔断、单个客户的发送限速，再让停用在运行中生效。额度用完时 AI 停下、客户收到一句固定话术并转人工；什么都没配置的租户，行为逐字节不变。

## 背景与问题

- **正式租户没有硬上限。** `src/tenancy/budget.ts` 第 1 行写明 standard「只记账、每日软上限只告警」：`reserve()` 永远不返回空。只有沙箱会被拦（`src/llm-gate.ts:249-252`）。租户用多少花多少。
- **企微客户没有限速。** 网页匿名访客有按 IP 限流和单会话上限（`src/budget.ts`、`src/http-guards.ts`），`src/budget.ts` 的注释写明「企微真实客户不受影响」。一个客户不停发消息，每条都走模型。
- **发送账本管不住成本。** 02 的账本限的是出站条数，客户再发一条窗口就重开，入站不受限（`src/quota/ledger.ts`）。
- **停用只在启动时生效。** `tenants.status` 只在装载时读（`src/config/source.ts:866`），运行中改了要重启才生效。
- **一个租户停用会拖垮整个进程。** 同一处直接抛 `tenant_suspended`，而 `loadConfigFromEnv` 逐个装载所有带 `public_host` 的租户（`src/config/source.ts:494-515`），没有按租户隔离失败。01 写这条时一个进程只有一个租户，05 之后这成了缺陷。
- **收款可以线下，用量不能靠人记。** 商业上的收费方式另记；不管怎么收，系统都要能数、能拦。

## 目标

1. 正式租户可配按月 AI 回复额度与按日模型费用上限，超了确定性地拦住。
2. 单个客户的发送频率可限。
3. 停用在运行中生效，不重启；一个租户停用不影响其他租户。
4. 改额度与状态不用重启，用平台命令行。
5. 给 15 的用量页准备一个只读接口。

## 非目标

- 收款、订单、发票、开通自动化：运营设施，按 [ADR-003](../../adr/adr-003-open-core-boundary.md) 不进公开仓库。
- 用量页与设置中心的界面：15 做，本 spec 只出接口。
- 多副本下的跨进程计数：线上单副本，master-reference 已把多副本列为按信号再定。
- 按模型、按 token 的计费口径。
- 租户之间的并发公平分配：第一批一家客户一个实例。
- 把网页匿名访客与沙箱的现有限额并进来：它们已有自己的规则，不动。

## 现状与方案

### R1 · 范围

- 只对 db 配置且 db 会话存储的 `standard` 租户生效。文件模式、沙箱一行新代码都不走。
- **没配置就等于没有这个功能**：`monthly_reply_quota`、`llm_daily_cap_milli` 为 `NULL`，限速的 env 未设，状态不是 `suspended`，这条路径上的输出逐字节不变（不变量 1）。

### R2 · 数据

新迁移（当时 `dev` 上的下一个编号）：

```sql
ALTER TABLE tenants
  ADD COLUMN monthly_reply_quota integer CHECK (monthly_reply_quota >= 0),
  ADD COLUMN llm_daily_cap_milli bigint CHECK (llm_daily_cap_milli >= 0),
  ADD CONSTRAINT tenants_limits_standard_only
    CHECK (kind = 'standard' OR (monthly_reply_quota IS NULL AND llm_daily_cap_milli IS NULL));
```

`NULL` 是不限，`0` 是全拦。`usage_daily_purpose_check` 加 `reply`（`-- migration-allow:` 标注）。

**计数。** 不新建表，AI 回复计入 `usage_daily`：`purpose='reply'`、`model='-'`、`calls` 加 1、token 与费用为 0，走现有的累加与落库（`src/usage.ts`、`src/trace/usage-daily.ts`）。理由：不用把新表加进 `sandbox_tenant_purge`；用量页要的按天曲线顺带有了；崩溃至多丢一次落库间隔的计数，这是成本护栏，不追求精确。

**什么算一条 AI 回复。** 一条落进会话、`author` 为 `ai` 或 `followup` 的消息算 1，分段发送也算 1，确定性回复也算。人工顾问的消息不算；本 spec 的三句固定话术不算。

**周期。** 按服务器时区（线上是上海）的自然月，月初归零，用 `usage_daily` 里本月 `reply` 行的 `calls` 之和加进程内未落库的部分。

### R3 · 运行时状态

新文件 `src/tenancy/limits.ts`，每个 standard 运行时一份状态，登记进 `src/tenancy/state-manifest.ts`：

```ts
export interface TenantLimits {
  status: 'trial' | 'active' | 'suspended';
  monthlyQuota: number | null;
  monthlyUsed: number;
  dailyCapMilli: number | null;
}
export type LimitVerdict = 'ok' | 'quota' | 'suspended';
/** 同步、不读库。引擎、跟进任务都只问这一个函数 */
export function limitVerdict(): LimitVerdict;
export function noteAiReply(): void;
```

- 启动装载读一次，之后每 30 秒读一次 `status` 与两个上限，计时器 `unref`，有关闭钩子。这是命令行改动不用重启的唯一机制（不用 `LISTEN/NOTIFY`，01 已定单副本不用）。
- 轮询失败：保留上一次的值，打日志，不告警第二次，不拦客户。
- 跨月在 `limitVerdict` 里按日期判断。

### R4 · 额度用完

`preflight`（`src/core/engine/index.ts:489`）里，重置口令与转人工静默之后、任何确定性回复与模型之前，判 `limitVerdict()`。顺序保证演示的「重置」和已转人工的静默不受影响。

为 `quota` 时：记下客户消息；`enterHandoff`，原因 `HANDOFF_REASON.quota`（「本月 AI 额度已用完」）；回固定句「您的消息已收到，顾问稍后回复您。」；trace 的 outcome 记 `budget`。之后这个会话按已转人工走，AI 静默，所以固定句每个会话至多一次。

额度告警：用量到 80%、100% 各一次（按租户、按月去重），`AlertKey` 加 `usage_limit`，只带租户与百分比。

跟进任务（`author: followup`）：`limitVerdict()` 不是 `ok` 时不发，任务按跳过结束，不重试。

### R5 · 日费用熔断

`createStandardBudget` 的 `reserve()`：`dailyCapMilli` 非空且「当日已记 + 本次预估」超过它时返回 `null`，`gatedFetch` 抛 `BudgetExhausted`（现有路径）。预占之后实际超一点可以接受。

- `chat`：引擎接住，走 R4 同样的转人工，原因 `HANDOFF_REASON.dailyCap`（「今日 AI 用量已到上限」）。
- 其余用途（`followup`、`vision`、`embedding`、`draft` 等）按它们现有的失败路径退回，不新增分支；实现时逐个核对，没有兜底的记进 plan。
- 告警：`usage_limit`，按租户按日一次，与软告警（05 R15）各走各的。

### R6 · 停用

`status='suspended'` 时：

- **启动**：不再抛 `tenant_suspended`。租户照常装载，运行时标记为停用。企微拉取、回调照常收消息，避免 cursor 积压。
- **运行中**：`limitVerdict()` 30 秒内变成 `suspended`。记下客户消息，每个会话至多回一次固定句「暂时无法在线回复，请稍后再联系。」，不转人工（停用时没有人值守）。跟进不发。
- **登录**：01 的规则不变，停用租户的后台会话一律无效。
- **恢复**：状态改回之后 30 秒内恢复 AI，已转人工的会话不动。
- `trial` 与 `active` 行为相同。

### R7 · 单客户限速

两个 env：`CUSTOMER_RATE_PER_MIN`、`CUSTOMER_RATE_PER_HOUR`，未设或 `0` 不限，默认不限（开放问题 3 定上线时的值）。

- 按会话的滑动窗口，内存计数、有界（超过 10 万个会话淘汰最久未活动的），登记进状态清单。重启清零可以接受。
- 只管 `wecom` 与 `web` 渠道的客户消息。已转人工的会话不计。`simulator` 渠道沿用现有限额。
- 超限：记下客户消息，不进模型，outcome 记 `silent`；同一会话 10 分钟内至多回一次固定句「您发得有点快，我看完一起回复您。」。消息留在历史里，下一次放行的回合能看到，所以不丢。
- 不因超限转人工，免得刷屏的人把顾问也刷了。

### R8 · 平台命令行

扩展 `src/cli/tenant-budget.ts`，写操作记审计，30 秒内生效，不用重启：

| 子命令                                                    | 作用                     |
| --------------------------------------------------------- | ------------------------ |
| `show --tenant <slug>`                                    | 状态、两个上限、本月已用 |
| `quota --tenant <slug> (--replies <n> \| --clear)`        | 设月度额度               |
| `cap --tenant <slug> (--milli <n> \| --clear)`            | 设日费用上限             |
| `status --tenant <slug> --set <active\|trial\|suspended>` | 改状态                   |

现有的 `set`、`clear`（软告警）不变。拒绝沙箱租户。

### R9 · 用量读接口

`GET /api/console/usage`，owner 与 admin 可读，走现有鉴权与租户作用域：

```ts
interface UsageView {
  status: 'trial' | 'active' | 'suspended';
  month: string; // YYYY-MM
  replies: { used: number; quota: number | null };
  daily: { costMilli: number; capMilli: number | null };
  days: { day: string; replies: number; costMilli: number }[]; // 本月逐日
}
```

不含会话内容。匿名只读与沙箱返回 403。

### R10 · 不变的东西

- 系统前缀、SOP、工具定义、四个哈希不变：三句固定话术在模型之外，不进提示词。
- 价格、订单、审批不变。
- 演示行为（重置、匿名只读、种子保鲜、访客清理）不变。
- 网页匿名访客与沙箱的现有限额不变。

### R11 · 回滚

迁移只增，没有新的回滚档：

- 旧镜像不读两个新列，等于「不限」；
- `usage_daily` 多出 `purpose='reply'` 的行，费用为 0。实现时核对旧镜像读这张表的所有路径，并在回滚演练里验证；
- `HANDOFF_REASON` 的新文字是普通字符串，旧镜像照常显示。

## 不变量

1. 没配置上限、没设限速、状态不是 `suspended` 时，行为与 14 之前逐字节相同。
2. 判定是确定性代码，模型不参与，也不能绕过。
3. `limitVerdict()` 同步、不读库，不给回合增加可见时延。
4. 额度用完或熔断时，客户一定收到一句话或已有人工接手，不会既没回复也没人管（停用除外，停用时只回固定句）。
5. 客户消息永远先记下来，任何一道闸都不丢消息。
6. 一个租户的额度、熔断、限速、停用不影响其他租户。
7. 一个租户停用不影响进程启动。
8. 告警里没有客户内容。

## 验收标准

1. **不配不变**：v2 文件与 PGlite 两条全过，快照 0 差异；四个哈希不变；`test:locked` 全绿。
2. **额度**：配 3 条额度，第 3 条 AI 回复之后，第 4 条客户消息收到固定句、会话转人工、顾问收到转人工通知；第 5 条 AI 静默；模型调用次数为 3。
3. **告警**：配 10 条额度，到第 8、10 条各告警一次，同月不重复。
4. **跨月**：用注入时钟跨到下月 1 日，额度归零，已转人工的会话不自动恢复。
5. **熔断**：配日上限，预估超限时不发模型请求，会话转人工；其他用途按现有路径失败，不抛到客户。
6. **限速**：设每分钟 3 条，同一会话 1 分钟内发 5 条，模型只被调 3 次，固定句 1 次，5 条都在历史里；下一分钟放行的回合能看到前面的消息。另一个会话不受影响。
7. **运行中停用**：`status --set suspended` 之后 30 秒内，新消息不进模型、每个会话至多一次固定句、跟进不发；改回 `active` 之后 30 秒内恢复。全程不重启。
8. **启动隔离**：两个 standard 租户，其中一个已停用，进程照常启动，另一个正常服务（真实 PG）。
9. **不用重启改额度**：运行中 `quota --replies` 调大，30 秒内客户恢复 AI 回复（新会话）。
10. **用量接口**：owner 读到本月用量与逐日数据，agent 与匿名 403，响应里没有会话内容。
11. **严格租户模式**：两个租户的计数互不串，`scope_missing=0`。
12. **回滚**：真镜像演练，库里有 `reply` 行与上限时退到上一个 tag，旧镜像照常启动、照常回答；再前滚，计数接得上。

## 开放问题

1. **额度用完怎么办？**
   - A：固定话术 + 转人工（本 spec 现在的写法）。客户有人接，顾问多一点活。
   - B：只回固定话术，不转人工。顾问没负担，但客户可能没人管。
   - 推荐 A：销售场景漏一个客户比多一次转人工贵。改起来容易，一个分支。
2. **额度按什么数？**（13 里 owner 定过按 AI 回复条数，这里沿用。）
   - A：AI 回复条数。客户好理解，单条成本波动由 R5 的日熔断兜住。
   - B：模型费用。精确，但客户算不清。
   - 推荐 A。
3. **限速默认值？** 上线时写进 `.env`，不进代码。
   - 推荐每分钟 12 条、每小时 120 条：正常人一分钟打不了十几条，微信连发几条不会被误伤。线上跑一周后按 `silent` 的量再调。
4. **演示租户配不配额度？**
   - 推荐配：演示链接公开，配一个宽松的日费用上限当保险丝，数值另记，由 owner 定。不配也不影响代码。
5. **停用时后台能不能看？**
   - A：不能（01 现状，本 spec 不改）。
   - B：只读。租户到期后还能导出数据，要改 01 的鉴权规则。
   - 推荐 A：第一批一家客户一个实例，要导出时运维用现有导出命令。

## 被否决的方案

- **用 `messages` 表现数。** 不用加写入路径，但表上没有按时间的索引，保留期可能在月中删掉旧消息，算出来会偏小。
- **新建 `usage_monthly` 表。** 要进 `sandbox_tenant_purge` 的删除清单，还多一条写入路径；`usage_daily` 已经够用。
- **额度用完直接报错或不回。** 客户在微信里看到的就是对方失联。
- **Redis 计数。** 单副本用不上，master-reference 已定多副本时再评估。
- **命令行改完重启生效。** 05 之后重启要停所有租户约 20 秒，加额度这种日常操作不该停服。
- **`LISTEN/NOTIFY` 推送变更。** 01 已定单副本不用，30 秒轮询够用。
- **限速写进租户配置。** 第一批一家一个实例，env 够用；真要分租户再加列。

## 分批

- **A 数据与状态**：迁移、计数、`limits.ts`、轮询、启动隔离。
- **B 闸门**：额度、熔断、停用、限速接进引擎与跟进。
- **C 出口**：命令行、读接口、告警。
- **D 验证**：回滚演练、验收。随 11 一起上线。

## 后续

- 15 的用量页与设置中心。
- 13 的试用与收款（运营设施部分进私有仓库）。
- 超额包、自动加额度。
