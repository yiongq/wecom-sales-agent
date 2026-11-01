import type { Redacted } from '../channels/secrets.js';
import { EgressError, type createEgress } from '../net/egress.js';
import { ErpError, type ErpConnector } from './types.js';

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every((row) => object(row) && positiveId(row.id))) throw new ErpError('bad_response');
  return value;
}

function relationId(value: unknown): number {
  if (!Array.isArray(value) || !positiveId(value[0])) throw new ErpError('bad_response');
  return value[0];
}

function uomId(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== 'string') throw new ErpError('bad_response');
  return relationId(value);
}

function one(value: unknown, id: number): Record<string, unknown> {
  const result = rows(value);
  if (result.length !== 1 || result[0].id !== id) throw new ErpError('bad_response');
  return result[0];
}

export function createOdooConnector(options: {
  send: ReturnType<typeof createEgress>;
  apiKey: Redacted<{ apiKey: string }>;
  database?: string | null;
  locationId: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): ErpConnector {
  const { send, apiKey, database, locationId } = options;
  if (database != null && (database.length < 1 || database.length > 63 || /[^A-Za-z0-9_.-]/.test(database))) throw new ErpError('invalid');
  if (!positiveId(locationId)) throw new RangeError('locationId');
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call(model: string, method: string, body: Record<string, unknown>, deadline: number, maxBytes: number): Promise<unknown> {
    let response: Awaited<ReturnType<typeof send>>;
    try {
      response = await send({
        path: `/json/2/${model}/${method}`,
        headers: {
          Authorization: `bearer ${apiKey.reveal().apiKey}`,
          'Content-Type': 'application/json',
          ...(database == null ? {} : { 'X-Odoo-Database': database }),
        },
        body: JSON.stringify(body),
        deadline,
        maxBytes,
      });
    } catch (error) {
      throw new ErpError(
        error instanceof EgressError
          ? error.code === 'timeout'
            ? 'timeout'
            : error.code === 'too_large'
              ? 'bad_response'
              : 'egress'
          : 'egress',
      );
    }
    // 状态码先于媒体类型与正文；从不读取 Odoo 错误里的 message/debug/arguments。
    const { status } = response;
    if (status === 401) throw new ErpError('auth');
    if (status === 403) throw new ErpError('forbidden');
    if (status === 404) throw new ErpError('not_found');
    if (status === 429 || status >= 500) throw new ErpError('server');
    if (status >= 400) throw new ErpError('invalid');
    if (status < 200 || status >= 300 || response.mediaType?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new ErpError('bad_response');
    }
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new ErpError('bad_response');
    }
  }

  return {
    async stock(ids, deadline) {
      if (ids.length > 30 || !ids.every(positiveId)) throw new RangeError('stock ids');
      if (ids.length === 0) return new Map();
      const value = await call(
        'product.product',
        'search_read',
        {
          domain: [['id', 'in', ids]],
          fields: ['free_qty', 'uom_id', 'active'],
          context: { location: locationId, active_test: false },
        },
        deadline,
        64 * 1024,
      );
      return new Map(
        rows(value).map((row) => {
          if (typeof row.free_qty !== 'number' || !Number.isFinite(row.free_qty) || typeof row.active !== 'boolean') {
            throw new ErpError('bad_response');
          }
          return [row.id as number, { freeQty: Math.max(0, Math.floor(row.free_qty)), uomId: uomId(row.uom_id), active: row.active }];
        }),
      );
    },
    async products({ offset, limit }) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !positiveId(limit) || limit > 500) throw new RangeError('products page');
      const value = await call(
        'product.product',
        'search_read',
        {
          domain: [
            ['default_code', '!=', false],
            ['sale_ok', '=', true],
          ],
          fields: ['default_code', 'uom_id'],
          order: 'id asc',
          offset,
          limit,
        },
        now() + 15_000,
        2 * 1024 * 1024,
      );
      return rows(value).map((row) => {
        if (typeof row.default_code !== 'string' || !row.default_code) throw new ErpError('bad_response');
        return { id: row.id as number, code: row.default_code, uomId: uomId(row.uom_id) };
      });
    },
    async check() {
      const read = (model: string, method: string, body: Record<string, unknown>) => call(model, method, body, now() + 5000, 64 * 1024);
      const context = await read('res.users', 'context_get', {});
      if (!object(context) || !positiveId(context.uid)) throw new ErpError('bad_response');
      await sleep(1000);
      const user = one(await read('res.users', 'read', { ids: [context.uid], fields: ['company_id'] }), context.uid);
      const companyId = relationId(user.company_id);
      await sleep(1000);
      const company = one(await read('res.company', 'read', { ids: [companyId], fields: ['currency_id'] }), companyId);
      const currencyId = relationId(company.currency_id);
      await sleep(1000);
      const currency = one(await read('res.currency', 'read', { ids: [currencyId], fields: ['name'] }), currencyId);
      if (typeof currency.name !== 'string' || !currency.name) throw new ErpError('bad_response');
      await sleep(1000);
      const locations = rows(await read('stock.location', 'search_read', { domain: [['id', '=', locationId]], fields: ['id'], limit: 1 }));
      return { companyCurrency: currency.name, locationOk: locations.some((row) => row.id === locationId) };
    },
  };
}
