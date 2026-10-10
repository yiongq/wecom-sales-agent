// 03 第 5 步：开关、三渠道话术与前缀回归。假模型拦截 fetch，不监听端口、不连接外部服务。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Session } from '../types.js';

const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-copy-selftest-'));
process.env.VAR_DIR = varDir;
process.env.CONFIG_SOURCE = 'file';
process.env.PARITY_CLOCK_MS = '1790913600000';
await import('../store/parity-clock.js');
process.env.SOP_PATH = path.resolve('data/sop.md');
process.env.ROUTES_PATH = path.resolve('data/routes.json');
process.env.LLM_MOCK = '0'; // 走真实请求拼装，fetch 只返回下面的假模型脚本。
process.env.LLM_PROVIDER = '';
process.env.LLM_BASE_URL = 'http://127.0.0.1/web-selftest';
process.env.LLM_API_KEY = 'selftest-fake-key';
process.env.LLM_MODEL = 'selftest-fake';
process.env.EMBED_BASE_URL = process.env.LLM_BASE_URL;
process.env.EMBED_API_KEY = 'selftest-fake-key';
process.env.LLM_HEDGE_MODEL = '';
process.env.LLM_MAX_RETRY = '0';
process.env.PRICE_GUARD = '1';
for (const k of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID', 'FOLLOWUP_ENABLED']) process.env[k] = '';

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface WireBody {
  messages: WireMessage[];
  tools?: unknown;
}
interface Step {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}
interface Transcript {
  context: string[];
  tools: string[];
  reply: string;
}
const script: Step[] = [];
const requests: WireBody[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  assert.ok(url.startsWith('http://127.0.0.1/web-selftest/'), `禁止网络请求：${url}`);
  const body = JSON.parse(String(init?.body)) as WireBody & { input: string[] };
  if (url.endsWith('/embeddings')) {
    return Response.json({ data: body.input.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 0 } });
  }
  assert.ok(url.endsWith('/chat/completions'));
  requests.push(body);
  const step = script.shift();
  assert.ok(step, '假模型脚本不能耗尽');
  const message = step.toolCalls
    ? {
        role: 'assistant',
        content: null,
        tool_calls: step.toolCalls.map((c, i) => ({
          id: `call_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }
    : { role: 'assistant', content: step.content };
  return Response.json({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
};
process.on('exit', () => fs.rmSync(varDir, { recursive: true, force: true }));

const { handleMessage, promptPrefix, guardOutbound } = await import('../engine.js');
const store = await import('../store.js');
const { dropUnbackedClaims } = await import('../price-rules.js');
const { resolveProfile, capFlags, BASELINE_FLAG_NAMES, PROFILE_ENV_NAMES, ProfileConfigError, __profileTest } =
  await import('../profile.js');
const { channelCustomerLabel } = await import('../shared/conversation.js');
const WEB_NOTE = '客户正在网页上咨询，不在微信里；说到顾问跟进时，请说顾问会在这个页面里回复您，不要说在微信上联系。';
const SYSTEM_SHA = 'dd2c10ee4d4205c1938f7ebdd3a4258490828a146a30c9931c33e35872ffdd60';
const TOOLS_SHA = '64c16fc8f464d5757f02411b7f8a2a6ce6f43da63416283851a6e997819692d1';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
// 下面是开工提交 5b697c2 的原文；仅随机订单凭据替换成 <ORDER>，其余字节原样保留。
const BASELINE: Record<string, Transcript> = {
  greeting: {
    context: ['【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}'],
    tools: [],
    reply: '您好，这次想去哪儿玩？',
  },
  'safety-new': {
    context: [
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: quote\n客户画像: {}\n最近报价: r-yunnan-mid《云南丽江大理 6 日舒适之旅》2 人，2026-12-10 出发',
    ],
    tools: [],
    reply:
      '好的，订单已生成～\n《云南丽江大理 6 日舒适之旅》2 位出行、12月10日出发，总价 ¥33,600。\n订单链接：/pay/<ORDER>\n顾问会在微信里跟您核对价格并发收款方式，不用点链接付款。',
  },
  'safety-existing': {
    context: [
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: quote\n客户画像: {}\n最近报价: r-yunnan-mid《云南丽江大理 6 日舒适之旅》2 人，2026-12-10 出发',
    ],
    tools: [],
    reply:
      '您这单已经建好啦～《云南丽江大理 6 日舒适之旅》2 位出行、12月10日出发，总价 ¥25,600。\n订单链接：/pay/<ORDER>\n顾问会在微信里跟您核对价格并发收款方式，想改人数或日期的话跟我说一声，我重新为您安排～',
  },
  resend: {
    context: [],
    tools: [],
    reply:
      '好的，订单链接给您重新发一次：\n/pay/<ORDER>\n《云南丽江大理 6 日舒适之旅》2 位、12月10日出发，合计 ¥25,600。顾问会在微信里跟您核对价格并发收款方式。',
  },
  'resend-confirmed': {
    context: [],
    tools: [],
    reply:
      '好的，订单链接给您重新发一次：\n/pay/<ORDER>\n《云南丽江大理 6 日舒适之旅》2 位、12月10日出发，合计 ¥25,600。请按顾问发的方式付款。',
  },
  'handoff-order': {
    context: [],
    tools: [],
    reply:
      '好的，马上为您转接资深顾问，请稍候～\n您刚下的《云南丽江大理 6 日舒适之旅》订单顾问会一并跟进，之前发您的订单链接仍然有效，顾问会在微信里核对价格、发收款方式。',
  },
  'tool-order-stranded': {
    context: [
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: quote\n客户画像: {}\n最近报价: r-yunnan-mid《云南丽江大理 6 日舒适之旅》2 人，2026-12-10 出发',
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: quote\n客户画像: {}\n最近报价: r-yunnan-mid《云南丽江大理 6 日舒适之旅》2 人，2026-12-10 出发',
    ],
    tools: [
      '{"orderId":"<ORDER>","payUrl":"/pay/<ORDER>","total":33600,"departDate":"2026-12-10","note":"12月不在最佳季，不上浮","payNote":"这是订单确认链接：顾问会在微信里跟客户核对价格并发收款方式，不要说点链接付款。"}',
    ],
    reply: '订单已生成，总价 ¥33,600。\n订单链接：/pay/<ORDER>\n顾问会在微信里跟您核对价格并发收款方式，不用点链接付款。',
  },
  'tool-order-reused': {
    context: [
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: closing\n客户画像: {"destinationInterest":"云南","travelers":"2人","dates":"2026-12-10"}',
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: closing\n客户画像: {"destinationInterest":"云南","travelers":"2人","dates":"2026-12-10"}',
    ],
    tools: [
      '{"orderId":"<ORDER>","payUrl":"/pay/<ORDER>","total":33600,"departDate":"2026-12-10","reused":true,"note":"这是本会话已有的那张订单（2 位 / 2026-12-10 出发），不是新建的。不要说成刚下了一单，更不要说成是给别人的订单；客户要给别人另订一份，这张单替代不了，先问清是合并成一单还是请顾问单独下。","payNote":"这是订单确认链接：顾问会在微信里跟客户核对价格并发收款方式，不要说点链接付款。"}',
    ],
    reply: '好的，订单信息已经核对。\n/pay/<ORDER>',
  },
  'price-handed-over': {
    context: [
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}',
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}',
    ],
    tools: [
      '{"ok":true,"reason":"客户需要人工协助核准价格","note":"已转人工：这是你给这位客户的最后一条回复，之后由资深顾问接手，你不会再回复他。这条只安抚一句、说明顾问会尽快联系，不要再推荐线路或报价，也不要说「随时告诉我 / 随时找我 / 我马上帮您查」这类之后兑现不了的话。客户要的地方我们没有现成线路时，只说顾问会联系评估，不要替顾问承诺能去、能安排或能定制原目的地（不说「帮您落实冰岛行程」「为您定制冰岛之旅」）。"}',
    ],
    reply: '具体价格由资深顾问为您核准，已为您转接，顾问会在微信上联系您，请稍候～',
  },
  'transfer-patched': {
    context: ['【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}'],
    tools: [],
    reply: '这个我记下了，会请顾问在微信上跟您确认。',
  },
  'transfer-declined': {
    context: [
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}',
      '【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}',
    ],
    tools: [
      '{"error":"这次没有转人工：客户这句没有要找真人，也没有坚持只要我们没有的那个目的地（没说「就要去」「别的不考虑」）。继续回答客户这句话——问什么答什么，接着推荐最接近的现成线路、报价或问出行信息。回复里不要说「为您转接」「顾问会联系您」。"}',
    ],
    reply: '收到～想去哪儿、几位出行、预算大概多少，随时告诉我，我来帮您安排！',
  },
  phone: {
    context: ['【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}'],
    tools: [],
    reply: '好的，顾问会在微信上联系您。',
  },
  'phone-or-wechat': {
    context: ['【当前会话状态】\n今天日期: 2026-10-02（客户说的月日一律按未来最近的日期理解）\n销售阶段: greeting\n客户画像: {}'],
    tools: [],
    reply: '好的，顾问会在微信上联系您。',
  },
};
let seq = 0;
function session(channel: string, tag: string): Session {
  return store.getOrCreateSession(`${channel === 'simulator' ? 'sim-' : channel + ':'}webcopy-${tag}-${++seq}`, channel);
}
function primeQuote(s: Session): void {
  s.messages.push({ role: 'customer', content: '去云南，两个人，12月10号出发', at: Date.now() });
  s.lastQuote = {
    routeId: 'r-yunnan-mid',
    routeTitle: '云南丽江大理 6 日舒适之旅',
    travelers: 2,
    perPerson: 12800,
    total: 25600,
    departDate: '2026-12-10',
  };
  s.stage = 'quote';
  store.saveSession(s);
}
function primeOrder(s: Session): void {
  s.orderIds.push(
    store.createOrder({
      sessionId: s.id,
      routeId: 'r-yunnan-mid',
      routeTitle: '云南丽江大理 6 日舒适之旅',
      travelers: 2,
      departDate: '2026-12-10',
      totalPrice: 25600,
    }).id,
  );
  store.saveSession(s);
}
function normalize(text: string, s: Session): string {
  for (const id of s.orderIds) text = text.replaceAll(id, '<ORDER>');
  return text;
}
async function run(tag: string, s: Session, text: string, steps: Step[]): Promise<string> {
  const from = requests.length;
  script.push(...steps);
  const reply = await handleMessage(s.id, text, s.channel);
  assert.equal(script.length, 0, `${tag} 应消费全部脚本`);
  const bodies = requests.slice(from);
  for (const b of bodies) {
    assert.equal(sha(b.messages[0]!.content!), SYSTEM_SHA, `${s.channel}/${tag} system 哈希`);
    assert.equal(sha(JSON.stringify(b.tools)), TOOLS_SHA, `${s.channel}/${tag} tools 哈希`);
  }
  const got: Transcript = {
    context: bodies.flatMap((b) =>
      b.messages.filter((m) => m.role === 'system' && m.content?.startsWith('【当前会话状态】')).map((m) => m.content!),
    ),
    tools: bodies.flatMap((b) => b.messages.filter((m) => m.role === 'tool').map((m) => normalize(m.content!, s))),
    reply: normalize(reply.text, s),
  };
  {
    const expected = BASELINE[tag]!;
    assert.ok(expected, `${tag} 有开工原文`);
    if (s.channel === 'web') {
      assert.deepEqual(
        got.context,
        expected.context.map((c) => `${c}\n${WEB_NOTE}`),
        `${tag} 网页 contextNote 只追加一句`,
      );
      assert.deepEqual(
        got.tools,
        expected.tools.map((t) => t.replaceAll('在微信里', '在这个页面里')),
        `${tag} 网页工具结果`,
      );
      assert.equal(
        got.reply,
        tag === 'phone-or-wechat'
          ? '好的，顾问会在这个页面里联系您。'
          : expected.reply
              .replaceAll('在微信里', '在这个页面里')
              .replaceAll('在微信上联系您', '在这个页面里回复您')
              .replaceAll('在微信上', '在这个页面里'),
        `${tag} 网页确定性回复`,
      );
      assert.ok(!got.reply.includes('微信') && got.tools.every((t) => !t.includes('微信')), `${tag} 网页没有微信承诺`);
    } else assert.deepEqual(got, expected, `${s.channel}/${tag} contextNote、工具结果、回复与开工原文逐字节相同`);
  }
  console.log(`PASS ${s.channel}/${tag}`);
  return reply.text;
}
const orderArgs = { routeId: 'r-yunnan-mid', travelers: 2, departDate: '2026-12-10' };
const orderStep: Step = { toolCalls: [{ name: 'create_order', args: orderArgs }] };
const handoffStep: Step = { toolCalls: [{ name: 'handoff_to_human', args: { reason: '客户需要人工协助核准价格' } }] };
try {
  {
    assert.equal(resolveProfile({}).flags.web_channel, true, 'demo 缺省开');
    assert.equal(resolveProfile({ DEPLOY_PROFILE: 'demo', FLAG_WEB_CHANNEL: 'off' }).flags.web_channel, false, 'demo 可关闭');
    assert.equal(resolveProfile({ DEPLOY_PROFILE: 'prod' }).flags.web_channel, false, 'prod 缺省关');
    assert.throws(() => resolveProfile({ DEPLOY_PROFILE: 'prod', FLAG_WEB_CHANNEL: 'on' }), ProfileConfigError, 'prod 禁止开启');
    assert.equal(capFlags('prod', { web_channel: true }).web_channel, false, 'prod 租户请求也不能放宽');
    assert.ok(PROFILE_ENV_NAMES.includes('FLAG_WEB_CHANNEL'), '自测与 eval 自动隔离新变量');
    assert.deepEqual(
      BASELINE_FLAG_NAMES,
      ['reset_command', 'anon_readonly_admin', 'seed_freshen', 'visitor_simulator', 'mock_pay', 'ai_disclosure'],
      '00 profile 行仍只有六项',
    );
    assert.equal(process.env.FLAG_WEB_CHANNEL, '', 'selftest-env 钉住网页开关');
    assert.equal(channelCustomerLabel('web', '客户'), '网页客户');
    assert.equal(channelCustomerLabel('simulator', '客户'), '演示客户');
    console.log('PASS web_channel：demo/prod、封顶、环境隔离与六项日志列表');
  }
  __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
  for (const channel of ['wecom', 'simulator', 'web']) {
    await run('greeting', session(channel, 'greeting'), '你好', [{ content: '您好，这次想去哪儿玩？' }]);
    const safety = session(channel, 'safety-new');
    primeQuote(safety);
    await run('safety-new', safety, '就这个，订吧', [{ content: '好的，马上为您处理～' }]);
    const existing = session(channel, 'safety-existing');
    primeQuote(existing);
    primeOrder(existing);
    await run('safety-existing', existing, '就这个，订吧', [{ content: '好的，马上为您处理～' }]);
    const resend = session(channel, 'resend');
    primeOrder(resend);
    await run('resend', resend, '订单链接再发我一下', []);
    store.getOrder(resend.orderIds[0]!)!.confirmedAt = Date.now();
    await run('resend-confirmed', resend, '订单链接再发我一下', []);
    const handoff = session(channel, 'handoff');
    primeOrder(handoff);
    await run('handoff-order', handoff, '转人工', []);
    const ordered = session(channel, 'tool-order');
    primeQuote(ordered);
    await run('tool-order-stranded', ordered, '帮我处理一下', [
      orderStep,
      { content: '报价如下，这条行程信息已经核对。\n每人 ¥999，总价 ¥1998。' },
    ]);
    await run('tool-order-reused', ordered, '帮我核对一下', [orderStep, { content: '好的，订单信息已经核对。' }]);
    await run('price-handed-over', session(channel, 'price'), '价格到底多少', [handoffStep, { content: '总价 ¥123456。' }]);
    await run('transfer-patched', session(channel, 'patched'), '签证怎么处理', [{ content: '好的，我帮您转接资深顾问，请稍候～' }]);
    const declined = session(channel, 'declined');
    declined.missedDestinations = [{ place: '冰岛', at: Date.now() }];
    store.saveSession(declined);
    await run('transfer-declined', declined, '明年2月，两个人', [
      { toolCalls: [{ name: 'handoff_to_human', args: { reason: '客户仍以冰岛为准' } }] },
      { content: '好的，顾问会在微信上联系您～' },
    ]);
    await run('phone', session(channel, 'phone'), '电话联系我', [{ content: '好的，顾问会电话联系您。' }]);
    await run('phone-or-wechat', session(channel, 'phone-or-wechat'), '电话联系我', [{ content: '好的，顾问会通过电话或微信联系您。' }]);
    // 每个受影响的使用点：web 正例与 wecom 原判定对照；都通过 handleMessage 验证后果。
    const pageContact = '顾问会在这个页面里回复您。';
    const pageNow = '已记录您的需求，顾问会在这个页面里回复您，请稍候～';
    const pageConfirm = '我请顾问在这个页面里跟您确认。';
    for (const content of [pageContact, pageConfirm]) {
      const s = session(channel, 'contact-task');
      script.push({ content });
      const reply = await handleMessage(s.id, '签证怎么处理', channel);
      assert.equal(reply.text, content);
      assert.equal(
        s.messages.some((m) => m.role === 'system' && /待顾问(?:跟进|确认)/.test(m.content)),
        channel === 'web',
        'promisesContact：仅网页说法记待办',
      );
    }
    {
      const s = session(channel, 'transfer-now');
      script.push({ content: pageNow });
      const reply = await handleMessage(s.id, '签证怎么处理', channel);
      assert.equal(
        reply.text,
        channel === 'web' ? '这个我记下了，会请顾问在这个页面里跟您确认。' : pageNow,
        'saysTransfer：网页现在联系承诺进入转接安全网',
      );
      assert.equal(
        s.messages.some((m) => m.role === 'system' && m.content.includes('待顾问跟进')),
        channel === 'web',
      );
    }
    {
      const s = session(channel, 'drop-contact');
      s.missedDestinations = [{ place: '冰岛', at: Date.now() }];
      store.saveSession(s);
      script.push({ toolCalls: [{ name: 'handoff_to_human', args: { reason: '客户仍以冰岛为准' } }] }, { content: pageContact });
      const reply = await handleMessage(s.id, '明年2月，两个人', channel);
      assert.equal(reply.text.includes(pageContact), channel !== 'web', 'dropTransferClaims：网页驳回后摘掉回复承诺');
      assert.ok(!s.handedOver);
    }
    {
      const s = session(channel, 'followup');
      assert.equal(
        await guardOutbound(s, pageContact, { kind: 'followup' }),
        channel === 'web' ? '' : pageContact,
        '跟进清理使用网页联系判定',
      );
      assert.equal(await guardOutbound(s, pageNow, { kind: 'followup' }), channel === 'web' ? '' : pageNow, '跟进转接清理使用网页判定');
      for (const prefix of ['如果需要的话，', '付款后，', '· ']) {
        const conditional = session(channel, 'conditional');
        script.push({ content: prefix + pageNow });
        const reply = await handleMessage(conditional.id, '接下来怎么处理', channel);
        assert.equal(reply.text, prefix + pageNow, '条件、售后、选项仍不转人工');
        assert.ok(!conditional.handedOver);
      }
    }
    {
      const s = session(channel, 'phone-direct');
      assert.equal(
        dropUnbackedClaims('顾问会电话联系您。', s).text,
        channel === 'web' ? '顾问会在这个页面里回复您。' : '顾问会在微信上联系您。',
      );
    }
    console.log(`PASS ${channel}/判定：转接、驳回摘句、待办、跟进、条件/售后/选项`);
  }
  {
    assert.equal(sha(promptPrefix().system), SYSTEM_SHA);
    assert.equal(sha(promptPrefix().tools), TOOLS_SHA);
    console.log(`PREFIX sha256 system=${SYSTEM_SHA} tools=${TOOLS_SHA}`);
    console.log('PASS web.selftest：三渠道开工原文与网页话术回归');
  }
} finally {
  globalThis.fetch = originalFetch;
  __profileTest.reset();
  fs.rmSync(varDir, { recursive: true, force: true });
}

// 第 17 步：后端验收。前面的第 5 步保持原样；真实 PG 另起进程，避免换掉已装上的会话后端。
fs.mkdirSync(varDir, { recursive: true });
process.env.SERVER_SELFTEST = '1';
process.env.WEB_RATE_PER_MIN = '20';
process.env.WEB_NEW_PER_IP_HOUR = '10';
process.env.WEB_SSE_MAX_PER_IP = '10';
process.env.WEB_SSE_MAX_TOTAL = '2000';
process.env.ALERT_WEBHOOK_URL = '';
process.env.NOTIFY_WEBHOOK_URL = '';
for (const s of store.listSessions()) if (!store.isDemoClassId(s.id)) store.forgetSession(s.id);
const { openTestDb, installPgSessionStore, createRealPgFixture, testConfigDeps } = await import('../db/testing.js');
const { importConfig } = await import('../config/transfer.js');
const { initConfig, closeConfig, __configTest } = await import('../config/source.js');
const { openDb } = await import('../db/client.js');
const { installAccounts } = await import('../channels/accounts.js');
const { webAdapter, webConversationId, subscribeWeb } = await import('../adapters/web.js');
const { __privacyTest } = await import('../privacy/privacy.js');
const { __logTest } = await import('../log.js');
const { execFileSync } = await import('node:child_process');
const realRun = process.env.WEB_BACKEND_REAL_PG === '1';
if (realRun) globalThis.Date = Object.getPrototypeOf(Date) as DateConstructor;
const pgTest = realRun ? await createRealPgFixture(process.env.PG_TEST_URL!) : null;
const t = realRun ? null : await openTestDb();
const realDb = pgTest ? await openDb(pgTest.urls.app) : null;
const fx = t ? await installPgSessionStore(t, { varDir }) : null;
const deps = fx?.deps ?? { db: realDb!.db, tenantId: pgTest!.tenantId, tenantSlug: 'demo', varDir };
const configDeps = testConfigDeps({ db: deps.db });
const imported = await importConfig({
  db: deps.db,
  tenantSlug: 'demo',
  dataDir: path.resolve('data'),
  imageSop: configDeps.imageSop,
  lock: configDeps.lock,
});
assert.equal(imported.code, 0, '后端夹具使用完整 DB 配置，确定性路径的 trace 也带前缀哈希');
await initConfig(configDeps);
await store.initSessionStore(deps);
const sqlQuery = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
  if (pgTest) return pgTest.query<R>(sql, params);
  return t!.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<R>(sql, params)).rows;
  });
};
const { app } = await import('../server.js');
const { __webTest } = await import('./routes.js');
const { enterHandoff } = await import('../handoff/record.js');
const { release } = await import('../handoff/takeover.js');
type Account = import('../channels/accounts.js').ChannelAccount;
const accounts: Account[] = [];
async function account(key: string, settings: Partial<NonNullable<Account['web']>> = {}): Promise<Account> {
  const a: Account = {
    id: `00000000-0000-4000-8000-${String(accounts.length + 1).padStart(12, '0')}`,
    tenantId: deps.tenantId,
    key,
    kind: 'web',
    name: '网页测试',
    status: 'active',
    source: 'db',
    wecom: null,
    inactiveReason: null,
    web: { title: '网页测试', dailyNewConversations: 500, dailyTurns: 3000, ...settings },
  };
  // 账号也写入测试库，合并第 7 步的 channel_account_id 外键投影后夹具仍成立。
  await sqlQuery('insert into channel_accounts (id, tenant_id, key, kind, name, status, settings) values ($1,$2,$3,$4,$5,$6,$7)', [
    a.id,
    a.tenantId,
    a.key,
    a.kind,
    a.name,
    a.status,
    JSON.stringify(a.web),
  ]);
  accounts.push(a);
  installAccounts(accounts);
  return a;
}
const primary = await account('web-test');
const secrets = new Set<string>();
const sessionIds = new Set<string>();
let ipSeq = 0;
const nextIp = (): string => `198.51.${Math.floor(++ipSeq / 200)}.${(ipSeq % 200) + 1}`;
const liveBodies: ReadableStream<Uint8Array>[] = [];
type ReplyBody = { reply: { text: string } | null };
async function request(
  a: Account,
  endpoint: string,
  opts: { body?: unknown; cookie?: string; ip?: string; chatHeader?: boolean } = {},
): Promise<Response> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return app.request(`/api/web/${a.key}/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-forwarded-for': opts.ip ?? nextIp(),
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.chatHeader === false ? {} : { 'x-web-chat': '1' }),
    },
    body,
  });
}
async function json<R>(res: Response, status = 200): Promise<R> {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const raw = await res.text();
  for (const secret of [...secrets, ...sessionIds]) assert.ok(!raw.includes(secret), '响应没有访客凭据或会话 id');
  if (status === 404) return null as R;
  return JSON.parse(raw) as R;
}
function credential(res: Response, a: Account): { cookie: string; token: string; s: Session } {
  const header = res.headers.get('set-cookie')!;
  assert.ok(header, '接受消息下发 cookie');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert.ok(header.includes(attr), attr);
  const cookie = header.split(';')[0]!;
  const token = cookie.split('=')[1]!;
  assert.equal(Buffer.from(token, 'base64url').length, 32, '32 字节凭据');
  const id = webConversationId(a.id, token);
  secrets.add(token);
  sessionIds.add(id);
  const s = store.getSession(id)!;
  assert.equal(s.channel, 'web');
  assert.equal(s.channelAccountId, a.id);
  assert.ok(/^web:[0-9a-f]{32}$/.test(id));
  assert.equal(store.isDemoClassId(id), false, 'web 不是 demo 类');
  return { cookie, token, s };
}
let modelCalls = 0;
let modelGate: Promise<void> | null = null;
let modelStarted: (() => void) | null = null;
globalThis.fetch = async (input) => {
  assert.ok(String(input).startsWith('http://127.0.0.1/web-selftest/'), '只使用本地假模型');
  modelCalls++;
  modelStarted?.();
  if (modelGate) await modelGate;
  return Response.json({
    choices: [{ message: { role: 'assistant', content: '您好，您想了解什么行程？' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
};
const report = (name: string): void => console.log(`PASS web 后端：${name}`);
try {
  __profileTest.use({ DEPLOY_PROFILE: 'demo' });
  const page = await app.request(`/w/${primary.key}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!/<script(?![^>]*\b(?:src=|type="application\/json"))[^>]*>/i.test(await page.text()), '页面没有可执行的内联脚本');
  for (const state of ['missing', 'disabled', 'wrong-kind', 'inactive']) {
    const a = await account(`web-${state}`);
    if (state === 'missing') a.key = 'other-key';
    if (state === 'disabled') a.status = 'disabled';
    if (state === 'wrong-kind') a.kind = 'wecom_kf';
    if (state === 'inactive') a.inactiveReason = '未启用';
    for (const endpoint of ['history', 'events', 'messages', 'end']) {
      const res = await app.request(`/api/web/web-${state}/${endpoint}`, {
        method: ['messages', 'end'].includes(endpoint) ? 'POST' : 'GET',
      });
      assert.equal(res.status, 404);
    }
    assert.equal((await app.request(`/w/web-${state}`)).status, 404);
  }
  report('入口与全部接口只认启用的 web 账号，占位没有脚本');
  assert.deepEqual(await json(await request(primary, 'history')), { messages: [] });
  await json(await request(primary, 'events'), 401);
  const forged = `__Host-wv=${Buffer.alloc(32, 17).toString('base64url')}`;
  await json(await request(primary, 'events', { cookie: forged }), 401);
  assert.deepEqual(await json(await request(primary, 'history', { cookie: forged })), { messages: [] });
  for (const endpoint of ['messages', 'end'])
    await json(await request(primary, endpoint, { body: { text: '你好' }, chatHeader: false }), 403);
  for (const body of [
    { text: '' },
    { text: 'x'.repeat(1001) },
    { text: 5 },
    { text: '你好', cid: 'short' },
    { text: '你好', menu: 'health:granted' },
    { text: '你好', sessionId: 'web:fake' },
  ]) {
    const res = await request(primary, 'messages', { body });
    assert.equal(res.headers.get('set-cookie'), null);
    await json(res, 400);
  }
  report('无凭据与伪造凭据不能读取或订阅，POST 必须带 x-web-chat，输入校验');

  const first = await request(primary, 'messages', { body: { text: '你好', cid: 'first-cid' } });
  const own = credential(first, primary);
  const firstReply = await json<ReplyBody>(first);
  const beforeDuplicate = modelCalls;
  const duplicate = await request(primary, 'messages', { cookie: own.cookie, body: { text: '不同文本', cid: 'first-cid' } });
  assert.deepEqual(await json(duplicate), firstReply);
  assert.ok(duplicate.headers.get('set-cookie')!.includes('Max-Age=2592000'), '已有 cookie 滑动续期');
  assert.equal(duplicate.headers.get('set-cookie')!.split(';')[0], own.cookie);
  assert.equal(modelCalls, beforeDuplicate);
  assert.equal(own.s.messages.filter((m) => m.msgid === 'first-cid').length, 1);
  report('cookie 属性、32 字节、滑动续期，cid 重复返回原回复且只记一条');

  const unissued = await request(primary, 'messages', { cookie: forged, body: { text: '你好' } });
  const rotated = credential(unissued, primary);
  await json(unissued);
  assert.notEqual(rotated.cookie, forged, '格式正确但未签发的凭据重新随机生成，防固定凭据');

  own.s.messages.push({ role: 'customer', content: '请问在吗', at: Date.now(), msgid: 'crash-cid' });
  store.saveSession(own.s);
  assert.ok(
    (await json<ReplyBody>(await request(primary, 'messages', { cookie: own.cookie, body: { text: '请问在吗', cid: 'crash-cid' } }))).reply,
  );
  assert.equal(own.s.messages.filter((m) => m.msgid === 'crash-cid').length, 1, 'alreadyRecorded 不重复记录');
  let unblock!: () => void;
  modelGate = new Promise((r) => {
    unblock = r;
  });
  const started = new Promise<void>((r) => {
    modelStarted = r;
  });
  const pending = request(primary, 'messages', { cookie: own.cookie, body: { text: '签证如何办理', cid: 'pending-cid' } });
  await started;
  assert.deepEqual(
    await json(await request(primary, 'messages', { cookie: own.cookie, body: { text: '签证如何办理', cid: 'pending-cid' } }), 409),
    { error: 'in_progress' },
  );
  unblock();
  modelGate = null;
  modelStarted = null;
  await json(await pending);
  assert.equal(own.s.messages.filter((m) => m.msgid === 'pending-cid').length, 1);
  report('处理中 409，崩溃留下的已记录消息通过 alreadyRecorded 恢复');

  own.s.profile.notes = ['不可公开的画像'];
  own.s.messages.push(
    { role: 'system', content: '不应公开的系统消息', at: Date.now() },
    { role: 'agent', content: '顾问回复', at: Date.now(), author: 'human', authorId: 'member-test', authorName: '真实姓名' },
  );
  store.saveSession(own.s);
  const history = await json<{ messages: import('../shared/channel-types.js').WebMessage[] }>(
    await request(primary, 'history', { cookie: own.cookie }),
  );
  assert.ok(history.messages.some((m) => m.text === '【顾问】顾问回复'));
  assert.ok(history.messages.every((m) => ['customer', 'agent'].includes(m.role) && Object.keys(m).sort().join() === 'at,role,text'));
  assert.ok(!JSON.stringify(history).match(/不可公开|不应公开|真实姓名|member-test/));
  const other = await account('web-other');
  assert.notEqual(webConversationId(other.id, own.token), own.s.id, '哈希绑定账号');
  assert.deepEqual(await json(await request(other, 'history', { cookie: own.cookie })), { messages: [] });
  await json(await request(other, 'events', { cookie: own.cookie }), 401);
  const anon = await app.request('/api/sessions');
  assert.ok(!(await anon.text()).includes(own.s.id), '匿名 admin 列表没有 web 会话');
  report('历史仅有 role/text/at，人工前缀，无 system/画像/成员；账号隔离与匿名列表');

  async function events(
    a: Account,
    cookie: string,
    ip = nextIp(),
  ): Promise<{ res: Response; reader?: ReadableStreamDefaultReader<Uint8Array> }> {
    const res = await request(a, 'events', { cookie, ip });
    if (res.status !== 200) return { res };
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const body = res.body!;
    liveBodies.push(body);
    const reader = body.getReader();
    const ping = await reader.read();
    assert.ok(new TextDecoder().decode(ping.value).includes('event: ping'));
    return { res, reader };
  }
  for (let i = 0; i < 3; i++) {
    const head = await app.request(`/api/web/${primary.key}/events`, {
      method: 'HEAD',
      headers: { cookie: own.cookie, 'x-forwarded-for': nextIp() },
    });
    assert.equal(head.status, 405);
    assert.equal(head.headers.get('allow'), 'GET');
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.equal(await head.text(), '');
  }
  const open = [await events(primary, own.cookie), await events(primary, own.cookie), await events(primary, own.cookie)];
  await json((await events(primary, own.cookie)).res, 429);
  report('连续三次 HEAD 返回空 405/Allow GET，随后三个 GET 均成功、第四个才 429');
  await webAdapter.push(own.s.id, '在线顾问', { kind: 'human' });
  for (const conn of open) assert.ok(new TextDecoder().decode((await conn.reader!.read()).value).includes('【顾问】在线顾问'));
  await open[1]!.reader!.cancel();
  await open[2]!.reader!.cancel();
  __privacyTest.set({ version: 1, body: '测试隐私说明' });
  await json(await request(primary, 'messages', { cookie: own.cookie, body: { text: '我妈有高血压', cid: 'consent-cid' } }));
  const menuRaw = new TextDecoder().decode((await open[0]!.reader!.read()).value);
  assert.ok(menuRaw.includes('event: menu') && menuRaw.includes('health:granted') && menuRaw.includes('不同意'));
  for (const secret of [...secrets, ...sessionIds]) assert.ok(!menuRaw.includes(secret));
  assert.equal(own.s.consent?.health, 'asked');
  const beforeClick = modelCalls;
  await json(await request(primary, 'messages', { cookie: own.cookie, body: { menu: 'health:granted', cid: 'menu-cid-1' } }));
  assert.equal(own.s.consent?.health, 'granted');
  assert.equal(modelCalls, beforeClick);
  await json(await request(primary, 'messages', { cookie: own.cookie, body: { menu: 'health:granted:fake' } }), 400);
  __webTest.tickStreams(Date.now() + 15_000);
  assert.ok(new TextDecoder().decode((await open[0]!.reader!.read()).value).includes('event: ping'));
  __webTest.tickStreams(Date.now() + 30 * 60_000 + 1);
  assert.equal((await open[0]!.reader!.read()).done, true, 'ping 不续空闲期，30 分钟关闭');
  assert.equal(await webAdapter.push(own.s.id, '离线正文'), true);
  assert.equal(await webAdapter.push(own.s.id, '离线菜单', { kind: 'menu', category: 'minor' }), false);
  const offlineRes = await request(primary, 'messages', { body: { text: '我妈有高血压' } });
  const offline = credential(offlineRes, primary);
  await json(offlineRes);
  assert.equal(offline.s.consentAskCount?.health, 1);
  await json(await request(primary, 'messages', { cookie: offline.cookie, body: { text: '我妈有高血压' } }));
  assert.equal(offline.s.consentAskCount?.health, 2, '离线菜单仍走第二次询问规则');
  await json(await request(primary, 'messages', { cookie: offline.cookie, body: { text: '我妈有高血压' } }));
  assert.equal(offline.s.consentAskCount?.health, 2, '最多问两次');
  assert.ok(!offline.s.messages.some((m) => m.content.includes('可以吗？隐私说明')), '离线菜单不假记已送达');
  report('SSE 会话第 4 条 429、多连接人工推送、15 秒 ping/30 分钟空闲关闭、同意菜单与 granted、离线菜单 false');

  const ipConnections: Awaited<ReturnType<typeof events>>[] = [];
  const sharedIp = nextIp();
  for (let i = 0; i < 4; i++) {
    const res = await request(primary, 'messages', { body: { text: '你好', cid: `ip-cid-0${i}` } });
    const cred = credential(res, primary);
    await json(res);
    for (let n = 0; n < (i === 3 ? 1 : 3); n++) ipConnections.push(await events(primary, cred.cookie, sharedIp));
    if (i === 3) await json((await events(primary, cred.cookie, sharedIp)).res, 429);
  }
  for (const conn of ipConnections) await conn.reader!.cancel();
  process.env.WEB_SSE_MAX_TOTAL = '1';
  const globalConnection = await events(primary, own.cookie);
  await json((await events(primary, own.cookie)).res, 429);
  await globalConnection.reader!.cancel();
  process.env.WEB_SSE_MAX_TOTAL = '2000';
  const failing = subscribeWeb(own.s.id, nextIp(), () => {
    throw new Error('断开');
  });
  assert.equal(typeof failing, 'function');
  const delivered: unknown[] = [];
  const good = subscribeWeb(own.s.id, nextIp(), (ev) => {
    delivered.push(ev);
  });
  await webAdapter.push(own.s.id, '仍送达');
  assert.equal(delivered.length, 1, '坏连接不影响其他连接');
  if (typeof failing === 'function') {
    failing();
    failing();
  }
  if (typeof good === 'function') good();
  report('同 IP 第 11 条 429、全局上限，取消与异常释放配额');

  const rateIp = nextIp();
  for (let i = 0; i < 20; i++)
    await json(await request(primary, 'messages', { ip: rateIp, cookie: own.cookie, body: { text: '你好', cid: 'first-cid' } }));
  const rateCalls = modelCalls;
  const rateResponse = await request(primary, 'messages', { ip: rateIp, cookie: own.cookie, body: { text: '你好' } });
  assert.equal(rateResponse.headers.get('set-cookie'), null);
  await json(rateResponse, 429);
  assert.equal(modelCalls, rateCalls);
  const newIp = nextIp();
  for (let i = 0; i < 10; i++) {
    const r = await request(primary, 'messages', { ip: newIp, body: { text: '你好' } });
    credential(r, primary);
    await json(r);
  }
  const countBeforeIp = store.listSessions().length;
  const ipLimited = await request(primary, 'messages', { ip: newIp, body: { text: '你好' } });
  assert.equal(ipLimited.headers.get('set-cookie'), null);
  await json(ipLimited, 429);
  assert.equal(store.listSessions().length, countBeforeIp);
  const capped = await account('web-new-cap', { dailyNewConversations: 1 });
  const allowed = await request(capped, 'messages', { cookie: '__Host-wv=invalid', body: { text: '你好' } });
  const capOwn = credential(allowed, capped);
  await json(allowed);
  assert.notEqual(capOwn.cookie, '__Host-wv=invalid');
  const countBefore = store.listSessions().length;
  const dailyDenied = await request(capped, 'messages', { body: { text: '你好' } });
  assert.equal(dailyDenied.headers.get('set-cookie'), null);
  await json(dailyDenied, 429);
  assert.equal(store.listSessions().length, countBefore);
  report('IP 分钟限流、新会话 IP 小时/账号每日上限；429 无 cookie、无会话、无模型调用');

  const turns = await account('web-turn-cap', { dailyTurns: 1 });
  const beforeReset = modelCalls;
  const resetResponse = await request(turns, 'messages', { body: { text: '重置', cid: 'reset-cid' } });
  const resetOwn = credential(resetResponse, turns);
  assert.ok((await json<ReplyBody>(resetResponse)).reply!.text.includes('重新开始'));
  assert.equal(modelCalls, beforeReset, 'demo 重置不调模型');
  const afterReset = await request(turns, 'messages', { cookie: resetOwn.cookie, body: { text: '你好', cid: 'after-reset' } });
  assert.ok((await json<ReplyBody>(afterReset)).reply);
  assert.equal(modelCalls, beforeReset + 1, '确定性回复退回预留，不消耗模型轮次上限');
  // 下一段用同一账号的新访客，轮次已经被 after-reset 用完。
  turns.web!.dailyTurns = 2;
  const r = await request(turns, 'messages', { body: { text: '你好', cid: 'turn-first' } });
  const turnOwn = credential(r, turns);
  await json(r);
  const beforeCap = modelCalls;
  const warnings: string[] = [];
  const oldWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };
  try {
    for (let i = 0; i < 2; i++)
      assert.deepEqual(
        await json(await request(turns, 'messages', { cookie: turnOwn.cookie, body: { text: `还有问题${i}`, cid: `turn-cap-${i}` } })),
        { reply: { text: '现在咨询的人有点多，顾问会在这里回复您' } },
      );
    assert.equal(turnOwn.s.handoffCount, 1);
    assert.equal(turnOwn.s.handoff?.kind, 'request');
    assert.equal(modelCalls, beforeCap);
    release(turnOwn.s.id, { role: 'shared', userId: null, name: '顾问', ip: null });
    assert.deepEqual(
      await json(await request(turns, 'messages', { cookie: turnOwn.cookie, body: { text: '又一个问题', cid: 'turn-after' } })),
      { reply: { text: '现在咨询的人有点多，顾问会在这里回复您' } },
    );
    assert.equal(turnOwn.s.handoffCount, 1, '顾问交还之后不重复因限额转人工');
    const r2 = await request(turns, 'messages', { body: { text: '第二个访客', cid: 'turn-newer' } });
    credential(r2, turns);
    await json(r2);
    assert.equal(warnings.filter((w) => w.includes('web-turn-cap')).length, 1, '每账号每天一条 channel 告警');
    assert.equal(modelCalls, beforeCap);
  } finally {
    console.warn = oldWarn;
  }
  assert.equal(turnOwn.s.messages.filter((m) => m.role === 'customer').length, 4, '超限客户消息照记');
  const human = await account('web-human');
  const hr = await request(human, 'messages', { body: { text: '你好' } });
  const humanOwn = credential(hr, human);
  await json(hr);
  enterHandoff(humanOwn.s, { kind: 'request', reason: '测试转人工', at: Date.now() });
  store.saveSession(humanOwn.s);
  assert.deepEqual(
    await json(await request(human, 'messages', { cookie: humanOwn.cookie, body: { text: '顾问在吗', cid: 'human-cid' } })),
    { reply: null },
  );
  assert.equal(humanOwn.s.messages.filter((m) => m.msgid === 'human-cid').length, 1);
  report('每日轮次超限固定回复/客户话留存/至多一次 request/不调模型/账号每日告警；普通转人工 reply null');

  const DayDate = Date;
  globalThis.Date = class extends DayDate {
    constructor(value?: string | number) {
      super(value ?? DayDate.now() + 86_400_000);
    }
  } as DateConstructor;
  try {
    const newDay = await request(capped, 'messages', { body: { text: '新一天咨询' } });
    credential(newDay, capped);
    await json(newDay);
    const turnDay = await request(turns, 'messages', { body: { text: '新一天的问题' } });
    const nextDayOwn = credential(turnDay, turns);
    await json(turnDay);
    assert.equal(nextDayOwn.s.handedOver, false, '自然日切换重置轮次上限');
    const beforeResume = modelCalls;
    assert.equal(turnOwn.s.handedOver, false, '顾问已交还之前超限的会话');
    const resumed = await json<ReplyBody>(
      await request(turns, 'messages', { cookie: turnOwn.cookie, body: { text: '今天继续咨询', cid: 'turn-resume' } }),
    );
    assert.equal(resumed.reply!.text, '您好，您想了解什么行程？');
    assert.equal(modelCalls, beforeResume + 1, '旧会话额度恢复后正常调模型');
    assert.equal(turnOwn.s.handoffCount, 1, '持久预算标记仍然保留');
    warnings.length = 0;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };
    try {
      for (let i = 0; i < 2; i++)
        assert.deepEqual(
          await json(await request(turns, 'messages', { cookie: turnOwn.cookie, body: { text: '再次超限', cid: `recap-cid-${i}` } })),
          { reply: { text: '现在咨询的人有点多，顾问会在这里回复您' } },
        );
      assert.equal(turnOwn.s.handoffCount, 1, '新自然日再次超限也不重复转人工');
      assert.equal(turnOwn.s.handedOver, false);
      assert.equal(modelCalls, beforeResume + 1, '再次超限不调模型');
      assert.equal(warnings.filter((w) => w.includes('web-turn-cap')).length, 1, '已有持久标记仍在新自然日合并一条告警');
    } finally {
      console.warn = oldWarn;
    }
    report('超限当天固定回复/转一次人工；次日顾问交还后调模型；再次超限不再转人工且每天告警一次');

    const beforeWindow = turnOwn.s.messages.length;
    const beforeWindowCalls = modelCalls;
    let appended = 0;
    for (let i = 0; i < 205; i++) {
      const length = turnOwn.s.messages.length;
      assert.deepEqual(
        await json(
          await request(turns, 'messages', { cookie: turnOwn.cookie, body: { text: `连续超限咨询${i}`, cid: `window-cid-${i}` } }),
        ),
        { reply: { text: '现在咨询的人有点多，顾问会在这里回复您' } },
      );
      appended += 2;
      if (length + 2 > 400) break;
    }
    assert.ok(beforeWindow + appended > 400, '不同 cid 的真实超限请求累计超过 400 条消息');
    assert.equal(turnOwn.s.messages.length, 300, '越过 400 后裁到最近 300 条');
    assert.equal(modelCalls, beforeWindowCalls);
    assert.equal(turnOwn.s.handoffCount, 1);
    await store.flushSession(turnOwn.s.id, { timeoutMs: 20_000 });
    const persisted = await sqlQuery<{ count: number }>(
      'select count(*)::int as count from messages where tenant_id=$1 and conversation_id=$2',
      [deps.tenantId, turnOwn.s.id],
    );
    assert.equal(persisted[0]!.count, beforeWindow + appended, '窗口裁剪不删除已落库消息，新增消息全部追加');
    report('超限路径不同 cid 超过 400 条裁到 300 条，数据库完整追加历史仍在');
  } finally {
    globalThis.Date = DayDate;
    console.warn = oldWarn;
  }
  report('账号每日新会话与轮次按服务器自然日清零');

  const end = await request(primary, 'end', { cookie: own.cookie, body: {} });
  assert.ok(end.headers.get('set-cookie')!.startsWith('__Host-wv=; Max-Age=0;'));
  await json(end);
  assert.equal(store.getSession(own.s.id), own.s);
  assert.deepEqual(await json(await request(primary, 'history')), { messages: [] });
  const newAfterEnd = await request(primary, 'messages', { body: { text: '你好' } });
  const afterEnd = credential(newAfterEnd, primary);
  await json(newAfterEnd);
  assert.notEqual(afterEnd.s.id, own.s.id);
  const logLines: string[] = [];
  const logger = __logTest.createJsonLogger({
    write: (line) => {
      logLines.push(line);
    },
  });
  logger.info(
    { cookie: own.cookie, headers: { 'set-cookie': first.headers.get('set-cookie'), cookie: own.cookie }, token: own.token },
    `会话 ${own.s.id}`,
  );
  assert.ok(!logLines.join('').includes(own.token) && !logLines.join('').includes(own.s.id), 'pino 遮盖 cookie/set-cookie/token 与 web id');
  assert.ok(__logTest.REDACT_PATHS.includes('cookie') && __logTest.REDACT_PATHS.some((p) => p.includes('set-cookie')));
  report('end 清 cookie 不删会话；响应与 pino 日志无凭据、无会话原 id');

  for (const flags of [{ DEPLOY_PROFILE: 'prod' }, { DEPLOY_PROFILE: 'demo', FLAG_WEB_CHANNEL: 'off' }]) {
    __profileTest.use(flags);
    assert.equal((await app.request(`/w/${primary.key}`)).status, 404);
    for (const endpoint of ['history', 'events', 'messages', 'end']) {
      const res = await request(primary, endpoint, {
        cookie: own.cookie,
        ...(['messages', 'end'].includes(endpoint) ? { body: { text: '你好' } } : {}),
      });
      await json(res, 404);
    }
    if (flags.DEPLOY_PROFILE === 'prod') assert.equal((await app.request('/chat.html')).status, 404);
  }
  __profileTest.use({ DEPLOY_PROFILE: 'demo' });
  report('prod 与 demo 关闭 web_channel 时全部网页路由 404，prod chat.html 仍为 404');

  const stale = store.getOrCreateSession(webConversationId(primary.id, Buffer.alloc(32, 33).toString('base64url')), 'web');
  stale.channelAccountId = primary.id;
  stale.messages.push({ role: 'customer', content: '过期咨询', at: Date.now() - 8 * 86_400_000 });
  stale.createdAt = stale.updatedAt = Date.now() - 8 * 86_400_000;
  store.saveSession(stale, false);
  const visitor = store.getOrCreateSession('sim-webbackend-stale', 'simulator');
  visitor.updatedAt = Date.now() - 8 * 86_400_000;
  store.saveSession(visitor, false);
  store.pruneStaleVisitorData();
  assert.equal(store.getSession(visitor.id), undefined);
  assert.equal(store.getSession(stale.id), stale, 'sim 访客清理不碰 web');
  const staleTraceId = '00000000-0000-4000-8000-000000000099';
  store.queueTelemetry(stale.id, {
    traces: [
      {
        id: staleTraceId,
        conversationId: stale.id,
        startedAt: new Date(),
        durationMs: 1,
        outcome: 'replied',
        sopVersion: 1,
        prefixHash: 'a'.repeat(64),
        catalogVersions: {},
        stageBefore: 'greeting',
        stageAfter: 'greeting',
        draft: '过期回复',
        finalText: '过期回复',
        calls: [],
        llm: [],
        signals: null,
      },
    ],
  });
  const drained = await store.drainStore(20_000);
  assert.deepEqual(drained.undrained, []);
  const stored = await sqlQuery<{ id: string; channel: string; state: Record<string, unknown> }>(
    'select id, channel, state from conversations where tenant_id=$1',
    [deps.tenantId],
  );
  assert.ok(
    stored.some((s) => s.id === own.s.id && s.channel === 'web' && s.state.channelAccountId === primary.id),
    '网页会话落库且账号在 state',
  );
  assert.ok(!stored.some((s) => s.id.startsWith('sim-')), 'sim 不落库');
  assert.ok(
    stored.some((s) => s.id === turnOwn.s.id && s.state.webTurnLimited === true),
    '预算已触发状态持久化',
  );
  await sqlQuery('update tenants set retention_lead_days=7 where id=$1', [deps.tenantId]);
  const { purgeOnce } = await import('../jobs/purge.js');
  assert.equal((await sqlQuery('select 1 from messages where tenant_id=$1 and conversation_id=$2', [deps.tenantId, stale.id])).length, 1);
  assert.equal(
    (await sqlQuery('select 1 from turn_traces where tenant_id=$1 and conversation_id=$2', [deps.tenantId, stale.id])).length,
    1,
  );
  // 真正登录后的 console 列表：清理前能看到目标，清理后同一个接口看不到。
  const { hashPassword } = await import('../auth/password.js');
  const [listUser] = await sqlQuery<{ id: string }>('insert into users (email,password_hash,display_name) values ($1,$2,$3) returning id', [
    'purge-web@example.com',
    await hashPassword('purge-web-password'),
    '清理测试',
  ]);
  await sqlQuery("insert into memberships (tenant_id,user_id,role) values ($1,$2,'owner')", [deps.tenantId, listUser!.id]);
  const { login, SESSION_COOKIE } = await import('../auth/session.js');
  const listLogin = await login({
    now: Date.now(),
    ip: '198.51.100.250',
    userAgent: 'selftest',
    email: 'purge-web@example.com',
    password: 'purge-web-password',
  });
  assert.ok(listLogin);
  const listConversations = async (): Promise<import('../shared/console-api.js').ConversationRow[]> => {
    const response = await app.request('/api/console/conversations?limit=100', {
      headers: { cookie: `${SESSION_COOKIE}=${listLogin.token}` },
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { items: import('../shared/console-api.js').ConversationRow[] }).items;
  };
  assert.ok(
    (await listConversations()).some((r) => r.id === stale.id),
    '清理前 console 列表含过期网页会话',
  );
  const purged = await purgeOnce(Date.now());
  assert.equal(purged.conversations, 1);
  assert.equal(store.getSession(stale.id), undefined);
  assert.ok(!(await sqlQuery<{ id: string }>('select id from conversations where id=$1', [stale.id])).length);
  assert.ok((await sqlQuery<{ id: string }>('select id from conversations where id=$1', [own.s.id])).length);
  assert.equal((await sqlQuery('select 1 from messages where tenant_id=$1 and conversation_id=$2', [deps.tenantId, stale.id])).length, 0);
  assert.equal(
    (await sqlQuery('select 1 from turn_traces where tenant_id=$1 and conversation_id=$2', [deps.tenantId, stale.id])).length,
    0,
  );
  assert.ok(!(await listConversations()).some((r) => r.id === stale.id), '清理后 console 列表没有过期网页会话');
  report(`${realRun ? '真实 PG' : 'PGlite'}：清除 web 会话连带 messages、turn_traces，console 列表不再显示`);
  report(`${realRun ? '真实 PG' : 'PGlite'}：落库、账号 state、预算状态持久化、不受 sim 清理、7 天保留期清除 8 天前会话`);
} finally {
  for (const body of liveBodies) {
    if (!body.locked) await body.cancel().catch(() => {});
  }
  __webTest.tickStreams(Date.now() + 31 * 60_000);
  await store.drainStore(20_000);
  __privacyTest.reset();
  installAccounts([]);
  __profileTest.reset();
  globalThis.fetch = originalFetch;
  await closeConfig();
  __configTest.reset();
  await realDb?.close();
  await pgTest?.drop();
  await t?.close();
  fs.rmSync(varDir, { recursive: true, force: true });
}
if (!realRun) {
  if (process.env.PG_TEST_URL) {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/web/web.selftest.ts'], {
      env: { ...process.env, WEB_BACKEND_REAL_PG: '1' },
      timeout: 120_000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ok(output.includes('PASS web 后端：真实 PG'));
    console.log(output);
  } else console.log('SKIP web 后端：未设置 PG_TEST_URL，真实 PG 由协调者在一次性测试容器补跑');
}
console.log('PASS web.selftest：第 17 步后端验收');

// 03 第 18 步：页面安全与浏览器脚本契约；只用内存 DOM，不监听端口。
const { CONSOLE_SECURITY_HEADERS } = await import('../shared/security-headers.js');
const { runInNewContext } = await import('node:vm');
const { randomUUID } = await import('node:crypto');
const webHtml = fs.readFileSync('public/web.html', 'utf8');
const webJs = fs.readFileSync('public/web.js', 'utf8');
const webCss = fs.readFileSync('public/web.css', 'utf8');
const { splitSiteLinks } = runInNewContext(`${webJs.replace('export function', 'function')}\n({ splitSiteLinks });`, { URL }) as {
  splitSiteLinks: (text: string, base?: string) => { text: string; href?: string }[];
};
const clickable = (text: string, base?: string): string[] =>
  Array.from(splitSiteLinks(text, base)).flatMap((p) => (p.href ? [p.href] : []));
assert.deepEqual(clickable('订单 /pay/order_1，方案 /proposal/route-1/2/2026-12-10?v=3'), [
  '/pay/order_1',
  '/proposal/route-1/2/2026-12-10?v=3',
]);
assert.deepEqual(clickable('https://example.test/pay/order_1 https://example.test/proposal/r/2'), []);
assert.deepEqual(clickable('https://example.test/pay/order_1', 'https://example.test'), ['/pay/order_1']);
assert.deepEqual(clickable('https://example.test/app/proposal/r/2', 'https://example.test/app'), ['/proposal/r/2']);
for (const attack of [
  'https://example.test.evil.test/pay/order_1',
  'https://example.test@evil.test/pay/order_1',
  '//evil.test/pay/order_1',
  'javascript:/pay/order_1',
  'data:text/html,/pay/order_1',
  'foo/pay/order_1',
  'evil.test/pay/order_1',
  '/pay/order_1/../../console',
  '/proposal/../../console',
  '/pay/%2e%2e',
  '/pay/order_1?redirect=//evil.test',
  '/pay/order_1\\evil',
  'ftp://example.test/pay/order_1',
]) {
  assert.deepEqual(clickable(attack, 'https://example.test'), [], `不允许 ${attack}`);
  assert.equal(
    splitSiteLinks(attack, 'https://example.test')
      .map((p) => p.text)
      .join(''),
    attack,
  );
}
for (const text of ['<img src=x onerror=alert(1)> /pay/order_1', '**原文**\n外站 https://evil.test/pay/order_1']) {
  assert.equal(
    splitSiteLinks(text)
      .map((p) => p.text)
      .join(''),
    text,
    '不改写原文，不解析 markdown',
  );
}
assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(webJs), '页面源码不访问凭据存储');
assert.ok(
  !/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|setAttribute\(['"](?:style|on\w+)/.test(webJs),
  '运行时只构造 DOM，不注入 HTML/内联样式/事件属性',
);
assert.ok(!/<style\b|\sstyle\s*=|\son\w+\s*=/i.test(webHtml));
const scripts = [...webHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 2);
assert.equal(scripts.filter((s) => /type="application\/json"/.test(s[1]!)).length, 1);
assert.ok(scripts.every((s) => /type="application\/json"/.test(s[1]!) || (/src="\/web.js"/.test(s[1]!) && !s[2]!.trim())));
assert.match(webHtml, /<link rel="stylesheet" href="\/web.css">/);
assert.match(webCss, /white-space: pre-wrap/);
assert.match(webCss, /prefers-reduced-motion/);

const pageAccount: Account = { ...primary, key: 'web-page', web: { ...primary.web!, title: '</script><img src=x onerror=alert(1)>$&' } };
const previousBase = process.env.PUBLIC_BASE_URL;
try {
  __profileTest.use({ DEPLOY_PROFILE: 'demo' });
  installAccounts([pageAccount]);
  process.env.PUBLIC_BASE_URL = 'https://example.test/';
  __privacyTest.set({ version: 1, body: '测试隐私说明' });
  const page = await app.request('/w/web-page');
  assert.equal(page.status, 200);
  assert.equal(
    page.headers.get('content-security-policy'),
    `${CONSOLE_SECURITY_HEADERS['Content-Security-Policy']}; style-src 'self'; base-uri 'none'; form-action 'self'`,
  );
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const rendered = await page.text();
  const configBlock = /<script type="application\/json" id="web-config">([\s\S]*?)<\/script>/.exec(rendered)![1]!;
  assert.ok(!configBlock.includes('<'));
  assert.ok(configBlock.includes('\\u003c/script>'));
  const config = JSON.parse(configBlock) as { key: string; title: string; welcome: string; privacyLink: string | null; base: string };
  assert.equal(config.key, pageAccount.key);
  assert.equal(config.title, pageAccount.web!.title, '恶意标题与 $& 原样往返，不执行 HTML 或 replace 的替换元字符');
  assert.equal(config.base, 'https://example.test');
  assert.equal(config.privacyLink, 'https://example.test/privacy');
  assert.match(config.welcome.split('\n')[0]!, /AI/);
  assert.match(config.welcome, /真人/);
  assert.ok(!rendered.includes(pageAccount.web!.title));
  pageAccount.web!.welcomeText = '我是 AI 顾问。需要人工请回复「人工」。<img src=x>';
  const custom = await (await app.request('/w/web-page')).text();
  assert.equal(JSON.parse(/id="web-config">([\s\S]*?)<\/script>/.exec(custom)![1]!).welcome, pageAccount.web!.welcomeText);
  __privacyTest.reset();
  const unpublished = await (await app.request('/w/web-page')).text();
  assert.equal(JSON.parse(/id="web-config">([\s\S]*?)<\/script>/.exec(unpublished)![1]!).privacyLink, null);
  for (const flags of [{ DEPLOY_PROFILE: 'demo', FLAG_WEB_CHANNEL: 'off' }, { DEPLOY_PROFILE: 'prod' }]) {
    __profileTest.use(flags);
    assert.equal((await app.request('/w/web-page')).status, 404);
    for (const [asset, mime, source] of [
      ['web.js', 'javascript', webJs],
      ['web.css', 'css', webCss],
    ]) {
      const res = await app.request(`/${asset}`);
      assert.equal(res.status, 200, '静态资源不受 webOnly/模拟器开关影响');
      assert.ok(res.headers.get('content-type')!.includes(mime!));
      assert.equal(await res.text(), source);
    }
    assert.equal((await app.request('/src/web/routes.ts')).status, 404, '静态兜底不暴露源码');
    assert.equal((await app.request('/AGENTS.md')).status, 404);
  }
} finally {
  if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = previousBase;
  installAccounts([]);
  __privacyTest.reset();
  __profileTest.reset();
}
console.log('PASS web 页面：无内联、JSON 转义往返、CSP 全等、站内链接、凭据隔离、开关与静态边界');

// 小型 DOM 夹具执行真实脚本，验证页面交互而非重复实现。
class PageNode {
  children: PageNode[] = [];
  parent: PageNode | null = null;
  className = '';
  private content = '';
  hidden = false;
  disabled = false;
  value = '';
  href = '';
  target = '';
  rel = '';
  type = '';
  scrollTop = 0;
  scrollHeight = 100;
  dataset: { q?: string } = {};
  listeners = new Map<string, ((event: Record<string, unknown>) => unknown)[]>();
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.content + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    this.content = text;
    this.replaceChildren();
  }
  append(...nodes: PageNode[]): void {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: PageNode[]): void {
    for (const n of this.children) n.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
  setAttribute(): void {}
  querySelectorAll(tag: string): PageNode[] {
    return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.querySelectorAll(tag)]);
  }
  addEventListener(name: string, fn: (event: Record<string, unknown>) => unknown): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  async emit(name: string, event: Record<string, unknown> = {}): Promise<void> {
    for (const fn of this.listeners.get(name) ?? []) await fn(event);
  }
}
function pageFixture(history: { role: string; text: string; at: number }[] = []) {
  const nodes = new Map<string, PageNode>();
  for (const id of ['web-config', 'title', 'msgs', 'input', 'sendBtn', 'endBtn', 'retryBtn', 'chips', 'notice', 'privacy', 'composer'])
    nodes.set(id, new PageNode('div'));
  nodes.get('web-config')!.textContent = JSON.stringify({
    key: 'web-page',
    title: '<img src=x onerror=alert(1)>',
    welcome: '我是 AI 顾问。可转真人。',
    base: 'https://example.test',
    privacyLink: '/privacy',
  });
  const requests: { url: string; init?: RequestInit }[] = [];
  const results: (Response | Error)[] = [Response.json({ messages: history })];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const sources: FakeSource[] = [];
  class FakeSource extends PageNode {
    closed = false;
    constructor(readonly url: string) {
      super('eventsource');
      sources.push(this);
    }
    close(): void {
      this.closed = true;
    }
  }
  const win = new PageNode('window');
  const document = {
    title: '',
    getElementById: (id: string) => nodes.get(id),
    createElement: (tag: string) => new PageNode(tag),
    createTextNode: (text: string) => {
      const n = new PageNode('text');
      n.textContent = text;
      return n;
    },
  };
  runInNewContext(webJs.replace('export function', 'function'), {
    document,
    window: win,
    URL,
    Date,
    AbortSignal,
    crypto: { randomUUID },
    EventSource: FakeSource,
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const result = results.shift();
      assert.ok(result, `缺少脚本响应 ${url}`);
      if (result instanceof Error) throw result;
      return result;
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { nodes, document, requests, results, sources, timers, win };
}
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ui = pageFixture();
await settle();
assert.equal(ui.requests[0]!.url, '/api/web/web-page/history');
assert.equal(ui.document.title, '<img src=x onerror=alert(1)>');
assert.equal(ui.nodes.get('title')!.textContent, ui.document.title);
assert.ok(ui.nodes.get('msgs')!.textContent.includes('我是 AI 顾问'));
assert.equal(ui.nodes.get('privacy')!.href, '/privacy');
assert.equal(ui.sources.length, 0, '无会话时不反复连接未授权 SSE');
ui.nodes.get('input')!.value = '<img src=x onerror=alert(1)> https://evil.test/pay/id';
ui.results.push(new Error('断网'));
await ui.nodes.get('composer')!.emit('submit', { preventDefault() {} });
await settle();
const sent = JSON.parse(ui.requests[1]!.init!.body as string) as { text: string; cid: string };
assert.match(sent.cid, /^[A-Za-z0-9_-]{8,64}$/);
assert.equal((ui.requests[1]!.init!.headers as Record<string, string>)['x-web-chat'], '1');
assert.equal(ui.requests[1]!.init!.credentials, 'same-origin');
assert.equal(ui.nodes.get('retryBtn')!.hidden, false);
assert.equal(ui.nodes.get('msgs')!.querySelectorAll('img').length, 0);
assert.equal(ui.nodes.get('msgs')!.querySelectorAll('a').length, 0, '站外链接和客户 HTML 作为文本');
ui.results.push(Response.json({ reply: { text: '**原文**\n订单 /pay/order_1' } }));
await ui.nodes.get('retryBtn')!.emit('click');
await settle();
assert.equal(ui.requests[2]!.init!.body, ui.requests[1]!.init!.body, '失败重试复用完全相同 cid 和内容');
assert.equal(ui.nodes.get('msgs')!.querySelectorAll('a')[0]!.href, '/pay/order_1');
assert.ok(ui.nodes.get('msgs')!.textContent.includes('**原文**'));
assert.equal(ui.nodes.get('retryBtn')!.hidden, true);
const source = ui.sources[0]!;
assert.equal(source.url, '/api/web/web-page/events');
await source.emit('push', { data: JSON.stringify({ text: '【顾问】您好' }) });
assert.ok(ui.nodes.get('msgs')!.textContent.includes('【顾问】您好'));
await source.emit('menu', {
  data: JSON.stringify({
    text: '是否同意？',
    buttons: [
      { id: 'health:granted', label: '同意' },
      { id: 'health:declined', label: '不同意' },
    ],
  }),
});
const buttons = ui.nodes.get('msgs')!.querySelectorAll('button');
assert.deepEqual(
  buttons.map((b) => b.textContent),
  ['同意', '不同意'],
);
ui.results.push(Response.json({ reply: null }));
await buttons[0]!.emit('click');
await settle();
assert.equal(JSON.parse(ui.requests.at(-1)!.init!.body as string).menu, 'health:granted');
assert.ok(ui.nodes.get('msgs')!.textContent.includes('已记录您的选择'));
assert.equal(ui.nodes.get('msgs')!.querySelectorAll('button').length, 0);
await source.emit('error');
for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
  const [id, timer] = [...ui.timers][0]!;
  assert.equal(timer.delay, delay, '断线指数退避并封顶');
  ui.timers.delete(id);
  timer.callback();
  await ui.sources.at(-1)!.emit('error');
}
ui.results.push(Response.json({ ok: true }));
await ui.nodes.get('endBtn')!.emit('click');
await settle();
assert.equal(ui.requests.at(-1)!.url, '/api/web/web-page/end');
assert.equal(ui.nodes.get('msgs')!.children.length, 0);
assert.ok(ui.nodes.get('notice')!.textContent.includes('已结束'));
assert.equal(ui.timers.size, 0);
assert.ok(ui.sources.every((s) => s.closed));
ui.nodes.get('input')!.value = '新的咨询';
ui.results.push(Response.json({ reply: null }));
await ui.nodes.get('composer')!.emit('submit', { preventDefault() {} });
await settle();
assert.notEqual(JSON.parse(ui.requests.at(-1)!.init!.body as string).cid, sent.cid, '新消息生成新 cid');
await ui.win.emit('pagehide');
assert.ok(ui.sources.every((s) => s.closed));
const refreshed = pageFixture([
  { role: 'customer', text: '先前的问题', at: Date.now() },
  { role: 'agent', text: '【顾问】历史回复', at: Date.now() },
]);
await settle();
assert.ok(refreshed.nodes.get('msgs')!.textContent.includes('先前的问题'));
assert.ok(refreshed.nodes.get('msgs')!.textContent.includes('【顾问】历史回复'));
assert.ok(!refreshed.nodes.get('msgs')!.textContent.includes('我是 AI 顾问'));
assert.equal(refreshed.sources.length, 1);
await refreshed.win.emit('pagehide');
console.log('PASS web 页面：textContent、欢迎语、历史恢复、发消息/cid 重试、SSE 人工/同意菜单、退避、结束与关闭清理');
