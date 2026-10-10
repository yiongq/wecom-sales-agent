// 04 R14：真实脚本经 bash -s 与 deploy.sh 两条入口；假 docker 主动吞 stdin，数据库谓词另用 PGlite 验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';

const root = path.join(import.meta.dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-brand-'));
const bin = path.join(tmp, 'bin');
const repo = path.join(tmp, 'repo');
const srv = path.join(tmp, 'srv');
const log = path.join(tmp, 'calls');
const queryFile = path.join(tmp, 'brand-query');
const rolledBack = path.join(tmp, 'rolled-back');
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
  PATH: `${bin}:${process.env.PATH}`,
  TMPDIR: tmp,
  FAKE_LOG: log,
  FAKE_QUERY: queryFile,
  FAKE_ROLLED_BACK: rolledBack,
};
const run = (command: string, args: string[], env: Record<string, string> = {}, input?: string) => {
  fs.writeFileSync(log, '');
  fs.rmSync(rolledBack, { force: true });
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
if (kill !== '--kill-after=2s' || limit !== '8s') process.exit(99);
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
      pending-probe:*information_schema.columns*tenants*|published-probe:*information_schema.columns*sop_versions*|pending:*"from public.tenants"*|published:*"from public.sop_versions"*|catalog-probe:*to_regclass*catalog_item_versions*|catalog:*"from catalog_item_versions"*|channel-probe:*to_regclass*channel_accounts*|channel:*"from channel_accounts where"*)
        exec perl -e 'sleep 60' ;;
    esac ;;
esac
case "$*" in
  *"inspect --format {{.Image}}"*) [ "\${FAKE_RUNNING:-4}" = missing ] && exit 1; echo sha256:running ;;
  *pg-backend.ts*|*registry.ts*|*pack-api.ts*)
    phase="\${FAKE_TARGET:-3}"
    case "$*" in *sha256:running*) phase="\${FAKE_RUNNING:-4}" ;; esac
    [ "$phase" = error ] && exit 125
    case "$*" in *pg-backend.ts*) need=2 ;; *registry.ts*) need=3 ;; *) need=4 ;; esac
    [ "$phase" -ge "$need" ] ;;
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
printf '{"revision":"%s","config":{"catalogVersioned":false}}' "\${FAKE_REVISION:-fixture}"`,
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
      *pack-api.ts) case "$3" in *v04:*) exit 0 ;; *) exit 1 ;; esac ;;
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
  *curl*) exec curl ;;
  *"image inspect"*) exec docker image inspect side1:prev ;;
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
    r.log.split('\n').filter((line) => line.startsWith('docker ') && line.includes('psql')).length === 4 &&
      r.log.split('\n').filter((line) => line.startsWith('timeout --kill-after=2s 8s docker ')).length === 4 &&
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
  check('04 到 04 无需品牌降级检查', r.code === 0 && !r.log.includes('information_schema.columns'), r.log);
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
        g.log.includes('from public.tenants t') === pendingSchema && g.log.includes('from public.sop_versions where') === publishedSchema,
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
  } finally {
    await pg.close();
  }
  console.log(`PASS rollback brand：${checks} 项（stdin、SQL、部署与自动回滚）`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
