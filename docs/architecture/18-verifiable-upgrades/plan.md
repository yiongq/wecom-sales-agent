# 18 · 实施计划

依据 [spec](./spec.md)。spec 已于 2026-11-07 定 `ready`（heavy）。

第 1–2 步（`eval/sim/`）、第 3 步（核心护栏与工业包）、第 4 步（检索）、第 7 步（数据库、配置、部署）改的文件互不重叠，可以分开并行；第 5–6 步要等第 1、3、4 步合入。第 9 步只要 owner 有空就能做。第 6.1 冻结之后到 6.2 跑完之前，不合入任何改 `src/` 的 PR（含第 7 步），否则留出集拒绝运行。

- [ ] 0. 开工核对
  - [ ] 0.1 把第 1、2、4、5 次 main、第 3 次中止的 journal 与两次换客户模型的 journal 复制到本 worktree 的 `var/eval-sim-archive/`（不提交），记下文件名与 sha256
  - [ ] 0.2 读 01 的启动重新渲染流程：交叉评审已核实会发布新版本，再写清要不要过发布闸、闸基线会不会失效（spec 开放问题 5）
  - [ ] 0.3 列出 R3 三类写入（入站认领、`markSending`、会话落库）和全部发请求的路径（含恢复补发、同段重试）
  - [ ] 0.4 复核 16 审计的 `reply_amount` 能识别不带「元」的小计（交叉评审称能）
  - [ ] 0.5 核实嵌入单价，回写 spec R6 的费用表
  - [ ] 0.6 实测等锁进程的内存占用
  - [ ] 0.7 请 owner 提供服务器 Caddy 的上游写法（或授权只读查看），定 spec 开放问题 2
  - [ ] 0.8 核对 `var/` 里除 spill 以外的每类文件都符合「只有持锁进程读写」，不符合的列进第 7 步
  - [ ] 0.9 第 3 步动手前，对照 `guards.ts` 列全「整段换成固定话术」的分支（写 `blocksSuppressed` 的地方）
- [ ] 1. 检测器：`eval/sim/triage.ts` 与自测（每个检测器至少一正一反，用合成 journal 片段）；回溯第 1、2、4、5 次，逐条核对验收 7 的已知问题
- [ ] 2. 生成用例
  - [ ] 2.1 16 的 journal 每轮写 `sessionBefore`（`eval/sim/runtime.ts`），旧字段不变
  - [ ] 2.2 v2 工业夹具加 `moneyLedger` 与审批种子（`eval/v2/schema.ts`、worker）
  - [ ] 2.3 `eval/sim/promote.ts` 与自测：订单 id 换序号、预取不进脚本、旧 journal 报「只能手写用例」
- [ ] 3. 价格块
  - [ ] 3.1 `pack-api` 的 `ReplyBlocks`、核心 `reply_blocks:render` / `reply_blocks:place` 两步，`blocksSuppressed` 旗标的读写声明与步骤表校验
  - [ ] 3.2 工业包三种试算模板、档位价、应付金额；`quote_items` 结果加 `block` 与下一档；`find_parts` 加 `block`
  - [ ] 3.3 `shape_check`、`rfq_trim` 按「正文 + 块」算预算、只改正文
  - [ ] 3.4 按 0.9 的清单在固定话术分支写旗标
  - [ ] 3.5 【硬性要求】与工具说明；trace `turn.blocks`
  - [ ] 3.6 自测与 v2 用例（验收 1、6）；锁定套件、旅游 v2 快照 0 差异
- [ ] 4. 混合检索
  - [ ] 4.1 `eval/retrieval/` 生成器、手写查询、`run.ts`，假嵌入自测
  - [ ] 4.2 真实嵌入跑 `current` 基线（owner 当次授权，上限 ¥1）
  - [ ] 4.3 `src/core/retrieval-hybrid.ts`、`src/packs/industrial/attributes.ts`、`semanticScores`、`match.ts` 接线，状态登记
  - [ ] 4.4 跑 `hybrid`，写检索报告（验收 16–18）
- [ ] 5. 开发集（owner 当次授权）：跑完用检测器扫一遍；修在代码的用第 2 步生成用例（验收 8），修在提示词的按 spec R2 找开发集场景定向复跑
- [ ] 6. 第 6 次 main
  - [ ] 6.1 重新冻结，`--prepare` 写开跑行并提交
  - [ ] 6.2 跑 main（owner 当次授权），再跑换客户模型（D6 已定 A）
  - [ ] 6.3 审计裁定、检测器、`triage-review.json`
  - [ ] 6.4 报告：16 格式加 R2 附表和「18 前后对比」（验收 2–5、9、19）
- [ ] 7. 主备切换
  - [ ] 7.1 `TENANT_LOCK_WAIT`、等锁启动、等锁时的 SIGTERM
  - [ ] 7.2 `process_epochs` 迁移与 RLS，`bumpProcessEpoch`、`fenceProcessEpoch`，按 0.3 的清单接栅栏
  - [ ] 7.3 发送前检查（含恢复补发、同段重试）、`markOutboundSending` 的 `stale` 结果、等锁模式下 03 R6 照发只在锁视图 `held` 时允许
  - [ ] 7.4 失锁即停收并关闭监听；重取成功后核对 epoch；等锁模式下失去主身份后的停机不写 spill
  - [ ] 7.5 compose `app-standby`、`deploy.sh` 滚动切换与回滚、`deploy/watch.sh` 探两个端口、运维手册、要求停应用的命令行提示、README 与总参考「从单实例到多租户」里单实例的说法
  - [ ] 7.6 真实 PG 演练自测：杀主进程、掐锁连接、重取时 epoch 已变、本机 compose 加 Caddy 容器的滚动发版（验收 10–14）
- [ ] 8. 主备上线前置（owner 点名才做）：服务器 Caddy 改上游、首次以主备方式部署
- [ ] 9. 企微去重实测：`src/cli/wecom-dedup-probe.ts`（每个间隔独立 msgid 的成对实验）；owner 授权后在服务器上跑，owner 手机看每一对；按结果改窗口规则与发送层截止检查（03 顶部标记已在 ready 时加）（验收 15）
- [ ] 10. 对照全部验收标准逐条验证，结果记在下面
- [ ] 11. 清理临时探针、演练容器与 `var/` 里的临时文件
- [ ] 12. owner 确认后改 spec 的 `Status`

## 交接记录

2026-11-07：spec 与 plan 首版起草（`dev` `406fe404`）。本机探针确认 `parseMoney` 不识别「小计 360.00」这种不带「元」的写法，已写进 spec 现状。第 1–5 次 main 的 journal 还在另一个 worktree 的 `var/eval-sim/`，第 0.1 步要先备份。下一步：owner 读 spec，定 7 张决策卡、档位和是否 `ready`。

2026-11-07：owner 对决策卡答「都按推荐」，D1–D7 全部定为 A，已记进 spec 顶部 `Revisions:`。还在等：Tier 是否按 heavy、是否改 `ready`。

2026-11-07：Codex 只读交叉评审 spec（3 blocker、8 major、1 minor）。其中 7 条我对照代码复核属实（局部纠正也返回 `replace`、12 行 600 字上限、恢复补发跳过 `markSending` 且标记失败会照发、journal 只存订单和阶段、10 验收 9 禁止 v2 审批种子、已知问题场景都在留出集、`watch.sh` 盯固定端口），其余是推理类问题，认同。12 条全部按评审改进 spec（见 spec 顶部第一条 `Revisions:`），plan 步骤随之重排。还在等：Tier 是否按 heavy、是否改 `ready`。

2026-11-07：owner「改 ready，heavy」，spec 改为 `ready`、Tier heavy；01、03、10、16 顶部补反向标记，总参考登记。下一步：第 0 步（0.7 要 owner 提供 Caddy 配置），之后按开头的分路并行，同时最多两路。
