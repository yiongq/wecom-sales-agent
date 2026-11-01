// 仅供自测使用；所有数据均为合成，不复制 Odoo 的实现、报错或业务数据。
import { once } from 'node:events';
import http from 'node:http';
import type { Socket } from 'node:net';

export interface MockProduct {
  id: number;
  default_code: string | false;
  uom_id: [number, string];
  active: boolean;
  sale_ok: boolean;
  freeQty: Record<number, unknown>;
  deleted?: boolean;
}

export interface MockRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
  at: number;
}

export interface MockFault {
  delayMs?: number;
  hang?: boolean;
  status?: number;
  html?: boolean;
  mediaType?: string | null;
  body?: unknown;
  rawBody?: string;
  errorName?: string;
}

/** 故障队列逐请求消耗；fault 回调可按路径注入，用于后续 registry、映射与集成自测。 */
export async function startOdooMock(options: {
  version: 19 | 20;
  keepAlive?: boolean;
  apiKey?: string;
  keyScope?: 'rpc' | '';
  database?: string;
  products?: MockProduct[];
  locations?: number[];
  uid?: number;
  companyId?: number;
  currencyId?: number;
  currencyName?: string;
  fault?: (request: MockRequest) => MockFault | undefined;
}) {
  const products =
    options.products ??
    ([
      { id: 1, default_code: 'PART-A', uom_id: [1, 'Synthetic units'], active: true, sale_ok: true, freeQty: { 10: 9.5, 20: 21.25 } },
      { id: 2, default_code: 'PART-DUP', uom_id: [1, 'Synthetic units'], active: true, sale_ok: true, freeQty: { 10: -2.5 } },
      { id: 3, default_code: 'PART-DUP', uom_id: [1, 'Synthetic units'], active: true, sale_ok: true, freeQty: { 10: 3 } },
      { id: 4, default_code: 'PART-ARCHIVED', uom_id: [1, 'Synthetic units'], active: false, sale_ok: true, freeQty: { 10: 4 } },
      {
        id: 5,
        default_code: 'PART-DELETED',
        uom_id: [1, 'Synthetic units'],
        active: true,
        sale_ok: true,
        freeQty: { 10: 5 },
        deleted: true,
      },
      { id: 6, default_code: false, uom_id: [1, 'Synthetic units'], active: true, sale_ok: true, freeQty: { 10: 6 } },
      { id: 7, default_code: 'PART-NOT-SOLD', uom_id: [1, 'Synthetic units'], active: true, sale_ok: false, freeQty: { 10: 7 } },
    ] satisfies MockProduct[]);
  const locations = options.locations ?? [10, 20];
  const uid = options.uid ?? 5;
  const companyId = options.companyId ?? 2;
  const currencyId = options.currencyId ?? 6;
  const requests: MockRequest[] = [];
  const faults: MockFault[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let inFlight = 0;
  let maxInFlight = 0;

  function error(status: number, errorName?: string) {
    const names: Record<number, string> = {
      400: 'werkzeug.exceptions.BadRequest',
      401: 'werkzeug.exceptions.Unauthorized',
      403: 'odoo.exceptions.AccessError',
      404: 'werkzeug.exceptions.NotFound',
      422: 'werkzeug.exceptions.UnprocessableEntity',
      500: 'builtins.ValueError',
    };
    return {
      name: errorName ?? names[status] ?? 'SyntheticError',
      message: 'Synthetic ERP request failed',
      arguments: ['Synthetic detail'],
      ...(options.version === 20 ? { timestamp: Math.floor(Date.now() / 1000) } : {}),
      context: {},
      debug: 'Synthetic diagnostic',
    };
  }

  function execute(record: MockRequest): { status: number; body: unknown; html?: boolean; errorName?: string } {
    if (!record.path.startsWith('/json/2/')) return { status: 404, body: null, html: true };
    if (record.headers['x-odoo-database'] !== undefined && record.headers['x-odoo-database'] !== (options.database ?? 'synthetic')) {
      return { status: 404, body: null, html: true };
    }
    if (
      record.headers.authorization !== `bearer ${options.apiKey ?? 'synthetic-key'}` ||
      (options.version === 20 && options.keyScope === '')
    ) {
      return { status: 401, body: null };
    }
    if (record.method !== 'POST') return { status: 404, body: null };
    if (record.body === null || typeof record.body !== 'object' || Array.isArray(record.body)) return { status: 400, body: null };
    const body = record.body as Record<string, unknown>;
    const fields = body.fields as string[] | undefined;
    const ids = body.ids as number[] | undefined;
    const context = body.context as { location?: number; active_test?: boolean } | undefined;
    const domain = (body.domain ?? []) as unknown[][];
    const project = (items: Record<string, unknown>[]) =>
      items.map((row) => Object.fromEntries(['id', ...(fields ?? [])].map((key) => [key, row[key]])));
    const success = (value: unknown) => ({ status: 200, body: value });
    if (record.path === '/json/2/res.users/context_get') return success({ lang: 'en_US', tz: false, uid });
    if (record.path === '/json/2/res.users/read')
      return success(project(ids?.includes(uid) ? [{ id: uid, company_id: [companyId, 'Synthetic company'] }] : []));
    if (record.path === '/json/2/res.company/read')
      return success(project(ids?.includes(companyId) ? [{ id: companyId, currency_id: [currencyId, 'Synthetic currency label'] }] : []));
    if (record.path === '/json/2/res.currency/read')
      return success(project(ids?.includes(currencyId) ? [{ id: currencyId, name: options.currencyName ?? 'CNY' }] : []));
    if (record.path === '/json/2/stock.location/search_read') {
      const id = domain.find(([field, op]) => field === 'id' && op === '=')?.[2];
      return success(
        locations
          .filter((location) => location === id)
          .slice(0, Number(body.limit ?? 1))
          .map((location) => ({ id: location })),
      );
    }
    if (record.path !== '/json/2/product.product/search_read') return { status: 404, body: null };
    if (ids?.length) return { status: 422, body: null };
    if (fields?.some((field) => !['id', 'default_code', 'uom_id', 'active', 'sale_ok', 'free_qty'].includes(field)))
      return { status: 500, body: null };
    if ('unexpected' in body) return { status: 500, body: null, errorName: 'builtins.TypeError' };
    if (
      (context?.location !== undefined && typeof context.location !== 'number') ||
      (body.limit !== undefined && typeof body.limit !== 'number')
    )
      return { status: 500, body: null };
    if (!Array.isArray(domain) || domain.some((clause) => !Array.isArray(clause) || !['=', '!=', 'in'].includes(clause[1] as string)))
      return { status: 500, body: null };
    let selected = products.filter((product) => !product.deleted && (context?.active_test === false || product.active));
    for (const [field, operator, operand] of domain) {
      selected = selected.filter((product) => {
        const actual = product[field as keyof MockProduct];
        return operator === 'in'
          ? Array.isArray(operand) && operand.includes(actual)
          : operator === '!='
            ? actual !== operand
            : actual === operand;
      });
    }
    selected = selected.toSorted((a, b) => (body.order === 'id desc' ? b.id - a.id : a.id - b.id));
    const offset = Number(body.offset ?? 0);
    selected = selected.slice(offset, offset + Number(body.limit ?? selected.length));
    return success(
      project(
        selected.map((product) => ({
          ...product,
          free_qty:
            context?.location === undefined
              ? Object.values(product.freeQty).reduce<number>((sum, qty) => sum + Number(qty), 0)
              : Object.hasOwn(product.freeQty, context.location)
                ? product.freeQty[context.location]
                : 0,
        })),
      ),
    );
  }

  const server = http.createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let timer: ReturnType<typeof setTimeout> | undefined;
    res.once('close', () => {
      inFlight--;
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    });
    const chunks: Buffer[] = [];
    req.on('error', () => res.destroy());
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        /* 按合成 400 响应处理，不输出正文。 */
      }
      const record: MockRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: { ...req.headers },
        body,
        rawBody,
        at: Date.now(),
      };
      requests.push(record);
      const fault = faults.shift() ?? options.fault?.(record) ?? {};
      if (fault.hang) return;
      const respond = () => {
        // 合成服务也把内部输入形状错误转为 JSON 500，不让测试进程崩溃。
        let result: ReturnType<typeof execute>;
        try {
          result = execute(record);
        } catch {
          result = { status: 500, body: null };
        }
        const status = fault.status ?? result.status;
        const html = fault.html ?? result.html ?? false;
        const responseBody = Object.hasOwn(fault, 'body')
          ? fault.body
          : status >= 400
            ? error(status, fault.errorName ?? result.errorName)
            : result.body;
        res.statusCode = status;
        const mediaType =
          fault.mediaType === undefined ? (html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8') : fault.mediaType;
        if (mediaType !== null) res.setHeader('Content-Type', mediaType);
        res.setHeader('Connection', options.keepAlive ? 'keep-alive' : 'close');
        res.end(fault.rawBody ?? (html ? '<html><body>Synthetic gateway failure</body></html>' : JSON.stringify(responseBody)));
      };
      if (fault.delayMs) {
        timer = setTimeout(respond, fault.delayMs);
        timers.add(timer);
      } else respond();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://erp.example.test:${port}`,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    enqueue(...next: MockFault[]) {
      faults.push(...next);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
    },
  };
}
