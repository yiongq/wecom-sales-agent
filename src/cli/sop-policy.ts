// 07 R4：以 app 身份写草稿；与后台共用保存、乐观锁和审计，发布仍在后台进行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withTenant, type Db } from '../db/client.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { readDraft, readPublishedSop } from '../db/repo/sop.js';
import { saveSopDraft, SopContractError } from '../config/sop.js';
import { publishedBrand } from '../config/hashes.js';
import { tenantImage } from '../config/brand.js';
import { packSources } from '../config/source.js';
import { runtimeById } from '../packs/registry.js';
import { dbFromEnv, main } from './common.js';

export async function runSopPolicy(argv: string[], deps: { connect(): Promise<{ db: Db; close(): Promise<void> }> }): Promise<number> {
  try {
    const command = argv[0];
    const a = parseArgs({
      args: argv.slice(1),
      options: { tenant: { type: 'string' }, 'policy-file': { type: 'string' } },
      strict: true,
    }).values;
    if (command !== 'set' || !a.tenant || !a['policy-file']) throw new Error('用法：sop-policy set --tenant <slug> --policy-file <json>');
    const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(a['policy-file'])));
    const { db, close } = await deps.connect();
    try {
      const tenant = await findTenantBySlug(db, a.tenant);
      if (!tenant) throw new Error('tenant_not_found');
      const runtime = runtimeById(tenant.packId, packSources());
      if (!runtime?.policy) throw new Error('pack_policy_unavailable');
      const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: 'sop-policy', ip: null } };
      const { pub, draft } = await withTenant(db, ctx, async (tx) => ({ pub: await readPublishedSop(tx), draft: await readDraft(tx) }), {
        readOnly: true,
      });
      if (!pub) throw new Error('no_published_sop');
      const image = fs.readFileSync(path.join(process.cwd(), 'data', 'sop.md'), 'utf8');
      await saveSopDraft(
        ctx,
        { basedOn: pub.id, rev: draft?.rev ?? null, edits: [], policy },
        {
          db,
          imageSections: tenantImage(runtime, image, publishedBrand(pub.renderInputs).brand),
          policy: runtime.policy,
        },
      );
      console.log('[sop-policy] 已保存退改条款草稿，请在后台发布');
      return 0;
    } finally {
      await close();
    }
  } catch (e) {
    // 不透出数据库错误或文件内容（可能含敏感数据）。
    console.error('[sop-policy] 保存失败', e instanceof SopContractError ? 'policy_invalid' : '请检查参数、文件与租户状态');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(() => runSopPolicy(process.argv.slice(2), { connect: () => dbFromEnv('DATABASE_URL') }));
