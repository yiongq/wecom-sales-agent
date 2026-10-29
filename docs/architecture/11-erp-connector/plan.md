# 11 · 外部业务系统连接器 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本 spec 现为 `draft`。

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

- [ ] 0. 开工核对与 Odoo 实测。
  - 做：
    - 对照 spec 引用的行号核对现状（12 合入后行号会动），差异记进实施记录。
    - 本机一次性 `odoo:19`、`odoo:20` 容器（各自配 `postgres`），装 `sale_management`、`stock`，不装演示数据；用 `odoo shell` 建低权限机器人用户与 scope 为 `rpc` 的 API key。实测：
      - JSON-2 的请求、错误与 `Content-Type` 形状（401、403、404、422、500）；many2one 的返回形状；
      - `product.product/search_read` 带 `context.location` 与 `active_test: false` 读 `free_qty`、`uom_id`、`active`，含一个已删的 id；
      - 20 上空 scope 的 key 被拒；机器人用户读产品与库存所需的最小组；
      - 读 30 个产品的耗时（首个请求与保活之后）。
    - owner 授权后，从线上服务器所在地区测到一台远端 Odoo（境内另一地区云主机上的一次性容器；Odoo Online 试用库若开放外部接口也测）：DNS、TLS 握手、首个请求、保活连接上后续请求的耗时。
  - 验：结果记进实施记录；与 spec 假设不符的（尤其 R8 的 1 秒截止时间对远端 Odoo 是否够用），先修订 spec（`Revisions:`）或记进 Open。
  - 依赖：无。
- [ ] 1. 出站防护（R4）与边界检查（R2）。
  - 文件：`src/net/egress.ts`、`src/net/egress.selftest.ts`、`scripts/check-boundaries.ts` 与其自测、`package.json`。
  - 做：`createEgress`、`normalizeBaseUrl`；字面量预检与 `lookup` 钩子里的解析校验；带超时的 c-ares 解析器；放行范围；不跟随重定向；截止时刻、大小上限；保活 `Agent`；只记错误码；R2 的四条边界检查。
  - 验：
    - 验收 7 的每一种地址在自测里被拒，错误与日志里没有地址；
    - 注入的解析器给一公一私时整次拒绝；连接用的是校验过的地址；保活连接复用；
    - 边界检查的正反例（验收 10）。
  - 依赖：0。
- [ ] 2. 凭据封装与迁移（R3、R5、R11）。
  - 文件：`src/channels/secrets.ts`、`src/connectors/secrets.ts`、新迁移与 journal、`src/db/schema.ts`、`src/db/repo/erp.ts`、`src/db/erp.selftest.ts`、`package.json`。
  - 做：
    - `sealJson` / `openJson`，渠道账号的两个函数改为薄封装、密文格式不变；连接器凭据的封装与解封；
    - 迁移：两张表（FORCE RLS、授权、CHECK）；`sandbox_tenant_purge` 的新版本（`-- migration-allow: create-or-replace` 标注），删除与核对清单加两张表，其余与 0021 版逐字比对不变；
    - repo：连接器与映射的读写。
  - 验：
    - 03 的渠道自测原样通过；连接器密文与渠道密文互相解不开；
    - 真实 PG 上 RLS、列级授权、`erp_connectors` 无 DELETE、`erp_item_links` 有 DELETE 通过；`src/db/sandbox.selftest.ts` 的覆盖检查通过；迁移检查通过。
  - 依赖：0。
- [ ] 3. Odoo 客户端与模拟 Odoo（R2、R6）。
  - 文件：`src/connectors/types.ts`、`src/connectors/odoo.ts`、`src/connectors/odoo-mock.ts`、`src/connectors/connectors.selftest.ts`、`package.json`。
  - 做：照第 0 步实测的形状构造 `search_read`、`products`、`check` 的请求；按状态码与媒体类型归类错误；数值校验；`database` 字符集。模拟 Odoo 可注入延迟、超时、401、403、404、500、HTML 502、已删产品、坏数值。
  - 验：请求头与请求体逐字段；R6 错误表逐行；模拟 Odoo 与第 0 步实测的形状一致。
  - 依赖：1。
- [ ] 4. 装载、新鲜值、截止时间与包门面（R2、R3、R6、R10）。
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
- [ ] 5. 产品映射与命令行（R5、R9）。
  - 文件：`src/connectors/mapping.ts`、`src/cli/erp-connector.ts`、`src/cli/erp-connector.selftest.ts`、`package.json`。
  - 做：映射的自动、手工与删除；`show`、`add-odoo`、`set`、`set-secrets`、`check`、`map`、`rekey`；拒绝沙箱租户与文件存储；凭据文件规则同 `channel-account`；`--key-expires` 必填。
  - 验：
    - 验收 6（映射函数注入模拟连接器测）；
    - 子进程测：输出与报错扫不到地址、API key、密文；地址校验；到期日校验；
    - `rekey` 前后都能解（验收 8 的一部分）。
  - 依赖：4。
- [ ] 6. 工业包接入（R7）。
  - 文件：`src/packs/industrial/live.ts`、`src/packs/industrial/tools.ts`、`src/packs/industrial/runtime.ts`（`priceLine` 包一层）、`src/packs/industrial/quotes.ts`、`src/packs/industrial/guards.ts`、`src/packs/industrial/turn.ts`（预热）、`src/industrial-erp.selftest.ts`、`package.json`。
  - 做：`live()`；预取一次预热；三个工具取新鲜值；`priceLine` 与自动批准只认 `fresh()`；护栏证据（主回复与跟进）改按新鲜值；退回产品库值时的系统消息（30 分钟去重）。
  - 验：
    - 验收 1（工具结果、订单与护栏输出逐字节对照 11 之前）、验收 2、3，验收 4 的预热部分；
    - v2 文件与 PGlite 两条全过，对当时的快照 0 差异；工业 10 套自测与 `eval/sim/industrial` 自测原样通过。
  - 依赖：4（与第 5 步可并行，只同改 `package.json`）。
- [ ] 7. 本机集成（R12）。
  - 文件：`scripts/odoo-integration.ts`（不进 `pnpm test`）。
  - 做：起 `odoo:19`、`odoo:20` 一次性容器，建机器人用户、scope 为 `rpc` 的 key、合成产品与库存；进程内用 `createEgress(baseUrl, { allowLoopback: true })` 构造连接器，跑 `check`、映射、`stock` 与门面的 `availability`；20 上再用一把空 scope 的 key 验 401；记耗时；外层超时，结束删容器。
  - 验：验收 9；结束后 `docker ps -a` 与 `ps` 没有残留。
  - 依赖：5、6。
- [ ] 8. 中期审查与回滚演练。
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

（无。）

## Open

（无。）

## 已定

- 2026-10-29 owner 定原开放问题 1：第一期只读，写回整段移出 11、另起 spec（spec 第二条 `Revisions:`）。

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
