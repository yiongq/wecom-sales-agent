# wecom-sales-agent · 单来

English | [简体中文](README.zh-CN.md)

An AI assistant for industrial RFQs in WeCom Customer Service. Receive inquiries, recognize part numbers, look up catalog stock, calculate quantity-based quotes, request human approval, and hand conversations to an advisor. Prices, orders, links and commitments are checked by deterministic code; the model interprets requests and organizes replies.

The workbench brings conversations, quote approval and advisor replies together. Text, images and spreadsheets can help collect inquiry details. Stock comes from the published catalog snapshot. ERP connectors and usage reporting are in the codebase but have **not been deployed**; do not treat them as available services.

Node 22 · Hono · TypeScript via tsx · PostgreSQL 17 + pgvector · React workbench · MIT software license.

## Request a trial account

Request an account from the person who introduced this project to you. Access is provided on request; there is no public password, automatic account claim or self-service signup. The sign-in address is supplied with the account.

The shared trial account has the agent role: handle assigned conversations and approve their quotes, without editing the catalog, sales SOP or administrator settings. Trial data includes synthetic seeds and messages submitted by trial users. Other members of the shared trial company may see those messages: **do not send personal information, credentials or real customer records**. Trial messages, customer profiles and traces are retained for 7 days; manual reset clears both trial messages and synthetic seeds.

Read the [quick start](docs/guides/quick-start.md) (Chinese) before sending a synthetic inquiry. No purchase, payment or delivery commitment is made by a trial interaction.

## Inquiry to approved quote

1. A customer sends a part number, specification and quantity through an enabled WeCom Customer Service channel.
2. The assistant matches catalog entries and asks about missing or ambiguous specifications. Images and spreadsheet extraction should be checked.
3. Quote tools apply the configured minimum order, packaging and quantity tiers. Catalog stock is a snapshot, not a real-time ERP promise.
4. A quote waits for advisor approval. Only an approved quote can be sent to the customer; rejection voids it and hands off.
5. When a customer asks for a person or the request exceeds the supported scope, an advisor takes over in the original channel. The AI stops replying during human handling.

See [catalog](docs/guides/catalog.md), [sales SOP](docs/guides/sales-sop.md) and [FAQ](docs/guides/faq.md) for permissions and workflow details. Organization, member and channel settings are read-only in this product phase; platform operators apply changes through existing commands during maintenance windows. See the [changelog](docs/guides/changelog.md) for confirmed product releases.

## Developer setup

Use Node 22 and pnpm 10; the exact pnpm version is pinned in package.json.

```sh
pnpm install
DEPLOY_PROFILE=demo CONFIG_SOURCE=file SESSION_STORE=file LLM_MOCK=1 pnpm start
```

This offline smoke configuration uses the repository's default reference pack. Open /chat.html on local port 3200 and /admin.html to inspect the demo. Mock checkout pages do not charge money. The database-backed member workbench at /console/ needs accounts and database configuration; see [local development](docs/guides/local-dev.md) and [account permissions](docs/guides/console-access.md) (Chinese).

The platform supports isolated tenants and industry packs. The industrial pack implements part matching, quantity rules and approval-based RFQs. Travel remains a second industry pack and regression baseline in the developer repository; it is not a second product offering. Demo-profile reset, anonymous read-only console, seed refresh and visitor pruning remain supported in source. Product hosting uses prod and ordinary sign-in; preparing this source does not mean it has been deployed.

Tenant tables use FORCE row-level security, with the login-table exception described in [ADR-001](docs/adr/adr-001-postgres-drizzle.md). Conversation messages are append-only. The current runtime requires a single application instance. Industry logic stays in packs; prompt prefixes remain stable within an SOP version, while per-turn state is separate.

```text
src/core/        engine, tools, guards and model client
src/packs/       industry packs and registry
src/tenancy/     tenant runtime, Host routing and demo sandbox
src/db/          schema, repositories and isolation tests
console/         member workbench
site/            product website and public legal templates
docs-site/      independent VitePress build (not a workspace package)
docs/guides/     user guides; only six approved files enter the public docs build
scripts/         checks, tests and static-site build pipeline
```

The website and documentation use private build inputs for real URLs, brand assets and reviewed legal text. No production identifiers or trial credentials belong in source. Synthetic builds and the screenshot checklist are described in [site/README.md](site/README.md); the docs build is described in [docs-site/README.md](docs-site/README.md). Names and marks are governed by [BRAND.md](BRAND.md), outside the software license.

## Development gates and reference

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Tests are plain tsx scripts. Database selftests normally use PGlite; real Postgres checks require a disposable container. Real-model evals cost money and run separately, never in CI. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), the [architecture reference](docs/architecture/master-reference.md), [specs](docs/architecture/) and [ADRs](docs/adr/) for developer rules and authoritative status. Developer and operations documentation stays in the repository and is excluded from the public docs site.

## License

Software code is licensed under [MIT](LICENSE). The 「单来」 name, Logo and official brand marks are **not included** in the MIT grant; see [BRAND.md](BRAND.md). Third-party licenses are listed in [NOTICE](NOTICE). Market, pricing and customer matters are tracked privately.
