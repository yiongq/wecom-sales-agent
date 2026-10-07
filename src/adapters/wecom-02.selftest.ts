// 企微适配器在 02 第 3 步多出的事（docs/architecture/02-conversations-workbench/spec.md「消息只追加」、R5、R18）：
// 记下的文本消息带原消息的 msgid 与 sentAt（send_time × 1000），非文本占位同样带 sentAt；
// 重放对齐时记下的消息有 msgid 就按 msgid 比（原文相同、msgid 不同的是新消息）。
// 锁定的 wecom.selftest.ts 不测这些。这里照它的写法搭一份最小的假企微服务端（假 fetch），驱动真正的适配器；引擎走离线脚本。
// 第 12 步的发送账本与五种去重情况在 quota.selftest 里另测。
// 用法：npx tsx src/adapters/wecom-02.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离数据目录，并且从「没有状态文件」开始（store 与适配器在模块加载时就取 VAR_DIR）
{
  const base = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  process.env.VAR_DIR = fs.mkdtempSync(path.join(base, 'wecom-02-selftest-'));
}
const VAR_DIR = process.env.VAR_DIR;
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '1'; // 引擎走离线脚本，绝不调真实模型
// 占位凭据：只为让 readConfig() 认为企微已配置，请求全部被下面的假 fetch 接住
process.env.WECOM_CORP_ID = 'selftest-corp';
process.env.WECOM_APP_SECRET = 'selftest-secret';
process.env.WECOM_KF_OPEN_KFID = 'selftest-kf';
process.env.PUBLIC_BASE_URL = ''; // 不走链接卡片

const { __test, syncFromCallback } = await import('./wecom.js');
const { getSession, getOrCreateSession, saveSession } = await import('../store.js');
const tk = await import('../handoff/takeover.js');
// store 与适配器的 exit 钩子先写盘，清理排在它们之后（exit 监听按注册顺序执行）
process.on('exit', () => fs.rmSync(VAR_DIR, { recursive: true, force: true }));

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
const json = (x: unknown) => JSON.stringify(x);

// ---------------- 假企微服务端：sync_msg 按 cursor 返回日志里之后的消息，send_msg 记下发了什么 ----------------
interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string };
}
const serverLog: FakeMsg[] = [];
const sent: { to: string; content: string }[] = [];
/** 审查第 7 条的探针：send_msg 第一次打到这个 uid 时触发一次接手，模拟退避重试期间被 HTTP 接手 */
let takeoverOnSend: { uid: string; fired: boolean } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const ep = new URL(String(input)).pathname.replace(/^\/cgi-bin\//, '');
  const res = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (ep === 'gettoken') return res({ errcode: 0, access_token: 'selftest-token', expires_in: 7200 });
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, any>;
  if (ep === 'kf/sync_msg') {
    const from = Number(String(body.cursor ?? '').split(':')[1] ?? 0) || 0;
    const list = serverLog.slice(from);
    return res({ errcode: 0, next_cursor: `0:${from + list.length}`, has_more: 0, msg_list: list });
  }
  if (ep === 'kf/send_msg') {
    const to = String(body.touser);
    // 审查第 7 条（concurrency[3]）：send_msg 第一次回限流错误（逼出退避重试），退避期间模拟顾问接手（HTTP 发起、
    // 真实的网络等待能插进来，不止 microtask 的那一段）。第二次尝试之前 stillCurrent 应该拦住，不照发
    if (takeoverOnSend && takeoverOnSend.uid === to && !takeoverOnSend.fired) {
      takeoverOnSend.fired = true;
      tk.takeover(`wecom:${to}`, tk.sharedActor());
      return res({ errcode: 45009, errmsg: 'selftest: 限流重试' });
    }
    sent.push({ to, content: String(body.text?.content ?? body.link?.url ?? '') });
    return res({ errcode: 0 });
  }
  if (ep === 'kf/customer/batchget') return res({ errcode: 0, customer_list: [] });
  return res({ errcode: 40001, errmsg: `selftest: 未模拟的接口 ${ep}` });
}) as typeof fetch;

let seq = 0;
function customerMsg(uid: string, content: string, ageMs = 0, msgtype = 'text'): FakeMsg {
  seq += 1;
  return {
    msgid: `msg02-${seq}`,
    open_kfid: 'selftest-kf',
    external_userid: uid,
    send_time: Math.floor((Date.now() - ageMs) / 1000), // 企微的 send_time 是秒
    origin: 3,
    msgtype,
    ...(msgtype === 'text' ? { text: { content } } : {}),
  };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}
const sentTo = (to: string) => sent.filter((s) => s.to === to);
const idle = (): Promise<boolean> => waitFor(() => !__test.inspectForTest().busy);
/** 模拟进程重启：退出前的落盘照常做完，模块内存清空，盘上的状态文件保留 */
const restart = (): Promise<void> => __test.resetForTest();
const msgsOf = (uid: string) => getSession(`wecom:${uid}`)?.messages ?? [];
/** 把一条消息放进盘上的在途表：模拟进程死在处理它的半路上，cursor 已越过它，只能靠启动重放 */
function pendOnDisk(m: FakeMsg): void {
  const st = JSON.parse(fs.readFileSync(__test.STATE_FILE, 'utf8')) as { cursor?: string; handled?: [string, number][] };
  fs.writeFileSync(
    __test.STATE_FILE,
    json({ cursor: st.cursor, handled: [...(st.handled ?? []), [m.msgid, Date.now()]], pending: [{ msg: m, tries: 0 }] }),
  );
}

// 场景日志先收着：全过就不刷屏，有失败再倒出来
const logBuf: string[] = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error'] as const) {
  console[k] = (...args: unknown[]) => {
    logBuf.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : json(a))).join(' '));
  };
}

// ---------------- 文本消息：记下的客户消息带原消息的 msgid 与 sentAt ----------------
{
  const m = customerMsg('u02-text', '你好，想去云南看看', 90_000);
  serverLog.push(m);
  void syncFromCallback('tok02-text');
  await waitFor(() => sentTo('u02-text').length > 0);
  await idle();
  const said = msgsOf('u02-text').filter((x) => x.role === 'customer');
  check(
    '文本消息：记下的客户消息带原消息的 msgid，sentAt 是 send_time × 1000',
    said.length === 1 && said[0]!.msgid === m.msgid && said[0]!.sentAt === m.send_time * 1000,
    json(said),
  );
  check('文本消息：照常回复', sentTo('u02-text').length === 1);
}

// ---------------- 非文本消息：占位同样带 sentAt ----------------
{
  const m = customerMsg('u02-image', '', 30_000, 'image');
  serverLog.push(m);
  void syncFromCallback('tok02-image');
  await waitFor(() => sentTo('u02-image').length > 0);
  await idle();
  const said = msgsOf('u02-image').filter((x) => x.role === 'customer');
  check(
    '非文本消息：占位带原消息的 msgid，sentAt 是 send_time × 1000',
    said.length === 1 && said[0]!.content === '[图片]' && said[0]!.msgid === m.msgid && said[0]!.sentAt === m.send_time * 1000,
    json(said),
  );
}

// ---------------- 重放：原文相同、msgid 不同的是新消息 ----------------
// 客户发「好的」（A），AI 回了；客户又发一句「好的」（B），进程在 B 进引擎之前死了。只比原文的话会把 B 当成 A、重发回 A 的那条，B 没人回
{
  await restart();
  const a = customerMsg('u02-same', '好的', 120_000);
  const OLD = '（回 A 那句「好的」的回复）';
  const s = getOrCreateSession('wecom:u02-same', 'wecom');
  s.messages.push(
    { role: 'customer', content: '好的', at: Date.now() - 119_000, msgid: a.msgid, sentAt: a.send_time * 1000 },
    { role: 'agent', content: OLD, at: Date.now() - 118_000 },
  );
  saveSession(s);
  const b = customerMsg('u02-same', '好的');
  pendOnDisk(b);
  void syncFromCallback('tok02-same');
  await waitFor(() => sentTo('u02-same').length > 0);
  await idle();
  const msgs = msgsOf('u02-same');
  const said = msgs.filter((x) => x.role === 'customer');
  const replies = msgs.filter((x) => x.role === 'agent');
  check(
    '重放（原文相同、msgid 不同）：判成新消息，B 记下且带自己的 msgid 与 sentAt',
    said.length === 2 && said[1]!.msgid === b.msgid && said[1]!.sentAt === b.send_time * 1000,
    json(said),
  );
  check(
    '重放（原文相同、msgid 不同）：给 B 生成新回复，不重发回 A 的那条',
    replies.length === 2 && sentTo('u02-same').length === 1 && !sentTo('u02-same')[0]!.content.includes(OLD),
    json({ replies: replies.map((x) => x.content), sent: sentTo('u02-same') }),
  );
}

// ---------------- 重放：msgid 相同的是已记下的这句 ----------------
{
  await restart();
  const m = customerMsg('u02-recorded', '你好，想看看');
  const s = getOrCreateSession('wecom:u02-recorded', 'wecom');
  s.messages.push({ role: 'customer', content: '你好，想看看', at: Date.now(), msgid: m.msgid, sentAt: m.send_time * 1000 });
  saveSession(s);
  pendOnDisk(m);
  void syncFromCallback('tok02-recorded');
  await waitFor(() => sentTo('u02-recorded').length > 0);
  await idle();
  const msgs = msgsOf('u02-recorded');
  check(
    '重放（msgid 相同、回复未生成）：这句不再记一遍，生成一条回复、只发一次',
    msgs.filter((x) => x.role === 'customer').length === 1 &&
      msgs.filter((x) => x.role === 'agent').length === 1 &&
      sentTo('u02-recorded').length === 1,
    json(msgs.map((x) => [x.role, x.content, x.msgid])),
  );
}

// ---------------- 审查第 7 条（concurrency[3]）：sendText 退避重试期间被接手，不补发剩下的分段 ----------------
// 只在 sendRich 之前比一次接手代次挡不住这个窗口：send_msg 第一次回限流，退避等待时模拟 HTTP 发起的接手，
// 第二次尝试之前 stillCurrent() 应该拦住，不照发；会话记一条「本轮未发送（顾问已接手）」
{
  await restart();
  const uid = 'u02-takenover';
  takeoverOnSend = { uid, fired: false };
  const m = customerMsg(uid, '你好，想去云南看看');
  serverLog.push(m);
  void syncFromCallback('tok02-takenover');
  await waitFor(() => takeoverOnSend?.fired === true);
  await idle();
  const msgs = msgsOf(uid);
  check(
    '退避重试期间被接手：第一次限流之后不再重试，客户什么都没收到',
    sentTo(uid).length === 0,
    json({ sent: sentTo(uid), msgs: msgs.map((x) => [x.role, x.content]) }),
  );
  check(
    '退避重试期间被接手：会话记一条「本轮未发送（顾问已接手）」，不是通用的发送失败说明',
    msgs.some((x) => x.role === 'system' && x.content === tk.TAKEN_OVER_NOTE) &&
      !msgs.some((x) => x.role === 'system' && x.content.includes('企微发送失败')),
    json(msgs.map((x) => [x.role, x.content])),
  );
  takeoverOnSend = null;
}

Object.assign(console, origConsole);
if (fails.length) {
  console.error('---- 场景日志（最近 40 行）----');
  for (const l of logBuf.slice(-40)) console.error('  ' + l);
  console.error(`WECOM-02 SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `WECOM-02 SELFTEST PASS: ${pass} 项断言全通（文本消息的 msgid 与 sentAt / 非文本占位的 sentAt / 重放按 msgid 对齐 / 退避重试期间被接手不补发）`,
);
process.exit(0);
