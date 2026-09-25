// 企微适配器自测：发送链路的纯函数 + 同步/停机/重放的可靠性（假 fetch 驱动，不连企微、不调真实 LLM）。
// 这几条都是"实机才看得见、看不见就以为没事"的坑，必须有断言钉住：
//   · 分段把 URL 从中间劈开 → 客户收到两条点不开的残缺网址
//   · 按整行剥离链接 → 报价/支付链接被连带吞掉
//   · 一条消息里两个链接硬做卡片 → 第二条（往往是支付链接）永久丢失
//   · markdown 原样发出 → 微信不渲染，客户看到一堆 ** 和 #；去得太狠 → 价格、链接、句中的 # 被误伤
//   · 状态文件丢失/损坏 → 把近 3 天的旧消息全回一遍
//   · 同步锁包住 LLM 处理 → 一个客户的慢回复拖住所有人，新客户欢迎语过期
//   · SIGTERM 立即退出 → 处理到一半的消息重启后被当成「已处理」，客户永远等不到回复
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 必须隔离数据目录：extractCard 会经 store 查订单，而 store 在模块加载时就取 VAR_DIR。
// 不隔离的话，跑一次自测就会触发真实 var/ 里的 demo 保鲜并重写 sessions.json。
// 外部给了 VAR_DIR 也在其下新建子目录：下面的场景要求从「没有状态文件」开始。
{
  const base = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  process.env.VAR_DIR = fs.mkdtempSync(path.join(base, 'wecom-selftest-'));
}
const VAR_DIR = process.env.VAR_DIR;
process.env.LLM_MOCK = '1'; // 引擎走离线脚本，绝不调真实模型
// 占位凭据：只为让 readConfig() 认为企微已配置，请求全部被下面的假 fetch 接住
process.env.WECOM_CORP_ID = 'selftest-corp';
process.env.WECOM_APP_SECRET = 'selftest-secret';
process.env.WECOM_KF_OPEN_KFID = 'selftest-kf';
process.env.PUBLIC_BASE_URL = ''; // 不走链接卡片（缩略图上传），测试只关心文本收发

const { __test, syncFromCallback, wecomAdapter } = await import('./wecom.js');
const { runShutdownHooks, getSession, getOrCreateSession, saveSession, createOrder } = await import('../store.js');

const { splitForWecom, extractCard, stripLink, wechatify } = __test;
const BASE = 'https://travel.example.com'; // 占位域名：自测只关心 URL 形态，与真实部署无关

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------- 分段：不得劈开 URL ----------------
{
  const url = `${BASE}/proposal/r-guizhou/2`;
  // 构造 URL 恰好横跨 2000 字节边界的正文（无换行，逼分段器走字节收敛路径）
  for (let padLen = 1900; padLen <= 2100; padLen += 1) {
    const text = '啊'.repeat(Math.floor(padLen / 3)) + url + '后面还有很多字'.repeat(60);
    const chunks = splitForWecom(text);
    const broken = chunks.some((c) => {
      const i = c.indexOf('/proposal/');
      return i >= 0 && !c.includes(url); // 出现了 /proposal/ 却不是完整 URL
    });
    check('分段不劈开 URL', !broken, `padLen=${padLen}`);
    if (broken) break;
  }
}

// ---------------- 分段：不得劈开代理对 ----------------
{
  for (let padLen = 1980; padLen <= 2020; padLen += 1) {
    const text = '啊'.repeat(Math.floor(padLen / 3)) + '🎉'.repeat(40) + '收尾'.repeat(400);
    const chunks = splitForWecom(text);
    const lone = chunks.some((c) => {
      const last = c.charCodeAt(c.length - 1);
      const first = c.charCodeAt(0);
      return (last >= 0xd800 && last <= 0xdbff) || (first >= 0xdc00 && first <= 0xdfff);
    });
    check('分段不劈开 emoji', !lone, `padLen=${padLen}`);
    if (lone) break;
  }
}

// ---------------- 分段：每段都不超字节上限，且不丢内容 ----------------
{
  const text = '云途定制旅行的行程说明'.repeat(900);
  const chunks = splitForWecom(text);
  check(
    '每段不超 2000 字节',
    chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 2000),
  );
  check('分段不丢字符', chunks.join('').replace(/\s/g, '') === text.replace(/\s/g, ''));
}

// ---------------- extractCard：单条链接才做卡片 ----------------
{
  const one = `方案书给您生成好了：${BASE}/proposal/r-guizhou/2 您先看看`;
  const card = extractCard(one, BASE);
  check('单条方案书链接可做卡片', !!card && card.url === `${BASE}/proposal/r-guizhou/2`);
  check('卡片标题带线路名', !!card && card.title.includes('行程方案书'));
}
{
  // 同一条消息里方案书 + 支付链接：硬做卡片会让支付链接在剥离正文时被吞掉
  const two = `方案在这 ${BASE}/proposal/r-guizhou/2\n确认后点这里付款 ${BASE}/pay/o-abc123`;
  check('多条链接时不做卡片', extractCard(two, BASE) === null);
}
{
  const two = `方案A ${BASE}/proposal/r-guizhou/2\n方案B ${BASE}/proposal/r-yunnan/2`;
  check('两条方案书时不做卡片', extractCard(two, BASE) === null);
}
{
  check('无链接时不做卡片', extractCard('您好，想去哪儿玩呢', BASE) === null);
  check('未知线路不做卡片', extractCard(`${BASE}/proposal/r-nonexistent/2`, BASE) === null);
}

// ---------------- 正文剥离：只挖 URL，不删整行 ----------------
{
  const body = `方案书已生成：${BASE}/proposal/r-guizhou/2 人均 15,800，两位合计 31,600`;
  const card = extractCard(body, BASE);
  const prose = card ? stripLink(body, card.raw) : '';
  check('剥离后保留同行报价', prose.includes('15,800') && prose.includes('31,600'), `得到「${prose}」`);
  check('剥离后不留裸 URL', !prose.includes('/proposal/'), `得到「${prose}」`);
}
{
  // 链接独占一行时，该行应整体消失而不是留下空行
  const body = `方案书给您了，点开看逐日行程：\n\n${BASE}/proposal/r-guizhou/2\n\n有问题随时问我`;
  const card = extractCard(body, BASE);
  const prose = card ? stripLink(body, card.raw) : '';
  check('独占行剥离后无空行残留', !/\n\s*\n\s*\n/.test(prose) && !prose.includes('/proposal/'), `得到「${prose}」`);
  check('独占行剥离保留前后文', prose.includes('逐日行程') && prose.includes('随时问我'));
}
{
  // 引擎出口修补后的样子（engine.ts repairLinks / putLink）：链接插在承诺句或占位符处、独占到行尾。
  // 三条是盲评里真实回复修补后的原文，渠道层要能认出唯一那条链接做卡片，剥离时不吞正文
  const cases: [string, string, string][] = [
    [
      's01',
      '我先把这条6日亲子线的详细方案发您看看，里面有逐日行程、住宿、含餐和费用明细：\n/proposal/r-sichuan-mid/3\n\n您看完行程觉得天数合适的话，我给您出个国庆的准确报价。',
      '/proposal/r-sichuan-mid/3',
    ],
    [
      's06',
      '报价出来了：\n\n· 云南 丽江大理·洱海古城 6 日\n· 每人 16800 起\n· 2 人总价 33600\n· 起价，按最终行程微调\n\n完整方案书也给您生成好了，逐日行程、住宿、含餐和费用明细都在链接里，您先看看～\n/proposal/r-yunnan-mid/2',
      '/proposal/r-yunnan-mid/2',
    ],
    [
      's11',
      '好嘞，我把完整方案书发您，方便您转给家里人看：\n\n👉 /proposal/r-beijing/2\n逐日行程、每晚住宿、含餐情况、费用包含与不含项都在里面，报价也附了。\n\n您和家人看完有任何想调的地方，随时跟我说。',
      '/proposal/r-beijing/2',
    ],
  ];
  const prose: Record<string, string> = {};
  for (const [name, body, url] of cases) {
    const card = extractCard(body, BASE);
    check(`${name} 修补后的链接能做成卡片`, card?.url === BASE + url, `得到「${card?.url}」`);
    prose[name] = card ? stripLink(body, card.raw) : '';
    check(`${name} 剥离后正文不留链接`, !prose[name].includes('/proposal/') && !!prose[name], `得到「${prose[name]}」`);
  }
  check(
    's06 剥离链接后报价还在',
    prose.s06.includes('16800') && prose.s06.includes('33600') && prose.s06.includes('您先看看'),
    `得到「${prose.s06}」`,
  );
  check('s11 只剩「👉」的那行一起拿掉', !prose.s11.includes('👉') && prose.s11.includes('报价也附了'), `得到「${prose.s11}」`);
  // 冒号原本指着那条链接；链接改走卡片后留着冒号，读起来就是「明细：」后面接了一句不相干的话
  check('s01 指向链接的冒号换成句号', prose.s01.includes('费用明细。') && prose.s01.includes('国庆的准确报价'), `得到「${prose.s01}」`);
  // 同行还有别的内容时上一行的冒号照旧，只动链接所在的这一行（「方案」是给链接起的名字，改成指着卡片）
  const sameLine = stripLink(`报价如下：\n方案 ${BASE}/proposal/r-guizhou/2 人均 15,800`, `${BASE}/proposal/r-guizhou/2`);
  check('同行有正文时不动前一行', sameLine === '报价如下：\n方案见下方卡片，人均 15,800', `得到「${sameLine}」`);
}

// ---------------- 正文剥离：指着链接的标签/指代句不能留下指向空气 ----------------
// 用户实测（按线上配置重放 c1/c4 + 线上一条）的原文照搬。卡片要等整段正文发完才作为下一条到达，
// 客户读到单独一行「· 支付链接」「详细方案书在这儿」，以为链接漏发了。
// 每条写成「原文里哪一段 → 应变成什么」，其余正文必须一字不动。
const LEFTOVER_CASES: [name: string, body: string, from: string, to: string][] = [
  [
    'c1 第2遍 · 支付链接',
    '订单已为您创建好啦 🎉\n\n· 线路：三亚亲子奢华度假 5 日\n· 出发：10月12日，两位\n· 总价：34760 元\n· 支付链接：/pay/ord_e8a7aafbdd9632e75725f076\n\n名额以付款为准，付好后会有专属顾问联系您发行程确认书，拉服务群对接细节～',
    '· 支付链接：/pay/ord_e8a7aafbdd9632e75725f076\n',
    '',
  ],
  [
    'c1 第3遍 独占一段的支付链接',
    '帮您订好了！🎉\n\n三亚亲子奢华度假 5 日，两位\n10月12日出发，总价 34760 元\n\n支付链接：/pay/ord_363898bc8dbe8dde2291b840\n\n名额以付款为准，付完款后顾问会把行程确认书发您，再拉个服务群，出行前有任何问题随时找我～',
    '支付链接：/pay/ord_363898bc8dbe8dde2291b840\n\n',
    '',
  ],
  [
    'c4 第1遍 上一行「在这儿」',
    '贵州这条 6 天线正合适：荔波小七孔 + 西江千户苗寨，两个人出行。\n\n· 小七孔开园首波入园，卧龙潭拍慢门流水不用抢机位\n· 瑶山古寨看白裤瑶猴鼓舞，亲手做一方靛蓝染布\n· 宿丹寨温泉酒店，五星精选标准\n\n详细方案书在这儿，逐日行程、住宿、含餐、费用含不含都在里面：\n/proposal/r-guizhou/2\n\n人均 15800 起，两人合计 31600 起（标准价）。您大概几号出发？旺季价格会有浮动，我按日期给您出准确报价。',
    '详细方案书在这儿，逐日行程、住宿、含餐、费用含不含都在里面：\n/proposal/r-guizhou/2\n',
    '详细方案书见下方卡片，逐日行程、住宿、含餐、费用含不含都在里面。\n',
  ],
  [
    'c4 第2遍 同行「发您」',
    '找到一条正好 6 天的贵州线路：荔波小七孔·西江千户苗寨 6 日\n\n详细方案书发您：/proposal/r-guizhou/2\n里面有逐日行程、住宿、含餐、费用含与不含，和报价（人均 15800 起，两位共 31600）。\n\n亮点：\n· 小七孔开园首波入园，卧龙潭拍慢门流水\n· 瑶山古寨体验白裤瑶蜡染，收一方自染方巾\n· 全程五星精选酒店，含丹寨温泉酒店\n\n您计划几号出发？旺季和淡季价格会有差别，我按日期给您出准确报价。',
    '详细方案书发您：/proposal/r-guizhou/2',
    '详细方案书发您，见下方卡片',
  ],
  [
    'c4 第3遍 同行「在这里」',
    '正好有条 6 天的，和您的天数完全对上。\n\n贵州 荔波小七孔·西江千户苗寨 6 日（两人）\n\n亮点：\n· 小七孔开园首波入园，卧龙潭拍慢门流水\n· 瑶山古寨白裤瑶蜡染手作，傍晚看猴鼓舞\n· 石桥村古法造纸，宿丹寨温泉酒店\n\n详细行程计划书在这里：/proposal/r-guizhou/2\n里面有逐日行程、住宿、含餐和费用说明，您先过一遍。\n\n计划书里按标准价显示人均 15800 起，两人共 31600 起。您计划几号出发？国庆前后是旺季，我可以按具体日期给您出准确报价。',
    '详细行程计划书在这里：/proposal/r-guizhou/2',
    '详细行程计划书见下方卡片',
  ],
  [
    '线上 上一行「做好了」',
    '正好，我们有一条 6 天的贵州线路，跟您需求完全对上，详细方案给您做好了：\n\n/proposal/r-guizhou/2\n贵州 荔波小七孔·西江千户苗寨 6 日，两人出行\n\n里面包含逐日行程、住宿、含餐和费用明细。亮点几个：\n· 小七孔开园首波入园，卧龙潭拍慢门流水\n· 瑶山古寨白裤瑶蜡染手作体验\n· 入住丹寨温泉酒店\n\n人均 15800 起，总价 31600（标准价，按最终行程微调）。\n\n您大概几号出发？旺季日期价格会有浮动，我按日期给您出准确报价。',
    '详细方案给您做好了：\n\n/proposal/r-guizhou/2\n',
    '详细方案给您做好了，见下方卡片。\n\n',
  ],
  // 下面几条不是实测原文：点这里 → 点下方卡片；标签后面还跟着实际内容的不能整行删，标签改成指着卡片
  ['点这里付款', '确认无误的话点这里付款：/pay/ord_x1\n名额以付款为准', '点这里付款：/pay/ord_x1', '点下方卡片付款'],
  [
    '标签后还有内容',
    '· 支付链接：/pay/ord_x2（24 小时内有效）',
    '· 支付链接：/pay/ord_x2（24 小时内有效）',
    '· 支付链接见下方卡片（24 小时内有效）',
  ],
  ['标签后接逗号', '支付链接：/pay/ord_x3，30 分钟内有效', '支付链接：/pay/ord_x3', '支付链接见下方卡片'],
  ['标签后隔空格接括号', '· 支付链接：/pay/ord_x4 （30 分钟内有效）', '：/pay/ord_x4 ', '见下方卡片'],
  // 标签单独一行、链接换到下一行（模型发方案书时常这么排）：标签那行一起拿掉，不能剩「· 支付链接。」
  ['上一行是标签', '· 总价：34760 元\n· 支付链接：\n/pay/ord_a1\n\n名额以付款为准', '· 支付链接：\n/pay/ord_a1\n', ''],
  ['上一行是方案书标签', '亮点如下\n\n详细方案书：\n/proposal/r-guizhou/2\n\n人均 15800 起', '详细方案书：\n/proposal/r-guizhou/2\n\n', ''],
  ['上一行是标签、链接前有 👉', '订单已创建～\n付款入口：\n👉 /pay/ord_a5\n名额以付款为准', '付款入口：\n👉 /pay/ord_a5\n', ''],
  // 上一行没冒号、但在指着链接
  ['上一行「发您」无冒号', '详细方案书发您\n/proposal/r-guizhou/2\n人均 15800 起', '发您\n/proposal/r-guizhou/2', '发您，见下方卡片'],
  ['上一行无关（景点）不动', '推荐几个景点\n/proposal/r-guizhou/2\n人均 15800 起', '\n/proposal/r-guizhou/2', ''],
  // 紧挨着链接的指向符号、结尾表情
  ['链接后的 👈', '方案书在这儿：/proposal/r-guizhou/2 👈\n人均 15800 起', '在这儿：/proposal/r-guizhou/2 👈', '见下方卡片'],
  ['链接后的表情不加逗号', '详细方案发您 /proposal/r-guizhou/2 😊', '详细方案发您 /proposal/r-guizhou/2 😊', '详细方案发您，见下方卡片 😊'],
  ['链接前的 👉', '点这里付款 👉 /pay/ord_a6\n名额以付款为准', '点这里付款 👉 /pay/ord_a6', '点下方卡片付款'],
  // 标签的其他说法
  ['👉 立即支付', '订单已创建～\n👉 立即支付：/pay/ord_a7\n名额以付款为准', '👉 立即支付：/pay/ord_a7\n', ''],
  ['您的专属支付链接', '订单已创建～\n这是您的专属支付链接：/pay/ord_a8\n名额以付款为准', '这是您的专属支付链接：/pay/ord_a8\n', ''],
  ['订单支付链接', '订单已创建～\n· 订单支付链接：/pay/ord_a9\n名额以付款为准', '· 订单支付链接：/pay/ord_a9\n', ''],
  ['行程标签', '贵州这条很合适～\n行程：/proposal/r-guizhou/2\n人均 15800 起', '行程：/proposal/r-guizhou/2\n', ''],
  // 带序号的整行删会断号，改成指着卡片
  ['带序号的标签', '1. 线路：三亚 5 日\n2. 支付链接：/pay/ord_b1\n3. 名额以付款为准', '：/pay/ord_b1', '见下方卡片'],
  ['点击此处', '请点击此处付款：/pay/ord_b2\n名额以付款为准', '点击此处付款：/pay/ord_b2', '点下方卡片付款'],
  ['付款请点', '付款请点：/pay/ord_b3\n名额以付款为准', '付款请点：/pay/ord_b3', '付款请点下方卡片'],
  // 标签带括注（A09/C03 实测 4 次）：此前认不出是标签，链接挖走后留下一行「支付链接（名额以付款为准）。」
  [
    'A09 上一行是带括注的标签',
    '订单已生成，10 月 24 日出发，4 位，总价 70224 元。\n\n支付链接（名额以付款为准）：\n/pay/ord_ad46bb1229d8568b9839774e\n\n付款后顾问会在微信上联系您，发行程确认书并拉服务群。',
    '支付链接（名额以付款为准）：\n/pay/ord_ad46bb1229d8568b9839774e\n',
    '支付链接见下方卡片（名额以付款为准）\n',
  ],
  [
    '上一行是带括注和句号的标签',
    '订单已生成～\n支付链接（名额以付款为准）。\n/pay/ord_c2\n付款后顾问会发确认书',
    '支付链接（名额以付款为准）。\n/pay/ord_c2',
    '支付链接见下方卡片（名额以付款为准）',
  ],
  [
    '同行是带括注的标签',
    '订单已生成～\n支付链接（名额以付款为准）：/pay/ord_c3\n付款后顾问会发确认书',
    '支付链接（名额以付款为准）：/pay/ord_c3',
    '支付链接见下方卡片（名额以付款为准）',
  ],
  [
    '带序号、带括注的标签',
    '1. 线路：三亚 5 日\n2. 支付链接（24 小时内有效）：/pay/ord_c4\n3. 名额以付款为准',
    '支付链接（24 小时内有效）：/pay/ord_c4',
    '支付链接见下方卡片（24 小时内有效）',
  ],
];
const SITE_LINK = /(?:https?:\/\/[^\s]*)?\/(?:proposal|pay)\/[A-Za-z0-9_-]+(?:\/[\d-]+)*/;
for (const [name, body, from, to] of LEFTOVER_CASES) {
  const raw = body.match(SITE_LINK)![0];
  if (raw.startsWith('/proposal/')) check(`${name} 能做成卡片`, extractCard(body, BASE)?.raw === raw);
  const want = body.replace(from, to);
  const got = stripLink(body, raw);
  check(`${name} 剥离后不留指向空气的标签/指代`, body.includes(from) && got === want, `得到「${got}」`);
  check(`${name}「见下方卡片」不重复`, (got.match(/见下方卡片/g) ?? []).length <= 1, `得到「${got}」`);
}

// 网页模拟器（public/chat.html）有同一逻辑的副本，支付卡片同样排在正文之后：
// 两边规则一旦分叉，同一条回复在网页和微信里读起来就不一样。拿页面里的函数真跑一遍对照
{
  const chat = fs.readFileSync(path.resolve('public/chat.html'), 'utf8');
  const fnSrc = /function stripLink\(body, raw\) \{[\s\S]*?\n {2}\}/.exec(chat)?.[0];
  check('chat.html 有 stripLink()', !!fnSrc);
  if (fnSrc) {
    const webStrip = new Function(`${fnSrc}; return stripLink;`)() as (b: string, r: string) => string;
    for (const [name, body] of LEFTOVER_CASES) {
      const raw = body.match(SITE_LINK)![0];
      check(`${name} 网页与企微剥离结果一致`, webStrip(body, raw) === stripLink(body, raw), `网页「${webStrip(body, raw)}」`);
    }
  }
}

// ---------------- 支付卡片摘要的出发日期 ----------------
// 正文写「10月12日出发」，紧跟的卡片却是「2026-10-12 出发」，像系统单据（实测 c1 第2、3遍）
{
  const y = new Date().getFullYear();
  const mk = (departDate: string) =>
    createOrder({
      sessionId: 'wecom:selftest-card',
      routeId: 'r-sanya',
      routeTitle: '三亚亲子奢华度假 5 日',
      travelers: 2,
      departDate,
      totalPrice: 34760,
    });
  const same = extractCard(`· 支付链接：/pay/${mk(`${y}-10-12`).id}`, BASE);
  check('支付卡片日期写成「10月12日出发」', same?.desc === '2 位出行 · 10月12日出发 · 合计 ¥34,760', `得到「${same?.desc}」`);
  const next = extractCard(`· 支付链接：/pay/${mk(`${y + 1}-01-05`).id}`, BASE);
  check('跨年的出发日期带年份', next?.desc === `2 位出行 · ${y + 1}年1月5日出发 · 合计 ¥34,760`, `得到「${next?.desc}」`);
}

// ---------------- 去 markdown：微信客服是纯文本，符号会原样露给客户 ----------------
// wechatify 是企微出口的最后一道（spec 不变量 21 的企微部分）。引擎出口只去 `**`、「# 」和 -/* 列表符，
// 不带空格的「#标题」、斜体、代码围栏、行内代码、当列表符用的 emoji 都靠这里。
// 每条写成「模型原文 → 客户收到的正文」，整条比对；列表符统一换成「·」。
const MARKDOWN_CASES: [name: string, input: string, want: string][] = [
  ['加粗', '人均 **15,800** 起，**两人合计 31,600**', '人均 15,800 起，两人合计 31,600'],
  ['「# 标题」井号后带空格', '# 贵州 6 日行程\n第一天抵达贵阳', '贵州 6 日行程\n第一天抵达贵阳'],
  ['「#标题」井号后不带空格', '#贵州 6 日行程\n第一天抵达贵阳', '贵州 6 日行程\n第一天抵达贵阳'],
  ['多级标题', '## 行程亮点\n### 第一天', '行程亮点\n第一天'],
  ['斜体', '国庆是*旺季*，价格会上浮', '国庆是旺季，价格会上浮'],
  [
    '代码围栏只去围栏行、保留内容',
    '订单信息如下：\n```\n线路：三亚 5 日\n```\n名额以付款为准',
    '订单信息如下：\n\n线路：三亚 5 日\n\n名额以付款为准',
  ],
  ['带语言标记的代码围栏', '```text\n出发：10月12日\n```', '出发：10月12日'],
  ['行内代码', '订单号是 `ord_x1`，付款后顾问联系您', '订单号是 ord_x1，付款后顾问联系您'],
  ['行首 emoji 当列表符', '🌟 小七孔开园首波入园\n🏨 宿丹寨温泉酒店', '· 小七孔开园首波入园\n· 宿丹寨温泉酒店'],
  ['行首带变体选择符的 emoji 当列表符', '✈️ 贵阳直飞往返\n☀️ 十月天气晴好', '· 贵阳直飞往返\n· 十月天气晴好'],
  ['行首 - / * 列表符', '- 含早餐\n* 含门票', '· 含早餐\n· 含门票'],
  ['多余空行折叠成一个', '第一段\n\n\n\n第二段', '第一段\n\n第二段'],
  [
    '整段混排',
    '## 贵州 6 日方案\n\n**亮点**\n- 小七孔开园首波入园\n- 宿丹寨温泉酒店\n\n#费用\n人均 15,800 起',
    '贵州 6 日方案\n\n亮点\n· 小七孔开园首波入园\n· 宿丹寨温泉酒店\n\n费用\n人均 15,800 起',
  ],
];
for (const [name, input, want] of MARKDOWN_CASES) {
  const got = wechatify(input);
  check(`去 markdown：${name}`, got === want, `得到「${got}」`);
}
// 去得太狠同样是事故：价格、链接、时间、句中的 # 和 emoji 被吃掉，客户读到的就是错的
const PLAIN_CASES: [name: string, text: string][] = [
  ['句中的 #', '房间号 #1203，下午 3:00 入住'],
  ['价格与千分位', '人均 ¥15,800 起，两人合计 ¥31,600（含税）'],
  ['站内链接与完整 URL', '支付链接：/pay/ord_x1，方案书：https://travel.example.com/proposal/r-guizhou/2/2026-10-12'],
  ['日期与时间', '10月12日 08:30 集合，18:00 前返回酒店'],
  ['中文标点', '好的！国庆人多——建议早订；「标准间」含早餐……名额以付款为准。'],
  ['句中 emoji', '订好啦 🎉 祝旅途愉快～'],
  ['行首 emoji 后不跟空格', '🎉订单已创建'],
  ['行首的负号', '-5℃ 的早晚要带羽绒服'],
  ['段落间的空行', '第一段\n\n第二段'],
  // 订单号里的下划线：一行有两个时，按 _斜体_ 去符号就会把两个 id 之间的内容当斜体、把链接吃坏
  ['同一行两个带下划线的订单号', '支付链接：/pay/ord_a1 和 /pay/ord_b2'],
  // 去 markdown 的规则都锚在行首，价格、时间、中文标点放在行首才真正经过它们；
  // 行首的 ……/—— 落在「emoji 当列表符」的码位范围里，后面不跟空格就不能被换成「·」
  ['行首的价格', '¥15,800 起，两人合计 ¥31,600'],
  ['行首的时间', '08:30 集合，18:00 前返回酒店'],
  ['行首的中文标点', '……名额以付款为准\n——国庆人多，建议早订\n「标准间」含早餐'],
];
for (const [name, text] of PLAIN_CASES) {
  const got = wechatify(text);
  check(`去 markdown 不误伤正文：${name}`, got === text, `得到「${got}」`);
}

// ======================================================================
// 以下是同步 / 停机 / 重放的可靠性场景：用假 fetch 模拟企微服务端。
// sync_msg 按 cursor 返回「服务端日志」里 cursor 之后的消息——和真实企微一样，
// cursor 一旦推进，之前的消息再也拉不到，这正是在途消息必须带原文落盘的原因。
// ======================================================================

interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string };
  event?: { event_type: string; welcome_code?: string; external_userid: string };
}
interface Sent {
  to: string;
  content: string;
}

let serverGen = 0; // 换一代 = 服务端日志清空，旧 cursor 作废
let serverLog: FakeMsg[] = [];
let syncCalls = 0;
const started: Sent[] = []; // 发起的 send_msg（含卡住未返回的）
const sent: Sent[] = []; // 成功返回的 send_msg / send_msg_on_event
const holds = new Map<string, Promise<void>>(); // 发给该客户的 send_msg 等到 promise 放行才返回
const hangOnce = new Set<string>(); // 发给该客户的下一次 send_msg 永不返回（模拟进程死在发送途中）

function resetServer(): void {
  serverGen += 1;
  serverLog = [];
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const ep = new URL(String(input)).pathname.replace(/^\/cgi-bin\//, '');
  const json = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (ep === 'gettoken') return json({ errcode: 0, access_token: 'selftest-token', expires_in: 7200 });
  // 缩略图上传一律失败：卡片发不出去时的退路见下方「缩略图传不上去」
  if (ep === 'media/upload') return json({ errcode: 40004, errmsg: 'selftest: 缩略图上传失败' });
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, any>;
  if (ep === 'kf/sync_msg') {
    syncCalls += 1;
    const [g, i] = String(body.cursor ?? '').split(':');
    const from = Number(g) === serverGen ? Number(i) : 0;
    const list = serverLog.slice(from);
    return json({ errcode: 0, next_cursor: `${serverGen}:${from + list.length}`, has_more: 0, msg_list: list });
  }
  if (ep === 'kf/send_msg') {
    const item = { to: String(body.touser), content: String(body.text?.content ?? body.link?.url ?? '') };
    started.push(item);
    if (hangOnce.delete(item.to)) return new Promise<Response>(() => {});
    await holds.get(item.to);
    sent.push(item);
    return json({ errcode: 0 });
  }
  if (ep === 'kf/send_msg_on_event') {
    sent.push({ to: `code:${body.code}`, content: String(body.text?.content ?? '') });
    return json({ errcode: 0 });
  }
  if (ep === 'kf/customer/batchget') return json({ errcode: 0, customer_list: [] });
  return json({ errcode: 40001, errmsg: `selftest: 未模拟的接口 ${ep}` });
}) as typeof fetch;

// ---------------- 缩略图传不上去：正文原样发（链接留在原处），不能说「见下方卡片」 ----------------
// 此前先发了改成「见下方卡片」的正文才去传缩略图；缩略图一失败（假服务端对 media/upload 回错误码），
// 客户读到「见下方卡片」，下方却是一条纯文本链接
{
  process.env.PUBLIC_BASE_URL = BASE;
  const from = sent.length;
  const body = '详细方案书在这儿，逐日行程都在里面：\n/proposal/r-guizhou/2\n\n人均 15800 起';
  const ok = await wecomAdapter.push('wecom:u-thumbfail', body);
  process.env.PUBLIC_BASE_URL = '';
  const msgs = sent
    .slice(from)
    .filter((m) => m.to === 'u-thumbfail')
    .map((m) => m.content);
  check('缩略图失败：照样送达', ok);
  check('缩略图失败：正文不提卡片', msgs.length > 0 && msgs.every((m) => !m.includes('卡片')), JSON.stringify(msgs));
  check(
    '缩略图失败：一条消息、链接留在原处',
    msgs.length === 1 && msgs[0] === body.replace('/proposal/', `${BASE}/proposal/`),
    JSON.stringify(msgs),
  );
}

let seq = 0;
function customerMsg(uid: string, content: string, ageMs = 0, msgtype = 'text'): FakeMsg {
  seq += 1;
  return {
    msgid: `msg-${seq}`,
    open_kfid: 'selftest-kf',
    external_userid: uid,
    send_time: Math.floor((Date.now() - ageMs) / 1000),
    origin: 3,
    msgtype,
    ...(msgtype === 'text' ? { text: { content } } : {}),
  };
}
function enterEvent(uid: string, welcomeCode?: string, ageMs = 0): FakeMsg {
  seq += 1;
  return {
    msgid: `evt-${seq}`,
    open_kfid: 'selftest-kf',
    external_userid: uid,
    send_time: Math.floor((Date.now() - ageMs) / 1000),
    origin: 4,
    msgtype: 'event',
    event: { event_type: 'enter_session', welcome_code: welcomeCode, external_userid: uid },
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
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const sentTo = (to: string): Sent[] => sent.filter((s) => s.to === to);
const startedTo = (to: string): Sent[] => started.filter((s) => s.to === to);
const inspect = __test.inspectForTest;
const idle = (): Promise<boolean> => waitFor(() => !inspect().busy);
/** 模拟进程重启：退出前的落盘照常做完，模块内存清空，盘上的状态文件保留 */
const restart = (): Promise<void> => __test.resetForTest();

interface DiskState {
  cursor: string;
  handled: [string, number][];
  pending?: { msg: FakeMsg; tries: number }[];
}
function readState(): DiskState | null {
  try {
    return JSON.parse(fs.readFileSync(__test.STATE_FILE, 'utf8')) as DiskState;
  } catch {
    return null;
  }
}
const pendingIds = (st: DiskState | null): string[] => (st?.pending ?? []).map((p) => p.msg.msgid);

// 场景日志先收着：全过就不刷屏，有失败再倒出来帮助定位
const logBuf: string[] = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error'] as const) {
  console[k] = (...args: unknown[]) => {
    logBuf.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

// ---------------- W3 冷启动：状态文件缺失 ----------------
// 全新目录、没有状态文件 → sync_msg 不带 cursor 会拉回近 3 天全部消息
{
  const old = customerMsg('u-old', '有新疆的线路吗', 40 * 3600_000);
  const oldEnter = enterEvent('u-old-enter', undefined, 30 * 3600_000);
  const fresh = customerMsg('u-fresh', '你好', 60_000);
  serverLog.push(old, oldEnter, fresh);
  void syncFromCallback('tok-cold-1');
  await waitFor(() => sentTo('u-fresh').length > 0);
  await idle();
  check('冷启动（无状态文件）：启动前很久的客户消息不回复', sentTo('u-old').length === 0);
  check('冷启动（无状态文件）：不给 3 天前扫过码的人补发欢迎', sentTo('u-old-enter').length === 0);
  check('冷启动（无状态文件）：启动前 10 分钟内的消息照常回复', sentTo('u-fresh').length === 1);
  check('冷启动：跳过的旧消息记为已处理', inspect().handled.includes(old.msgid) && inspect().handled.includes(oldEnter.msgid));
  check('冷启动后拿到 cursor 并落盘', !!readState()?.cursor);
}

// ---------------- W3 冷启动：状态文件损坏 ----------------
{
  resetServer();
  await restart();
  fs.writeFileSync(__test.STATE_FILE, '{"cursor":"x:9","handled":[["msg-'); // 半截 JSON
  const old = customerMsg('u-old-2', '有新疆的线路吗', 40 * 3600_000);
  const fresh = customerMsg('u-fresh-2', '你好', 60_000);
  serverLog.push(old, fresh);
  void syncFromCallback('tok-cold-2');
  await waitFor(() => sentTo('u-fresh-2').length > 0);
  await idle();
  check(
    '损坏的状态文件改名 .corrupt-* 留现场',
    fs.readdirSync(VAR_DIR).some((f) => f.startsWith('wecom-cursor.json.corrupt-')),
  );
  check('状态文件损坏按冷启动处理', inspect().coldStart);
  check('冷启动（文件损坏）：旧消息不回复、新消息照常回复', sentTo('u-old-2').length === 0 && sentTo('u-fresh-2').length === 1);
}

// ---------------- W3 反面：有 cursor 的正常重启不能误伤旧消息 ----------------
// 停机两天后重启，cursor 之后积压的客户消息仍要回复（那是真没回过的）
{
  await restart();
  const late = customerMsg('u-backlog', '你好', 30 * 3600_000);
  serverLog.push(late);
  void syncFromCallback('tok-warm');
  await waitFor(() => sentTo('u-backlog').length > 0);
  await idle();
  check('有 cursor 时不是冷启动', !inspect().coldStart);
  check('有 cursor 时积压的旧消息照常回复', sentTo('u-backlog').length === 1);
}

// ---------------- W2 跨客户不排队：A 卡在发送时 B 和新客户的欢迎语照常走 ----------------
{
  const holdA = deferred();
  holds.set('u-a', holdA.promise);
  serverLog.push(customerMsg('u-a', '你好，想出去玩'));
  void syncFromCallback('tok-a');
  await waitFor(() => startedTo('u-a').length > 0);
  serverLog.push(customerMsg('u-b', '在吗'), enterEvent('u-c', 'welcome-code-c'));
  void syncFromCallback('tok-b');
  const fast = await waitFor(() => sentTo('u-b').length > 0 && sentTo('code:welcome-code-c').length > 0, 1500);
  check('跨批次不排队：A 的回复卡住时 B 照常收到回复、新客户照常收到欢迎语', fast);
  check('（前提）B 回复时 A 仍卡在发送', sentTo('u-a').length === 0);
  holdA.resolve();
  holds.delete('u-a');
  await waitFor(() => sentTo('u-a').length > 0);
  await idle();
  check('A 放行后照常送达', sentTo('u-a').length === 1);
}

// ---------------- W2 同客户保序：前一条没发完，后一条不抢先 ----------------
{
  const holdD = deferred();
  holds.set('u-d', holdD.promise);
  serverLog.push(customerMsg('u-d', '你好'));
  void syncFromCallback('tok-d1');
  await waitFor(() => startedTo('u-d').length > 0);
  serverLog.push(customerMsg('u-d', '', 0, 'image')); // 图片提示不经 LLM，不排队的话会立刻抢发
  void syncFromCallback('tok-d2');
  await sleep(150);
  check('同客户保序：前一条卡住时后一条不抢发', startedTo('u-d').length === 1);
  holdD.resolve();
  holds.delete('u-d');
  await waitFor(() => sentTo('u-d').length >= 2);
  await idle();
  const d = sentTo('u-d');
  check('同客户保序：后到的图片提示排在前一条回复之后', d.length === 2 && d[1].content.includes('图我收到了'));
}

// ---------------- W1 优雅停机：等进行中的回复发完再退出 ----------------
{
  const holdE = deferred();
  holds.set('u-e', holdE.promise);
  const eMsg = customerMsg('u-e', '你好呀');
  serverLog.push(eMsg);
  void syncFromCallback('tok-e');
  await waitFor(() => startedTo('u-e').length > 0);
  const onDisk = (readState()?.pending ?? []).find((p) => p.msg.msgid === eMsg.msgid);
  check('处理中的消息连同原文记在盘上的在途表里', onDisk?.msg.text?.content === '你好呀');

  const shutdown = runShutdownHooks(3000);
  await sleep(30);
  const syncsBefore = syncCalls;
  const lateMsg = customerMsg('u-late', '在吗');
  serverLog.push(lateMsg);
  await syncFromCallback('tok-during-shutdown');
  check('停机中回调不再拉取', syncCalls === syncsBefore);
  setTimeout(() => holdE.resolve(), 200);
  const ok = await shutdown;
  holds.delete('u-e');
  check('优雅停机：等进行中的回复发完才返回', ok && sentTo('u-e').length === 1);
  const st = readState();
  check('优雅停机：落盘时在途表已清空', !!st && pendingIds(st).length === 0 && st.handled.some(([id]) => id === eMsg.msgid));
  check('停机期间到达的消息不认领（留给新进程）', !!st && !st.handled.some(([id]) => id === lateMsg.msgid));

  await restart();
  void syncFromCallback('tok-after-restart');
  await waitFor(() => sentTo('u-late').length > 0);
  await idle();
  check('新进程补拉到停机期间到达的消息', sentTo('u-late').length === 1);
  check('正常停机后重启不重复回复', sentTo('u-e').length === 1);
}

// ---------------- W1 停机超时：未完成的消息按原文重放（回复已生成 → 原样重发，不重跑 LLM） ----------------
{
  hangOnce.add('u-f');
  const fMsg = customerMsg('u-f', '你好，想去玩');
  serverLog.push(fMsg);
  void syncFromCallback('tok-f');
  await waitFor(() => startedTo('u-f').length > 0);
  const ok = await runShutdownHooks(200);
  check('停机等待超时如实返回 false', !ok);
  check('超时退出时未完成的消息留在盘上的在途表', pendingIds(readState()).includes(fMsg.msgid));

  await restart(); // 进程被强制退出后重启：cursor 已越过 fMsg，只能靠在途表重放
  void syncFromCallback('tok-f-restart');
  await waitFor(() => sentTo('u-f').length > 0);
  await idle();
  const s = getSession('wecom:u-f');
  const agentMsgs = (s?.messages ?? []).filter((m) => m.role === 'agent');
  check('重启后重放在途消息，客户收到回复', sentTo('u-f').length === 1);
  check('重放不重复记客户消息', (s?.messages ?? []).filter((m) => m.role === 'customer').length === 1);
  check('回复已生成则原样重发、不再跑一轮 LLM', agentMsgs.length === 1 && sentTo('u-f')[0]?.content === agentMsgs[0]?.content);
  check('重放完成后在途表清空', await waitFor(() => !pendingIds(readState()).includes(fMsg.msgid)));
}

// ---------------- W1 重放：引擎已记下客户这句、回复还没生成 ----------------
{
  await restart();
  const gMsg = customerMsg('u-g', '你好，想看看');
  const sess = getOrCreateSession('wecom:u-g', 'wecom');
  sess.messages.push({ role: 'customer', content: '你好，想看看', at: Date.now() });
  saveSession(sess);
  const st = readState();
  fs.writeFileSync(
    __test.STATE_FILE,
    JSON.stringify({ cursor: st?.cursor, handled: [...(st?.handled ?? []), [gMsg.msgid, Date.now()]], pending: [{ msg: gMsg, tries: 0 }] }),
  );
  void syncFromCallback('tok-g');
  await waitFor(() => sentTo('u-g').length > 0);
  await idle();
  const msgs = getSession('wecom:u-g')?.messages ?? [];
  check('重放（回复未生成）：客户收到回复', sentTo('u-g').length === 1);
  check(
    '重放（回复未生成）：客户这句只记一次',
    msgs.filter((m) => m.role === 'customer').length === 1 && msgs.filter((m) => m.role === 'agent').length === 1,
  );
}

// ---------------- W1 重放上限：毒消息不能让进程重启即崩、无限循环 ----------------
{
  await restart();
  const pMsg = customerMsg('u-p', '你好');
  const sess = getOrCreateSession('wecom:u-p', 'wecom');
  sess.messages.push({ role: 'customer', content: '你好', at: Date.now() });
  saveSession(sess);
  const st = readState();
  fs.writeFileSync(
    __test.STATE_FILE,
    JSON.stringify({ cursor: st?.cursor, handled: st?.handled ?? [], pending: [{ msg: pMsg, tries: 2 }] }),
  );
  await syncFromCallback('tok-p');
  await idle();
  check('重放次数到上限的消息不再重放', startedTo('u-p').length === 0 && !pendingIds(readState()).includes(pMsg.msgid));
  check(
    '放弃重放时在会话里给顾问留标记',
    (getSession('wecom:u-p')?.messages ?? []).some((m) => m.role === 'system' && m.content.includes('请人工回复')),
  );
}

// ---------------- W1 重放只认各客户的队头：排在后面、从没开始处理的消息按新消息派发 ----------------
// 客户回复慢时常连发两遍「在吗」。此前两条都按「处理到一半」对齐：第二条撞上第一条的回复，
// 被当成「回复已生成」原样重发，自己却从没入库；次数也一起累加，毒消息会拖着后面的无辜消息一起被放弃
{
  await restart();
  hangOnce.add('u-dup');
  const d1 = customerMsg('u-dup', '在吗');
  const d2 = customerMsg('u-dup', '在吗');
  serverLog.push(d1, d2);
  void syncFromCallback('tok-dup');
  await waitFor(() => startedTo('u-dup').length > 0);
  const ok = await runShutdownHooks(200); // 第一条卡在发送途中，停机等待超时
  const before = pendingIds(readState());
  check('（前提）超时退出时两条都留在在途表', !ok && before.includes(d1.msgid) && before.includes(d2.msgid));

  await restart();
  const holdDup = deferred();
  holds.set('u-dup', holdDup.promise);
  void syncFromCallback('tok-dup-restart');
  await waitFor(() => startedTo('u-dup').length > 1);
  const tries = new Map((readState()?.pending ?? []).map((p) => [p.msg.msgid, p.tries]));
  check('重放只给队头计次数，排在后面的不累加', tries.get(d1.msgid) === 1 && tries.get(d2.msgid) === 0, JSON.stringify([...tries]));
  holdDup.resolve();
  holds.delete('u-dup');
  await waitFor(() => sentTo('u-dup').length >= 2);
  await idle();
  const msgs = getSession('wecom:u-dup')?.messages ?? [];
  check(
    '连发两条相同文本：第二条照常入库、单独回复，不拿第一条的回复顶替',
    msgs.filter((m) => m.role === 'customer').length === 2 && msgs.filter((m) => m.role === 'agent').length === 2,
    JSON.stringify(msgs.map((m) => m.role)),
  );
}

// ---------------- W1 重放对齐：插在这一轮中间的欢迎语不是回复 ----------------
// 老客户再次进入时欢迎语不排队、直接写进会话；这一轮若被强制退出，重放不能把「欢迎回来」当回复重发
{
  await restart();
  const wMsg = customerMsg('u-wb', '西藏几月去合适');
  const sess = getOrCreateSession('wecom:u-wb', 'wecom');
  sess.messages.push({ role: 'customer', content: '西藏几月去合适', at: Date.now() });
  sess.messages.push({ role: 'agent', content: __test.WELCOME_BACK_TEXT, at: Date.now() });
  saveSession(sess);
  const st = readState();
  fs.writeFileSync(
    __test.STATE_FILE,
    JSON.stringify({ cursor: st?.cursor, handled: [...(st?.handled ?? []), [wMsg.msgid, Date.now()]], pending: [{ msg: wMsg, tries: 0 }] }),
  );
  void syncFromCallback('tok-wb');
  await waitFor(() => sentTo('u-wb').length > 0);
  await idle();
  const msgs = getSession('wecom:u-wb')?.messages ?? [];
  check(
    '重放时不把欢迎语当成这句的回复',
    sentTo('u-wb').length === 1 && !sentTo('u-wb')[0].content.includes('欢迎回来'),
    sentTo('u-wb')[0]?.content,
  );
  check('重放（中间夹欢迎语）：客户这句只记一次', msgs.filter((m) => m.role === 'customer').length === 1);
}

// ---------------- W1 启动重放途中收到停机信号：钩子要等重放的回复发完 ----------------
// 连续两次 docker restart 时可能落在这个窗口：重放已派发，钩子却没等它就返回，进程随即退出
{
  await restart();
  const gMsg = customerMsg('u-giveup', '你好');
  const rMsg = customerMsg('u-replay', '你好');
  // 到上限的消息被放弃时会往会话里写一条标记——借这个同步点「送达 SIGTERM」：
  // 此刻 replayInflight 已过了开头的 stopping 检查，正要 await 落盘、再派发重放
  const trigger = getOrCreateSession('wecom:u-giveup', 'wecom');
  const sig: { shutdown?: Promise<boolean> } = {};
  Object.defineProperty(trigger.messages, 'push', {
    configurable: true,
    value(this: unknown[], ...items: unknown[]) {
      sig.shutdown ??= runShutdownHooks(3000);
      return Array.prototype.push.apply(this, items);
    },
  });
  saveSession(trigger);
  const holdR = deferred();
  holds.set('u-replay', holdR.promise);
  const st = readState();
  fs.writeFileSync(
    __test.STATE_FILE,
    JSON.stringify({
      cursor: st?.cursor,
      handled: [...(st?.handled ?? []), [gMsg.msgid, Date.now()], [rMsg.msgid, Date.now()]],
      pending: [
        { msg: gMsg, tries: 2 },
        { msg: rMsg, tries: 0 },
      ],
    }),
  );
  void syncFromCallback('tok-startup-stop');
  await waitFor(() => !!sig.shutdown);
  setTimeout(() => holdR.resolve(), 200);
  const ok = sig.shutdown ? await sig.shutdown : false;
  delete (trigger.messages as { push?: unknown }).push;
  holds.delete('u-replay');
  check(
    '启动重放途中停机：钩子等重放的回复发完才返回',
    ok && sentTo('u-replay').length === 1 && !inspect().busy,
    `ok=${ok} sent=${sentTo('u-replay').length} busy=${inspect().busy}`,
  );
  check('启动重放途中停机：落盘时在途表已清空', !pendingIds(readState()).includes(rMsg.msgid));
}

// ---------------- W1 信号接线：SIGTERM 先跑完停机钩子，再以 143 退出 ----------------
{
  const marker = path.join(VAR_DIR, 'shutdown-hook-done');
  const child = path.join(VAR_DIR, 'sigterm-child.mts');
  const storeUrl = new URL('../store.ts', import.meta.url).href;
  fs.writeFileSync(
    child,
    `import fs from 'node:fs';\n` +
      `const { onShutdown } = await import(${JSON.stringify(storeUrl)});\n` +
      `onShutdown(async () => { await new Promise((r) => setTimeout(r, 300)); fs.writeFileSync(${JSON.stringify(marker)}, 'ok'); });\n` +
      `setInterval(() => {}, 1000); // 像 HTTP server 一样让进程常驻\n` +
      `setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);\n`,
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', child], {
    cwd: process.cwd(),
    env: { ...process.env, VAR_DIR },
    timeout: 20_000,
    encoding: 'utf8',
  });
  check('SIGTERM 等停机钩子跑完才退出', fs.existsSync(marker), `status=${r.status} stderr=${(r.stderr ?? '').slice(0, 300)}`);
  check('SIGTERM 退出码为 143', r.status === 143, `status=${r.status}`);
}

Object.assign(console, origConsole);

// ---------------- 结果 ----------------
if (fails.length) {
  console.error('---- 场景日志（最近 60 行）----');
  for (const l of logBuf.slice(-60)) console.error('  ' + l);
  console.error(`WECOM SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 20)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`WECOM SELFTEST PASS: ${pass} 项断言全通（分段 / 卡片 / 去 markdown / 冷启动 / 跨客户不排队 / 优雅停机 / 在途重放）`);
// 显式退出：「死在半路」的场景故意留下永不返回的假请求，不让它们成为悬念
process.exit(0);
