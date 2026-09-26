#!/bin/sh
# Claude Code Stop hook: an extra gate on top of lefthook + CI.
# Blocks the stop (exit 2) when lint or typecheck fail, unless we are already
# continuing because of this hook (stop_hook_active), which would loop forever.
set -u
input=$(cat)
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi
cd "$(dirname "$0")/../.." || exit 0
[ -f package.json ] || exit 0
[ -d node_modules ] || exit 0        # dependencies not installed yet; nothing to run
if pnpm lint && pnpm typecheck; then
  exit 0
fi
echo 'stop-gate: pnpm lint / pnpm typecheck failed; fix before stopping' >&2
exit 2
