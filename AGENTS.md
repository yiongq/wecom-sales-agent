# wecom-sales-agent — Repository Guidelines

wecom-sales-agent is an AI sales agent for WeCom Customer Service (微信客服), built with Node 22, Hono and TypeScript run directly by tsx, and being evolved from a single-tenant demo into a general multi-tenant product. Read this file first; it is the single source of rules for any coding agent. Claude Code reads it via `CLAUDE.md`; other agents read it directly.

## How we work

- Substantial work — a new module, a cross-module change, a data migration, a public contract — starts from `docs/architecture/<goal>/spec.md`. Read it before writing code. Do not invent architecture the spec does not describe; if the spec is insufficient, stop and say exactly what is missing.
- `plan.md` next to the spec is the only progress tracker. Update it as you go. Never create `tasks.md` or any other todo file.
- Starting without instructions ("继续", "开工", or nothing at all): the active work is the lowest-numbered `docs/architecture/NN-*/spec.md` whose `Status` is `ready` and whose `plan.md` still has unchecked steps. Continue from its first unchecked step, or from the half-done state its handoff notes describe. If the only unchecked step left is the `Status: implemented` step, report the acceptance results and stop — do not pick another spec and do not promote. Say which spec and step you picked before touching anything; ask only if two spec folders share the same number or the handoff notes contradict the code.
- `Status: draft` → `ready` is the owner's call; never promote a spec yourself. Set `Status: implemented` only after every acceptance criterion has been verified, the results are recorded in `plan.md`, and the owner has confirmed.
- Changing a decision once the spec is `implemented` (or once code depends on the contract) means writing a new spec that supersedes the old one; mark the old one `Status: superseded by <link>`. The one lighter path is an **amendment**: a later spec may add to an `implemented` spec — a new interface member, a new enum value, a tightened choice — without changing or removing anything; the amending spec carries the full text and an `Amends:` line, the amended spec gains an `Amended by:` line and is otherwise untouched. Before `implemented`, a `draft`/`ready` spec may be revised in place only if the change is recorded in its top `Revisions:` line — see `docs/spec-driven-dev.md`.
- Trivial changes (style, copy, localized logic with one obvious owner) need no spec.
- Cross-phase technology choices are ADRs in `docs/adr/`; specs cite them instead of restating them.
- The architecture reference is `docs/architecture/master-reference.md`. Process details: `docs/spec-driven-dev.md`.
- This repository is public (MIT). Decisions that affect contributors and users — license, boundaries, interfaces, trade-offs — go into public specs and ADRs. Market judgement, pricing, customers, company registration, revenue and negotiations never enter the repo; they are tracked privately outside it, and public docs only say "tracked privately" (另记).

## Hard rules (non-negotiable)

- Money and commitments are never decided by the model: prices, orders, payment links and handoff go through deterministic code (price guard, tools, engine safety nets), and every new guard ships with a selftest.
- The system prompt prefix (SOP + fixed hard requirements + tool definitions) must stay byte-identical within one SOP version; per-turn state goes into the separate context message, never into the system prompt.
- Any change to the SOP, prompts or guards must pass `pnpm test`; switching models or large SOP changes also require a manual real-model eval run (`eval/run.ts` without `LLM_MOCK`), which costs money and never runs in CI.
- Demo-instance behaviors (reset command, anonymous read-only console, seed freshening, visitor pruning) must keep working; production hardening goes behind `DEPLOY_PROFILE` switches, never by removing demo behavior.
- No customer data, credentials, real WeCom identifiers (corp id, `open_kfid`, `external_userid`), QR images, production domains or server IPs in the repo. The one exception is the public demo URL in the README's online-demo section. Market, pricing and customer notes live in private notes outside the repo; public docs only say "tracked privately".
- Secrets live only in env files on the server, outside the repo (split per compose service from phase 01 on), and never appear in logs. The one planned exception: per-tenant channel credentials (phase 04) may be stored in the database encrypted at rest, with the encryption key kept in an env file.
- From phase 01 on, every tenant-scoped table carries `tenant_id` under FORCE row-level security (the login tables are exempt, see ADR-001). Once conversations move into Postgres (phase 02), messages are append-only.
- Customer-facing WeChat text never contains markdown.
- No code from license-incompatible or proprietary sources; copied third-party code keeps its header and is listed in `NOTICE` (create it on the first such copy).

## Development

- Package manager: pnpm 10 (the exact version is pinned in `packageManager`; CI and the Dockerfile install it through corepack). Runtime: Node 22.
- Layout: `src/` (server, engine, tools, guards; channel adapters in `src/adapters/`; each `*.selftest.ts` sits next to the code it covers), `data/` (demo SOP and product catalog), `public/` (hand-written HTML pages), `eval/` (regression cases and runners), `var/` (runtime JSON state, gitignored), `docs/` (specs, plans, ADRs).
- Docs: `AGENTS.md` is in English; every other document (specs, plans, ADRs, `CONTRIBUTING.md`) is in Chinese.
- Gates: four `package.json` script names are the only interface — `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Git hooks, CI and the Claude Code Stop hook call only these names; tools are swapped only inside `package.json`. Behind them: oxfmt and oxlint (wired in phase 00; until then those two scripts are placeholders), `tsc --noEmit`, and the six `*.selftest.ts` suites followed by `eval/run.ts` in mock mode (`LLM_MOCK=1`). Tests are plain tsx scripts; do not introduce vitest or another test framework.
- Before handoff run all four gates; `pnpm test` takes seconds, so run it whole. The shared gate is git hooks (lefthook: pre-commit runs format+lint+typecheck, commit-msg runs commitlint and the AI co-author check) plus CI — they apply to every agent and every human. Claude Code's `.claude/settings.json` Stop hook is an extra layer, not the only one.
- Tests are regression protection, not scaffolding. Commit only durable tests for user-visible behavior, documented contracts, persistence/migration, concurrency, recovery and security boundaries.
- Prefer the smallest correct change; add no abstraction or dependency without a real need.

## Working with more than one agent

Any two sessions forget each other — a different agent, or the same agent in a new window — so everything that matters lives in files:

- `plan.md` is the only handoff surface. Before you stop — for any reason — update it: mark what is done, what is half-done (and in what state the code was left), and what the next step is. A session that ends without updating `plan.md` is a failed session.
- Leave the worktree either committed or with a clean, described diff. Never leave failing builds, temporary probes or debug prints for the next agent to discover.
- One agent per worktree at a time. For parallel work use `git worktree add` on separate branches; never run two agents against the same checkout.
- Read `plan.md` and `git log -5` before touching anything; do not redo steps already marked done, and do not silently change a decision recorded in the spec.
- If you disagree with the spec or the previous agent's work, write it down in `plan.md` under "Open" and stop; do not fork the architecture.
- Never bypass hooks (`--no-verify`, `LEFTHOOK=0`). Preserve unrelated worktree changes; never run destructive git (`reset --hard`, `push --force`, branch deletion) unless explicitly asked.

## Git

- Conventional Commits: `type(scope): subject`, whole header <= 50 chars. Never add AI co-author trailers; commitlint, the commit-msg hook and CI reject them.
- Routine PRs target `dev`. Only release branches target `main`.
- For UI changes include a concise BEFORE/AFTER description in the PR.
