# 本地跑法与门禁

使用 Node 22、pnpm 10（精确版本见 `package.json` 的 `packageManager`）。

```bash
pnpm install           # 安装依赖和 lefthook；提交前检查格式、lint、类型，提交信息检查 Conventional Commits 与 AI co-author

# 离线冒烟（不调真实 LLM，文件配置与文件会话存储）
DEPLOY_PROFILE=demo CONFIG_SOURCE=file SESSION_STORE=file LLM_MOCK=1 pnpm start

# 真实 LLM
cp .env.example .env   # 填模型凭据；启动时自动加载，不提交此文件
pnpm start

# 四个门禁（git hook、CI、部署使用同一接口）
pnpm format:check      # oxfmt
pnpm lint              # oxlint + 公开边界、模块边界、迁移、后台源码检查
pnpm typecheck         # 服务端与 console 两份 tsc --noEmit
pnpm test              # 锁定套件、其余服务端/后台自测、两种配置的 mock eval、字体与后台构建产物检查

# 单独跑全部锁定套件：使用固定时钟，避免硬编码出发日期过期
pnpm -s test:locked
# 单独跑某个锁定套件时沿用 package.json 的时钟与 import
CONFIG_SOURCE=file PARITY_CLOCK_MS=1790913600000 pnpm exec tsx --import ./src/store/parity-clock.ts src/engine.selftest.ts
```

`pnpm test` 不要求外部 Postgres：数据库相关自测使用 PGlite，mock eval 跑两种配置：文件配置，以及加 `CONFIG_TEST_DB=pglite` 的数据库配置。截至 10，两种配置各 900 条 v2 用例全过、8742 项断言、快照 0 处差异（[10 plan](../architecture/10-industrial-rfq-pack/plan.md)「验收记录」），准确数以运行输出为准。要验证真实 PostgreSQL 权限与恢复，按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 给一次性测试集群设置 `PG_TEST_URL`，跑完移除；不要指向已有数据库。真实模型回归另跑 `eval/run.ts`，会产生费用。

启动后用本机 3200 端口打开 `/console/`（DB 模式）进入后台，或打开 `/chat.html` 聊天，`/admin.html` 实时看作战室；回复中的 `/pay/<订单号>` 是 mock 收银台。成员后台需 DB 配置、账号与 HTTPS；本地开发另运行 `pnpm --filter console dev`（Vite HTTPS 开发服务，代理本机 3200 端口 API），构建用 `pnpm --filter console build`。配置与账号初始化见 [部署](deployment.md)；`CONFIG_SOURCE=file` 时不能使用成员后台 API。

**部署 profile**：`DEPLOY_PROFILE=demo|prod`，不设按 demo，但配企微凭据却未显式设置就拒绝启动。重置口令、匿名只读作战室、种子保鲜、访客裁剪、网页模拟器与匿名 mock 支付保留在 demo；prod 关闭演示开关，不能用 `FLAG_*=on` 绕过，且必须配 `ADMIN_PASS`。开关与其含义见 [.env.example](../../.env.example)。
