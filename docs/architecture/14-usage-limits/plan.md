# 14 · 用量限制 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。

## 开工条件

缺一条就停下，告诉 owner：

1. 本 spec 已由 owner 定为 `ready`，开放问题 1–5 已定；翻 `ready` 的 docs PR 同时给 01 加 `Superseded in part by:`，给 05、01 加 `Amended by:`，主参考「阶段 8」加一条。
2. 11 的代码已在 `dev`（已满足）。
3. 本机能跑四个门禁、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。

## 开工须知

- 先读 `AGENTS.md`、本 spec、05 spec 的 R15、`docs/spec-driven-dev.md`、`git log -5`。
- 锁定的 8 个文件一个字节都不改；四个哈希全程不变。
- 测试随批合入，每一批合并时是绿的。新自测接进 `package.json` 的 `test` 行，跑 `scripts/ci-shard.ts --check 4`。
- 第 2、3 步并行时，两步之间的共享契约是 `limitVerdict()`、`noteAiReply()` 的签名，先合第 1 步再开工；合并后要有走真实链路的贯穿用例，不用假门面。

## 步骤

- [ ] 0. 开工核对。对照 spec 引用的行号核对现状；列出读 `usage_daily` 的所有路径，确认 `reply` 行不影响现有数字（模型费用、运行数字、`/api/usage`）。结果记进实施记录。依赖：无。
- [ ] 1. 数据与状态（R2、R3）。
  - 文件：新迁移与 journal、`src/db/schema.ts`、`src/db/repo/tenants.ts`、`src/usage.ts`、`src/db/repo/usage.ts`、`src/tenancy/limits.ts`、`src/tenancy/state-manifest.ts`、`src/ops/alert.ts`。
  - 验：迁移检查通过；月度计数跨日、跨月、重启后接得上（注入时钟）；轮询失败保留旧值；严格租户模式下两个租户不串（验收 11）。
  - 依赖：0。
- [ ] 2. 启动隔离（R6 启动部分）。
  - 文件：`src/config/source.ts`、`src/config/config.selftest.ts`。
  - 验：验收 8（真实 PG）。
  - 依赖：1。
- [ ] 3. 引擎闸门（R4、R5、R6 运行部分）。
  - 文件：`src/core/engine/index.ts`、`src/handoff/reasons.ts`、`src/tenancy/budget.ts`、跟进任务入口。
  - 验：验收 2、3、4、5、7；`done()` 与跟进都计数；固定句不计数。
  - 依赖：1。
- [ ] 4. 单客户限速（R7）。
  - 文件：`src/tenancy/customer-rate.ts`、`src/core/engine/index.ts`、`src/tenancy/state-manifest.ts`。
  - 验：验收 6。
  - 依赖：3。
- [ ] 5. 命令行（R8）。
  - 文件：`src/cli/tenant-budget.ts`、`src/cli/tenant-settings.selftest.ts`、`src/shared/ui-labels.ts`。
  - 验：子进程测每个子命令与审计；拒绝沙箱租户；验收 9 的本机部分。
  - 依赖：1。
- [ ] 6. 用量读接口（R9）。
  - 文件：`src/console-api/`、`src/shared/console-api.ts`。
  - 验：验收 10。
  - 依赖：1。
- [ ] 7. 贯穿用例。不用假门面，走真实的命令行写库 → 轮询 → 引擎 → 转人工，覆盖验收 2、7、9。依赖：3、5。
- [ ] 8. 中期审查与回滚演练。对照不变量与验收核证据；另派一路只读评审；真镜像演练 R11（验收 12）。依赖：1–7。
- [ ] 9. 上线（随 11 一起，owner 当次授权）。按开放问题 3、4 的结论写 `.env` 与上限，只读核对四个哈希与演示行为。依赖：8。
- [ ] 10. 对照全部验收逐条验证并记录。依赖：9。
- [ ] 11. 清理临时探针、容器与后台进程。依赖：10。
- [ ] 12. owner 确认后翻 `Status: implemented`。依赖：11。

## 工作量与并行

- 第 2、3、5、6 步在第 1 步之后可并行，只同改 `package.json`。第 4 步等第 3 步。
- 按 03–12 的实际速度折算，日历时间约一两天，不含等 owner 授权与上线。

## 实施记录

（无。）

## Open

（无。）

## 已定

- 2026-10-31 owner 定开放问题 1–5，全部照推荐（spec 第二条 `Revisions:`）。演示租户日费用上限的数值上线时由 owner 给。

## 交接记录

### 交接（2026-10-31，起草）

- spec 与本 plan 起草为 `draft`，依据：对照代码的只读调研；13 初稿里 owner 定的「按 AI 回复条数计」。
- 起草时发现一个现存缺陷并写进 R6：任何一个 standard 租户停用都会让整个进程拒绝启动。
- 2026-10-31 已向 owner 讲通俗版，开放问题 1–5 全部照推荐。
- 下一步：是否翻 `ready` 由 owner 点名决定。
