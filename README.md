# wecom-sales-agent

English | [简体中文](README.zh-CN.md)

An AI sales agent for WeCom (企业微信) Customer Service: the AI greets customers in WeChat or on the web, works out what they need, recommends and quotes from the product catalog, creates orders and follows up. Prices, orders, links and handoff are decided and checked by code; the model only understands the request, picks tools and writes the wording.

One engine serves isolated tenants. Industry logic plugs in as industry packs, while brand, sales playbook and catalog are configuration. The repository ships two public reference packs: tailor-made travel and industrial RFQ (request for quotation). When a customer asks for a person, complains, or wants something the system cannot deliver, the AI hands off to an advisor, who takes over in the member workbench, replies on the original channel, approves quotes and confirms payment.

Node 22 · Hono · TypeScript (run directly by `tsx`) · PostgreSQL 17 + pgvector · Vite + React console · MIT license.

**Status**: phases 00–10 are `implemented`; 00–08 are released, and 09 (quote approval) and 10 (industrial RFQ pack and demo tenant) are live on the demo environment, awaiting release. The roadmap is in the [master reference](docs/architecture/master-reference.md) (Chinese).

## Live demo

| Entry                                                        | What you get                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Try it, no sign-up**](https://travel.yiongspace.com/try)  | Spins up a temporary tenant of your own, with copies of the sample conversations, orders and catalog, and drops you into the member workbench. Scan the QR code with your own WeChat to play the customer, or chat in the web simulator. Kept for up to 24 hours; the whole tenant is deleted after 2 idle hours or when you end it |
| [Sign-in / member workbench](https://travel.yiongspace.com/) | Members sign in to handle conversations: take over, reply, hand back to the AI, confirm price and payment                                                                                                                                                                                                                           |
| [Web simulator](https://travel.yiongspace.com/chat.html)     | Play the customer through needs, recommendation, quote, order and mock payment; visitors' model calls are capped per day, after which an offline script takes over                                                                                                                                                                  |
| [Sales war room](https://travel.yiongspace.com/admin.html)   | Read-only without sign-in: watch the demo seed and the conversations you just had in the same browser                                                                                                                                                                                                                               |

All entries above belong to the travel demo tenant. The brand 「云途定制旅行」 and the routes, hotels and prices under `data/` are fictional (see [data/README.md](data/README.md)); the industrial pack's catalog is synthetic too. Payment is a mock page: nothing is charged and it is not WeChat Pay.

## Key design points

1. **Tenant isolation is enforced, in the database and in the process.** Every table with a `tenant_id` has PostgreSQL row-level security with FORCE (the login tables are exempt per [ADR-001](docs/adr/adr-001-postgres-drizzle.md)); a [selftest](src/db/db.selftest.ts) finds tables from the system catalog and fails if a new one is missed, and all three database roles are `NOBYPASSRLS` ([roles.sql](deploy/db-init/roles.sql)). Over 600 pieces of module-level state are registered with an owner in [state-manifest.ts](src/tenancy/state-manifest.ts), and anything unregistered fails `pnpm lint`. The [isolation selftest](src/tenancy/sandbox/isolation.selftest.ts) grows one sandbox process to 2 tenants and back to 0 with interleaved conversations and no cross-tenant leaks.
2. **One deployment, tenants routed by Host.** One image runs as two services. The host process loads the standard tenants; with more than one, routing matches the Host strictly and every tenant needs its own `public_host` ([hosts.ts](src/tenancy/hosts.ts)). The sandbox process hosts many temporary tenants at once and deletes each one whole when it expires ([05 spec](docs/architecture/05-tenancy-sandbox/spec.md)). On the demo environment the travel and industrial RFQ demo tenants share one deployment ([10 spec](docs/architecture/10-industrial-rfq-pack/spec.md) R16).
3. **Money and links are verified by code.** Quotes are computed only by the quote tool from the catalog and fixed rules. Every amount in a reply must trace back to the catalog or to this conversation's tool results before it is sent; Chinese numerals, shorthand like `38k` and full-width digits are normalized first ([money.ts](src/core/parse/money.ts)), and untraceable amounts never go out. Site links are registered per pack, only this conversation's orders and documents generated this turn get through, and domains the model invents are stripped ([site-links.ts](src/core/site-links.ts), [link-whitelist.ts](src/core/guards/link-whitelist.ts)).
4. **Quotes are approved before they go out.** A pack can give the generic orders it creates an approval state. An unapproved quote's link never reaches the customer, its page shows no amount, and no order entry point can confirm it or mark it paid. Once an advisor approves it in the workbench, the system pushes the quote page `/quote/<order id>`; a rejection voids it and hands off ([09 spec](docs/architecture/09-quote-approval/spec.md)).
5. **Industry logic lives in packs; the core knows no industry.** Core code that imports a pack fails lint ([check-boundaries.ts](scripts/check-boundaries.ts)). The [travel pack](src/packs/travel) searches routes, quotes and builds proposals; the [industrial RFQ pack](src/packs/industrial) normalizes part numbers, prices by quantity tier and minimum order, handles multi-line inquiries and sends every quote to human review by default ([ADR-005](docs/adr/adr-005-industrial-reference-pack.md)). Both configurations (file and PGlite database) pass 900 v2 regression cases with 8,742 assertions and zero snapshot diffs, and the travel prompt prefix stays byte-identical ([10 plan](docs/architecture/10-industrial-rfq-pack/plan.md)).
6. **Handoff is rule-triggered, and the advisor wins.** Emergencies, negative sentiment and interaction failures are detected by rules; an emergency gets a fixed reply without calling the model ([trigger-rules.ts](src/handoff/trigger-rules.ts)). Once an advisor takes over, the AI reply of the turn in flight is not sent, and a restart replay does not send it either ([02 spec](docs/architecture/02-conversations-workbench/spec.md)).
7. **Evals decide model choice and cost.** Three rounds of model evals each overturned the earlier call: the candidate with the best route hit rate and 46% lower cost was rejected because 17% of its turns took over 8 seconds; engine-side prefetch then cut round trips, and the current model now has 0 first turns over 8 seconds ([model selection](docs/guides/model-selection.md)). Prefix caching cut the cost of the same regression run from ¥2.52 to ¥0.80, with a 94.2% input cache hit rate ([prefix cache](docs/guides/prefix-cache.md)).

## Architecture

```text
Customer touchpoints                       one image, two services: APP_ROLE=host | APP_ROLE=sandbox
  WeCom Customer Service (callback + sync_msg, polling fallback) ─┐
  Web channel /w/<key> ────────────────────────────────────────────┼─▶ tenant by Host (public_host;
  Web simulator /chat.html (host only) ────────────────────────────┘    sandbox tenants in-process)
                                                                      │
                                                                      ▼
  engine (core, industry-agnostic)
    ├─ prefetch ─▶ model tool loop ─▶ tools of the tenant's pack
    │                                  ├─ travel: search_routes · search_hotels · get_route_detail
    │                                  │          create_quote · generate_proposal · create_order
    │                                  └─ industrial: find_parts · quote_items · create_quote_sheet
    ├─ outbound guard pipeline: money provenance · site-link registry · shape · injection · pack policy checks
    ├─ deterministic handoff and fixed replies (both packs also have handoff_to_human)
    └─ stage and profile derived from the actual tool calls

  Customer pages (plain HTML)  /pay/<order id> · /proposal/… (travel) · /quote/<order id> (09) · /privacy
  Member console /console/ (Vite + React) ── console-api ── take over · reply · approve quotes · confirm payment · edit SOP and catalog
  Demo war room /admin.html ── legacy API (anonymous read-only in demo)

  PostgreSQL 17 + pgvector (FORCE RLS)
    config and versions (SOP, catalog, policy, knowledge base) · conversations and append-only messages · orders and quotes
    channel_inbox (WeCom inbound and cursor) · jobs (follow-ups, handoff notices, retention) · turn_traces · guard_events · usage_daily
  File mode: CONFIG_SOURCE=file reads data/, SESSION_STORE=file writes var/ (offline smoke runs and selftests)
```

Money, orders, links and handoff sit in deterministic code, and the model has no path to change them. Within one SOP version the SOP, fixed requirements and tool definitions stay byte-identical, and per-turn state travels as a separate message, so the prefix cache keeps hitting. A database store does not mean multiple replicas: the identity map, serialization locks and some rate counters are still in-process, so it must run as a single instance for now. Details: [how it works](docs/guides/how-it-works.md) (Chinese).

## Repository layout

```text
src/core/        engine, guard pipeline, money parsing, site links, LLM client (no industry code)
src/packs/       industry packs: travel/, industrial/, and the registry
src/tenancy/     tenant runtimes, Host routing, state manifest, sandbox process
src/adapters/    channel adapters (WeCom, web channel, simulator)
src/db/          Drizzle schema, repositories, RLS selftests
console/         member console (Vite + React), served at /console/
public/          hand-written pages: simulator, web channel, pay, proposal, quote, try, war room
data/            demo SOP and catalogs; data/packs/industrial/ holds the synthetic industrial pack data
eval/            regression cases (v1 and v2), simulated-customer goals, model A/B script
deploy/          Compose file, DB init, backup, host watchdog, rollback guard; deploy.sh at the root
scripts/         repo checks behind lint and test, CI sharding, load tests, demo seeding
docs/            specs and plans, ADRs, guides (Chinese)
```

Each `*.selftest.ts` sits next to the code it covers; tests are plain tsx scripts.

## Quick start

Use Node 22 and pnpm 10 (the exact version is pinned in `packageManager` in `package.json`).

```bash
pnpm install
```

Offline smoke run: no real model, file config and file session store.

```bash
DEPLOY_PROFILE=demo CONFIG_SOURCE=file SESSION_STORE=file LLM_MOCK=1 pnpm start
```

Then open `/chat.html` on local port 3200 to play the customer and `/admin.html` for the war room; the `/pay/<order id>` links in replies are a mock checkout. For a real model, copy `.env.example` to `.env` and fill in model credentials. The member console `/console/` needs database config and accounts; see [local development and gates](docs/guides/local-dev.md) (Chinese).

Four gates; git hooks, CI and deploy call only these names:

```bash
pnpm format:check   # oxfmt
pnpm lint           # oxlint + public-boundary, module-boundary, migration, console-source and tenant-state checks
pnpm typecheck      # tsc --noEmit for the server and the console
pnpm test           # locked suites, module selftests, mock regression in both configs, font and console-build checks
```

`pnpm test` needs no external Postgres; database selftests use PGlite. Real-model regression runs separately through `eval/run.ts` (without `LLM_MOCK`), costs money and never runs in CI. Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese); rules for coding agents are in [AGENTS.md](AGENTS.md).

## Documentation

All documents below are in Chinese; this README is the only English document.

Operations and internals:

| Document                                                     | Covers                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [How it works](docs/guides/how-it-works.md)                  | One turn end to end, guards, rule-based handoff, WeCom dedup and recovery, quote approval |
| [Model selection](docs/guides/model-selection.md)            | Three rounds of model evals, prefetch, hedging, switching providers                       |
| [Prefix cache and cost](docs/guides/prefix-cache.md)         | Request ordering, block-wise history window, hit rate and pricing                         |
| [Observability and privacy](docs/guides/observability.md)    | Traces, run metrics, alerts, OTel, retention                                              |
| [Local development and gates](docs/guides/local-dev.md)      | Running locally, gates, locked suites, deploy profiles                                    |
| [Console, accounts and roles](docs/guides/console-access.md) | War room and workbench auth, role permission table                                        |
| [Deployment](docs/guides/deployment.md)                      | Tag-based deploys, rollback guards, multi-tenant Host, switching stores                   |
| [Connecting real WeCom](docs/guides/wecom.md)                | The Customer Service channel and the admin setup order                                    |
| [Path to production](docs/guides/production-path.md)         | What is built and what comes later, such as multiple replicas                             |

Design and decisions:

| Document                                                  | Covers                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| [Master reference](docs/architecture/master-reference.md) | Positioning, settled decisions, phased roadmap               |
| [docs/architecture/](docs/architecture/)                  | Per-phase specs and plans (00–10); `Status` is authoritative |
| [docs/adr/](docs/adr/)                                    | Cross-phase technology choices                               |
| [Spec-driven development](docs/spec-driven-dev.md)        | How specs, plans and reviews work                            |

## License

[MIT](LICENSE). Third-party content shipped with the repository (fonts, icons and more) and its licenses are listed in [NOTICE](NOTICE). Market, pricing and customer matters are tracked privately, outside this repository.
