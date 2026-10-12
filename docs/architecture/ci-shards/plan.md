# CI 分片执行计划

对应 [spec.md](./spec.md)，实现依据为 owner 本次明确给出的 CI 分片任务。

- [x] 1. 核对原 94 条命令的依赖及严格列表，记录显式规则。
- [x] 2. 实现严格子集入口、耗时表、确定性分配、覆盖检查与执行器。
- [x] 3. 加入分片器自测，改 workflow 与种子一致性检查。
- [x] 4. 对照全部验收标准验证，记录分配、门禁与抽跑结果。
- [x] 5. 清理临时探针与测试，核对锁定文件及公开边界。
- [ ] 6. owner 确认后更新 spec 状态。

## 交接记录

### 2026-10-12 · 开始

已读根规则、最近五个提交、00 / 05 的相关 spec 与 plan、完整任务和种子补丁；工作区开工时干净。原链 94 条命令，严格列表实际 25 套（原注释的 24 已过时）。下一步完成依赖核对，按本任务实施，不推进 05 其他步骤。

## Open

无。

## 依赖核对

原 94 条命令逐条如下。编号固定为开工时的完整链；新增分片器自测另记为「新增」。

- 显式顺序规则：原 68 → 69 合成一个单元，前者生成 `console/dist` 与 `console/build-meta`，后者直接读取这两处；依据 `console/vite.config.ts` 的 `buildMeta` / `build` 与 `scripts/check-console-dist.ts` 的 `DIST` / `META` / 缺产物失败分支。
- 原 1 展开七条锁定命令，逐条保留 CONFIG_SOURCE、固定时钟与 preload；没有跨进程产物依赖。
- 原 85 展开原列表 25 个严格单元；每个子集自行创建报告、启动被预载的子进程并验证原断言，普通运行不是它的前置条件。
- 真实 PG 夹具建随机数据库，但 `createRealPgFixture` 会修改集群级角色口令（`src/db/testing.ts`）；所以每片单独使用 PG service，片内串行执行，不在同一集群并发运行单元。
- 原 39 的 console 托管断言自己生成临时产物、设置 CONSOLE_DIST；原 84 同样生成自己的 index，不依赖 console build。原 62 将 seed-demo.py 的输出重定向到临时目录，不生成供后续测试读取的仓库文件。原 65 / 66 的 eval 默认各有临时 VAR_DIR，只有显式 --json 才写报告，此链未传。

| 原编号 | 命令目标（完整命令见 package.json）                    | 依据 / 单元边界                                                                                                          |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1      | `pnpm -s test:locked`                                  | 展开 test:locked；七个进程各自自测，固定时钟前缀保留                                                                     |
| 2      | `src/config/pack-runtime.selftest.ts`                  | 本套临时目录（src/config/pack-runtime.selftest.ts:20）；不消费其他套的状态                                               |
| 3      | `src/config/brand.selftest.ts`                         | 本套临时目录（src/config/brand.selftest.ts:18）；不消费其他套的状态                                                      |
| 4      | `src/config/brand-publish.selftest.ts`                 | 本套 openTestDb 夹具（src/config/brand-publish.selftest.ts:25）；不消费其他套的数据库；真实 PG 分支使用本套数据库夹具    |
| 5      | `src/config/brand-transfer.selftest.ts`                | 本套临时目录（src/config/brand-transfer.selftest.ts:22）；不消费其他套的状态                                             |
| 6      | `src/core/guards/validate.selftest.ts`                 | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 7      | `src/core/guards/execute.selftest.ts`                  | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 8      | `src/followup-guards.selftest.ts`                      | 本套临时目录（src/followup-guards.selftest.ts:20）；不消费其他套的状态                                                   |
| 9      | `src/core/tools/registry.selftest.ts`                  | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 10     | `src/core/llm/client.selftest.ts`                      | 本套临时目录（src/core/llm/client.selftest.ts:13）；不消费其他套的状态                                                   |
| 11     | `src/packs/travel/tools/tools.selftest.ts`             | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 12     | `src/packs/travel/progress.selftest.ts`                | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 13     | `src/packs/travel/turn.selftest.ts`                    | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 14     | `src/core/parse/date-count.selftest.ts`                | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 15     | `src/packs/travel/dates.selftest.ts`                   | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 16     | `src/packs/travel/price.selftest.ts`                   | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 17     | `src/price-guard-parse.selftest.ts`                    | 本套临时目录（src/price-guard-parse.selftest.ts:100）；不消费其他套的状态                                                |
| 18     | `src/store/store.selftest.ts`                          | 本套临时目录（src/store/store.selftest.ts:37）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                       |
| 19     | `src/store/spill-channel.selftest.ts`                  | 本套临时目录（src/store/spill-channel.selftest.ts:64）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具               |
| 20     | `src/store/parity.selftest.ts`                         | 本套临时目录（src/store/parity.selftest.ts:116）；不消费其他套的状态                                                     |
| 21     | `src/trace/trace.selftest.ts`                          | 本套临时目录（src/trace/trace.selftest.ts:22）；不消费其他套的状态                                                       |
| 22     | `src/trace/verdicts.selftest.ts`                       | 本套临时目录（src/trace/verdicts.selftest.ts:21）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                    |
| 23     | `src/jobs/jobs.selftest.ts`                            | 本套临时目录（src/jobs/jobs.selftest.ts:67）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                         |
| 24     | `src/notify/notify.selftest.ts`                        | 本套临时目录（src/notify/notify.selftest.ts:173）；不消费其他套的状态                                                    |
| 25     | `src/ops/ops.selftest.ts`                              | 本套临时目录（src/ops/ops.selftest.ts:54）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                           |
| 26     | `src/channels/channels.selftest.ts`                    | 本套临时目录（src/channels/channels.selftest.ts:263）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                |
| 27     | `src/handoff/handoff.selftest.ts`                      | 本套临时目录（src/handoff/handoff.selftest.ts:20）；不消费其他套的状态                                                   |
| 28     | `src/privacy/privacy.selftest.ts`                      | 本套临时目录（src/privacy/privacy.selftest.ts:12）；不消费其他套的状态                                                   |
| 29     | `src/adapters/wecom-02.selftest.ts`                    | 本套临时目录（src/adapters/wecom-02.selftest.ts:16）；不消费其他套的状态                                                 |
| 30     | `src/adapters/wecom-03.selftest.ts`                    | 本套临时目录（src/adapters/wecom-03.selftest.ts:103）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                |
| 31     | `src/channels/recovery.selftest.ts`                    | 本套临时目录（src/channels/recovery.selftest.ts:398）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                |
| 32     | `src/channels/restore-cutoff.selftest.ts`              | 本套临时目录（src/channels/restore-cutoff.selftest.ts:22）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具           |
| 33     | `src/quota/quota.selftest.ts`                          | 本套临时目录（src/quota/quota.selftest.ts:67）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                       |
| 34     | `src/quota/outbound.selftest.ts`                       | 本套临时目录（src/quota/outbound.selftest.ts:55）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                    |
| 35     | `src/db/rollback-guard.selftest.ts`                    | 本套临时目录（src/db/rollback-guard.selftest.ts:14）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                 |
| 36     | `src/db/db.selftest.ts`                                | 本套临时目录（src/db/db.selftest.ts:26）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                             |
| 37     | `src/db/brand.selftest.ts`                             | 本套临时目录（src/db/brand.selftest.ts:21）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                          |
| 38     | `src/config/config.selftest.ts`                        | 本套临时目录（src/config/config.selftest.ts:19）；不消费其他套的状态                                                     |
| 39     | `src/console-api/console.selftest.ts`                  | 本套临时目录（src/console-api/console.selftest.ts:22）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具               |
| 40     | `src/payment/orders.selftest.ts`                       | 本套临时目录（src/payment/orders.selftest.ts:15）；不消费其他套的状态                                                    |
| 41     | `src/web/web.selftest.ts`                              | 本套临时目录（src/web/web.selftest.ts:13）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                           |
| 42     | `src/payment/legacy-pay-poisoned.selftest.ts`          | 本套临时目录（src/payment/legacy-pay-poisoned.selftest.ts:16）；不消费其他套的状态                                       |
| 43     | `src/packs/packs.selftest.ts`                          | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 44     | `console/src/theme/theme.selftest.ts`                  | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 45     | `src/shared/typography.selftest.ts`                    | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 46     | `src/shared/format.selftest.ts`                        | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 47     | `src/shared/audit-text.selftest.ts`                    | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 48     | `console/src/typography.selftest.ts`                   | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 49     | `console/src/session.selftest.ts`                      | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 50     | `console/src/parts/errors.selftest.ts`                 | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 51     | `console/src/shell/shell.selftest.ts`                  | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 52     | `console/src/fields/fields.selftest.tsx`               | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 53     | `console/src/overview/overview.selftest.tsx`           | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 54     | `console/src/conversations/conversations.selftest.tsx` | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 55     | `console/src/conversations/workbench.selftest.tsx`     | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 56     | `console/src/audit/audit.selftest.tsx`                 | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 57     | `console/src/sop/sop.selftest.tsx`                     | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 58     | `console/src/pages/login.selftest.tsx`                 | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 59     | `console/src/parts/popupRegion.selftest.tsx`           | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 60     | `scripts/check-console-src.selftest.ts`                | 本套临时目录（scripts/check-console-src.selftest.ts:219）；不消费其他套的状态                                            |
| 61     | `scripts/check-boundaries.selftest.ts`                 | 本套临时目录（scripts/check-boundaries.selftest.ts:11）；不消费其他套的状态                                              |
| 62     | `scripts/seed-demo.selftest.ts`                        | 生成器输出经 isolated_open 重定向至本套临时目录                                                                          |
| 63     | `eval/v2/runner.selftest.ts`                           | 本套临时目录（eval/v2/runner.selftest.ts:15）；不消费其他套的状态                                                        |
| 64     | `eval/sim/sim.selftest.ts`                             | 本套临时目录（eval/sim/sim.selftest.ts:150）；不消费其他套的状态                                                         |
| 65     | `eval/run.ts`                                          | 各自 mkdtemp(VAR_DIR)，不传 --json，不消费前一轮结果                                                                     |
| 66     | `eval/run.ts`                                          | 各自 mkdtemp(VAR_DIR)，不传 --json，不消费前一轮结果                                                                     |
| 67     | `scripts/check-fonts.ts`                               | 只读已提交字体 / 数据 / 源码，无先行生成命令                                                                             |
| 68     | `build`                                                | 唯一产物生产者；与原 69 绑定，先 build                                                                                   |
| 69     | `scripts/check-console-dist.ts`                        | 读 dist / build-meta；与原 68 绑定，后 check                                                                             |
| 70     | `src/db/sandbox.selftest.ts`                           | 本套 openTestDb 夹具（src/db/sandbox.selftest.ts:457）；不消费其他套的数据库；真实 PG 分支使用本套数据库夹具             |
| 71     | `scripts/check-tenant-state.selftest.ts`               | 本套临时目录（scripts/check-tenant-state.selftest.ts:10）；不消费其他套的状态                                            |
| 72     | `src/server-entry.selftest.ts`                         | 本套临时目录（src/server-entry.selftest.ts:8）；不消费其他套的状态                                                       |
| 73     | `src/tenancy/seed-fixture.selftest.ts`                 | 只读已提交字体 / 数据 / 源码，无先行生成命令                                                                             |
| 74     | `src/tenancy/runtime.selftest.ts`                      | 本套临时目录（src/tenancy/runtime.selftest.ts:28）；不消费其他套的状态                                                   |
| 75     | `src/tenancy/review.selftest.ts`                       | 本套临时目录（src/tenancy/review.selftest.ts:32）；不消费其他套的状态                                                    |
| 76     | `src/tenancy/local-state.selftest.ts`                  | 本套临时目录（src/tenancy/local-state.selftest.ts:7）；不消费其他套的状态                                                |
| 77     | `eval/v2/isolation.selftest.ts`                        | 本套临时目录（eval/v2/isolation.selftest.ts:8）；不消费其他套的状态                                                      |
| 78     | `src/tenancy/hosts.selftest.ts`                        | 已核对 imports / I/O：纯函数、内存夹具或只读提交源码；无跨命令产物                                                       |
| 79     | `src/cli/tenant-settings.selftest.ts`                  | 本套 openTestDb 夹具（src/cli/tenant-settings.selftest.ts:171）；不消费其他套的数据库；真实 PG 分支使用本套数据库夹具    |
| 80     | `src/tenancy/public-routes.selftest.ts`                | 本套临时目录（src/tenancy/public-routes.selftest.ts:21）；不消费其他套的状态                                             |
| 81     | `src/console-api/entry.selftest.ts`                    | 本套临时目录（src/console-api/entry.selftest.ts:8）；不消费其他套的状态                                                  |
| 82     | `src/tenancy/events-channels.selftest.ts`              | 本套临时目录（src/tenancy/events-channels.selftest.ts:13）；不消费其他套的状态                                           |
| 83     | `src/tenancy/usage.selftest.ts`                        | 本套临时目录（src/tenancy/usage.selftest.ts:9）；不消费其他套的状态                                                      |
| 84     | `src/tenancy/isolation.selftest.ts`                    | 本套临时目录（src/tenancy/isolation.selftest.ts:13）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                 |
| 85     | `scripts/test-tenancy-strict.ts`                       | 原列表 25 套；每套独立报告，逐套验证                                                                                     |
| 86     | `src/db/sandbox-process.selftest.ts`                   | 本套临时目录（src/db/sandbox-process.selftest.ts:97）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具                |
| 87     | `src/tenancy/sandbox/provision.selftest.ts`            | 本套临时目录（src/tenancy/sandbox/provision.selftest.ts:415）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具        |
| 88     | `src/tenancy/sandbox/http.selftest.ts`                 | 本套临时目录（src/tenancy/sandbox/http.selftest.ts:40）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具              |
| 89     | `console/src/sandbox/sandbox.selftest.tsx`             | 本进程的 DOM / API mock 或纯函数；只读提交的源码，不消费其他套产物                                                       |
| 90     | `src/tenancy/sandbox/pages.selftest.ts`                | 本套临时目录（src/tenancy/sandbox/pages.selftest.ts:11）；不消费其他套的状态                                             |
| 91     | `src/tenancy/sandbox/reaper.selftest.ts`               | 本套 openTestDb 夹具（src/tenancy/sandbox/reaper.selftest.ts:959）；不消费其他套的数据库；真实 PG 分支使用本套数据库夹具 |
| 92     | `src/db/sandbox-limits.selftest.ts`                    | 本套 openTestDb 夹具（src/db/sandbox-limits.selftest.ts:498）；不消费其他套的数据库；真实 PG 分支使用本套数据库夹具      |
| 93     | `src/tenancy/sandbox/outbound.selftest.ts`             | 本套临时目录（src/tenancy/sandbox/outbound.selftest.ts:33）；不消费其他套的状态；真实 PG 分支使用本套数据库夹具          |
| 94     | `src/quota/shutdown.selftest.ts`                       | 本套临时目录（src/quota/shutdown.selftest.ts:11）；不消费其他套的状态                                                    |

## 四片分配

正常命令用上表原编号；`1.k` 指展开后的第 k 条锁定命令，`68→69` 是一个依赖单元。严格项省略 `src/` 与 `.selftest.ts`，eval 保留路径。新增自测记为「新增」。执行顺序为原链顺序；未知耗时为 10 秒。

| 片号 | 正常单元                                                                                                     | 严格单元                                                                                                                                                   | 单元数 | 估时                 |
| ---- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- |
| 1    | 1.4, 2, 5, 8, 12, 16, 24, 26, 29, 30, 32, 33, 35, 36, 42, 44, 48, 52, 56, 60, 63, 71, 75, 79, 83, 86, 90, 94 | notify/notify, config/config                                                                                                                               | 30     | 904 秒（15.07 分钟） |
| 2    | 1.3, 1.7, 7, 11, 15, 20, 21, 28, 37, 38, 43, 47, 51, 55, 59, 62, 70, 74, 78, 82, 89, 93                      | channels/channels, adapters/wecom-03, channels/restore-cutoff, quota/quota, quota/outbound, db/rollback-guard, db/db, web/web, payment/legacy-pay-poisoned | 31     | 904 秒（15.07 分钟） |
| 3    | 1.1, 1.5, 3, 4, 9, 13, 17, 19, 22, 23, 34, 40, 45, 49, 53, 57, 新增, 64, 65, 72, 76, 80, 84, 87, 91          | config/brand-transfer, trace/trace, ops/ops, channels/recovery, console-api/console, eval/run.ts                                                           | 31     | 904 秒（15.07 分钟） |
| 4    | 1.2, 1.6, 6, 10, 14, 18, 25, 27, 31, 39, 41, 46, 50, 54, 58, 61, 66, 67, 68→69, 73, 77, 81, 88, 92           | config/brand, config/brand-publish, store/store, store/spill-channel, store/parity, trace/verdicts, jobs/jobs, db/brand                                    | 32     | 904 秒（15.07 分钟） |

估时总和 3616 秒，不包含 checkout、安装、排队与环境性能差异；目标墙钟约 15 分钟仍需实际 CI 确认，本次按任务要求没有访问网络或运行 GitHub workflow。

## 验收记录

### 2026-10-12 · 本机验证

- `pnpm -s test:locked` 通过，八个锁定文件与开工提交逐字节相同；`test:locked` 的脚本文本也不变。原 94 条命令与顺序全部保留，`test` 仅增加要求的分片器自测。
- 分片器自测 49 条断言通过：遗漏、多余、重复、依赖拆开与反序、不同 N、严格空 / 未知 / 重复子集、环境前缀、实际 CLI 执行、失败停止及进程组超时。
- `--check 4` 通过：124 个单元、25 个严格目标，四片估时均为 904 秒，完整分配见上表。
- 抽跑第 3 片中只用 PGlite 的两个单元，经真实分片执行器：普通 `src/config/brand.selftest.ts` 通过，1.59 秒；严格 `src/config/brand-transfer.selftest.ts` 78 项通过，5.93 秒，报告 `1/1`、`scope_missing=0`、`whitelist=0`、`processes=13`。未抽跑真实 PG 单元，未启动或连接任何数据库容器。
- 种子生成器输出与 `data/sandbox-seeds.json` 逐字节相同；workflow YAML 解析、原覆盖注释完整保留、四片 matrix / PG service / timeout / always 均核对通过。实际执行汇总 shell 的 16 种 success / failure / cancelled / skipped 组合，只有两项均 success 时退出 0。
- 本次不跑完整 `pnpm test`、不访问网络 / GitHub / 服务器、不提交，均遵照 owner 的任务要求。缓存沿用现有安装方式，没有新增 action。
- 新增 spec / plan 与 00 的部分取代链接用于遵守仓库文档规则；spec 保持 draft，没有自行推进状态。
- format / lint / typecheck 首轮通过，最后修改分片器自测后复验结果见下方交接。lint 的内容黑名单因本 worktree 没有敏感词表而按原行为跳过；其余 lint 子检查通过。pnpm 的用户配置权限警告不影响退出码。

### 2026-10-12 · 交接

实现及本机验收已完成；没有代码半成品或临时探针，工作区为本任务的未提交 diff。下一步由 owner 审阅并提交，然后在实际 CI 核实墙钟时间；本任务不操作 GitHub。第 6 步仍等待 owner 确认，不能把 spec 自行翻为 implemented。

最终复验：`pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck` 均退出 0，分片器自测 49 条及 `--check 4` 通过；已等待所有启动的测试进程退出，未启动后台服务或容器。系统级 `ps` 枚举被沙箱拒绝，生命周期核对依据为各启动进程的退出状态和进程组超时自测。工作区只包含上文列出的实现、测试与文档改动，没有提交。
