# ADR-001：存储选型：Postgres + pgvector，Drizzle + pg，租户隔离做两层

- **状态**：采纳
- **日期**：2026-09-25
- **背景**：数据现在放在进程内的 Map 里，每次变更后整份重写 `var/*.json`，没有事务，只能跑单实例。产品化路线需要消息只追加、报价快照、逐轮 trace、持久任务、多租户隔离和知识库检索，这些都要一个真正的数据库（见[总参考](../architecture/master-reference.md)「分阶段路线」）。

---

## 决策

1. **数据库：PostgreSQL 17 + pgvector 0.8.x**，另装 `pg_trgm`：中文没有内置分词，模糊匹配用三元组，语义检索用向量。
   - 开发和演示环境用 compose 自托管 `pgvector/pgvector:pg17`。
   - 只用标准 Postgres 能力，不依赖任何托管平台的专有功能。换托管库时只需 `pg_dump` / `pg_restore`，再改 `DATABASE_URL`。
2. **查询层：Drizzle ORM + drizzle-kit。**
   - 迁移生成 SQL 文件，提交进仓库，人工审阅。
   - 策略、触发器、`SECURITY DEFINER` 函数写在 custom 迁移里。
   - 生产驱动用 node-postgres（`pg.Pool`）。
   - 所有依赖钉死精确版本。
3. **测试。**
   - 需要 Postgres 语义的自测（例如存储实现的一致性自测）用 PGlite（`drizzle-orm/pglite`，进程内 Postgres，不需要 Docker）。
   - RLS 套件跑在 CI 的真实 Postgres 服务容器上，以应用角色连接。PGlite 默认以超级用户连接，按 Postgres 通则会绕过 RLS（待核实），所以 RLS 的结论不从 PGlite 上得出。
   - 现有 6 组自测默认跑哪种存储，见总参考「开放问题」，01 spec 定。
4. **租户隔离两层都做。**
   - **应用层**：
     - 每个仓储函数都必须拿到租户上下文：`withTenant(ctx, tx => …)`，上下文由 AsyncLocalStorage 携带。
     - SQL 全部带 `tenant_id`。
     - 进程内的缓存键全部带租户 id。identity map、产品库快照、SOP 缓存、会话串行锁、限流、洞察缓存都在内存里，RLS 管不到它们。
   - **数据库层**：
     - 租户内的表开 `ENABLE` 和 `FORCE ROW LEVEL SECURITY`。登录相关的表例外，见下文「实现时必须处理的坑」第 2 条。
     - 三个角色：`agent_owner` 持有表、跑迁移；`agent_app` 供运行时使用，不是表属主，`NOBYPASSRLS`；`agent_platform` 专做平台级查询，走单独的代码路径。
     - 每个事务里执行 `set_config('app.tenant_id', $1, true)`。策略写成 `NULLIF(current_setting('app.tenant_id', true), '')::uuid`，没设租户时返回 0 行。
   - **demo 和 prod 各用一个数据库**，demo 的缺陷碰不到 prod 租户的数据。
5. **表结构约定。**
   - 租户内的新表用 uuid 主键，以后合并库不会冲突。
   - `conversations` 和 `orders` 保留旧 id 字符串（`wecom:…`、`ord_…`），已发出的付款链接继续有效。它们的主键从建表起（02）就是 `(tenant_id, id)`，引用它们的外键都带上 `tenant_id`：`wecom:<external_userid>` 在多家企业之间可能重复，等到 04 再改主键就是一次破坏性迁移，违反决策 6。
   - 类枚举字段用 `text + CHECK`，不用 PG enum，后者难迁移。
   - `messages` 只追加：REVOKE UPDATE/DELETE，删除只能走 `SECURITY DEFINER` 的清除函数。
6. **迁移只扩不缩。** 部署失败会自动回滚到上一个镜像，所以一次发布里的迁移只能加表、加列；删列和改名等下一次发布。CI 加迁移 lint，没有显式标注的 `DROP` / `RENAME` 直接拒绝。

## 理由

- **现状撑不住。** `src/store.ts` 每次变更防抖 200ms 后重写整个文件；消息超过 400 条会被真删；保留期删除和按条件查询都做不了。
- **为什么直接上 Postgres，不走 SQLite 过渡。** SQLite 过渡方案本身带着换库条件，满足任一条就换：
  - 同一部署服务第二家客户，需要行级隔离（RLS）；
  - 需要 pgvector；
  - 需要多个进程并发写；
  - 需要多个实例。

  多租户 RLS 和 pgvector 知识库都已经排进 01–04，这些条件在路线内一定会满足。走过渡就要多迁移一次数据，多维护一种方言。

- **为什么选 Drizzle。**
  - RLS 策略（`pgPolicy`）、pgvector 列（`vector` / `halfvec`）和 HNSW 索引都能直接写在 schema 里。
  - 有官方的 PGlite 驱动，drizzle-kit 也支持 `driver: "pglite"`。
  - drizzle-zod 只在服务端使用：从表定义生成 Hono 校验器的 schema，不必手写第二份。后台表单用行业包里不依赖 drizzle 的 zod（ADR-002 决策 1），前端的接口类型靠 Hono RPC 的纯类型推导，浏览器包里不会出现 drizzle 或 pg。
- **为什么两层都做。** RLS 让漏写 `WHERE` 的查询失败时是关闭的，而不是泄漏数据；应用层过滤管的是 RLS 碰不到的进程内缓存。只做其中一层都会留缺口。
- **为什么要 FORCE。** 不加 FORCE，表属主会绕过 RLS。再把迁移角色和运行时角色分开，运行时的连接无论如何都受策略约束。

## 实现时必须处理的坑

1. **连接池**：连接池下只能用事务级的 `set_config(..., true)`。所有租户查询都要经过 `withTenant`，lint 禁止在 `db/` 以外直接使用 pool。
2. **登录相关的表**：`tenants`、`users`、`auth_sessions` 不能套租户 RLS 模板，因为登录时还不知道租户。这几张表用平台角色或 `SECURITY DEFINER` 函数访问。
3. **不依赖 `BYPASSRLS`**：托管库的高权限账号能不能授予它，还没核实。
   - 平台级访问写显式的 `TO agent_platform` 策略。
   - FORCE 之下，只要属主没有 BYPASSRLS，`SECURITY DEFINER` 函数照样受 RLS 限制。要么在函数里自己设租户，要么给属主单独写策略。
4. **公开路由**：总参考阶段 0 定的公开路由白名单（付款 / 订单确认页、单订单读取、方案书，以及 demo 下网页模拟器的 `/api/stream/:sessionId` 等）没有登录态，也就没有租户上下文，FORCE 下会返回 0 行。
   - 要按域名或 `SECURITY DEFINER` 函数解析租户。
   - 一个容器一个租户期间，用环境变量里的默认租户。
5. **`jsonb` 会重排键序**：工具把线路和酒店对象直接 `JSON.stringify` 发给模型，字节一变，前缀缓存和回归都会漂。这类字段用 `json` 类型，或者读出来后按固定键序重建对象。
6. **向量列用 `halfvec`**：智谱 embedding-3 默认 2048 维，而 pgvector 的 HNSW 索引对 `vector` 最多支持 2000 维，对 `halfvec` 支持 4000 维。
7. **扩展的 schema 不写死**：用 `CREATE EXTENSION vector WITH SCHEMA …` 显式指定，列类型不带 schema 前缀。不同平台把扩展装在不同的 schema 里。

## 被否决的方案

- **SQLite 过渡**：见「理由」第二条。它的换库条件在路线内一定会满足，过渡等于多迁移一次。
- **Prisma**：
  - RLS 要靠 client extensions 加 `$transaction` 实现，写法别扭。
  - pgvector 历史上只能用 `Unsupported("vector")` 加原生 SQL（这次没有复核是否已经原生支持）。
  - 迁移更重。
- **Supabase**：
  - 没有中国大陆区（最近的是新加坡、东京、首尔），数据会出境，大陆访问也不稳定。
  - Free 档闲置 7 天会自动暂停。
  - 我们的 RLS 靠 `set_config`，不靠它的 JWT；登录和推送都是自建的。它的卖点我们用不上。
  - 它的 `postgres` 角色带 bypassrls，会掩盖上面第 3 个坑，换平台后才暴露。
- **Kysely**：可以接受的备选。但 RLS 策略要手写 SQL 迁移，pgvector 要写原生 `sql` 模板，PGlite 只有社区驱动（`kysely-pglite`），类型共享还要另跑 kysely-codegen。

## 后果

- **变好的**：有了事务和只追加的消息表；漏写租户条件的查询在数据库层失败时是关闭的；trace、持久任务和向量检索都放在同一个库里，不用另起 Redis、队列或向量库。
- **代价**：
  - 部署多了一个有状态服务：compose 编排、迁移任务、每晚备份和恢复演练都要有人维护。
  - store 从同步的内存读写变成异步 IO，要靠 identity map 让 `getSession` 保持同步，引擎里「生成中顾问接管」「生成中客户付款」这类共享对象的语义要逐个保住。
  - 每个查询都要经过 `withTenant`；登录相关的表、公开路由和平台级查询都要单独处理（见上文「实现时必须处理的坑」）。
- **以后变难的事**：
  - 迁移只扩不缩，删列和改名要跨两次发布。
  - 有了真实租户数据之后，改主键或拆表都是在线迁移，所以会话主键在 02 建表时就带上租户。
  - RLS 策略写在 custom 迁移里，改策略要走迁移，并重跑 RLS 套件。
  - 上多副本之前要补 fence read 和 advisory lock（见总参考「从单实例到多租户」）。

## 后续动作

- 01：
  - 开工前核实 Drizzle 当前的稳定大版本，钉死精确版本；核实 PGlite 默认连接是否绕过 RLS。
  - 建本阶段的 7 张表：tenants（带 `locale` / `region`）、users、memberships、auth_sessions、audit_log、sop_versions、catalog_items。`usage_daily` 随 `usage.ts` 的迁移移到 02（见 01 spec R14）。
  - 建三个角色，实现 `withTenant`。
  - CI 加迁移 lint（决策 6）。
  - compose 加迁移任务，每晚执行 `pg_dump -Fc` 并留异地副本，做一次恢复演练。
  - CI 加 Postgres 服务容器和 RLS 套件。
  - 自测默认跑哪种存储，01 spec 定（见总参考「开放问题」）。
- 02：
  - 会话、消息、订单、报价快照、`turn_traces`、`jobs` 入库；`conversations`、`orders` 按决策 5 用 `(tenant_id, id)` 主键。
  - identity map 的加载方式和写入顺序在 02 spec 里定。
  - 会话保留期清理经清除函数执行。
- 03：知识库改用 pgvector，替换进程内的向量缓存文件。
- 04：
  - 同一部署服务多个租户：公开路由按域名或 `SECURITY DEFINER` 函数解析租户。
  - 跨租户泄漏测试覆盖进程内缓存。
- 换成托管 Postgres 之前：
  - 把 CI 指向目标库，跑一遍 RLS 套件；
  - 核实这家云的 pgvector 版本和 BYPASSRLS 授权。

## 参考

- [pgvector](https://github.com/pgvector/pgvector)：HNSW 支持的维度上限（`vector` 2000，`halfvec` 4000）。
- Drizzle 官方文档：[RLS](https://orm.drizzle.team/docs/rls)（`pgPolicy`、事务内的 `set_config`）、[向量相似度检索](https://orm.drizzle.team/docs/guides/vector-similarity-search)、[PGlite 驱动](https://orm.drizzle.team/docs/connect-pglite)、[drizzle-zod](https://orm.drizzle.team/docs/zod)。
- [智谱 embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)：维度可在 256–2048 之间设置，默认 2048。
- [Supabase 区域列表](https://supabase.com/docs/guides/platform/regions)。
- 托管 Postgres 的 pgvector：[腾讯云 PostgreSQL](https://cloud.tencent.com/document/product/409/132364)、[阿里云 RDS PostgreSQL](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/pgvector-use-guide)。
