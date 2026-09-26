# 01 · Postgres 底座 + 配置入库 + 后台 v0 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。括号里是工程日估算，合计约 35 个工程日。

- [x] 1. 开工核对（0.5）：
  - 记下开工提交的 sha，验收 1 的 diff 以它为基准。
  - 逐项核对 spec「前置条件」：四个门禁接的是真实工具；格式化排除 `data/sop.md`；`profile()`；【硬性要求】身份那一行不读 profile；`promptPrefix()` 和多轮逐字节断言；`deploy.sh <tag>` 与 `/healthz.revision`。缺一项就写进 Open 并停下。
  - 查 00 是否在 `server.selftest.ts` 里断言了「prod 下 `/api/admin/stream` 匿名可连」，结论记进实施记录（验收 1 的唯一例外）。
  - 本 spec 开放问题 1（`test` 新增三组）已由 owner 于 2026-09-25 确认，无需再问。
  - 00 开放问题 3（oxlint 的 suspicious 等类别什么时候开，约定「01 开工前定」）：按 00 验收后各类别在全仓的命中数，请 owner 定，结论记进 Open。
  - 00 开放问题 1（没设 `DEPLOY_PROFILE` 却配了企微凭据时是否拒绝启动）已被本 spec 部分回答：DB 模式要求显式写 `DEPLOY_PROFILE`，缺了以 `env_invalid` 拒绝启动（验收 13）。文件模式下要不要也拦，仍由 owner 在第一个 prod 实例上线前定。
- [x] 2. 数据库骨架，还不接任何运行时代码（3）：
  - 装 drizzle-orm、drizzle-kit、pg、@types/pg、zod、@electric-sql/pglite、@hono/zod-validator，全部钉精确版本（先按开放问题 9 的规则核实版本线）；根目录的 `hono` 也改成精确版本；提交 lockfile。
  - `src/db/schema.ts`（七张表）、`client.ts`（`openDb`、`withTenant` 与 AsyncLocalStorage、会话级泄漏断言、`lockTenantConfig`、`queryCount`、`holdTenantLock`）、`migrate.ts`、`testing.ts`（`openTestDb`）。先用 typecheck 验证 `Db` / `Tx` 取 `PgDatabase` / `PgTransaction` 基类的写法对两个驱动都成立。
  - drizzle-kit 生成初始迁移，外加 custom 迁移：RLS 模板、三个触发器、五个认证函数、GRANT / REVOKE / 默认权限。
  - `lint` 加：import 边界（spec「模块与依赖方向」全部规则）；`app.tenant_id` 的出现位置与 `sql.raw`；迁移检查脚本（破坏性语句清单、已提交迁移不许改、journal 的 `when` 单调，与 `origin/dev` 的 merge-base 比较）。
  - 新建 `src/db/db.selftest.ts`，先写 PGlite 部分：迁移连跑两遍、CHECK（含哈希）、三个触发器、两个部分唯一索引、复合外键。
  - 实测 PGlite 对 `CREATE ROLE`、`SECURITY DEFINER`、`GRANT`、`sha256()` 的支持，结论记进实施记录（开放问题 2）。
  - 对应验收 7 的约束与触发器部分、20 的迁移与 import 边界部分。
- [x] 3. 真实 Postgres、本地 db 与镜像骨架（3）：
  - `deploy/db-init/roles.sql` 与 `roles.sh`（口令从环境读，可重复执行）；`deploy/compose.yml` 先写 `db` 与 `migrate` 两个服务，db 不发布端口。
  - 多阶段 Dockerfile 的骨架（`deps` / 运行阶段，`COPY drizzle`），console 阶段留到第 12 步补。
  - `db.selftest.ts` 的真实 PG 部分：建临时库、执行 roles.sql、以 owner 跑迁移；按「各角色对各表的期望」逐格断言；按系统目录检查带 `tenant_id` 的表与豁免清单；认证函数、`search_path` 与临时表遮蔽、会话级 SET 泄漏；租户锁的 `lock_held`、断连后重取与 `held_by_other`。结束时删库。
  - `test` 在有 `PG_TEST_URL` 时跑这部分；`CI=true` 而没有它时失败。
  - `ci.yml` 的 `check` job 加 `services.postgres`（`pgvector/pgvector:pg17`）并设 `PG_TEST_URL`，步骤仍只调四个门禁名。
  - 手工验证一次：去掉某张表的 `ENABLE ROW LEVEL SECURITY`，套件变红；验证完还原。
  - 对应验收 12，以及 7 的权限部分。
- [ ] 4. SOP 纯内核（2）：
  - `src/tool-defs.ts`：`toolDefs` 从 `tools.ts` 搬出，`tools.ts` 再导出；`promptPrefix().tools` 字节不变。
  - `src/prompt/system.ts`：从 `buildSystemPrompt` 拆出 `renderSystemPrompt(sop)`。`buildSystemPrompt` 仍走文件，`promptPrefix()` 和 `__engineTest` 不变；用 00 的前缀测试确认哈希没变。
  - `src/sop/sections.ts`：节表、`splitSop` / `joinSop` / `sectionBody` / `normalizeBody` / `withBody` / `mergeWithImage` / `editableChars`、编码检查。
  - `src/sop/contract.ts`：17 条断言原文照抄进清单，加上 `SOP_KNOWN_FIELDS`、`KNOWN_FIELD_SOURCES` 和 `checkSopContract`。
  - 仓库加 `.gitattributes`（`data/sop.md`、`data/*.json` 设 `text eol=lf`）。
  - 新建 `src/config/config.selftest.ts`（先设临时 `VAR_DIR` 再动态 import），写这些断言：`data/sop.md` 切成 11 节并逐字节往返；每节已是规范形，GET→PUT 往返不变；各类编码问题被拒；每种 violation code 各一例；源码扫描的漂移测试；`SOP_KNOWN_FIELDS` 出现在 `KNOWN_FIELD_SOURCES` 里；当前 `data/sop.md` 零 violation。
  - 对应验收 6 的纯函数部分，以及 3 的编码部分。
- [ ] 5. 产品库纯内核（1.5）：
  - `src/shared/catalog-types.ts`：`Route`、`Hotel` 及嵌套类型搬出，`types.ts` 再导出；`Route` 补上 `overseas?: boolean`。
  - `src/shared/season.ts`：`peakMonths` 搬出，`tools.ts` 再导出。
  - `src/shared/catalog.ts`：strict 的 `RouteSchema` / `HotelSchema`（`itinerary` 条数等于 `days`、`bestSeason` 可解析、不用 coerce）、`ALWAYS_LOCKED`、`LOCKED_WHEN_ACTIVE`、`lockedFieldChanges`、递归的 `mergeKeyOrder`、补丁的应用函数。
  - `searchHotels` 改成先拷贝再排序；文件模式下 `loadRoutes` / `loadHotels` 也 deep-freeze。跑全部自测，发现别的原地修改就改成先拷贝，改动记进实施记录。
  - 断言写进 `config.selftest.ts`：现有全部条目都能过 schema；锁定字段比对；嵌套键序合并；表单往返不变。
  - 对应验收 4 的文件模式部分。
- [ ] 6. 配置源、启动顺序、导入导出与运行时接线（4）：
  - `src/config/source.ts`：`configMode`、`productionConfigDeps`、`initConfig`（十步，前八步只读）、`currentSop` / `currentCatalog`、`onCatalogChanged`、锁状态机、`reloadFromDb` 单飞、`configHealth`、`__configTest.reset`。启动重渲染这时先用「不一致就以 `contract_failed` 拒绝启动」占位。
  - `src/boot.ts`；`server.ts` 改成顶层 `await boot({...})`，`startWecom()` 从模块顶层挪进 boot；那五处 catch 收窄；`/healthz` 加 `config`；`store.ts` 的 `onShutdown` 加 late 阶段并导出 `gracefulExit`，登记 `markConfigShuttingDown` 与 `closeConfig`。
  - `engine.ts` 的 `buildSystemPrompt`、`tools.ts` 的 `loadRoutes` / `loadHotels` 改走配置源，签名不变；每轮日志带 `sopVersion` 与 `prefixHash`。
  - `llm.ts` 加只读的请求观察钩子。
  - 命令行 `src/cli/tenant-create.ts`（platform）、`import-config.ts`、`export-config.ts`（含 `--image-sop`、`REPEATABLE READ`）。
  - `testing.ts` 加 `installSeededConfig`。`eval/run.ts` 在 `VAR_DIR` 赋值之后加 `CONFIG_TEST_DB=pglite` 开关和 `--cases <path>`。`test` 对现有 6 组和文件模式 eval 加 `CONFIG_SOURCE=file` 前缀，eval 跑两遍。
  - 真实 PG 部分补上：node-postgres 下的逐条字节比较；以子进程执行 import / export 并断言退出码。
  - `.env.example` 补上 spec 列的变量，注明 owner / platform 连接串不写进 `.env`。
  - 对应验收 1、2、3、4、13、14，以及 21 的自动部分。
- [ ] 7. SOP 编辑流程（3）：
  - `src/db/repo/sop.ts`、`repo/audit.ts`；`src/config/sop.ts` 实现草稿（`rev`）、锁定节 422、检查（200 带 violations）、发布事务（配置写锁、三方 rebase、合并后写回 `sections`、发布时分配版本号、四个哈希与 `render_inputs`）、回滚（目标状态校验、`sameHashAsTarget`）、丢弃、审计。提交之后才替换缓存。
  - 启动重渲染从占位改成真实实现：完整性、渲染两遍、每次启动都跑契约、按 `render_inputs` 定 `causes`、最后一步才写入。
  - 对应验收 5、6、7 的其余部分、8，以及 10 的 SOP 部分，都先在 PGlite 上用函数调用测。
- [ ] 8. 产品库编辑流程（2）：
  - `src/db/repo/catalog.ts`；`src/config/catalog.ts` 实现新建（draft）、字段级补丁（`rev`、锁定字段、递归键序、请求原值）、上架、23505 映射、审计 diff。
  - 提交之后用 `RETURNING` 的行调 `applyCatalogRow()`；COMMIT 结果不明时 `reloadFromDb()`。
  - 命令行 `src/cli/catalog-fix.ts`。
  - 对应验收 9，以及 10 的产品库部分。
- [ ] 9. 检索（0.5）：
  - `invalidateIndex()`、按代际丢弃、失败退避重试、`indexHealth()`；缓存改成 tmp 加 rename 写入，格式不变。
  - `retrieval.ts` 注册 `onCatalogChanged`。
  - 计数的假 embedding 服务写进 `config.selftest.ts`。
  - 对应验收 11。
- [ ] 10. 鉴权与账号命令行（2.5）：
  - `src/auth/password.ts`：scrypt、`maxmem`、并发上限 2 加 2 秒排队、假哈希、`needsRehash`。
  - `src/auth/session.ts`：`login` / `resolveSession` / `logout` / `csrfFor`，外加三路登录限流（LRU、IPv6 /64）和无效 cookie 的按 IP 限流。
  - `src/db/repo/auth.ts` 包装五个认证函数。
  - 平台命令行 `user-create`、`user-password`、`user-disable`、`member-role`、`member-remove`（口令只走 stdin 或 `/dev/tty`）。
  - prod 下 `/api/admin/stream` 要求有效后台会话。
  - 在目标服务器上实测两个并发登录的耗时和内存（开放问题 4），记进实施记录。
  - 对应验收 15 的函数部分。
- [ ] 11. 后台接口子应用（2.5）：
  - `src/shared/console-api.ts` 写请求与响应的 schema。
  - `src/console-api/app.ts` 链式注册：`securityHeaders`、`requireDbMode`、`loadSession`、`guardWrites`、权限矩阵、匿名投影（只读缓存与快照）、命名错误映射（含 23505 与 `lock_lost`）。
  - `server.ts` 用 `app.route('/', consoleApi)` 挂载，放在 serveStatic 兜底之前。
  - 新建 `src/console-api/console.selftest.ts`（先设临时 `VAR_DIR`），走 `app.request`，库用 PGlite。
  - 对应验收 5、6、9、15、16 的 HTTP 部分。
- [ ] 12. console 工作区和三个核心页（4）：
  - `console/` 按 ADR-002 的栈搭起来，版本先核实再钉死（开放问题 9）；Dockerfile 补上 console 构建阶段。
  - `hc<ConsoleApp>` 客户端；页面：登录、SOP（不含 diff；过期草稿、rebase 与冲突提示；回滚哈希提示）、产品库（schema 生成的表单，锁定字段只读，只提交改过的字段，不含 CSV 导入）、审计日志；demo 匿名只读横幅。
  - `format:check` / `lint` / `typecheck` 覆盖 `console/`；`test` 末尾做生产构建并扫描产物；typecheck 范围内放 `@ts-expect-error` 夹具。
  - 实测开放问题 3（类型引用的耗时与冲突）和 8（`__Host-` 在本地 http 下的表现）。
  - 对应验收 17 的产物与类型部分、22。
- [ ] 13. 会话只读列表：接口和页面（0.5，可砍）。
- [ ] 14. SOP 的逐节 diff 视图：`@codemirror/merge`（1，可砍）。
- [ ] 15. 产品库 CSV 导入：接口和页面（1，可砍）。
- [ ] 16. 部署收尾（1.5）：
  - `deploy/compose.yml` 补上 `app` 与 `platform` 服务，按服务分 env，镜像名用 `APP_IMAGE`。
  - `/console` 的托管与 SPA 回退、安全头。
  - `deploy.sh` 的换容器改成 `docker compose up -d app`，回滚用 `--no-deps` 起 `:prev`。
  - `deploy/backup.sh`：超级用户经 socket 导出、TOC 与行数校验、age 加密、7 天本地轮转、异地 30 天与未配置告警。
  - 对应验收 17 的镜像部分，以及 23 的环境变量部分。
- [ ] 17. 演练与 demo 切换（2）：
  - 在本机 compose 上按 spec「导入、导出与回滚」完整走一遍：首次切换、两种手动回到文件模式（同一镜像、上一个 tag）、备份恢复。
  - 然后由 owner 在线上 demo 执行切换。
  - 恢复演练（验收 19）通过或不通过，以及不敏感的证据（例如 `/healthz` 哈希是否一致、四张 RLS 表的行数比对），记进本文件「验收记录」；主机、路径、异地目标等细节另记。
  - 真实模型对比（验收 21 的手动部分）按「文件 → DB → 文件」交替跑。
  - 对应验收 18、19、21、23。
- [ ] 18. 对照 spec 当前全部验收标准逐条验证，把每条的结果记在本文件「验收记录」一节
- [ ] 19. 清理临时探针与测试
- [ ] 20. owner 确认验收通过后，spec 顶部改 `Status: implemented`

## 工作量与砍法

累计估算：第 6 步结束约第 14 个工程日，第 10 步结束约第 22 个工程日，全部约 35 个工程日。

**第一级**：第 14 个工程日结束时第 6 步还没勾，就按顺序砍：

1. 第 15 步（CSV 导入）。spec 要改：接口列表去掉 `import-csv`，页面去掉 CSV 一条。
2. 第 14 步（diff 视图）。spec 要改：SOP 页去掉 diff 一条。
3. 第 13 步（会话只读列表）。spec 要改：目标 5 改成四页；接口列表去掉 `/conversations`；权限表去掉这一行；验收 16 的 `GET /conversations` 改成 404。
4. 第 11、12 步里的 demo 匿名只读：demo 的后台也要求登录，`admin.html` 仍然匿名可看。spec 要改：R15、权限表、匿名投影一段、不变量 31、验收 16 的 demo 部分、验收 22 的横幅一句。

**第二级**：第 22 个工程日结束时第 10 步还没勾，在第一级之外再砍：

1. 产品库表单只做可编辑字段，锁定字段只读展示；新建线路改用命令行 `catalog-add` 从 JSON 文件建 draft，后台只负责编辑和上架。spec 要改：产品库页面一段、验收 22 的新建一句，命令行列表加 `catalog-add`。
2. 命令行 `member-role`、`member-remove` 推到 02，`user-disable` 保留。spec 要改：命令行列表、审计表、授权表里 `agent_platform` 对 `memberships` 的 DELETE。
3. 验收 21 的手动部分推到 02，自动部分保留。

砍掉的项并入 02 的后台工作；每砍一项，都在 spec 顶部加一行 `Revisions:`，写明改了哪些目标、接口和验收编号。Hono RPC 不砍（spec 裁决 R17）。**第 2–12 步的核心和第 16、17 步不能砍**：表与角色的形状、锁定节与渲染语义、快照的字节与冻结、鉴权的存法、凭据隔离，以后都补不了；回滚和备份没有演练过，就不能切换 demo。

## 实施记录

按步骤号记下实施中的实测结论与偏离 spec 的取舍；不复述 spec。

### 第 1 步（2026-09-26）

- 开工提交：`f6f525c`（dev）。验收 1 的 diff 以它为基准；四个门禁在它上面全绿。
- 前置条件逐项核对，全部具备：`format:check` / `lint` / `typecheck` / `test` 接的是 oxfmt、oxlint + 公开边界脚本、tsc、6 组自测 + mock eval；`.oxfmtrc.json` 排除 `data/sop.md`；`profile().flags.anon_readonly_admin` 存在；`buildSystemPrompt` 不读 profile，`ai_disclosure` 只有 `always`、除启动日志外无人读取（欢迎语里的「AI 旅行顾问」是写死的）；`promptPrefix()` 已导出，`engine.selftest.ts` 有多轮与 prod/demo 逐字节断言；`deploy.sh <tag>` 只收 tag、保留 `:prev`，`/healthz` 返回 `revision`。
- 00 断言过「prod 下 `/api/admin/stream` 匿名可连」：`server.selftest.ts` 的 `PUBLIC` 表含这一项，按「prod 下有意匿名可达：/api/admin/stream 返回 200」检查。验收 1 的唯一例外成立，第 10 步把这一项改成 401。
- 00 开放问题 3 已由 owner 定（见 Open），同一步落地：`.oxlintrc.json` 开 suspicious，关掉 4 条规则；`**/*.selftest.ts` 与 `eval/run.ts` 另外豁免 `no-array-sort`、`no-array-reverse`，因为验收 1 锁住了它们的 diff。业务代码 39 处命中：`sort` / `reverse` 改成 `toSorted` / `toReversed`（都是对临时数组取返回值，语义不变；`searchHotels` 由此已不再原地排序，第 5 步那一条只剩 deep-freeze），`[...arr].sort` 去掉多余的拷贝；两处读 JSON 失败的 `throw` 带上 `cause`；5 处字面量拼接合成一个字面量（字节不变）；两处 `no-unmodified-loop-condition` 是误报（标志在回调或并发调用里改），加行内豁免并写明原因。`toSorted` 要 ES2023 的类型，`tsconfig.json` 的 `target` 从 ES2022 升到 ES2023（只影响类型检查，tsx 不读它）。
- 改完 `PREFIX sha256` 仍是 `system=6c202d63…a423 tools=64c16fc8…92d1`，与 00 记录相同；各组断言数不变（wecom 461、dejargon 333、price-guard 403、server 269，eval mock 19/19）。

### 第 2 步（2026-09-26）

- 版本（开放问题 9，按 npm `latest`）：drizzle-orm 0.45.3、drizzle-kit 0.31.11（1.0 仍是 rc，不取）、pg 8.23.0、@types/pg 8.23.1、zod 4.6.5（v4，自带 `z.toJSONSchema`）、@electric-sql/pglite 0.5.8、@hono/zod-validator 0.9.1；根目录 `hono` 钉成 4.13.9。
- 开放问题 2 的结论：PGlite 0.5.8（内核 PG 18.3）支持 `CREATE ROLE`、`GRANT`、`ALTER DEFAULT PRIVILEGES`、`SECURITY DEFINER`、`sha256()` 与触发器，`SET ROLE` 到非超级用户后 RLS 也生效。`openTestDb()` 因此不跳过任何语句：建三个角色，把库的属主改成 `agent_owner`，`SET ROLE agent_owner` 跑迁移，表和函数的属主、默认权限、授权都与生产相同；默认连接仍是超级用户。PGlite 是 PG 18，CI 与 compose 是 17，RLS 与授权的结论仍以第 3 步的真实 PG 套件为准。
- `Db` / `Tx` 的写法经 typecheck 验证：两个驱动都能赋给 `PgDatabase<PgQueryResultHKT, Schema>`；`PgTransaction` 的第三个类型参数默认是空 schema，`Tx` 要显式写 `ExtractTablesWithRelations<Schema>`。
- spec 没写、此处取定的地方：
  - `catalog_items_guard` 也禁止改 `id`（spec 只列了 `tenant_id`、`kind`、`code`、`ord`）。
  - `auth_session_touch`：会话属于别的租户时一律只返回空、不删行，哪怕它已经过期，不碰别的租户的数据。
  - 会话绝对期限写成 `interval '168 hours'` 而不是 `'7 days'`：timestamptz 加「天」按调用方时区的日历天算，跨夏令时差一小时（审查发现，自测在 `America/New_York` 下断言 168 小时）。
  - `audit_log_by_tenant` 显式写 `id DESC NULLS FIRST`：drizzle 的 `desc()` 默认生成 `NULLS LAST`，与 spec 的 `id DESC` 不一致，`order by id desc` 会多一次排序（审查发现）。
  - `withTenant` 发现会话级泄漏时，node-postgres 下 `release(true)` 销毁连接；PGlite 只有一条连接，退化为 `RESET` 租户设置。
  - 连接池给每条连接挂常驻 `error` 监听。借出的连接 Pool 不替它监听，`withTenant` 进行中库重启、连接被踢或事务空闲超时，都会以未处理的 `error` 事件让整个进程崩掉（审查发现，已在本机 PG 17 容器上复现，并验证修复后 `withTenant` 正常 reject、连接池照常可用）。
  - `holdTenantLock`：`reacquire` 单飞；锁连接还健康时直接返回 `ok`；重连期间被 `release` 会放掉新拿到的锁；锁连接 4 秒连接超时；首次取锁时查询本身出错照原样抛，不当成「锁在别人手里」。同样在 PG 17 容器上验证过：连接被踢后 `onLost` 触发一次，并发两次 `reacquire` 都是 `ok`，别的进程仍拿不到锁，`release` 之后别人能拿到。
  - `migrate.ts` 发现当前用户不是 `agent_owner` 就拒绝执行：换成超级用户跑，建出来的对象归超级用户，FORCE RLS 与权限表都不成立。
  - lint 的两处放宽：`app.tenant_id` 允许出现在 `src/db/**/*.selftest.ts`（RLS 套件要做会话级 SET 来测泄漏）；「配置层不 import 运行时模块」对 `*.selftest.ts` 豁免（spec 要求这些自测动态加载会连带 `store.ts` 的模块）。另外 `app.tenant_id` 也查所有 `.sql`（第 3 步的 `roles.sql` 在内）。
  - 迁移的标注写法：语句正上方的 `--` 行写 `-- migration-allow: <规则>[, <规则>…] <理由>`，规则名 drop、rename、alter-type、add-not-null、set-not-null、add-check、create-or-replace、alter-policy、revoke、execute；缺理由本身算违规。`DO` 块里字符串的内容也按规则查，其中的 `EXECUTE` 一律要标注（审查发现动态 SQL 能绕过）。`0001_rls_auth.sql` 里 `ALTER DEFAULT PRIVILEGES … REVOKE` 已标注。
  - 公开边界检查的误报：新装依赖的 sha512 integrity 哈希偶然撞上私有词表里的一条正则。扫描前把锁文件里的 integrity 值抹掉，包名与 registry 地址照查，行号不变（`19f00a2`）。
  - `drizzle/meta/**` 排除在格式化之外（drizzle-kit 每次生成都整份重写 `_journal.json`）；新增 `pnpm db:generate`；`tsconfig` 纳入 `drizzle.config.ts`。Dockerfile 还没有 `COPY drizzle`，第 3 步补。
- 验证：`db.selftest.ts` 的 PGlite 部分 139 条断言，约 1.3 秒。断言尽量点名是哪条约束或触发器拒的，只比错误码时，一条约束拆掉、别的约束碰巧也拦得住，断言照样绿。变异测试拆掉约束、触发器分支、认证函数里的租户判断与恢复等 20 余处，每一处都让套件变红。验收 20 的 lint 部分在真实仓库上手工验过：迁移里加未标注的 `DROP COLUMN` 或 `SET NOT NULL`、`src/shared/` 引 `drizzle-orm`、`src/config/` 引 `store`、`src/db/` 以外出现 `app.tenant_id`，都失败并点名文件。「修改已提交的迁移」要等迁移进了 dev 才有基准，第 3 步开工时在真实仓库上复验（脚本已在临时仓库里验过）。
- 提交前做了一轮五个角度的对抗审查（SQL 与 spec 对照、安全、连接层、lint 脚本、测试充分性），确认 9 条，都已修掉（上面标了「审查发现」的几条，加上 4 处测试漏洞）；驳回 6 条，例如「`execute(string)` 能绕过 `sql.raw` 禁令」：spec 只禁 `sql.raw`。

### 第 3 步（2026-09-26）

- 开工时补验了第 2 步留下的一条：迁移进了 dev 之后，往 `drizzle/0000_init.sql` 追加一行，`lint` 失败并点名这个文件（验收 20）。
- `deploy/db-init/roles.sql` 是 `roles.sh` 与自测共用的契约：每条语句一行，变量只有三个口令和 `:"db_name"`。已存在的角色把行首 `CREATE ROLE` 换成 `ALTER ROLE`，已存在的库跳过 `CREATE DATABASE`；`roles.sh` 用 sed 做这个替换，自测用同样的规则逐行执行。比 spec 的 DDL 多两处：`agent_owner` 也写 `NOCREATEDB`，重跑时能纠正被改过的属性；加一行 `ALTER DATABASE … OWNER TO agent_owner`，库已存在但属主不对时（例如误设了 `POSTGRES_DB`）改回来。
- `roles.sh`：必须带可执行位（entrypoint 会 source 不可执行的脚本，脚本发现被 source 就拒绝执行）；口令用 psql 的 `\getenv` 读入，不上命令行；会话里设 `VERBOSITY terse` 与 `log_min_error_statement = panic`，语句出错时口令不进 psql 输出和 `docker logs`（实测过：不设时出错的 `ALTER ROLE … PASSWORD` 会写进服务端日志）。`roles.sql` 不能放进 `initdb.d`（entrypoint 会直接执行那里的 `*.sql`），compose 把 `db-init/` 挂到 `/db-init`，脚本另挂成 `initdb.d/10-roles.sh`。
- compose 的 env 文件放在服务器的仓库根目录：`.env.db`（超级用户与三个角色的口令）、`.env.migrate`（`DATABASE_OWNER_URL`）。这个命名已被 `.gitignore`、lint 的路径黑名单和 `deploy.sh` 的 rsync 保护规则覆盖，`.dockerignore` 补了 `.env.*`；放进 `deploy/env/` 会被下一次部署的 `rsync --delete` 删掉。db 的健康检查走 TCP：首次初始化时 entrypoint 的临时服务只开 socket，按 socket 探测会在建角色之前就报健康。项目名固定为 `wecom-sales-agent`。已知的小问题留给第 16 步：`image: ${APP_IMAGE:?}` 让不带 `APP_IMAGE` 的 `docker compose ps` 也报错。
- Dockerfile 拆成 `deps` 与运行两个阶段，运行阶段加 `COPY drizzle`，其余照旧；console 阶段留到第 12 步。
- 本机 docker 端到端验过：镜像能建，`/app/drizzle` 在，pnpm 的符号链接完好；空数据卷上 `run --rm migrate` 先拉起 db、等健康、以 `agent_owner` 迁移，退出 0，重跑也是 0；三个角色的属性、库的属主与编码、PUBLIC 没有 CONNECT 与 TEMP 都对；db 不发布端口。口令轮换从 compose 网络里另一个容器验证（容器内 127.0.0.1 是 trust，在里面试口令什么都证明不了）：改 `.env.db` 并重建 db 之后、跑 `roles.sh` 之前，旧口令仍有效；跑完之后旧口令失效、新口令可用；原样再跑一遍仍是 0。
- `db.selftest.ts` 的真实 PG 部分：有 `PG_TEST_URL` 才跑，`CI=true` 而没有它时失败。临时库建在 `PG_TEST_URL` 指向的集群里，跑完删掉；三个角色是集群级的，已存在就改口令，所以它只能指向专用的测试集群（CI 的服务容器，或本机的一次性容器），CONTRIBUTING 写了本机怎么跑。覆盖验收 12 全部条目与验收 7 的权限部分；另外核对了库级权限、角色属性、`agent_app` 登录后带着两个超时、函数的 EXECUTE 授权、迁移身份检查，以及 json 经 node-postgres 读回键序不变。系统目录那组检查加强为「每张 RLS 表只有一条策略、对所有命令和角色生效、USING 与 WITH CHECK 都是租户模板」：光看策略名，一条 `USING (true)` 的同名策略也能通过。
- 本机 PG 17 上整组 268 条断言（PGlite 150、真实 PG 118）全过，连跑两遍（第二遍角色已存在，走 `ALTER ROLE`）也全过，临时库都删干净了。手工验证：去掉 `catalog_items` 的 `ENABLE ROW LEVEL SECURITY`，10 条失败；新增一张带 `tenant_id` 却没开 RLS 的表，6 条失败；`CI=true` 而没有 `PG_TEST_URL`，失败。验证完已还原。

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

## Open

- 已定（owner，2026-09-26，00 开放问题 3）：oxlint 在 correctness 之外开 suspicious，但关掉 `no-shadow`（139 处，几乎都在自测里）、`consistent-function-scoping`（52）、`no-underscore-dangle`（与 spec 定的 `__configTest` 这类命名冲突）、`no-async-endpoint-handlers`（针对 Express，Hono 的 async handler 是正常写法）。pedantic、perf、style、restriction、nursery 不开：全仓命中 1332 / 136 / 11097 / 1891 / 584，基本是风格噪音或误报（nursery 的 583 条是 `no-undef` 不认 TS 类型）。
- 仍挂在 owner 名下（00 开放问题 1 的余下部分）：文件模式下没设 `DEPLOY_PROFILE` 却配了企微凭据时，是否也拒绝启动。第一个 prod 实例上线前定。

<!-- 「交接」与「Open」两节在第一次停下时再追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：

## Open
- 与 spec 的分歧、需要 owner 裁决的事
-->
