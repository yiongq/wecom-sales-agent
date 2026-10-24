// 08 第 8 步：通用单投影、库约束、写队列与预载往返；PGlite 必跑，真实 PG 由 PG_TEST_URL 开启。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnyOrder, LineOrder } from '../core/order-view.js';
import { createFixtureLineOrder } from '../packs/__fixture/order-fixtures.js';
import type { Order } from '../types.js';
import { normalizeForStore, orderToRow, rowToOrder } from './project.js';

if (!process.argv[2]) {
  for (const backend of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, backend], {
      env: { ...process.env, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file', LLM_MOCK: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, `${backend} 通用单落库自测失败`);
  }
  if (!process.env.PG_TEST_URL) console.log('ORDER STORAGE SKIP：未设置 PG_TEST_URL，真实 PG 未运行');
} else {
  const backend = process.argv[2];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-storage-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const testing = await withoutTenantScope(() => import('../db/testing.js'));
  const { withTenant, pgErrorOf } = await import('../db/client.js');
  const { readLiveOrders, upsertOrders } = await import('../db/repo/orders.js');
  const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
  const t = backend === 'pglite' ? await testing.openTestDb() : null;
  const real = t ? null : await testing.createRealPgFixture(process.env.PG_TEST_URL!);
  const gated = real ? await testing.openGatedDb(real.urls.app) : null;
  const store = await import('../store.js');
  const query = async <T>(text: string, params: unknown[] = []): Promise<T[]> => {
    if (real) return real.query<T>(text, params);
    return t!.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<T>(text, params)).rows;
    });
  };
  try {
    const tenant = t ? await createFixtureTenant(t.db) : null;
    if (real) await real.query("UPDATE tenants SET pack_id = '__fixture' WHERE id = $1", [real.tenantId]);
    const fx = t ? await testing.installPgSessionStore(t, { slug: tenant!.slug, varDir: dir }) : null;
    const deps = fx?.deps ?? { db: gated!.db, tenantId: real!.tenantId, tenantSlug: 'demo', varDir: dir };
    const ctx = { tenantId: deps.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const line = createFixtureLineOrder();
    const legacy: Order = {
      id: 'ord_legacy',
      sessionId: line.sessionId,
      routeId: 'r-synthetic',
      routeTitle: '合成旅游单',
      travelers: 2,
      departDate: '2026-11-01',
      totalPrice: 1330,
      status: 'pending_payment',
      createdAt: 100,
    };
    // 逐列固定旧投影，包含各状态、可选时间与两种作废原因；data 的键序与字节也要保持。
    for (const status of ['pending_payment', 'paid', 'cancelled', 'superseded', 'refund_pending', 'refunded'] as const) {
      const old: Order = {
        ...legacy,
        status,
        ...(status === 'paid' || status.startsWith('refund_') ? { paidAt: 300 } : {}),
        confirmedAt: 150,
      };
      for (const reason of [undefined, 'reset', 'resync'] as const) {
        const voided = reason ? { at: 400, reason } : undefined;
        assert.deepEqual(orderToRow(old, voided), {
          id: old.id,
          sessionId: old.sessionId,
          routeId: old.routeId,
          status: old.status,
          totalPrice: old.totalPrice,
          totalFen: null,
          createdAt: new Date(100),
          paidAt: old.paidAt === undefined ? null : new Date(old.paidAt),
          confirmedAt: new Date(150),
          voidedAt: reason ? new Date(400) : null,
          voidReason: reason ?? null,
          data: normalizeForStore(old),
        });
        assert.equal(JSON.stringify(orderToRow(old).data), JSON.stringify(old));
      }
    }
    for (const totalFen of [133049, 133050]) {
      const fractional: LineOrder = { ...line, totalFen };
      assert.equal(orderToRow(fractional).totalPrice, totalFen === 133049 ? 1330 : 1331);
      assert.equal(orderToRow(fractional).totalFen, totalFen);
    }
    assert.deepEqual(rowToOrder({ data: orderToRow(line).data }), line);
    // 列是查询副本，重建不能让冲突的副本覆盖 data。
    const conflicting = { ...orderToRow(line), routeId: 'other', totalPrice: 0, totalFen: 0 };
    assert.deepEqual(rowToOrder(conflicting), line);

    await store.initSessionStore(deps);
    const s = store.getOrCreateSession(line.sessionId, 'wecom');
    s.orderIds.push(line.id, legacy.id);
    // 第 9 步才加建单；自测直接放入两种合成单，经现有写队列与投影落库。
    const anyOrders: Map<string, AnyOrder> = rt.store.orders;
    anyOrders.set(line.id, line);
    anyOrders.set(legacy.id, legacy);
    store.saveSession(s);
    rt.store.pgBackend!.scheduleOrder(line.id);
    rt.store.pgBackend!.scheduleOrder(legacy.id);
    await store.flushSession(s.id);
    let rows = await withTenant(deps.db, ctx, (tx) => readLiveOrders(tx, [s.id]));
    assert.deepEqual(
      rows.find((o) => o.id === line.id),
      orderToRow(line),
    );
    assert.deepEqual(
      rows.find((o) => o.id === legacy.id),
      orderToRow(legacy),
    );
    const [raw] = await query<{ total_fen: string; total_price: number; route_id: string; data_text: string }>(
      'SELECT total_fen::text, total_price, route_id, data::text AS data_text FROM orders WHERE tenant_id = $1 AND id = $2',
      [deps.tenantId, line.id],
    );
    assert.deepEqual(raw, { total_fen: '133000', total_price: 1330, route_id: 'w-a', data_text: JSON.stringify(line) });

    // upsert 的更新分支也必须覆盖新列（两行总额仍保持合法）。
    const changed: LineOrder = {
      ...line,
      lines: [line.lines[0], { ...line.lines[1]!, unitPriceFen: 1201, amountFen: 60050 }],
      totalFen: 133050,
    };
    await withTenant(deps.db, ctx, (tx) => upsertOrders(tx, [orderToRow(changed)]));
    rows = await withTenant(deps.db, ctx, (tx) => readLiveOrders(tx, [s.id]));
    assert.deepEqual(
      rows.find((o) => o.id === line.id),
      orderToRow(changed),
    );
    await withTenant(deps.db, ctx, (tx) => upsertOrders(tx, [orderToRow(line)]));

    const insert = `INSERT INTO orders (tenant_id, id, session_id, route_id, status, total_price, total_fen, created_at, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::json)`;
    for (const [id, data, totalFen, constraint] of [
      ['ord_mismatch', line, 133001, 'orders_line_total_fen_check'],
      ['ord_missing', line, null, 'orders_line_total_fen_check'],
      ['ord_negative', legacy, -1, 'orders_total_fen_check'],
    ] as const) {
      await assert.rejects(
        query(insert, [deps.tenantId, id, s.id, 'w-a', 'pending_payment', 1330, totalFen, new Date(200), JSON.stringify({ ...data, id })]),
        (error: unknown) => {
          const err = pgErrorOf(error);
          return err.code === '23514' && err.constraint === constraint;
        },
      );
    }
    // 清空内存后走完整预载，再经对外访问器取回；新旧访问器的分流照旧。
    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    rt.store.pgBackend = null;
    rt.store.sessions.clear();
    rt.store.orders.clear();
    await store.initSessionStore(deps);
    assert.deepEqual(store.getAnyOrder(line.id), line);
    assert.equal(store.getOrder(line.id), undefined);
    assert.deepEqual(store.getOrder(legacy.id), legacy);
    // 导出与重复导入也走 rowToOrder，通用单必须原样保留。
    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    const { exportSessions, importSessions } = await import('../cli/session-transfer.js');
    const transfer = { ...deps, keepDir: `${dir}-keep`, lock: async () => testing.fakeLock() };
    try {
      const exported = await exportSessions(transfer);
      assert.equal(exported.code, 0, exported.lines.join('\n'));
      const fileOrders = JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8')) as AnyOrder[];
      assert.deepEqual(
        fileOrders.find((o) => o.id === line.id),
        line,
      );
      assert.deepEqual(
        fileOrders.find((o) => o.id === legacy.id),
        legacy,
      );
      const imported = await importSessions(transfer);
      assert.equal(imported.code, 0, imported.lines.join('\n'));
    } finally {
      fs.rmSync(transfer.keepDir, { recursive: true, force: true });
    }
    console.log(
      `ORDER STORAGE PASS (${backend})：133000分/1330元/w-a、整单JSON、upsert更新、预载/getAnyOrder、三个CHECK拒绝、旧单逐列不变`,
    );
  } finally {
    await store.drainStore(5000);
    rt.store.pgBackend?.close();
    rt.store.fileBackend?.reset();
    if (rt.store.maintenanceTimer) clearInterval(rt.store.maintenanceTimer);
    if (rt.store.changeTimer) clearTimeout(rt.store.changeTimer);
    await gated?.close();
    await t?.close();
    await real?.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}
