# 贡献指南

目前暂不接受外部 PR。将来开始接受时使用 DCO：每个提交都带 `Signed-off-by`（`git commit -s`），不需要签 CLA。依据见 [ADR-003](docs/adr/adr-003-open-core-boundary.md) 决策 1。

先读 `AGENTS.md`，里面的规则对人同样适用。

- 实质性改动先写 spec，流程见 `docs/spec-driven-dev.md`。
- 常规 PR 合进 `dev`。提交信息用 Conventional Commits，标题不超过 50 字符，不加 AI co-author 署名。
- 开 PR 前跑完四个门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
- `pnpm test` 里数据库自测的 RLS、授权与租户锁部分要一个真实 Postgres，给了 `PG_TEST_URL` 才跑（CI 里总是跑）。本机起一个一次性容器再跑：`docker run -d --rm --name pgtest -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17`，然后 `PG_TEST_URL=postgres://postgres:pw@127.0.0.1:55432/postgres pnpm test`。它会建临时库、改三个 `agent_*` 角色的口令，所以不要指向开发或线上用的集群。
- 后台前端在 `console/`（ADR-002）。服务端以 DB 模式跑在 `:3200` 时，`pnpm --filter console dev` 起开发服务器，打开 `https://localhost:5173/console/`，`/api` 会代理过去。开发服务器用自签证书走 https：会话 cookie 是 `__Host-` 前缀、必须 Secure，Safari 在 http 的 localhost 上不存，第一次打开要在浏览器里接受证书。`pnpm --filter console preview` 按线上的安全头（含 CSP nonce）托管构建产物。
- 首次全仓格式化的提交列在 `.git-blame-ignore-revs` 里。clone 之后跑一次 `git config blame.ignoreRevsFile .git-blame-ignore-revs`，`git blame` 就会越过它，指到格式化之前的提交。
- 没有实际需要就不加依赖、不加抽象；不从许可证不兼容或私有来源复制代码。
- 不提交客户数据、凭据、真实企微标识、二维码、生产域名或服务器 IP。
- issue 和 PR 用中文或英文都可以。
