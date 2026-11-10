// 18 R4 / 第 9.1 步：只读库后直接请求企微；与 app、app-standby 同时运行，不取锁、不经发送账本、不读写 var/。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { accountFromRow, openAccountSecrets } from '../channels/accounts.js';
import { keyRingFromEnv } from '../channels/secrets.js';
import { openDb, withTenant, type Db } from '../db/client.js';
import { listChannelAccounts } from '../db/repo/channel-accounts.js';
import { readProbeRecipientMatches } from '../db/repo/messages.js';
import { findTenantBySlug } from '../db/repo/tenants.js';

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const USAGE = 'wecom-dedup-probe --tenant <slug> --account <key 或 id> --match-text <口令> [--gaps 0,2,60,300,1800] [--stagger 5]';

class ProbeError extends Error {
  constructor(
    readonly code: 1 | 2,
    message: string,
  ) {
    super(message);
  }
}

function integer(value: string, option: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    throw new ProbeError(1, `${option} 须为非负整数${max === 3600 ? '，且不超过 3600 秒' : ''}`);
  return Number(value);
}

export function parseProbeArgs(argv: string[]) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        tenant: { type: 'string' },
        account: { type: 'string' },
        'match-text': { type: 'string' },
        gaps: { type: 'string', default: '0,2,60,300,1800' },
        stagger: { type: 'string', default: '5' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    // parseArgs 异常可能含误传的凭据，不回显。
    throw new ProbeError(1, `参数无效；用法：${USAGE}`);
  }
  if (!values.tenant?.trim() || !values.account?.trim() || !values['match-text']?.trim())
    throw new ProbeError(1, `缺少租户、账号或口令；用法：${USAGE}`);
  const gaps = [...new Set(values.gaps!.split(',').map((value) => integer(value, '--gaps', 3600)))].toSorted((a, b) => a - b);
  const stagger = integer(values.stagger!, '--stagger');
  // 每对的绝对排期必须能被毫秒时钟精确表示。
  if (!Number.isSafeInteger((gaps.length - 1) * stagger * 1000 + 3600_000)) throw new ProbeError(1, '--stagger 排期过长');
  return { tenant: values.tenant, account: values.account, matchText: values['match-text'], gaps, stagger };
}

export interface ProbeIo {
  fetch: typeof globalThis.fetch;
  now(): number;
  /** 必须在 signal 中止时取消等待；生产用 timers/promises，自测用虚拟时钟。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface ProbeTarget {
  corpId: string;
  appSecret: string;
  openKfid: string;
  touser: string;
  /** 另外两项解密凭据也参与回包脱敏，仅保留在内存。 */
  redactions?: string[];
}

interface SendResult {
  pair: number;
  gapSec: number;
  attempt: 1 | 2;
  at: string;
  sinceFirstMs: number;
  httpStatus: number | null;
  errcode: number | null;
  errmsg: string;
}

/** 网络异常不推断是否送达，不自动重发；只有明确的 token 失效会刷新一次并重试原请求体。 */
export async function probePairs(target: ProbeTarget, gaps: number[], stagger: number, io: ProbeIo): Promise<0 | 1> {
  const stop = new AbortController();
  let failure = false;
  const sensitive = [target.corpId, target.appSecret, target.openKfid, target.touser, ...(target.redactions ?? [])];
  const safeMessage = (message: string): string => {
    let safe = message.split(/from ip\b/i)[0]!;
    for (const value of [...sensitive, 'access_token', 'corpsecret', 'touser', 'open_kfid', 'corpid']) {
      if (value) {
        safe = safe.replaceAll(value, '[已遮盖]');
        safe = safe.replaceAll(encodeURIComponent(value), '[已遮盖]');
      }
    }
    return [...safe.trim()].slice(0, 120).join('');
  };
  const halt = (message: string): void => {
    if (!failure) io.stderr(message);
    failure = true;
    stop.abort();
  };
  const getToken = async (): Promise<string> => {
    try {
      const response = await io.fetch(
        `${API_BASE}/gettoken?corpid=${encodeURIComponent(target.corpId)}&corpsecret=${encodeURIComponent(target.appSecret)}`,
        { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]) },
      );
      const data = (await response.json()) as { errcode?: number; access_token?: unknown };
      if (!response.ok || data.errcode || typeof data.access_token !== 'string' || !data.access_token) throw new Error();
      sensitive.push(data.access_token);
      return data.access_token;
    } catch {
      throw new ProbeError(1, '取企微凭据失败；请检查账号凭据或网络');
    }
  };
  let token: string;
  try {
    token = await getToken();
  } catch {
    io.stderr('取企微凭据失败；请检查账号凭据或网络');
    return 1;
  }
  let refresh: Promise<string> | undefined;
  const runId = randomBytes(8).toString('hex');
  const started = io.now();
  const pairs = gaps.map((gapSec, index) => ({ pair: index + 1, gapSec, records: [] as SendResult[], firstAt: null as number | null }));

  const send = async (pair: (typeof pairs)[number], attempt: 1 | 2, body: string): Promise<void> => {
    for (let retry = 0; retry < 2 && !stop.signal.aborted; retry++) {
      const at = io.now();
      // 失效凭据的首发没有进入投递：刷新后的首发重新起算，不能把等凭据的时间冒充去重窗口。
      if (attempt === 1) pair.firstAt = at;
      const record: SendResult = {
        pair: pair.pair,
        gapSec: pair.gapSec,
        attempt,
        at: new Date(at).toISOString(),
        sinceFirstMs: at - pair.firstAt!,
        httpStatus: null,
        errcode: null,
        errmsg: '',
      };
      try {
        const response = await io.fetch(`${API_BASE}/kf/send_msg?access_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
        });
        record.httpStatus = response.status;
        const data = (await response.json()) as { errcode?: unknown; errmsg?: unknown };
        record.errcode = typeof data.errcode === 'number' ? data.errcode : null;
        record.errmsg = typeof data.errmsg === 'string' ? safeMessage(data.errmsg) : '';
      } catch {
        record.errmsg = stop.signal.aborted ? '请求已取消，送达情况请查看手机' : '请求失败或响应无效，送达情况请查看手机';
      }
      pair.records.push(record);
      io.stdout(JSON.stringify(record));
      if (attempt === 1 && record.errcode === 48002) halt('先让收件人给客服发口令');
      if (retry === 0 && (record.errcode === 40014 || record.errcode === 42001) && !stop.signal.aborted) {
        try {
          // 并发的旧凭据请求只触发一次刷新，整个实验最多重取一次。
          refresh ??= getToken();
          token = await refresh;
          continue;
        } catch {
          halt('取企微凭据失败；请检查账号凭据或网络');
        }
      }
      return;
    }
  };
  const waitUntil = async (deadline: number): Promise<void> => {
    while (!stop.signal.aborted && io.now() < deadline) await io.sleep(deadline - io.now(), stop.signal);
  };
  await Promise.all(
    pairs.map(async (pair, index) => {
      try {
        await waitUntil(started + index * stagger * 1000);
        if (stop.signal.aborted) return;
        // 只序列化一次，重发与刷新后的重试都逐字节使用原 body。
        const body = JSON.stringify({
          touser: target.touser,
          open_kfid: target.openKfid,
          msgid: `wdp_${runId}_${pair.pair}`,
          msgtype: 'text',
          text: { content: `去重实测 ${runId} 第 ${pair.pair} 对（间隔 ${pair.gapSec} 秒）` },
        });
        await send(pair, 1, body);
        if (stop.signal.aborted) return;
        await waitUntil(pair.firstAt! + pair.gapSec * 1000);
        if (!stop.signal.aborted) await send(pair, 2, body);
      } catch {
        if (!stop.signal.aborted) halt('实验计时失败，已停止未发请求');
      }
    }),
  );
  for (const pair of pairs) {
    const first = pair.records.findLast((record) => record.attempt === 1);
    const second = pair.records.findLast((record) => record.attempt === 2);
    io.stdout(
      JSON.stringify({
        summary: true,
        pair: pair.pair,
        gapSec: pair.gapSec,
        firstAt: first?.at ?? null,
        secondAt: second?.at ?? null,
        sinceFirstMs: second?.sinceFirstMs ?? null,
        errcodes: pair.records.map((record) => record.errcode),
        complete: !!second,
      }),
    );
  }
  io.stdout(`请在手机上数每一对出现几条：1 条 = 去重，2 条 = 不去重；接口返回不代表送达${failure ? '，本次实验已提前停止' : ''}。`);
  return failure ? 1 : 0;
}

export interface ProbeDeps extends ProbeIo {
  env: Readonly<Record<string, string | undefined>>;
  connect(): Promise<{ db: Db; close(): Promise<void> }>;
}

export async function runWecomDedupProbe(argv: string[], deps: ProbeDeps): Promise<number> {
  try {
    const options = parseProbeArgs(argv);
    const connection = await deps.connect();
    let target: ProbeTarget;
    try {
      const tenant = await findTenantBySlug(connection.db, options.tenant);
      if (!tenant) throw new ProbeError(1, '租户不存在');
      target = await withTenant(
        connection.db,
        {
          tenantId: tenant.id,
          actor: { kind: 'system', userId: null, name: 'wecom-dedup-probe', ip: null },
        },
        async (tx) => {
          const row = (await listChannelAccounts(tx)).find((account) => account.key === options.account || account.id === options.account);
          if (!row || row.kind !== 'wecom_kf' || row.status !== 'active') throw new ProbeError(1, '未找到启用的企微客服账号');
          const account = accountFromRow(tenant.id, row, { webChannel: false });
          const w = account.wecom!;
          if (!w.corpId || !w.openKfId || !w.idPrefix) throw new ProbeError(2, '账号数据不完整');
          const matches = await readProbeRecipientMatches(tx, row.id, w.idPrefix === 'wecom:', options.matchText, new Date(deps.now()));
          if (matches.length !== 1)
            throw new ProbeError(1, matches.length === 0 ? '没有匹配会话；先让收件人给客服发口令' : '匹配会话多于 1 个，拒绝发送');
          const id = matches[0]!;
          if (!id.startsWith(w.idPrefix) || id.length === w.idPrefix.length) throw new ProbeError(2, '会话与账号前缀不一致');
          const ring = keyRingFromEnv(deps.env);
          if (!ring) throw new ProbeError(2, '未配置渠道解密密钥');
          const secrets = openAccountSecrets(ring, tenant.id, row).reveal();
          return {
            corpId: w.corpId,
            openKfid: w.openKfId,
            appSecret: secrets.appSecret,
            touser: id.slice(w.idPrefix.length),
            redactions: [secrets.callbackToken, secrets.callbackAesKey],
          };
        },
        { readOnly: true, isolation: 'repeatable read' },
      );
    } finally {
      // 半小时的实验不持有数据库连接或事务。
      await connection.close();
    }
    deps.stdout('找到 1 个匹配会话');
    return await probePairs(target, options.gaps, options.stagger, deps);
  } catch (error) {
    // 不输出驱动错误、SQL 参数、URL、解密异常或用户原始参数。
    deps.stderr(error instanceof ProbeError ? error.message : '数据库读取或凭据解密失败');
    return error instanceof ProbeError ? error.code : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWecomDedupProbe(process.argv.slice(2), {
    env: process.env,
    now: Date.now,
    fetch: globalThis.fetch,
    sleep: (ms, signal) => sleep(Math.min(ms, 2_147_483_647), undefined, { signal }),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    connect: async () => {
      // common.ts 的 dbFromEnv 会输出驱动异常并以 1 退出，这里需固定安全提示与退出码 2。
      if (!process.env.DATABASE_URL) throw new ProbeError(2, '缺少 DATABASE_URL（agent_app 身份）');
      return openDb(process.env.DATABASE_URL, { max: 1 });
    },
  });
}
