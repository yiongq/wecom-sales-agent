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
