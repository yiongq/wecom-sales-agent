// 企微发送链路的纯函数自测：分段切分与链接卡片识别。
// 这几条都是"实机才看得见、看不见就以为没事"的坑，必须有断言钉住：
//   · 分段把 URL 从中间劈开 → 客户收到两条点不开的残缺网址
//   · 按整行剥离链接 → 报价/支付链接被连带吞掉
//   · 一条消息里两个链接硬做卡片 → 第二条（往往是支付链接）永久丢失
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须隔离数据目录：extractCard 会经 store 查订单，而 store 在模块加载时就取 VAR_DIR。
// 不隔离的话，跑一次自测就会触发真实 var/ 里的 demo 保鲜并重写 sessions.json。
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-selftest-'));

const { __test } = await import('./wecom.js');

const { splitForWecom, extractCard, stripLink } = __test;
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
  check('每段不超 2000 字节', chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 2000));
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

// ---------------- 结果 ----------------
if (fails.length) {
  console.error(`WECOM SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 10)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`WECOM SELFTEST PASS: ${pass} 项断言全通（分段边界 / 卡片识别 / 正文剥离）`);
