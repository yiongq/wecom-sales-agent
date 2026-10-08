// 隐私说明、敏感信息同意、行权删除的自测（docs/architecture/02-conversations-workbench/spec.md「隐私说明、敏感信息同意、
// 保留期与行权」，R23；02 第 16 步）。纯文件存储、不碰数据库：隐私说明的发布/轮询用 __privacyTest 直接灌内存，
// 保留期清理与 erase-conversation 的真实 PG 场景在 src/store/store.selftest.ts。
// 用法：npx tsx src/privacy/privacy.selftest.ts
import './../selftest-env.js'; // 必须第一个 import
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const varDir = fs.mkdtempSync(path.join(varParent, 'wecom-privacy-selftest-'));
process.env.VAR_DIR = varDir;
process.env.LLM_MOCK = '1';
process.env.PUBLIC_BASE_URL = 'https://privacy-selftest.example';

const { handleMessage } = await import('../engine.js');
const { getSession, getOrCreateSession } = await import('../store.js');
const { __privacyTest, currentPrivacyNotice, privacyLink, escapeHtml } = await import('./privacy.js');
const {
  SENSITIVE_CATEGORY_LABEL,
  CONSENT_MAX_ASKS,
  consentMenuText,
  sensitiveContextNote,
  CONSENT_WITHDRAWN_REPLY,
  CONSENT_WITHDRAWAL_REASON,
  consentMenuButtonId,
  parseConsentMenuId,
  noteSensitiveMentions,
  awaitingConsent,
  applyConsentDecision,
  withdrawConsent,
} = await import('./../handoff/consent.js');
const { consentDeclined, release, ConsentDeclinedError, sharedActor } = await import('../handoff/takeover.js');
const { sensitiveCategoriesOf, consentWithdrawalOf } = await import('../handoff/triggers.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
let seq = 0;
const sid = (tag: string): string => `wecom:wmP${tag}${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------------------------
// 1. privacy.ts：没发布时一切为 null；发布过时内存里取；escapeHtml
// ---------------------------------------------------------------------------------------------
{
  __privacyTest.reset();
  check('没发布过：currentPrivacyNotice 为 null', currentPrivacyNotice() === null);
  check('没发布过：privacyLink 为 null', privacyLink() === null);
  __privacyTest.set({ version: 3, body: '处理者：云途\n保存期限：730 天\n行权方式：发邮件给我们' });
  const n = currentPrivacyNotice();
  check('发布过：currentPrivacyNotice 带版本与正文', n?.version === 3 && n.body.includes('保存期限'), json(n));
  check('发布过：privacyLink 是 PUBLIC_BASE_URL + /privacy', privacyLink() === 'https://privacy-selftest.example/privacy');
  check(
    'escapeHtml：& < > " 都转义，中文与换行原样',
    escapeHtml('a<b>&"c\n中文') === 'a&lt;b&gt;&amp;&quot;c\n中文',
    escapeHtml('a<b>&"c\n中文'),
  );
  __privacyTest.reset();
  check('reset 之后又是 null', currentPrivacyNotice() === null);
}

// ---------------------------------------------------------------------------------------------
// 2. consent.ts：纯函数与文案
// ---------------------------------------------------------------------------------------------
{
  __privacyTest.set({ version: 1, body: 'x' });
  const healthText = consentMenuText('health');
  const minorText = consentMenuText('minor');
  check(
    '同意菜单问句：写明用途、可撤回、链接，类别代入正确',
    healthText.includes(SENSITIVE_CATEGORY_LABEL.health) &&
      healthText.includes('可以随时撤回') &&
      healthText.includes('隐私说明：https://privacy-selftest.example/privacy') &&
      minorText.includes(SENSITIVE_CATEGORY_LABEL.minor) &&
      healthText !== minorText,
    healthText,
  );
  check(
    'contextNote 提示：点名类别、要求别主动提',
    sensitiveContextNote('health').includes(SENSITIVE_CATEGORY_LABEL.health) && sensitiveContextNote('health').includes('不要'),
  );
  check('CONSENT_MAX_ASKS 是 2', CONSENT_MAX_ASKS === 2);
  check(
    '菜单按钮 id 编解码往返：category:decision',
    parseConsentMenuId(consentMenuButtonId('health', 'granted'))?.category === 'health' &&
      parseConsentMenuId(consentMenuButtonId('health', 'granted'))?.decision === 'granted' &&
      parseConsentMenuId(consentMenuButtonId('minor', 'declined'))?.decision === 'declined',
  );
  check(
    '菜单按钮 id：认不出的 id 与残缺的都返回 null',
    parseConsentMenuId(undefined) === null &&
      parseConsentMenuId('') === null &&
      parseConsentMenuId('other:granted') === null &&
      parseConsentMenuId('health:maybe') === null &&
      parseConsentMenuId('health') === null,
  );
  __privacyTest.reset();
}

// ---------------------------------------------------------------------------------------------
// 3. noteSensitiveMentions：问一次、没点再问一次、问过两次不再问；已有结论的类别不再问
// ---------------------------------------------------------------------------------------------
{
  const s = getOrCreateSession(sid('ask'), 'wecom');
  const ask1 = noteSensitiveMentions(s, ['health'], 1, '我妈有高血压');
  check('第一次出现：要问', ask1.length === 1 && ask1[0] === 'health', json(ask1));
  check('第一次出现：session.consent 记 asked，consentAskCount 记 1', s.consent?.health === 'asked' && s.consentAskCount?.health === 1);
  check('已经 asked：awaitingConsent 为 true', awaitingConsent(s, 'health'));

  const ask2 = noteSensitiveMentions(s, ['health'], 1, '我妈血压一直控制不好');
  check('第二次出现、仍没点：再问一次', ask2.length === 1, json(ask2));
  check('第二次之后 consentAskCount 记 2', s.consentAskCount?.health === 2);

  const ask3 = noteSensitiveMentions(s, ['health'], 1, '我妈高血压能不能去');
  check('第三次出现、问过两次了：不再问', ask3.length === 0, json(ask3));
  check('不再问之后仍是 asked（照常接待，不升级也不清除）', s.consent?.health === 'asked');

  // 另一个类别互不影响
  const askMinor = noteSensitiveMentions(s, ['minor'], 1, '孩子才8岁');
  check('不同类别各自计数', askMinor.length === 1 && s.consentAskCount?.minor === 1 && s.consentAskCount?.health === 2);

  // 已经有结论（granted）的类别不再问
  applyConsentDecision(s, 'health', 'granted', 'menu-click-evidence', 1);
  const askAfterGrant = noteSensitiveMentions(s, ['health'], 1, '我妈还是高血压');
  check('已经 granted 的类别：不再问，也不改状态', askAfterGrant.length === 0 && s.consent?.health === 'granted');
}

// ---------------------------------------------------------------------------------------------
// 4. applyConsentDecision：granted 不转人工；declined 转人工（kind=consent）且不能交还；重复点击忽略
// ---------------------------------------------------------------------------------------------
{
  const s = getOrCreateSession(sid('dec'), 'wecom');
  s.consent = { minor: 'asked' };
  const applied = applyConsentDecision(s, 'minor', 'declined', 'health:declined', 2);
  check('点「不同意」：applyConsentDecision 返回 true（真的改了）', applied === true);
  check('点「不同意」：consent 记 declined', s.consent.minor === 'declined');
  check('点「不同意」：enterHandoff(kind=consent)，有接手人之前没有', s.handedOver === true && s.handoff?.kind === 'consent');
  check('consentDeclined() 为 true：之后不能交还 AI', consentDeclined(s));
  let threw: unknown;
  try {
    release(s.id, sharedActor());
  } catch (e) {
    threw = e;
  }
  check('release()（交还 AI）在 consent 被拒时抛 ConsentDeclinedError', threw instanceof ConsentDeclinedError);

  // 同一个类别再点一次（旧菜单的重复点击）：忽略，不重复记、不重复 enterHandoff
  const genBefore = s.handoff?.at;
  const appliedAgain = applyConsentDecision(s, 'minor', 'granted', 'late-click', 2);
  check(
    '已经有结论的类别再点（旧菜单重复点击）：忽略，结论不变',
    appliedAgain === false && s.consent.minor === 'declined' && s.handoff?.at === genBefore,
  );
}
{
  const s = getOrCreateSession(sid('grant'), 'wecom');
  s.consent = { health: 'asked' };
  applyConsentDecision(s, 'health', 'granted', 'health:granted', 3);
  check('点「同意」：consent 记 granted，不转人工', s.consent.health === 'granted' && !s.handedOver);
  check('点「同意」之后：consentDeclined 为 false，能正常交还', !consentDeclined(s));
}

// ---------------------------------------------------------------------------------------------
// 5. withdrawConsent：对已问过的类别各记 withdrawn；没问过任何类别时返回 0（调用方仍要转人工回固定一句）
// ---------------------------------------------------------------------------------------------
{
  const s = getOrCreateSession(sid('wd'), 'wecom');
  s.consent = { health: 'granted', minor: 'asked' };
  const n = withdrawConsent(s, '把我的信息删掉', 4);
  check(
    '撤回：两个已问过的类别都变成 withdrawn，返回条数 2',
    n === 2 && s.consent.health === 'withdrawn' && s.consent.minor === 'withdrawn',
    json(s.consent),
  );
  const n2 = withdrawConsent(s, '再撤一次', 4);
  check('已经全是 withdrawn 的会话：再撤回记 0 条（不重复记）', n2 === 0);
}
{
  const s = getOrCreateSession(sid('wd0'), 'wecom');
  const n = withdrawConsent(s, '把我的信息删掉', 4);
  check('从没问过任何类别就说撤回：记 0 条（没有可撤的）', n === 0 && s.consent === undefined);
}

// ---------------------------------------------------------------------------------------------
// 6. 撤回同意接进引擎（R23）：本轮不调模型、固定回复、转人工、不升级已有的别的转人工类型之外的记录
// ---------------------------------------------------------------------------------------------
{
  __privacyTest.set({ version: 5, body: 'x' });
  // 第一句同时触发安全网转人工（确定性、不调模型）与健康信息：两条规则互不挡道，同意菜单该问照样问
  const id1 = sid('eng-wd1');
  await handleMessage(id1, '我妈有高血压，帮我转人工', 'wecom');
  const s1 = getSession(id1)!;
  check('安全网转人工 + 命中敏感信息：session.consent.health 记为 asked', s1.consent?.health === 'asked', json(s1.consent));

  // 另开一个会话单独验证撤回同意本身：先问过一次 health（走 mock 模型的普通应答），再撤回
  const id2 = sid('eng-wd2');
  await handleMessage(id2, '我妈有高血压', 'wecom');
  const askedHealth = getSession(id2)!.consent?.health === 'asked';
  const r = await handleMessage(id2, '把我的信息删掉，别保存了', 'wecom');
  const s2 = getSession(id2)!;
  check(
    '撤回同意：固定回复、转人工 kind=consent、reason 是 spec 原文',
    r.text === CONSENT_WITHDRAWN_REPLY &&
      r.handoff === true &&
      s2.handoff?.kind === 'consent' &&
      s2.handoff.reason === CONSENT_WITHDRAWAL_REASON,
    json({ r, handoff: s2.handoff, askedHealth }),
  );
  check('撤回同意：已问过的 health 类别记为 withdrawn', s2.consent?.health === 'withdrawn', json(s2.consent));
  check('consentWithdrawalOf 纯函数本身命中这句', consentWithdrawalOf('把我的信息删掉，别保存了'));
}

// ---------------------------------------------------------------------------------------------
// 7. 没发布隐私说明（demo 默认）：不触发同意菜单、不记 consent，不变量 40
// ---------------------------------------------------------------------------------------------
{
  __privacyTest.reset();
  const id = sid('nopub');
  await handleMessage(id, '我妈有高血压，帮我转人工', 'wecom');
  const s = getSession(id)!;
  check('没发布隐私说明：session.consent 不存在（不记 asked）', s.consent === undefined, json(s.consent));
  check(
    'sensitiveCategoriesOf 本身照常命中（不是识别失效，是调用方被隐私说明的发布状态挡住）',
    sensitiveCategoriesOf('我妈有高血压，帮我转人工').includes('health'),
  );
}

if (fails.length) {
  console.error(`PRIVACY SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `PRIVACY SELFTEST PASS: ${pass} 项断言全通（隐私说明的内存读取与 escapeHtml / 同意菜单文案与按钮 id / 问一次·再问一次·问两次不再问 / ` +
    `同意与不同意的记账与转人工·交还被拒 / 撤回同意的记账与固定回复 / 撤回同意接进引擎 / 没发布隐私说明时不触发）`,
);
fs.rmSync(varDir, { recursive: true, force: true });
