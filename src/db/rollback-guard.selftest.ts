// 04 R14：真实脚本经 bash -s 与 deploy.sh 两条入口；假 docker 主动吞 stdin，数据库谓词另用 PGlite 验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
const recovery = '先 tenant-brand clear、重启、确认 /healthz 的 promptHash 回到旧版模式的值，再回滚。';
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
  const r = spawnSync(command, args, { cwd: repo, env: { ...baseEnv, ...env }, input, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(r.error);
  return { code: r.status, out: r.stdout + r.stderr, log: fs.readFileSync(log, 'utf8') };
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
  fake(
    'docker',
    `
cat >/dev/null
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  *"inspect --format {{.Image}}"*) [ "\${FAKE_RUNNING:-4}" = missing ] && exit 1; echo sha256:running ;;
  *pg-backend.ts*|*registry.ts*|*pack-api.ts*)
    phase="\${FAKE_TARGET:-3}"
    case "$*" in *sha256:running*) phase="\${FAKE_RUNNING:-4}" ;; esac
    [ "$phase" = error ] && exit 125
    case "$*" in *pg-backend.ts*) need=2 ;; *registry.ts*) need=3 ;; *) need=4 ;; esac
    [ "$phase" -ge "$need" ] ;;
  *"from tenants t"*)
    printf '%s' "\${!#}" > "$FAKE_QUERY"
    case "\${FAKE_BRAND-f}" in down) exit 1 ;; *) echo "\${FAKE_BRAND-f}" ;; esac ;;
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
    r.log.includes('exec -T db psql -U postgres -d brand_fixture') && r.out.includes('clear 只改待生效值'),
    r.log,
  );
  for (const target of ['pre-02', 'pre-03', 'pre-04', 'side1:prev']) {
    r = guard(target, { FAKE_BRAND: 't' });
    check(`${target} 仍检查品牌`, r.code === 6 && r.out.includes(recovery), r.out);
  }
  r = guard('pre-04');
  check('品牌为空放行，当前 04 发布的 brand:null 由 SQL 判断', r.code === 0, r.out);
  r = guard('side1:prev', { FAKE_TARGET: '4', FAKE_BRAND: 'down' });
  check('04 到 04 无需品牌降级检查', r.code === 0 && !r.log.includes('from tenants t'), r.log);
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
  const query = fs.readFileSync(queryFile, 'utf8');
  const pg = new PGlite();
  try {
    await pg.exec(`create table tenants(id text primary key); create table sop_versions(tenant_id text, status text, render_inputs jsonb);
      insert into tenants values ('demo'), ('other');
      insert into sop_versions values ('demo', 'published', null), ('other', 'published', '{}');`);
    const risky = async (): Promise<boolean> => Object.values((await pg.query<Record<string, boolean>>(query)).rows[0])[0]!;
    const state = async (name: string, expected: boolean): Promise<void> => {
      const risk = await risky();
      check(`${name}：SQL`, risk === expected);
      const env = { FAKE_BRAND: risk ? 't' : 'f' };
      const g = guard('pre-04', env);
      check(`${name}：bash -s`, g.code === (expected ? 6 : 0) && (!expected || g.out.includes(recovery)), g.out);
      const d = deploy('v03', env);
      check(
        `${name}：deploy.sh`,
        expected
          ? d.code === 1 && d.out.includes(recovery) && !d.log.includes('rsync ')
          : d.code === 0 && d.out.includes('v03 部署成功') && d.log.includes('rsync ') && !d.out.includes('拒绝回滚'),
        d.out,
      );
    };
    await state('03 旧库没有 brand 列、快照缺字段放行', false);
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
  } finally {
    await pg.close();
  }
  console.log(`PASS rollback brand：${checks} 项（stdin、SQL、部署与自动回滚）`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
