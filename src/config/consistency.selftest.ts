// 06 第 13 步 · R21：话术、工具提示、代码模板之间的一致性检查（验收 12 第一、二、四项）。
// 四类文字：渲染后的 SOP、包登记的全部对客固定文字（三种渲染）、工具结果里的提示模板、两套出口词表。
// 四条规则：quote-final、sop-vs-wordlist、fixed-vs-guards、template-no-channel。失败信息一律点名规则 id 和冲突的双方。
// 用法：npx tsx src/config/consistency.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
process.env.VAR_DIR = fs.mkdtempSync(path.join(process.env.VAR_DIR ?? os.tmpdir(), 'wecom-consistency-selftest-'));
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'file';

const root = path.join(import.meta.dirname, '..', '..');
const { packSources } = await withoutTenantScope(() => import('../core/engine/sources.js'));
const config = await withoutTenantScope(() => import('./source.js'));
await config.initConfig(null);
const { legacyTravelRuntime } = await withoutTenantScope(() => import('../packs/registry.js'));
const { createFixtureRuntime } = await withoutTenantScope(() => import('../packs/__fixture/runtime.js'));
const { tenantImage } = await withoutTenantScope(() => import('./brand.js'));
const { splitSop, joinSop, TRAVEL_SOP_SECTIONS, withBody, sectionBody } = await withoutTenantScope(() => import('../sop/sections.js'));
const { checkSopContract } = await withoutTenantScope(() => import('../sop/contract.js'));
const { renderSystemPrompt } = await withoutTenantScope(() => import('../prompt/system.js'));
const { toolDefs } = await withoutTenantScope(() => import('../tool-defs.js'));
const cons = await import('../packs/travel/consistency.js');
const { MODE_CTX, declaredOrigin, FIXED_REPLY_STEPS } = await import('../packs/travel/fixed-replies.js');
const { replyLineCount } = await import('../core/guards/shape.js');
const { travelTemplates } = await import('../packs/travel/templates.js');
const { shanhaiBrand } = await import('../packs/travel/brand-fixture.js');
const { formatConflict, resolveConflicts, originProblems, FIXED_REPLY_MODES } = await import('../core/consistency.js');
const { CORE_FIXED_REPLIES } = await withoutTenantScope(() => import('../core/core-fixed-replies.js'));
const { packPipelines } = await withoutTenantScope(() => import('../core/engine/pipelines.js'));
type Conflict = import('../core/consistency.js').ConsistencyConflict;
type ConsistencyText = import('../core/consistency.js').ConsistencyText;

const travel = legacyTravelRuntime(packSources());
const consistency = travel.consistency;
const runtime = travel.runtime;

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}
/** 失败时逐条列出；同一条文字三种渲染都撞上的，合并成一行（[legacy] [web] [template] 写成 [*]） */
const names = (cs: readonly Conflict[]): string =>
  [...new Set(cs.map((c) => formatConflict(c).replace(/\[(?:legacy|web|template)\]/g, '[*]')))].join('\n    ');

// ---------------- 登记 ----------------
check(
  'PackRuntime.fixedReplies 就是旅游包登记的那一份',
  runtime.fixedReplies === consistency.fixedReplies && runtime.fixedReplies!.length > 0,
);
check(
  'PackRuntime.consistencyRules：四条规则，每条有 id、两方、范围、理由',
  runtime.consistencyRules!.map((r) => r.id).join(',') === 'quote-final,sop-vs-wordlist,fixed-vs-guards,template-no-channel' &&
    runtime.consistencyRules!.every((r) => r.a && r.b && r.scope.length > 0 && r.why),
);
{
  // 核心在包没登记时照常工作：别的包（假包）不带这两个成员
  const fixture = createFixtureRuntime();
  check('没登记的包：两个成员都没有，核心不要求', fixture.fixedReplies === undefined && fixture.consistencyRules === undefined);
}
check('三种渲染与 MODE_CTX 一一对应', MODE_CTX.map((m) => m.mode).join(',') === FIXED_REPLY_MODES.join(','));

// 管线的真实步骤顺序：固定文字只穿过产出它的步骤之后的护栏，顺序取自这里，不手写第二套
const pipelines = packPipelines(runtime);
const order = {
  reply: pipelines.reply.steps.map((s) => s.id),
  followup: pipelines.followup.steps.map((s) => s.id),
};
// 核心自己的固定文字（不经 PackRuntime）一起查
const allFixedReplies = [...consistency.fixedReplies, ...CORE_FIXED_REPLIES];
const fixed = await cons.flattenFixed(allFixedReplies);
{
  const ids = allFixedReplies.map((f) => f.id);
  check('固定文字：id 不重复', new Set(ids).size === ids.length);
  for (const f of consistency.fixedReplies) check(`固定文字 ${f.id}：在 ORIGINS 里声明了产出步骤`, declaredOrigin(f.id) !== undefined);
  check(
    '固定文字：出处文件都存在',
    allFixedReplies.every((f) => fs.existsSync(path.join(root, f.source))),
  );
  for (const f of allFixedReplies) {
    const samples = await f.samples();
    check(
      `固定文字 ${f.id}：三种渲染各一份、非空、不带 markdown`,
      samples.map((s) => s.mode).join(',') === FIXED_REPLY_MODES.join(',') &&
        samples.every((s) => s.text.trim() !== '' && !/\*\*|^#{1,6}\s/m.test(s.text)),
    );
    // 「原则」：品牌模板的渲染里不出现旧品牌名
    check(
      `固定文字 ${f.id}：web、template 渲染不出现「云途」`,
      samples.filter((s) => s.mode !== 'legacy').every((s) => !s.text.includes('云途')),
    );
  }
}

// ---------------- 渲染后的 SOP ----------------
const sopMd = fs.readFileSync(path.join(root, 'data', 'sop.md'), 'utf8');
const legacySop = splitSop(sopMd);
const templateSop = tenantImage(runtime, sopMd, shanhaiBrand);
const sopUnits = [...cons.splitSopUnits(legacySop), ...cons.splitSopUnits(templateSop)];

// ---------------- 代码模板 ----------------
const templates = cons.templateTexts(travelTemplates);

/** 源码里的字符串字面量（注释、正则不算）：兜底，登记漏了的代码模板也逃不掉。定义规则的两个文件自己必然提到那句话，不扫 */
function sourceLiterals(): ConsistencyText[] {
  const out: ConsistencyText[] = [];
  const dirs = ['src/packs/travel', 'src/packs/travel/tools'];
  const skip = new Set(['consistency.ts', 'consistency-sop.ts']);
  for (const dir of dirs) {
    for (const file of fs.readdirSync(path.join(root, dir))) {
      if (!file.endsWith('.ts') || file.endsWith('.selftest.ts') || skip.has(file)) continue;
      const rel = `${dir}/${file}`;
      const sf = ts.createSourceFile(rel, fs.readFileSync(path.join(root, rel), 'utf8'), ts.ScriptTarget.Latest, true);
      const where = file === 'templates.ts' ? 'templates.ts' : `code:${rel}`;
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          out.push({ id: `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, where, text: node.text });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out;
}
const literals = sourceLiterals();
check('源码字面量扫描：扫到了东西', literals.length > 500, String(literals.length));

// ---------------- 工具提示 ----------------
const toolNotes = await consistency.toolNotes();
check(
  '工具提示：上浮 note、altitudeNote（三种）、intensityNote、payNote、日期提示、复用与作废旧单、库外目的地、境外全貌都登记了',
  toolNotes.length >= 18 &&
    ['order.reused', 'order.superseded', 'search.destination-miss', 'search.abroad'].every((id) =>
      toolNotes.some((n) => n.id === `tool-note:${id}`),
    ),
  String(toolNotes.length),
);

// ---------------- quote-final ----------------
{
  const texts: ConsistencyText[] = [...fixed, ...toolNotes, ...sopUnits, ...templates, ...literals];
  const all = cons.quoteFinalConflicts(texts);
  const res = resolveConflicts(all, cons.QUOTE_FINAL_EXEMPTIONS);
  check('quote-final：白名单之外没有冲突', res.failing.length === 0, `\n    ${names(res.failing)}`);
  check('quote-final：白名单已删，为空（第 16 步）', cons.QUOTE_FINAL_EXEMPTIONS.length === 0, JSON.stringify(cons.QUOTE_FINAL_EXEMPTIONS));
  check(
    'quote-final：旧版与模板模式的 SOP 里，任何位置都没有「按最终行程…微调」',
    ['legacy', 'template'].every((mode) => {
      const units = cons.splitSopUnits(mode === 'legacy' ? legacySop : templateSop);
      return units.every((u) => !cons.QUOTE_HEDGE.test(u.text));
    }),
  );
  check(
    'quote-final：templates.ts 的源码字面量里也没有',
    templates.every((t) => !cons.QUOTE_HEDGE.test(t.text)),
  );
  // 白名单之外不许有任何豁免：同一位置的另一条规则、别的位置，都不被它放过
  check(
    'quote-final：豁免只认「规则 + 位置」都对上',
    resolveConflicts(
      [{ rule: 'quote-final', a: 'x', b: 'y', detail: 'd', where: 'code:src/packs/travel/reply-helpers.ts' }],
      cons.QUOTE_FINAL_EXEMPTIONS,
    ).failing.length === 1 &&
      resolveConflicts([{ rule: 'fixed-vs-guards', a: 'x', b: 'y', detail: 'd', where: 'templates.ts' }], cons.QUOTE_FINAL_EXEMPTIONS)
        .failing.length === 1,
  );
}

// ---------------- quote-final 能抓到：合成的变异（文件级变异另在 shell 里做） ----------------
{
  const quoteLine = fixed.find((f) => f.id === 'fixed:quote.line.exact-date[legacy]')!;
  const mutated = cons.quoteFinalConflicts([{ ...quoteLine, text: `${quoteLine.text}\n起价，按最终行程微调。` }]);
  check(
    'quote-final 变异：报价模板加回「按最终行程微调」→ 点名 quote-final 和这条模板',
    mutated.length === 1 && formatConflict(mutated[0]!).startsWith('[quote-final] fixed:quote.line.exact-date[legacy]'),
    names(mutated),
  );
  check('quote-final 变异：「可能微调」也算', cons.quoteFinalConflicts([{ id: 't', where: 'w', text: '总价 ¥1，可能微调' }]).length === 1);
  check(
    'quote-final：产品库亮点「次日节奏微调」不算',
    cons.quoteFinalConflicts([{ id: 't', where: 'w', text: '每日行程复盘与次日节奏微调' }]).length === 0,
  );
  const noPrice = cons.quoteFinalConflicts([{ id: 'code:x.ts:1', where: 'code:x.ts', text: '起价，按最终行程微调' }]);
  check(
    'quote-final：同段没有确定价说法时，点名代码里的确定价模板',
    noPrice.length === 1 && noPrice[0]!.b === cons.QUOTE_TEMPLATE_ID && formatConflict(noPrice[0]!).includes(noPrice[0]!.a),
    names(noPrice),
  );
}

// ---------------- sop-vs-wordlist ----------------
const SOP_VS_WORDLIST_ITEMS = (): ConsistencyText[] => {
  const items: ConsistencyText[] = [];
  for (const m of [MODE_CTX[0]!, MODE_CTX[2]!]) {
    const sop = m.brand ? templateSop : legacySop;
    const rendered = sop.map((s) => s.text).join('');
    const label = m.brand ? 'template' : 'legacy';
    for (const rule of runtime.contractRules(m.brand ? { brand: m.brand } : 'legacy')) {
      if (rule.kind !== 'include') continue;
      check(`SOP_CONTRACT include「${rule.id}」确实在渲染后的 ${label} SOP 里`, rendered.includes(rule.text));
      // 禁说示例：SOP 点名不让说的话，词表删它是对的，不拿来查
      if (cons.SOP_FORBIDDEN_EXAMPLES.some((e) => e.contractId === rule.id)) {
        check(`禁说示例「${rule.id}」在渲染后的 ${label} SOP 里确实出现在禁说的上下文里`, cons.appearsAsForbidden(rendered, rule.text));
        continue;
      }
      items.push({ id: `sop-contract:${rule.id}[${label}]`, where: `sop-contract:${rule.id}`, text: rule.text, mode: m.mode });
    }
    for (const s of cons.SOP_REQUIRED_SENTENCES) {
      check(`SOP 要求说的固定句「${s.text}」确实在渲染后的 ${label} SOP 里`, rendered.includes(s.text));
      items.push({ id: `sop-sentence:${s.id}[${label}]`, where: `sop-sentence:${s.id}`, text: s.text, mode: m.mode });
    }
  }
  return items;
};
{
  // 禁说示例清单：不能是空的，每条都对应一条真实的 include 短语，也不能把所有 include 短语都放行
  const includes = runtime.contractRules('legacy').filter((r) => r.kind === 'include');
  check(
    '禁说示例清单：非空、每条对应一条 include 短语、只占其中一小部分',
    cons.SOP_FORBIDDEN_EXAMPLES.length > 0 &&
      cons.SOP_FORBIDDEN_EXAMPLES.every((e) => includes.some((r) => r.id === e.contractId)) &&
      cons.SOP_FORBIDDEN_EXAMPLES.length < includes.length,
  );
  const renderedLegacy = legacySop.map((x) => x.text).join('');
  const notForbidden = includes.filter((r) => !cons.SOP_FORBIDDEN_EXAMPLES.some((e) => e.contractId === r.id));
  check(
    '禁说示例的判法不是对所有短语放行：其余 include 短语里至少一半不在禁说上下文里',
    notForbidden.filter((r) => !cons.appearsAsForbidden(renderedLegacy, r.text)).length * 2 >= notForbidden.length,
  );
  const items = SOP_VS_WORDLIST_ITEMS();
  const conflicts = await cons.sopVsWordlistConflicts(items, consistency.wordlists());
  const res = resolveConflicts(conflicts, [], cons.SOP_VS_WORDLIST_PENDING);
  check('sop-vs-wordlist：待裁决清单之外没有冲突', res.failing.length === 0, `\n    ${names(res.failing)}`);
  check('sop-vs-wordlist：待裁决清单里的项都真的命中（没命中就删）', res.unusedPending.length === 0, JSON.stringify(res.unusedPending));
  // 变异：把「名额以付款为准」放进词表 → 点名 sop-vs-wordlist
  const poisoned = [...consistency.wordlists(), { id: 'wordlist:mutation', run: (t: string) => t.replaceAll('名额以付款为准', '') }];
  const bad = await cons.sopVsWordlistConflicts(items, poisoned);
  const hit = bad.filter((c) => c.b === 'wordlist:mutation');
  check(
    'sop-vs-wordlist 变异：词表删掉「名额以付款为准」→ 点名 sop-vs-wordlist 与 SOP 句',
    hit.length === 2 && hit.every((c) => formatConflict(c).startsWith('[sop-vs-wordlist] sop-sentence:push-by-payment')),
    names(hit),
  );
}

// ---------------- fixed-vs-guards ----------------
{
  const guards = [...consistency.textGuards(), ...consistency.wordlists()];
  // 声明的步骤确实在真实管线里；变换的步骤 id 也是；不经出口护栏的都写了原因
  const problems = originProblems({ items: fixed, transforms: guards, order });
  check(
    'fixed-vs-guards：每条固定文字声明的产出步骤都在真实管线里，变换的步骤 id 也对',
    problems.length === 0,
    `\n    ${problems.join('\n    ')}`,
  );
  check(
    'fixed-vs-guards：用的是真实管线顺序（stranded、encyclopedia、order_net 都在 markdown 之后或之前，与步骤表一致）',
    order.reply.indexOf('stranded') > order.reply.indexOf('markdown') &&
      order.reply.indexOf('encyclopedia') > order.reply.indexOf('markdown') &&
      order.reply.indexOf('order_net') < order.reply.indexOf('markdown'),
  );
  check(
    'fixed-vs-guards：每条固定文字都有声明，不经出口护栏的至少有 payment.paid',
    fixed.every((f) => f.origin) && fixed.some((f) => f.id.startsWith('fixed:payment.paid') && f.origin && 'outside' in f.origin),
  );
  const conflicts = await cons.fixedVsGuardsConflicts(fixed, guards, order);
  check(
    'fixed-vs-guards：没有冲突，也没有待裁决清单',
    conflicts.length === 0 && !('FIXED_VS_GUARDS_PENDING' in cons),
    `\n    ${names(conflicts)}`,
  );
  // 代码整段生成的推荐 / 线路列表单独给上限（8），和出口 shape_check 同一口径；清单对着真实步骤表核
  check(
    'fixed-vs-guards：置 fixedReply 的回复步骤清单与真实步骤表一致',
    [...FIXED_REPLY_STEPS].sort().join(',') ===
      pipelines.reply.steps
        .filter((s) => s.writes?.includes('fixedReply'))
        .map((s) => s.id)
        .sort()
        .join(','),
    pipelines.reply.steps
      .filter((s) => s.writes?.includes('fixedReply'))
      .map((s) => s.id)
      .join(','),
  );
  const listIds = fixed.filter((f) => f.generatedList).map((f) => f.id.replace(/\[.*$/, ''));
  check(
    'fixed-vs-guards：代码生成的推荐列表含 stranded.routes.high-altitude 与 recommend.deterministic',
    listIds.includes('fixed:stranded.routes.high-altitude') && listIds.includes('fixed:recommend.deterministic'),
    [...new Set(listIds)].join(','),
  );
  const high = fixed.find((f) => f.id === 'fixed:stranded.routes.high-altitude[legacy]')!;
  check(
    'fixed-vs-guards：高海拔线路列表 8 行，按列表上限 8 通过',
    high.generatedList && replyLineCount(high.text) === 8,
    String(replyLineCount(high.text)),
  );
  const nine = await cons.fixedVsGuardsConflicts([{ ...high, text: `${high.text}\n多一行` }], guards, order);
  check(
    'fixed-vs-guards 变异：代码生成的列表 9 行 → 点名列表上限 8',
    nine.some((c) => c.b === 'line-cap:list=8'),
    names(nine),
  );
  const seven = await cons.fixedVsGuardsConflicts(
    [
      {
        ...high,
        generatedList: false,
        text: high.text
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 7)
          .join('\n'),
      },
    ],
    guards,
    order,
  );
  check(
    'fixed-vs-guards：非代码生成的 rich 回复 7 行 → 点名 rich 上限 6',
    seven.some((c) => c.b === 'line-cap:rich=6'),
    names(seven),
  );
  const channelHits = cons.templateNoChannelConflicts(fixed);
  check('template-no-channel：模板模式的固定文字不点名渠道', channelHits.length === 0, `\n    ${names(channelHits)}`);
  // 变异：在某条 template 文字里加回「微信」→ 点名规则与文字 id
  {
    const tpl = fixed.find((f) => f.mode === 'template' && f.id.startsWith('fixed:order.net.created.advisor'))!;
    const bad = cons.templateNoChannelConflicts([{ ...tpl, text: `${tpl.text}顾问会在微信上联系您。` }]);
    check(
      'template-no-channel 变异：template 文字里加回「微信」→ 点名规则与文字 id',
      bad.length === 1 && formatConflict(bad[0]!).startsWith(`[template-no-channel] ${tpl.id}`),
      names(bad),
    );
    const legacyOnly = cons.templateNoChannelConflicts([{ ...tpl, mode: 'legacy', text: `${tpl.text}顾问会在微信上联系您。` }]);
    check('template-no-channel：旧版 / 网页渲染里的「微信」不查', legacyOnly.length === 0, names(legacyOnly));
  }
  check(
    'fixed-vs-guards：纯文字护栏清单',
    consistency
      .textGuards()
      .map((g) => g.id)
      .join(',') === 'guard:markdown,guard:dangling,guard:advisor_prefix,guard:dejargon,guard:final_clean,guard:adults,guard:post_handoff',
  );
  // 变异：一条固定文字带 markdown 加粗、超行数 → 各自点名 fixed-vs-guards
  const sample = fixed.find((f) => f.id === 'fixed:fallback.quote[legacy]')!;
  const md = await cons.fixedVsGuardsConflicts([{ ...sample, text: `**${sample.text}**` }], guards, order);
  check(
    'fixed-vs-guards 变异：固定文字带加粗 → 点名 fixed-vs-guards 与 guard:markdown',
    md.length === 1 && formatConflict(md[0]!).startsWith('[fixed-vs-guards] fixed:fallback.quote[legacy]  <->  guard:markdown'),
    names(md),
  );
  const long = await cons.fixedVsGuardsConflicts([{ ...sample, text: '一\n二\n三\n四' }], guards, order);
  check('fixed-vs-guards 变异：普通类 4 行 → 点名行数上限', long.length === 1 && long[0]!.b === 'line-cap:plain=3', names(long));
  // 位置很要紧：两格缩进的线路列表，如果当作管线开头产出的，markdown 会改它；按真实位置（stranded 之后）就不改
  const routes = fixed.find((f) => f.id === 'fixed:stranded.routes[legacy]')!;
  const early = await cons.fixedVsGuardsConflicts([{ ...routes, origin: { pipeline: 'reply', step: 'pre_clean' } }], guards, order);
  const late = await cons.fixedVsGuardsConflicts([routes], guards, order);
  check(
    'fixed-vs-guards：线路列表按真实产出位置（stranded）不被 markdown 改，放到管线开头就会被改',
    early.some((c) => c.b === 'guard:markdown') && !late.some((c) => c.b === 'guard:markdown'),
    names(late),
  );
  const bad = originProblems({ items: [{ ...routes, origin: { pipeline: 'reply', step: 'no_such_step' } }], transforms: guards, order });
  check('fixed-vs-guards：声明了管线里没有的步骤 → 自测点名', bad.length === 1 && bad[0]!.includes('no_such_step'), bad.join(';'));
}

// ---------------- 契约检查：consistency 默认开 ----------------
{
  const spec = TRAVEL_SOP_SECTIONS;
  const toolNames = toolDefs.map((t) => t.function.name);
  const contract = (sections: ReturnType<typeof splitSop>, over: { consistency?: boolean } = {}) =>
    checkSopContract({
      sections,
      imageSections: legacySop,
      rendered: renderSystemPrompt(joinSop(sections)),
      toolNames,
      knownFields: runtime.knownFields.names,
      baselineEditableChars: null,
      ...over,
    });
  const edit = (key: string, extra: string) =>
    legacySop.map((s, i) => (s.key === key ? withBody(spec[i]!, `${sectionBody(s, spec[i]!)}\n${extra}`, i === spec.length - 1) : s));
  const draft = edit('tone', '- 报价要写成「起价，按最终行程微调」，总价 ¥1 不作数。');
  check('契约：当前 data/sop.md 默认就是零 violation（没有白名单）', contract(legacySop).length === 0);
  check(
    '契约：模板模式渲染出来的 SOP 也是零 consistency',
    contract(templateSop, { consistency: true }).every((v) => v.code !== 'consistency'),
  );
  const on = contract(draft).filter((v) => v.code === 'consistency');
  check(
    '契约：默认就拦（验收 12 第三项），违规码 consistency，落在 tone 节，点名规则和冲突的模板',
    on.length === 1 &&
      on[0]!.sectionKey === 'tone' &&
      on[0]!.match === '按最终行程微调' &&
      on[0]!.detail.startsWith('[quote-final] sop:tone/') &&
      on[0]!.detail.includes('总价'),
    JSON.stringify(on),
  );
  check(
    '契约：只有显式传 false 才关',
    contract(draft, { consistency: false }).every((v) => v.code !== 'consistency'),
  );
  const noPrice = contract(edit('tone', '- 报价后补一句：这是起价，按最终行程微调。')).filter((v) => v.code === 'consistency');
  check(
    '契约：同段没有确定价说法时，点名代码里的报价模板',
    noPrice.length === 1 && noPrice[0]!.detail.includes(cons.QUOTE_TEMPLATE_ID),
    JSON.stringify(noPrice),
  );
}

if (failures.length) {
  console.error(`CONSISTENCY SELFTEST FAIL: ${failures.length} 项\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
assert.ok(passed > 0);
console.log(
  `CONSISTENCY SELFTEST PASS: ${passed} 项断言全通（登记 / 四条规则：quote-final、sop-vs-wordlist、fixed-vs-guards、template-no-channel / 变异 / 契约 consistency 默认开）`,
);
process.exit(0);
