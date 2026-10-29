# 11 · 外部业务系统连接器：Odoo 实时库存与报价单写回

Status: draft
Revisions: 2026-10-29 起草；依据 10「后续」第 1 条与工业品询价调研（另记）。
Phase: 8 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」——阶段 8「按信号再定」；[10](../10-industrial-rfq-pack/spec.md)「后续」第 1 条。
Depends on: [12 · 客户发来的图片与文件](../12-customer-files/spec.md) 已 implemented（11 要改的工业包文件与 12 重叠，12 做完再开工）；[09](../09-quote-approval/spec.md)、[10](../10-industrial-rfq-pack/spec.md) 已 implemented；[03](../03-channels-v2/spec.md) R9 的密钥环与加密存库；[05](../05-tenancy-sandbox/spec.md) R5 的租户状态登记与沙箱；[02](../02-conversations-workbench/spec.md) 的任务表。
Amends: 只新增，原有成员与行为不变。[02](../02-conversations-workbench/spec.md) 的任务表加 `erp_quote_push` 一类与独立认领道，`handoff_notify` 的原因加 `erp_push_failed`（R8）；[03](../03-channels-v2/spec.md) R9 的密钥环兼管连接器凭据，附加数据另起 `erp_connectors:v1` 一域，轮换多一步 `erp-connector rekey`（R3）；[04](../04-industry-packs/spec.md) 与 [08](../08-pack-generalization/spec.md) 的 `PackRuntime` 加可选声明 `erp`，`PackSources` 加 `erp`（R2）；[09](../09-quote-approval/spec.md) 报价单变为已批准时（工作台批准与自动批准），租户开了写回就随同一次提交排写回任务（R8）；[10](../10-industrial-rfq-pack/spec.md) R4–R6：租户有启用的连接器时，库存与交期取 ERP 实时值，自动批准的「全部现货」只认 ERP 的新鲜值（R6）；[05](../05-tenancy-sandbox/spec.md) R5 的进程内状态清单加连接器三项，沙箱租户不能配连接器（R3）。

**一句话：** 给按租户配置的外部业务系统（ERP）加一个连接器，第一家是 Odoo。工业询价时，库存与交期由代码按映射好的 Odoo 产品实时查询，带超时、缓存与熔断，查不到就退回产品库的值；报价单经人工批准（或商家显式开启的自动批准）之后，由后台任务把它写成 Odoo 里的一张草稿报价单，失败时告诉顾问。价格始终只由产品库与 `priceLine` 算；模型看不到、也碰不到 ERP。为此修订 AGENTS.md 的密钥规则，允许连接器凭据加密存库，并加一道所有连接器出站都必须经过的出站地址防护（SSRF）。

## 背景与问题

- **库存与交期是商家手工维护的。** 10 的 `part` 条目里，`stock`、`leadDays` 是产品库字段（`src/packs/industrial/catalog.ts:33-34`），`priceLine` 据此写「现货 / 约 D 天」（`src/packs/industrial/catalog.ts:72-81`），自动批准的「全部现货」也只读它（`src/packs/industrial/quotes.ts:18-28`）。用 ERP 的商家，这两个数每天在变，靠后台手改跟不上。
- **把库存同步进产品库代价很高。** 已上架条目的内容每变一次，就写一个新版本、记一行 `catalog.version` 审计，写之前还要拿配置写锁（`src/config/catalog.ts:3-8、128-139`）；`stock`、`leadDays` 都标了 `reprices`（`src/packs/industrial/console-pack.ts:62-63`）。按分钟同步库存，会把版本表和审计刷满。
- **批准的报价单只在本系统里。** 批准（`src/payment/orders.ts:120-148`）与自动批准（`src/core/order-view.ts:203-207`）之后，顾问要在 ERP 里再录一遍。业内的顺序是：抽取 → 对照 ERP 主数据校验 → 标出低置信的行 → 销售批准 → 写回 ERP（调研另记）。10、12 已经做到第四步。
- **没有对租户配置地址的出站。** 现在的出站请求全部打向运维在 env 里配的地址或固定地址：模型网关（`src/llm-gate.ts:268`）、企微接口（`src/adapters/wecom.ts:465、515、621、1040`）、群机器人与告警（`src/notify/notifier.ts:97`、`src/ops/alert.ts:154`）。连接器是第一个由租户配置决定目的地的出站，需要防 SSRF：地址可能指向内网、回环、云厂商元数据。
- **密钥规则只给渠道凭据开了例外。** AGENTS.md 规定密钥只放服务器 env 文件，唯一例外是 03 的按租户渠道凭据。03 的实现：AES-256-GCM、附加数据绑定租户与账号（`src/channels/secrets.ts:97-108、110-147`），密钥环在 env，环境变量名只许出现在一个文件里（`scripts/check-boundaries.ts:289-295`），命令行从权限不宽于 0600 的文件读凭据（`src/cli/channel-account.ts:223-251`），有 `rekey`（`src/cli/channel-account.ts:523-542`）。ERP 的 API key 按租户不同，放 env 就要每接一家改 env、重建容器。
- **包只能经 `pack-api` 拿能力。** `src/packs/` 的跨层 import 只能指向 `src/core/pack-api.ts`（`scripts/check-boundaries.ts:129-133`）；包的存储、配置与检索能力由组合根装进 `PackSources`（`src/core/engine/sources.ts:19-42`、`src/core/pack-api.ts:956-962`）。
- **为什么先做 Odoo。** 国内工业中小企业用金蝶、用友的更多；Odoo 社区版开源（LGPL-3），能在一次性容器里起完整实例做测试，接口公开。10「后续」已定第一家是 Odoo，本 spec 不重开这个决定；接口只做到「以后能加第二家」的程度，不为金蝶、用友做细节设计。
- **Odoo 的外部接口（2026-10-29 核对）：**
  - 19.0 起有 JSON-2 接口：`POST /json/2/<model>/<method>`，请求头 `Authorization: bearer <API key>`，一台服务器多个库且按域名区分不了时加 `X-Odoo-Database`；请求体是 JSON 对象，`ids`、`context` 加方法的具名参数，不支持位置参数；成功 200，出错 4xx/5xx 带 `name`、`message` 等；每次调用是一个独立事务，成功提交、出错回滚，多次调用串不进同一事务（[19.0 文档](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)，20.0 文档同）。
  - `/xmlrpc`、`/xmlrpc/2`、`/jsonrpc` 自 19.0 起弃用：20.0 已删掉 db 服务，common 与 object 服务计划在 Odoo 22（2028 秋）与 Odoo Online 21.1（2027 冬）删除（[20.0 文档](https://www.odoo.com/documentation/20.0/developer/reference/external_api.html)）。18.0 只有 XML-RPC / JSON-RPC，API key 代替密码使用（[18.0 文档](https://www.odoo.com/documentation/18.0/developer/reference/external_api.html)）。
  - API key 以所属用户的身份运行，受该用户的访问权限与记录规则约束；文档建议集成用专用的低权限机器人用户。18.0 起 key 带到期日：系统管理员能建不过期的，其他用户受所在组的 `api_key_duration` 限制（`odoo/addons/base/models/res_users.py` 的 `_check_expiration_date`，18.0、19.0 源码）。
  - Odoo Online 上只有 Custom 方案开放外部接口；One App Free 与 Standard 方案不开放。
  - 官方镜像 `odoo` 的 20.0 标签自 2026-09-26 起发布；17.0 的镜像在 2026-09-08 之后不再更新（Docker Hub 标签列表）。
  - 字段（按 17.0–20.0 源码核对）：`product.product` 有 `default_code`（内部参考，只建索引、不唯一）、`free_qty`、`qty_available`、`uom_id`、`active`、`sale_ok`；客户交期 `sale_delay` 是 `product.template` 上的整数天，20.0 从 stock 模块挪到了 sale 模块，模型与字段名不变；按库位查数量用 context 的 `location`，按仓库的 context 键 17.0 是 `warehouse`、18.0 起是 `warehouse_id`；`sale.order.line` 的单位字段 18.0 叫 `product_uom`，19.0 起改名 `product_uom_id`；`sale.order` 有 `origin`（源单据）、`client_order_ref`（客户参考号）、`state='draft'` 即「报价单」。Odoo 标准的 product 模块没有客户料号表，只有供应商价目 `product.supplierinfo`。
- **与 12 的关系。** 12 R8 把识别出的行按 10 的匹配对到产品库，R10 在客户确认那一轮预取 `quote_items`。本 spec 不改匹配与清单；确认后的试算自动用上实时库存（R6）。客户料号 / 竞品料号对照仍放后面（开放问题 4）。

## 目标

1. **核心的连接器框架。** 按租户配置、凭据加密存库、所有出站经同一道防护、进程内缓存与熔断、平台命令行。
2. **Odoo 连接器。** 支持 Odoo 19、20 的 JSON-2 接口（开放问题 3）：产品映射、批量读实时可售量与客户交期、写草稿报价单并核对。
3. **工业包接上。** 租户有启用的连接器时，`find_parts`、`quote_items`、`create_quote_sheet` 与自动批准用实时库存与交期；没有时逐字节照旧。
4. **写回。** 报价单批准之后排任务写成 Odoo 草稿报价；幂等、可重试；失败或核对不一致时，顾问在会话里看到一条系统消息并收到通知。
5. **修订 AGENTS.md** 的密钥规则，加出站防护规则（R3、R4）。
6. **测试。** CI 用模拟的 Odoo；本机能用一次性 Odoo 社区版容器跑集成，CI 不依赖它。旅游与现有工业用例逐条不变。

## 非目标

- 价格从 ERP 来：价目表、客户专属价、税、币种都不读；价格仍只由产品库与 `priceLine` 算（R7）。
- 把 ERP 的产品主数据同步进产品库（新建条目、改名称或价格）。
- 写回之外的 ERP 写操作：确认订单、建客户、建发货、改库存；报价单撤回、过期后同步 ERP 状态。
- 客户料号 / 竞品料号对照（开放问题 4）。
- Odoo 18 及更早版本（开放问题 3）；金蝶、用友等第二家 ERP。
- 后台的连接器设置页、工作台的 ERP 状态卡片与「重试写回」按钮：本期只用平台命令行与会话里的系统消息。
- 演示租户接真实 Odoo（开放问题 5）；沙箱租户、文件存储模式下的连接器。
- 把现有出站（模型网关、企微、群机器人）改走新的出站防护：它们的地址来自运维的 env，不是租户输入。

## 前置条件

- 12 已 implemented；09、10 已 implemented。
- owner 定开放问题 1–7；翻 `ready` 的同一个 docs PR 把 R3、R4 的规则文字写进 AGENTS.md，并给 02、03、04、05、08、09、10 加 `Amended by:`，主参考「阶段 8」加一条。
- 开工第 0 步落进 plan：
  - 对照本 spec 引用的行号核对现状（12 合入后行号会动）；
  - 在本机一次性 Odoo 19 与 20 容器上实测：JSON-2 的请求与错误形状、many2one 的返回形状、`free_qty` 按 `location` 的读取、`sale.order` 带 `price_unit` 创建后是否原样保留、`origin` 检索、机器人用户的最小权限组合、读 30 个产品与建一张 30 行报价单的耗时；
  - 实测与本 spec 的假设不符时，停下来修订本 spec（`Revisions:`），再开工。

## 现状与方案

### R1 · 范围与版本

- **第一期做两件事（开放问题 1）：**
  - 读：按映射的产品，实时取可售量与客户交期，叠到产品库的值上；
  - 写：报价单批准之后，写成 Odoo 的一张草稿报价单（`sale.order`，`state='draft'`）。写回按租户开关，缺省关。
- **版本：** Odoo 19、20 的 JSON-2 接口，社区版与企业版、自建与 Odoo.sh 相同；Odoo Online 只有 Custom 方案可用。只读写下面列出的字段，避开 18 → 19 改过名的 `product_uom` / `product_uom_id`（写回不传单位，R8）。
- **ERP 种类：** 枚举只有 `odoo`。第二家 ERP 实现同一个 `ErpConnector` 接口（R2）、加枚举值，另写 spec。

### R2 · 代码位置与包边界

```
src/net/egress.ts          出站防护（R4）。连接器唯一的网络出口
src/connectors/types.ts    ErpConnector 接口、Availability、错误码
src/connectors/odoo.ts     Odoo JSON-2 客户端：只构造 R5、R6、R8 列出的调用
src/connectors/secrets.ts  连接器凭据的封装与解封（调 src/channels/secrets.ts 的通用函数，R3）
src/connectors/registry.ts 按租户装载、缓存、熔断、给 PackSources 的门面；pre-11 镜像标记（R12）
src/connectors/mapping.ts  产品映射（R5）
src/connectors/push.ts     写回任务的执行体（R8）
src/cli/erp-connector.ts   平台命令行（R9）
```

```ts
// src/connectors/types.ts
export interface Availability {
  onHand: number; // 可售量：Odoo free_qty 取整、负数记 0，按映射单位
  leadDays: number | null; // 客户交期（天）；租户设置为 catalog、或 ERP 值为 0 时为 null
  at: number; // 取到的时间（毫秒）
}
export type ErpErrorCode =
  | 'egress'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'server'
  | 'bad_response'
  | 'unmapped'
  | 'uom_mismatch'
  | 'duplicate'
  | 'cooldown'
  | 'busy';
export interface ErpConnector {
  availability(
    remoteIds: readonly number[],
    signal: AbortSignal,
  ): Promise<Map<number, { freeQty: number; saleDelay: number; uomId: number; active: boolean }>>;
  products(page: { offset: number; limit: number }): Promise<{ id: number; code: string; uomId: number }[]>; // 映射用（R5）
  findQuote(origin: string): Promise<{ id: number; name: string; state: string }[]>;
  createQuote(input: {
    partnerId: number;
    origin: string;
    lines: { productId: number; qty: number; priceUnit: number }[];
  }): Promise<number>;
  readQuote(id: number): Promise<{ name: string; lines: { productId: number; qty: number; priceUnit: number }[] }>;
  check(): Promise<{ companyCurrency: string; locationOk: boolean; partnerOk: boolean | null }>;
}
```

**包怎么用。** 包不 import `src/connectors/`，只经 `PackSources.erp`（组合根 `src/core/engine/sources.ts` 装上）：

```ts
// src/core/pack-api.ts（PackSources 新增）
erp: {
  /** 本租户有启用的连接器、且这个产品种类在包的 erp.kinds 里 */
  active(kind: string): boolean;
  /** 批量取实时值。只返回取到且映射合格的条目；超时、冷却、未映射的不在结果里，由包退回产品库值。不抛错 */
  availability(kind: string, codes: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, Availability>>;
  /** 同步读本进程缓存：priceLine 与自动批准用；没有或超过 10 分钟返回 undefined */
  peek(kind: string, code: string): Availability | undefined;
};

// src/core/pack-api.ts（PackRuntime 新增可选声明；没有它，连接器对这个包不生效）
erp?: {
  kinds: readonly string[];                                          // 工业包：['part']
  matchKey(item: Readonly<Record<string, unknown>>): string | null;  // 工业包：normalizePartNo(partNo)
  remoteKey(defaultCode: string): string;                             // 工业包：normalizePartNo
  unitOf(item: Readonly<Record<string, unknown>>): string;            // 工业包：part.unit
};
```

**边界检查**（加进 `scripts/check-boundaries.ts`）：

- `src/connectors/**`（自测除外）不调 `fetch(`，不 import `node:http`、`node:https`、`node:net`、`node:tls`、`node:dns`；网络只经 `src/net/egress.ts`。
- `allowLoopback` 只出现在 `*.selftest.ts` 与本机集成脚本 `scripts/odoo-integration.ts`。
- `src/packs/` 本来就只能 import `pack-api`，碰不到连接器与出站防护。

### R3 · 按租户的配置与凭据

**表 `erp_connectors`**（`tenant_id`、FORCE RLS）：

```ts
erp_connectors: {
  tenantId: uuid;
  id: uuid;
  key: string; // ^[a-z][a-z0-9-]{1,30}$，日志与命令行用
  kind: 'odoo';
  status: 'active' | 'disabled'; // 停用代替删除
  baseUrl: string; // 经 R4 规范化的 https 地址；视同标识，不进日志
  database: string | null; // X-Odoo-Database
  settings: OdooSettings; // json
  secretsCt: Uint8Array;
  secretsKeyId: string;
  createdAt: Date;
  updatedAt: Date;
}
// 唯一键 (tenant_id)：第一期一个租户一个连接器
interface OdooSettings {
  locationId: number; // 查可售量的库位（stock.location），经 context.location 传
  uom: Record<string, number>; // 我方单位 → Odoo uom.uom 的 id，如 { "件": 1 }
  leadTime: 'catalog' | 'odoo'; // 缺省 catalog；odoo 时取 sale_delay，值为 0 的条目仍用产品库
  writeback: boolean; // 缺省 false（R8）
  partnerId: number | null; // 写回用的占位客户（开放问题 2）；writeback 为 true 时必填
  turnTimeoutMs: number; // 回合内查询的时限，缺省 1500，上限 2500
}
```

**凭据加密。**

- 凭据只有 `{ apiKey }` 一项，JSON 一次加密：AES-256-GCM，12 字节随机 nonce，附加数据 `erp_connectors:v1:<tenant_id>:<连接器 id>`；换到别的行、或拿渠道账号的密文来解，都解不开。
- 共用 03 的密钥环（`CHANNEL_SECRETS_KEY`，开放问题 6）：`src/channels/secrets.ts` 抽出按「附加数据前缀 + 字段校验」的通用 `sealJson` / `openJson`，环境变量名仍只出现在这一个文件；渠道账号的 `sealSecrets` / `openSecrets` 改为它的薄封装，密文格式逐字节不变（03 的自测照跑）。
- 解出的值包在 `Redacted` 里，只在 `src/connectors/odoo.ts` 组请求头时 `reveal()`。明文、密文都不进日志、trace、审计 diff、告警、`/healthz`、命令行输出与模型输入。
- 启动装载时解不开（密钥环缺失或不对）：这个连接器按停用处理，告警 `erp` 一次，应用照常启动，工业包退回产品库值。不像渠道那样拒绝启动：连接器不可用时有安全的退路。
- 轮换：照 03 R9，前面加一把新钥，跑 `channel-account rekey` 与 `erp-connector rekey`，再去掉旧钥。

**AGENTS.md 修订**（英文原文，替换「Hard rules」里 Secrets 那一条）：

> - Secrets live only in env files on the server, outside the repo (split per compose service from phase 01 on), and never appear in logs. Two kinds of per-tenant credentials are the exception and may be stored in the database: channel credentials (phase 03) and credentials for external business systems such as an ERP (phase 11). Both are encrypted at rest with AES-256-GCM bound to their tenant and row, with the key ring kept only in an env file; decrypted values stay in memory and never appear in API responses, the console, model input, logs, traces, audit diffs, alerts or command output.

**授权。** `agent_app` 对 `erp_connectors` 只有 SELECT、INSERT 与 `status`、`base_url`、`database`、`settings`、`secrets_ct`、`secrets_key_id`、`updated_at` 的列级 UPDATE，没有 DELETE。命令行拒绝 `kind='sandbox'` 的租户。

### R4 · 出站防护（SSRF）

`src/net/egress.ts` 导出 `createEgress(opts?)`，返回唯一的请求函数；连接器构造时拿到它，没有别的网络出口（R2 的边界检查）。

```ts
export interface EgressRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}
export function createEgress(opts?: { allowLoopback?: true }): (req: EgressRequest) => Promise<{ status: number; body: Buffer }>;
export function normalizeBaseUrl(raw: string): { ok: true; url: string } | { ok: false; code: EgressCode };
export type EgressCode =
  'scheme' | 'userinfo' | 'port' | 'host' | 'blocked_address' | 'dns' | 'timeout' | 'too_large' | 'redirect' | 'content_type' | 'network';
```

| 规则       | 做法                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议       | 只认 `https:`；`allowLoopback` 时另认 `http:`，且只连回环地址                                                                                                                                                                                                                                                                                                                                   |
| 地址形状   | 按 WHATWG URL 解析；不许带用户名密码、查询串、片段；主机是带点的域名或 IP 字面量；`localhost`、`*.localhost` 直接拒                                                                                                                                                                                                                                                                             |
| 端口       | 443、8443、8069 三个之一，缺省 443                                                                                                                                                                                                                                                                                                                                                              |
| 解析与校验 | 在 `https.request` 的 `lookup` 钩子里解析全部地址，任何一个落在禁用段就整次拒绝；连接用的就是校验过的地址，不先解析、后连接，防 DNS rebinding                                                                                                                                                                                                                                                   |
| 禁用段     | 只放行公网单播：拒绝 IANA 特殊用途段，包括 0.0.0.0/8、10/8、100.64/10（含阿里云元数据 100.100.100.200）、127/8、169.254/16（含 169.254.169.254）、172.16/12、192.0.0/24、192.0.2/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、224/4、240/4；IPv6 的 ::、::1、fc00::/7、fe80::/10、ff00::/8、2001:db8::/32、100::/64；`::ffff:0:0/96`、`64:ff9b::/96`、`2002::/16` 按内嵌的 IPv4 再判 |
| 重定向     | 不跟随，3xx 按 `redirect` 失败                                                                                                                                                                                                                                                                                                                                                                  |
| 证书       | 校验证书，没有关闭的开关；不读 `HTTPS_PROXY` 等代理变量                                                                                                                                                                                                                                                                                                                                         |
| 时限       | 从开始解析到读完响应的总时限 `timeoutMs`，另受 `signal` 中止                                                                                                                                                                                                                                                                                                                                    |
| 大小       | 先看 `Content-Length`，再按读到的字节计，超过 `maxBytes` 当场中断，按 `too_large` 失败                                                                                                                                                                                                                                                                                                          |
| 类型       | 响应 `Content-Type` 必须是 `application/json`                                                                                                                                                                                                                                                                                                                                                   |
| 日志       | 只记错误码、状态码、耗时与连接器 key；不记地址、请求头、请求体、响应体                                                                                                                                                                                                                                                                                                                          |

- 配置时（命令行 `add` / `set`）先过 `normalizeBaseUrl` 并实际解析一次；运行时每次请求再按上表校验。
- `allowLoopback` 只供自测与本机集成脚本（R2 的边界检查），应用的组合根永远用严格版本，不设 env 开关：线上跑的是 demo profile，env 开关会被误开。
- **AGENTS.md 加一条**（英文原文，放在 Secrets 那条之后）：

> - Outbound requests to tenant-configured addresses (phase 11 connectors) go only through `src/net/egress.ts`: HTTPS only, every resolved address checked against the private, loopback, link-local and metadata ranges at connect time, no redirects, fixed timeouts and response size limits.

### R5 · 产品映射

- 新表 `erp_item_links`（`tenant_id`、FORCE RLS）：`(tenant_id, connector_id, kind, code)` 为主键，存 `remote_id`、`remote_code`、`remote_uom_id`、`source: 'auto' | 'manual'`、`checked_at`。产品库本身不加字段（加了会让旧镜像的严格 schema 读不了，R12）。
- **自动映射**（命令行 `map --auto`，可 `--dry-run`）：
  - 分页读 Odoo 里 `default_code` 非空、`sale_ok` 为真的 `product.product`，每页 500；
  - 包的 `erp.remoteKey(default_code)` 与 `erp.matchKey(item)` 全等才算对上；工业包两边都用 `normalizePartNo`，所以 `6205 2RS` 与 `6205-2RS` 对得上；
  - 恰好一个 → 建链接；没有 → 未映射；多于一个（`default_code` 在 Odoo 不唯一）→ 冲突，不建；
  - 单位必须对上：Odoo 的 `uom_id` 等于 `settings.uom[erp.unitOf(item)]`，否则 `uom_mismatch`，不建；
  - 只看已上架与草稿的条目；输出各类条数与我方编号清单，不打印 Odoo 的品名。
- **手工映射**：`map --set <编号>=<Odoo 产品 id>`，按 id 指定，免得 `default_code` 重名；同样核对单位。`map --unset <编号>` 删链接。
- **运行时**：只按链接里的整数 id 读 Odoo，从不拿客户或模型给的文字去 Odoo 检索。读到的产品 `active` 为假、`uom_id` 与链接不符，这一条按未映射处理，计数进告警。
- 未映射的条目照常报价，库存与交期用产品库的值。

### R6 · 实时可售量与交期

**读法。** 一次请求读完：`POST /json/2/product.product/read`，`ids` 是本次要的链接 id（至多 30 个），`fields` 为 `free_qty`、`sale_delay`、`uom_id`、`active`，`context` 为 `{ location: settings.locationId }`。many2one 只取 id。

**数值校验。** `free_qty` 必须是有限数，取整（向下）、负数记 0；`sale_delay` 必须是 0–365 的整数，否则这一条不用。

**缓存、时限与熔断**（每个连接器，进程内租户状态，登记进 05 R5 的清单）：

- 缓存键 `kind:code`；60 秒内的值直接用，不发请求；超过 60 秒才重新取。`peek` 在 10 分钟内都返回缓存值，保证同一轮里试算与建单看到同一个数。
- 回合内的请求时限 `turnTimeoutMs`（缺省 1.5 秒）。
- 超时、网络错误或 5xx 一次，这个连接器冷却 30 秒：冷却期内 `availability` 不发请求，直接返回空（`cooldown`）；一轮里至多等一次超时。
- 同一连接器同时至多 4 个请求，再多直接返回空（`busy`）。
- `auth`（401、403）：冷却 10 分钟，告警一次「API key 失效或到期」。

**工业包怎么叠加。** 新文件 `src/packs/industrial/live.ts` 的 `live(part, a?)`：有实时值时返回 `{ ...part, stock: a.onHand, leadDays: a.leadDays ?? part.leadDays }`，没有时原样返回。

- `find_parts`、`quote_items`：匹配之后，对精确命中的条目调一次 `sources.erp.availability('part', codes, cancel)`，再按 `live()` 算库存标签与 `priceLine`（`src/packs/industrial/tools.ts:45-74、102-153`）。工具结果的结构与字段不变，变的只是库存与交期的值。
- `create_quote_sheet`：建单前调一次 `availability`；`runtime.priceLine` 包一层 `live(item, peek(...))`（`src/packs/industrial/runtime.ts:39`），订单行冻结的「交期」与刚才的试算一致。
- 自动批准（`src/packs/industrial/quotes.ts:18-28`）：连接器启用时，「库存 ≥ 数量」只认 `peek` 返回的 ERP 值；有一行没有 ERP 值就不自动批准，转人审。没有连接器时照旧。
- 型号匹配、护栏、`rfqDraft`、预取的判定（`src/packs/industrial/turn.ts:125-157`）都不改。库存与交期的说法护栏照旧比对本轮工具结果，工具结果里的数已经是叠加后的。
- `sources.erp.active('part')` 为假时（没有连接器、停用、文件存储、沙箱），以上代码路径一行都不走，工具结果逐字节不变。

**ERP 返回的东西进到哪里。** 只有两个整数（可售量、交期天数）进入 `priceLine` 的行属性与工具结果。Odoo 的品名、描述、`default_code` 等字符串不进模型、不进对客文字。

### R7 · 价格

- 价格不读 ERP。单价、档位、起订量、`moneyLedger` 与报价单金额照 10 R4、09，只来自产品库与 `priceLine`。
- 理由：Odoo 的价格来自价目表、客户专属规则、税是否含在价内、币种，映射到我们的四档扁平价要另外设计，并会让价格不再由我们的确定性代码决定。真要从 ERP 取价，另写 spec，先把价目同步成产品库的新版本、经后台确认再生效。
- 写回时把我们批准的单价写进 Odoo（R8），由 Odoo 侧核对；不一致时提醒顾问，不改我们的单。

### R8 · 写回草稿报价单

**什么时候排任务。**

- 报价单变为已批准的两处，租户连接器启用且 `writeback` 为真时，用 `queueJobs` 排一个任务，随这次会话落库一起提交：
  - 工作台批准：`approveQuote`（`src/payment/orders.ts:120-148`）在 `quoteDecided(order, 'approved')` 之后；已经是已批准的幂等分支不排；
  - 自动批准：`createLineOrder`（`src/core/order-view.ts:203-207`）里转为已批准之后；复用已有报价单（`reused: true`）不排。
- 自动批准的报价单也写回：自动批准是商家在 policy 里显式开的确定性规则（10 R6），缺省全部人审。
- 任务：`kind: 'erp_quote_push'`，`dedupeKey: erp_quote:<订单号>`，`payload: { sessionId, orderId }`，至多 5 次。认领走新的一条道 `erp`（`src/jobs/runner.ts:87-91` 加一项），ERP 慢不挡转人工通知。`jobs.kind` 的 CHECK 加这一值（`drizzle/0002_conversations.sql:84`）。沙箱的 `queueJobs` 本来就丢弃任务（`src/store.ts:525-529`）。
- 每个租户每天至多写回 200 张，超出的这张记 `failed: rate_limited` 并告警一次。

**执行体**（`src/connectors/push.ts`，在租户作用域里）：

1. 读订单。已不是已批准（撤回、被取代、已过期），或已有 `done`：结束，不写。
2. 每一行 `(kind, code)` 都要有链接且单位相符；有一行没有就结束为 `failed: unmapped`，不写半张。
3. 查重：`sale.order` 的 `search_read`，条件 `origin = <订单号>`，至多 2 条。有 1 条：记为 `done`（不论它在 Odoo 里的状态，可能是顾问已经处理过）；多于 1 条：`failed: duplicate`，告警。
4. 新建：`sale.order` 的 `create`，`vals_list` 只有一条：`partner_id` 为 `settings.partnerId`，`origin` 为订单号，`order_line` 为 `[0, 0, { product_id, product_uom_qty, price_unit }]` 各行；`price_unit` 是 `unitPriceFen / 100`。不传单位、税、备注、客户信息。
5. 核对：读回这张单的单号与各行。每行的产品、数量相同，且 `round(price_unit × 100) = unitPriceFen` → `done`；有不一致 → `diff`，草稿留在 Odoo，不删不改。

- 超时、网络错误、5xx：抛错，由任务表重试；重试时第 3 步会找到上次其实已提交的那张，不重复建。查重与新建之间没有锁（JSON-2 每次调用一个事务），同一订单靠任务表的去重键保证只有一个执行者。
- 401、403、4xx、第 2 步：不重试，直接结束。
- 第 3 步依赖 `origin`；顾问在 Odoo 里改掉了 `origin` 之后再重试，可能多建一张。只在人工 `push` 时可能发生，命令行提示这一点。

**状态表 `erp_quote_pushes`**（`tenant_id`、FORCE RLS）：主键 `(tenant_id, order_id)`；`connector_id`、`state: 'pending' | 'done' | 'failed' | 'diff'`、`remote_id`、`remote_name`、`error`（固定错误码，CHECK 限定取值）、`attempts`、时间戳。`agent_app` 无 DELETE。

**告诉顾问。**

- 结果写进会话一条 `role: 'system'` 消息（工作台照常显示，模型历史本来就过滤掉系统消息，`src/core/engine/index.ts:771`）：
  - `done`：「报价单已写入 ERP 草稿报价 <单号>」；
  - `diff`：「报价单已写入 ERP 草稿报价 <单号>，但单价或数量与本系统不一致，请在 ERP 里核对」；
  - `failed`：「报价单没写进 ERP（<原因>），请在 ERP 里手动录入」，原因是固定文案表里的一句。
  - 单号只在匹配 `^[A-Za-z0-9/_-]{1,32}$` 时显示，否则省略。
- `failed` 与 `diff` 另经 `handoff_notify` 通知顾问，原因 `erp_push_failed`（`src/notify/handoff.ts:53` 的集合加一项），按订单号去重；文案登记进通知文案表。
- 不发给客户，不改报价单状态，不影响客户已经收到的报价单链接。

### R9 · 平台命令行

`src/cli/erp-connector.ts`，用法与 `channel-account` 一致（`docker compose run --rm app node --import tsx src/cli/erp-connector.ts …`），写操作记审计 `erp.*`，改完「重启应用生效」：

| 子命令                                                                                                                                                          | 作用                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list --tenant <slug>`                                                                                                                                          | 连接器 key、种类、状态、映射条数、写回开关、最近一次检查结果；不打印地址与凭据                                            |
| `add-odoo --tenant <slug> --key <key> --base-url <url> [--database <db>] --location <id> --uom <单位=id,…> --secrets-file <path>`                               | 建连接器；地址先过 R4；凭据文件规则同 `channel-account`（普通文件、权限不宽于 0600、至多 64 KiB）；建完自动跑一次 `check` |
| `set --tenant <slug> [--status active\|disabled] [--writeback on\|off] [--partner <id>] [--lead-time catalog\|odoo] [--location <id>] [--uom …] [--base-url …]` | 改设置；开写回时 `partnerId` 必填且 `check` 要通过                                                                        |
| `set-secrets --tenant <slug> --secrets-file <path>`                                                                                                             | 换 API key                                                                                                                |
| `check --tenant <slug>`                                                                                                                                         | 鉴权、公司币种必须是 CNY、库位与占位客户存在；只打印结论与错误码                                                          |
| `map --tenant <slug> (--auto [--dry-run] \| --set <编号>=<id> \| --unset <编号>)`                                                                               | R5                                                                                                                        |
| `push --tenant <slug> --order <订单号>`                                                                                                                         | 给一张已批准的报价单手工排写回（失败后、或回滚期间漏写的）                                                                |
| `rekey --tenant <slug>`                                                                                                                                         | 用当前密钥重新加密                                                                                                        |

- 拒绝沙箱租户；文件存储模式下整体拒绝。
- 输出与报错不含地址、凭据、Odoo 品名。

### R10 · 可观测性

- 日志：`[erp] <租户>/<key> <read|create|search|readback> <条数> <毫秒> <ok|错误码>`，不带地址与内容。
- 回合 trace：`PrefetchResult.timings` 与工具耗时里记 ERP 段的毫秒数与是否命中缓存（`src/core/pack-api.ts:253-256`）。
- 告警（`src/ops/alert.ts:34-45` 的 `AlertKey` 加 `erp`）：连接器从正常转为失败、API key 失效、启动解不开凭据、写回 `failed` / `diff`、超出每日写回上限，各在状态变化时推一次，只带租户、连接器 key 与错误码。

### R11 · 测试

- **出站防护自测** `src/net/egress.selftest.ts`：禁用段逐段的正反例（含 IPv4 映射的 IPv6、NAT64、6to4）；解析结果一真一假时整次拒绝；连接用的是校验过的地址；重定向不跟随；超时、超大响应、错误类型、用户名密码、端口、`http:` 的拒绝；`allowLoopback` 之外连不上回环。
- **模拟 Odoo**：`src/connectors/odoo-mock.ts`，回环上的 `node:http` 服务，照公开文档的 JSON-2 形状实现本 spec 用到的五个方法与错误返回，可注入延迟、超时、401、500、重复 `origin`、读回改价。合成数据，域名用 `erp.example.test`。不抄 Odoo 的代码与文档原文（LGPL-3 的代码只读）。
- **连接器自测** `src/connectors/connectors.selftest.ts`：请求头与请求体逐字段；错误码映射；数值校验；缓存、冷却、并发上限；映射的三种结果与单位不符；写回的幂等（新建后超时 → 重试找到原单，不重建）、半张不写、`diff`；凭据的封装往返、换附加数据或换成渠道密文解不开；`Redacted` 打印只有「[已遮盖]」。
- **数据库自测**：三张表的 RLS、列级授权、CHECK；`jobs.kind` 新值；迁移检查。真实 PG 用一次性 `pgvector/pgvector:pg17` 容器。
- **工业包自测**：没有连接器时工具结果逐字节不变；有连接器时库存标签、交期、`priceLine`、订单行冻结的交期都用实时值；超时退回产品库值、一轮只等一次；自动批准缺 ERP 值时转人审；`peek` 与试算一致。
- **命令行自测**（子进程）：输出与报错里扫不到地址、API key、密文；拒绝沙箱租户；地址校验；写回开关的前置条件。
- **回滚检查自测**：R12 的四种情况。
- **本机集成** `scripts/odoo-integration.ts`，不进 `pnpm test`，CI 不依赖：
  - 起一次性 `postgres` 与 `odoo:19`（再跑一遍 `odoo:20`）容器，装 `sale_management`、`stock`，不装演示数据；用 `odoo shell` 建低权限机器人用户、它的 API key、合成产品与库存；
  - 跑 `check`、`map --auto`、`availability`、写回、重复写回、读回核对；记耗时；
  - 外层套超时，结束删容器（AGENTS.md）。镜像约 1.5 GB，初始化约一两分钟，太重，不进 CI。
- **评测**：没有新的 v2 用例，也不跑真实模型闸：SOP、提示词、工具定义、护栏都不改，评测与模拟客户里没有连接器。v2 旅游与工业用例逐条不变，四个哈希不变。

### R12 · 回滚

- 迁移只增：三张新表、`jobs.kind` 的 CHECK 放宽（`-- migration-allow: drop` 标注，旧镜像写的值都在新集合里）。
- 旧镜像不读这三张表，读到也不会出错；风险是静默：回滚期间库存回到产品库值，批准的报价单不写回；旧镜像不认领 `erp_quote_push`（按道认领，`src/db/repo/jobs.ts:71`），执行到一半的还会被它的启动归位改回待执行或标成失败。所以照 09 R15、10 R17、12 R14 的做法加 pre-11 检查，用镜像里有没有 `src/connectors/registry.ts` 识别 pre-11（手动部署看 tag 的文件树，自动回滚看目标镜像）。
- 库里有以下任一项时拒绝退到 11 之前（退出 9），提示「先 `erp-connector set --status disabled` 停用连接器、等写回任务跑完，再回滚；或前滚修复」：
  - `status='active'` 的连接器；
  - `state='pending'` 的写回；
  - `pending` 或 `running` 的 `erp_quote_push` 任务。
- 查询失败或目标能力无法确认时从严拒绝。停用的连接器、已结束的写回不拦：这是 08 R13 式的「先清理再回滚」，不删任何数据。前滚、重新启用之后，回滚期间批准的报价单用 `push --order` 补写。

### R13 · 不变的东西

- 旅游租户与没声明 `erp` 的包：一行新代码都不走；锁定的 8 个文件、四个哈希、v2 用例不变。
- 工业租户没有启用的连接器时：工具结果、订单、自动批准、护栏逐字节不变。
- SOP、系统前缀、工具定义、固定句、护栏规则不变；没有新工具。
- 演示行为（重置、匿名只读、种子保鲜、访客清理）不变；连接器不由 `DEPLOY_PROFILE` 开关控制，没配就不存在。

## 不变量

1. 报价单的单价与金额只来自产品库与 `priceLine`；ERP 返回的任何值都不进入单价、金额与 `moneyLedger`。
2. ERP 返回的值只有可售量与交期两个整数会影响对客文字，且只经 `priceLine` 的行属性与工具结果；ERP 的字符串不进模型、不进对客文字。
3. 模型不能指定连接器的地址、方法、参数或写操作：没有 ERP 工具；读只按映射表里的整数 id，写只由批准后的任务发起。
4. 连接器的每一次出站都经过 `src/net/egress.ts`；连接时的地址都已按禁用段校验过，重定向一律不跟随。
5. 连接器凭据只以密文落库；明文只在进程内存里，不出现在日志、trace、审计、告警、接口响应、命令行输出与模型输入里。
6. 没有启用的连接器时，行为与 11 之前逐字节相同。
7. ERP 不可用时，询价回合照常完成：一轮至多等一次 `turnTimeoutMs`，之后按产品库值回答。
8. 只有已批准的报价单会写进 ERP；同一张报价单在 ERP 里至多一张草稿（除非有人在 ERP 里改掉了 `origin`）；写回只建草稿，不确认、不改、不删 ERP 里的单。
9. 连接器启用时，自动批准只认 ERP 的新鲜可售量；缺 ERP 值的报价单走人审。
10. 写回失败、单价不一致，顾问一定会在会话里看到系统消息并收到一次通知。

## 兼容与迁移

- 新迁移（开工时 `dev` 上的下一个编号）：
  - `erp_connectors`、`erp_item_links`、`erp_quote_pushes` 三张表，FORCE RLS，授权见 R3、R5、R8；
  - `jobs.kind` 的 CHECK 加 `erp_quote_push`。
- 不改 `catalog_items`、`orders`、`messages` 的形状；产品库条目不加字段。
- `handoff_notify` 的原因、`AlertKey` 是代码里的集合，不是库约束。
- 上线顺序：先部署不配连接器的版本，确认四个哈希与旅游、工业行为不变；再由 owner 授权，给目标租户 `add-odoo` → `check` → `map --auto` → 重启；写回在只读跑稳之后单独 `set --writeback on`。
- 回滚见 R12。

## 安全、隐私与性能

- **SSRF**：R4；配置入口只有平台命令行（运维执行），以后若开放给商家在后台自助配置，同一道防护照用。
- **注入**：Odoo 的检索条件只由整数 id 与订单号组成；ERP 返回的字符串不进模型；写回只传数字与订单号。
- **最小权限**：命令行与文档要求 Odoo 侧用专用机器人用户，只给读产品与库存、建报价单所需的组；`check` 不需要管理员。18.0 起 key 会到期，到期按 `auth` 告警，换 key 用 `set-secrets`。
- **隐私**：写回不传客户的任何信息（占位客户，开放问题 2）；只传订单号、产品与数量、单价。ERP 部署在哪里由商家决定；接境外托管的 Odoo（如 Odoo Online）时，传出去的也只有这些。
- **许可**：只调用 Odoo 的公开接口；不复制 Odoo 的代码与文档；集成用的官方镜像只在本机下载运行，不进仓库、不随产品分发。
- **性能**：
  - 缓存命中时不增加时延；未命中时一次请求，`turnTimeoutMs` 缺省 1.5 秒；一轮至多等一次超时。工业询价回合（10 第 21 步之后的一次模型往返）的 8 秒线照旧适用，ERP 段另记进 trace。
  - 写回在后台任务里，不占客户回合。
  - 映射一次全量读，命令行里跑，不在请求路径上。

## 验收标准

1. **不配连接器什么都不变**：旅游与工业的 v2 用例逐条不变，四个哈希不变；工业工具结果与订单逐字节对照 11 之前。
2. **实时库存**：模拟 Odoo 给某型号可售量 7、交期 12 天，产品库写 100 件现货：客户问 10 件，回复与工具结果都是「现货 7 件，其余约 12 天」；建单后订单行冻结同一交期；60 秒内再问不再请求 Odoo。
3. **ERP 不可用**：模拟 Odoo 挂起或 500：这一轮在 `turnTimeoutMs` 之后按产品库值答完；30 秒内的下一轮不再等；自动批准阈值内、全现货的报价单因缺 ERP 值转人审；告警只推一次。401 时告警写明 key 失效。
4. **映射**：`map --auto` 对合成产品给出已映射、未映射、冲突（`default_code` 重复）、单位不符四类，条数与样本真值一致；未映射的型号照常按产品库值报价；`map --set` 按 id 指定后生效。
5. **写回**：开写回后工作台批准一张 3 行报价单：Odoo 里出现一张 `origin` 为订单号的草稿报价，产品、数量、单价一致，会话里有「已写入」系统消息。模拟「新建后超时」：重试后 Odoo 里仍只有一张。有一行未映射：不写，顾问收到一次通知与系统消息。读回单价被改：记 `diff`、通知一次。客户侧没有任何新消息。
6. **出站防护**：地址指向 127.0.0.1、10.x、169.254.169.254、100.100.100.200、`[::1]`、`[::ffff:10.0.0.1]`、解析到私网的域名、一次公网一次私网的解析、302 跳到内网、`http://`、带用户名密码、端口 22：命令行配置时拒绝；绕过命令行直接写库的，运行时请求也被拒绝，错误码与日志里都没有地址。
7. **凭据**：命令行输出、日志、审计、告警、`/healthz` 与 trace 里扫不到 API key 的明文、密文的 base64 与 hex；渠道账号的密文换到连接器行解不开，反之亦然；`rekey` 前后都能解。
8. **本机集成**：`scripts/odoo-integration.ts` 在一次性 Odoo 19 与 20 容器上跑通 `check`、`map --auto`、实时库存、写回与重复写回；结束后没有残留容器与进程；耗时记进 plan。
9. **回滚**：库里有启用的连接器、待写回、待执行的写回任务时，退到 11 之前的镜像被拒绝（退出 9），停用并等任务结束后放行；本机一次性容器演练四种情况。
10. **边界**：在 `src/connectors/` 里加一处 `fetch(`、在包里 import 连接器、在应用代码里写 `allowLoopback`，`pnpm lint` 都失败。

## 开放问题

1. **第一期做不做写回？**
   - A：只读（实时库存与交期），写回另起一期。
   - B：只读加写回，写回按租户开关、缺省关，只写已批准的报价单（本 spec 现在的写法）。
   - 推荐 B：10「后续」已把写回列进 11；任务表、去重与通知都有现成的机制，增量不大；业内的流程以写回 ERP 收尾。分批里写回是独立的一批（C），赶不上可以先只上只读。
2. **写回的报价单挂在哪个客户名下？**
   - A：每个租户配一个占位客户（如「企微询价客户（待指定）」），顾问在 Odoo 里改成真实客户。
   - B：按会话在 Odoo 里建 `res.partner`，带画像里的公司名。
   - 推荐 A：不往 ERP 写任何客户信息，隐私面最小；B 会在 ERP 里堆出大量重复客户，还要处理客户去重，留到有真实商家需求时再定。
3. **支持哪些 Odoo 版本？**
   - A：19、20，只用 JSON-2。
   - B：再加 18，走 `/jsonrpc` 的 `execute_kw`（API key 代替密码），要多一套传输、一套鉴权（先 `authenticate` 取 uid）和一个测试容器。
   - 推荐 A：`/jsonrpc` 已弃用，2027–2028 年删除；17 已停止发镜像。真有商家在 18 上，再按 B 补，接口不用改。
4. **客户料号 / 竞品料号对照放 11 第一期吗？**
   - A：放进 11，从 ERP 读。
   - B：不放，后面单独一份 spec。
   - 推荐 B：Odoo 标准版没有客户料号表，从 ERP 读不到；对照要按「哪个客户」区分，前提是先有客户身份；数据更可能来自商家的表格或 12 收到的询价单。
5. **工业演示租户接不接 Odoo？**
   - A：不接；验收在本机一次性容器上做，线上只确认「不配连接器什么都不变」。
   - B：在线上服务器跑一个 Odoo 社区版容器（自带 Postgres，常驻内存约 0.5–1 GB）给演示租户接上。
   - 推荐 A：11 对演示的帮助不如 12；B 要在唯一的生产服务器上多养一套服务和它的备份。有真实商家试点时再定。
6. **连接器凭据用哪把密钥？**
   - A：共用 03 的密钥环 `CHANNEL_SECRETS_KEY`，用附加数据区分用途。
   - B：新加一个 env，如 `CONNECTOR_SECRETS_KEY`。
   - 推荐 A：两把钥匙放在同一台服务器的同一个 env 文件里，分开并不增加隔离；一套轮换流程更不容易出错。名字里的「CHANNEL」以后改名时另议。
7. **连接器启用但 ERP 取不到值时，对客户怎么说库存？**
   - A：退回产品库的值（本 spec 现在的写法），同时这张单不自动批准。
   - B：改说「库存和交期以顾问确认为准」，不报具体库存。
   - 推荐 A：与今天没有连接器时的行为一致，回复不因 ERP 抖动而变样；风险是产品库的值过时，所以接了 ERP 的商家应把产品库里的库存写保守（文档写明），并由不变量 9 兜住自动批准。B 要改工具结果与护栏，评测随之变动。

## 被否决的方案

- **把库存定时同步进产品库。** 每次变化都会写一个条目版本和一行审计，还要拿配置写锁（`src/config/catalog.ts:128-139`）；按分钟同步会把版本表刷满。实时查加缓存，产品库只当兜底。
- **价格也从 ERP 取。** 见 R7。
- **给模型一个「查 ERP」或「写 ERP」工具。** 改系统前缀，模型可能乱调、传任意参数；ERP 的读写由代码确定性地做更稳。
- **按客户原话去 Odoo 搜 `default_code`。** 每轮都把外部输入送进 ERP 的检索；`default_code` 不唯一。改为事先映射、运行时只按 id 读。
- **用 XML-RPC。** 已弃用，还要解析 XML（仓库不引入 XML 解析依赖）。
- **用 `fetch` 再自己先解析一次域名做校验。** 解析与连接之间域名可以换地址（DNS rebinding）；`fetch` 不让指定连接地址。改为 `node:https` 的 `lookup` 钩子，校验与连接是同一个地址。
- **引入现成的 Odoo 客户端包。** 只用到五个方法，自己写更好审计；npm 上的包多是 XML-RPC 封装。
- **在客户回合里同步写回。** 拖慢回合，失败难重试；放后台任务。
- **用 env 开关放行私网地址做本机测试。** 线上跑的是 demo profile，开关一旦误开就是 SSRF；改为只在自测与集成脚本里用代码参数放行回环。
- **先接金蝶或用友。** 国内更常见，但没有能放进 CI 的开源实例，接口与授权要和厂商另谈；第一家用 Odoo 把框架、防护与密钥规则立起来，第二家照接口接入（另写 spec）。

## 分批

- **A 地基**：出站防护、凭据封装与 AGENTS.md 修订、迁移、连接器装载与门面、命令行骨架、回滚检查。
- **B 只读**：Odoo 客户端的读、映射、缓存与熔断、工业包叠加、模拟 Odoo。
- **C 写回**：任务、执行体、状态表、系统消息与通知、`push` 命令。
- **D 验证**：本机集成、验收、上线。

## 后续

- 第二家 ERP（金蝶云星空、用友等），以及 Odoo 18（开放问题 3 的 B）。
- 客户料号 / 竞品料号对照（开放问题 4）。
- 后台的连接器设置页与工作台的 ERP 状态、重试按钮。
- 报价单撤回、过期、客户确认之后同步 ERP 状态；确认后转销售订单。
- 从 ERP 取价、同步产品主数据（经后台确认后写产品库新版本）。
- 把群机器人等 env 配置的出站也收进出站防护。
