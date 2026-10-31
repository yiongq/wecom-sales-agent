import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { createTenantRuntime } from '../runtime.js';
import { createIndustrialRuntime } from '../../packs/industrial/runtime.js';
import { packSources } from '../../config/source.js';
import { sharedTrial } from './notice.js';

const rt = createTenantRuntime({ id: '00000000-0000-4000-8000-000000000015', slug: 'synthetic-trial', isHost: false });
rt.pack = { ...rt.pack, runtime: createIndustrialRuntime(packSources()) };
const entry = { tenantId: rt.id, slug: rt.slug, packId: 'industrial', kind: 'standard', isHost: false };
assert.equal(sharedTrial(rt, JSON.stringify([entry])), true);
for (const raw of [
  '',
  'broken',
  '{}',
  '[]',
  ...[
    { tenantId: '00000000-0000-4000-8000-000000000016' },
    { slug: 'other' },
    { packId: 'travel' },
    { kind: 'sandbox' },
    { isHost: true },
  ].map((change) => JSON.stringify([{ ...entry, ...change }])),
])
  assert.equal(sharedTrial(rt, raw), false);
assert.equal(sharedTrial({ ...rt, isHost: true }, JSON.stringify([entry])), false);
assert.equal(sharedTrial({ ...rt, kind: 'sandbox' }, JSON.stringify([entry])), false);
console.log('PASS 15 验收 9：共享告知仅精确白名单，错 UUID/slug/pack/kind/宿主与损坏配置不显示');
