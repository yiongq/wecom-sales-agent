# 11 · 外部业务系统连接器 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本 spec 已由 owner 于 2026-10-29 定为 `ready`。

## 开工条件

缺一条就停下，告诉 owner：

1. 本 spec 已由 owner 定为 `ready`，开放问题 1–5 已定。翻 `ready` 的 docs PR 同时：
   - 把 R3、R4 的两条规则原文写进 `AGENTS.md`；
   - 给 ADR-003 与 10 加反向的 `Superseded in part by:`，给 03、04、05、08 加 `Amended by:`，主参考「阶段 8」加一条。
2. 12 已 `implemented`；09、10 已 `implemented`。第 1–3 步不碰工业包，12 收尾期间可以先做；迁移编号取合入时 `dev` 上的下一个。
3. 本机能跑四个门禁、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。
4. 第 0 步与第 7 步要下载并运行 `postgres` 与 `odoo:19`、`odoo:20` 官方镜像（各约 1.5 GB），每次 owner 当次授权。第 0 步的跨地区实测另要 owner 授权与一台远端主机。
5. 上线（第 9 步）与给任何租户配连接器，都要 owner 当次授权；真实 ERP 的地址与凭据由 owner 提供、按 R9 的凭据文件规则录入，Claude 不经手明文。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`（密钥与出站两条规则已按 R3、R4 修订）、本 spec、10 spec 的 R4、R6、R9 与第 21 步记录、12 spec 的 R8、R10、`docs/spec-driven-dev.md`、本文件的「Open」「已定」「交接记录」，再看 `git log -5`。
- 锁定的 8 个文件一个字节都不改；旅游前缀与四个哈希全程不变；没有连接器时工业工具结果、订单与护栏输出逐字节不变（不变量 6）。
- 测试随批合入，每一批合并时是绿的。新自测都要接进 `package.json` 的 `test` 那一行与 CI 分片：第 1、2、3、5、6 步都改这一行，并行合入时后合的一方 rebase。
- 数据只用合成的：产品照 10 的合成规则，域名用 `erp.example.test`；不提交真实 ERP 地址、数据库名、API key、Odoo 的代码与文档原文。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、凭据、商家的 ERP 数据。
- 探针与样本放 gitignored 的 `var/`；容器与后台进程用完即删，外层套超时（macOS 用 `perl -e 'alarm N; exec @ARGV'`）。

## 步骤

- [x] 0. 开工核对与 Odoo 实测。2026-10-31 本机部分完成；跨地区实测 owner 定推迟，见「已定」。
  - 做：
    - 对照 spec 引用的行号核对现状（12 合入后行号会动），差异记进实施记录。
    - 本机一次性 `odoo:19`、`odoo:20` 容器（各自配 `postgres`），装 `sale_management`、`stock`，不装演示数据；用 `odoo shell` 建低权限机器人用户与 scope 为 `rpc` 的 API key。实测：
      - JSON-2 的请求、错误与 `Content-Type` 形状（401、403、404、422、500）；many2one 的返回形状；
      - `product.product/search_read` 带 `context.location` 与 `active_test: false` 读 `free_qty`、`uom_id`、`active`，含一个已删的 id；
      - 20 上空 scope 的 key 被拒；机器人用户读产品与库存所需的最小组；
      - 读 30 个产品的耗时（首个请求与保活之后）。
    - ~~owner 授权后，从线上服务器所在地区测到一台远端 Odoo：DNS、TLS 握手、首个请求、保活连接上后续请求的耗时。~~（2026-10-31 owner 定推迟到接第一家真实商家时，见 spec「后续」。）
  - 验：结果记进实施记录；与 spec 假设不符的（尤其 R8 的 1 秒截止时间对远端 Odoo 是否够用），先修订 spec（`Revisions:`）或记进 Open。
  - 依赖：无。
- [x] 1. 出站防护（R4）与边界检查（R2）。
  - 文件：`src/net/egress.ts`、`src/net/egress.selftest.ts`、`scripts/check-boundaries.ts` 与其自测、`package.json`。
  - 做：`createEgress`、`normalizeBaseUrl`；字面量预检与 `lookup` 钩子里的解析校验；带超时的 c-ares 解析器；放行范围；不跟随重定向；截止时刻、大小上限；保活 `Agent`；只记错误码；R2 的四条边界检查。
  - 验：
    - 验收 7 的每一种地址在自测里被拒，错误与日志里没有地址；
    - 注入的解析器给一公一私时整次拒绝；连接用的是校验过的地址；保活连接复用；
    - 边界检查的正反例（验收 10）。
  - 依赖：0。
- [x] 2. 凭据封装与迁移（R3、R5、R11）。
  - 文件：`src/channels/secrets.ts`、`src/connectors/secrets.ts`、新迁移与 journal、`src/db/schema.ts`、`src/db/repo/erp.ts`、`src/db/erp.selftest.ts`、`package.json`。
  - 做：
    - `sealJson` / `openJson`，渠道账号的两个函数改为薄封装、密文格式不变；连接器凭据的封装与解封；
    - 迁移：两张表（FORCE RLS、授权、CHECK）；`sandbox_tenant_purge` 的新版本（`-- migration-allow: create-or-replace` 标注），删除与核对清单加两张表，其余与 0021 版逐字比对不变；
    - repo：连接器与映射的读写。
  - 验：
    - 03 的渠道自测原样通过；连接器密文与渠道密文互相解不开；
    - 真实 PG 上 RLS、列级授权、`erp_connectors` 无 DELETE、`erp_item_links` 有 DELETE 通过；`src/db/sandbox.selftest.ts` 的覆盖检查通过；迁移检查通过。
  - 依赖：0。
- [x] 3. Odoo 客户端与模拟 Odoo（R2、R6）。
  - 文件：`src/connectors/types.ts`、`src/connectors/odoo.ts`、`src/connectors/odoo-mock.ts`、`src/connectors/connectors.selftest.ts`、`package.json`。
  - 做：照第 0 步实测的形状构造 `search_read`、`products`、`check` 的请求；按状态码与媒体类型归类错误；数值校验；`database` 字符集。模拟 Odoo 可注入延迟、超时、401、403、404、500、HTML 502、已删产品、坏数值。
  - 验：请求头与请求体逐字段；R6 错误表逐行；模拟 Odoo 与第 0 步实测的形状一致。
  - 依赖：1。
- [x] 4. 装载、新鲜值、截止时间与包门面（R2、R3、R6、R10）。
  - 文件：`src/connectors/registry.ts`、`src/core/pack-api.ts`、`src/core/engine/sources.ts`、`src/core/engine/index.ts`（每轮作用域）、`src/boot.ts`（启动装载，与 `initChannels` 同处）、`src/tenancy/state-manifest.ts`、`src/ops/alert.ts`、`src/packs/industrial/runtime.ts`（只加 `erp` 声明：`kind`、`key`、`remoteKey`、`unit`）。
  - 做：
    - 启动按租户装载并解密，解不开按停用并告警；沙箱与文件存储下不装；
    - `PackSources.erp` 的 `active` / `availability` / `fresh`；`PackRuntime.erp` 声明；
    - 新鲜值 60 秒、30 秒重取；每轮截止时间；单路、合并、每秒限速；冷却；
    - 租户状态登记；`AlertKey` 加 `erp`；key 到期的每日检查；日志格式。
  - 验：
    - 新鲜值、截止时间、冷却、限速与合并的时序用注入时钟测（验收 4、5 的本机部分）；
    - 严格租户模式下两个租户的缓存互不串；
    - 没有连接器时 `active` 恒为假，旅游与工业自测原样通过。
  - 依赖：2、3。
- [x] 5. 产品映射与命令行（R5、R9）。
  - 文件：`src/connectors/mapping.ts`、`src/cli/erp-connector.ts`、`src/cli/erp-connector.selftest.ts`、`package.json`。
  - 做：映射的自动、手工与删除；`show`、`add-odoo`、`set`、`set-secrets`、`check`、`map`、`rekey`；拒绝沙箱租户与文件存储；凭据文件规则同 `channel-account`；`--key-expires` 必填。
  - 验：
    - 验收 6（映射函数注入模拟连接器测）；
    - 子进程测：输出与报错扫不到地址、API key、密文；地址校验；到期日校验；
    - `rekey` 前后都能解（验收 8 的一部分）。
  - 依赖：4。
- [x] 6. 工业包接入（R7）。
  - 文件：`src/packs/industrial/live.ts`、`src/packs/industrial/tools.ts`、`src/packs/industrial/runtime.ts`（`priceLine` 包一层）、`src/packs/industrial/quotes.ts`、`src/packs/industrial/guards.ts`、`src/packs/industrial/turn.ts`（预热）、`src/industrial-erp.selftest.ts`、`package.json`。
  - 做：`live()`；预取一次预热；三个工具取新鲜值；`priceLine` 与自动批准只认 `fresh()`；护栏证据（主回复与跟进）改按新鲜值；退回产品库值时的系统消息（30 分钟去重）。
  - 验：
    - 验收 1（工具结果、订单与护栏输出逐字节对照 11 之前）、验收 2、3，验收 4 的预热部分；
    - v2 文件与 PGlite 两条全过，对当时的快照 0 差异；工业 10 套自测与 `eval/sim/industrial` 自测原样通过。
  - 依赖：4（与第 5 步可并行，只同改 `package.json`）。
- [x] 7. 本机集成（R12）。
  - 文件：`scripts/odoo-integration.ts`（不进 `pnpm test`）。
  - 做：起 `odoo:19`、`odoo:20` 一次性容器，建机器人用户、scope 为 `rpc` 的 key、合成产品与库存；进程内用 `createEgress(baseUrl, { allowLoopback: true })` 构造连接器，跑 `check`、映射、`stock` 与门面的 `availability`；20 上再用一把空 scope 的 key 验 401；在 Odoo 前放一层一次性 nginx（回环 HTTP），确认连接确实复用，记复用率（第 0 步测得 Odoo 直连不复用，R8）；记耗时；外层超时，结束删容器。
  - 验：验收 9；结束后 `docker ps -a` 与 `ps` 没有残留。
  - 依赖：5、6。
- [x] 8. 中期审查与回滚演练。
  - 做：
    - 对照不变量 1–10 与验收 1–10 逐条核本机证据；跑全部门禁与 gitleaks；另派一路只读评审看出站防护、凭据路径与新鲜值的四处用法；
    - 本机一次性容器演练 R11：库里有连接器与映射时退到 12 的 tag，旧镜像照常启动、按产品库值回答；再前滚，连接器照常工作（验收 11）。
  - 验：审查结论、修复与演练结果记进实施记录。
  - 依赖：1–7。
- [ ] 9. 上线（不配连接器）。
  - 做：owner 授权后上线 rc；只读核对四个哈希、迁移条数、旅游与工业的一问一答不变、库里没有任何 `erp_connectors` 行。按开放问题 3 的结论，不给演示租户配连接器。
  - 验：验收 1 的线上部分。
  - 依赖：8。
- [ ] 10. 对照全部验收逐条验证并记录。依赖：9。
- [ ] 11. 清理临时探针、集成产物、容器与后台进程。依赖：10。
- [ ] 12. owner 确认后翻 `Status: implemented`，按授权发版。依赖：11。

## 工作量与并行

- 第 0 步之后，第 1、2 步可并行（只同改 `package.json`）。第 3 步等第 1 步；第 4 步等第 2、3 步。
- 第 4 步之后，第 5、6 步可并行；第 7 步等两者都合入。
- 第 1–3 步不碰工业包，12 收尾期间可以先做。
- 按 03–12 的实际速度折算，日历时间约四五天，不含下载镜像、跨地区实测、等 owner 授权与上线的时间。

## 实施记录

### 第 0 步 · 本机部分（2026-10-31，Codex 执行，协调者审查）

本次只做第 0 步的本机核对与 HTTP 实测，没有实现连接器。跨地区 DNS、TLS、远端首请求与保活耗时不在授权范围，未测；第 0 步复选框保持未勾选。本节由 Codex 填写，协调者已审查：抽查样本与记录一致，下面的建议已按 spec 2026-10-31 的 `Revisions:` 落地。

**环境与数据。** 两版依次运行，每套独立的 `postgres:17` 与 Odoo，安装 `sale_management`、`stock`，`--without-demo=all`；直连默认 HTTP 服务，`workers=0`，关闭 cron。Node 22.22.0；全部地址与产品为合成数据，未调用真实 ERP、模型或生产服务。

| 镜像          | 实际版本 / digest                                                                          |
| ------------- | ------------------------------------------------------------------------------------------ |
| `odoo:19`     | `19.0-20261015`；`sha256:27f920e002c43a1af7022a68f3cc17db71a2f9f3348800cb050721ce54893e49` |
| `odoo:20`     | `20.0-20261015`；`sha256:d5e3a26baa044867c826dddc09058f10e2582706bf83c146ea04fea889720c76` |
| `postgres:17` | `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`                  |

每版创建 38 个有合成料号的产品：35 个在售且未归档（其中两个 `default_code` 都是 `6205-2RS`），另有一个归档、一个 `sale_ok=false`、一个创建后删除；另建一个无料号产品验证筛选。两个内部库位的库存不同，第一个产品在 A 有 12.5、B 有 21.25，在 A 预留 3；公司币种设为 CNY。专用机器人不在管理员组；分别生成 `rpc`、空 scope、到期测试用 key，不保存或输出 key 明文。

**1. 行号核对。** 对照当前 `HEAD df85a025` 与起草核对基线 `c5cda19a`，逐项复核 spec 中 31 个去重后的 `src/…:行号` / `scripts/…:行号` 引用；只有以下 11 项有差异，其他位置与所述含义均保留。未改 spec。

| 文件                              | spec 行号 → 当前行号                          | 差异                                                                      |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `src/adapters/wecom.ts`           | `465、515、621、1040` → `475、525、631、1050` | 原四处出站仍在，均 +10；12 还新增固定企微地址的附件下载，不是租户配置出站 |
| `src/notify/notifier.ts`          | `97` → `102`                                  | 群机器人 `fetch` +5                                                       |
| `src/ops/alert.ts`                | `154` → `155`                                 | 告警 `fetch` +1                                                           |
| `src/core/pack-api.ts`            | `956-962` → `985-991`                         | `PackSources` +29；原行号现为品牌页类型                                   |
| `src/packs/industrial/turn.ts`    | `139-156` → `131-148`                         | 原文字预取主体 -8；见下方流程变化                                         |
| `src/packs/industrial/turn.ts`    | `125-157` → `118-149`                         | 原预取移入 `textPrefetch`，并非全段一个固定偏移；当前总入口为 `167-178`   |
| `src/packs/industrial/runtime.ts` | `39` → `42`                                   | `priceLine` +3；39 现为新增 `intake`                                      |
| `src/packs/industrial/guards.ts`  | `223` → `225`                                 | 库存证据不足时替换 / 删句 +2，原义保留                                    |
| `src/core/engine/index.ts`        | `771` → `823`                                 | 模型历史排除系统消息 +52                                                  |
| `src/core/pack-api.ts`            | `253-256` → `261-265`                         | `PrefetchResult` 增加 `effects`，`timings` 当前为 264                     |
| `src/ops/alert.ts`                | `34-45` → `34-46`                             | `AlertKey` 新增 `attachment_limit`，原成员保留                            |

单独标记的流程 / 契约扩展：12 把预取拆成文字分支 `textPrefetch`（117–149）、确认分支 `confirmPrefetch`（151–166）与总入口（167–178）。确认分支按清单一次 `quote_items`，经 `effects.statePatch` 标 confirmed、经 `effects.notify` 通知未匹配项；旧的文字预取区间不能覆盖它。`PrefetchResult.effects` 与 `AlertKey.attachment_limit` 均已存在，后续只能追加。另核对 spec 用自然语言引用的引擎「第 821 行 prefetch」：当前实际调用在 873 行（+52）。R7 的预热应覆盖两个分支，并放在各分支调用工具之前。

**2–3. JSON-2、库存、分页与检查。** 下表无特别标注时，两版结果相同。请求为 `POST /json/2/<model>/<method>`，`Authorization: bearer <遮盖>`，`Content-Type: application/json`，请求体直接是方法的具名参数对象；没有 JSON-RPC 外壳。成功均为 200，原样响应媒体类型为 `application/json; charset=utf-8`，结果直接是数组或对象，没有 `result` 外壳。

| 实测                | 请求要点                                                                                                                                         | 结果与返回形状                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 批量库存            | `product.product/search_read`；`domain=[["id","in",ids]]`；`fields=["free_qty","uom_id","active"]`；`context={"location":A,"active_test":false}` | 响应每行 `{id,free_qty,uom_id,active}`；`id` 自动带回。含已删 id 的整批成功，已删项缺席；归档项返回且 `active=false`                                                                   |
| 库位 / 预留         | 第一个产品 A、B 分开读取；A 另读 `qty_available`                                                                                                 | A：`free_qty=9.5`、`qty_available=12.5`；B：`free_qty=21.25`。确实按库位算且扣了预留。样本中所有 `free_qty` 都是有限 JSON 数字，允许小数；仍须保留 R6 的有限数校验、向下取整与负数截零 |
| many2one            | `uom_id`、`currency_id`、`company_id`                                                                                                            | 非空值为 `[整数id,展示字符串]`，不是对象；本样本 `uom_id=[1,"Units"]`。未构造空 many2one；客户端不能据此免除形状校验                                                                   |
| 归档过滤            | 库存请求去掉 `active_test:false`                                                                                                                 | 归档项消失；显式 false 才带回                                                                                                                                                          |
| 数据库请求头        | 加 / 不加 `X-Odoo-Database`                                                                                                                      | 只有一个已初始化库时，两版均成功且结果相同；指定不存在的库返回 HTML 404。多库且无法自动选择的情况未测，不能据此删掉可配置请求头                                                        |
| 产品第一页 / 第二页 | `domain=[["default_code","!=",false],["sale_ok","=",true]]`，`fields=["default_code","uom_id"]`，`order="id asc"`，`limit=30`，`offset=0/30`     | 分别 30 / 5 行，按 id 升序且无交叠；两条重复料号都保留，无料号、不可销售、归档、已删项均不在默认分页里                                                                                 |
| 分页排序 / 归档     | `order="id desc",limit=3`；另用 `context={"active_test":false},limit=100`                                                                        | 前者取最大的 3 个在售 id，倒序；后者返回 36 条，额外包含归档产品。自动映射应保留默认 active 过滤，并显式固定排序                                                                       |
| `read` 对照         | `product.product/read`，`ids=[有效id,已删id]`，`fields=["free_qty","uom_id","active"]`                                                           | 两版均 200，仅返回有效项；只传已删 id 返回 `[]`。这组字段下没有出现 spec 所述整批报错；仍按 spec 选择 `search_read`                                                                    |

`check()` 的可行调用与形状：

| 目的                   | 最小读取与返回                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单公司读取币种         | `res.company/search_read`：`{"domain":[],"fields":["currency_id"],"limit":1,"order":"id asc"}` → `[{"id":1,"currency_id":[6,"CNY"]}]`。若直接使用展示字符串，本次单公司环境只需它与下行两次调用                                                                                                                        |
| 库位存在               | `stock.location/search_read`：`{"domain":[["id","=",locationId]],"fields":["id"],"limit":1}` → `[{"id":locationId}]`；不存在则 200、`[]`。`locationOk` 按是否命中该 id 判断                                                                                                                                            |
| 确认币种代码而非展示名 | 再调 `res.currency/read`：`{"ids":[6],"fields":["name"]}` → `[{"id":6,"name":"CNY"}]`，也验证了相同条件的 `search_read` 可用。单公司合计三次调用，不依赖展示名                                                                                                                                                         |
| 明确读取机器人默认公司 | `res.users/context_get {}` → `{lang,tz,uid}`，本样本没有 `allowed_company_ids`；再用返回的 `uid` 调 `res.users/read {ids:[uid],fields:["company_id"]}` → `[{id,company_id:[整数id,展示名]}]`；之后 `res.company/read {ids:[companyId],fields:["currency_id"]}`，再读币种与库位，共五次。无需已知机器人 id 或管理员权限 |

本次只有一个公司。多公司时第一家可见公司与机器人默认公司是否相同未测，二者不可混称；建议协调者在第 3 步前明确 `companyCurrency` 的公司选择口径。

**3–5. 错误、scope 与到期。** 原样 JSON 媒体类型均为 `application/json; charset=utf-8`；不存在数据库的 HTML 为 `text/html; charset=utf-8`，普通路由的 HTML 为 `text/html;charset=utf-8`（空格不同）。JSON 错误顶层：19 是 `name,message,arguments,context,debug`；20 是 `name,message,arguments,timestamp,context,debug`，额外的 `timestamp` 为整数。`arguments` 为数组、`context` 为对象、`debug` 为字符串；没有 `error` 外壳。样本只留字段、类型与异常类名，遮掉 message / debug 原文。

| 情况 / 触发方式                                                   | 19                         | 20                         | 媒体与形状                                                                                                           |
| ----------------------------------------------------------------- | -------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 错 key、`bearer` 后空 key                                         | 401                        | 401                        | JSON；`name=werkzeug.exceptions.Unauthorized`                                                                        |
| 同用户空 scope key                                                | 200                        | 401                        | 19 返回正常产品数组；20 为上述 JSON 401；`rpc` key 两版均 200                                                        |
| key 到期                                                          | 到期前 200，改到过去后 401 | 到期前 200，改到过去后 401 | 通过 shell 把独立测试 key 的 `expiration_date` 改成过去，JSON 401                                                    |
| 缺权限 / 调私有方法                                               | 403                        | 403                        | JSON；权限不足为 `odoo.exceptions.AccessError`；固定只读客户端不应调用私有方法                                       |
| 不存在模型 / 方法                                                 | 404                        | 404                        | JSON；`name=werkzeug.exceptions.NotFound`                                                                            |
| 不存在的数据库 / 普通 HTTP 路由                                   | 404                        | 404                        | HTML，媒体类型分别为 `text/html; charset=utf-8` / `text/html;charset=utf-8`；不是 JSON 错误对象，只保留 kind、字节数 |
| 给模型级 `search_read` 额外传非空 `ids`                           | 422                        | 422                        | JSON；`name=werkzeug.exceptions.UnprocessableEntity`                                                                 |
| `res.currency/round` 传 `ids` 与未知参数 `unexpected`             | 422                        | 422                        | 同上，入口能检查到的参数绑定错误                                                                                     |
| 不存在字段 `fields=["wsa11_missing"]`                             | 500                        | 500                        | JSON；`name=builtins.ValueError`                                                                                     |
| `search_read` 传未知参数 `unexpected`                             | 500                        | 500                        | JSON；`name=builtins.TypeError`，不是 422                                                                            |
| 非法 domain 运算符、错误类型的 `context.location`、字符串 `limit` | 500                        | 500                        | JSON；均已触发 500，无需人为制造服务崩溃                                                                             |
| 破损 JSON 请求体                                                  | 400                        | 400                        | JSON；参数入口解析失败                                                                                               |
| 对 JSON-2 方法地址发 GET                                          | 404                        | 404                        | JSON；不能当成正常只读 GET 接口                                                                                      |

修改用户组的实验必须通知 HTTP 进程清除权限缓存，否则会把旧权限误认为新权限。19 的独立 shell 在提交后显式调用 `registry.signal_changes()`；20 的提交已触发失效通知，且没有同名公共方法。key 的到期变更也在提交后重新发 HTTP 请求验证，不只看数据库字段。

**6. 最小内置组。** 两版均依次测下列五档，移除库存组后再次失败，排除了只加不减造成的误判。每档都通过真实 HTTP 读取，机器人始终 `base.group_system=false`，未加销售组或管理员组。

| 显式组（按测试顺序）                         | 产品 `default_code,uom_id` | `free_qty,uom_id,active` | 公司 / 币种 / 库位 |
| -------------------------------------------- | -------------------------- | ------------------------ | ------------------ |
| 无组                                         | 403                        | 403                      | 全部 403           |
| 仅 `base.group_user`                         | 200                        | 403                      | 全部 200           |
| `base.group_user` + `stock.group_stock_user` | 200                        | 200                      | 全部 200           |
| 移除库存组，仅保留内部用户                   | 200                        | 403                      | 全部 200           |
| 仅显式 `stock.group_stock_user`              | 200                        | 200                      | 全部 200           |

`stock.group_stock_user` 隐含内部用户权限，单独指定即可跑通，R6 的库存权限不足告警有实际 403 依据。这是本次逐步删减所得的最小内置组组合，没有穷举所有自定义 ACL。补验有效 ACL：库存用户对 `stock.quant`、`stock.move` 有 read / write / create，没有 unlink；对 `product.product` 有 read、没有 write / create / unlink。它不是严格只读账号；连接器自身仍必须只构造约定的只读调用。若要求凭据本身也只能读，需要另定 Odoo 侧自定义权限，不在本步实现。

**7. 耗时与连接。** 同一 Node 22 进程，30 个产品一批，使用 `http.Agent({keepAlive:true,maxSockets:1})`；测第一次新 Agent 请求、之后 20 次，以及禁用 Agent 的另 20 次作对照。分位数按排序后的 nearest-rank 取值；每次均 200。下表单位毫秒，仅为 Colima 本机回环 HTTP，不含 DNS 或 TLS，不能外推同地区公网或跨地区。

| 版本 | 第一次新 Agent 请求 | Agent 后 20 次 p50 / p90 / 最大 | 无 Agent 20 次 p50 / p90 / 最大 | Agent 后 20 次 `reusedSocket=true` |
| ---- | ------------------- | ------------------------------- | ------------------------------- | ---------------------------------- |
| 19   | 9.37                | 10.98 / 17.33 / 18.26           | 14.05 / 25.22 / 28.65           | 0 / 20                             |
| 20   | 18.79               | 15.28 / 23.11 / 29.70           | 12.62 / 16.90 / 19.42           | 0 / 20                             |

两版所有响应均为 `Connection: close`；显式请求 `Connection: keep-alive` 也一样。观察 socket 的 close 事件，独立连接样本在响应结束后 19 约 0.23 ms、20 约 0.17 ms 就关闭，没有进入 Agent 空闲池；这不是 30 秒的空闲超时。等 1 秒后再请求，两版均新建连接、200、`reusedSocket=false`，Node 无错误，没有观察到 `ECONNRESET`。因此没有真正的「保活之后 20 次」分布，也无法在这种直连模式下测到空闲保活连接超时后的复用错误；不能把表中的 Agent 请求称作保活样本。未测反向代理、TLS 或非默认 worker 模式。

**8–10. 交付、清理与交接。** 脱敏样本逐情况保存在 gitignored 的 `var/11-step0/samples/`，以 `19-` / `20-` 加情况名区分，含请求参数、状态码、原样媒体类型、返回字段、权限状态与 20 次逐请求耗时；不含 key、错误全文、HTML 原文或 Odoo 源码。19 为补齐检查调用又单独起过一套环境，补验 fixture 与原库存 fixture 分文件保留。本任务创建的 19 / 20 容器均以 `docker rm -f -v` 删除，初始化容器也以 `-v` 删除，匿名卷随之删除；本任务网络已删除。最终 `docker ps -a` 仍列出一个其他步骤创建的 `wsa11-` 前缀容器，未停止、删除或连接它；所以全机「无此名前缀」条件未满足。本任务命名下无容器、卷或网络残留。`ps` 被系统权限拒绝，无法独立列进程核对；所有探针执行会话均已结束，没有主动留下后台进程。

**与 spec 不符之处（已修订 spec，见 2026-10-31 的 `Revisions:`）。**

1. R4 / R8 的保活是客户端能力，不是 Odoo 直连的保证。建议保留 Agent，同时明确直连可能每次重连；跨地区测试要同时测真实入口与实际复用率，不能从本机 p90 推导 300 ms / 1 秒预算成立。若要求代理提供保活，把入口条件写清后再测。
2. R6 错误表的 500 归类仍可照状态码执行，但配置错误也可能变成 500。建议在前置 JSON-2 说明与第 3 步自测中明确：错字段 / 透传错误参数可为 500，按现有表归 `server`、冷却 30 秒；入口绑定错误才可能 422，归 `invalid`、冷却 10 分钟。不能按响应文字把 500 猜成配置错误。
3. R6「`read` 遇已删 id 会整批报错」在两版的本次字段组合下不成立。建议删去这句绝对断言，保留 `search_read` 及其省略已删项的实测契约；不主张更换客户端方法。
4. R2 的 `companyCurrency` 没有说明多公司选哪一家。建议选机器人默认公司，经 `context_get` → 用户 `company_id` → 公司 `currency_id` → 币种 `name`，加库位共五次，均在非管理员账号上调通；单公司三次路径可作更小的集成探针，不把展示字符串当币种字段。

给第 3 步的要点：成功数组与错误对象都无外壳；20 多一个 `timestamp`；先按状态码分类，再处理成功响应的媒体类型与结构（HTML 404 仍是 404）；媒体类型忽略 charset；many2one 取首个整数 id；分页固定 `id asc`；归档 false、已删缺席、小数 `free_qty`、重复料号都要进入模拟器；500 与 422 都需按上述触发方式覆盖。第 7 步初始化建议用布尔开关 `--without-demo`：本次的 `--without-demo=all` 在两版都警告后按 True 执行（19 另核对两模块的 `demo=false`）；造预留时，两版 `stock.move` 都没有旧的 `name` 字段，19 的单位字段是 `product_uom`，20 是 `uom_id`；这只是集成造数据差异，不改变客户端只读接口。

未完成部分：跨地区实测未授权，未进行；直连没有可复用的保活连接，真正保活分布与空闲复用错误无法取得，留到第 7 步经 nginx 测。第 0 步保持未勾选，等跨地区实测。

本步验证：两版样本断言通过（库存、归档 / 删除、分页、权限、scope / 到期、错误形状、检查调用与每版 20 + 20 次耗时），143 个 JSON 样本完成脱敏检查；其余 plan 小节与复选框逐字节未改。`pnpm -s format:check` 通过，`git diff --check` 通过；相对 `origin/dev` 的新增行无本机绝对路径或超长假企微 id。按本任务只跑格式门禁，lint / typecheck / test / test:locked 未跑；无新增或受影响自测。临时探针与日志已清理，只保留脱敏样本。

### 第 1–6 步（2026-10-31，Codex 执行，协调者审查）

都按 plan 的「验」通过；全量测试由各 PR 的 CI 跑。协调者审查时另外修的，自测当时没有发现：

| 步骤 | PR   | 问题                                                                                                                                                                                           | 修法                                                                                                                                |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1    | #386 | `agent.on('free')` 设 30 秒空闲计时，排在 Node 自己的监听器之后，盖掉了服务端 `Keep-Alive: timeout=N` 算出的更短计时，会复用已被对端关闭的连接                                                 | 改用 Agent 的 `timeout` 选项，自测验提示 `timeout=5` 时空闲计时是 4 秒                                                              |
| 2    | #385 | 任务说明不许改 `state-manifest`，lint 却要求登记两张表与两组列                                                                                                                                 | 协调者补 4 条静态登记                                                                                                               |
| 4    | #388 | 单个产品读不到被算成连接器故障，含它与不含它的批次会来回「不可用 / 已恢复」                                                                                                                    | 只计数告警，不进健康状态                                                                                                            |
| 5、6 | #390 | 映射按条目 code 存链接，工业包按 `normalizePartNo(partNo)` 查，两路各自的假门面用的键都和调用方一致，合起来所有查询都对不上：静默退回产品库值、自动批准全转人审、不告警；spec 没写 code 的语义 | `sources.erp` 的 code 一律是条目 code；新增贯穿用例「ERP SEAM」，走真实映射、真实客户端、registry、工业工具，键改回旧写法时它会失败 |

第 5、6 步在 spec 里补的细节见 2026-10-31 的第二条 `Revisions:`。

### 第 7 步 · 本机集成（2026-10-31，Codex 执行，协调者审查）

本机部分完成，协调者已审查：真 Odoo 与客户端、模拟 Odoo 没有不一致。新增 `scripts/odoo-integration.ts`，未改 `src/`、spec、依赖、CI 或测试链。运行命令：`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock pnpm exec tsx scripts/odoo-integration.ts`，最终退出码 0，输出 `INTEGRATION PASS: Odoo 19 + 20` 与 `CLEANUP PASS`。下一步为第 8 步审查；第 0 步跨地区实测仍等 owner 授权，本步没有进行。

**环境与断言。** Node 22.22.0；Odoo 分别为 `19.0-20261015`、`20.0-20261015`，使用 `postgres:17`（这三个镜像与第 0 步的 digest 相同）；代理使用 `nginx:latest`，实际版本 `1.31.3`，镜像 id `sha256:fa25dc4482506b0786a17a167b25348e6ca303ae0213404416db35441c75af29`。仅用本机已有镜像，全部端口只绑回环。两版各装 `sale_management`、`stock`，初始化用布尔开关 `--without-demo`；机器人只指定 `stock.group_stock_user`，断言无系统管理员与库存经理组，key 的 scope 为 `rpc`。key 只在内存中传递，不落盘、不输出。

每版创建 34 个合成 Odoo 产品与 34 个我方条目：30 个正常产品、2 个同料号 `6206-2RS`、1 个单位不符 `6207-2RS`、1 个归档 `6208-2RS`；我方另有不存在的 `6209-2RS`。两版 `autoMapProducts` 均断言已映射 30、未映射 2、冲突 1、单位不符 1，且链接里的整数 id 与 fixture 一致。首个产品 A 库位实物 12.5、预留 3，ORM 断言 `free_qty=9.5`，真实客户端返回取整后的 9；B 库位 `free_qty=21.25`，返回 21。按 id 读取归档产品得到 `active=false`。经真实 registry → `packSources().erp.availability` 返回 30 个我方编号对应的库存，逐项与 fixture 一致；`check` 均为 `CNY`、`locationOk=true`。20 的空 scope key 调 `check` 得 `ErpError('auth')`（客户端由 HTTP 401 归类）。未发现需要改产品代码的 Odoo 契约差异；fixture 只在 19 调 `registry.signal_changes()`，20 无此方法。

**耗时。** 全为本机回环 HTTP，不含 TLS 或跨地区网络；每次读 30 个产品，客户端新建 Agent 的首个请求单列，后续 20 次按最近秩法统计，相邻请求间隔 1,100 ms，每次库存请求截止时间 1 秒。以下单位均为毫秒：

| 入口                    | 首个请求 | 后续 p50 | 后续 p90 | 后续最大值 |
| ----------------------- | -------: | -------: | -------: | ---------: |
| Odoo 19 直连            |    31.04 |    27.16 |    32.63 |      71.59 |
| Odoo 20 直连            |    37.38 |    16.66 |    30.38 |      34.02 |
| Odoo 20 经 nginx 1.31.3 |    43.86 |    29.83 |    32.77 |      44.76 |

**保活。** nginx 明确配置 `keepalive_timeout 4s`；专用日志仅记 `$connection $connection_requests $status`。21 个库存请求的连接号相同、请求序号为 1–21、状态均为 200，复用 20/21（95.24%），后续 20 次复用率 100%。同一客户端随后空闲 5,500 ms，再请求为新连接、序号 1、200，耗时 26.71 ms，`ok`，无 `network` 错误。这些数据只证明本机代理入口的保活，不能据此断定远端 R8 目标成立。

**清理与验证。** 脚本工作总限时 15 分钟，每条 Docker 命令另有限时，`finally` 按本次登记的确切名称删除容器（含匿名卷）、数据卷与网络，并核对列表及在途子进程计数。开发中的信号探针发现应用导入期的默认停机处理会提前退出，探针资源已单独清理；独立集成脚本随后接管信号，SIGINT、SIGTERM 两次子进程演练均退出 1、`cleanup=true`，正常集成与普通失败路径也通过清理。最终 `docker ps -a`、`docker volume ls`、`docker network ls` 的 `wsa11-it-` 结果均为空。独立的 `/bin/ps` 被执行环境拒绝（`operation not permitted`），无法补做全局进程列表核对；脚本登记的 Docker 子进程计数为 0，演练进程均已退出。

门禁：`pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck` 均通过；路径检索只命中 `scripts/check-boundaries.selftest.ts`，额外运行通过 270 项。`git diff --check` 通过，新增行无本机绝对路径或超长假企微 id；锁定文件未改。按本步例外不跑 `pnpm test`、`test:locked` 或产品自测；未调用真实模型、真实 ERP、浏览器或生产服务，未提交、推送或开 PR。

### 第 8 步 · 真镜像回滚演练（2026-10-31，Codex 执行，协调者审查）

**环境与镜像。** 本机 Colima，第一条演练命令 `docker version` 退出 0，客户端与服务端均可达；默认 Docker 配置的读取警告按任务约定忽略，后续使用临时配置目录及本机已有的 Compose 插件。两个镜像均按仓库原有 `Dockerfile` 构建，退出 0：

| 镜像                | 来源与实际镜像 ID                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wsa11-drill:pre11` | `git archive demo-v11` 解到 `var/wsa11-drill/pre11`；tag 对应提交 `10f56dc5`，镜像 `2e33ae166a1b`。镜像有附件与工业 runtime，没有连接器 registry，标记检查退出 0。 |
| `wsa11-drill:cur`   | 构建前干净的当前工作区 `68638d9e`，镜像 `677d696807d7`，`APP_REVISION=68638d9e`。                                                                                  |

**库与数据。** 一次性 `pgvector/pgvector:pg17` 容器 `wsa11-drill-pg`、命名卷 `wsa11-drill-pgdata`、网络 `wsa11-drill-net`；PG 只映射回环空闲端口 `53547`，应用依次复用回环端口 `53548`。沿用 `deploy/db-init/roles.sh` 初始化角色与 vector，以 `cur` 内的 `src/db/migrate.ts`、`agent_owner` 跑迁移，退出 0；23 条落库哈希逐条与当前镜像一致。通过 `insertTenant` 建 `standard` 工业租户、`importConfig` 导入 SOP v1 与 40 条已上架合成 `part`，通过 `sealConnectorSecrets`、`insertErpConnector`、`upsertErpItemLink` 写入 1 行 active 连接器与 3 行映射，造数探针退出 0。地址为 `https://erp.example.test`，凭据与密钥均为合成值，未连接真实 ERP。三个映射编号是 `bearing-01`、`bearing-02`、`fastener-01`；询价型号 `6205-2RS` 的产品库库存为 30 件、缺货交期 7 天。

**A–D 实际结果。** 应用始终使用 DB 配置与会话存储开关、`TENANCY_STRICT=1`、`LLM_MOCK=1`，由镜像内真实 server 启动；临时包装入口只在健康检查后读取同进程的包门面。三轮均经 HTTP `POST /api/chat` 发送同一句 `6205-2RS 40件`，没有调用真实模型。模拟器会话按既有 demo 行为落在共享的 `var/sessions.json`，因此降级系统消息在该文件核对，不冒充已落入 PG 的真实客户消息。

| 环节       | 实际结果                                                                                                                                                                                                                                                                                               | 退出码与证据                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A 前滚基线 | `cur` 的 `/healthz` 为 200，revision 为 `68638d9e`；同进程 `sources.erp.active('part')=true`、已映射 3 条。ERP 被严格出站拒绝，按产品库回答，系统消息恰好 1 条。                                                                                                                                       | 启动与询价探针均 0；HTTP 200；`[erp] drill-industrial search_read 1 25 egress`。系统消息为「ERP 这次没查到 1 个型号的库存，按产品库的库存回答」。                                                                  |
| B 退回     | 停 `cur`，`pre11` 连同一个库启动，`/healthz` 为 200、revision 为 `demo-v11`。只警告「库里多出 1 条镜像里没有的迁移（库比镜像新），照常启动」，没有迁移错误；询价成功，旧版日志无任何 ERP 字样，新会话无 ERP 降级消息。连接器与映射的完整行内容与造数后逐字节相同。                                     | 启动、询价、行快照检查均 0；手动执行 `bash deploy/rollback-guard.sh <演练目录> wsa11-drill:pre11 wsa11-drill 53548` 退出 0、无输出。使用真实目标镜像探测既有能力，没有新增或虚构 `pre-11` 档；未运行 `deploy.sh`。 |
| C 再前滚   | 再启 `cur`，`/healthz` 为 200、revision 为 `68638d9e`；同一服务进程再次输出 `sources.erp.active('part')=true mapped=3`。无需重新导入、映射或迁移，完整连接器与映射行仍逐字节不变；再次询价正常并留下新会话的降级消息。                                                                                 | 启动、询价、行快照检查均 0；`[erp] drill-industrial search_read 1 23 egress`，证明重新装载后实际尝试读取。域名仍不可用，未把降级回答记成实时库存读取成功。                                                         |
| D 沙箱回收 | 用新版 `withNewSandboxTenant` 创建合成沙箱，经 repo 写入 1 行连接器与 1 行映射，再以 `endSandbox` 令其到期。用真实 `pre11` 镜像中的 `SandboxReaper.tick()` 调新版库函数，成功删掉沙箱；旧 reaper 日志完整记录新增计数 `"erp_connectors":1,"erp_item_links":1`，没有报错，标准租户的 1 / 3 行原样保留。 | 沙箱造数与旧版回收探针均 0；日志有 `[sandbox] deleted` 与新增两项计数；沙箱租户查询为 0 行，后续标准租户行快照检查退出 0。                                                                                         |

三轮对客回复逐字相同：

```text
6205-2RS 数量40，金额360.00元，现货 30 件，其余约 7 天
合计360.00元
```

独立汇总探针退出 0：逐字比较 A / B / C 回复，分别核得 1 / 0 / 1 条 ERP 系统消息；A、B、C、D 后的两张新表完整行快照均与造数后相同（含密文与时间戳），指纹始终为 `d0de7c7ca665fd9ece7821a980bc5690`。应用日志、健康检查与询价响应中均未出现合成 API key 明文、密文 hex 或 base64。三次 `docker stop -t 15` 均退出 0，容器均按既有 SIGTERM 处理以 143 退出，日志没有停机超时或异常；不是启动失败。

**清理、门禁与交接。** 本轮容器（含一次性探针）、命名卷、网络、两个最终镜像及本轮新建的中间镜像（共 56 个镜像 ID）已删除；未停止、删除或连接其他项目的容器。清理脚本退出 0，`docker ps -a`、`docker volume ls`、`docker network ls`、`docker images` 四项均退出 0，`wsa11-drill` 前缀匹配数均为 0；`var/wsa11-drill` 临时目录已删除。独立 `/bin/ps` 核对被执行环境以 `Operation not permitted` 拒绝，无法补做全局进程列表检查；本轮构建、应用、探针与清理执行会话均已结束，没有主动遗留后台进程。`pnpm -s format:check` 与 `git diff --check` 通过；按本任务只改 plan 的例外，不运行其他门禁或自测，受影响自测清单为空，锁定八文件未改。没有发现产品问题或与 R11 的预期差异，需要确认的问题：无。仅新增本节，第 8 步仍未勾选；中期审查、其余验收与 owner 确认由协调者继续，本轮未提交、推送或开 PR。

### 第 8 步 · 只读审查（2026-10-31，Codex 执行，协调者裁决）

范围 `df85a025...HEAD`。没有 blocker；出站防护、凭据路径、没有连接器时的行为、租户隔离与生命周期、回滚五个角度没发现问题，其中禁止地址另用 14 种写法的离线探针核过。报了两条 major，协调者裁决：

| 意见                                                                                                                             | 裁决                                                                                                                                                                                  | 处理                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 没有固定本轮的库存视图：缓存 29 秒时 `quote_items` 读到 7，模型两秒后建单时被刷新成 0，对客说「现货 7 件」，订单冻结「约 12 天」 | 成立，违反不变量 8                                                                                                                                                                    | registry 加本轮视图，第一次得到的结果（含没取到）固定到本轮结束；自测验两种情况 |
| 进入冷却后 `availability()` 仍返回 60 秒内的旧值，可能继续自动批准；R6 原文写「直接返回空」                                      | 不算缺陷，是 spec 两句话冲突：工具与护栏读 `fresh()`，返回空也改变不了它们看到的值；60 秒内的 ERP 值比产品库更准，也在 spec 接受的新鲜窗口内；验收 3 的场景是没有新鲜值，行为不受影响 | 代码不改，改 R6 的句子                                                          |

两处都记进 spec 2026-10-31 的第三条 `Revisions:`。

## Open

（无。）

## 已定

- 2026-10-31 owner 定跨地区实测不在 11 里做，推迟到接第一家真实商家时，在它的真实入口上测（spec 2026-10-31 的第四条 `Revisions:`、「后续」第 1 条）。验收 9 相应改写，第 0 步勾掉。
- 2026-10-29 owner 定原开放问题 1：第一期只读，写回整段移出 11、另起 spec（spec 第二条 `Revisions:`）。
- 2026-10-29 owner 定开放问题 1–5，全部照推荐（spec 第三条 `Revisions:`）：
  - 只支持 Odoo 19、20 的 JSON-2；
  - 料号对照不放进 11；
  - 演示租户不接 Odoo，验收在本机一次性容器上做；
  - 连接器凭据共用 `CHANNEL_SECRETS_KEY`；
  - 取不到新鲜值时退回产品库的值，不自动批准，给顾问留系统消息。

## 交接记录

### 交接（2026-10-29，起草）

- spec 与本 plan 起草为 `draft`。依据：10「后续」第 1 条、工业品询价调研（另记）、对照代码的只读调研，以及 2026-10-29 对 Odoo 17.0–20.0 公开文档与源码的核对（结论见 spec「背景与问题」）。
- 起草时发现与原先设想不同的几处，已写进 spec：Odoo 20 已发布、17 已停止发镜像，故第一期定为 19、20 的 JSON-2；18.0 起 API key 会到期；按仓库查库存的 context 键 17、18 不同，改用 `location`；Odoo Online 只有 Custom 方案开放外部接口；Odoo 标准版没有客户料号表。

### 交接（2026-10-29，评审修订与 owner 定只读）

- 起草期评审（一路 Opus，只读，对照代码并核对 Odoo 文档与源码）给出 2 条阻断、9 条主要与若干次要；同日 owner 定第一期只读。spec 按第二条 `Revisions:` 就地修订，本 plan 随之重排：
  - 删掉写回的全部内容（表、任务、通知、命令、回滚检查、相关步骤）；
  - 出站防护补 IP 字面量；交期只用产品库；新鲜值一个定义四处共用；每轮截止时间、预热、单路限速与保活；key 到期与 scope；不加 pre-11 回滚档；头部改部分取代；集成脚本进程内注入；工业包的 `erp` 声明挪到第 4 步；补 `package.json` 与 `sandbox_tenant_purge`。
- 行号已按 `origin/dev` `c5cda19a` 复核。
- 下一步：向 owner 讲通俗版，定开放问题 1–5；是否翻 `ready` 由 owner 决定。

### 交接（2026-10-29，owner 定开放问题）

- 已向 owner 讲通俗版；开放问题 1–5 全部照推荐（spec 第三条 `Revisions:`）。
- spec 仍为 `draft`，随本 docs PR 进 `dev`；是否翻 `ready` 由 owner 决定。翻 `ready` 的 PR 同时改 AGENTS.md（R3、R4 两条原文），给 ADR-003 与 10 加反向的 `Superseded in part by:`，给 03、04、05、08 加 `Amended by:`，主参考「阶段 8」加一条。
- 开工要等 12 implemented（R7 改的工业包文件与 12 重叠）。

### 交接（2026-10-29，owner 定 ready）

- spec 翻 `ready`；AGENTS.md 的两条规则、ADR-003 与 10 的反向行、03 / 04 / 05 / 08 的 `Amended by:`、主参考「阶段 8」同一 PR 补上。
- 下一步：12 implemented 之后开工第 0 步。第 0 步里「从线上服务器所在地区测远端 Odoo」要 owner 当次授权。

### 交接（2026-10-31，第 0 步本机部分）

- owner 定开工，Codex 并行：第 0、1、2 步同时派出。第 1、2 步用不到实测结果，但都等本节合入 `dev` 之后才合。
- 第 0 步本机部分完成，见「实施记录」；spec 按实测就地修订（第五条 `Revisions:`），只改事实与细节，不改决定。第 7 步加了经 nginx 验证保活。
- 12 的预取已拆成 `textPrefetch`、`confirmPrefetch` 与总入口，第 6 步按当前行号改，不按 spec 里的旧行号。
- 响应样本（143 个脱敏 JSON）在协调者本机、不进仓库，第 3 步派活时交给 Codex。
- 下一步：合入第 1、2 步，再派第 3 步。

### 交接（2026-10-31，第 1–7 步）

- 第 1–7 步完成，见「实施记录」。第 0 步的框还没勾，等 owner 定跨地区实测怎么做（「Open」）。
- 第 7 步脚本 `scripts/odoo-integration.ts` 能重跑，一行命令写在脚本头部；镜像留在本机。
- 下一步：第 8 步中期审查与回滚演练。

### 交接（2026-10-31，第 8 步）

- 第 8 步完成：只读审查与真镜像回滚演练见「实施记录」，演练用的镜像不含审查后的本轮视图修复，那处修复只改进程内逻辑，不影响 R11 的结论。
- 本机能做的都做完了。跨地区实测 owner 已定推迟（「已定」）。
- 下一步：第 9 步上线 rc（不配连接器），等 owner 当次授权。上线前先确认 #391–#393 与跨地区决定的 docs PR 都已合入、线上还是 `demo-v11-rc2`，然后从 `dev` 打 rc。
