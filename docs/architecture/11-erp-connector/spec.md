# 11 · 外部业务系统连接器：Odoo 实时库存（只读）

Status: ready
Revisions: 2026-10-29 起草；依据 10「后续」第 1 条与工业品询价调研（另记）。
Revisions: 2026-10-29 起草期评审（一路 Claude Opus，只读，对照代码并核对 Odoo 文档与源码）之后就地修订，尚无代码依赖；owner 当日定开放问题 1：第一期只读，写回整段移出 11、另起 spec（理由见「非目标」「被否决的方案」）。按评审改：出站防护补上 IP 字面量（Node 遇字面量不调 `lookup`），AGENTS.md 规则原文随之修改；交期不再取 Odoo 的 `sale_delay`（语义不同）；「新鲜值」只有一个定义，工具结果、`priceLine`、自动批准与护栏证据（含跟进）共用；每轮共享一个 ERP 截止时间、预取一次预热、每个连接器一条保活连接，按 10 第 21 步的实测重算时延；API key 到期日必填并提前告警，Odoo 20 只认 scope 为 `rpc` 的 key；不再加 pre-11 回滚档（R11）；头部改为部分取代 10 R4、R6 (2) 与 ADR-003 决策 2；集成脚本进程内注入出站；补齐边界规则、计划依赖、`package.json` 与 `sandbox_tenant_purge`；单路请求加每秒限速、401 与 403 分开、`search_read` 带 `active_test`、地址改白名单式等次要项；砍掉并发池、可调时限与连接器 key。开放问题由 7 条减为 5 条。
Revisions: 2026-10-29 owner 定开放问题 1–5，全部照推荐：只支持 Odoo 19、20 的 JSON-2；客户料号 / 竞品料号对照不放进 11；工业演示租户不接 Odoo，验收在本机一次性容器上做；连接器凭据共用 `CHANNEL_SECRETS_KEY`；这一轮取不到新鲜值时退回产品库的值，同时不自动批准、给顾问留系统消息。
Revisions: 2026-10-29 owner 定 `ready`。同一 docs PR 把 R3、R4 的两条规则原文写进 AGENTS.md，给 ADR-003 与 10 加反向的 `Superseded in part by:`（10 的那一行一并写 R9 的收紧），给 03、04、05、08 加 `Amended by:`，主参考「阶段 8」加一条。
Revisions: 2026-10-31 第 0 步本机实测（Odoo `19.0-20261015`、`20.0-20261015`）之后就地修订，尚无代码依赖；都是事实修正或补细节，不改决定：R6 删去「`read` 遇已删 id 会整批报错」这条不成立的理由（两版实测都只是省略），仍用 `search_read`；R6 补 `check()` 的五次调用，公司取机器人默认公司（原文没说多公司取哪家）；R5 分页固定 `id asc`；R6 错误表之后补「错字段、错参数也可能是 500」；R8 写明保活取决于服务入口（Odoo 内置 HTTP 服务每次都 `Connection: close`）；「安全」写明最小内置组 `stock.group_stock_user` 不是严格只读。跨地区实测仍待 owner 授权。
Phase: 8 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」——阶段 8「按信号再定」；[10](../10-industrial-rfq-pack/spec.md)「后续」第 1 条。
Depends on: [12 · 客户发来的图片与文件](../12-customer-files/spec.md) 已 implemented（R7 要改的工业包文件与 12 重叠）；[09](../09-quote-approval/spec.md)、[10](../10-industrial-rfq-pack/spec.md) 已 implemented；[03](../03-channels-v2/spec.md) R9 的密钥环与加密存库；[05](../05-tenancy-sandbox/spec.md) R5 的租户状态登记与 R12 的沙箱回收。
Supersedes in part: [10](../10-industrial-rfq-pack/spec.md) 的两处，理由都是「接了 ERP 的租户，库存以 ERP 的新鲜值为准」：（1）R4「行属性」里判现货用的「库存」；（2）R6 自动批准条件（2）「每一行在建单这一刻都是库存 ≥ 数量」。新条文见 R7，没有启用连接器的租户仍按原文。[ADR-003](../../adr/adr-003-open-core-boundary.md) 决策 2「不进任何仓库」一格的「凭据：只放服务器上的 env 文件（01 起按 compose 服务拆分），不写进日志」：改为按租户的渠道凭据（03 引入，当时没有在 ADR 落档）与外部业务系统凭据（本 spec）可以加密存库，密钥环只在 env 文件（R3）。10 与 ADR-003 在本 spec 翻 `ready` 时加反向的 `Superseded in part by:` 行。
Amends: 只新增，原有成员与行为不变。[03](../03-channels-v2/spec.md) R9 的密钥环兼管连接器凭据，附加数据另起 `erp_connectors:v1` 一域，轮换多一步 `erp-connector rekey`（R3）；[04](../04-industry-packs/spec.md) 与 [08](../08-pack-generalization/spec.md) 的 `PackRuntime` 加可选声明 `erp`，`PackSources` 加 `erp`（R2）；[05](../05-tenancy-sandbox/spec.md) R5 的进程内状态清单加连接器的租户状态，R12 的 `sandbox_tenant_purge` 删除清单加两张新表（R3、R5）；[10](../10-industrial-rfq-pack/spec.md) R9 的库存与交期护栏：连接器启用时，由 `rfqDraft` 推出的证据只认新鲜值（R7，只收紧）。

**一句话：** 给按租户配置的外部业务系统（ERP）加一个只读连接器，第一家是 Odoo。工业询价时，代码按事先映射好的 Odoo 产品 id 查实时可售量，带每轮截止时间、缓存与冷却，查不到就退回产品库的值；查到的值只经 `priceLine` 与工具结果影响「现货 / 部分现货」的说法。价格、交期、报价单都不变，模型看不到、也碰不到 ERP。为此修订 AGENTS.md 的密钥规则，允许连接器凭据加密存库，并加一道所有连接器出站都必须经过的出站地址防护（SSRF）。

## 背景与问题

- **库存是商家手工维护的。** 10 的 `part` 条目里，`stock` 是产品库字段（`src/packs/industrial/catalog.ts:33`），`priceLine` 据此写「现货 / 现货 N 件，其余约 D 天」（`src/packs/industrial/catalog.ts:72-81`），自动批准的「全部现货」也只读它（`src/packs/industrial/quotes.ts:18-28`），护栏的证据对 `rfqDraft` 行直接按产品库算 `priceLine`（`src/packs/industrial/guards.ts:34-44`）。用 ERP 的商家，库存每天在变，靠后台手改跟不上。
- **把库存同步进产品库代价很高。** 已上架条目的内容每变一次，就写一个新版本、记一行 `catalog.version` 审计，写之前还要拿配置写锁（`src/config/catalog.ts:3-8、128-139`）；`stock` 标了 `reprices`（`src/packs/industrial/console-pack.ts:62`）。按分钟同步库存，会把版本表和审计刷满。
- **没有对租户配置地址的出站。** 现在的出站请求全部打向运维在 env 里配的地址或固定地址：模型网关（`src/llm-gate.ts:302`）、企微接口（`src/adapters/wecom.ts:465、515、621、1040`）、群机器人与告警（`src/notify/notifier.ts:97`、`src/ops/alert.ts:154`）。连接器是第一个由租户配置决定目的地的出站，地址可能指向内网、回环、云厂商元数据，要防 SSRF。
- **密钥规则只给渠道凭据开了例外。** AGENTS.md 规定密钥只放服务器 env 文件，唯一例外是 03 的按租户渠道凭据；ADR-003 决策 2 还写着「凭据：只放服务器上的 env 文件」，03 时没有改。03 的实现：AES-256-GCM、附加数据绑定租户与账号（`src/channels/secrets.ts:97-108、110-147`），密钥环在 env，环境变量名只许出现在一个文件里（`scripts/check-boundaries.ts:289-295`），命令行从权限不宽于 0600 的文件读凭据（`src/cli/channel-account.ts:223-251`），有 `rekey`（`src/cli/channel-account.ts:523-542`）。
- **包只能经 `pack-api` 拿能力。** `src/packs/` 的跨层 import 只能指向 `src/core/pack-api.ts`（`scripts/check-boundaries.ts:129-133`）；包的存储、配置与检索能力由组合根装进 `PackSources`（`src/core/engine/sources.ts:19-42`、`src/core/pack-api.ts:956-962`）。
- **询价回合的时延已经贴着 8 秒线。** 10 第 21 步之后的真实模型复测（本机网络）：引擎预取试算轮 p50 4340、p90 6441、最大 8251 毫秒；建单轮两次模型往返，8.1–8.3 秒（10 plan 实施记录，第 93–94 行）。预取会串行调 `quote_items` 再加至多 5 次 `find_parts`（`src/packs/industrial/turn.ts:139-156`）；12 R10 的确认轮再预取一次 `quote_items`。ERP 的时延必须有硬上限，而且一轮只付一次。
- **为什么先做 Odoo。** 国内工业中小企业用金蝶、用友的更多；Odoo 社区版开源（LGPL-3），能在一次性容器里起完整实例做测试，接口公开。10「后续」已定第一家是 Odoo，本 spec 不重开；接口只做到「以后能加第二家」的程度。
- **Odoo 的外部接口（2026-10-29 核对）：**
  - 19.0 起有 JSON-2 接口：`POST /json/2/<model>/<method>`，请求头 `Authorization: bearer <API key>`，一台服务器多个库且按域名区分不了时加 `X-Odoo-Database`；请求体是 JSON 对象，`ids`、`context` 加方法的具名参数，不支持位置参数；成功 200，出错 4xx/5xx 带 `name`、`message` 等；每次调用一个独立事务（[19.0 文档](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)，20.0 文档同）。
  - `/xmlrpc`、`/xmlrpc/2`、`/jsonrpc` 自 19.0 起弃用：20.0 删掉了 db 服务，common 与 object 服务计划在 Odoo 22（2028 秋）与 Odoo Online 21.1（2027 冬）删除（[20.0 文档](https://www.odoo.com/documentation/20.0/developer/reference/external_api.html)）。18.0 只有 XML-RPC / JSON-RPC（[18.0 文档](https://www.odoo.com/documentation/18.0/developer/reference/external_api.html)）。
  - API key 以所属用户的身份运行，受该用户的访问权限与记录规则约束。18.0 起 key 带到期日：系统管理员能建不过期的，其他用户的期限取所在各组 `api_key_duration` 的最大值（`odoo/addons/base/models/res_users.py` 的 `_check_expiration_date`），19.0 的内部用户组缺省 90 天（`odoo/addons/base/security/base_groups.xml:45`）。19.0 认 scope 为空或为 `rpc` 的 key，20.0 只认 scope 为 `rpc` 的（`res_users.py`，19.0 第 1743 行、20.0 第 1832 行），19 上建的空 scope key 升到 20 会失效。
  - Odoo Online 只有 Custom 方案开放外部接口；它的可接受使用政策把不并发、约每秒 1 次的调用列为通常可接受（odoo.com/acceptable-use，2025-05-07 版）。
  - 官方镜像 `odoo` 的 20.0 标签自 2026-09-26 起发布；17.0 的镜像在 2026-09-08 之后不再更新（Docker Hub 标签列表）。
  - 字段（按 17.0–20.0 源码核对）：`product.product` 有 `default_code`（内部参考，只建索引、不唯一）、`free_qty`、`qty_available`、`uom_id`、`active`、`sale_ok`；按库位查数量用 context 的 `location`（按仓库的键 17.0 是 `warehouse`、18.0 起是 `warehouse_id`）。`sale_delay` 是「从确认订单到交货」承诺给客户的天数，有没有货都适用，缺省 0，与我们「无现货或不足时的交期」`leadDays` 不是一回事。Odoo 标准的 product 模块没有客户料号表，只有供应商价目 `product.supplierinfo`。
- **与 12 的关系。** 12 R8 把识别出的行按 10 的匹配对到产品库，R10 在客户确认那一轮预取 `quote_items`。本 spec 不改匹配与清单；确认那一轮的试算按 R7 预热、用上实时库存。客户料号 / 竞品料号对照仍放后面（开放问题 2）。

## 目标

1. **核心的连接器框架。** 按租户配置、凭据加密存库、所有出站经同一道防护、新鲜值缓存与冷却、每轮截止时间、平台命令行。
2. **Odoo 只读连接器。** 支持 Odoo 19、20 的 JSON-2 接口（开放问题 1）：产品映射、批量读实时可售量。
3. **工业包接上。** 租户有启用的连接器时，三个工具、`priceLine`、自动批准与库存护栏用同一份新鲜值；没有时逐字节照旧。
4. **修订 AGENTS.md** 的密钥规则，加出站防护规则（R3、R4）；ADR-003 加部分取代行。
5. **测试。** CI 用模拟的 Odoo；本机能用一次性 Odoo 社区版容器跑集成，CI 不依赖它。旅游与现有工业用例逐条不变。

## 非目标

- **把报价单写回 ERP**（owner 2026-10-29 定移出 11，另起 spec）。理由：
  - Odoo 自己算税和折扣：不传税时按产品缺省税（19.0 `tax_ids`、18.0 `tax_id`），折扣与改数量后的单价按价目表重算；我们的含税价遇上不含税的 13% 税，合计会是 1.13 倍，只比单价查不出来。
  - 价目表的币种、客户专属价要在 Odoo 侧核对；机器人用户若只在「只看自己的单据」组，按 `origin` 查重会漏，导致重复建单。
  - 只能挂占位客户，顾问在 Odoo 里还要改客户；key 到期、重试用完、重启中断之后的收尾都要另行设计。
- 交期从 ERP 来：`sale_delay` 语义不同（见背景）；补货期（如 `product.supplierinfo.delay`）另写 spec。第一期交期只用产品库的 `leadDays`。
- 价格从 ERP 来：价目表、客户专属价、税、币种都不读；价格仍只由产品库与 `priceLine` 算。
- 把 ERP 的产品主数据同步进产品库（新建条目、改名称、价格或库存字段）。
- 客户料号 / 竞品料号对照（开放问题 2）。
- Odoo 18 及更早版本（开放问题 1）；金蝶、用友等第二家 ERP。
- 后台的连接器设置页、工作台的 ERP 状态卡片：本期只用平台命令行、告警与会话里的系统消息。
- 演示租户接真实 Odoo（开放问题 3）；沙箱租户、文件存储模式下的连接器。
- 把现有出站（模型网关、企微、群机器人）改走新的出站防护：它们的地址来自运维的 env，不是租户输入。

## 前置条件

- 12 已 implemented；09、10 已 implemented。
- owner 定开放问题 1–5（2026-10-29 已定，全部照推荐）；翻 `ready` 的同一个 docs PR：
  - 把 R3、R4 的两条规则原文写进 AGENTS.md；
  - 给 ADR-003 与 10 加反向的 `Superseded in part by:`，给 03、04、05、08 加 `Amended by:`（10 的 R9 一并写进它那一行），主参考「阶段 8」加一条。
- 开工第 0 步落进 plan：
  - 对照本 spec 引用的行号核对现状（12 合入后行号会动）；
  - 在本机一次性 Odoo 19 与 20 容器上实测：JSON-2 的请求、错误与 `Content-Type` 形状；many2one 的返回形状；`product.product/search_read` 带 `context.location` 与 `active_test: false` 读 `free_qty`、`uom_id`、`active`；20 上空 scope 的 key 被拒；机器人用户读产品与库存所需的最小组；读 30 个产品的耗时；
  - 由 owner 授权，从线上服务器所在地区测到一台远端 Odoo（境内另一地区云主机上的一次性容器；Odoo Online 试用库若开放外部接口也测一次）：DNS、TLS 握手、首个请求、保活连接上后续请求的耗时；
  - 实测与本 spec 的假设不符时，停下来修订本 spec（`Revisions:`），再开工。

## 现状与方案

### R1 · 范围与版本

- **第一期只读**：按映射的产品取实时可售量（`free_qty`），叠到产品库的 `stock` 上。不写 ERP，不取交期与价格。
- **版本**：Odoo 19、20 的 JSON-2 接口，社区版与企业版、自建与 Odoo.sh 相同；Odoo Online 只有 Custom 方案可用。API key 必须由专用的低权限机器人用户建，scope 为 `rpc`（20 只认这一种，R3 的命令行与 R12 的集成脚本都照此）。
- **ERP 种类**：枚举只有 `odoo`。第二家 ERP 实现同一个 `ErpConnector` 接口、加枚举值，另写 spec。

### R2 · 代码位置与包边界

```
src/net/egress.ts          出站防护（R4），连接器唯一的网络出口
src/connectors/types.ts    ErpConnector 接口、Availability、错误码
src/connectors/odoo.ts     Odoo JSON-2 客户端：只构造 R5、R6 列出的调用
src/connectors/odoo-mock.ts 模拟 Odoo（回环上的 node:http 服务），只许 *.selftest.ts import
src/connectors/secrets.ts  连接器凭据的封装与解封（调 src/channels/secrets.ts 的通用函数，R3）
src/connectors/registry.ts 按租户装载、新鲜值缓存、冷却、限速、每轮截止时间、给 PackSources 的门面
src/connectors/mapping.ts  产品映射（R5）
src/cli/erp-connector.ts   平台命令行（R9）
```

```ts
// src/connectors/types.ts
export interface Availability {
  onHand: number; // free_qty 向下取整、负数记 0，按映射单位
  at: number; // 从 ERP 取到的时刻（毫秒）
}
export type ErpErrorCode = 'egress' | 'timeout' | 'auth' | 'forbidden' | 'not_found' | 'invalid' | 'server' | 'bad_response' | 'cooldown';
export interface ErpConnector {
  /** 按 id 批量读，至多 30 个；读不到（已删）的 id 不在结果里 */
  stock(ids: readonly number[], deadline: number): Promise<Map<number, { freeQty: number; uomId: number; active: boolean }>>;
  /** 映射用，分页读 default_code 非空、可销售的产品 */
  products(page: { offset: number; limit: number }): Promise<{ id: number; code: string; uomId: number }[]>;
  check(): Promise<{ companyCurrency: string; locationOk: boolean }>;
}
```

**包怎么用。** 包不 import `src/connectors/`，只经 `PackSources.erp`（组合根 `src/core/engine/sources.ts` 装上）：

```ts
// src/core/pack-api.ts（PackSources 新增）
erp: {
  /** 本租户有启用的连接器、且这个产品种类就是包声明的 erp.kind */
  active(kind: string): boolean;
  /** 取实时值：有新鲜值的直接用，其余并进一次请求；受本轮截止时间约束（R6）。只返回取到且映射合格的条目，不抛错 */
  availability(kind: string, codes: readonly string[]): Promise<ReadonlyMap<string, Availability>>;
  /** 同步读新鲜值（R6 的唯一定义）；没有就返回 undefined */
  fresh(kind: string, code: string): Availability | undefined;
};

// src/core/pack-api.ts（PackRuntime 新增可选声明；没有它，连接器对这个包不生效）
erp?: {
  kind: string; // 工业包：'part'
  key(item: Readonly<Record<string, unknown>>): string | null; // 工业包：normalizePartNo(partNo)
  remoteKey(defaultCode: string): string; // 工业包：normalizePartNo
  unit(item: Readonly<Record<string, unknown>>): string; // 工业包：part.unit
};
```

**边界检查**（加进 `scripts/check-boundaries.ts`）：

- `src/connectors/**` 里除 `odoo-mock.ts` 与自测之外，不调 `fetch(`，不 import `node:http`、`node:https`、`node:net`、`node:tls`、`node:dns`；网络只经 `src/net/egress.ts`。
- `src/connectors/odoo-mock.ts` 只许 `*.selftest.ts` import。
- `allowLoopback` 与 `resolver`（`createEgress` 的两个测试参数）只出现在 `src/net/egress.ts`、`*.selftest.ts` 与本机集成脚本 `scripts/odoo-integration.ts`。
- `src/packs/` 本来就只能 import `pack-api`，碰不到连接器与出站防护。

### R3 · 按租户的配置与凭据

**表 `erp_connectors`**（`tenant_id`、FORCE RLS）：

```ts
erp_connectors: {
  tenantId: uuid;
  id: uuid;
  kind: 'odoo';
  status: 'active' | 'disabled'; // 停用代替删除
  baseUrl: string; // 经 R4 规范化的 https 地址；视同标识，不进日志
  database: string | null; // X-Odoo-Database，只许 ^[A-Za-z0-9_.-]{1,63}$
  settings: {
    locationId: number;
    uom: Record<string, number>;
    keyExpiresAt: string;
  } // json：库位、我方单位 → Odoo uom id、key 到期日
  secretsCt: Uint8Array;
  secretsKeyId: string;
  createdAt: Date;
  updatedAt: Date;
}
// 唯一键 (tenant_id)：第一期一个租户一个连接器，日志与命令行按租户称呼
```

**凭据加密。**

- 凭据只有 `{ apiKey }` 一项，JSON 一次加密：AES-256-GCM，12 字节随机 nonce，附加数据 `erp_connectors:v1:<tenant_id>:<连接器 id>`；换到别的行、或拿渠道账号的密文来解，都解不开。
- 共用 03 的密钥环（`CHANNEL_SECRETS_KEY`，开放问题 4）：`src/channels/secrets.ts` 抽出按「附加数据前缀 + 字段校验」的通用 `sealJson` / `openJson`，环境变量名仍只出现在这一个文件；渠道账号的 `sealSecrets` / `openSecrets` 改为它的薄封装，密文格式逐字节不变。
- 解出的值包在 `Redacted` 里，只在 `src/connectors/odoo.ts` 组请求头时 `reveal()`。明文、密文都不进日志、trace、审计 diff、告警、`/healthz`、命令行输出与模型输入。
- 启动装载时解不开（密钥环缺失或不对）：这个连接器按停用处理，告警 `erp` 一次，应用照常启动，工业包退回产品库值。不像渠道那样拒绝启动：连接器不可用时有安全的退路。
- **到期**：`add-odoo` 与 `set-secrets` 必须给 `--key-expires <日期>`（今天之后），存进 `settings.keyExpiresAt`。每天检查一次，到期前 14 天、3 天各告警一次；到期后请求会得到 401（R6）。
- 轮换：照 03 R9，前面加一把新钥，跑 `channel-account rekey` 与 `erp-connector rekey`，再去掉旧钥。

**AGENTS.md 修订**（英文原文，替换「Hard rules」里 Secrets 那一条）：

> - Secrets live only in env files on the server, outside the repo (split per compose service from phase 01 on), and never appear in logs. Two kinds of per-tenant credentials are the exception and may be stored in the database: channel credentials (phase 03) and credentials for external business systems such as an ERP (phase 11). Both are encrypted at rest with AES-256-GCM bound to their tenant and row, with the key ring kept only in an env file; decrypted values stay in memory and never appear in API responses, the console, model input, logs, traces, audit diffs, alerts or command output.

**授权。** `agent_app` 对 `erp_connectors` 只有 SELECT、INSERT 与 `status`、`base_url`、`database`、`settings`、`secrets_ct`、`secrets_key_id`、`updated_at` 的列级 UPDATE，没有 DELETE（命令行与 `channel-account` 一样以 `agent_app` 身份连库，`src/cli/channel-account.ts:598-599`）。命令行拒绝 `kind='sandbox'` 的租户；`sandbox_tenant_purge` 仍把这张表列进删除清单（R11）。

### R4 · 出站防护（SSRF）

`src/net/egress.ts` 导出 `createEgress(opts?)`，返回唯一的请求函数；连接器构造时拿到它，没有别的网络出口（R2）。每个连接器一个实例，内含一条保活连接。

```ts
export interface EgressRequest {
  path: string; // 拼在 baseUrl 之后；连接器只传固定的 /json/2/<model>/<method>
  headers: Record<string, string>;
  body: string;
  deadline: number; // 绝对时刻（毫秒）：从解析到读完响应都要在它之前
  maxBytes: number;
}
export function createEgress(
  baseUrl: string,
  opts?: { allowLoopback?: true; resolver?: Resolver },
): (req: EgressRequest) => Promise<{ status: number; mediaType: string | null; body: Buffer }>;
export function normalizeBaseUrl(raw: string): { ok: true; url: string } | { ok: false; code: EgressCode };
export type EgressCode =
  'scheme' | 'userinfo' | 'port' | 'host' | 'blocked_address' | 'dns' | 'timeout' | 'too_large' | 'redirect' | 'network';
```

| 规则       | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议与形状 | 只认 `https:`（`allowLoopback` 时另认 `http:`，且只连回环）；按 WHATWG URL 解析，不许用户名密码、查询串、片段；`localhost`、`*.localhost` 直接拒                                                                                                                                                                                                                                                                                            |
| 端口       | 443、8443、8069 三个之一，缺省 443                                                                                                                                                                                                                                                                                                                                                                                                          |
| IP 字面量  | WHATWG 归一化之后（`2130706433`、`0x7f.1` 之类都会变成点分写法）主机是 IP 字面量时，发请求前按下面的放行规则校验；Node 遇字面量直接连、不调 `lookup`，所以这一步不能省                                                                                                                                                                                                                                                                      |
| 域名       | 用带超时的 c-ares 解析器（`dns.promises.Resolver`，单次 500 毫秒、不重试；不占 libuv 线程池）在 `https.request` 的 `lookup` 钩子里解析全部 A / AAAA，任何一个不在放行范围就整次拒绝；连接用的就是校验过的地址，防 DNS rebinding                                                                                                                                                                                                             |
| 放行范围   | IPv4：IANA 特殊用途地址表之外的地址，即拒绝 0/8、10/8、100.64/10（含阿里云元数据 100.100.100.200）、127/8、169.254/16（含 169.254.169.254）、172.16/12、192.0.0/24、192.0.2/24、192.88.99/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、224/4、240/4；IPv6：只放 `2000::/3`，再扣掉 `2001::/23`（含 Teredo）、`2001:db8::/32`、`2002::/16`、`3fff::/20`。IPv4 映射、NAT64、站点本地、链路本地、ULA 都在 `2000::/3` 之外，一律拒绝 |
| 重定向     | 不跟随，3xx 按 `redirect` 失败                                                                                                                                                                                                                                                                                                                                                                                                              |
| 证书       | 显式 `rejectUnauthorized: true`、最低 TLS 1.2，没有关闭的开关；不读 `HTTPS_PROXY` 等代理变量                                                                                                                                                                                                                                                                                                                                                |
| 时限与大小 | 每次请求给绝对截止时刻；先看 `Content-Length`，再按读到的字节计，超过 `maxBytes` 当场中断                                                                                                                                                                                                                                                                                                                                                   |
| 保活       | 每个实例一个 `https.Agent`（`keepAlive`、`maxSockets: 1`、空闲 30 秒关闭）；复用的连接在建立时已校验                                                                                                                                                                                                                                                                                                                                        |
| 日志       | 只记错误码、状态码、耗时与租户；不记地址、请求头、请求体、响应体                                                                                                                                                                                                                                                                                                                                                                            |

- 配置时（命令行 `add-odoo` / `set`）先过 `normalizeBaseUrl` 并实际解析一次；运行时每次新建连接再按上表校验。
- `allowLoopback` 与 `resolver` 只供自测与本机集成脚本（R2 的边界检查），应用与命令行永远用严格版本，不设 env 开关：线上跑的是 demo profile，env 开关会被误开。
- **AGENTS.md 加一条**（英文原文，放在 Secrets 那条之后）：

> - Outbound requests to tenant-configured addresses (phase 11 connectors) go only through `src/net/egress.ts`: HTTPS only, every address the connection uses — resolved or literal — checked against an allow-list of public unicast ranges before connecting, no redirects, and fixed deadlines and response size limits.

### R5 · 产品映射

- 新表 `erp_item_links`（`tenant_id`、FORCE RLS）：主键 `(tenant_id, connector_id, kind, code)`，存 `remote_id`、`remote_code`、`remote_uom_id`、`source: 'auto' | 'manual'`、`checked_at`。`agent_app` 有 SELECT、INSERT、UPDATE、DELETE（`map --unset` 要删），写操作记审计 `erp.map`。产品库本身不加字段。
- **自动映射**（命令行 `map --auto`，可 `--dry-run`）：
  - 分页读 Odoo 里 `default_code` 非空、`sale_ok` 为真的 `product.product`，保留默认的归档过滤，按 `id asc` 排序，每页 500，单页时限 15 秒、至多 2 MiB；
  - 包的 `erp.remoteKey(default_code)` 与 `erp.key(item)` 全等才算对上；工业包两边都用 `normalizePartNo`，所以 `6205 2RS` 与 `6205-2RS` 对得上；
  - 恰好一个 → 建链接；没有 → 未映射；多于一个（`default_code` 在 Odoo 不唯一）→ 冲突，不建；
  - 单位必须对上：Odoo 的 `uom_id` 等于 `settings.uom[erp.unit(item)]`，否则单位不符，不建；
  - 只看已上架与草稿的条目；输出各类条数与我方编号清单，不打印 Odoo 的品名。
- **手工映射**：`map --set <编号>=<Odoo 产品 id>`，按 id 指定，免得 `default_code` 重名；同样核对单位。`map --unset <编号>` 删链接。
- **运行时**：只按链接里的整数 id 读 Odoo，从不拿客户或模型给的文字去 Odoo 检索。读到的产品 `active` 为假、`uom_id` 与链接不符、或已被删（结果里没有），这一条按未映射处理，计数进告警。
- 未映射的条目照常报价，库存用产品库的值。

### R6 · 实时可售量、新鲜值与时限

**读法。** 一次请求：`POST /json/2/product.product/search_read`，`domain` 为 `[["id", "in", ids]]`（至多 30 个），`fields` 为 `free_qty`、`uom_id`、`active`，`context` 为 `{ "location": settings.locationId, "active_test": false }`。用 `search_read` 而不是 `read`：按条件取，已删的 id 只是不在结果里，这正是要的语义，不依赖 `read` 对缺失 id 的处理。many2one 只取 id。`free_qty` 必须是有限数，向下取整、负数记 0。

**检查。** `check()` 依次发五次只读调用：`res.users/context_get` 取 `uid`；`res.users/read` 取 `company_id`（机器人的默认公司，多公司时只看这一家）；`res.company/read` 取 `currency_id`；`res.currency/read` 取 `name` 作为 `companyCurrency`，不用 many2one 的展示字符串；`stock.location/search_read` 按 `id` 查库位，命中才算 `locationOk`。只在命令行跑，不走每轮截止时间。

**新鲜值（唯一定义）。** 本进程从 ERP 取到、`at` 距现在不超过 60 秒的值。`PackSources.erp.fresh()` 只按这一条返回；`availability()` 对超过 30 秒的值重新取，所以它交出去的值至少还新鲜 30 秒，够一轮用完。工具结果、`priceLine`、自动批准与护栏证据都只认 `fresh()`（R7）。

**每轮截止时间。** 引擎在每轮开始时开一个 `AsyncLocalStorage` 作用域（`src/core/engine/index.ts` 第 821 行 `prefetch` 之前）。本轮第一次真正向 ERP 发请求时定下截止时刻：发起时刻加 1 秒；本轮之后的请求、包括排队等待，都只等到它为止，到点按「没取到」返回。作用域外（命令行、映射）每次请求用自己的时限。所以一轮花在 ERP 上的时间至多 1 秒，不论慢而成功还是超时。

**单路与限速。** 每个连接器同一时刻只有一个请求在途，相邻两次请求至少隔 1 秒（照 Odoo Online 的可接受使用政策，自建实例同样适用）。排队期间别的回合要的编号并进下一次请求（至多 30 个）；等不到截止时间就放弃。

**错误与冷却。**

| 情况                                                                             | 归类                                             | 冷却    | 告警                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------ | ------- | ------------------------------------------ |
| 先看状态码：2xx 且媒体类型为 `application/json`（忽略 `charset` 等参数）、能解析 | 正常                                             | —       | 失败后恢复时推一次「已恢复」               |
| 401                                                                              | `auth`：key 无效或已到期                         | 10 分钟 | 「API key 无效或已到期，请 `set-secrets`」 |
| 403                                                                              | `forbidden`：机器人用户权限不够                  | 10 分钟 | 「机器人用户缺少读产品或库存的权限」       |
| 404、400、422                                                                    | `not_found` / `invalid`                          | 10 分钟 | 「连接器配置与 Odoo 不符」                 |
| 超时、网络错误、出站防护拒绝、5xx、非 JSON（如代理的 502 页面）                  | `timeout` / `egress` / `server` / `bad_response` | 30 秒   | 从正常转为失败时推一次                     |

错字段、错参数在 Odoo 上常是 500 而不是 422（19、20 实测），一律按状态码归 `server`，不按响应文字猜成配置错误；我们只发固定的调用，这种情况只会在 Odoo 字段变化时出现。

冷却期内 `availability()` 不发请求，直接返回空（`cooldown`）。

### R7 · 工业包怎么用

新文件 `src/packs/industrial/live.ts`：`live(part, a?)` 有新鲜值时返回 `{ ...part, stock: a.onHand }`，没有时原样返回。交期 `leadDays` 一律用产品库的值。以下只在 `sources.erp.active('part')` 为真时生效；为假时（没有连接器、停用、文件存储、沙箱）这些代码路径一行都不走，结果逐字节不变。

- **预取一次预热。** 引擎预取（`src/packs/industrial/turn.ts:125-157`，含 12 R10 的确认轮）在调任何工具之前，把本轮要用的精确编号（客户这句里的精确型号、过期报价单的行、确认清单里已匹配的行，至多 30 个）合成一次 `availability()`；之后的工具调用命中缓存，不再发请求。
- **工具。** `find_parts`、`quote_items`（`src/packs/industrial/tools.ts:45-74、102-153`）匹配之后，对精确命中的条目调 `availability()`（多半已预热），再按 `live(part, fresh())` 算库存标签与 `priceLine`。工具结果的结构与字段不变，变的只是库存的值。
- **建单。** `create_quote_sheet`（`src/packs/industrial/tools.ts:186-207`）建单前调一次 `availability()`；`runtime.priceLine` 包一层 `live(item, fresh(...))`（`src/packs/industrial/runtime.ts:39`），订单行冻结的「交期」与本轮工具结果一致。
- **自动批准**（部分取代 10 R6 (2)）：新条文是「每一行在建单这一刻都有新鲜值，且新鲜值 ≥ 数量」；有一行没有新鲜值就不自动批准，转人审（`src/packs/industrial/quotes.ts:18-28`）。没有连接器时仍按原文读产品库。
- **护栏证据**（`src/packs/industrial/guards.ts:34-44`，主回复与跟进共用）：由 `rfqDraft` 推出的库存证据改为按 `live(part, fresh())` 算；没有新鲜值时，这一行只提供替代型号，不提供库存与交期证据。本轮工具结果仍是证据。效果：后来没调工具的回合、以及跟进，复述「现货」时拿不到新鲜值，主回复换成「库存和交期以顾问确认为准」，跟进删句（`src/packs/industrial/guards.ts:223`）。
- **退回产品库值时告诉顾问。** 本轮有精确型号因为没取到新鲜值而按产品库值回答时，工具在会话里加一条系统消息「ERP 这次没查到 N 个型号的库存，按产品库的库存回答」，同一会话 30 分钟内至多一条。系统消息工作台照常显示，不进模型历史（`src/core/engine/index.ts:771`），不发给客户。
- **不变的。** 型号匹配、`rfqDraft`、确定性回复、预取的判定条件不改。多个候选时「有现货在前」的排序（`src/packs/industrial/match.ts:9`）仍按产品库的库存，只影响列候选的顺序，不是库存说法。
- **ERP 返回的东西进到哪里。** 只有可售量这一个整数，经 `priceLine` 的行属性与工具结果进到对客文字。Odoo 的品名、`default_code` 等字符串不进模型、不进对客文字。

### R8 · 时延预算

| 回合（10 第 21 步实测，本机网络）   | 现在                                  | 接 ERP 后                                                    |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| 预取试算轮                          | p50 4340、p90 6441、最大 8251 毫秒    | 缓存命中 +0；未命中多一次请求，至多 +1 秒（每轮截止时间）    |
| 建单轮（两次模型往返）              | 8.1–8.3 秒，已超 8 秒线（10「后续」） | 编号多半在试算轮预热过；隔了 30 秒以上要再取一次，至多 +1 秒 |
| 12 确认轮（一次预取 `quote_items`） | 照 10 第 21 步                        | 预热一次，至多 +1 秒                                         |

- 目标：同地区、保活连接命中时，ERP 段 p90 ≤ 300 毫秒；任何情况下一轮 ≤ 1 秒。
- 保活取决于服务入口。Odoo 内置 HTTP 服务每次响应都是 `Connection: close`（19、20 实测），连接不复用；R4 只许 HTTPS，真实入口都在 TLS 终结层之后（nginx、Odoo.sh 等），能不能复用看这一层。入口不支持保活时每次请求都要重新建连和握手，p90 目标不成立，只剩 1 秒上限与退路兜底。第 7 步经 nginx 验证复用，跨地区实测记实际复用率。
- 跨地区或到境外托管的 Odoo，第一次 TLS 握手可能就接近 1 秒，这一轮会退回产品库值；保活连接复用之后才快。第 0 步的跨地区实测决定这个目标对远端 Odoo 是否成立，不成立就在 plan「Open」里请 owner 定（例如对远端 Odoo 只在命令行建连接器时提示风险）。

### R9 · 平台命令行

`src/cli/erp-connector.ts`，用法与 `channel-account` 一致（`docker compose run --rm app node --import tsx src/cli/erp-connector.ts …`），写操作记审计 `erp.*`，改完「重启应用生效」：

| 子命令                                                                                                                                     | 作用                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `show --tenant <slug>`                                                                                                                     | 种类、状态、映射条数、key 到期日、最近一次检查结论；不打印地址与凭据                                                      |
| `add-odoo --tenant <slug> --base-url <url> [--database <db>] --location <id> --uom <单位=id,…> --key-expires <日期> --secrets-file <path>` | 建连接器；地址先过 R4；凭据文件规则同 `channel-account`（普通文件、权限不宽于 0600、至多 64 KiB）；建完自动跑一次 `check` |
| `set --tenant <slug> [--status active\|disabled] [--location <id>] [--uom …] [--base-url …] [--database …]`                                | 改设置                                                                                                                    |
| `set-secrets --tenant <slug> --key-expires <日期> --secrets-file <path>`                                                                   | 换 API key                                                                                                                |
| `check --tenant <slug>`                                                                                                                    | 鉴权、公司币种必须是 CNY、库位存在；401 时提示「20 只认 scope 为 rpc 的 key」；只打印结论与错误码                         |
| `map --tenant <slug> (--auto [--dry-run] \| --set <编号>=<id> \| --unset <编号>)`                                                          | R5                                                                                                                        |
| `rekey --tenant <slug>`                                                                                                                    | 用当前密钥重新加密                                                                                                        |

- 拒绝沙箱租户；文件存储模式下整体拒绝。
- 输出与报错不含地址、凭据、Odoo 品名。

### R10 · 可观测性

- 日志：`[erp] <租户> <search_read|products|check> <条数> <毫秒> <ok|错误码>`，不带地址与内容。
- 回合 trace：`PrefetchResult.timings` 与工具耗时里记 ERP 段的毫秒数、是否命中缓存、是否到了截止时间（`src/core/pack-api.ts:253-256`）。
- 告警：`AlertKey`（`src/ops/alert.ts:34-45`）加 `erp`，按 R6 的表在状态变化时各推一次；另有 key 到期前 14 天、3 天，与启动时解不开凭据。只带租户与错误码。

### R11 · 回滚：不加 pre-11 档

- 迁移只增：两张新表；`sandbox_tenant_purge` 在新迁移里 `CREATE OR REPLACE`（`-- migration-allow: create-or-replace` 标注），把两张表加进删除与核对清单——`src/db/sandbox.selftest.ts:338-353` 要求删除清单等于系统目录里每一张带 `tenant_id` 的表。
- 11 之前的镜像读不懂的东西一样都没有：
  - 不改任何已有的表、列、约束与枚举；会话状态、订单、消息、产品库条目的形状都不变（订单行冻结的「交期」还是原来的字符串格式）；
  - 旧镜像不读两张新表，等同于「没有连接器」，按产品库值回答，与 ERP 不可用时的退路相同；
  - 新版 `sandbox_tenant_purge` 只多删两张表、返回的计数多两个键，旧镜像只把计数写进日志（`src/tenancy/sandbox/reaper.ts:182`）。
- 所以退到 11 之前不需要拒绝，`deploy.sh` 与 `deploy/rollback-guard.sh` 不改，也不用新的镜像标记；判档链里 12 的 pre-12 档照旧是最后一档。回滚期间库存回到产品库值；前滚后连接器照常工作，没有要补的东西（只读）。
- 本地一次性容器演练一次「有连接器与映射时退到 12 的 tag 再前滚」，记进 plan。

### R12 · 测试

- **出站防护自测** `src/net/egress.selftest.ts`：放行规则逐段的正反例（含 IPv4 映射、NAT64、6to4、Teredo）；IP 字面量（`127.0.0.1`、`2130706433`、`[::ffff:a00:1]`、`[::1]`）在发请求前被拒；注入的解析器给一公一私时整次拒绝；连接用的是校验过的地址；重定向不跟随；截止时间、超大响应、用户名密码、端口、`http:` 的拒绝；保活连接复用。
- **模拟 Odoo** `src/connectors/odoo-mock.ts`：照公开文档的 JSON-2 形状实现 `search_read` 与 `check` 用到的读取，可注入延迟、超时、401、403、404、500、HTML 502、已删产品、`free_qty` 为负或非数。合成数据，域名用 `erp.example.test`。不抄 Odoo 的代码与文档原文（LGPL-3 的代码只读）。
- **连接器自测** `src/connectors/connectors.selftest.ts`：请求头与请求体逐字段；`database` 字符集；错误归类与冷却；新鲜值 60 / 30 秒的边界；每轮截止时间（慢而成功的请求、排队等待）；单路、合并与每秒限速；映射的三种结果与单位不符；凭据封装往返、换附加数据或换成渠道密文解不开；`Redacted` 打印只有「[已遮盖]」；到期告警的日期。
- **数据库自测**：两张表的 RLS、列级授权、无 DELETE（`erp_connectors`）；`sandbox_tenant_purge` 的覆盖检查。真实 PG 用一次性 `pgvector/pgvector:pg17` 容器。
- **工业包自测** `src/industrial-erp.selftest.ts`（假的 `sources.erp`）：没有连接器时工具结果、订单与护栏输出逐字节不变；有连接器时库存标签、`priceLine`、订单行冻结的交期用新鲜值；预取一轮只发一次请求；过了截止时间退回产品库值并加系统消息；自动批准缺新鲜值转人审；后来的回合与跟进复述「现货」时，主回复被替换、跟进被删句。
- **命令行自测**（子进程）：输出与报错里扫不到地址、API key、密文；拒绝沙箱租户；地址校验；`--key-expires` 必填且须在今天之后。命令行用严格出站，连不上回环，联网的部分由连接器自测与本机集成覆盖。
- **本机集成** `scripts/odoo-integration.ts`，不进 `pnpm test`，CI 不依赖：
  - 起一次性 `postgres` 与 `odoo:19`（再跑一遍 `odoo:20`）容器，装 `sale_management`、`stock`，不装演示数据；用 `odoo shell` 建低权限机器人用户、它的 scope 为 `rpc` 的 API key、合成产品与库存；
  - 脚本在自己进程里用 `createEgress(baseUrl, { allowLoopback: true })` 构造连接器，直接调映射、`stock`、`check` 与门面的 `availability`，不经命令行与应用；记耗时；
  - 外层套超时，结束删容器（AGENTS.md）。镜像约 1.5 GB，初始化约一两分钟，太重，不进 CI。
- **评测**：没有新的 v2 用例，也不跑真实模型闸：SOP、提示词、工具定义都不改，护栏只在连接器启用时收紧，评测与模拟客户里没有连接器。v2 旅游与工业用例逐条不变，四个哈希不变。

### R13 · 不变的东西

- 旅游租户与没声明 `erp` 的包：一行新代码都不走；锁定的 8 个文件、四个哈希、v2 用例不变。
- 工业租户没有启用的连接器时：工具结果、订单、自动批准、护栏逐字节不变。
- SOP、系统前缀、工具定义、固定句不变；没有新工具。交期、价格、报价单、审批流程不变。
- 演示行为（重置、匿名只读、种子保鲜、访客清理）不变；连接器不由 `DEPLOY_PROFILE` 开关控制，没配就不存在。

## 不变量

1. 单价、金额、交期只来自产品库与 `priceLine`；ERP 的值只改「库存」这一个输入。
2. ERP 只有可售量这一个整数会影响对客文字，且只经 `priceLine` 的行属性与工具结果；ERP 的字符串不进模型、不进对客文字。
3. 模型不能指定连接器的地址、方法或参数：没有 ERP 工具；读只按映射表里的整数 id；连接器不写 ERP。
4. 连接器的每一次出站都经过 `src/net/egress.ts`；连接用的每个地址（解析出来的或字面量）都在连接前按放行规则校验过；重定向一律不跟随。
5. 连接器凭据只以密文落库；明文只在进程内存里，不出现在日志、trace、审计、告警、接口响应、命令行输出与模型输入里。
6. 没有启用的连接器时，行为与 11 之前逐字节相同。
7. 一轮花在 ERP 上的时间至多 1 秒；ERP 不可用时询价回合照常完成，按产品库值回答，并给顾问留一条系统消息。
8. 「新鲜值」只有一个定义（R6）；同一轮里工具结果、订单行、自动批准与护栏看到的是同一份。
9. 连接器启用时，自动批准只认新鲜值；缺新鲜值的报价单走人审；没有新鲜值的库存说法不会靠 `rfqDraft` 放行。
10. 每个连接器同一时刻至多一个在途请求，相邻请求至少隔 1 秒。

## 兼容与迁移

- 新迁移（开工时 `dev` 上的下一个编号）：
  - `erp_connectors`、`erp_item_links` 两张表，FORCE RLS，授权见 R3、R5；
  - `sandbox_tenant_purge` 的新版本（R11）。
- 不改 `catalog_items`、`orders`、`messages`、`jobs` 的形状与约束；产品库条目不加字段。
- `AlertKey` 是代码里的集合，不是库约束。
- 上线顺序：先部署不配连接器的版本，确认四个哈希与旅游、工业行为不变；再由 owner 授权，给目标租户 `add-odoo` → `check` → `map --auto` → 重启。
- 回滚见 R11：不拦。

## 安全、隐私与性能

- **SSRF**：R4；配置入口只有平台命令行（运维执行），以后若开放给商家在后台自助配置，同一道防护照用。
- **注入**：Odoo 的检索条件只由整数 id 组成；ERP 返回的字符串不进模型。
- **最小权限**：Odoo 侧用专用机器人用户，只给读产品与库存所需的组；`check` 不需要管理员。实测（19、20）最小内置组是 `stock.group_stock_user`（隐含内部用户），只有内部用户时读 `free_qty` 得 403。这个组对 `stock.quant`、`stock.move` 有读、写、建权限，不是严格只读：我们的客户端只发只读调用，但 key 泄露时风险大于纯只读账号；要凭据本身只读，商家在 Odoo 里自建只读组。key 到期前告警，换 key 用 `set-secrets`。
- **隐私**：只读，不向 ERP 发送任何客户信息；请求里只有产品 id、库位 id 与字段名。
- **许可**：只调用 Odoo 的公开接口；不复制 Odoo 的代码与文档；集成用的官方镜像只在本机下载运行，不进仓库、不随产品分发。
- **性能**：R8；映射在命令行里跑，不在请求路径上。

## 验收标准

1. **不配连接器什么都不变**：旅游与工业的 v2 用例逐条不变，四个哈希不变；工业工具结果、订单与护栏输出逐字节对照 11 之前。
2. **实时库存**：模拟 Odoo 给某型号可售量 7，产品库写 100 件、交期 12 天：客户问 10 件，回复与工具结果都是「现货 7 件，其余约 12 天」；建单后订单行冻结同一交期；30 秒内再问不再请求 Odoo。
3. **新鲜值一致**：建单时 ERP 进了冷却：工具结果、订单行都用产品库值，自动批准阈值内、全现货的报价单转人审，会话里有一条「按产品库的库存回答」的系统消息（30 分钟内不重复）。两分钟后客户没调工具地追问「是现货吧」，主回复的库存说法被换成「库存和交期以顾问确认为准」；同样内容的跟进被删句。
4. **时延**：模拟 Odoo 每次慢 900 毫秒并成功：一轮里第二次需要请求时直接按产品库值返回，ERP 段合计 ≤ 1 秒；挂起时同样 ≤ 1 秒、之后 30 秒内不再等。预取一轮 3 个精确型号、12 确认轮 20 行，各只发一次请求。并发的两个会话在 1 秒内各要不同编号：合并成一次请求，或后到的按截止时间放弃，Odoo 端同一时刻至多一个请求。
5. **错误归类**：401、403、404、500、HTML 502、已删产品各按 R6 的表归类、冷却与告警，401 与 403 的告警文字不同；已删产品不影响同批其他产品。
6. **映射**：`map --auto` 对合成产品给出已映射、未映射、冲突（`default_code` 重复）、单位不符四类，条数与样本真值一致；未映射的型号照常按产品库值报价；`map --set` 按 id 指定后生效。
7. **出站防护**：地址或解析结果是 127.0.0.1、`2130706433`、10.x、169.254.169.254、100.100.100.200、`[::1]`、`[::ffff:a00:1]`、`[64:ff9b::a00:1]`、解析到私网的域名、一次公网一次私网的解析、302 跳到内网、`http://`、带用户名密码、端口 22：命令行配置时拒绝；绕过命令行直接往库里写 IP 字面量或私网域名的，运行时请求也被拒绝；错误码与日志里都没有地址。
8. **凭据与到期**：命令行输出、日志、审计、告警、`/healthz` 与 trace 里扫不到 API key 的明文、密文的 base64 与 hex；渠道账号的密文换到连接器行解不开，反之亦然；`rekey` 前后都能解；`--key-expires` 缺失或已过被拒；到期前 14 天、3 天各告警一次。
9. **本机集成**：`scripts/odoo-integration.ts` 在一次性 Odoo 19 与 20 容器上跑通映射、实时库存与 `check`；20 上空 scope 的 key 得到 401；结束后没有残留容器与进程；耗时与第 0 步的跨地区实测记进 plan。
10. **边界**：在 `src/connectors/` 的非自测文件里加一处 `fetch(`、在非自测文件里 import `odoo-mock.ts`、在应用代码里写 `allowLoopback`、在包里 import 连接器，`pnpm lint` 都失败。
11. **沙箱与回滚**：`sandbox_tenant_purge` 的覆盖检查通过；命令行拒绝沙箱租户。本机一次性容器演练：库里有连接器与映射时退到 12 的 tag，旧镜像照常启动、按产品库值回答；再前滚，连接器照常工作。

## 开放问题

2026-10-29 owner 已定，全部照推荐：

1. **支持哪些 Odoo 版本？**（已定：A，19、20，只用 JSON-2。）
   - A：19、20，只用 JSON-2。
   - B：再加 18，走 `/jsonrpc` 的 `execute_kw`（API key 代替密码），多一套传输、一套鉴权（先 `authenticate` 取 uid）和一个测试容器。
   - 推荐 A：`/jsonrpc` 已弃用，2027–2028 年删除；17 已停止发镜像。真有商家在 18 上，再按 B 补，接口不用改。
2. **客户料号 / 竞品料号对照放 11 第一期吗？**（已定：B，不放，后面单独一份 spec。）
   - A：放进 11，从 ERP 读。
   - B：不放，后面单独一份 spec。
   - 推荐 B：Odoo 标准版没有客户料号表，从 ERP 读不到；对照要按「哪个客户」区分，前提是先有客户身份；数据更可能来自商家的表格或 12 收到的询价单。
3. **工业演示租户接不接 Odoo？**（已定：A，不接，验收在本机一次性容器上做。）
   - A：不接；验收在本机一次性容器上做，线上只确认「不配连接器什么都不变」。
   - B：在线上服务器跑一个 Odoo 社区版容器（自带 Postgres，常驻内存约 0.5–1 GB）给演示租户接上。
   - 推荐 A：只读的 11 对演示的帮助不大；B 要在唯一的生产服务器上多养一套服务和它的备份。有真实商家试点时再定。
4. **连接器凭据用哪把密钥？**（已定：A，共用 `CHANNEL_SECRETS_KEY`。）
   - A：共用 03 的密钥环 `CHANNEL_SECRETS_KEY`，用附加数据区分用途。
   - B：新加一个 env，如 `CONNECTOR_SECRETS_KEY`。
   - 推荐 A：两把钥匙放在同一台服务器的同一个 env 文件里，分开并不增加隔离；一套轮换流程更不容易出错。名字里的「CHANNEL」以后改名时另议。
5. **连接器启用但这一轮取不到新鲜值时，对客户怎么说库存？**（已定：A，退回产品库的值，不自动批准，给顾问留系统消息。）
   - A：退回产品库的值（本 spec 现在的写法），同时这张单不自动批准，并给顾问留系统消息。
   - B：改说「库存和交期以顾问确认为准」，不报具体库存。
   - 推荐 A：与今天没有连接器时的行为一致，回复不因 ERP 抖动而变样；风险是产品库的值过时，所以接了 ERP 的商家应把产品库里的库存写保守（命令行 `add-odoo` 的说明写明），并由不变量 9 兜住自动批准与后续回合的复述。B 要改工具结果，评测随之变动。

## 被否决的方案

- **第一期就写回报价单。** owner 2026-10-29 定移出 11，理由见「非目标」第一条。
- **交期取 Odoo 的 `sale_delay`。** 它是有货时也适用的承诺交付天数，缺省 0，与「缺货交期」不是一回事；照搬会把「约 0 天」说给客户。
- **把库存定时同步进产品库。** 每次变化都会写一个条目版本和一行审计，还要拿配置写锁（`src/config/catalog.ts:128-139`）；实时查加缓存，产品库只当兜底。
- **价格也从 ERP 取。** 价目表、客户专属价、税与币种要另外设计，并会让价格不再由我们的确定性代码决定。
- **给模型一个「查 ERP」工具。** 改系统前缀，模型可能乱调、传任意参数；ERP 的读由代码确定性地做更稳。
- **按客户原话去 Odoo 搜 `default_code`。** 每轮都把外部输入送进 ERP 的检索；`default_code` 不唯一。改为事先映射、运行时只按 id 读。
- **用 XML-RPC 或 `/jsonrpc`。** 已弃用；XML-RPC 还要解析 XML（仓库不引入 XML 解析依赖）。
- **用 `fetch` 再自己先解析一次域名做校验。** 解析与连接之间域名可以换地址（DNS rebinding），`fetch` 也不让指定连接地址。改为 `node:https` 的 `lookup` 钩子加字面量预检。
- **用 env 开关放行私网地址做本机测试。** 线上跑的是 demo profile，开关一旦误开就是 SSRF；改为只在自测与集成脚本里用代码参数放行回环。
- **并发连接池。** Odoo Online 的使用政策要求不并发；有缓存、预热与合并，一轮至多一个请求，单路足够。
- **有启用的连接器就拒绝回滚。** 旧镜像忽略连接器，等同 ERP 不可用时的退路，没有读不懂的数据（R11）。
- **引入现成的 Odoo 客户端包。** 只用到两三个读方法，自己写更好审计；npm 上的包多是 XML-RPC 封装。
- **先接金蝶或用友。** 国内更常见，但没有能放进 CI 的开源实例，接口与授权要和厂商另谈；第一家用 Odoo 把框架、防护与密钥规则立起来，第二家照接口接入（另写 spec）。

## 分批

- **A 地基**：出站防护与边界检查、凭据封装与 AGENTS.md 修订、迁移（含 `sandbox_tenant_purge`）。
- **B 读法**：Odoo 客户端与模拟 Odoo、装载与门面（新鲜值、截止时间、单路限速、冷却）、映射与命令行。
- **C 工业包**：预热、工具、`priceLine`、自动批准、护栏证据、退回时的系统消息。
- **D 验证**：本机集成、回滚演练、验收、上线。

## 后续

- **报价单写回 ERP**（另起 spec）。要先解决：Odoo 自算的税与折扣（显式传 `discount: 0`、按租户配置传税或声明不含税，读回再比 `discount`、`price_total`、`amount_total`）；价目表币种核对；机器人用户的记录规则（要能看到全部销售单，否则按 `origin` 查重会漏）；客户怎么挂（占位客户还是建客户）；重试用完、重启中断之后的收尾与通知；回滚期间漏写的补写。
- ERP 补货期作为缺货交期（如 `product.supplierinfo.delay`）。
- 第二家 ERP（金蝶云星空、用友等），以及 Odoo 18（开放问题 1 的 B）。
- 客户料号 / 竞品料号对照（开放问题 2）。
- 后台的连接器设置页与工作台的 ERP 状态。
- 把群机器人等 env 配置的出站也收进出站防护。
