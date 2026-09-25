# 贡献指南

目前暂不接受外部 PR。将来开始接受时使用 DCO：每个提交都带 `Signed-off-by`（`git commit -s`），不需要签 CLA。依据见 [ADR-003](docs/adr/adr-003-open-core-boundary.md) 决策 1。

先读 `AGENTS.md`，里面的规则对人同样适用。

- 实质性改动先写 spec，流程见 `docs/spec-driven-dev.md`。
- 常规 PR 合进 `dev`。提交信息用 Conventional Commits，标题不超过 50 字符，不加 AI co-author 署名。
- 开 PR 前跑完四个门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
- 没有实际需要就不加依赖、不加抽象；不从许可证不兼容或私有来源复制代码。
- 不提交客户数据、凭据、真实企微标识、二维码、生产域名或服务器 IP。
- issue 和 PR 用中文或英文都可以。
