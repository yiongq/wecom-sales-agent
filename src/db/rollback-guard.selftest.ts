// 04 R14 / 12 R14：真实脚本经 bash -s 与 deploy.sh 两条入口；假 docker 主动吞 stdin，数据库谓词用 PGlite 验证。
// 12 的三项查询还经 PG_TEST_URL 指向的一次性集群验证；只建删本套件的独立数据库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodePg from 'pg';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { hostRuntime } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
const root = path.join(import.meta.dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-brand-'));
const bin = path.join(tmp, 'bin');
const repo = path.join(tmp, 'repo');
const srv = path.join(tmp, 'srv');
const log = path.join(tmp, 'calls');
const queryFile = path.join(tmp, 'brand-query');
const rolledBack = path.join(tmp, 'rolled-back');
const purged = path.join(tmp, 'purged');
const guardSource = fs.readFileSync(path.join(root, 'deploy/rollback-guard.sh'), 'utf8');
const recovery = '再重跑回滚检查，确认品牌风险已消除';
let checks = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  assert.ok(ok, `${name}: ${detail}`);
  checks++;
};
const fake = (name: string, source: string): void => {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${source}\n`, { mode: 0o755 });
};
// 只传必要的环境变量，避免开发机部署配置、PG_TEST_URL 等混入隔离夹具。
const baseEnv = {
  ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  PATH: `${bin}:${process.env.PATH}`,
  TMPDIR: tmp,
  FAKE_LOG: log,
  FAKE_QUERY: queryFile,
  FAKE_ROLLED_BACK: rolledBack,
  FAKE_PURGED: purged,
};
const run = (command: string, args: string[], env: Record<string, string> = {}, input?: string) => {
  fs.writeFileSync(log, '');
  fs.rmSync(rolledBack, { force: true });
  fs.rmSync(purged, { force: true });
  const started = performance.now();
  const r = spawnSync(command, args, { cwd: repo, env: { ...baseEnv, ...env }, input, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(r.error);
  return { code: r.status, out: r.stdout + r.stderr, log: fs.readFileSync(log, 'utf8'), elapsed: performance.now() - started };
};
const guard = (target: string, env: Record<string, string> = {}) =>
  run('bash', ['-s', '--', srv, target, 'side1', '3999'], env, guardSource);
const deploy = (tag: string, env: Record<string, string> = {}) =>
  run('bash', ['deploy.sh', tag], { SERVER: 'fake@srv', REMOTE_DIR: srv, NAME: 'side1', HOST_PORT: '3999', FAKE_REVISION: tag, ...env });

try {
  for (const dir of [bin, path.join(repo, 'deploy'), path.join(repo, 'src/db'), path.join(srv, 'var')])
    fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'deploy.sh'), path.join(repo, 'deploy.sh'));
  fs.writeFileSync(path.join(repo, 'deploy/rollback-guard.sh'), guardSource);
  for (const file of ['package.json', 'Dockerfile', 'deploy/compose.yml', 'src/db/migrate.ts'])
    fs.writeFileSync(path.join(repo, file), '{}');
  fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\n');
  fs.writeFileSync(
    path.join(srv, '.env.db'),
    'AGENT_DB=brand_fixture\nPOSTGRES_PASSWORD=x\nAGENT_OWNER_PASSWORD=x\nAGENT_APP_PASSWORD=x\nAGENT_PLATFORM_PASSWORD=x\n',
  );
  fs.writeFileSync(path.join(srv, '.env.migrate'), '');
  // 本机没有 coreutils timeout：监督真实假 docker 子进程，超时杀掉并回 124；测试缩短等待，生产参数照样核对。
  fs.writeFileSync(
    path.join(bin, 'timeout'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [kill, limit, command, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'timeout ' + process.argv.slice(2).join(' ') + '\\n');
if (kill !== '--kill-after=2s' || !['8s', '120s'].includes(limit)) process.exit(99);
const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
  timeout: Number(process.env.FAKE_TIMEOUT_MS || 8000), killSignal: 'SIGKILL' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.error?.code === 'ETIMEDOUT' ? 124 : (r.status ?? 1));
`,
    { mode: 0o755 },
  );
  fake(
    'docker',
    `
cat >/dev/null
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  *psql*)
    case "$*" in
      *"PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=2000"*"-v ON_ERROR_STOP=1"*) ;;
      *) exit 99 ;;
    esac
    case "\${FAKE_HANG:-}:$*" in
      pending-probe:*information_schema.columns*tenants*|published-probe:*information_schema.columns*sop_versions*|pending:*"select exists(select 1 from public.tenants t"*|published:*"from public.sop_versions"*|catalog-probe:*to_regclass*catalog_item_versions*|catalog:*"from catalog_item_versions"*|channel-probe:*to_regclass*channel_accounts*|channel:*"from channel_accounts where"*)
        exec perl -e 'sleep 60' ;;
    esac ;;
esac
case "$*" in
  *"inspect --format {{.Image}}"*) [ "\${FAKE_RUNNING:-4}" = missing ] && exit 1; echo sha256:running ;;
  *"container ls"*) [ "\${FAKE_CONTAINER_DOWN:-0}" = 0 ] || exit 1; [ "\${FAKE_SANDBOX_CONTAINER:-absent}" = absent ] || echo placeholder; exit 0 ;;
  *"sandbox.ts purge --all"*) [ "\${FAKE_PURGE_FAIL:-0}" = 0 ] || { echo "[sandbox] sandbox_tenant_lock_held" >&2; exit 3; }; echo "purge image=\${APP_IMAGE:-missing}" >> "$FAKE_LOG"; touch "$FAKE_PURGED" ;;
  *pg-backend.ts*|*registry.ts*|*pack-api.ts*|*runtime.ts*|*0015_order_refund_status.sql*|*order-view.ts*|*site-links.ts*|*attachments.ts*)
    phase="\${FAKE_TARGET:-3}"
    case "$*" in *sha256:running*) phase="\${FAKE_RUNNING:-4}" ;; esac
    case "$*" in *src/packs/industrial/runtime.ts*) phase="\${FAKE_INDUSTRIAL_TARGET:-$phase}" ;; esac
    case "$*" in *site-links.ts*) phase="\${FAKE_QUOTE_TARGET:-$phase}" ;; esac
    case "$*" in *attachments.ts*) phase="\${FAKE_ATTACHMENT_TARGET:-$phase}" ;; esac
    [ "$phase" = hang ] && exec perl -e 'sleep 60'
    [ "$phase" = error ] && exit 125
    case "$*" in *attachments.ts*) need=12 ;; *pg-backend.ts*) need=2 ;; *registry.ts*) need=3 ;; *pack-api.ts*) need=4 ;; *src/packs/industrial/runtime.ts*) need=10 ;; *runtime.ts*) need=5 ;; *order-view.ts*) need=8 ;; *site-links.ts*) need=9 ;; *) need=7 ;; esac
    [ "$phase" -ge "$need" ] ;;
  *to_regclass*public.attachments*|*to_regclass*public.usage_daily*|*to_regclass*public.conversations*|*"from public.attachments where"*|*"from public.usage_daily where"*|*"from public.conversations where"*)
    case "$*" in
      *public.attachments*) key=attachments; value="\${FAKE_ATTACHMENTS-f}" ;;
      *public.usage_daily*) key=usage; value="\${FAKE_VISION-f}" ;;
      *) key=conversations; value="\${FAKE_RFQ_INTAKE-f}" ;;
    esac
    case "$*" in *to_regclass*) key="$key-probe"; value="\${FAKE_ATTACHMENT_SCHEMA-t}" ;; esac
    printf '%s' "\${!#}" > "$FAKE_QUERY.attachment-$key"
    case "$value" in down) exit 1 ;; lock-timeout) echo f; exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "$value" ;; esac ;;
  *"select to_regclass('public.tenants') is not null"|*"select to_regclass('public.catalog_items') is not null")
    case "$*" in *public.tenants*) key=tenants ;; *) key=catalog ;; esac
    printf '%s' "\${!#}" > "$FAKE_QUERY.industrial-$key-probe"
    case "\${FAKE_INDUSTRIAL_SCHEMA-t}" in down) exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "\${FAKE_INDUSTRIAL_SCHEMA-t}" ;; esac ;;
  *"pack_id = 'industrial'"*|*"kind = 'part'"*|*"data->'lines'"*)
    case "$*" in
      *"pack_id = 'industrial'"*) key=tenants; value="\${FAKE_INDUSTRIAL_TENANTS-f}" ;;
      *"kind = 'part'"*) key=catalog; value="\${FAKE_INDUSTRIAL_CATALOG-f}" ;;
      *) key=orders; value="\${FAKE_INDUSTRIAL_ORDERS-f}" ;;
    esac
    printf '%s' "\${!#}" > "$FAKE_QUERY.industrial-$key"
    case "$value" in down) exit 1 ;; lock-timeout) echo f; exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "$value" ;; esac ;;
  *to_regclass*public.kb_chunks*)
    case "\${FAKE_KB_SCHEMA-t}" in down) exit 1 ;; *) echo "\${FAKE_KB_SCHEMA-t}" ;; esac ;;
  *"pack_id <> 'travel'"*|*"data->>'v' = '2'"*|*"kind not in ('route','hotel')"*|*"source <> 'route'"*)
    case "$*" in
      *"pack_id <> 'travel'"*) key=tenants; value="\${FAKE_NONTRAVEL_TENANTS-f}" ;;
      *"data->>'v' = '2'"*) key=orders; value="\${FAKE_NONTRAVEL_ORDERS-f}" ;;
      *"kind not in ('route','hotel')"*) key=catalog; value="\${FAKE_NONTRAVEL_CATALOG-f}" ;;
      *) key=kb; value="\${FAKE_NONTRAVEL_KB-f}" ;;
    esac
    case "$*" in
      *"select count(*)"*)
        printf '%s' "\${!#}" > "$FAKE_QUERY.nontravel-$key-count"
        [ "\${FAKE_NONTRAVEL_COUNT-1}" != down ] || exit 1
        echo "\${FAKE_NONTRAVEL_COUNT-1}" ;;
      *)
        printf '%s' "\${!#}" > "$FAKE_QUERY.nontravel-$key"
        case "$value" in down) exit 1 ;; lock-timeout) echo f; exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "$value" ;; esac ;;
    esac ;;
  *information_schema.columns*"column_name = 'kind'"*)
    case "\${FAKE_TENANCY_SCHEMA:-f}" in down) exit 1 ;; *) echo "\${FAKE_TENANCY_SCHEMA:-f}" ;; esac ;;
  *"kind = 'standard'"*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.tenancy"
    [ "\${FAKE_TENANCY_DOWN:-0}" = 0 ] || exit 1
    rows="\${FAKE_SANDBOX_ROWS:-f}"
    [ ! -f "$FAKE_PURGED" ] || rows="\${FAKE_AFTER_PURGE:-f}"
    echo "\${FAKE_OTHER_HOST:-f}|$rows" ;;
  *information_schema.columns*tenants*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.pending-probe"
    case "\${FAKE_PROBE-t}" in down) exit 1 ;; *) echo "\${FAKE_PENDING_SCHEMA-\${FAKE_PROBE-t}}" ;; esac ;;
  *information_schema.columns*sop_versions*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.published-probe"
    echo "\${FAKE_PUBLISHED_SCHEMA-\${FAKE_PROBE-t}}" ;;
  *"from public.tenants t"*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.pending"
    case "\${FAKE_BRAND-f}" in down) exit 1 ;; lock-timeout) echo f; exit 1 ;; *) echo "\${FAKE_PENDING_BRAND-\${FAKE_BRAND-f}}" ;; esac ;;
  *"from public.sop_versions where"*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.published"
    echo "\${FAKE_PUBLISHED_BRAND-\${FAKE_BRAND-f}}" ;;
  *"data->'approval' IS NOT NULL"*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.quote"
    case "\${FAKE_QUOTE:-f}" in down) exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "\${FAKE_QUOTE:-f}" ;; esac ;;
  *to_regclass*public.orders*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.industrial-orders-probe"
    case "\${FAKE_REFUND_SCHEMA-f}" in down) exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "\${FAKE_REFUND_SCHEMA-f}" ;; esac ;;
  *"from public.orders where status in"*)
    printf '%s' "\${!#}" > "$FAKE_QUERY.refund"
    case "\${FAKE_REFUND:-f}" in down) exit 1 ;; hang) exec perl -e 'sleep 60' ;; *) echo "\${FAKE_REFUND:-f}" ;; esac ;;
  *to_regclass*channel_accounts*) echo t ;;
  *"from channel_accounts where"*) echo "\${FAKE_CHANNEL:-f}" ;;
  *to_regclass*catalog_item_versions*) echo t ;;
  *"from catalog_item_versions where"*) echo "\${FAKE_CATALOG:-f}" ;;
  *"image inspect"*) exit 0 ;;
  *) exit 98 ;;
esac`,
  );
  fake(
    'curl',
    `
cat >/dev/null
echo "curl $*" >> "$FAKE_LOG"
[ "\${FAKE_HEALTH_FAIL:-}" = 1 ] && [ ! -f "$FAKE_ROLLED_BACK" ] && exit 7
printf '{"revision":"%s","role":"host","sandboxes":0,"config":{"catalogVersioned":%s}}' "\${FAKE_REVISION:-fixture}" "\${FAKE_CATALOG_VERSIONED:-false}"`,
  );
  fake(
    'git',
    `
echo "git $*" >> "$FAKE_LOG"
case "$1" in
  show-ref) exit 0 ;;
  cat-file)
    case "$3" in
      *pg-backend.ts) case "$3" in *v01:*) exit 1 ;; esac ;;
      *registry.ts) case "$3" in *v01:*|*v02:*) exit 1 ;; esac ;;
      *pack-api.ts) case "$3" in *v04:*|*v06:*|*v07:*|*v08:*|*v09:*|*v10:*|*v11:*|*v12:*) exit 0 ;; *) exit 1 ;; esac ;;
      *runtime.ts) case "$3" in *v06:*|*v07:*|*v08:*|*v09:*|*v10:*|*v11:*|*v12:*) exit 0 ;; *) exit 1 ;; esac ;;
      *0015_order_refund_status.sql) case "$3" in *v07:*|*v08:*|*v09:*|*v10:*|*v11:*|*v12:*) exit 0 ;; *) exit 1 ;; esac ;;
      *order-view.ts) case "$3" in *v08:*|*v09:*|*v10:*|*v11:*|*v12:*) exit 0 ;; *) exit 1 ;; esac ;;
    esac ;;
  ls-tree)
    case "$*" in
      *src/core/attachments.ts*)
        [ "\${FAKE_ATTACHMENT_TREE_DOWN:-0}" = 0 ] || exit 1
        case "$*" in *v12*) echo src/core/attachments.ts ;; esac ;;
      *src/packs/industrial/runtime.ts*)
        [ "\${FAKE_TREE_DOWN:-0}" = 0 ] || exit 1
        case "$*" in *v10*|*v11*|*v12*) echo src/packs/industrial/runtime.ts ;; esac ;;
      *) case "$*" in *v09*|*v10*|*v11*|*v12*) echo src/core/site-links.ts ;; esac ;;
    esac ;;
  archive) tar -cf - package.json Dockerfile deploy src ;;
  *) exit 98 ;;
esac`,
  );
  fake('pnpm', 'exit 0');
  fake('rsync', 'echo "rsync $*" >> "$FAKE_LOG"');
  fake('sleep', 'exit 0');
  fake(
    'ssh',
    `
echo "ssh $*" >> "$FAKE_LOG"
shift
if [ "$1" = bash ]; then exec "$@"; fi
case "$*" in
  *"if [ -f"*".env.sandbox"*"echo 1"*) [ -f "$REMOTE_DIR/.env.sandbox" ] && echo 1 || echo 0 ;;
  *runtime.ts*) exec docker run --rm --entrypoint /bin/sh side1:prev -c "test -e /app/src/tenancy/runtime.ts" ;;
  *curl*) exec curl ;;
  *"image inspect"*) case "$*" in *".Config.Env"*) echo "APP_REVISION=\${FAKE_REVISION:-fixture}" ;; *) exec docker image inspect side1:prev ;; esac ;;
  *"up -d --no-deps app"*) touch "$FAKE_ROLLED_BACK" ;;
esac
exit 0`,
  );

  const dc = 'APP_CONTAINER=side1 HOST_PORT=3999 docker compose -p side1 -f deploy/compose.yml';
  const clear = `${dc} run --rm platform node --import tsx src/cli/tenant-brand.ts clear --tenant <slug>`;
  const restore = `APP_IMAGE=side1:prev ${dc} up -d --no-deps app && docker tag side1:prev side1:current`;
  for (const [name, pending, published] of [
    ['只有待生效品牌', 't', 'f'],
    ['只有发布快照（clear 未重启）', 'f', 't'],
    ['待生效与发布快照都有', 't', 't'],
  ] as const) {
    for (const auto of [false, true]) {
      const label = `${name} × ${auto ? '自动回滚' : '部署旧 tag'}`;
      const env = { FAKE_PENDING_BRAND: pending, FAKE_PUBLISHED_BRAND: published, ...(auto ? { FAKE_HEALTH_FAIL: '1' } : {}) };
      const g = guard(auto ? 'side1:prev' : 'pre-04', env);
      check(`${label}：仍拒绝 6`, g.code === 6, g.out);
      check(
        `${label}：只对非空待生效值建议 clear`,
        g.out.includes(clear) === (pending === 't') &&
          g.out.includes('先 tenant-brand clear') === (pending === 't') &&
          (pending === 't' || g.out.includes('待生效品牌已经为空，无需再次 tenant-brand clear')),
        g.out,
      );
      check(
        `${label}：只有发布快照需要 04 重渲染和 hash 核对`,
        g.out.includes('按原因 brand 重渲染') === (published === 't') &&
          g.out.includes('promptHash') === (published === 't') &&
          g.out.includes(`${dc} restart app`) === (!auto && published === 't') &&
          (published === 't' || g.out.includes('clear 后无需重启或重渲染')),
        g.out,
      );
      check(
        `${label}：恢复命令带项目、端口与目标镜像`,
        auto
          ? g.out.includes(restore) && !g.out.includes('restart app') && g.out.indexOf(recovery) < g.out.indexOf(restore)
          : !g.out.includes('APP_IMAGE=') && g.out.includes('再部署旧 tag'),
        g.out,
      );
      const useRecovery = `APP_IMAGE=\${RECOVERY_IMAGE} ${dc} up -d --no-deps app`;
      check(
        `${label}：自动回滚有快照先起已知可用 04，再 clear、重启、核对后起 prev`,
        auto && published === 't'
          ? g.out.includes("RECOVERY_IMAGE='side1:<已知可用的04之后tag>'") &&
              g.out.includes(`${useRecovery} && docker tag "\${RECOVERY_IMAGE}" side1:current`) &&
              g.out.includes(`${dc} stop app\n  ${useRecovery}`) &&
              (pending === 'f' || g.out.indexOf(useRecovery) < g.out.indexOf(clear)) &&
              g.out.indexOf('按原因 brand 重渲染') < g.out.indexOf('promptHash') &&
              g.out.indexOf('promptHash') < g.out.indexOf(restore)
          : !g.out.includes('RECOVERY_IMAGE'),
        g.out,
      );
      const d = deploy(auto ? 'v04' : 'v03', env);
      check(
        `${label}：deploy.sh 把 6 转成 1、原样透出，收尾不误导`,
        d.code === 1 &&
          d.out.includes(g.out.trim()) &&
          d.out.includes('按上面对应品牌状态的步骤恢复') &&
          (auto ? !d.log.includes('up -d --no-deps app') && !d.out.includes('restart app') : !d.log.includes('rsync ')) &&
          (pending === 't' || (!d.out.includes('先 tenant-brand clear') && !d.out.includes(clear))),
        d.out,
      );
    }
  }

  // 假 docker 输出只控制查询结果；下方执行同一条捕获的 SQL 证明两种品牌输入均被检查。
  let r = guard('pre-04', { FAKE_BRAND: 't' });
  check(
    '品牌非空经 stdin 拒绝 6、完整恢复顺序与旁路命令',
    r.code === 6 &&
      r.out.includes(recovery) &&
      r.out.includes('HOST_PORT=3999') &&
      r.out.includes('tenant-brand.ts clear --tenant <slug>') &&
      r.out.includes('restart app') &&
      !r.out.includes('export-sessions'),
    r.out,
  );
  check(
    '品牌查询跨租户使用 postgres 与指定数据库、stdin 未被吞',
    r.log.includes('db psql -U postgres -d brand_fixture') && r.out.includes('clear 只改待生效值'),
    r.log,
  );
  for (const target of ['pre-02', 'pre-03', 'pre-04', 'side1:prev']) {
    r = guard(target, { FAKE_BRAND: 't' });
    check(`${target} 仍检查品牌`, r.code === 6 && r.out.includes(recovery), r.out);
  }
  r = guard('pre-04');
  check('品牌为空放行，当前 04 发布的 brand:null 由 SQL 判断', r.code === 0, r.out);
  check(
    '每次品牌探测/查询都有进程超时、SQL/锁超时与失败退出保护',
    r.log
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('docker ') &&
          line.includes('psql') &&
          (line.includes("column_name = 'brand'") || line.includes("column_name = 'render_inputs'") || line.includes('coalesce(')),
      ).length === 4 &&
      r.log
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('timeout --kill-after=2s 8s docker ') &&
            line.includes('psql') &&
            (line.includes("column_name = 'brand'") || line.includes("column_name = 'render_inputs'") || line.includes('coalesce(')),
        ).length === 4 &&
      r.log.includes('PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=2000') &&
      r.log.includes('-v ON_ERROR_STOP=1'),
    r.log,
  );
  const sqlTimeouts = r.log.match(/PGOPTIONS=-c statement_timeout=(\d+) -c lock_timeout=(\d+)/)!;
  r = guard('pre-04', { FAKE_BRAND: 'lock-timeout' });
  check('SQL 锁超时即使输出 f 也从严拒绝，不当作无风险', r.code === 6 && r.out.includes('问不到库') && r.elapsed < 3000, r.out);
  r = guard('pre-04', { FAKE_PROBE: 'down' });
  check('元数据探测连接失败仍从严拒绝', r.code === 6 && r.out.includes('问不到库'), r.out);
  for (const point of ['published-probe', 'published']) {
    for (const running of ['4', '1']) {
      r = guard('side1:prev', { FAKE_PENDING_BRAND: 't', FAKE_RUNNING: running, FAKE_HANG: point, FAKE_TIMEOUT_MS: '180' });
      check(
        `已知待生效品牌有风险，${point} 超时/运行 ${running} 不能放行或误提示只需 clear`,
        r.code === 6 &&
          r.out.includes('tenants.brand 不为空') &&
          r.out.includes('问不到库') &&
          r.elapsed < 3000 &&
          r.out.includes('RECOVERY_IMAGE=') &&
          r.out.includes(restore) &&
          !r.out.includes('restart app') &&
          !r.out.includes('无需重启或重渲染'),
        r.out,
      );
    }
  }
  for (const [phase, target, points] of [
    ['02', 'pre-02', ['catalog-probe', 'catalog']],
    ['03', 'pre-03', ['channel-probe', 'channel']],
    ['04', 'pre-04', ['pending-probe', 'pending', 'published-probe', 'published']],
  ] as const) {
    for (const point of points) {
      for (const running of ['4', '1']) {
        r = guard(target, { FAKE_HANG: point, FAKE_TIMEOUT_MS: '180', FAKE_HEALTH_FAIL: '1', FAKE_RUNNING: running });
        const expected = running === '1' ? 0 : phase === '02' ? 4 : phase === '03' ? 5 : 6;
        check(
          `${phase} ${point} 进程超时：运行 ${running} 返回 ${expected}，3 秒内结束`,
          r.code === expected && r.elapsed < 3000 && (expected === 0 || r.out.includes('问不到库')),
          `${r.elapsed.toFixed(0)}ms ${r.out}`,
        );
      }
    }
  }
  r = guard('side1:prev', { FAKE_TARGET: '4', FAKE_BRAND: 'down' });
  check(
    '04 到 04 无需品牌降级检查',
    r.code === 0 && !r.log.includes("column_name = 'brand'") && !r.log.includes("column_name = 'render_inputs'"),
    r.log,
  );
  for (const running of ['4', 'error', 'missing']) {
    for (const brand of ['down', 'malformed', '']) {
      r = guard('pre-04', { FAKE_RUNNING: running, FAKE_BRAND: brand, FAKE_HEALTH_FAIL: '1' });
      check(`查库 ${brand || '空结果'}、运行镜像 ${running} 从严拒绝`, r.code === 6 && r.out.includes(recovery), r.out);
    }
  }
  for (const running of ['1', '2', '3']) {
    r = guard('pre-04', { FAKE_RUNNING: running, FAKE_BRAND: 'down', FAKE_HEALTH_FAIL: '1' });
    check(`查库失败、明确运行旧镜像 ${running} 放行`, r.code === 0, r.out);
  }
  r = guard('side1:prev', { FAKE_TARGET: 'error', FAKE_BRAND: 't' });
  check('目标镜像判断失败按旧镜像拒绝', r.code === 6, r.out);
  r = guard('pre-02', { FAKE_BRAND: 't', FAKE_CATALOG: 't', FAKE_CHANNEL: 't', FAKE_HEALTH_FAIL: '1' });
  check('共享条目版本风险仍返回 4、品牌步骤也透出', r.code === 4 && r.out.includes('只能回到 02 之后') && r.out.includes(recovery), r.out);
  r = guard('pre-02', { FAKE_BRAND: 't', FAKE_CHANNEL: 't' });
  check(
    '共享渠道风险仍返回 5，不因品牌风险伪造会话导出',
    r.code === 5 && r.out.includes('channel-export') && r.out.includes(recovery) && !r.out.includes('export-sessions'),
    r.out,
  );
  fs.writeFileSync(path.join(srv, 'var/sessions-in-db.json'), '{}');
  r = guard('pre-02', { FAKE_BRAND: 't' });
  check('共享会话风险保留回到文件存储步骤', r.code === 6 && r.out.includes('export-sessions') && r.out.includes(recovery), r.out);
  r = guard('pre-02');
  check('品牌安全后旧会话风险仍返回 3', r.code === 3 && r.out.includes('export-sessions'), r.out);
  fs.rmSync(path.join(srv, 'var/sessions-in-db.json'));
  fs.writeFileSync(path.join(srv, 'var/channels-in-db.json'), '{}');
  r = guard('pre-02', { FAKE_BRAND: 't' });
  check('共享渠道标记风险仍返回 5、品牌步骤保留', r.code === 5 && r.out.includes('channel-export') && r.out.includes(recovery), r.out);
  fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\nSESSION_STORE=db\n');
  r = guard('pre-02', { FAKE_BRAND: 't' });
  check(
    '共享渠道、会话与品牌风险同时保留两个导出步骤',
    r.code === 5 && r.out.includes('channel-export') && r.out.includes('export-sessions') && r.out.includes(recovery),
    r.out,
  );
  fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\n');
  fs.rmSync(path.join(srv, 'var/channels-in-db.json'));

  for (const tag of ['v01', 'v02', 'v03']) {
    r = deploy(tag, { FAKE_BRAND: 't' });
    check(
      `${tag} 按目标树拒绝，6 转 1，原样透出恢复步骤，不 rsync`,
      r.code === 1 && r.out.includes(recovery) && !r.log.includes('rsync '),
      r.out,
    );
    check(
      `${tag} 保留最早阶段的检查入口`,
      r.log.includes(` ${tag === 'v01' ? 'pre-02' : tag === 'v02' ? 'pre-03' : 'pre-04'} side1 3999`),
      r.log,
    );
  }
  r = deploy('v03', { FAKE_BRAND: 'down', FAKE_RUNNING: '4' });
  check('部署旧 tag 查库失败按运行 04 镜像拒绝', r.code === 1 && r.out.includes(recovery) && !r.log.includes('rsync '), r.out);
  r = deploy('v04', { FAKE_BRAND: 't', FAKE_HEALTH_FAIL: '1' });
  check(
    '健康失败后实际自动回滚经相同检查拒绝 1、不启动 prev',
    r.code === 1 &&
      r.out.includes(recovery) &&
      r.out.includes('没有自动回滚') &&
      r.log.includes('side1:prev side1 3999') &&
      !r.log.includes('up -d --no-deps app'),
    r.out,
  );
  r = deploy('v04', { FAKE_BRAND: 'down', FAKE_RUNNING: '4', FAKE_HEALTH_FAIL: '1' });
  check('健康失败且库不可达也不启动 prev', r.code === 1 && r.out.includes(recovery) && !r.log.includes('up -d --no-deps app'), r.out);
  r = deploy('v04', { FAKE_HANG: 'published', FAKE_TIMEOUT_MS: '180', FAKE_HEALTH_FAIL: '1' });
  check(
    '健康失败后品牌锁等待被限时终止，拒绝自动回滚并透出恢复步骤',
    r.code === 1 && r.elapsed < 3000 && r.out.includes(recovery) && !r.log.includes('up -d --no-deps app'),
    `${r.elapsed.toFixed(0)}ms ${r.out}`,
  );
  r = deploy('v04', { FAKE_BRAND: 't', FAKE_TARGET: '4', FAKE_HEALTH_FAIL: '1' });
  check(
    '04 自动回滚到 04 不受品牌阻拦并恢复服务',
    r.code === 1 && r.log.includes('up -d --no-deps app') && r.out.includes('服务恢复') && !r.out.includes('拒绝回滚'),
    r.out,
  );
  r = deploy('v04', { FAKE_HEALTH_FAIL: '1' });
  check(
    '品牌为空自动回滚到 03、恢复后部署仍退出 1',
    r.code === 1 && r.log.includes('side1:prev side1 3999') && r.log.includes('up -d --no-deps app') && r.out.includes('服务恢复'),
    r.out,
  );
  for (const [oldRisk, extra] of [
    ['条目版本', { FAKE_CATALOG: 't' }],
    ['渠道状态', { FAKE_CHANNEL: 't' }],
  ] as const) {
    const shared = deploy('v04', { FAKE_TARGET: '1', FAKE_BRAND: 't', FAKE_HEALTH_FAIL: '1', ...extra });
    check(
      `自动回滚共享${oldRisk}优先拒绝并透出品牌步骤`,
      shared.code === 1 && shared.out.includes(oldRisk) && shared.out.includes(recovery) && !shared.log.includes('up -d --no-deps app'),
      shared.out,
    );
  }

  // 使用检查脚本真正发出的 SQL，验证旧库、跨租户、历史快照、clear 与重启状态。
  const queries = Object.fromEntries(
    ['pending-probe', 'published-probe', 'pending', 'published'].map((key) => [key, fs.readFileSync(`${queryFile}.${key}`, 'utf8')]),
  );
  // 05 验收 13：真实脚本由 bash -s 执行，所有 docker/psql 都是吞 stdin 的替身。
  fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\nDEFAULT_TENANT_SLUG=demo\n');
  {
    guard('pre-07', { FAKE_REFUND_SCHEMA: 't', FAKE_REFUND: 'f' });
    const refundSql = fs.readFileSync(`${queryFile}.refund`, 'utf8');
    const pg = new PGlite();
    try {
      await pg.exec('create table orders(status text)');
      for (const status of ['pending_payment', 'paid', 'cancelled', 'superseded', 'refund_pending', 'refunded']) {
        await pg.query('insert into orders values ($1)', [status]);
        const result = await pg.query<{ exists: boolean }>(refundSql);
        check(`07：跨租户查询谓词识别 ${status}`, result.rows[0]?.exists === ['refund_pending', 'refunded'].includes(status));
        await pg.exec('delete from orders');
      }
    } finally {
      await pg.close();
    }
  }
  // 07 R20：显式旧 tag 与自动回滚共用数据库检查，退款风险不触发 purge。
  for (const status of ['refund_pending', 'refunded']) {
    const env = { FAKE_TARGET: '6', FAKE_RUNNING: '7', FAKE_REFUND_SCHEMA: 't', FAKE_REFUND: 't' };
    for (const target of ['pre-07', 'side1:prev']) {
      r = guard(target, env);
      check(
        `${status} ${target}：退出 8、给出实测风险说明、不 purge`,
        r.code === 8 &&
          r.out.includes(
            '先在后台把退款中的订单办完或驳回；旧镜像会把退款中、已退款的单当成待付款显示在支付页上，成交统计也会漏算，确认能接受再回滚',
          ) &&
          !fs.existsSync(purged),
        r.out,
      );
    }
    r = deploy('v06', env);
    check(
      `${status}：按 tag 树判 pre-07，8 转 1、rsync 前拒绝`,
      r.code === 1 && r.log.includes('pre-07 side1 3999') && !r.log.includes('rsync '),
      r.out,
    );
    r = deploy('v07', { ...env, FAKE_HEALTH_FAIL: '1' });
    check(
      `${status}：自动回滚 8 转 1、提示服务不可用、不启动 prev`,
      r.code === 1 && r.out.includes('没有自动回滚，服务当前不可用！') && !fs.existsSync(rolledBack),
      r.out,
    );
  }
  for (const env of [
    { FAKE_REFUND_SCHEMA: 'down', FAKE_REFUND: 'f' },
    { FAKE_REFUND_SCHEMA: 't', FAKE_REFUND: 'down' },
  ]) {
    for (const running of ['7', 'missing', 'error']) {
      r = guard('pre-07', { ...env, FAKE_RUNNING: running });
      check('07：库问不到且运行镜像不能明确证明是旧版，从严退出 8', r.code === 8, r.out);
    }
    r = guard('pre-07', { ...env, FAKE_RUNNING: '6' });
    check(
      '07：旧运行镜像仍豁免退款检查，订单表未知另由10从严拒绝',
      env.FAKE_REFUND_SCHEMA === 'down' ? r.code === 9 && r.out.includes('另一个含 10 的 tag') : r.code === 0,
      r.out,
    );
  }
  r = guard('pre-07', { FAKE_REFUND_SCHEMA: 't', FAKE_REFUND: 'f' });
  check('07：没有退款订单放行', r.code === 0, r.out);
  r = guard('side1:prev', { FAKE_TARGET: '7', FAKE_REFUND_SCHEMA: 'down' });
  check(
    '07：目标已有迁移标记不查询退款数据，订单表未知另由10拒绝',
    r.code === 9 && r.out.includes('另一个含 10 的 tag') && !r.log.includes("status in ('refund_pending', 'refunded')"),
    r.out,
  );
  r = guard('pre-07', { FAKE_REFUND_SCHEMA: 't', FAKE_REFUND: 'hang', FAKE_RUNNING: '7', FAKE_TIMEOUT_MS: '100' });
  check('07：退款查询挂住有时限，退出 8', r.code === 8 && r.elapsed < 4000, r.out);

  // 08 R13：真实脚本的四项风险独立触发；旧版本拒绝码与副作用顺序不变。
  const nontravelRisks = [
    ['tenants', 'FAKE_NONTRAVEL_TENANTS', '非旅游租户'],
    ['orders', 'FAKE_NONTRAVEL_ORDERS', '通用单'],
    ['catalog', 'FAKE_NONTRAVEL_CATALOG', '非旅游条目'],
    ['kb', 'FAKE_NONTRAVEL_KB', '非旅游知识块'],
  ] as const;
  for (const [, variable, label] of nontravelRisks) {
    const env = { FAKE_TARGET: '7', FAKE_RUNNING: '8', [variable]: 't' };
    r = guard('side1:prev', env);
    check(
      `08：只有${label}时退出 9，逐项打印计数与处理步骤，不 purge`,
      r.code === 9 &&
        r.out.includes(`${label}（`) &&
        r.out.includes('：1') &&
        r.out.includes('先停用并清理非旅游租户') &&
        r.out.includes('四项都为零后再回滚') &&
        r.out.split('：0').length === 4 &&
        !fs.existsSync(purged),
      r.out,
    );
    check(
      `08：${label}镜像目标在四项清零、重跑检查通过后给出恢复命令`,
      r.out.includes(restore) &&
        r.out.indexOf('四项都为零、重跑回滚检查退出码 0 后') < r.out.indexOf(restore) &&
        r.out.includes('curl -fsS http://127.0.0.1:3999/healthz') &&
        r.out.includes('确认 revision 是 side1:prev 的 APP_REVISION'),
      r.out,
    );
    const pre08 = guard('pre-08', env);
    check(
      `08：pre-08 目标只有${label}时退出 9，清理并检查通过后重新部署，无镜像恢复命令`,
      pre08.code === 9 &&
        pre08.out.includes('四项都为零、重跑回滚检查通过后，再部署旧 tag') &&
        !pre08.out.includes('APP_IMAGE=') &&
        !pre08.out.includes('docker tag'),
      pre08.out,
    );
    const d = deploy('v03', env);
    check(
      `08：${label}部署旧 tag，9 转 1、原样透出、rsync 前拒绝`,
      d.code === 1 &&
        d.out.includes(pre08.out.trim()) &&
        d.out.includes('旧版本，非旅游数据、报价单、工业数据或附件回滚检查拒绝部署（服务器上什么都没动）') &&
        !d.log.includes('rsync '),
      d.out,
    );
    const oldTag = deploy('v07', env);
    check(
      `08：07 tag 按文件树判 pre-08，${label}导致 9 转 1、同步前拒绝`,
      oldTag.code === 1 &&
        oldTag.out.includes(pre08.out.trim()) &&
        oldTag.log.includes('pre-08 side1 3999') &&
        !oldTag.log.includes('rsync '),
      oldTag.out,
    );
    const auto = deploy('v08', { ...env, FAKE_HEALTH_FAIL: '1' });
    check(
      `08：${label}自动回滚，9 转 1、原样透出、不启动 prev`,
      auto.code === 1 &&
        auto.out.includes(r.out.trim()) &&
        auto.out.includes('非旅游数据、报价单、工业数据或附件回滚检查拒绝，没有自动回滚，服务当前不可用！按上面的步骤人工处理') &&
        !fs.existsSync(rolledBack),
      auto.out,
    );
  }
  for (const target of ['pre-02', 'pre-03', 'pre-04', 'pre-05', 'pre-07', 'pre-08', 'side1:prev']) {
    r = guard(target, { FAKE_TARGET: '7', FAKE_RUNNING: '8', FAKE_NONTRAVEL_ORDERS: 't' });
    check(
      `08：${target} 同样检查通用单、退出 9，仅镜像目标打印恢复命令`,
      r.code === 9 &&
        r.out.includes('通用单') &&
        r.out.includes(restore) === (target === 'side1:prev') &&
        r.out.includes('APP_IMAGE=') === (target === 'side1:prev') &&
        r.out.includes('再部署旧 tag') === (target !== 'side1:prev'),
      r.out,
    );
  }
  const emptyServer = {
    FAKE_RUNNING: 'missing',
    FAKE_NONTRAVEL_TENANTS: 'down',
    FAKE_NONTRAVEL_ORDERS: 'down',
    FAKE_NONTRAVEL_CATALOG: 'down',
    FAKE_KB_SCHEMA: 'down',
  };
  r = guard('pre-08', emptyServer);
  check(
    '08：新服务器四项无法确认，退出 9 并提示先部署新版或确认无数据',
    r.code === 9 &&
      nontravelRisks.every(([, , label]) => new RegExp(`${label}（[^\\n]*：无法确认`).test(r.out)) &&
      r.out.includes('若这是库还没建、四项都无法确认的新服务器，先部署 08 之后的 tag，或确认库里确实没有这四类数据后再处理。') &&
      !r.out.includes('APP_IMAGE='),
    r.out,
  );
  const emptyDeploy = deploy('v07', emptyServer);
  check(
    '08：新服务器部署旧 tag 透出空库提示，9 转 1、同步前拒绝',
    emptyDeploy.code === 1 && emptyDeploy.out.includes(r.out.trim()) && !emptyDeploy.log.includes('rsync '),
    emptyDeploy.out,
  );
  const oldRisks = {
    FAKE_TARGET: 'error',
    FAKE_RUNNING: '8',
    FAKE_CATALOG_VERSIONED: 'true',
    FAKE_CHANNEL: 't',
    FAKE_BRAND: 't',
    FAKE_TENANCY_SCHEMA: 't',
    FAKE_OTHER_HOST: 't',
    FAKE_SANDBOX_ROWS: 't',
    FAKE_SANDBOX_CONTAINER: 'stopped',
    FAKE_REFUND_SCHEMA: 't',
    FAKE_REFUND: 't',
  };
  for (const file of ['var/sessions-in-db.json', 'var/channels-in-db.json', '.env.sandbox']) fs.writeFileSync(path.join(srv, file), '{}');
  try {
    r = guard('pre-08', oldRisks);
    check('08：pre-08 四项为零，02–07 的风险与标记均不误拦', r.code === 0, r.out);
    check(
      '08：pre-08 不按镜像名探测旧目标、不查询渠道/品牌/沙箱/退款，不 purge',
      !r.log.includes('docker run ') &&
        !r.log.includes('channel_accounts') &&
        !r.log.includes('information_schema.columns') &&
        !r.log.includes("status in ('refund_pending', 'refunded')") &&
        !r.log.includes('sandbox.ts purge --all'),
      r.log,
    );
  } finally {
    for (const file of ['var/sessions-in-db.json', 'var/channels-in-db.json', '.env.sandbox'])
      fs.rmSync(path.join(srv, file), { force: true });
  }
  r = deploy('v07', { ...oldRisks, FAKE_SANDBOX_CONTAINER: 'absent' });
  check(
    '08：07 tag 四项为零放行并完成部署，02–07 风险不误拦',
    r.code === 0 && r.log.includes('pre-08 side1 3999') && r.log.includes('rsync '),
    r.out,
  );
  r = guard('side1:prev', { FAKE_TARGET: '7', FAKE_RUNNING: '8' });
  check('08：四项为零放行', r.code === 0, r.out);
  check(
    '08：目标镜像探测带时限，四项查询跨租户、只读并带 SQL 超时',
    r.log.includes('timeout --kill-after=2s 8s docker run --rm --entrypoint /bin/sh side1:prev -c test -e /app/src/core/order-view.ts') &&
      r.log
        .split('\n')
        .filter((line) => line.startsWith('docker ') && line.includes('psql'))
        .every(
          (line) =>
            line.includes('PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=2000') &&
            line.includes('db psql -U postgres -d brand_fixture -v ON_ERROR_STOP=1 -Atc select '),
        ),
    r.log,
  );
  r = guard('side1:prev', { FAKE_TARGET: '8', FAKE_NONTRAVEL_TENANTS: 't', FAKE_KB_SCHEMA: 'down' });
  check(
    '08：目标已有 order-view.ts 不执行四项查询',
    r.code === 0 && !r.log.includes("data->>'v' = '2'") && !r.log.includes("pack_id <> 'travel'"),
    r.log + r.out,
  );
  r = guard('side1:prev', { FAKE_TARGET: '7', FAKE_RUNNING: '8', FAKE_KB_SCHEMA: 'f' });
  check('08：kb_chunks 不存在按零处理，不查询缺失表', r.code === 0 && !r.log.includes('from public.kb_chunks'), r.log + r.out);
  for (const [, variable, label] of nontravelRisks) {
    for (const value of ['down', 'malformed', '', 'lock-timeout']) {
      for (const running of ['8', '7']) {
        r = guard('pre-07', { FAKE_RUNNING: running, [variable]: value });
        check(
          `08：${label}查询 ${value || '空结果'}、运行 ${running}，${running === '7' ? '豁免' : '拒绝 9'}`,
          r.code === (running === '7' ? 0 : 9) && (running === '7' || r.out.includes('无法确认')),
          r.out,
        );
      }
    }
  }
  for (const running of ['missing', 'error']) {
    r = guard('pre-07', { FAKE_RUNNING: running, FAKE_NONTRAVEL_TENANTS: 'down' });
    check(`08：运行镜像 ${running} 无法证明旧版，从严拒绝 9`, r.code === 9, r.out);
  }
  for (const schema of ['down', 'malformed', '']) {
    r = guard('pre-07', { FAKE_RUNNING: '8', FAKE_KB_SCHEMA: schema });
    check(`08：知识块表探测 ${schema || '空结果'} 从严拒绝 9`, r.code === 9 && r.out.includes('无法确认'), r.out);
  }
  r = guard('pre-07', { FAKE_RUNNING: '7', FAKE_NONTRAVEL_TENANTS: 't', FAKE_NONTRAVEL_KB: 'down' });
  check('08：旧运行镜像仅豁免未知项，不能豁免已确认的非旅游租户', r.code === 9 && r.out.includes('已确认存在'), r.out);
  r = guard('pre-07', { FAKE_RUNNING: '8', FAKE_NONTRAVEL_ORDERS: 't', FAKE_NONTRAVEL_COUNT: 'down' });
  check(
    '08：计数失败仍拒绝已确认的通用单，并打印无法确认',
    r.code === 9 && r.out.includes('无法确认') && r.out.includes('已确认存在'),
    r.out,
  );
  r = guard('pre-07', { FAKE_RUNNING: '8', FAKE_NONTRAVEL_TENANTS: 'hang', FAKE_TIMEOUT_MS: '100' });
  check('08：查询挂住有时限，从严退出 9', r.code === 9 && r.elapsed < 4000, r.out);
  r = guard('side1:prev', { FAKE_TARGET: 'error', FAKE_RUNNING: '8', FAKE_NONTRAVEL_ORDERS: 't' });
  check('08：目标镜像探测失败按旧版拒绝', r.code === 9, r.out);
  for (const [expected, target, extra] of [
    [4, 'pre-02', { FAKE_CATALOG: 't', FAKE_HEALTH_FAIL: '1' }],
    [5, 'pre-03', { FAKE_CHANNEL: 't' }],
    [6, 'pre-04', { FAKE_BRAND: 't' }],
    [8, 'pre-07', { FAKE_REFUND_SCHEMA: 't', FAKE_REFUND: 't' }],
  ] as const) {
    r = guard(target, { ...extra, FAKE_NONTRAVEL_TENANTS: 't' });
    check(`08：旧风险优先，仍退出 ${expected}`, r.code === expected && !fs.existsSync(purged), r.out);
  }
  r = guard('pre-05', { FAKE_NONTRAVEL_TENANTS: 't', FAKE_TENANCY_SCHEMA: 't', FAKE_SANDBOX_ROWS: 't' });
  check('08：非旅游风险在沙箱 purge 前拒绝，不删除数据', r.code === 9 && !r.log.includes('sandbox.ts purge --all'), r.log + r.out);
  {
    // 09：真实脚本的 SQL 在进程内 PG 上逐状态执行；手动和自动都过同一 guard。
    const quoteEnv = { FAKE_REFUND_SCHEMA: 't', FAKE_QUOTE: 't', FAKE_RUNNING: '9' };
    for (const target of ['pre-09', 'side1:prev']) {
      r = guard(target, { ...quoteEnv, FAKE_TARGET: '8' });
      check('09：带报价拒绝9并明确两条出路', r.code === 9 && r.out.includes('前滚修复，或者回滚到另一个含 09 的 tag'), r.out);
    }
    r = deploy('v08', quoteEnv);
    check('09：手动部署08在rsync之前拒绝', r.code === 1 && r.log.includes('pre-09 side1 3999') && !r.log.includes('rsync '), r.log + r.out);
    r = deploy('v09', { ...quoteEnv, FAKE_TARGET: '8', FAKE_HEALTH_FAIL: '1' });
    check(
      '09：健康失败自动退08也被拒绝',
      r.code === 1 && r.out.includes('没有自动回滚') && r.out.includes('前滚修复') && !fs.existsSync(rolledBack),
      r.out,
    );
    r = guard('pre-09', { ...quoteEnv, FAKE_QUOTE: 'f' });
    check('09：无报价放行', r.code === 0, r.out);
    r = guard('side1:prev', { ...quoteEnv, FAKE_TARGET: '9' });
    check('09：目标有site-links标记不查09报价风险', r.code === 0 && !r.log.includes("where data->'approval' IS NOT NULL)"), r.out);
    for (const state of ['down', 'unexpected', 'hang']) {
      r = guard('pre-09', { ...quoteEnv, FAKE_QUOTE: state, FAKE_TIMEOUT_MS: '100' });
      check('09：查询故障从严拒绝且有时限', r.code === 9 && r.elapsed < 5000, r.out);
    }
    {
      const pg = new PGlite();
      try {
        await pg.exec('create table orders(status text, data jsonb, void_reason text)');
        const sql = fs.readFileSync(`${queryFile}.quote`, 'utf8');
        for (const [status, approval, voidReason, decidedAt] of [
          ['pending_payment', 'pending', null],
          ['pending_payment', 'approved', null, Date.now()],
          ['pending_payment', 'approved', null, 0], // 过期的批准仍留在历史里
          ['paid', 'approved', null],
          ['cancelled', 'rejected', null],
          ['cancelled', 'withdrawn', null],
          ['superseded', 'approved', null],
          ['pending_payment', 'approved', 'reset'],
        ]) {
          await pg.query('insert into orders values ($1,$2,$3)', [
            status,
            JSON.stringify({ approval: { state: approval, ...(decidedAt === undefined ? {} : { decidedAt }) } }),
            voidReason,
          ]);
          check('09：所有审批状态和重置历史均拒绝', Object.values((await pg.query<Record<string, boolean>>(sql)).rows[0]!)[0] === true);
          await pg.exec('delete from orders');
        }
        await pg.exec(`insert into orders values ('paid','{}',null)`);
        check('09：SQL无审批放行', Object.values((await pg.query<Record<string, boolean>>(sql)).rows[0]!)[0] === false);
      } finally {
        await pg.close();
      }
    }

    const pg = new PGlite();
    try {
      await pg.exec(`create table tenants(id text, pack_id text);
        create table orders(tenant_id text, data jsonb);
        create table catalog_items(tenant_id text, kind text);
        create table kb_chunks(tenant_id text, source text);
        insert into tenants values ('host', 'travel'), ('other', 'travel');
        insert into orders values ('other', '{"v":1}'), ('host', '{}');
        insert into catalog_items values ('host', 'route'), ('other', 'hotel');
        insert into kb_chunks values ('other', 'route');`);
      const inserts = [
        "insert into tenants values ('fixture', '__fixture')",
        "insert into orders values ('other', '{\"v\":2}'), ('other', '{\"v\":\"2\"}')",
        "insert into catalog_items values ('other', 'widget')",
        "insert into kb_chunks values ('other', 'widget')",
      ];
      for (const [i, [key, variable, label]] of nontravelRisks.entries()) {
        guard('pre-07', { [variable]: 't' });
        const sql = fs.readFileSync(`${queryFile}.nontravel-${key}`, 'utf8');
        const countSql = fs.readFileSync(`${queryFile}.nontravel-${key}-count`, 'utf8');
        const exists = async () => (await pg.query<{ exists: boolean }>(sql)).rows[0]?.exists;
        check(`08 SQL：旅游数据不触发${label}`, (await exists()) === false);
        await pg.exec(inserts[i]!);
        check(`08 SQL：其他租户的${label}也被检查`, (await exists()) === true);
        check(
          `08 SQL：${label}计数来自同一谓词`,
          Number((await pg.query<{ count: number }>(countSql)).rows[0]?.count) === (i === 1 ? 2 : 1),
        );
      }
    } finally {
      await pg.close();
    }
  }

  // 10 R17：三类风险取 OR，两个旧档位和两条部署入口均受同一道只读检查保护。
  {
    const message = '前滚修复，或者回滚到另一个含 10 的 tag';
    const industrialEnv = { FAKE_RUNNING: '10', FAKE_REFUND_SCHEMA: 't' };
    const industrialRisks = [
      ['tenants', 'FAKE_INDUSTRIAL_TENANTS'],
      ['catalog', 'FAKE_INDUSTRIAL_CATALOG'],
      ['orders', 'FAKE_INDUSTRIAL_ORDERS'],
    ] as const;
    for (const [key, variable] of industrialRisks) {
      for (const phase of ['8', '9']) {
        const env = { ...industrialEnv, [variable]: 't', FAKE_TARGET: phase, FAKE_QUOTE: 't' };
        for (const target of [phase === '8' ? 'pre-09' : 'pre-10', 'side1:prev']) {
          r = guard(target, env);
          check(`10：${key} 单独存在，目标 ${target}/${phase} 拒绝9`, r.code === 9 && r.out.includes(message), r.out);
          check(
            '10：工业提示优先于09且拒绝前不写库、不purge',
            !r.log.includes("where data->'approval' IS NOT NULL)") &&
              !r.log.includes('sandbox.ts purge') &&
              !/\b(insert|update|delete|truncate)\b/i.test(r.log),
            r.log,
          );
        }
        r = deploy(`v0${phase}`, env);
        check(`10：手动部署${phase}拒绝1，在rsync之前`, r.code === 1 && r.out.includes(message) && !r.log.includes('rsync '), r.out);
        r = deploy('v10', { ...env, FAKE_HEALTH_FAIL: '1' });
        check(
          `10：健康失败回滚到${phase}拒绝1，不切换旧镜像`,
          r.code === 1 && r.out.includes(message) && r.out.includes('没有自动回滚') && !fs.existsSync(rolledBack),
          r.out,
        );
      }
      for (const state of ['down', 'lock-timeout', 'unexpected', '', 'hang']) {
        r = guard('pre-10', { ...industrialEnv, [variable]: state, FAKE_RUNNING: '8', FAKE_TIMEOUT_MS: '100' });
        check(
          `10：${key} 查询 ${state || '空结果'} 从严限时拒绝，旧运行镜像不豁免`,
          r.code === 9 && r.out.includes(message) && r.elapsed < 5000,
          r.out,
        );
      }
    }
    for (const schema of ['down', 'unexpected', '', 'hang']) {
      r = guard('pre-10', { ...industrialEnv, FAKE_INDUSTRIAL_SCHEMA: schema, FAKE_TIMEOUT_MS: '100' });
      check('10：表探测失败或挂住从严限时拒绝', r.code === 9 && r.out.includes(message) && r.elapsed < 5000, r.out);
    }
    for (const schema of ['down', 'unexpected', '', 'hang']) {
      r = guard('pre-10', { ...industrialEnv, FAKE_REFUND_SCHEMA: schema, FAKE_TIMEOUT_MS: '100' });
      check('10：订单表探测未知从严拒绝', r.code === 9 && r.out.includes(message) && r.elapsed < 5000, r.out);
    }
    for (const state of ['down', 'hang']) {
      const env = { ...industrialEnv, FAKE_INDUSTRIAL_ORDERS: state, FAKE_TARGET: '9', FAKE_TIMEOUT_MS: '100' };
      r = deploy('v09', env);
      check('10：工业查询故障经手动部署转为1且不同步', r.code === 1 && r.out.includes(message) && !r.log.includes('rsync '), r.out);
      r = deploy('v10', { ...env, FAKE_HEALTH_FAIL: '1' });
      check('10：工业查询故障经自动回滚转为1且不切换', r.code === 1 && r.out.includes(message) && !fs.existsSync(rolledBack), r.out);
    }
    r = guard('pre-10', { ...industrialEnv, FAKE_INDUSTRIAL_SCHEMA: 'f', FAKE_REFUND_SCHEMA: 'f' });
    check('10：确认三表不存在的空库放行', r.code === 0, r.out);
    r = guard('pre-10', { ...industrialEnv, FAKE_QUOTE: 't', FAKE_NONTRAVEL_TENANTS: 't', FAKE_BRAND: 't', FAKE_HEALTH_FAIL: '1' });
    check(
      '10：无工业风险放行，查附件与工业、不探测健康或旧风险',
      r.code === 0 && !r.log.includes('curl ') && !r.log.includes('site-links.ts') && !r.log.includes('information_schema'),
      r.log + r.out,
    );
    r = guard('pre-09', { ...industrialEnv, FAKE_QUOTE: 't' });
    check(
      '10：工业三项均无，pre-09仍拒绝任意approval历史',
      r.code === 9 && r.out.includes('另一个含 09 的 tag') && !r.out.includes(message),
      r.out,
    );
    for (const phase of ['8', '9']) {
      r = deploy(`v0${phase}`, industrialEnv);
      check('10：无风险手动部署旧tag成功', r.code === 0 && r.log.includes('rsync '), r.out);
      r = deploy('v10', { ...industrialEnv, FAKE_TARGET: phase, FAKE_HEALTH_FAIL: '1' });
      check('10：无风险健康失败可以切换旧镜像', r.code === 1 && fs.existsSync(rolledBack), r.out);
    }
    r = guard('side1:prev', { ...industrialEnv, FAKE_TARGET: '10', FAKE_INDUSTRIAL_TENANTS: 't' });
    check('10：含10目标不查工业数据', r.code === 0 && !r.log.includes("from public.tenants where pack_id = 'industrial'"), r.log + r.out);
    r = guard('side1:prev', { ...industrialEnv, FAKE_TARGET: '10', FAKE_QUOTE_TARGET: '8', FAKE_QUOTE: 't' });
    check('10：工业标记不跳过其他独立能力检查', r.code === 9 && r.out.includes('另一个含 09 的 tag'), r.out);
    for (const state of ['error', 'hang']) {
      r = guard('side1:prev', { ...industrialEnv, FAKE_TARGET: '9', FAKE_INDUSTRIAL_TARGET: state, FAKE_TIMEOUT_MS: '100' });
      check('10：目标文件探测失败或挂住，即使三项为零仍拒绝9', r.code === 9 && r.out.includes(message) && r.elapsed < 5000, r.out);
      r = deploy('v10', {
        ...industrialEnv,
        FAKE_TARGET: '9',
        FAKE_INDUSTRIAL_TARGET: state,
        FAKE_HEALTH_FAIL: '1',
        FAKE_TIMEOUT_MS: '100',
      });
      check('10：自动回滚目标能力未知拒绝1，不切换', r.code === 1 && r.out.includes(message) && !fs.existsSync(rolledBack), r.out);
    }
    r = deploy('v10', { FAKE_TREE_DOWN: '1' });
    check('10：手动tag文件树查询失败拒绝1，不同步', r.code === 1 && r.out.includes(message) && !r.log.includes('rsync '), r.out);

    // 执行生产脚本捕获的真实探测 / 谓词；不用重写SQL来证明自己。
    guard('pre-10', industrialEnv);
    const pg = new PGlite();
    try {
      for (const [key] of industrialRisks) {
        const sql = fs.readFileSync(`${queryFile}.industrial-${key}-probe`, 'utf8');
        check(`10 SQL：${key} 表不存在可识别`, Object.values((await pg.query(sql)).rows[0]!)[0] === false);
      }
      await pg.exec(`create table tenants(id text, slug text, pack_id text, status text);
        create table catalog_items(tenant_id text, kind text, status text);
        create table orders(tenant_id text, status text, data jsonb, void_reason text);
        insert into tenants values ('other', 'other-business', 'travel', 'disabled');`);
      const sqls = Object.fromEntries(industrialRisks.map(([key]) => [key, fs.readFileSync(`${queryFile}.industrial-${key}`, 'utf8')]));
      const exists = async (key: string) => (await pg.query<{ exists: boolean }>(sqls[key]!)).rows[0]?.exists;
      for (const [key] of industrialRisks) {
        const sql = fs.readFileSync(`${queryFile}.industrial-${key}-probe`, 'utf8');
        check(`10 SQL：${key} 表存在可识别`, Object.values((await pg.query(sql)).rows[0]!)[0] === true);
        check(`10 SQL：无工业数据时 ${key} 为false`, (await exists(key)) === false);
      }
      for (const status of ['active', 'disabled']) {
        await pg.query("insert into tenants values ('fixture', 'not-demo', 'industrial', $1)", [status]);
        check(`10 SQL：非demo工业租户 ${status} 仍拒绝`, (await exists('tenants')) === true);
        await pg.exec("delete from tenants where id = 'fixture'");
      }
      for (const status of ['draft', 'active']) {
        await pg.query("insert into catalog_items values ('other', 'part', $1)", [status]);
        check(`10 SQL：其他停用租户part条目 ${status} 仍拒绝`, (await exists('catalog')) === true);
        await pg.exec('delete from catalog_items');
      }
      for (const status of ['pending_payment', 'paid', 'cancelled', 'superseded', 'refund_pending', 'refunded']) {
        for (const approval of ['pending', 'approved', 'rejected', 'withdrawn']) {
          for (const voidReason of [null, 'reset']) {
            await pg.query('insert into orders values ($1,$2,$3,$4)', [
              'other',
              status,
              JSON.stringify({ v: 2, approval: { state: approval, decidedAt: 0 }, lines: [{ kind: 'widget' }, { kind: 'part' }] }),
              voidReason,
            ]);
            check(`10 SQL：工业报价 ${status}/${approval}/${voidReason} 不漏历史`, (await exists('orders')) === true);
            await pg.exec('delete from orders');
          }
        }
      }
      for (const data of [
        {},
        { v: 1, approval: {}, lines: [{ kind: 'part' }] },
        { v: 2, lines: [{ kind: 'part' }] },
        { v: 2, approval: {}, lines: [{ kind: 'widget' }] },
        { v: 2, approval: {} },
        { v: 2, approval: {}, lines: [] },
        { v: 2, approval: {}, lines: null },
      ]) {
        await pg.query("insert into orders values ('other', 'paid', $1, 'reset')", [JSON.stringify(data)]);
        check('10 SQL：缺少任一工业报价必要条件不误拒绝', (await exists('orders')) === false);
        await pg.exec('delete from orders');
      }
      // JSON null 仍符合原文 IS NOT NULL；不能悄悄收紧成审批对象判断。
      await pg.exec(`insert into orders values ('other', 'paid', '{"v":"2","approval":null,"lines":[{"kind":"part"}]}', 'reset')`);
      check('10 SQL：严格沿用v文本比较和approval IS NOT NULL', (await exists('orders')) === true);
    } finally {
      await pg.close();
    }
  }

  {
    const message = '前滚修复，或者回滚到另一个含 12 的 tag';
    const attachmentRisks = [
      ['attachments', 'FAKE_ATTACHMENTS', '有附件'],
      ['usage', 'FAKE_VISION', '有 vision 用量'],
      ['conversations', 'FAKE_RFQ_INTAKE', '有 rfqIntake 工业会话'],
    ] as const;
    for (const [, variable, label] of attachmentRisks) {
      const env = { FAKE_TARGET: '10', [variable]: 't' };
      for (const target of ['pre-12', 'side1:prev']) {
        r = guard(target, env);
        check(`12：${label}拒绝9，提示含12且无删除`, r.code === 9 && r.out.includes(message) && !r.log.includes('purge --all'), r.out);
      }
      for (const tag of ['v09', 'v10', 'v11']) {
        r = deploy(tag, env);
        check(`12：${label}手动退${tag}在同步前拒绝1`, r.code === 1 && r.out.includes(message) && !r.log.includes('rsync '), r.out);
        if (tag !== 'v09')
          check(
            `12：${tag}按附件文件树进入pre-12`,
            r.log.includes('pre-12 side1 3999') && r.log.includes(`refs/tags/${tag} -- src/core/attachments.ts`),
            r.log,
          );
      }
      r = deploy('v12', env);
      check(
        `12：含12的tag有${label}仍可部署，不进入pre-12`,
        r.code === 0 && r.log.includes('rsync ') && !r.log.includes('pre-12 side1 3999'),
        r.out,
      );
      r = deploy('v12', { ...env, FAKE_HEALTH_FAIL: '1' });
      check(`12：${label}自动退10拒绝1且不切换`, r.code === 1 && r.out.includes(message) && !fs.existsSync(rolledBack), r.out);
      r = guard('side1:prev', { ...env, FAKE_TARGET: '12' });
      check(`12：含12目标跳过${label}检查`, r.code === 0 && !r.log.includes('public.attachments'), r.log + r.out);
      for (const state of ['down', 'unexpected', '', 'lock-timeout', 'hang']) {
        r = guard('pre-12', { [variable]: state, FAKE_RUNNING: '9', FAKE_TIMEOUT_MS: '100' });
        check(
          `12：${label}查询${state || '空结果'}从严拒绝，不豁免旧运行镜像`,
          r.code === 9 && r.out.includes(message) && r.elapsed < 5000,
          r.out,
        );
      }
    }
    for (const tag of ['v10', 'v11']) {
      r = deploy(tag);
      check(`12：${tag}三项均无时检查后允许同步`, r.code === 0 && r.log.includes('pre-12 side1 3999') && r.log.includes('rsync '), r.out);
    }
    r = deploy('v12', { FAKE_ATTACHMENT_TREE_DOWN: '1' });
    check('12：tag文件树查询失败即使无数据仍拒绝1且不同步', r.code === 1 && r.out.includes(message) && !r.log.includes('rsync '), r.out);
    r = deploy('v10', { FAKE_ATTACHMENT_SCHEMA: 'down' });
    check(
      '12：手动退10查询未知拒绝1且不切换',
      r.code === 1 && r.out.includes(message) && !r.log.includes('rsync ') && !r.log.includes('up -d app'),
      r.out,
    );
    for (const schema of ['f', 't', 'down', 'unexpected', '', 'hang']) {
      r = guard('pre-12', { FAKE_ATTACHMENT_SCHEMA: schema, FAKE_TIMEOUT_MS: '100' });
      check(`12：表探测${schema || '空结果'}`, r.code === (['t', 'f'].includes(schema) ? 0 : 9) && r.elapsed < 5000, r.out);
      if (schema === 'f') check('12：缺表只跳过对应查询', !r.log.includes('select exists('), r.log);
    }
    for (const state of ['error', 'hang']) {
      r = guard('side1:prev', { FAKE_TARGET: '12', FAKE_ATTACHMENT_TARGET: state, FAKE_TIMEOUT_MS: '100' });
      check(`12：目标能力${state}即使数据为空仍拒绝9`, r.code === 9 && r.out.includes(message) && r.elapsed < 5000, r.out);
    }
    for (const target of ['pre-09', 'side1:prev']) {
      const env = { FAKE_TARGET: '8', FAKE_REFUND_SCHEMA: 't', FAKE_INDUSTRIAL_TENANTS: 't', FAKE_QUOTE: 't' };
      r = guard(target, { ...env, FAKE_ATTACHMENTS: 't' });
      check(
        '12：附件、工业、审批同时触发先报12',
        r.code === 9 &&
          r.out.includes(message) &&
          !r.log.includes('from public.tenants where') &&
          !r.log.includes("where data->'approval' IS NOT NULL"),
        r.log + r.out,
      );
      r = guard(target, env);
      check('12：附件为空仍由pre-10拒绝工业数据', r.code === 9 && r.out.includes('另一个含 10 的 tag') && !r.out.includes(message), r.out);
      r = guard(target, { ...env, FAKE_INDUSTRIAL_TENANTS: 'f' });
      check('12：附件与工业为空仍由pre-09拒绝审批历史', r.code === 9 && r.out.includes('另一个含 09 的 tag'), r.out);
    }
    r = guard('pre-12');
    check('12：三项都没有放行，只查询附件风险', r.code === 0 && !r.log.includes('curl ') && !r.log.includes('docker run'), r.log + r.out);
    r = guard('side1:prev', { FAKE_TARGET: '10' });
    check(
      '12：pre-12镜像三项都没有放行，按attachments.ts探测',
      r.code === 0 && r.log.includes('/app/src/core/attachments.ts'),
      r.log + r.out,
    );

    // 执行生产脚本捕获的SQL；PGlite与一次性PG独立数据库走相同的四类数据与JSON边界。
    const sqls = Object.fromEntries(
      attachmentRisks.flatMap(([key]) =>
        [key, `${key}-probe`].map((name) => [name, fs.readFileSync(`${queryFile}.attachment-${name}`, 'utf8')]),
      ),
    );
    const suite = async (label: string, query: (sql: string, values?: string[]) => Promise<{ rows: Record<string, unknown>[] }>) => {
      const exists = async (key: string) => Object.values((await query(sqls[key]!)).rows[0]!)[0];
      for (const [key] of attachmentRisks) check(`12 ${label}：${key}缺表可识别`, (await exists(`${key}-probe`)) === false);
      for (const sql of `create table attachments(id text, bytes bytea);
        create table usage_daily(tenant_id text, purpose text);
        create table tenants(id text, pack_id text, status text);
        create table conversations(tenant_id text, state json);
        insert into tenants values ('industrial-other', 'industrial', 'disabled'), ('travel', 'travel', 'active');`
        .split(';')
        .filter((sql) => sql.trim()))
        await query(sql);
      const verify = async (name: string, riskKey?: string) => {
        const env: Record<string, string> = {};
        for (const [key, variable] of attachmentRisks) {
          check(`12 ${label}：${key}表存在可识别`, (await exists(`${key}-probe`)) === true);
          const risk = await exists(key);
          check(`12 ${label}：${name}/${key}`, risk === (key === riskKey));
          env[variable] = risk ? 't' : 'f';
        }
        const result = guard('pre-12', env);
        check(
          `12 ${label}：${name}真实SQL结果送guard`,
          result.code === (riskKey ? 9 : 0) && (!riskKey || result.out.includes(message)),
          result.out,
        );
      };
      await verify('都没有');
      await query("insert into attachments values ('metadata-only', null)");
      await verify('只有附件元数据也拒绝', 'attachments');
      await query('delete from attachments');
      await query("insert into usage_daily values ('industrial-other', 'vision')");
      await verify('只有vision用量', 'usage');
      await query('delete from usage_daily');
      await query("insert into usage_daily values ('travel', 'main')");
      for (const intake of [{ lines: [] }, null, {}]) {
        await query('insert into conversations values ($1, $2)', [
          'industrial-other',
          JSON.stringify({ packState: { rfqIntake: intake } }),
        ]);
        await verify('停用非demo工业会话含rfqIntake键', 'conversations');
        await query('delete from conversations');
      }
      for (const state of [{}, { rfqIntake: {} }, { packState: {} }, { packState: null }, { packState: { nested: { rfqIntake: {} } } }]) {
        await query('insert into conversations values ($1, $2)', ['industrial-other', JSON.stringify(state)]);
        await verify('错误层级或缺键不误拒绝');
        await query('delete from conversations');
      }
      await query(`insert into conversations values ('travel', '{"packState":{"rfqIntake":{}}}')`);
      await verify('其他包同名键不误拒绝');
    };
    const local = new PGlite();
    try {
      await suite('PGlite', (sql, values) => local.query(sql, values));
    } finally {
      await local.close();
    }
    if (process.env.PG_TEST_URL) {
      const config = { connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 2000 };
      const admin = new nodePg.Client({ connectionString: process.env.PG_TEST_URL, ...config });
      const database = `rollback_guard_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(process.env.PG_TEST_URL);
      url.pathname = `/${database}`;
      const client = new nodePg.Client({ connectionString: url.toString(), ...config });
      let created = false;
      try {
        await admin.connect();
        await admin.query(`create database "${database}"`);
        created = true;
        await client.connect();
        await suite('真实PG', (sql, values) => client.query(sql, values));
        console.log('12：真实 PG 四类数据、JSON 层级与 guard 返回码通过');
      } finally {
        await client.end();
        try {
          if (created) await admin.query(`drop database "${database}"`);
        } finally {
          await admin.end();
        }
      }
    } else console.log('12：未设 PG_TEST_URL，真实 PG 待补跑');
  }

  const sandboxEnv = { FAKE_TARGET: '4', FAKE_RUNNING: '5', FAKE_TENANCY_SCHEMA: 't' };
  for (const state of ['running', 'stopped', 'env-only']) {
    if (state === 'env-only') fs.writeFileSync(path.join(srv, '.env.sandbox'), 'placeholder');
    const env = { ...sandboxEnv, FAKE_SANDBOX_CONTAINER: state === 'env-only' ? 'absent' : state };
    r = guard('pre-05', env);
    check(
      `05-13① ${state}：拒绝 7，只打印适用的删容器/改名与摘站点，未 purge`,
      r.code === 7 &&
        r.out.includes('--profile sandbox rm -sfv sandbox') === (state !== 'env-only') &&
        r.out.includes('mv .env.sandbox .env.sandbox.off') === (state === 'env-only') &&
        !r.out.includes('tenant-host clear') &&
        !r.out.includes('down -v') &&
        !r.out.includes('volume rm') &&
        r.out.includes('摘掉沙箱站点') &&
        !r.log.includes('sandbox.ts purge --all'),
      r.out,
    );
    const d = deploy('v04', env);
    check(
      `05-13① ${state}：deploy 转 1，不同步、不换容器、不改环境文件`,
      d.code === 1 &&
        d.out.includes('服务器上什么都没动') &&
        !d.log.includes('rsync ') &&
        !d.log.includes('up -d app') &&
        (state !== 'env-only' || fs.existsSync(path.join(srv, '.env.sandbox'))),
      d.out,
    );
    fs.rmSync(path.join(srv, '.env.sandbox'), { force: true });
  }
  r = deploy('v08', { ...sandboxEnv, FAKE_OTHER_HOST: 't', FAKE_HEALTH_FAIL: '1' });
  check(
    '05：自动回滚 7 转 1、提示服务不可用、不启动 prev',
    r.code === 1 && r.out.includes('多租户或沙箱风险，没有自动回滚，服务当前不可用！') && !fs.existsSync(rolledBack),
    r.out,
  );
  r = guard('pre-05', { ...sandboxEnv, FAKE_SANDBOX_ROWS: 't' });
  check(
    '05-13② 当前镜像 purge --all 后重新问库才放行',
    r.code === 0 &&
      r.log.includes('purge image=sha256:running') &&
      r.log.includes('sandbox.ts purge --all') &&
      r.log.indexOf('sandbox.ts purge --all') < r.log.lastIndexOf("kind = 'standard'") &&
      r.log.includes('timeout --kill-after=2s 120s docker compose') &&
      !r.out.includes('拒绝回滚'),
    r.log + r.out,
  );
  for (const [name, env] of [
    ['purge 持续失败', { FAKE_SANDBOX_ROWS: 't', FAKE_PURGE_FAIL: '1' }],
    ['运行时为零，purge 成功但库仍有行', { FAKE_SANDBOX_ROWS: 't', FAKE_AFTER_PURGE: 't' }],
    ['库不可达', { FAKE_TENANCY_DOWN: '1' }],
    ['查询结果无法确认', { FAKE_OTHER_HOST: 'unexpected' }],
    ['库元数据不可达', { FAKE_TENANCY_SCHEMA: 'down' }],
    ['容器列表不可确认', { FAKE_CONTAINER_DOWN: '1' }],
    ['其他 standard 有 public_host', { FAKE_OTHER_HOST: 't', FAKE_SANDBOX_ROWS: 't' }],
  ] as const) {
    r = guard('pre-05', { ...sandboxEnv, ...env });
    check(`05-13③ ${name}：拒绝 7`, r.code === 7, r.out);
    const forbiddenSteps =
      !r.out.includes('rm -sfv sandbox') &&
      !r.out.includes('mv .env.sandbox') &&
      !r.out.includes('down -v') &&
      !r.out.includes('volume rm');
    if ('FAKE_PURGE_FAIL' in env)
      check(
        '演练二·1 purge 失败：透出 CLI 错误码、查沙箱进程与挂住事务、不打印 Host/删除步骤',
        r.out.includes('sandbox_tenant_lock_held') &&
          r.out.includes('沙箱进程还在跑') &&
          r.out.includes('挂住的事务') &&
          r.out.includes('数据库锁') &&
          !r.out.includes('tenant-host clear') &&
          forbiddenSteps,
        r.out,
      );
    if ('FAKE_TENANCY_DOWN' in env || 'FAKE_TENANCY_SCHEMA' in env || ('FAKE_OTHER_HOST' in env && env.FAKE_OTHER_HOST === 'unexpected'))
      check(
        `演练二·1 ${name}：查 db、连接与查询字段，不打印清理步骤`,
        r.out.includes('确认 db 在跑') &&
          r.out.includes('数据库连接') &&
          r.out.includes('kind/public_host') &&
          r.out.includes('DEFAULT_TENANT_SLUG') &&
          !r.out.includes('tenant-host clear') &&
          forbiddenSteps,
        r.out,
      );
    if ('FAKE_AFTER_PURGE' in env)
      check(
        '演练二·1 purge 后仍有行：核查残留与查询结果、不打印无关清理步骤',
        r.out.includes('kind=sandbox') && r.out.includes('确认 purge 结果') && forbiddenSteps,
        r.out,
      );
    if ('FAKE_CONTAINER_DOWN' in env)
      check(
        '演练二·1 容器列表失败：查 Docker 与已停容器、不打印清理步骤',
        r.out.includes('确认 Docker 可达') && r.out.includes('docker container ls -a') && forbiddenSteps,
        r.out,
      );

    const d = deploy('v04', { ...sandboxEnv, ...env });
    check(
      `05-13③ ${name}：deploy 转 1、不 rsync`,
      d.code === 1 && d.out.includes('服务器上什么都没动') && !d.log.includes('rsync '),
      d.out,
    );
    if ('FAKE_OTHER_HOST' in env && env.FAKE_OTHER_HOST === 't')
      check(
        '05-13③ Host 风险先报，打印 clear 与摘域名、不 purge',
        r.out.includes('tenant-host clear') &&
          r.out.includes('standard') &&
          r.out.includes('public_host') &&
          r.out.includes('摘掉它们的域名') &&
          forbiddenSteps &&
          !r.log.includes('sandbox.ts purge --all'),
        r.out,
      );
  }
  r = deploy('v04', { ...sandboxEnv, FAKE_RUNNING: 'missing', FAKE_TENANCY_SCHEMA: 'down' });
  check(
    '演练二·2 空服务器旧 tag：从严拒绝、新服务器处理办法、无删容器/改名/Host 步骤',
    r.code === 1 &&
      r.out.includes('没有任何容器、库不可达的空服务器') &&
      r.out.includes('新服务器先部署 05 之后的 tag') &&
      r.out.includes('或确认库后再试') &&
      r.out.includes('服务器上什么都没动') &&
      !r.out.includes('rm -sfv sandbox') &&
      !r.out.includes('mv .env.sandbox') &&
      !r.out.includes('tenant-host clear') &&
      !r.log.includes('rsync '),
    r.out,
  );
  fs.writeFileSync(path.join(srv, '.env.sandbox'), 'placeholder');
  r = guard('pre-04', { ...sandboxEnv, FAKE_BRAND: 't', FAKE_OTHER_HOST: 't', FAKE_SANDBOX_CONTAINER: 'stopped', FAKE_SANDBOX_ROWS: 't' });
  check(
    '05-13④ 品牌与沙箱风险同时存在先报 6、只读列出 Host/容器/env/库行、不 purge',
    r.code === 6 &&
      r.out.includes(recovery) &&
      r.out.includes('处理完品牌风险后再跑，还可能因沙箱风险以 7 拒绝') &&
      r.out.includes('standard 租户有 public_host') &&
      r.out.includes('沙箱容器仍存在（包括已停的容器）') &&
      r.out.includes('.env.sandbox 仍存在') &&
      r.out.includes('库里仍有沙箱行') &&
      !r.log.includes('sandbox.ts purge --all') &&
      !r.log.includes('docker rm') &&
      !r.log.includes('rm -sfv'),
    r.out,
  );
  fs.rmSync(path.join(srv, '.env.sandbox'));
  r = guard('pre-04', { ...sandboxEnv, FAKE_BRAND: 't', FAKE_TENANCY_SCHEMA: 'down', FAKE_CONTAINER_DOWN: '1' });
  check(
    '演练二·3 品牌优先且沙箱查询不确定：提示库/容器无法确认、不 purge',
    r.code === 6 &&
      r.out.includes('库不可达或查询结果无法确认') &&
      r.out.includes('沙箱容器是否存在无法确认') &&
      !r.log.includes('sandbox.ts purge --all'),
    r.out,
  );
  r = guard('pre-05', { ...sandboxEnv, FAKE_RUNNING: '4', FAKE_TENANCY_SCHEMA: 'down' });
  check('05 旧运行镜像且问不到库，保留旧部署回归豁免', r.code === 0, r.out);
  r = guard('side1:prev', { ...sandboxEnv, FAKE_TARGET: '5', FAKE_TENANCY_DOWN: '1' });
  check('05 到 05 回滚无需 pre-05 数据检查', r.code === 0 && !r.log.includes("column_name = 'kind'"), r.out);

  const pg = new PGlite();
  try {
    await pg.query("select set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)", [
      sqlTimeouts[1]!,
      sqlTimeouts[2]!,
    ]);
    const settings = (
      await pg.query<{ statement: string; lock: string }>(
        "select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock",
      )
    ).rows[0]!;
    check('真正传入 psql 的 SQL 超时选项可在 PostgreSQL 设置', settings.statement === '5s' && settings.lock === '2s');
    const sqlBool = async (key: string): Promise<boolean> =>
      Object.values((await pg.query<Record<string, boolean>>(queries[key]!)).rows[0])[0]!;
    const state = async (name: string, expected: boolean): Promise<void> => {
      const pendingSchema = await sqlBool('pending-probe');
      const publishedSchema = await sqlBool('published-probe');
      const pending = pendingSchema && (await sqlBool('pending'));
      const published = publishedSchema && (await sqlBool('published'));
      const risk = pending || published;
      check(`${name}：SQL`, risk === expected);
      const env = {
        FAKE_PENDING_SCHEMA: pendingSchema ? 't' : 'f',
        FAKE_PUBLISHED_SCHEMA: publishedSchema ? 't' : 'f',
        FAKE_PENDING_BRAND: pending ? 't' : 'f',
        FAKE_PUBLISHED_BRAND: published ? 't' : 'f',
      };
      const g = guard('pre-04', env);
      check(`${name}：bash -s`, g.code === (expected ? 6 : 0) && (!expected || g.out.includes(recovery)), g.out);
      check(
        `${name}：缺表/列只跳过对应的风险查询`,
        g.log.includes('select exists(select 1 from public.tenants t') === pendingSchema &&
          g.log.includes('from public.sop_versions where') === publishedSchema,
        g.log,
      );
      const d = deploy('v03', env);
      check(
        `${name}：deploy.sh`,
        expected
          ? d.code === 1 && d.out.includes(recovery) && !d.log.includes('rsync ')
          : d.code === 0 && d.out.includes('v03 部署成功') && d.log.includes('rsync ') && !d.out.includes('拒绝回滚'),
        d.out,
      );
    };
    await state('空库没有任何表放行', false);
    await pg.exec(`create table tenants(id text primary key); create table sop_versions(tenant_id text, status text);
      insert into tenants values ('demo'), ('other');
      insert into sop_versions values ('demo', 'published'), ('other', 'published');`);
    await state('旧库有表但缺 brand 与 render_inputs 列放行', false);
    await pg.exec(`alter table sop_versions add column render_inputs jsonb;
      update sop_versions set render_inputs = '{}' where tenant_id = 'other';`);
    await state('03 旧库没有 brand 列、快照缺字段放行', false);
    await pg.exec(`update sop_versions set render_inputs = '{"brand":{"brandName":"山海旅行"}}' where tenant_id = 'other';`);
    await state('待生效品牌列缺失仍检查当前发布品牌', true);
    await pg.exec(`alter table tenants add column brand json;
      update sop_versions set render_inputs = '{"brand":null,"brandHash":"legacy"}';
      insert into sop_versions values ('other', 'archived', '{"brand":{"brandName":"旧品牌"}}'), ('other', 'draft', '{"brand":{"brandName":"草稿"}}');`);
    await state('显式 JSON null、历史与草稿品牌均不阻拦', false);
    await pg.exec(`update tenants set brand = '{"brandName":"山海旅行"}' where id = 'other';`);
    await state('非默认租户 set 未重启也拒绝', true);
    await pg.exec(`update sop_versions set render_inputs = '{"brand":{"brandName":"山海旅行"}}' where tenant_id = 'other' and status = 'published';
      update tenants set brand = null;`);
    await state('clear 未重启当前发布仍带品牌，拒绝', true);
    await pg.exec(`update sop_versions set status = 'archived' where tenant_id = 'other' and status = 'published';
      insert into sop_versions values ('other', 'published', '{"brand":null}');`);
    await state('重启重渲染后放行、历史品牌仍在不算风险', false);
    await pg.exec(`alter table sop_versions drop column render_inputs;
      update tenants set brand = '{"brandName":"山海旅行"}' where id = 'other';`);
    await state('发布快照列缺失仍检查待生效品牌', true);
    // 直接执行脚本捕获的 05 谓词，证明宿主 Host 被排除而其他 standard 与沙箱行分别计数。
    const tenancySql = fs.readFileSync(`${queryFile}.tenancy`, 'utf8');
    await pg.exec(`alter table tenants add column kind text default 'standard';
      alter table tenants add column slug text; alter table tenants add column public_host text;
      update tenants set slug = id;
      update tenants set public_host = 'host-placeholder' where id = 'demo';`);
    const tenancyRows = async (): Promise<boolean[]> => Object.values((await pg.query<Record<string, boolean>>(tenancySql)).rows[0]!);
    check('05-13③ SQL 宿主 public_host 不阻止回滚', (await tenancyRows()).join() === 'false,false');
    await pg.exec("update tenants set public_host = 'other-placeholder' where id = 'other'");
    check('05-13③ SQL 其他 standard public_host 阻止回滚', (await tenancyRows()).join() === 'true,false');
    await pg.exec(
      "update tenants set public_host = null where id = 'other'; insert into tenants(id,slug,kind) values ('sandbox','sbx-placeholder','sandbox')",
    );
    check('05-13② SQL 库中沙箱行独立于 standard Host 风险', (await tenancyRows()).join() === 'false,true');
    await pg.exec("delete from tenants where kind = 'sandbox'");
    check('05-13② SQL purge 后无沙箱行才放行', (await tenancyRows()).join() === 'false,false');
  } finally {
    await pg.close();
  }
  console.log(`PASS rollback brand/sandbox/nontravel/attachments：${checks} 项（stdin、SQL、部署与自动回滚）`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
