// 07 R3、验收 2 后半：模板模式的锁定节、旧版【硬性要求】、企微欢迎语不再手抄，由来源生成，字节与开工时相同。
//   一、锁定节模板 = 镜像 data/sop.md 的 7 个锁定节 + 声明的替换表（6 行「微信」说法）：逐节 sha256 等于开工时手抄那份，
//       表外的节与镜像逐字节相同，模板里没有「微信」「云途」；表里任一条命中 0 次或多次、指向非锁定节、镜像缺锁定节，都抛错（包装载时抛错 = 启动失败）。
//   二、旧版硬性要求 = 模板模式的硬性要求按 demo 品牌渲染 + 两条替换：sha256 等于开工时的值，渲染与结果只差那两行。
//   三、企微欢迎语：适配器 __test 上的 WELCOME_TEXT / WELCOME_BACK_TEXT 现取绑定包的旧版文字（08 R5：适配器不 import 包），适配器源码里没有第二份；LEGACY_WELCOME_TEXTS 原样。
// 批 S（07 第 19 步）改镜像里 handoff、capabilities 两个锁定节时，同步更新下面这两节的 sha256（替换表对不上会在装载时先报错）。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hashes.js';
import { renderBrandTemplate } from '../core/brand.js';
import { splitSop } from '../sop/sections.js';
import { TRAVEL_SOP_SECTIONS } from '../packs/travel/sop.js';
import { demoBrand } from '../packs/travel/demo-brand.js';
import { applyReplacements } from '../packs/travel/replacements.js';
import { deriveLockedSectionTemplates, LOCKED_SECTION_REPLACEMENTS, readMirrorSop } from '../packs/travel/locked-templates.js';
import {
  hardRequirementsTemplate,
  LEGACY_HARD_REQUIREMENTS_REPLACEMENTS,
  renderLegacyHardRequirements,
} from '../packs/travel/hard-requirements.js';
import * as legacy from '../packs/travel/legacy.js';
import { travelTemplates } from '../packs/travel/templates.js';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '1';
process.env.WECOM_CORP_ID = 'selftest-corp';
process.env.WECOM_APP_SECRET = 'selftest-secret'; // gitleaks:allow
process.env.WECOM_KF_OPEN_KFID = 'selftest-kf';

const root = path.join(import.meta.dirname, '..', '..');
const config = await withoutTenantScope(() => import('./source.js'));
const { __test: wecom } = await withoutTenantScope(() => import('../adapters/wecom.js'));
const runtime = config.currentPack().runtime;

const mirror = readMirrorSop();
assert.equal(mirror, fs.readFileSync(path.join(root, 'data', 'sop.md'), 'utf8'));
const mirrorByKey = new Map(splitSop(mirror, runtime.sopSections).map((s) => [s.key, s.text]));
const lockedKeys = TRAVEL_SOP_SECTIONS.filter((s) => s.locked).map((s) => s.key);
const lines = (s: string): string[] => s.split('\n');
const countOf = (text: string, part: string): number => text.split(part).length - 1;

// ---------------- 一、锁定节模板 ----------------
{
  const templates = travelTemplates.lockedSectionTemplates;
  assert.deepEqual(Object.keys(templates), lockedKeys, '7 个锁定节，顺序同节表');
  assert.equal(lockedKeys.length, 7);

  // 开工时（手抄那份）每一节的 sha256：生成结果必须逐字节相同
  const pinned: Record<string, string> = {
    stages: '84bfe66a1f47d98312c27d5b848e56d64fa88588f3d683786e89214515f8ed01',
    orders: '9438d55ca8b65a72a763b027428922fa161652b0d9efeb9263ba05910c58533e',
    'quote-discipline': 'd411e789b490c3d9cad8f5da3b8551d0f130e9e3da92a000dc6db7d6c297394b',
    'price-rules': 'e377d983b0cd6453f224d81cf2b3bff255e24e00d9704aa954c2a7efa4793671',
    capabilities: 'c8eb21861d67e8a61e06e1144d43d352e6501fedd466d493f2e6d2a79ef2371c',
    'no-destinations': '86a8d9b4c87043b4fca3ae5a2bcd15d65dd69af7725ecb695d1e148e2dc96899',
    handoff: '6784c6b666a511fd6315fc9e75717f581067d83b1766ffeba2e039e1e9796532',
  };
  for (const key of lockedKeys) assert.equal(sha256(templates[key]!), pinned[key], `锁定节 ${key} 的模板必须与开工时逐字节相同`);

  // 生成结果就是 derive(镜像, 表)；运行时那份来自同一个函数
  assert.deepEqual({ ...templates }, deriveLockedSectionTemplates(mirror));

  // 表的内容：今天那 6 行，落在 4 个节
  const table = LOCKED_SECTION_REPLACEMENTS;
  assert.equal(table.length, 6);
  assert.deepEqual([...new Set(table.map((r) => r.section))], ['orders', 'capabilities', 'no-destinations', 'handoff']);
  for (const r of table) {
    assert.equal(countOf(mirrorByKey.get(r.section)!, r.from), 1, `镜像「${r.section}」节里 from 恰好一次：${r.from}`);
    assert.equal(countOf(templates[r.section]!, r.from), 0, `模板里不再有 from：${r.from}`);
    assert.equal(countOf(templates[r.section]!, r.to), 1, `模板里 to 恰好一次：${r.to}`);
  }

  // 表外的节与镜像逐字节相同（stages、quote-discipline、price-rules）；表内的节只差表里的行
  const listed = new Set(table.map((r) => r.section));
  let differing = 0;
  for (const key of lockedKeys) {
    const from = mirrorByKey.get(key)!;
    const to = templates[key]!;
    if (!listed.has(key)) {
      assert.equal(to, from, `表外的节 ${key} 与镜像逐字节相同`);
      continue;
    }
    assert.equal(lines(to).length, lines(from).length, `${key} 行数不变`);
    lines(from).forEach((line, i) => {
      if (line !== lines(to)[i]) differing++;
    });
  }
  assert.equal(differing, 6, '模板与镜像一共只差 6 行');
  for (const key of lockedKeys) assert.doesNotMatch(templates[key]!, /微信|云途/, `${key}：模板模式不点名渠道和旧品牌`);

  // 表对不上就抛错（包装载时抛 = 启动失败）
  const one = (r: Partial<(typeof table)[number]>) => [{ section: 'orders', from: '顾问', to: 'x', ...r }];
  assert.throws(() => deriveLockedSectionTemplates(mirror, one({ from: '镜像里没有这句话' })), /锁定节「orders」.*实际 0 次/, '命中 0 次');
  const twice = countOf(mirrorByKey.get('handoff')!, '顾问');
  assert.ok(twice >= 2, '夹具：handoff 节里「顾问」不止一处');
  assert.throws(
    () => deriveLockedSectionTemplates(mirror, one({ section: 'handoff', from: '顾问' })),
    new RegExp(`锁定节「handoff」.*实际 ${twice} 次`),
    '命中多次',
  );
  assert.throws(
    () => deriveLockedSectionTemplates(mirror, [...table, table[0]!]),
    /锁定节「orders」.*实际 0 次/,
    '同一条列两遍：第二遍命中 0 次',
  );
  assert.throws(() => deriveLockedSectionTemplates(mirror, one({ from: '' })), /实际 0 次/, 'from 为空不算命中');
  assert.throws(() => deriveLockedSectionTemplates(mirror, one({ section: 'tone' })), /「tone」不是锁定节/, '指向可编辑节');
  assert.throws(() => deriveLockedSectionTemplates(mirror, one({ section: 'nope' })), /「nope」不是锁定节/, '指向不存在的节');
  assert.throws(
    () => deriveLockedSectionTemplates(mirror.replace('## 转人工条件', '## 转人工条件改名'), table),
    /镜像里没有「转人工条件/,
    '镜像缺锁定节',
  );
  // 表过期的典型情形：镜像里的说法改了，表没跟着改
  assert.throws(
    () => deriveLockedSectionTemplates(mirror.replace('顾问核实后会在微信上联系您', '顾问核实后会联系您'), table),
    /锁定节「orders」.*实际 0 次/,
  );
  // 替换后的 to 里有 $& 之类时按字面放进去
  assert.equal(applyReplacements('甲乙', [{ from: '甲', to: '$&$$' }], 't'), '$&$$乙');
}

// ---------------- 二、旧版【硬性要求】 ----------------
{
  assert.equal(sha256(travelTemplates.hardRequirements), '29175870632ba32e322f13e1a1eff6cb905d5631155a9e4df0143660788bad04');
  assert.equal(travelTemplates.hardRequirements, hardRequirementsTemplate);
  assert.equal(
    sha256(legacy.hardRequirements),
    'ee44ffd30eeb4e09786fcc9e848f7ef883c0ac96af83fb7dd289c29245587893',
    '旧版硬性要求必须与开工时逐字节相同（promptHash 的一部分）',
  );
  assert.equal(legacy.hardRequirements, renderLegacyHardRequirements());

  // 渲染 demo 品牌之后只差表里的两行
  const rendered = renderBrandTemplate(hardRequirementsTemplate, demoBrand);
  const table = LEGACY_HARD_REQUIREMENTS_REPLACEMENTS;
  assert.equal(table.length, 2);
  assert.equal(lines(legacy.hardRequirements).length, lines(rendered).length);
  const changed = lines(rendered).flatMap((line, i) => (line === lines(legacy.hardRequirements)[i] ? [] : [i]));
  assert.equal(changed.length, 2, '渲染与旧版只差两行');
  for (const r of table) {
    assert.equal(countOf(rendered, r.from), 1);
    assert.equal(countOf(legacy.hardRequirements, r.to), 1);
  }
  assert.doesNotMatch(rendered, /微信/, '模板渲染 demo 品牌后没有「微信」');
  assert.match(legacy.hardRequirements, /微信正文/);
  assert.match(legacy.hardRequirements, /微信不渲染 markdown/);
  assert.doesNotMatch(hardRequirementsTemplate, /微信|云途/, '模板模式的硬性要求不点名渠道和旧品牌');

  // demo 品牌：就是 PackRuntime.defaultBrand；identityLine 加「～」就是旧版的身份回答
  assert.deepEqual(runtime.defaultBrand, demoBrand);
  assert.equal(`${demoBrand.identityLine}～`, legacy.identityAnswer);
  assert.equal(runtime.legacy.hardRequirements, legacy.hardRequirements);

  // 表对不上就抛错
  assert.throws(() => renderLegacyHardRequirements(demoBrand, [{ from: '- 不存在的一行', to: 'x' }]), /旧版【硬性要求】.*实际 0 次/);
  assert.throws(() => renderLegacyHardRequirements(demoBrand, [{ from: '客户', to: 'x' }]), /旧版【硬性要求】.*实际 [2-9]\d* 次/);
  assert.throws(() => renderLegacyHardRequirements(demoBrand, [...table, table[1]!]), /旧版【硬性要求】.*实际 0 次/);
  // 别的品牌照常渲染（不过替换表时没有「微信」）
  const other = renderBrandTemplate(hardRequirementsTemplate, { ...demoBrand, brandName: '山海旅行' });
  assert.match(other, /山海旅行的旅行顾问/);
}

// ---------------- 三、企微欢迎语 ----------------
{
  assert.equal(sha256(legacy.welcomeText), 'af429978d17b2bdb4d8ad4dc31a80fcd386c566bcdbe08305c7369b6578197fb');
  assert.equal(sha256(legacy.welcomeBackText), '2a14dfab5e37875baa78842fef895671aca3e90444487e7b6e3575f834b55390');
  assert.equal(wecom.WELCOME_TEXT, legacy.welcomeText);
  assert.equal(wecom.WELCOME_BACK_TEXT, legacy.welcomeBackText);
  assert.equal(runtime.legacy.welcomeText, wecom.WELCOME_TEXT);
  assert.equal(runtime.legacy.welcomeBackText, wecom.WELCOME_BACK_TEXT);
  // 历史识别串原样留在适配器：改版前的两段
  assert.deepEqual(wecom.LEGACY_WELCOME_TEXTS.map(sha256), [
    '98356928ecef2875589c18a9ba7a890d8aefb3b8708d517d18ebdd16ab8988bf',
    '09cc44398d9657600485565ac14918edb2effcc528f029121c69beaba9baf1fb',
  ]);
  // 适配器源码里不再有现行两段欢迎语的第二份字面量
  const source = fs.readFileSync(path.join(root, 'src', 'adapters', 'wecom.ts'), 'utf8');
  for (const needle of ['我是您的 AI 旅行顾问', '我是云途定制旅行的 AI 旅行顾问', '想去哪玩直接跟我说，比如「想去西藏']) {
    const n = countOf(source, needle);
    // 「想去哪玩…」在改版前的第一段识别串里还有一处；其余两句现行文字只允许出现在注释以外的零处
    assert.equal(n, needle.startsWith('想去哪玩') ? 1 : 0, `wecom.ts 里不应再手抄现行欢迎语：${needle}`);
  }
  // 08 R5：适配器不 import 包；两段现行文字在用到时按绑定包的 runtime.legacy 现取
  assert.doesNotMatch(source, /from '\.\.\/packs\//);
  assert.match(source, /currentPack\(\)\.runtime\.legacy/);
}

console.log(
  'SELFTEST PASS: 锁定节模板由镜像加替换表生成 / 旧版硬性要求由模板渲染加替换表生成 / 企微欢迎语引用包的旧版文字（字节同开工，表对不上即抛错）',
);
await withoutTenantScope(() => config.closeConfig());
