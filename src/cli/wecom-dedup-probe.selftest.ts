// 18 R4：虚拟时钟、假企微与真实 PGlite 查询；不连接外部服务、不初始化应用或会话存储。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CHANNEL_KEY_ENV, sealSecrets, type KeyRing } from '../channels/secrets.js';
import { openTestDb } from '../db/testing.js';
import { parseProbeArgs, probePairs, runWecomDedupProbe, type ProbeIo, type ProbeTarget } from './wecom-dedup-probe.js';

const BASE = Date.now();
const target: ProbeTarget = {
  corpId: 'synthetic-corp',
  appSecret: 'synthetic-app-credential',
  openKfid: 'synthetic-kf',
  touser: 'wmprobe',
  redactions: ['synthetic-callback', 'synthetic-aes'],
};
const tokens = ['synthetic-access-a', 'synthetic-access-b'];
const allOutput: string[] = [];
const forbidden = [...Object.values(target).flat(), ...tokens, 'touser', 'open_kfid', 'access_token', 'corpsecret', 'corpid'];

class Clock {
  at = BASE;
  waits: { until: number; finish(): void; cancel(): void }[] = [];
  constructor(readonly drift = 0) {}
  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const remove = () => {
        signal.removeEventListener('abort', wait.cancel);
        this.waits = this.waits.filter((item) => item !== wait);
      };
      const wait = {
        until: this.at + ms,
        finish: () => {
          remove();
          resolve();
        },
        cancel: () => {
          remove();
          reject(new Error('cancelled'));
        },
      };
      this.waits.push(wait);
      signal.addEventListener('abort', wait.cancel, { once: true });
    });
  async run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    let result: T | undefined;
    let failure: unknown;
    void work.then(
      (value) => {
        result = value;
        done = true;
      },
      (error: unknown) => {
        failure = error;
        done = true;
      },
    );
    for (let turn = 0; turn < 10_000; turn++) {
      // 先让当前时刻的 fetch、JSON 与 Promise 链跑完，随后推进下一只计时器。
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (done) {
        if (failure) throw failure;
        assert.equal(this.waits.length, 0, '不能遗留等待中的计时器');
        return result!;
      }
      assert.ok(this.waits.length, '未完成实验必须有可推进的计时器');
      this.at = Math.min(...this.waits.map((wait) => wait.until)) + this.drift;
      for (const wait of this.waits) if (wait.until <= this.at) wait.finish();
    }
    throw new Error('虚拟时钟未能结束实验');
  }
}

type Request = { url: URL; body: string; at: number; signal: AbortSignal };
function fakeIo(clock: Clock, reply?: (request: Request) => Promise<Response> | Response) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  let tokenCalls = 0;
  const io: ProbeIo = {
    now: () => clock.at,
    sleep: clock.sleep,
    stdout: (line) => {
      stdout.push(line);
      allOutput.push(line);
    },
    stderr: (line) => {
      stderr.push(line);
      allOutput.push(line);
    },
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, 'https://qyapi.weixin.qq.com');
      assert.ok(init?.signal, '每次请求都有可中止的截止时限');
      init.signal.throwIfAborted();
      if (parsed.pathname.endsWith('/gettoken')) {
        tokenCalls++;
        assert.equal(parsed.searchParams.get('corpid'), target.corpId);
        assert.equal(parsed.searchParams.get('corpsecret'), target.appSecret);
        return Response.json({ access_token: tokens[Math.min(tokenCalls - 1, 1)] });
      }
      assert.equal(parsed.pathname, '/cgi-bin/kf/send_msg');
      assert.equal(init.method, 'POST');
      assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json');
      const request = { url: parsed, body: String(init.body), at: clock.at, signal: init.signal };
      requests.push(request);
      return reply ? reply(request) : Response.json({ errcode: 0, errmsg: 'ok' });
    },
  };
  return { io, stdout, stderr, requests, tokenCalls: () => tokenCalls };
}

{
  const clock = new Clock(13);
  const fake = fakeIo(clock, async (request) => {
    await clock.sleep(80, request.signal);
    return Response.json({ errcode: 0, errmsg: 'ok' });
  });
  const gaps = [0, 2, 60, 300, 1800];
  assert.equal(await clock.run(probePairs(target, gaps, 5, fake.io)), 0);
  assert.equal(fake.tokenCalls(), 1);
  assert.equal(fake.requests.length, 10);
  const msgids = new Set<string>();
  for (const [index, gap] of gaps.entries()) {
    const matching = fake.requests.filter((request) => JSON.parse(request.body).text.content.includes(`第 ${index + 1} 对`));
    assert.equal(matching.length, 2);
    const [first, second] = matching as [Request, Request];
    assert.equal(first.body, second.body, '同对的两次请求体逐字节相同');
    const body = JSON.parse(first.body);
    assert.match(body.msgid, /^[0-9A-Za-z_-]{1,32}$/);
    const runId = /^去重实测 ([a-f0-9]{16}) /.exec(body.text.content)![1]!;
    assert.ok(body.msgid.includes(runId));
    assert.equal(Buffer.byteLength(body.msgid), body.msgid.length);
    assert.equal(body.touser, target.touser);
    assert.equal(body.open_kfid, target.openKfid);
    assert.equal(body.msgtype, 'text');
    assert.equal(body.text.content, `去重实测 ${runId} 第 ${index + 1} 对（间隔 ${gap} 秒）`);
    msgids.add(body.msgid);
    assert.equal(first.at - BASE, index === 0 ? 0 : index * 5000 + 13, '按 stagger 错开，不等上一对');
    assert.equal(second.at - first.at, gap === 0 ? 93 : gap * 1000 + 13, '按首发请求时刻排期，记录实际漂移');
    const records = fake.stdout.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    const result = records.find((record) => record.pair === index + 1 && record.attempt === 2);
    assert.equal(result.sinceFirstMs, second.at - first.at);
    assert.equal(result.at, new Date(second.at).toISOString());
    assert.equal(result.httpStatus, 200);
    assert.equal(result.errcode, 0);
    const summary = records.find((record) => record.summary && record.pair === index + 1);
    assert.equal(summary.sinceFirstMs, result.sinceFirstMs);
    assert.equal(summary.complete, true);
  }
  assert.equal(msgids.size, gaps.length, '各间隔独立 msgid');
  assert.ok(clock.at - BASE < 1821_000, '各对互不等待，总时长由最长绝对排期决定');
  assert.match(fake.stdout.at(-1)!, /1 条 = 去重，2 条 = 不去重/);
  console.log('PASS 成对请求体、独立 msgid、纯文本、stagger、实际时间差、并发总时长与汇总');
}

{
  const clock = new Clock();
  const fake = fakeIo(clock, () => Response.json({ errcode: 48002, errmsg: 'window closed' }));
  assert.equal(await clock.run(probePairs(target, [0, 2, 1800], 5, fake.io)), 1);
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.stderr, ['先让收件人给客服发口令']);
  assert.equal(clock.at, BASE, '不能等到最长间隔才退出');
  assert.equal(fake.stdout.filter((line) => line.includes('"summary":true')).length, 3);
  console.log('PASS 首发 48002 取消全部未发请求和长等待，退出码 1');
}

{
  const clock = new Clock();
  const fake = fakeIo(clock, async (request) => {
    const firstPair = JSON.parse(request.body).text.content.includes('第 1 对');
    await clock.sleep(firstPair ? 1500 : 30_000, request.signal);
    return Response.json({ errcode: firstPair ? 48002 : 0 });
  });
  assert.equal(await clock.run(probePairs(target, [0, 2, 1800], 1, fake.io)), 1);
  assert.equal(fake.requests.length, 2, '48002 返回之前已发起的并发请求允许存在，之后不再发');
  assert.equal(clock.at - BASE, 1500, '在途请求和尚未首发的配对一起中止');
  assert.ok(fake.requests.every((request) => request.signal.aborted));
  console.log('PASS 延迟 48002 取消在途请求、尚未首发的配对及全部重发');
}

for (const errcode of [40014, 42001]) {
  const clock = new Clock();
  const fake = fakeIo(clock, (request) =>
    Response.json({
      errcode: request.url.searchParams.get('access_token') === tokens[0] ? errcode : 0,
      errmsg: `${request.url.searchParams.get('access_token')} ${Object.values(target).flat().join(' ')} touser open_kfid corpid from ip hidden-address`,
    }),
  );
  assert.equal(await clock.run(probePairs(target, [2, 60], 0, fake.io)), 0);
  assert.equal(fake.tokenCalls(), 2, '并发凭据过期只刷新一次');
  assert.equal(fake.requests.length, 6);
  for (const body of new Set(fake.requests.map((request) => request.body)))
    assert.equal(fake.requests.filter((request) => request.body === body).length, 3, '认证重试也复用原字节');
  assert.ok(fake.stdout.every((line) => !line.includes('hidden-address')));
  console.log(`PASS ${errcode} 并发刷新一次后成功，原请求体与输出脱敏`);
}

{
  const clock = new Clock();
  const fake = fakeIo(clock, async (request) => {
    if (request.url.searchParams.get('access_token') === tokens[0]) {
      await clock.sleep(3000, request.signal);
      return Response.json({ errcode: 40014 });
    }
    return Response.json({ errcode: 0 });
  });
  assert.equal(await clock.run(probePairs(target, [2], 0, fake.io)), 0);
  assert.deepEqual(
    fake.requests.map((request) => request.at - BASE),
    [0, 3000, 5000],
  );
  const summary = JSON.parse(fake.stdout.find((line) => line.includes('"summary":true'))!);
  assert.equal(summary.firstAt, new Date(BASE + 3000).toISOString());
  assert.equal(summary.sinceFirstMs, 2000, '失效凭据请求的耗时不能冒充去重窗口');
  console.log('PASS 首发凭据重试后重新起算间隔，汇总用最终实际请求时刻');
}

{
  const clock = new Clock();
  const fake = fakeIo(clock, () =>
    Response.json({ errcode: 45009, errmsg: `${'字'.repeat(140)} from ip hidden-address` }, { status: 429 }),
  );
  assert.equal(await clock.run(probePairs(target, [0], 0, fake.io)), 0, '其他错误码全部请求发出仍返回 0');
  const record = JSON.parse(fake.stdout[0]!);
  assert.equal(record.httpStatus, 429);
  assert.equal(record.errcode, 45009);
  assert.equal([...record.errmsg].length, 120);
  console.log('PASS HTTP 状态、其他错误码退出 0、errmsg 按字符截断到 120 字');
}

for (const refreshFails of [false, true]) {
  const clock = new Clock();
  const fake = fakeIo(clock, () => Response.json({ errcode: 40014 }));
  const fetch = fake.io.fetch;
  let calls = 0;
  fake.io.fetch = async (url, init) => {
    if (String(url).includes('/gettoken') && ++calls === (refreshFails ? 2 : 1)) throw new Error(tokens[0]);
    return fetch(url, init);
  };
  assert.equal(await clock.run(probePairs(target, [0, 1800], 5, fake.io)), 1);
  assert.equal(fake.requests.length, refreshFails ? 1 : 0);
  assert.equal(clock.at, BASE);
}
console.log('PASS 初取与刷新失败均停止实验、退出 1，异常内容不回显');

{
  const clock = new Clock();
  const fake = fakeIo(clock, () => {
    throw new Error(`${tokens[0]} ${target.appSecret}`);
  });
  assert.equal(await clock.run(probePairs(target, [0], 0, fake.io)), 0);
  assert.equal(fake.requests.length, 2, '网络异常只继续预定的第二次，不额外重发');
  assert.equal(JSON.parse(fake.stdout[0]!).errcode, null);
  assert.equal(JSON.parse(fake.stdout[0]!).httpStatus, null);
  console.log('PASS 网络异常保留未知结果，无额外重发、无异常原文');
}

const key = Buffer.alloc(32, 18);
const ring: KeyRing = { current: { id: 'probe', key }, all: new Map([['probe', key]]) };
const keyEnv = { [CHANNEL_KEY_ENV]: `probe:${key.toString('base64')}` };
const args = ['--tenant', 'probe-test', '--account', 'default', '--match-text', '去重实测', '--gaps', '0'];
assert.deepEqual(parseProbeArgs(args).gaps, [0]);
assert.deepEqual(parseProbeArgs([...args, '--gaps', '60,0,2,2']).gaps, [0, 2, 60]);
assert.deepEqual(parseProbeArgs(args.slice(0, 6)).gaps, [0, 2, 60, 300, 1800]);
assert.equal(parseProbeArgs(args).stagger, 5);
assert.equal(parseProbeArgs([...args, '--stagger', '0']).stagger, 0);
let connects = 0;
const unused = fakeIo(new Clock());
for (const bad of [
  [],
  ['--unknown', target.appSecret],
  args.slice(0, 4),
  [...args, '--match-text', ''],
  ...['', '-1', '1.5', 'NaN', '1e2', '0,,2', '3601', ' 2', '2,', 'Infinity'].map((value) => [...args, '--gaps', value]),
  ...['', '-1', '1.5', 'NaN', '1e2', 'Infinity', '9007199254740992'].map((value) => [...args, '--stagger', value]),
]) {
  assert.equal(
    await runWecomDedupProbe(bad, {
      ...unused.io,
      env: keyEnv,
      connect: async () => {
        connects++;
        throw new Error('不得连接');
      },
    }),
    1,
  );
}
assert.equal(connects, 0, '非法参数在连接数据库之前拒绝');
console.log('PASS --gaps / --stagger 默认、去重排序、非法值与必填参数拒绝码 1');

const t = await openTestDb();
const host = randomUUID();
const other = randomUUID();
const mainAccount = randomUUID();
const secondaryAccount = randomUUID();
const otherAccount = randomUUID();
try {
  for (const [id, slug] of [
    [host, 'probe-test'],
    [other, 'probe-other'],
  ])
    await t.pg.query("insert into tenants(id, slug, name, pack_id) values($1,$2,'合成租户','travel')", [id, slug]);
  for (const [tenantId, id, accountKey, prefix, openKfid] of [
    [host, mainAccount, 'default', 'wecom:', target.openKfid],
    [host, secondaryAccount, 'probe', 'wecom:probe:', 'synthetic-kf-2'],
    [other, otherAccount, 'default', 'wecom:', target.openKfid],
  ]) {
    const sealed = sealSecrets(
      ring,
      { tenantId: tenantId!, accountId: id! },
      {
        appSecret: target.appSecret,
        callbackToken: target.redactions![0]!,
        callbackAesKey: target.redactions![1]!,
      },
    );
    await t.pg.query(
      `insert into channel_accounts(tenant_id,id,key,kind,name,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id)
      values($1,$2,$3,'wecom_kf','合成客服',$4,$5,$6,$7,$8)`,
      [tenantId, id, accountKey, prefix, target.corpId, openKfid, sealed.ct, sealed.keyId],
    );
  }
  const seed = async (
    suffix: string,
    contents: { text: string; at?: number; role?: string }[],
    tenantId = host,
    accountId: string | null = null,
    prefix = 'wecom:',
  ) => {
    await t.pg.exec('RESET ROLE');
    const id = `${prefix}wm${suffix}`;
    await t.pg.query(
      `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at,last_seq,channel_account_id)
      values($1,$2,'wecom','discovery',false,$3,$4,$4,$5,$6)`,
      [tenantId, id, JSON.stringify({ id }), new Date(BASE), contents.length, accountId],
    );
    for (const [index, message] of contents.entries())
      await t.pg.query('insert into messages(tenant_id,conversation_id,seq,role,content,at) values($1,$2,$3,$4,$5,$6)', [
        tenantId,
        id,
        index + 1,
        message.role ?? 'customer',
        message.text,
        new Date(message.at ?? BASE),
      ]);
    await t.pg.exec('SET ROLE agent_app');
  };
  const run = async (text: string, account = 'default', env: Readonly<Record<string, string | undefined>> = keyEnv) => {
    const fake = fakeIo(new Clock());
    let closed = false;
    const fetch = fake.io.fetch;
    fake.io.fetch = async (url, init) => {
      assert.ok(closed, '发送前已结束只读事务并关闭连接');
      return fetch(url, init);
    };
    const code = await runWecomDedupProbe([...args, '--account', account, '--match-text', text], {
      ...fake.io,
      env,
      connect: async () => ({
        db: t.db,
        close: async () => {
          closed = true;
        },
      }),
    });
    assert.ok(closed);
    return { ...fake, code };
  };
  // 同口令出现在另一租户与另一账号，不能被误算进来。
  await seed('other', [{ text: '唯一口令' }], other);
  await seed('second', [{ text: '唯一口令' }], host, secondaryAccount, 'wecom:probe:');
  const none = await run('唯一口令');
  assert.equal(none.code, 1);
  assert.equal(none.requests.length, 0);
  await seed('probe', [{ text: '唯一口令' }, { text: '收到', role: 'agent' }]);
  const one = await run('唯一口令');
  assert.equal(one.code, 0);
  assert.equal(one.requests.length, 2);
  assert.equal(JSON.parse(one.requests[0]!.body).touser, target.touser);
  assert.equal(one.stdout[0], '找到 1 个匹配会话');
  assert.equal((await run('唯一口令', mainAccount)).code, 0, '账号也可按 id 定位');
  assert.equal((await run('唯一口令', 'probe')).code, 0, '非默认账号按 channel_account_id 匹配');
  await seed('probe2', [{ text: '唯一口令' }], host, mainAccount);
  const two = await run('唯一口令');
  assert.equal(two.code, 1);
  assert.equal(two.requests.length, 0);
  for (const [suffix, content, expected] of [
    ['stale', [{ text: '过期口令', at: BASE - 600_001 }], 1],
    ['edge', [{ text: '边界口令', at: BASE - 600_000 }], 0],
    ['future', [{ text: '未来口令', at: BASE + 1 }], 1],
    ['last', [{ text: '旧口令' }, { text: '换一句', at: BASE - 1 }], 1],
    ['space', [{ text: ' 精确口令 ' }], 1],
  ] as const) {
    await seed(suffix, [...content]);
    const result = await run({ stale: '过期口令', edge: '边界口令', future: '未来口令', last: '旧口令', space: '精确口令' }[suffix]);
    assert.equal(result.code, expected);
    if (expected === 1) assert.equal(result.requests.length, 0);
  }
  assert.equal((await run('边界口令', 'default', {})).code, 2, '缺少解密密钥');
  assert.equal(
    (await run('边界口令', 'default', { [CHANNEL_KEY_ENV]: `probe:${Buffer.alloc(32, 19).toString('base64')}` })).code,
    2,
    '错误密钥解密失败',
  );
  assert.equal((await run('边界口令', 'missing')).code, 1);
  const failureIo = fakeIo(new Clock());
  assert.equal(
    await runWecomDedupProbe(args, {
      ...failureIo.io,
      env: keyEnv,
      connect: async () => {
        throw new Error(`${target.appSecret} ${target.corpId}`);
      },
    }),
    2,
  );
  // 探针不写会话、消息、cursor、账本或入站行：角色切回属主核全部合成记录。
  await t.pg.exec('RESET ROLE');
  assert.equal((await t.pg.query<{ n: number }>('select count(*)::int n from outbound_sends')).rows[0]!.n, 0);
  assert.equal((await t.pg.query<{ n: number }>('select count(*)::int n from channel_inbox')).rows[0]!.n, 0);
  assert.equal((await t.pg.query<{ n: number }>('select count(*)::int n from channel_accounts where cursor is not null')).rows[0]!.n, 0);
  assert.equal((await t.pg.query<{ n: number }>("select count(*)::int n from messages where content = '收到'")).rows[0]!.n, 1);
  console.log('PASS PGlite：0/1/2 会话、10 分钟边界、最后客户消息、精确口令、默认 NULL 账号、按 id/key、租户与账号隔离');
  console.log('PASS 数据库/解密失败退出 2，发送前关库，不产生入站、出站或 cursor 写入');
} finally {
  await t.close();
}

for (const [index, line] of allOutput.entries())
  for (const [item, value] of forbidden.entries())
    assert.ok(!line.includes(value), `stdout + stderr 不得含凭据、标识或敏感字段（行 ${index}、项 ${item}）`);
console.log('PASS stdout + stderr 全路径脱敏（含企微回显、网络异常、错误参数、数据库与解密错误）');
console.log('wecom-dedup-probe selftest: PASS');
