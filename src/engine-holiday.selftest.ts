// 节日正在放假时的顺口一问（docs/issues/holiday-in-progress/spec.md）：10月2号客户先说「10月3号出发」，再问
// 「国庆期间景区人多吗」。此前这句问话里的国庆只读成明年的国庆，和 10月3号不在同一个月，就冲掉了客户说过的日子，
// 下单被驳回去再问哪天。只在国庆、五一、春节这些假期放到一半的那几天出现，所以「今天」全部钉死，哪天跑结果都一样。
// 数据写进临时目录（VAR_DIR 覆盖），模型是本机假服务，全程不出本机。
// 用法：npx tsx src/engine-holiday.selftest.ts
import './selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import type { AddressInfo } from 'node:net';

// ---------- 钉住时钟 ----------
// 引擎的「今天」都出自 env.ts 的 todayIso()（new Date() 的本地日期）。只读一句话的函数照 dejargon、engine 自测的做法
// 直接传 today；整段对话（报价→顺口一问→下单）一路上各处现取 todayIso()，只能把全局 Date 换成从钉住那天起走的钟
const RealDate = Date;
let offset = 0;
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [string]));
  }
  static override now(): number {
    return RealDate.now() + offset;
  }
}
globalThis.Date = PinnedDate as DateConstructor;
/** 把「今天」钉成 iso 那天的本地正午（todayIso 按本地时区取日期，正午离两头都远），钟照常往前走 */
const pinToday = (iso: string): void => {
  const [y, m, d] = iso.split('-').map(Number);
  offset = new RealDate(y, m - 1, d, 12).getTime() - RealDate.now();
};
pinToday('2026-10-02');

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const varDir = fs.mkdtempSync(path.join(varParent, 'wecom-holiday-selftest-'));
process.env.VAR_DIR = varDir;

// ---------- 本机假模型服务（OpenAI 兼容）：每次请求从脚本队列取一步 ----------
interface Step {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}
const script: Step[] = [];
let scriptOverrun = 0;
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      const data = (body.input ?? []).map(() => ({ embedding: Array.from({ length: 32 }, () => 1) }));
      res.end(JSON.stringify({ data, usage: { prompt_tokens: 0 } }));
      return;
    }
    const step = script.shift();
    if (!step) scriptOverrun += 1;
    const message = step?.toolCalls
      ? {
          role: 'assistant',
          content: null,
          tool_calls: step.toolCalls.map((c, i) => ({
            id: `call_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }
      : { role: 'assistant', content: step?.content ?? '（假模型脚本已耗尽）' };
    res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
// 必须在 import 引擎之前设好，本机 .env 里的真实配置一个都进不来（同 engine.selftest.ts）
process.env.LLM_MOCK = '0';
process.env.LLM_PROVIDER = '';
process.env.LLM_BASE_URL = fakeUrl;
process.env.LLM_API_KEY = 'selftest-fake-key';
process.env.LLM_MODEL = 'selftest-fake';
process.env.EMBED_BASE_URL = fakeUrl;
process.env.EMBED_API_KEY = 'selftest-fake-key';
process.env.LLM_HEDGE_MODEL = '';
process.env.LLM_MAX_RETRY = '0';
process.env.SOP_PATH = path.join(process.cwd(), 'data', 'sop.md');

const { handleMessage, __engineTest } = await import('./engine.js');
const { getOrder, getSession } = await import('./store.js');
const { llmCfg } = await import('./llm.js');
const { todayIso } = await import('./env.js');
assert.ok(llmCfg().baseUrl.startsWith('http://127.0.0.1:'), '自测只能打本机假模型服务');
assert.equal(todayIso(), '2026-10-02', '时钟要钉得住');

const fails: string[] = [];
const check = (ok: boolean, name: string, got: unknown): void => {
  if (!ok) fails.push(`${name}（实际：${typeof got === 'string' ? got : JSON.stringify(got)}）`);
};

// ---------- 一串客户原话读出来的出发日期 ----------
// 写法同 dejargon 自测：具体哪天照写，按节日推的带「~」，用不了的日子是 invalid
const { latestDepart, spokenDepartDate } = __engineTest;
const depart = (said: string[], today: string): string => {
  const p = latestDepart(said, today)?.pick;
  return !p ? 'none' : p.kind === 'vague' ? 'vague' : `${p.iso ?? 'invalid'}${p.exact ? '' : '~'}`;
};
const ask = '国庆期间景区人多吗';
const cases: [string, string[], string, string][] = [
  // 国庆放到一半（10月1日至7日）：问的就是眼下这个国庆，客户早先说的那天照用
  ['国庆第二天', ['10月3号出发，丽江大理两个人报个价', ask], '2026-10-02', '2026-10-03'],
  ['国庆第三天、说的就是今天', ['10月3号出发，丽江大理两个人报个价', ask], '2026-10-03', '2026-10-03'],
  ['国庆最后一天', ['10月7号出发，丽江大理两个人报个价', ask], '2026-10-07', '2026-10-07'],
  ['国庆最后一天、节后出发', ['10月9号出发，两个人报个价', ask], '2026-10-07', '2026-10-09'],
  ['十一期间', ['10月5号出发，两个人报个价', '十一期间人多不多'], '2026-10-02', '2026-10-05'],
  // 明年的日子照旧认（国庆读成明年那次本来就对得上）；别的月份的日子不认
  ['国庆中说的明年那天', ['明年10月5号出发，两个人报个价', ask], '2026-10-02', '2027-10-05'],
  ['国庆中连着问了两句', ['明年10月5号出发，两个人报个价', ask, `明年${ask}`], '2026-10-02', '2027-10-05'],
  ['国庆中说的 11 月', ['11月3号出发，两个人报个价', ask], '2026-10-02', '2027-10-01~'],
  // 写明年份的照字面：明年国庆不是眼下这次；今年国庆就是眼下这次
  ['国庆中问明年国庆', ['10月3号出发，两个人报个价', `明年${ask}`], '2026-10-02', '2027-10-01~'],
  ['国庆中问今年国庆', ['10月3号出发，两个人报个价', `今年${ask}`], '2026-10-02', '2026-10-03'],
  ['国庆中问 2026 年国庆', ['10月3号出发，两个人报个价', `2026年${ask}`], '2026-10-02', '2026-10-03'],
  // 放完了（10月8号）：国庆就是明年那次，和这个月的日子不是一回事
  ['国庆放完第二天', ['10月9号出发，两个人报个价', ask], '2026-10-08', '2027-10-01~'],
  ['国庆放完、说的明年那天', ['明年10月3号出发，两个人报个价', ask], '2026-10-08', '2027-10-03'],
  // 五一（5月1日至5日）
  ['五一第三天', ['5月4号出发，两个人报个价', '五一期间人多吗'], '2027-05-03', '2027-05-04'],
  ['五一最后一天', ['5月5号出发，两个人报个价', '劳动节期间人多吗'], '2027-05-05', '2027-05-05'],
  ['五一放完', ['5月8号出发，两个人报个价', '五一期间人多吗'], '2027-05-06', '2028-05-01~'],
  // 春节按农历表（2027 年初一是 2 月 6 日，放到初七 2 月 12 日）
  ['春节初三', ['2月10号出发，两个人报个价', '春节期间景区人多吗'], '2027-02-08', '2027-02-10'],
  ['春节初七', ['2月12号出发，两个人报个价', '春节期间景区人多吗'], '2027-02-12', '2027-02-12'],
  ['春节放完', ['2月15号出发，两个人报个价', '春节期间景区人多吗'], '2027-02-13', '2028-01-26~'],
  // 跨月的那次（2028 年初一 1月26日，放到 2月1日）：1 月里问春节，剩下的假期跨到 2 月，两个月的日子都认
  ['跨月春节的最后一天', ['2月2号出发，两个人报个价', '今年春节期间景区人多吗'], '2028-02-01', '2028-02-02'],
  ['跨月春节的初一', ['2月1号出发，两个人报个价', '春节期间景区人多吗'], '2028-01-26', '2028-02-01'],
  ['跨月春节、1 月里问', ['2月1号出发，两个人报个价', '今年春节期间景区人多吗'], '2028-01-28', '2028-02-01'],
  ['跨月春节、1 月里问、没说哪年', ['2月1号出发，两个人报个价', '春节期间景区人多吗'], '2028-01-28', '2028-02-01'],
  // 农历表里最后一次（2028 年）放到节日之后：下一次不在表里，问句读成说不准哪天，眼下这次照样在放
  ['表里最后一次春节、没说哪年', ['1月30号出发，两个人报个价', '春节期间景区人多吗'], '2028-01-28', '2028-01-30'],
  ['表里最后一次春节的最后一天', ['2月2号出发，两个人报个价', '春节期间景区人多吗'], '2028-02-01', '2028-02-02'],
  ['表里最后一次端午', ['5月30号出发，两个人报个价', '端午期间人多吗'], '2028-05-29', '2028-05-30'],
  ['表里最后一次中秋', ['10月5号出发，两个人报个价', '中秋期间人多吗'], '2028-10-04', '2028-10-05'],
  ['表里最后一次春节放完', ['2月5号出发，两个人报个价', '春节期间景区人多吗'], '2028-02-02', 'vague'],
  // 元旦（1月1日至3日）
  ['元旦第三天', ['1月3号出发，两个人报个价', '元旦期间人多吗'], '2027-01-03', '2027-01-03'],
  ['元旦放完', ['1月5号出发，两个人报个价', '元旦期间人多吗'], '2027-01-04', '2028-01-01~'],
  // 端午、中秋按农历表，从节日那天起三天（2027 年端午 6 月 9 日，2026 年中秋 9 月 25 日）
  ['端午第三天', ['6月12号出发，两个人报个价', '端午期间人多吗'], '2027-06-11', '2027-06-12'],
  ['端午放完', ['6月15号出发，两个人报个价', '端午期间人多吗'], '2027-06-12', '2028-05-28~'],
  ['中秋第三天', ['9月27号出发，两个人报个价', '中秋期间人多吗'], '2026-09-27', '2026-09-27'],
  ['中秋放完', ['9月29号出发，两个人报个价', '中秋期间人多吗'], '2026-09-28', '2027-09-15~'],
  // 只说到月份的顺口一问照旧（W7c 那种），月份也按传进来的今天读：1月5号问「2月冷不冷」是今年 2 月
  ['只说月份的问句', ['2月10号出发，两个人报个价', '2月冷不冷'], '2026-01-05', '2026-02-10'],
];
for (const [name, said, today, want] of cases) {
  const got = depart(said, today);
  check(got === want, `${name}（${today}）「${said.join('」→「')}」读作 ${want}`, got);
}
// 出发的说法不受影响：国庆放完那天说「国庆出发」就是明年的国庆，没有「眼下这次」
const after = spokenDepartDate('国庆出发', '2026-10-08');
check(
  after?.kind === 'date' && after.iso === '2027-10-01' && !after.exact && after.ongoing === undefined,
  '10月8号说「国庆出发」是明年的国庆',
  after,
);
// 报价的读法也不受影响：表里没有下一次春节，眼下这次放到一半时说「春节」照旧是说不准哪天，不拿去报价
const lastNewYear = spokenDepartDate('春节出发', '2028-01-28');
check(lastNewYear?.kind === 'vague', '2028年1月28号说「春节出发」仍是说不准哪天', lastNewYear);

// ---------- W7 整段对话：报价 → 顺口一问 → 下单（模型调的、安全网兜的都一样） ----------
let seq = 0;
const newSid = (tag: string): string => `wecom:selftest-holiday-${tag}-${++seq}`;
const fakeSay = async (sid: string, text: string, steps: Step[]) => {
  script.push(...steps);
  const r = await handleMessage(sid, text, 'wecom');
  assert.equal(script.length, 0, `「${text}」这轮应恰好用完脚本（剩 ${script.length} 步）`);
  return r;
};
// [今天, 客户说的那天, 原话里的说法, 顺口一问]
const talks: [string, string, string, string][] = [
  ['2026-10-02', '2026-10-03', '10月3号', ask],
  ['2026-10-03', '2026-10-03', '10月3号', ask],
  // 农历表里最后一次春节放到一半（下一次不在表里），和跨到 2 月的那几天
  ['2028-01-28', '2028-01-30', '1月30号', '春节期间景区人多吗'],
  ['2028-01-28', '2028-02-01', '2月1号', '今年春节期间景区人多吗'],
];
for (const [today, day, said, aside] of talks) {
  pinToday(today);
  const orderSteps: [string, Step[]][] = [
    [
      '模型下单',
      [{ toolCalls: [{ name: 'create_order', args: { routeId: 'r-yunnan-mid', travelers: 2, departDate: day } }] }, { content: '好的' }],
    ],
    ['安全网', [{ content: '好的～' }]],
  ];
  for (const [how, steps] of orderSteps) {
    const sid = newSid(today.slice(5));
    await fakeSay(sid, `${said}出发，丽江大理两个人报个价`, [
      { toolCalls: [{ name: 'create_quote', args: { routeId: 'r-yunnan-mid', travelers: 2, departDate: day } }] },
      { content: '丽江大理这条报价给您出好了。' },
    ]);
    await fakeSay(sid, aside, [{ content: '假期人会多一些，这条线会错峰安排。' }]);
    const r = await fakeSay(sid, how === '安全网' ? '行，就订这个' : '行，订吧', steps);
    const order = getOrder(r.orderId ?? '');
    check(
      order?.departDate === day && getSession(sid)!.orderIds.length === 1,
      `W7 ${today} 顺口问「${aside}」不冲掉客户说的 ${said}（${how}）`,
      order ?? r.text,
    );
  }
}

assert.equal(scriptOverrun, 0, '假模型被多调了（脚本耗尽后仍有请求）');
fake.close();
assert.equal(fails.length, 0, `节日放假中的顺口一问 ${fails.length} 条未通过：\n  ✗ ${fails.join('\n  ✗ ')}`);
fs.rmSync(varDir, { recursive: true, force: true });
console.log(
  'SELFTEST PASS: 节日放假中的顺口一问（国庆 · 五一 · 元旦 · 春节 · 端午 · 中秋放到最后一天认眼下这次 / 放完认下一次 / 农历表最后一次与跨月的春节 / 写明年份照字面 / W7 报价→顺口一问→下单）',
);
