# 11 · 外部业务系统连接器 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本 spec 现为 `draft`。

## 开工条件

缺一条就停下，告诉 owner：

1. 本 spec 已由 owner 定为 `ready`，开放问题 1–7 已定。翻 `ready` 的 docs PR 同时：
   - 把 R3、R4 的两条规则原文写进 `AGENTS.md`；
   - 给 02、03、04、05、08、09、10 加 `Amended by:`，主参考「阶段 8」加一条。
2. 12 已 `implemented`；09、10 已 `implemented`。
3. 本机能跑四个门禁、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。
4. 第 0 步与第 9 步要下载并运行 `postgres` 与 `odoo:19`、`odoo:20` 官方镜像（各约 1.5 GB），每次 owner 当次授权。
5. 上线（第 11 步）与给任何租户配连接器，都要 owner 当次授权；真实 ERP 的地址与凭据由 owner 提供、按 R9 的凭据文件规则录入，Claude 不经手明文。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`（密钥与出站两条规则已按 R3、R4 修订）、本 spec、10 spec 的 R4–R6 与第 21 步记录、12 spec 的 R8、R10、`docs/spec-driven-dev.md`、本文件的「Open」「已定」「交接记录」，再看 `git log -5`。
- 锁定的 8 个文件一个字节都不改；旅游前缀与四个哈希全程不变；没有连接器时工业工具结果逐字节不变（不变量 6）。
- 测试随批合入，每一批合并时是绿的；新自测登记进 CI 分片。
- 数据只用合成的：产品照 10 的合成规则，域名用 `erp.example.test`；不提交真实 ERP 地址、数据库名、API key、Odoo 的代码与文档原文。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、凭据、商家的 ERP 数据。
- 容器与后台进程用完即删，外层套超时（macOS 用 `perl -e 'alarm N; exec @ARGV'`）。

## 步骤

- [ ] 0. 开工核对与 Odoo 实测。
  - 做：
    - 对照 spec 引用的行号核对现状（12 合入后行号会动），差异记进实施记录。
    - 本机一次性 `odoo:19`、`odoo:20` 容器（各自配 `postgres`），装 `sale_management`、`stock`，不装演示数据；用 `odoo shell` 建低权限机器人用户与它的 API key。实测：
      - JSON-2 的请求与错误形状（401、403、404、422、500）；many2one 在 `read` 里的返回形状；
      - `product.product/read` 带 `context.location` 读 `free_qty`、`sale_delay`、`uom_id`、`active`；
      - `sale.order/create` 带 `price_unit` 后读回是否原样保留；按 `origin` 的 `search_read`；
      - 机器人用户读产品与库存、建报价单所需的最小组；
      - 读 30 个产品、建一张 30 行报价单的耗时。
  - 验：结果记进实施记录；与 spec 假设不符的，先修订 spec（`Revisions:`）。
  - 依赖：无。
- [ ] 1. 出站防护（R4）与边界检查（R2）。
  - 文件：`src/net/egress.ts`、`src/net/egress.selftest.ts`、`scripts/check-boundaries.ts`（及其自测）。
  - 做：`createEgress`、`normalizeBaseUrl`、禁用段表、`lookup` 钩子里校验并连接、不跟随重定向、总时限、大小与类型上限、只记错误码；R2 的三条边界检查。
  - 验：
    - 验收 6 的每一种地址在自测里被拒，错误与日志里没有地址；
    - 解析结果一公一私时整次拒绝；连接用的是校验过的地址；
    - 边界检查的正反例（验收 10）。
  - 依赖：0。
- [ ] 2. 凭据封装与迁移（R3、R5、R8 的表）。
  - 文件：`src/channels/secrets.ts`、`src/connectors/secrets.ts`、新迁移与 journal、`src/db/schema.ts`、`src/db/repo/erp.ts`、`src/db/erp.selftest.ts`。
  - 做：
    - `sealJson` / `openJson`，渠道账号的两个函数改为薄封装、密文格式不变；连接器凭据的封装与解封；
    - 迁移：三张表（FORCE RLS、授权、CHECK）、`jobs.kind` 的 CHECK 加 `erp_quote_push`（`-- migration-allow: drop` 标注）；
    - repo：连接器、映射、写回状态的读写。
  - 验：
    - 03 的渠道自测原样通过；连接器密文与渠道密文互相解不开；
    - 真实 PG 上 RLS、列级授权、无 DELETE、CHECK 通过；迁移检查通过。
  - 依赖：0。
- [ ] 3. Odoo 客户端与模拟 Odoo（R5–R8 用到的五个方法）。
  - 文件：`src/connectors/types.ts`、`src/connectors/odoo.ts`、`src/connectors/odoo-mock.ts`、`src/connectors/connectors.selftest.ts`。
  - 做：照第 0 步实测的形状构造请求、映射错误码、校验数值；模拟 Odoo 可注入延迟、超时、401、500、重复 `origin`、读回改价。
  - 验：请求头与请求体逐字段；错误码映射；数值校验的边界；模拟 Odoo 与第 0 步实测的形状一致。
  - 依赖：1。
- [ ] 4. 装载、缓存、熔断与包门面（R2、R3、R6、R10）。
  - 文件：`src/connectors/registry.ts`、`src/core/pack-api.ts`、`src/core/engine/sources.ts`、启动装载的接线点（与 `initChannels` 同处，`src/boot.ts`）、`src/tenancy/state-manifest.ts`、`src/ops/alert.ts`。
  - 做：
    - 启动按租户装载并解密，解不开按停用并告警；沙箱与文件存储下不装；
    - `PackSources.erp` 的 `active` / `availability` / `peek`；`PackRuntime.erp` 声明；
    - 60 秒缓存、10 分钟 `peek`、超时冷却 30 秒、`auth` 冷却 10 分钟、并发 4；
    - 三项租户状态登记；`AlertKey` 加 `erp`；日志格式。
  - 验：
    - 缓存、冷却、并发上限的时序用注入时钟测；
    - 一轮至多等一次超时；
    - 严格租户模式下两个租户的缓存互不串；
    - 没有连接器时 `active` 恒为假，旅游与工业自测原样通过。
  - 依赖：2、3。
- [ ] 5. 产品映射与命令行（R5、R9，`push` 除外）。
  - 文件：`src/connectors/mapping.ts`、`src/cli/erp-connector.ts`、`src/cli/erp-connector.selftest.ts`。
  - 做：`list`、`add-odoo`、`set`、`set-secrets`、`check`、`map`、`rekey`；拒绝沙箱租户与文件存储；凭据文件规则同 `channel-account`。
  - 验：
    - 验收 4；
    - 子进程测：输出与报错扫不到地址、API key、密文；地址校验；开写回的前置条件；
    - `rekey` 前后都能解（验收 7 的一部分）。
  - 依赖：4。
- [ ] 6. 工业包叠加实时值（R6）。
  - 文件：`src/packs/industrial/live.ts`、`src/packs/industrial/tools.ts`、`src/packs/industrial/runtime.ts`、`src/packs/industrial/quotes.ts`、`src/industrial-erp.selftest.ts`。
  - 做：`live()`；三个工具在匹配后取一次实时值；`priceLine` 包一层 `peek`；自动批准缺 ERP 值时转人审；`erp` 声明（`kinds`、`matchKey`、`remoteKey`、`unitOf`）。
  - 验：
    - 验收 1（工具结果与订单逐字节对照 11 之前）、验收 2、验收 3 的本机部分；
    - v2 文件与 PGlite 两条全过，对当时的快照 0 差异。
  - 依赖：4。
- [ ] 7. 写回（R8）。
  - 文件：`src/connectors/push.ts`、`src/jobs/runner.ts`（`erp` 道）、`src/jobs/notify.ts`、`src/notify/handoff.ts`、`src/payment/orders.ts`、`src/core/order-view.ts`、`src/cli/erp-connector.ts`（`push` 子命令）、通知文案表。
  - 做：两处批准点排任务；执行体五步；状态表；系统消息与 `erp_push_failed` 通知（按订单号去重）；每日 200 张上限；`push --order`。
  - 验：
    - 验收 5（在模拟 Odoo 上）；
    - 重启后任务不重复执行、通知不重发；
    - 没开写回或没有连接器时，批准流程逐字节不变（09 的自测原样通过）。
  - 依赖：4、5。
- [ ] 8. pre-11 回滚检查（R12）。
  - 文件：`deploy/rollback-guard.sh`、`deploy.sh`（按 tag 文件树判 `src/connectors/registry.ts`）、`src/db/rollback-guard.selftest.ts`。
  - 做：三项拒绝条件、从严处理未知、提示文字；手动 tag 与自动回滚两条路径。
  - 验：验收 9，本机一次性容器演练四种情况：有启用的连接器、有待写回、有待执行的写回任务、都没有（含只有停用连接器）。
  - 依赖：2。
- [ ] 9. 本机集成（R11）。
  - 文件：`scripts/odoo-integration.ts`（不进 `pnpm test`）。
  - 做：起 `odoo:19`、`odoo:20` 一次性容器，建机器人用户、合成产品与库存；跑 `check`、`map --auto`、实时库存、写回、重复写回与读回核对；记耗时；外层超时，结束删容器。
  - 验：验收 8；结束后 `docker ps -a` 与 `ps` 没有残留。
  - 依赖：6、7。
- [ ] 10. 中期审查。
  - 做：对照不变量 1–10 与验收 1–10 逐条核本机证据；跑全部门禁与 gitleaks；另派一路只读评审看出站防护与凭据路径。
  - 验：审查结论与修复记进实施记录。
  - 依赖：1–9。
- [ ] 11. 上线（不配连接器）。
  - 做：owner 授权后上线 rc；只读核对四个哈希、迁移条数、旅游与工业的一问一答不变、没有任何 `erp_connectors` 行。按开放问题 5 的结论，不给演示租户配连接器。
  - 验：验收 1 的线上部分。
  - 依赖：10。
- [ ] 12. 对照全部验收逐条验证并记录。依赖：11。
- [ ] 13. 清理临时探针、集成产物、容器与后台进程。依赖：12。
- [ ] 14. owner 确认后翻 `Status: implemented`，按授权发版。依赖：13。

## 工作量与并行

- 第 0 步之后，第 1、2 步可并行（文件不重叠）。第 3 步等第 1 步；第 4 步等第 2、3 步。
- 第 4 步之后，第 5、6 步可并行；第 8 步只依赖第 2 步，可以更早开工。第 7 步等第 5 步（同改 `src/cli/erp-connector.ts`）。
- 写回（第 7 步）是独立的一批：赶不上时，第 1–6、8 步可以先单独上线。
- 按 03–12 的实际速度折算，日历时间约一周，不含下载镜像、等 owner 授权与上线的时间。

## 实施记录

（无。）

## Open

（无。）

## 已定

（无。开放问题 1–7 待 owner 定。）

## 交接记录

### 交接（2026-10-29，起草）

- spec 与本 plan 起草为 `draft`。依据：10「后续」第 1 条、工业品询价调研（另记）、对照代码的只读调研，以及 2026-10-29 对 Odoo 17.0–20.0 公开文档与源码的核对（结论见 spec「背景与问题」）。
- 起草时发现与原先设想不同的几处，已写进 spec：Odoo 20 已发布、17 已停止发镜像，故第一期定为 19、20 的 JSON-2（开放问题 3）；18.0 起 API key 会到期；`sale.order.line` 的单位字段 19 起改名，写回不传单位；按仓库查库存的 context 键 17、18 不同，改用 `location`；Odoo Online 只有 Custom 方案开放外部接口；Odoo 标准版没有客户料号表。
- 下一步：起草期评审（一路只读，对照代码）；之后向 owner 讲通俗版，定开放问题 1–7；是否翻 `ready` 由 owner 决定。
