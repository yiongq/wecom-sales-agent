// 08 R14：后续证明包验收复用的租户夹具；调用方提供 openTestDb() 的 PGlite 测试库。
// 与现有 tenancy/testing.ts 同类，仅供自测。此时不导入产品、不发布 SOP、不绑定运行时。
// 08 R5：非自测文件不能直接 import 具体包，因此从参考配置读取并校验品牌。
import fs from 'node:fs';
import { BrandProfileSchema } from '../core/pack-api.js';
import type { Db } from '../db/client.js';
import { insertTenant, type TenantRow } from '../db/repo/tenants.js';
import { packById } from '../packs/registry.js';

/** 以测试库的超级用户身份调用；返回租户信息，连接角色由调用方管理。 */
export async function createFixtureTenant(db: Db, opts: { slug?: string } = {}): Promise<TenantRow> {
  if (process.env.PACK_FIXTURES !== '1' || !packById('__fixture')) {
    throw new Error('创建证明包租户需要 PACK_FIXTURES=1 且证明包已登记');
  }
  return insertTenant(db, {
    slug: opts.slug ?? 'fixture',
    name: '方盒核验证明租户',
    packId: '__fixture',
    locale: 'zh-CN',
    region: 'CN',
    brand: BrandProfileSchema.parse(JSON.parse(fs.readFileSync(new URL('../../data/packs/__fixture/brand.json', import.meta.url), 'utf8'))),
  });
}
