// 配置层自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。现在有两块纯内核：
// - SOP：节表与 data/sop.md 的逐字节往返、规范形、编码检查、契约检查的每种 violation（验收 6 的纯函数部分、验收 3 的编码部分），
//   以及守着契约清单不漂移的测试；
// - 产品库：schema、锁定字段、键序合并、补丁与表单往返，文件模式的快照冻结（验收 4 的文件模式部分）。
// 配置源、导入导出、编辑流程等在后面几步往这里加。
// 用法：npx tsx src/config/config.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// 先设临时 VAR_DIR 再动态 import：engine 会连带加载 store.ts，它在加载时就读 VAR_DIR
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-config-selftest-'));
process.env.LLM_MOCK = '1';
// 开发机 .env 里写着 CONFIG_SOURCE=db 也不能影响这组：DB 模式只经 initConfig(deps) 显式装上
process.env.CONFIG_SOURCE = 'file';

const root = path.join(import.meta.dirname, '..', '..');
const { TRAVEL_SOP_SECTIONS, splitSop, joinSop, sectionBody, withBody, normalizeBody, mergeWithImage, editableChars, assertSopEncoding } =
  await import('../sop/sections.js');
const { SOP_CONTRACT, SOP_KNOWN_FIELDS, KNOWN_FIELD_SOURCES, BUDGET_RATIO, checkSopContract } = await import('../sop/contract.js');
const { renderSystemPrompt } = await import('../prompt/system.js');
const toolDefsModule = await import('../tool-defs.js');
const { toolDefs: toolDefsViaTools } = await import('../tools.js');
const { promptPrefix, __engineTest } = await import('../engine.js');
const { loadRoutes, loadHotels, searchHotels } = await import('../tools.js');
const { RouteSchema, HotelSchema, lockedFieldChanges, mergeKeyOrder, applyCatalogPatch, LOCKED_WHEN_ACTIVE, ALWAYS_LOCKED } =
  await import('../shared/catalog.js');
const { deepFreeze } = await import('../shared/freeze.js');
const { sha256 } = await import('./hashes.js');
type SopSection = import('../sop/sections.js').SopSection;
type ViolationCode = import('../sop/contract.js').ViolationCode;

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
/** 抛出的错误类名；不抛返回 'ok' */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}
const ch = (code: number): string => String.fromCharCode(code);

const md = fs.readFileSync(path.join(root, 'data', 'sop.md'), 'utf8');
const image = splitSop(md);
const spec = TRAVEL_SOP_SECTIONS;
const specOf = (key: string) => spec.find((s) => s.key === key)!;
const indexOf = (key: string): number => spec.findIndex((s) => s.key === key);
const toolNames = toolDefsModule.toolDefs.map((t) => t.function.name);

// ---------------- 节表与 data/sop.md ----------------
check('节表：11 节，第一节是前言', spec.length === 11 && spec[0]?.key === 'preamble' && spec[0].heading === null);
check(
  '节表：锁定 7 节',
  spec
    .filter((s) => s.locked)
    .map((s) => s.key)
    .join(',') === 'stages,orders,quote-discipline,price-rules,capabilities,no-destinations,handoff',
);
check('data/sop.md：切成 11 节，key 与节表一致', image.map((s) => s.key).join(',') === spec.map((s) => s.key).join(','));
check('data/sop.md：切开再拼回逐字节相同', joinSop(image) === md);
for (const [i, s] of spec.entries()) {
  const section = image[i]!;
  const body = sectionBody(section, s);
  check(`规范形：「${s.key}」已是规范形`, normalizeBody(body, i === spec.length - 1) === body);
  // 后台只提交可编辑节的正文：GET 到的正文原样 PUT 回去，节的字节不变，哈希也就不变
  check(`GET→PUT：「${s.key}」原样提交回去字节不变`, withBody(s, body, i === spec.length - 1).text === section.text);
}
check('mergeWithImage：同一份合并是恒等', joinSop(mergeWithImage(image, image)) === md);
check(
  'editableChars：等于四个可编辑节正文长度之和',
  editableChars(image) === spec.filter((s) => !s.locked).reduce((n, s) => n + sectionBody(image[indexOf(s.key)]!, s).length, 0),
);

// ---------------- 合并 ----------------
{
  const replace = (sections: readonly SopSection[], key: string, text: string): SopSection[] =>
    sections.map((s) => (s.key === key ? { key, text } : s));
  const toneText = `## 话术原则\n\n改过的话术。\n\n`;
  const stagesText = `## 各阶段目标\n\n运营想改锁定节。\n\n`;
  const stored = replace(replace(image, 'tone', toneText), 'stages', stagesText);
  const merged = mergeWithImage(stored, image);
  check('mergeWithImage：可编辑节取存下来的', merged[indexOf('tone')]?.text === toneText);
  check('mergeWithImage：锁定节永远取镜像', merged[indexOf('stages')]?.text === image[indexOf('stages')]?.text);
  const partial = mergeWithImage(
    stored.filter((s) => s.key !== 'objections'),
    image,
  );
  check('mergeWithImage：存下来的缺某个可编辑节时取镜像', partial[indexOf('objections')]?.text === image[indexOf('objections')]?.text);
  const extra = mergeWithImage([...stored, { key: 'old-section', text: '## 旧节\n\n旧的。\n\n' }], image);
  check('mergeWithImage：节表里已经没有的节丢掉', extra.length === spec.length && !extra.some((s) => s.key === 'old-section'));
  // 旧节表里末节在前面、结尾是 \n\n：按当前节表重建后末节只留一个换行
  const oldLast = replace(image, 'wechat-style', `## 旧标题\n\n微信语气。\n\n`);
  const rebuilt = mergeWithImage(oldLast, image).at(-1)!;
  check(
    'mergeWithImage：可编辑节按当前节表重建标题与结尾',
    rebuilt.text === `## 微信语气规范\n\n微信语气。\n`,
    JSON.stringify(rebuilt.text),
  );
}

// ---------------- 编码检查（验收 3 的编码部分） ----------------
{
  const BOM = ch(0xfeff);
  const cases: [string, string][] = [
    ['BOM', BOM + md],
    ['\\r\\n', md.replace('\n', '\r\n')],
    ['单独的 \\r', md.replace('云途', `云途${ch(13)}x`)],
    ['NFD 字符', md.replace('云途', `云途 e${ch(0x301)}`)],
    ['孤立代理项', md.replace('云途', `云途${ch(0xd800)}`)],
    ['NUL', md.replace('云途', `云途${ch(0)}`)],
    ['其他 C0 控制字符', md.replace('云途', `云途${ch(0x07)}`)],
    ['U+2028', md.replace('云途', `云途${ch(0x2028)}`)],
    ['U+2029', md.replace('云途', `云途${ch(0x2029)}`)],
  ];
  for (const [what, text] of cases) {
    check(`编码：含${what}被 assertSopEncoding 拒`, thrown(() => assertSopEncoding(text)) === 'SopEncodingError');
    check(`编码：含${what}的文件 splitSop 也拒`, thrown(() => splitSop(text)) === 'SopEncodingError');
  }
  check('编码：制表符与换行照收', thrown(() => assertSopEncoding('a\tb\nc')) === 'ok');
  check('编码：当前 data/sop.md 合格', thrown(() => assertSopEncoding(md)) === 'ok');

  // 规范化：BOM、CRLF、NFD、行尾空白、开头空行、末尾空白都修掉；修不了的字符直接拒，不替换
  const messy = `${BOM}\n\n第一行  \r\n第二行 e${ch(0x301)}\t\r\n\n   \n`;
  check(
    '规范化：能修的都修掉，非末节以空行结尾',
    normalizeBody(messy, false) === `第一行\n第二行 é\n\n`,
    JSON.stringify(normalizeBody(messy, false)),
  );
  check('规范化：末节以一个换行结尾', normalizeBody('末节  \n\n', true) === '末节\n');
  check('规范化：单独的 \\r 换成 \\n', normalizeBody(`a${ch(13)}b`, true) === 'a\nb\n');
  check('规范化：行首缩进保留', normalizeBody('  · 一条\n', true) === '  · 一条\n');
  for (const [what, bad] of [
    ['行尾的 U+2028', `一行${ch(0x2028)}`],
    ['孤立代理项', `一行${ch(0xdc00)}`],
    ['NUL', `一行${ch(0)}`],
  ]) {
    check(`规范化：${what}直接拒，不当空白删掉`, thrown(() => normalizeBody(bad!, true)) === 'SopEncodingError');
  }
}

// ---------------- 结构 ----------------
{
  const structure = (text: string): string => thrown(() => splitSop(text));
  check('结构：标题改一个字被拒', structure(md.replace('## 话术原则\n', '## 话术原则们\n')) === 'SopStructureError');
  check('结构：少一节被拒', structure(md.replace(/## 异议处理\n[\s\S]*?(?=## 能力边界)/, '')) === 'SopStructureError');
  check('结构：多一节被拒', structure(md.replace('## 异议处理\n', '## 新节\n\n多出来的。\n\n## 异议处理\n')) === 'SopStructureError');
  check('结构：标题后缺空行被拒', structure(md.replace('## 话术原则\n\n', '## 话术原则\n')) === 'SopStructureError');
  check('结构：末尾多一节被拒', structure(`${md}## 附录\n\n内容\n`) === 'SopStructureError');
  // 空正文要写成规范形（非末节 \n\n、末节 \n），否则先被「不是规范形」拦下，测不到「正文为空」本身
  check(
    '结构：非末节正文为空被拒',
    structure(md.replace(/## 异议处理\n\n[\s\S]*?(?=## 能力边界)/, '## 异议处理\n\n\n\n')) === 'SopStructureError',
  );
  check('结构：末节正文为空被拒', structure(md.replace(/## 微信语气规范\n\n[\s\S]*$/, '## 微信语气规范\n\n\n')) === 'SopStructureError');
  check(
    '结构：正文开头多一个空白行（不是规范形）被拒',
    structure(md.replace('## 话术原则\n\n', '## 话术原则\n\n  \n')) === 'SopStructureError',
  );
  const trailing = md.replace(/(## 话术原则\n\n[^\n]*)\n/, '$1 \n');
  check('结构：正文某行带行尾空格被拒', trailing !== md && structure(trailing) === 'SopStructureError');
  check('结构：末节多一个空行被拒', structure(`${md}\n`) === 'SopStructureError');
  check('withBody：正文为空被拒', thrown(() => withBody(specOf('tone'), '  \n\n', false)) === 'SopStructureError');
  check(
    'withBody：正文里有行首「## 」被拒',
    thrown(() => withBody(specOf('wechat-style'), '正文\n## 新节\n内容', true)) === 'SopStructureError',
  );
  check('withBody：「### 」小标题照收', thrown(() => withBody(specOf('tone'), '### 小标题\n内容', false)) === 'ok');
  check(
    'sectionBody：标题不对抛结构错误',
    thrown(() => sectionBody({ key: 'tone', text: '## 别的\n\n正文\n\n' }, specOf('tone'))) === 'SopStructureError',
  );
}

// ---------------- 渲染与工具定义 ----------------
check(
  '渲染：renderSystemPrompt(data/sop.md) 与引擎的 buildSystemPrompt 逐字节相同',
  renderSystemPrompt(md) === __engineTest.buildSystemPrompt(),
);
check('渲染：promptPrefix().system 也经它', promptPrefix().system === renderSystemPrompt(md));
check('渲染：同一份输入渲染两遍结果相同', renderSystemPrompt(md) === renderSystemPrompt(md));
check('渲染：以 SOP 开头，硬性要求在后', renderSystemPrompt(md).startsWith(md) && renderSystemPrompt('').startsWith('\n\n【硬性要求】'));
check('工具定义：tools.ts 再导出的就是 tool-defs.ts 的同一个数组', toolDefsViaTools === toolDefsModule.toolDefs);
check('工具定义：promptPrefix().tools 等于 JSON.stringify(toolDefs)', promptPrefix().tools === JSON.stringify(toolDefsModule.toolDefs));

// ---------------- 契约检查 ----------------
const contract = (sections: readonly SopSection[], over: Partial<Parameters<typeof checkSopContract>[0]> = {}) =>
  checkSopContract({
    sections,
    imageSections: image,
    rendered: renderSystemPrompt(joinSop(sections)),
    toolNames,
    knownFields: SOP_KNOWN_FIELDS,
    baselineEditableChars: null,
    ...over,
  });
const codes = (vs: { code: ViolationCode; sectionKey: string | null }[]): string =>
  vs.map((v) => `${v.code}@${v.sectionKey ?? '-'}`).join(' ');
/** 把某个可编辑节的正文换成 body，其余不动（后台保存草稿就是这样） */
const editBody = (key: string, body: (old: string) => string): SopSection[] =>
  image.map((s, i) => (s.key === key ? withBody(spec[i]!, body(sectionBody(s, spec[i]!)), i === spec.length - 1) : s));

{
  const clean = contract(image, { baselineEditableChars: editableChars(image) });
  check('契约：当前 data/sop.md 零 violation（含预算）', clean.length === 0, JSON.stringify(clean));

  // 验收 6 的五种草稿
  const forbidden = contract(editBody('tone', (b) => `${b}\n明显超出我们现有线路的范围，就转人工。`));
  check('契约：话术原则里写进禁用短语 → phrase_forbidden@tone', codes(forbidden) === 'phrase_forbidden@tone', codes(forbidden));
  for (const name of ['search_route', 'create_refund']) {
    const vs = contract(editBody('objections', (b) => `${b}\n嫌贵时调 ${name} 看看。`));
    check(
      `契约：异议处理里写 ${name} → unknown_tool@objections`,
      codes(vs) === 'unknown_tool@objections' && vs[0]!.detail.includes(name),
      codes(vs),
    );
  }
  const field = contract(editBody('objections', (b) => `${b}\n看结果里的 destinationMissing。`));
  check('契约：写 destinationMissing → unknown_field', codes(field) === 'unknown_field@objections', codes(field));
  const newSection = image.map((s) => (s.key === 'wechat-style' ? { key: s.key, text: `${s.text}## 新节\n\n多一节。\n` } : s));
  const struct = contract(newSection);
  check(
    '契约：微信语气规范的正文里加一行「## 新节」→ structure@wechat-style',
    codes(struct).split(' ').includes('structure@wechat-style'),
    codes(struct),
  );
  const baseline = editableChars(image);
  const limit = Math.floor(baseline * BUDGET_RATIO);
  const grow = (k: number): SopSection[] => editBody('tone', (b) => b + '多'.repeat(k));
  // 追加在正文末尾时，规范化会在原结尾和新内容之间留一个空行：多出来的那几个字符先量出来
  const newline = editableChars(grow(1)) - baseline - 1;
  const atLimit = grow(limit - baseline - newline);
  const grown = grow(limit - baseline - newline + 1);
  check(
    '契约：正好在上限上不算超',
    editableChars(atLimit) === limit && contract(atLimit, { baselineEditableChars: baseline }).length === 0,
  );
  check(
    '契约：可编辑节超出导入时的 120% → over_budget',
    editableChars(grown) === limit + 1 && codes(contract(grown, { baselineEditableChars: baseline })) === 'over_budget@-',
  );
  check('契约：预算传 null 不查', contract(grown).length === 0);

  // 其余几种 code
  const lockedEdit = image.map((s) => (s.key === 'price-rules' ? { key: s.key, text: s.text.replace('定价只有两条规则', '定价规则') } : s));
  const lockedVs = contract(lockedEdit);
  check(
    '契约：改了锁定节 → locked_changed（顺带丢了必需短语）',
    codes(lockedVs) === 'locked_changed@price-rules phrase_missing@-',
    codes(lockedVs),
  );
  // 代码部署改了锁定节、镜像也跟着变时，只剩 phrase_missing：这正是「要求出现」这一类防的情况
  const missing = contract(lockedEdit, { imageSections: lockedEdit });
  check(
    '契约：镜像里的锁定节丢了必需短语 → phrase_missing',
    codes(missing) === 'phrase_missing@-' && missing[0]!.detail.includes('定价只有两条规则'),
    codes(missing),
  );
  const pattern = contract(editBody('objections', (b) => `${b}\n嫌贵就换酒店档。`));
  check(
    '契约：命中禁用模式 → phrase_forbidden',
    codes(pattern) === 'phrase_forbidden@objections' && pattern[0]!.detail.includes('换酒店档'),
    codes(pattern),
  );
  const order = contract(image.toReversed());
  check('契约：节的顺序不对 → structure', codes(order).startsWith('structure@-'), codes(order));
  const noBlank = image.map((s) => (s.key === 'tone' ? { key: s.key, text: s.text.replace('## 话术原则\n\n', '## 话术原则\n') } : s));
  check('契约：标题后缺空行 → structure@tone', codes(contract(noBlank)).split(' ').includes('structure@tone'));
  const emptyBody = contract(image.map((x) => (x.key === 'objections' ? { key: x.key, text: '## 异议处理\n\n\n\n' } : x)));
  check('契约：正文为空 → structure@objections', codes(emptyBody).split(' ').includes('structure@objections'), codes(emptyBody));
  // 短语规则对的是整段 rendered（含硬性要求），不是各节：只改 rendered 也要拦得住
  const rendered = renderSystemPrompt(md);
  const extraForbidden = contract(image, { rendered: `${rendered}\n明显超出我们现有线路的范围` });
  check(
    '契约：rendered 里出现禁用短语 → phrase_forbidden（不在任何一节里）',
    codes(extraForbidden) === 'phrase_forbidden@-',
    codes(extraForbidden),
  );
  const lostRequired = contract(image, { rendered: rendered.replace('定价只有两条规则', '') });
  check('契约：rendered 里丢了必需短语 → phrase_missing', codes(lostRequired) === 'phrase_missing@-', codes(lostRequired));
  const multi = contract(editBody('objections', (b) => `${b}\n先调 get_route_details，再看 maxBudgetPerKid。`));
  check(
    '契约：多段下划线的未知工具、多个驼峰的未知字段都拦',
    codes(multi) === 'unknown_tool@objections unknown_field@objections',
    codes(multi),
  );
  check(
    '契约：大写开头的词与纯小写单词不查',
    contract(editBody('tone', (b) => `${b}\n住 Aman 或 WeChat 里说，greeting 与 emoji 都行。`)).length === 0,
  );
  check('契约：已有的工具名与字段名照收', contract(editBody('tone', (b) => `${b}\n报价调 create_quote，看 withinBudget。`)).length === 0);
}

// ---------------- 产品库：schema ----------------
const routesRaw = fs.readFileSync(path.join(root, 'data', 'routes.json'), 'utf8');
const hotelsRaw = fs.readFileSync(path.join(root, 'data', 'hotels.json'), 'utf8');
/** 与请求原文等价：每次重新 parse，拿到一份可以随便改的普通对象 */
const freshRoutes = (): Record<string, unknown>[] => JSON.parse(routesRaw) as Record<string, unknown>[];
const freshHotels = (): Record<string, unknown>[] => JSON.parse(hotelsRaw) as Record<string, unknown>[];
{
  const bad = freshRoutes().flatMap((r) => (RouteSchema.safeParse(r).success ? [] : [String(r.id)]));
  const badH = freshHotels().flatMap((h) => (HotelSchema.safeParse(h).success ? [] : [String(h.id)]));
  check('schema：data/routes.json 每条都能过 RouteSchema', bad.length === 0, bad.join(','));
  check('schema：data/hotels.json 每条都能过 HotelSchema', badH.length === 0, badH.join(','));
  const base = freshRoutes()[0]!;
  const itin = base.itinerary as Record<string, unknown>[];
  const rejects: [string, Record<string, unknown>][] = [
    ['顶层有未知键', { ...base, discount: 0.9 }],
    ['行程里有未知键', { ...base, itinerary: [{ ...itin[0], note: 'x' }, ...itin.slice(1)] }],
    ['强度里有未知键', { ...base, intensity: { level: '轻松', hardest: '行程没写', extra: 1 } }],
    // 删最后一天：天号仍从 1 连续，只剩条数与 days 对不上
    ['逐日行程条数不等于 days', { ...base, itinerary: itin.slice(0, -1) }],
    ['行程天号不连续', { ...base, itinerary: itin.map((d, i) => (i === 0 ? { ...d, day: 2 } : d)) }],
    ['bestSeason 解析不出月份', { ...base, bestSeason: '随时都行' }],
    ['priceFrom 是字符串（不做 coerce）', { ...base, priceFrom: '12800' }],
    ['priceFrom 不是整数', { ...base, priceFrom: 12800.5 }],
    ['可选数组为空', { ...base, aliases: [] }],
    ['字符串数组里有空串', { ...base, highlights: ['', '雪山'] }],
    ['缺必填字段', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'hotelLevel'))],
    ['id 不合 code 规则', { ...base, id: 'R_Upper' }],
    ['客群不在五类里', { ...base, segments: ['学生'] }],
    ['overseas 不是布尔', { ...base, overseas: 'no' }],
    ['缺 overseas（表单上没勾的框不能存成缺）', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'overseas'))],
    ['priceFrom 是 0', { ...base, priceFrom: 0 }],
    ['maxAltitude 是负数', { ...base, maxAltitude: -1 }],
    ['maxAltitude 不是整数', { ...base, maxAltitude: 3500.5 }],
    ['segments 为空', { ...base, segments: [] }],
    ['highlights 为空', { ...base, highlights: [] }],
    ['标题是空串', { ...base, title: '' }],
    ['inclusions 为空', { ...base, inclusions: [] }],
    ['exclusions 为空', { ...base, exclusions: [] }],
    ['别名里有空串', { ...base, aliases: [''] }],
    ['强度档位不在三档里', { ...base, intensity: { level: '很累', hardest: '行程没写' } }],
    ['id 里有 code 规则以外的字符（末尾也要锚住）', { ...base, id: 'r-ok_X' }],
    ['id 超过 64 位', { ...base, id: `r${'a'.repeat(64)}` }],
  ];
  for (const [what, r] of rejects) check(`schema：${what}被拒`, !RouteSchema.safeParse(r).success);
  check('schema：全年适游不需要月份', RouteSchema.safeParse({ ...base, bestSeason: '全年适游' }).success);
  check('schema：id 正好 64 位可以', RouteSchema.safeParse({ ...base, id: `r${'a'.repeat(63)}` }).success);
  const h0 = freshHotels()[0]!;
  const hotelRejects: [string, Record<string, unknown>][] = [
    ['有未知键', { ...h0, breakfast: true }],
    ['nightlyFrom 是字符串', { ...h0, nightlyFrom: '2000' }],
    ['nightlyFrom 不是整数', { ...h0, nightlyFrom: 2000.5 }],
    ['nightlyFrom 是 0', { ...h0, nightlyFrom: 0 }],
    ['highlights 为空', { ...h0, highlights: [] }],
    ['名称是空串', { ...h0, name: '' }],
    ['id 不合 code 规则', { ...h0, id: 'H_Upper' }],
  ];
  for (const [what, h] of hotelRejects) check(`schema：酒店${what}被拒`, !HotelSchema.safeParse(h).success);
}

// ---------------- 产品库：锁定字段 ----------------
{
  const r = freshRoutes()[0]!;
  const tags = r.tags as string[];
  const changed = (over: Record<string, unknown>, status: 'draft' | 'active' = 'active', drop: string[] = []): string => {
    const next = { ...r, ...over };
    for (const k of drop) delete next[k];
    return lockedFieldChanges('route', status, r, next).join(',');
  };
  check('锁定：active 改 priceFrom 被点名', changed({ priceFrom: 1 }) === 'priceFrom');
  check('锁定：active 同时改 title 与 days，按锁定表顺序点名', changed({ days: 99, title: '新标题' }) === 'title,days');
  check(
    '锁定：「国内」这一项的有无算锁定字段',
    changed({ tags: tags.includes('国内') ? tags.filter((t) => t !== '国内') : [...tags, '国内'] }) === 'tags:国内',
  );
  check('锁定：「国内」以外的 tag 可以改', changed({ tags: [...tags, '小众'] }) === '');
  const multi = freshRoutes().find((x) => ((x.aliases as string[] | undefined)?.length ?? 0) >= 2)!;
  check(
    '锁定：aliases 换顺序也算改',
    lockedFieldChanges('route', 'active', multi, { ...multi, aliases: (multi.aliases as string[]).toReversed() }).join(',') === 'aliases',
  );
  check('锁定：active 删掉 inclusions 算改', changed({}, 'active', ['inclusions']) === 'inclusions');
  check(
    '锁定：highlights、itinerary、intensity、hotelLevel 可以改',
    changed({ highlights: ['新亮点'], itinerary: [], intensity: undefined, hotelLevel: '五星' }) === '',
  );
  check('锁定：只换键序不算改', lockedFieldChanges('route', 'active', r, Object.fromEntries(Object.entries(r).toReversed())).length === 0);
  check('锁定：draft 只锁 id', changed({ priceFrom: 1, title: 'x' }, 'draft') === '' && changed({ id: 'r-other' }, 'draft') === 'id');
  check('锁定：active 改 id 也被点名', changed({ id: 'r-other' }) === 'id');
  const noDomestic = tags.filter((t) => t !== '国内');
  check(
    '锁定：「国内」按整项比，不按子串（删掉「国内」只留「国内游」算改，只加「国内游」不算）',
    lockedFieldChanges(
      'route',
      'active',
      { ...r, tags: [...noDomestic, '国内', '国内游'] },
      { ...r, tags: [...noDomestic, '国内游'] },
    ).join(',') === 'tags:国内' &&
      lockedFieldChanges('route', 'active', { ...r, tags: noDomestic }, { ...r, tags: [...noDomestic, '国内游'] }).length === 0,
  );
  const h = freshHotels()[0]!;
  check(
    '锁定：酒店 active 改 nightlyFrom 被点名、改 stars 不算',
    lockedFieldChanges('hotel', 'active', h, { ...h, nightlyFrom: 1, stars: '奢华' }).join(',') === 'nightlyFrom',
  );
  check(
    '锁定：锁定表与 spec 一致',
    LOCKED_WHEN_ACTIVE.route.join(',') ===
      'id,title,destination,days,priceFrom,bestSeason,segments,aliases,maxAltitude,overseas,tags:国内,inclusions,exclusions' &&
      LOCKED_WHEN_ACTIVE.hotel.join(',') === 'id,name,destination,nightlyFrom' &&
      ALWAYS_LOCKED.join(',') === 'id' &&
      ALWAYS_LOCKED.every(
        (f) => (LOCKED_WHEN_ACTIVE.route as readonly string[]).includes(f) && (LOCKED_WHEN_ACTIVE.hotel as readonly string[]).includes(f),
      ),
  );
}

// ---------------- 产品库：键序合并与补丁 ----------------
{
  const prev = { a: 1, b: { x: 1, y: 2 }, c: [{ p: 1, q: 2 }] };
  const next = { d: 1, c: [{ q: 3, p: 4 }, { z: 1 }], b: { w: 7, y: 5, x: 6 } } as unknown as typeof prev;
  check(
    'mergeKeyOrder：原有的键按旧序、新增的追加在后、删掉的去掉，嵌套对象与数组元素逐层递归',
    JSON.stringify(mergeKeyOrder(prev, next)) === '{"b":{"x":6,"y":5,"w":7},"c":[{"p":4,"q":3},{"z":1}],"d":1}',
    JSON.stringify(mergeKeyOrder(prev, next)),
  );
  check(
    'mergeKeyOrder：新增的几个键按它们在新对象里的顺序追加',
    Object.keys(mergeKeyOrder({ a: 1 } as Record<string, number>, { a: 1, x: 1, y: 2 })).join(',') === 'a,x,y',
  );
  const r = freshRoutes()[1]!;
  const expectOnly = (patched: Record<string, unknown>, field: string, value: unknown): boolean =>
    JSON.stringify(patched) === JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === field ? value : v])));
  check(
    '补丁：只改 highlights，其余字节与键序不变',
    expectOnly(applyCatalogPatch(r, { set: { highlights: ['只改这一项'] } }), 'highlights', ['只改这一项']),
  );
  // 请求里的嵌套对象键序与库里不同（比如表单或 zod 按 schema 顺序重排过）：写库的仍按库里原来的键序
  const intensity = r.intensity as { level: string; hardest: string };
  const reordered = applyCatalogPatch(r, { set: { intensity: { hardest: intensity.hardest, level: intensity.level } } });
  check('补丁：嵌套对象按旧键序写回，值相同就逐字节不变', JSON.stringify(reordered) === JSON.stringify(r));
  const unset = applyCatalogPatch(r, { set: {}, unset: ['intensity'] });
  check(
    '补丁：unset 删掉字段、其余不动',
    !('intensity' in unset) &&
      Object.keys(unset).join(',') ===
        Object.keys(r)
          .filter((k) => k !== 'intensity')
          .join(','),
  );
  // 挑一个不在末尾的可选字段：去掉它再加回来，它应当落到最后
  const keys = Object.keys(r);
  const opt = keys.find(
    (k, i) => i < keys.length - 1 && ['aliases', 'maxAltitude', 'intensity', 'inclusions', 'exclusions', 'overseas'].includes(k),
  )!;
  const without = Object.fromEntries(Object.entries(r).filter(([k]) => k !== opt));
  const added = applyCatalogPatch(without, { set: { [opt]: r[opt] } });
  check('补丁：新加的字段追加在末尾', Object.keys(added).at(-1) === opt, `${opt} → ${Object.keys(added).join(',')}`);
  let threw = false;
  try {
    applyCatalogPatch(r, { set: { intensity }, unset: ['intensity'] });
  } catch {
    threw = true;
  }
  check('补丁：同一字段既 set 又 unset 直接拒', threw);
  // 请求原文里的 __proto__ 只能是个普通键：不改结果对象的原型，更不能污染 Object.prototype，并且被 strict schema 拒掉
  const hostile = applyCatalogPatch(r, { set: JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown> });
  check(
    '补丁：__proto__ 键不改原型、不污染 Object.prototype、过不了 schema',
    Object.getPrototypeOf(hostile) === Object.prototype &&
      !('polluted' in {}) &&
      Object.hasOwn(hostile, '__proto__') &&
      !RouteSchema.safeParse(hostile).success,
  );
  // 表单往返：把每条的全部字段按现值提交回去，写库对象逐字节不变、没有锁定字段变化、仍能过 schema
  const roundTrip = (kind: 'route' | 'hotel', items: Record<string, unknown>[]): string[] =>
    items.flatMap((item) => {
      const form = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
      const out = applyCatalogPatch(item, { set: form });
      const schema = kind === 'route' ? RouteSchema : HotelSchema;
      const ok =
        JSON.stringify(out) === JSON.stringify(item) &&
        lockedFieldChanges(kind, 'active', item, out).length === 0 &&
        schema.safeParse(out).success;
      return ok ? [] : [String(item.id)];
    });
  const rt = [...roundTrip('route', freshRoutes()), ...roundTrip('hotel', freshHotels())];
  check('表单往返：每条线路和酒店原样提交回去逐字节不变', rt.length === 0, rt.join(','));
}

// ---------------- 产品库：文件模式的快照冻结（验收 4） ----------------
{
  const assignThrows = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof TypeError;
    }
  };
  check(
    '冻结：给 loadRoutes()[0].priceFrom 赋值抛 TypeError',
    assignThrows(() => ((loadRoutes()[0] as { priceFrom: number }).priceFrom = 1)),
  );
  check(
    '冻结：改嵌套的行程也抛 TypeError',
    assignThrows(() => ((loadRoutes()[0]!.itinerary![0] as { title: string }).title = 'x')),
  );
  check(
    '冻结：对 loadHotels() 原地 sort 抛 TypeError',
    assignThrows(() => void loadHotels().sort((a, b) => a.nightlyFrom - b.nightlyFrom)),
  );
  check(
    '冻结：给 loadHotels()[0].nightlyFrom 赋值、往它的 tags 里 push 都抛 TypeError',
    assignThrows(() => ((loadHotels()[0] as { nightlyFrom: number }).nightlyFrom = 1)) &&
      assignThrows(() => void (loadHotels()[0]!.tags as string[]).push('x')),
  );
  check(
    '冻结：往 loadRoutes() 里 push 抛 TypeError',
    assignThrows(() => void loadRoutes().push(loadRoutes()[0]!)),
  );
  // 酒店文件缺失时返回的空数组也冻结（不变量 16 两种模式、任何情况都成立）
  const savedHotelsPath = process.env.HOTELS_PATH;
  process.env.HOTELS_PATH = path.join(process.env.VAR_DIR!, 'no-such-hotels.json');
  const noHotels = loadHotels();
  check(
    '冻结：酒店文件缺失时 loadHotels() 返回的空数组同样冻结，push 抛 TypeError',
    noHotels.length === 0 && Object.isFrozen(noHotels) && assignThrows(() => void (noHotels as unknown[]).push({})),
  );
  if (savedHotelsPath === undefined) delete process.env.HOTELS_PATH;
  else process.env.HOTELS_PATH = savedHotelsPath;
  const before = loadHotels()
    .map((h) => h.id)
    .join(',');
  const first = JSON.stringify(searchHotels({}));
  const second = JSON.stringify(searchHotels({}));
  check('冻结：search_hotels({}) 连调两次结果相同', first === second && first !== '[]');
  check(
    '冻结：search_hotels 之后快照顺序不变',
    loadHotels()
      .map((h) => h.id)
      .join(',') === before,
  );
  check('冻结：冻结后的数据与文件逐字节相同', JSON.stringify(loadRoutes()) === JSON.stringify(JSON.parse(routesRaw)));
  const o = { a: { b: [1] } };
  check('deepFreeze：返回同一个引用、递归冻结', deepFreeze(o) === o && Object.isFrozen(o.a.b));
  const inner = [1];
  const outer = Object.freeze({ inner });
  deepFreeze(outer);
  check('deepFreeze：父对象已冻结时照样冻结它的子对象', Object.isFrozen(inner));
  const cyclic: { self?: unknown; list: number[] } = { list: [1] };
  cyclic.self = cyclic;
  check('deepFreeze：有环不死循环', deepFreeze(cyclic) === cyclic && Object.isFrozen(cyclic.list));
}

// ---------------- 清单不漂移 ----------------
{
  // 源码扫描按 AST 走，不按正则：格式化器会把长短语折成多行，正则就漏了。
  // engine.selftest.ts 里对 system prompt 的每一处短语断言，都必须原样在 SOP_CONTRACT 里，反过来也一样
  const file = path.join(root, 'src', 'engine.selftest.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const HOLDERS = new Set(['sys', 'sop']);
  const isHolder = (n: ts.Node): n is ts.Identifier => ts.isIdentifier(n) && HOLDERS.has(n.text);
  const negated = (call: ts.Node): boolean =>
    ts.isPrefixUnaryExpression(call.parent) && call.parent.operator === ts.SyntaxKind.ExclamationToken;
  const found: string[] = [];
  const recognized = new Set<ts.Node>();
  const odd: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const callee = n.expression;
      const [arg] = n.arguments;
      // sys.includes('…')：参数必须是不带插值的字面量，否则清单里没法照抄
      if (callee.name.text === 'includes' && isHolder(callee.expression)) {
        recognized.add(callee.expression);
        if (n.arguments.length === 1 && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          found.push(`${negated(n) ? 'exclude' : 'include'}:${arg.text}`);
        } else odd.push(`第 ${line(n)} 行的 includes 参数不是字面量`);
      }
      // /…/.test(sys)：带上 flags 一起比，/x/i 与 /x/ 不算同一条
      if (callee.name.text === 'test' && ts.isRegularExpressionLiteral(callee.expression) && arg && isHolder(arg)) {
        recognized.add(arg);
        const lit = callee.expression.text;
        found.push(`${negated(n) ? 'exclude-pattern' : 'include-pattern'}:${lit}`);
      }
      // buildSystemPrompt() 只能赋给 sys 或 sop：换个变量名、或者直接在调用结果上断言，扫描就看不见了
      if (callee.name.text === 'buildSystemPrompt') {
        const decl = n.parent;
        if (!(ts.isVariableDeclaration(decl) && decl.initializer === n && isHolder(decl.name))) {
          odd.push(`第 ${line(n)} 行的 buildSystemPrompt() 没有赋给 sys 或 sop`);
        }
      }
    }
    if (isHolder(n) && ts.isVariableDeclaration(n.parent) && n.parent.name === n) recognized.add(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const holderUses = (n: ts.Node, acc: ts.Identifier[] = []): ts.Identifier[] => {
    if (isHolder(n)) acc.push(n);
    ts.forEachChild(n, (c) => void holderUses(c, acc));
    return acc;
  };
  for (const id of holderUses(sf))
    if (!recognized.has(id)) odd.push(`第 ${line(id)} 行对 ${id.text} 的用法认不出来（只认 .includes('…') 与 /…/.test(${id.text})）`);
  const listed = SOP_CONTRACT.map((r) => `${r.kind}:${r.kind === 'exclude-pattern' ? String(r.pattern) : r.text}`);
  const unlisted = found.filter((f) => !listed.includes(f));
  const stale = listed.filter((l) => !found.includes(l));
  check('漂移：engine.selftest.ts 的每条 SOP 短语断言都在 SOP_CONTRACT 里', unlisted.length === 0, `没进清单：${unlisted.join(' | ')}`);
  check('漂移：SOP_CONTRACT 里没有 engine.selftest.ts 已经删掉的断言', stale.length === 0, `多出来的：${stale.join(' | ')}`);
  check('漂移：engine.selftest.ts 里对 system prompt 的断言都是认得出的写法', odd.length === 0, odd.join('；'));
  check('漂移：扫描确实找到了断言（17 条）', found.length === 17, String(found.length));

  // SOP_KNOWN_FIELDS 的每一项都要以标识符（或字符串字面量）的形式出现在产出工具字段的源文件里；注释里提到不算
  const tokens = new Set<string>();
  for (const f of KNOWN_FIELD_SOURCES) {
    const src = ts.createSourceFile(f, fs.readFileSync(path.join(root, f), 'utf8'), ts.ScriptTarget.Latest, true);
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) tokens.add(n.text);
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  const absent = SOP_KNOWN_FIELDS.filter((f) => !tokens.has(f));
  check('漂移：SOP_KNOWN_FIELDS 都以标识符出现在 KNOWN_FIELD_SOURCES 里', absent.length === 0, absent.join(','));
  check('漂移：SOP 点名的工具都是现有的工具', contract(image).filter((v) => v.code === 'unknown_tool').length === 0);
}

// ================ DB 模式：配置源、启动顺序、导入导出（第 6 步） ================
const { openTestDb, installSeededConfig, testConfigDeps, fakeLock } = await import('../db/testing.js');
const cfg = await import('./source.js');
const { importConfig, exportConfig, EXIT, imageCode } = await import('./transfer.js');
const { boot } = await import('../boot.js');
const { queryCount } = await import('../db/client.js');
const { executeTool } = await import('../tools.js');
const { getOrCreateSession, getSession } = await import('../store.js');
const { handleMessage } = await import('../engine.js');
type ToolHints = import('../tools.js').ToolHints;
type ConfigDeps = import('./source.js').ConfigDeps;
type Route = import('../shared/catalog-types.js').Route;

const DATA = path.join(root, 'data');
const nextYear = new Date().getFullYear() + 1;
const peakDate = `${nextYear}-07-15`;
const offDate = `${nextYear}-01-15`;
let simSeq = 0;
const freshSession = (): import('../types.js').Session =>
  getOrCreateSession(`sim-cfgtest${String(simSeq++).padStart(4, '0')}`, 'simulator');
/** 订单号、支付链接、时间戳、会话 id 两种模式必然不同，遮掉再比 */
const mask = (s: string, sid: string): string =>
  s
    .replaceAll(sid, 'SID')
    .replace(/ord_[0-9a-f]{24}/g, 'ord_X')
    .replace(/"payUrl":"[^"]*"/g, '"payUrl":"X"')
    .replace(/\b1\d{12}\b/g, 'T');

const READ_ONLY_TOOLS: [string, Record<string, unknown>, ToolHints?][] = [
  ['search_routes', { destination: '云南', maxBudgetPerPerson: 20000 }],
  ['search_routes', { query: '带爸妈去不累的地方', maxBudgetPerPerson: 30000 }],
  ['get_route_detail', { routeId: 'r-sichuan-lux' }, { elder: true }],
  ['search_hotels', {}],
  ['search_hotels', { destination: '三亚' }],
  ['create_quote', { routeId: 'r-sichuan-lux', travelers: 2, departDate: peakDate }],
  ['create_quote', { routeId: 'r-sichuan-lux', travelers: 4, departDate: offDate }],
  ['generate_proposal', { routeId: 'r-sichuan-lux', travelers: 2 }],
];
/** 同一组输入在当前模式下的全部观测：前缀、产品库、只读工具的输出、下单与转人工（遮掉之后）的输出与会话状态 */
async function observeMode(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const p = promptPrefix();
  out.system = p.system;
  out.tools = p.tools;
  out.routes = loadRoutes()
    .map((r) => JSON.stringify(r))
    .join('\n');
  out.hotels = loadHotels()
    .map((h) => JSON.stringify(h))
    .join('\n');
  for (const [i, [name, args, hints]] of READ_ONLY_TOOLS.entries())
    out[`${i}:${name}`] = await executeTool(name, args, freshSession(), hints);
  for (const [name, args] of [
    ['create_order', { routeId: 'r-sichuan-lux', travelers: 2, departDate: peakDate }],
    ['handoff_to_human', { reason: '客户要求找真人顾问' }],
  ] as const) {
    const s = freshSession();
    const result = await executeTool(name, args, s);
    out[name] = mask(result, s.id);
    out[`${name}:session`] = mask(JSON.stringify(getSession(s.id)), s.id);
  }
  return out;
}

const fileView = await observeMode();
check('DB 前：当前是文件模式', cfg.configMode() === 'file');
const t = await openTestDb();
await installSeededConfig(t);
check('DB：装载之后是 DB 模式', cfg.configMode() === 'db' && cfg.currentSop().versionNo === 1);

// ---------------- 两种模式逐字节等价（验收 2） ----------------
{
  const dbView = await observeMode();
  for (const k of Object.keys(fileView)) check(`等价：${k} 两种模式逐字节相同`, dbView[k] === fileView[k], (dbView[k] ?? '').slice(0, 80));
  check('等价：比了全部观测项', Object.keys(dbView).length === Object.keys(fileView).length && Object.keys(fileView).length === 16);
  const sop = cfg.currentSop();
  check(
    '等价：缓存里的哈希与现算的相同',
    sop.promptHash === sha256(promptPrefix().system) && sop.toolsHash === sha256(promptPrefix().tools),
  );
  check('等价：缓存里的节就是镜像的节', joinSop(sop.sections) === md);
}

// ---------------- DB 模式的快照不可变（验收 4） ----------------
{
  const throwsType = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof TypeError;
    }
  };
  check(
    'DB 冻结：给 loadRoutes()[0].priceFrom 赋值抛 TypeError',
    throwsType(() => ((loadRoutes()[0] as { priceFrom: number }).priceFrom = 1)),
  );
  check(
    'DB 冻结：对 loadHotels() 原地 sort 抛 TypeError',
    throwsType(() => void loadHotels().sort((a, b) => a.nightlyFrom - b.nightlyFrom)),
  );
  const before = loadHotels()
    .map((h) => h.id)
    .join(',');
  check('DB 冻结：search_hotels({}) 连调两次结果相同', JSON.stringify(searchHotels({})) === JSON.stringify(searchHotels({})));
  check(
    'DB 冻结：快照顺序不变',
    loadHotels()
      .map((h) => h.id)
      .join(',') === before,
  );
  check(
    'DB 冻结：loadRoutes() 返回快照里的数组本身，不拷贝',
    loadRoutes() === loadRoutes() && loadRoutes() === cfg.currentCatalog().routes,
  );
  // 两种模式的数据相同，等价比较分不出「DB 模式下其实还在读文件」：只能看拿到的是不是快照本身
  check('DB 冻结：loadHotels() 也返回快照里的数组本身', loadHotels() === cfg.currentCatalog().hotels);
}

// ---------------- 每轮不查库（验收 14） ----------------
{
  const sid = 'sim-cfgtest-turns-0001';
  const before = queryCount();
  for (const say of ['想去西安，两个人', '多少钱', '10月5号出发，就订这个', '付款链接打不开 再发我一次', '好的谢谢'])
    await handleMessage(sid, say, 'simulator');
  const s = getSession(sid);
  check('每轮不查库：5 轮对话（含报价与下单）之后 queryCount 没变', queryCount() === before, `${before} → ${queryCount()}`);
  check('每轮不查库：这几轮确实下了单', (s?.orderIds.length ?? 0) > 0);
}

// ---------------- /healthz 的 config ----------------
{
  process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微
  const { app } = await import('../server.js');
  const body = (await (await app.request('/healthz')).json()) as { config: Record<string, unknown> };
  const sop = cfg.currentSop();
  check(
    '/healthz：DB 模式报版本号、哈希前 12 位与锁状态',
    body.config.mode === 'db' &&
      body.config.sopVersion === 1 &&
      body.config.promptHash === sop.promptHash.slice(0, 12) &&
      body.config.toolsHash === sop.toolsHash.slice(0, 12) &&
      body.config.prefixHash === sop.prefixHash.slice(0, 12) &&
      body.config.sopHash === sop.sopHash.slice(0, 12) &&
      body.config.lock === 'held' &&
      body.config.sopStale === false &&
      body.config.catalogStale === false,
    JSON.stringify(body.config),
  );
}

// ---------------- 导入与导出（验收 3） ----------------
/** 以超级用户查库（绕过 RLS），查完回到 agent_app */
async function asSuper<T>(fn: () => Promise<T>): Promise<T> {
  await t.pg.exec('RESET ROLE');
  try {
    return await fn();
  } finally {
    await t.pg.exec('SET ROLE agent_app');
  }
}
const rowsOfTenant = async (slug: string): Promise<string> =>
  asSuper(async () => {
    const r = await t.pg.query<{ v: number; c: number; a: number }>(
      `select (select count(*)::int from sop_versions s join tenants x on x.id = s.tenant_id where x.slug = $1) as v,
              (select count(*)::int from catalog_items s join tenants x on x.id = s.tenant_id where x.slug = $1) as c,
              (select count(*)::int from audit_log s join tenants x on x.id = s.tenant_id where x.slug = $1) as a`,
      [slug],
    );
    return JSON.stringify(r.rows[0]);
  });
const newTenant = (slug: string, status = 'active'): Promise<unknown> =>
  asSuper(() => t.pg.query(`insert into tenants (slug, name, pack_id, status) values ($1, $1, 'travel', $2)`, [slug, status]));
/** 把 data/ 拷一份到临时目录，按需改一个文件 */
const dataCopy = (edit?: { file: string; to: (text: string) => string }): string => {
  const dir = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'data-'));
  for (const f of ['sop.md', 'routes.json', 'hotels.json']) fs.copyFileSync(path.join(DATA, f), path.join(dir, f));
  if (edit) fs.writeFileSync(path.join(dir, edit.file), edit.to(fs.readFileSync(path.join(dir, edit.file), 'utf8')));
  return dir;
};
const imp = (slug: string, over: Partial<Parameters<typeof importConfig>[0]> = {}) =>
  importConfig({ db: t.db, tenantSlug: slug, dataDir: DATA, imageSop: md, lock: async () => fakeLock(), ...over });
{
  const out = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'export-'));
  const ex = await exportConfig({ db: t.db, tenantSlug: 'demo', outDir: out, imageSop: md });
  check(
    '导出：退出码 0，打印版本号与 sopHash',
    ex.code === EXIT.ok && ex.versionNo === 1 && ex.hashes?.sopHash === cfg.currentSop().sopHash,
    ex.message,
  );
  check('往返：导出的 sop.md 与 data/sop.md 逐字节相同', fs.readFileSync(path.join(out, 'sop.md'), 'utf8') === md);
  for (const f of ['routes.json', 'hotels.json']) {
    const a = (JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) as unknown[]).map((x) => JSON.stringify(x));
    const b = (JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) as unknown[]).map((x) => JSON.stringify(x));
    check(`往返：${f} 条目顺序相同、每条 JSON.stringify 相同`, a.length === b.length && a.every((x, i) => x === b[i]));
  }
  check(
    '往返：导出的 JSON 是 JSON.stringify(items, null, 2) 加换行',
    fs.readFileSync(path.join(out, 'routes.json'), 'utf8').endsWith(']\n'),
  );

  const before = await rowsOfTenant('demo');
  const again = await imp('demo');
  check(
    '导入：同一份 data/ 再跑一次，退出码 0、库不变',
    again.code === EXIT.ok && (await rowsOfTenant('demo')) === before,
    `${again.code} ${again.message}`,
  );
  const differentSop = await imp('demo', {
    dataDir: dataCopy({ file: 'sop.md', to: (s) => s.replace('## 话术原则\n\n', '## 话术原则\n\n改了一句话术。\n') }),
  });
  check(
    '导入：可编辑节不同 → 退出码 2、库不变',
    differentSop.code === EXIT.inconsistent && (await rowsOfTenant('demo')) === before,
    differentSop.message,
  );
  const differentItems = await imp('demo', {
    dataDir: dataCopy({ file: 'hotels.json', to: (s) => JSON.stringify((JSON.parse(s) as unknown[]).toReversed(), null, 2) }),
  });
  check('导入：条目顺序不同 → 退出码 2、库不变', differentItems.code === EXIT.inconsistent && (await rowsOfTenant('demo')) === before);
  const locked = await imp('demo', { lock: async () => null });
  check('导入：应用持着租户锁 → 退出码 3', locked.code === EXIT.locked && (await rowsOfTenant('demo')) === before);

  // 坏文件：一律退出码 1，库里没有新行
  await newTenant('fresh');
  const BOM = ch(0xfeff);
  const bad: [string, (s: string) => string][] = [
    ['\\r\\n', (s) => s.replace('\n', '\r\n')],
    ['NFD 字符', (s) => s.replace('云途', `云途 e${ch(0x301)}`)],
    ['BOM', (s) => BOM + s],
    ['NUL', (s) => s.replace('云途', `云途${ch(0)}`)],
    ['U+2028', (s) => s.replace('云途', `云途${ch(0x2028)}`)],
    ['行尾空格（不是规范形）', (s) => s.replace(/(## 话术原则\n\n[^\n]*)\n/, '$1 \n')],
  ];
  // 文件里不可能有孤立代理项的「字符」，只有编码过的字节（ED A0 80）：Node 按 utf8 读会悄悄换成 U+FFFD，导入必须按字节严格解码
  {
    const dir = dataCopy();
    const [head, tail] = [md.slice(0, 10), md.slice(10)];
    fs.writeFileSync(path.join(dir, 'sop.md'), Buffer.concat([Buffer.from(head), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from(tail)]));
    const r = await imp('fresh', { dataDir: dir });
    check(
      '导入：sop.md 含编码过的孤立代理项（非法 UTF-8）→ 退出码 1、库里没有新行',
      r.code === EXIT.error && (await rowsOfTenant('fresh')) === '{"v":0,"c":0,"a":0}',
      r.message,
    );
  }
  for (const [what, to] of bad) {
    const r = await imp('fresh', { dataDir: dataCopy({ file: 'sop.md', to }) });
    check(
      `导入：sop.md 含${what} → 退出码 1、库里没有新行`,
      r.code === EXIT.error && (await rowsOfTenant('fresh')) === '{"v":0,"c":0,"a":0}',
      r.message,
    );
  }
  const lockedChanged = await imp('fresh', {
    dataDir: dataCopy({ file: 'sop.md', to: (s) => s.replace('定价只有两条规则', '定价只有这两条规则') }),
  });
  check(
    '导入：锁定节与镜像不同 → locked_changed、退出码 1',
    lockedChanged.code === EXIT.error && lockedChanged.message.startsWith('locked_changed'),
    lockedChanged.message,
  );
  const badRoute = await imp('fresh', {
    dataDir: dataCopy({
      file: 'routes.json',
      to: (s) => JSON.stringify((JSON.parse(s) as Record<string, unknown>[]).map((r, i) => (i === 0 ? { ...r, priceFrom: '1' } : r))),
    }),
  });
  check(
    '导入：线路过不了 schema → 退出码 1、库里没有新行',
    badRoute.code === EXIT.error && (await rowsOfTenant('fresh')) === '{"v":0,"c":0,"a":0}',
    badRoute.message,
  );
  const dry = await imp('fresh', { dryRun: true });
  check(
    '导入：--dry-run 跑通、打印哈希、不写库',
    dry.code === EXIT.ok &&
      dry.hashes?.promptHash === cfg.currentSop().promptHash &&
      (await rowsOfTenant('fresh')) === '{"v":0,"c":0,"a":0}',
    dry.message,
  );
  const real = await imp('fresh');
  check(
    '导入：空租户导入写 v1、全部条目与一行审计',
    real.code === EXIT.ok && (await rowsOfTenant('fresh')) === '{"v":1,"c":43,"a":1}',
    `${real.message} ${await rowsOfTenant('fresh')}`,
  );
  check(
    '导入：打印的三个哈希与另一个租户的相同（同一份内容）',
    real.hashes?.prefixHash === cfg.currentSop().prefixHash && real.hashes?.sopHash === cfg.currentSop().sopHash,
  );

  const target = await exportConfig({ db: t.db, tenantSlug: 'demo', outDir: out, imageSop: md, targetImageSop: md });
  check('导出：--image-sop 指向同一份时照常导出', target.code === EXIT.ok, target.message);
  const oldImage = md.replace('定价只有两条规则', '定价就两条规则');
  const badTarget = await exportConfig({ db: t.db, tenantSlug: 'demo', outDir: out, imageSop: md, targetImageSop: oldImage });
  check(
    '导出：与目标镜像合并后过不了契约检查 → 退出码 1',
    badTarget.code === EXIT.error && badTarget.message.startsWith('contract_failed'),
    badTarget.message,
  );
  const changedCode = await exportConfig({
    db: t.db,
    tenantSlug: 'demo',
    outDir: out,
    imageSop: md,
    code: { ...imageCode(), render: (s) => `${renderSystemPrompt(s)}\n新规则` },
  });
  check('导出：本地渲染的 promptHash 与库里的不同 → 退出码 1', changedCode.code === EXIT.error, changedCode.message);
}

// ---------------- 锁丢失的状态机与重读 ----------------
{
  cfg.__configTest.reset();
  const lock = fakeLock();
  const exits: number[] = [];
  cfg.__configTest.setTimings({ reacquireMs: 5, reloadBackoffMs: [5] });
  await cfg.initConfig(testConfigDeps(t, { lock: async () => lock, gracefulExit: (c) => void exits.push(c) }));
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  check('锁：装载后持锁、可写', cfg.configHealth().lock === 'held' && thrown(() => cfg.assertConfigWritable()) === 'ok');
  lock.next = 'unreachable';
  lock.lose();
  check(
    '锁：连接断开进入 lost，配置写入抛 ConfigLockLostError',
    cfg.configHealth().lock === 'lost' && thrown(() => cfg.assertConfigWritable()) === 'ConfigLockLostError',
  );
  check('锁：lost 期间对话照常（读缓存）', loadRoutes().length > 0 && cfg.currentSop().versionNo === 1);
  await wait(40);
  check('锁：连不上就一直重取，仍是 lost', lock.reacquired >= 2 && cfg.configHealth().lock === 'lost', String(lock.reacquired));
  lock.next = 'ok';
  await wait(40);
  check('锁：重取成功回到 held', cfg.configHealth().lock === 'held');
  lock.next = 'held_by_other';
  lock.lose();
  await wait(40);
  check('锁：别的进程拿走了锁 → 走优雅退出，退出码 1', exits.join(',') === '1', exits.join(','));

  cfg.__configTest.reset();
  const lock2 = fakeLock();
  await cfg.initConfig(testConfigDeps(t, { lock: async () => lock2 }));
  cfg.markConfigShuttingDown();
  lock2.lose();
  check('锁：进入停机之后忽略锁连接的事件', cfg.configHealth().lock === 'held');
  await cfg.closeConfig();
  check('锁：closeConfig 释放租户锁', lock2.released);

  cfg.__configTest.reset();
  cfg.__configTest.setTimings({ reloadBackoffMs: [5] });
  await cfg.initConfig(testConfigDeps(t));
  const seen: number[] = [];
  cfg.onCatalogChanged((snap) => void seen.push(snap.generation));
  const gen0 = cfg.currentCatalog().generation;
  const extra = { ...(JSON.parse(routesRaw) as Record<string, unknown>[])[0]!, id: 'r-reload-test' };
  await asSuper(() =>
    t.pg.query(
      `insert into catalog_items (tenant_id, kind, code, ord, status, payload) select id, 'route', 'r-reload-test', 99, 'active', $1::json from tenants where slug = 'demo'`,
      [JSON.stringify(extra)],
    ),
  );
  const p1 = cfg.reloadFromDb();
  const p2 = cfg.reloadFromDb();
  const staleDuring = cfg.configHealth();
  await p1;
  check('重读：进行中再调用拿到同一个 promise（单飞）', p1 === p2);
  check(
    '重读：进行中标脏，完成后清掉',
    staleDuring.sopStale && staleDuring.catalogStale && !cfg.configHealth().sopStale && !cfg.configHealth().catalogStale,
  );
  check(
    '重读：新条目进了快照，代际加 1，回调一次',
    cfg.currentCatalog().routes.some((r) => r.id === 'r-reload-test') &&
      cfg.currentCatalog().generation === gen0 + 1 &&
      seen.join(',') === String(gen0 + 1),
    seen.join(','),
  );
  check('重读：新快照同样冻结', Object.isFrozen(cfg.currentCatalog().routes.at(-1)));
  await asSuper(() => t.pg.query(`delete from catalog_items where code = 'r-reload-test'`));
}

// ---------------- 启动顺序与各个启动失败分支（验收 13） ----------------
{
  const cursor = path.join(process.env.VAR_DIR!, 'wecom-cursor.json');
  fs.writeFileSync(cursor, '{"cursor":"keep-me"}');
  const cursorStat = fs.statSync(cursor).mtimeMs;
  const bootWith = async (init: () => Promise<void>): Promise<{ calls: string; exits: string; log: string }> => {
    cfg.__configTest.reset();
    const calls: string[] = [];
    const exits: number[] = [];
    const logs: string[] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await boot({
        initConfig: init,
        serve: (onListening) => {
          calls.push('serve');
          onListening();
        },
        preflight: () => void calls.push('preflight'),
        buildIndex: async () => void calls.push('buildIndex'),
        startFollowUpScheduler: () => void calls.push('followup'),
        startWecom: () => void calls.push('startWecom'),
        exit: (c) => void exits.push(c),
      });
    } finally {
      console.error = origErr;
      console.warn = origWarn;
    }
    return { calls: calls.join(','), exits: exits.join(','), log: logs.join('\n') };
  };
  const ok = await bootWith(() => cfg.initConfig(testConfigDeps(t)));
  check(
    'boot：装载成功后才监听，监听后依次预检、索引、跟进、企微',
    ok.calls === 'serve,preflight,buildIndex,followup,startWecom' && ok.exits === '',
    ok.calls,
  );

  const expectFail = async (name: string, reason: string, init: () => Promise<void>, alsoIn?: string): Promise<void> => {
    const r = await bootWith(init);
    check(
      `boot：${name} → 以 ${reason} 拒绝启动，serve 与 startWecom 都没调`,
      r.exits === '1' && r.calls === '' && r.log.includes(`（${reason}）`) && (!alsoIn || r.log.includes(alsoIn)),
      `${r.exits} ${r.calls} ${r.log.slice(0, 160)}`,
    );
  };
  const env = (over: Record<string, string>): NodeJS.ProcessEnv => ({
    CONFIG_SOURCE: 'db',
    DATABASE_URL: 'postgres://agent_app:hush-hush@127.0.0.1:1/agent',
    DEFAULT_TENANT_SLUG: 'demo',
    DEPLOY_PROFILE: 'demo',
    ...over,
  });
  const fromEnv = (e: NodeJS.ProcessEnv) => () => cfg.initConfigFromEnv(e, () => {});
  await expectFail('CONFIG_SOURCE 取值非法', 'env_invalid', fromEnv({ CONFIG_SOURCE: 'dbb' }));
  for (const missing of ['DATABASE_URL', 'DEFAULT_TENANT_SLUG', 'DEPLOY_PROFILE']) {
    await expectFail(`DB 模式缺 ${missing}`, 'env_invalid', fromEnv(env({ [missing]: '' })));
  }
  await expectFail('DATABASE_URL 不是 postgres://', 'env_invalid', fromEnv(env({ DATABASE_URL: 'mysql://x@y/z' })));
  for (const k of ['DATABASE_OWNER_URL', 'DATABASE_PLATFORM_URL', 'POSTGRES_PASSWORD', 'AGENT_OWNER_PASSWORD']) {
    await expectFail(`app 环境里有 ${k}`, 'env_privileged', fromEnv(env({ [k]: 'x' })), k);
  }
  const unreachable = await bootWith(fromEnv(env({})));
  check(
    'boot：连不上库 → db_unreachable，日志里的连接串去掉了口令',
    unreachable.exits === '1' && unreachable.log.includes('（db_unreachable）') && !unreachable.log.includes('hush-hush'),
    unreachable.log.slice(0, 200),
  );

  const d = (over: Partial<ConfigDeps>) => () => cfg.initConfig(testConfigDeps(t, over));
  // 迁移：镜像里的某条不在库里 → schema_behind；库里多出一条 → 照常启动并 warn
  const [last] = (
    await asSuper(() =>
      t.pg.query<{ id: number; hash: string; created_at: string }>(
        'select id, hash, created_at from drizzle.__drizzle_migrations order by id desc limit 1',
      ),
    )
  ).rows;
  await asSuper(() => t.pg.query('delete from drizzle.__drizzle_migrations where id = $1', [last!.id]));
  await expectFail('镜像里的某条迁移没在库里', 'schema_behind', d({}));
  await asSuper(() =>
    t.pg.query('insert into drizzle.__drizzle_migrations (id, hash, created_at) values ($1, $2, $3)', [
      last!.id,
      last!.hash,
      last!.created_at,
    ]),
  );
  await asSuper(() => t.pg.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-image', 1)`));
  const newer = await bootWith(d({}));
  check(
    'boot：库里多出一条镜像没有的迁移 → 照常启动并 warn',
    newer.exits === '' && newer.calls.startsWith('serve') && newer.log.includes('多出 1 条'),
    newer.log.slice(0, 160),
  );
  await asSuper(() => t.pg.query(`delete from drizzle.__drizzle_migrations where hash = 'from-a-newer-image'`));

  await expectFail('DEFAULT_TENANT_SLUG 不存在', 'tenant_not_found', d({ tenantSlug: 'nobody' }));
  await newTenant('paused', 'suspended');
  await expectFail('租户已停用', 'tenant_suspended', d({ tenantSlug: 'paused' }));
  await newTenant('blank');
  await expectFail('租户没有已发布的 SOP', 'no_published_sop', d({ tenantSlug: 'blank' }));
  await expectFail('另一个进程已持有该租户的锁', 'lock_held', d({ lock: async () => null }));

  // 手工绕过触发器改了已发布行的 sections：sop_hash 对不上
  await newTenant('tampered');
  await imp('tampered');
  await asSuper(async () => {
    await t.pg.exec('ALTER TABLE sop_versions DISABLE TRIGGER sop_versions_guard_update');
    await t.pg.query(
      `update sop_versions set sections = jsonb_set(sections, '{3,text}', to_jsonb('## 话术原则\n\n被人改过。\n\n'::text)) where tenant_id = (select id from tenants where slug = 'tampered')`,
    );
    await t.pg.exec('ALTER TABLE sop_versions ENABLE TRIGGER sop_versions_guard_update');
  });
  await expectFail('手工改过已发布行的 sections', 'integrity', d({ tenantSlug: 'tampered' }));

  await newTenant('no-routes');
  await imp('no-routes');
  await asSuper(() =>
    t.pg.query(`delete from catalog_items where kind = 'route' and tenant_id = (select id from tenants where slug = 'no-routes')`),
  );
  await expectFail('没有 active 线路', 'no_active_routes', d({ tenantSlug: 'no-routes' }));

  await expectFail('镜像里的 data/sop.md 缺失（空文件）', 'image_sop_invalid', d({ imageSop: '' }));
  await expectFail('镜像里的 data/sop.md 切不开', 'image_sop_invalid', d({ imageSop: md.replace('## 话术原则\n', '## 话术原则们\n') }));
  await expectFail('镜像里的 data/sop.md 编码不合格', 'image_sop_invalid', d({ imageSop: ch(0xfeff) + md }));
  let n = 0;
  await expectFail('渲染不确定', 'renderer_nondeterministic', d({ render: (s) => `${renderSystemPrompt(s)}${n++}` }));
  await expectFail(
    'SOP 点名的工具已经不存在',
    'contract_failed',
    d({ toolNames: toolNames.filter((x) => x !== 'create_quote') }),
    'create_quote',
  );
  await expectFail(
    'SOP 点名的字段已经不存在',
    'contract_failed',
    d({ knownFields: SOP_KNOWN_FIELDS.filter((x) => x !== 'payUrl') }),
    'payUrl',
  );

  check(
    'boot：企微 cursor 文件的内容与 mtime 都没动',
    fs.readFileSync(cursor, 'utf8') === '{"cursor":"keep-me"}' && fs.statSync(cursor).mtimeMs === cursorStat,
  );
  cfg.__configTest.reset();
}
// ---------------- SOP 编辑流程（第 7 步：验收 5、6、7、8，以及 10 的 SOP 部分） ----------------
{
  const sopApi = await import('./sop.js');
  const { observeRequests } = await import('../llm.js');
  const reinit = async (over: Partial<ConfigDeps> = {}): Promise<void> => {
    cfg.__configTest.reset();
    await cfg.initConfig(testConfigDeps(t, over));
  };
  await reinit();
  const tenantId = cfg.currentCatalog().tenantId;
  const ctx: import('../db/client.js').TenantCtx = { tenantId, actor: { kind: 'user', userId: null, name: '运营甲', ip: null } };
  const specOfKey = (key: string) => TRAVEL_SOP_SECTIONS.find((s) => s.key === key)!;
  const bodyOf = (sections: readonly SopSection[], key: string): string =>
    sectionBody(
      sections.find((s) => s.key === key)!,
      specOfKey(key),
    );
  const audits = async (action: string): Promise<number> =>
    asSuper(
      async () =>
        (
          await t.pg.query<{ n: number }>('select count(*)::int as n from audit_log where tenant_id = $1 and action = $2', [
            tenantId,
            action,
          ])
        ).rows[0]!.n,
    );
  const versions = async (): Promise<number> =>
    asSuper(
      async () =>
        (await t.pg.query<{ n: number }>('select count(*)::int as n from sop_versions where tenant_id = $1', [tenantId])).rows[0]!.n,
    );
  const errName = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.constructor.name : String(e);
    }
  };
  // 干净起点：前面的测试可能留下了草稿
  const leftover = (await sopApi.getSopOverview(ctx)).draft;
  if (leftover) await sopApi.discardSopDraft(ctx, { rev: leftover.rev });

  // 验收 5：编辑「话术原则」并发布，下一轮 chat() 收到的 system 就是新版本的 rendered_prompt
  const v0 = cfg.currentSop();
  const overview = await sopApi.getSopOverview(ctx);
  check(
    'SOP：概览里有已发布版本、没有草稿',
    overview.published.id === v0.versionId && overview.draft === null && overview.budget.chars <= overview.budget.limit,
  );
  const toneBody = `${bodyOf(overview.published.sections, 'tone')}\n\n新加一句话术：先把客户的原话复述一遍再推荐。`;
  const draft1 = await sopApi.saveSopDraft(ctx, { basedOn: v0.versionId, rev: null, edits: [{ key: 'tone', body: toneBody }] });
  check('SOP：新建草稿，rev 为 1', draft1.status === 'draft' && draft1.rev === 1 && draft1.basedOn === v0.versionId);
  const draft2 = await sopApi.saveSopDraft(ctx, {
    basedOn: v0.versionId,
    rev: 1,
    edits: [{ key: 'tone', body: `${toneBody}\n再补一句。` }],
  });
  check('SOP：再次保存草稿，rev 加 1', draft2.rev === 2);
  check(
    'SOP：保存时带旧 rev → SopRevConflictError',
    (await errName(sopApi.saveSopDraft(ctx, { basedOn: v0.versionId, rev: 1, edits: [] }))) === 'SopRevConflictError',
  );
  check(
    'SOP：保存时点名锁定节 → SopLockedSectionError',
    (await errName(sopApi.saveSopDraft(ctx, { basedOn: v0.versionId, rev: 2, edits: [{ key: 'price-rules', body: 'x' }] }))) ===
      'SopLockedSectionError',
  );
  check('SOP：草稿不算进缓存', cfg.currentSop().versionNo === v0.versionNo);
  const beforePublishAudits = await audits('sop.publish');
  const v1 = await sopApi.publishSopDraft(ctx, { rev: 2, changeNote: '话术加一句' });
  check(
    'SOP：发布拿到比原来大的版本号，缓存跟着换',
    v1.versionNo! > v0.versionNo && cfg.currentSop().versionNo === v1.versionNo && cfg.currentSop().promptHash === v1.promptHash,
  );
  check('SOP：发布写一行审计', (await audits('sop.publish')) === beforePublishAudits + 1);
  const seenSystems: string[] = [];
  observeRequests((r) => void seenSystems.push(r.system));
  await handleMessage('sim-cfgtest-publish-0001', '想去三亚玩几天', 'simulator');
  observeRequests(null);
  const published = cfg.currentSop();
  check(
    'SOP：下一轮 chat() 收到的 system 等于新版本的 rendered_prompt',
    seenSystems.length > 0 && seenSystems.every((sys) => sys === published.renderedPrompt) && published.renderedPrompt.includes('再补一句'),
  );
  check('SOP：/healthz 报的版本号跟着变', cfg.prefixSummary(() => ({ system: '', tools: '', sop: '' })).sopVersion === v1.versionNo);
  check('SOP：发布变更说明不能为空', (await errName(sopApi.publishSopDraft(ctx, { rev: 1, changeNote: '  ' }))) === 'SopInputError');

  // 回滚到发布前的版本：它之后没有 rerender，prompt_hash 与它相同
  const beforeRollbackAudits = await audits('sop.rollback');
  const back = await sopApi.rollbackSop(ctx, { versionId: v0.versionId, changeNote: '回到导入版本' });
  check(
    'SOP：回滚生成新的版本号，prompt_hash 等于目标版本的',
    back.versionNo! > v1.versionNo! && back.promptHash === v0.promptHash && back.sameHashAsTarget && back.source === 'rollback',
  );
  check(
    'SOP：回滚写一行审计、缓存跟着换',
    (await audits('sop.rollback')) === beforeRollbackAudits + 1 && cfg.currentSop().versionNo === back.versionNo,
  );
  // 回滚到草稿或丢弃的版本 → 404
  const d3 = await sopApi.saveSopDraft(ctx, { basedOn: back.id, rev: null, edits: [{ key: 'objections', body: '临时草稿。' }] });
  check(
    'SOP：回滚到草稿 → SopNotFoundError',
    (await errName(sopApi.rollbackSop(ctx, { versionId: d3.id, changeNote: 'x' }))) === 'SopNotFoundError',
  );
  const beforeDiscard = await audits('sop.discard');
  await sopApi.discardSopDraft(ctx, { rev: d3.rev });
  check(
    'SOP：丢弃草稿写一行审计',
    (await audits('sop.discard')) === beforeDiscard + 1 && (await sopApi.getSopOverview(ctx)).draft === null,
  );
  check(
    'SOP：回滚到已丢弃的版本 → SopNotFoundError',
    (await errName(sopApi.rollbackSop(ctx, { versionId: d3.id, changeNote: 'x' }))) === 'SopNotFoundError',
  );
  const history = await sopApi.listSopVersions(ctx, { limit: 100 });
  check(
    'SOP：历史只列已发布与已归档，按版本号倒序',
    history.every((v) => v.status === 'published' || v.status === 'archived') &&
      history.every((v, i) => i === 0 || history[i - 1]!.versionNo! > v.versionNo!),
  );

  // 验收 6：五种过不了闸的草稿——检查返回 violations，发布抛 SopContractError，已发布版本与缓存都不变
  const bad: [string, string, string][] = [
    ['tone', '明显超出我们现有线路的范围，就转人工。', 'phrase_forbidden'],
    ['objections', '嫌贵就调 search_route 再看看。', 'unknown_tool'],
    ['objections', '先调 create_refund 退一部分。', 'unknown_tool'],
    ['objections', '看结果里的 destinationMissing。', 'unknown_field'],
    ['wechat-style', '正文\n## 新节\n多出来的一节', 'structure'],
    ['tone', '多'.repeat(5000), 'over_budget'],
  ];
  for (const [key, extra, code] of bad) {
    const cur = cfg.currentSop();
    const d = await sopApi.saveSopDraft(ctx, {
      basedOn: cur.versionId,
      rev: null,
      edits: [{ key, body: `${bodyOf(cur.sections, key)}\n${extra}` }],
    });
    const checked = await sopApi.checkSopDraft(ctx);
    check(
      `闸：草稿里写进「${extra.slice(0, 16)}」→ 检查报 ${code}`,
      checked.violations.some((v) => v.code === code),
      checked.violations.map((v) => v.code).join(','),
    );
    check(
      `闸：这份草稿发布 → SopContractError，已发布版本与缓存不变（${code}）`,
      (await errName(sopApi.publishSopDraft(ctx, { rev: d.rev, changeNote: '想发布' }))) === 'SopContractError' &&
        cfg.currentSop().versionNo === cur.versionNo,
    );
    await sopApi.discardSopDraft(ctx, { rev: d.rev });
  }

  // 验收 10：两个并发的首次保存草稿，一个成功、一个 409，没有 500
  {
    const cur = cfg.currentSop();
    const save = (text: string) => sopApi.saveSopDraft(ctx, { basedOn: cur.versionId, rev: null, edits: [{ key: 'tone', body: text }] });
    const results = await Promise.allSettled([save('甲的版本。'), save('乙的版本。')]);
    const names = results.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).constructor.name)).toSorted();
    check('并发：两个首次保存一个成功、一个 SopRevConflictError', names.join(',') === 'SopRevConflictError,ok', names.join(','));
    const open = (await sopApi.getSopOverview(ctx)).draft!;
    await sopApi.discardSopDraft(ctx, { rev: open.rev });
  }

  // 验收 10：草稿打开期间别人改了另一节（这里用回滚制造「上游改了 tone」）→ 自动 rebase，两处改动都在
  {
    const cur = cfg.currentSop();
    const d = await sopApi.saveSopDraft(ctx, {
      basedOn: cur.versionId,
      rev: null,
      edits: [{ key: 'objections', body: `${bodyOf(cur.sections, 'objections')}\n草稿加的异议处理。` }],
    });
    const up = await sopApi.rollbackSop(ctx, { versionId: v1.id, changeNote: '上游：tone 回到加过话术的版本' });
    const checked = await sopApi.checkSopDraft(ctx);
    check('rebase：检查报需要 rebase、没有冲突', checked.rebase.needed && checked.rebase.conflicts.length === 0);
    const merged = await sopApi.publishSopDraft(ctx, { rev: d.rev, changeNote: '发布草稿' });
    check(
      'rebase：发布成功，上游的 tone 与草稿的 objections 都在',
      merged.versionNo! > up.versionNo! &&
        bodyOf(merged.sections, 'tone').includes('再补一句') &&
        bodyOf(merged.sections, 'objections').includes('草稿加的异议处理'),
    );
    // 同一节被上游改了 → 409，点名这一节并带当前正文
    const d2 = await sopApi.saveSopDraft(ctx, { basedOn: merged.id, rev: null, edits: [{ key: 'tone', body: '草稿改的话术。' }] });
    await sopApi.rollbackSop(ctx, { versionId: v0.versionId, changeNote: '上游：tone 回到原样' });
    check('rebase：检查报冲突的节', (await sopApi.checkSopDraft(ctx)).rebase.conflicts.join(',') === 'tone');
    let conflict: unknown = null;
    try {
      await sopApi.publishSopDraft(ctx, { rev: d2.rev, changeNote: '发布' });
    } catch (e) {
      conflict = e;
    }
    check(
      'rebase：改了同一节 → SopConflictError，点名 tone 并带当前正文',
      conflict instanceof sopApi.SopConflictError &&
        conflict.keys.join(',') === 'tone' &&
        conflict.current.some((s) => s.key === 'tone' && s.text === cfg.currentSop().sections.find((x) => x.key === 'tone')!.text),
    );
    await sopApi.discardSopDraft(ctx, { rev: d2.rev });
  }

  // 验收 8 与验收 7：启动重渲染。草稿打开期间先插一个回滚版本，再以改过锁定节的镜像启动（产生 rerender），最后发布草稿
  {
    const cur = cfg.currentSop();
    const edited = `${bodyOf(cur.sections, 'objections')}\n重渲染期间草稿里的编辑。`;
    const d = await sopApi.saveSopDraft(ctx, { basedOn: cur.versionId, rev: null, edits: [{ key: 'objections', body: edited }] });
    const rb = await sopApi.rollbackSop(ctx, { versionId: v1.id, changeNote: '草稿打开期间的回滚' });
    const lockedImage = md.replace(
      '## 订单：改单、给别人再订、重发链接\n\n',
      '## 订单：改单、给别人再订、重发链接\n\n改单时先核对原订单号。\n',
    );
    const beforeRerender = await audits('sop.rerender');
    await reinit({ imageSop: lockedImage });
    const rr = cfg.currentSop();
    const rrRow = (await sopApi.listSopVersions(ctx, { limit: 1 }))[0]!;
    check(
      '重渲染：锁定节改了 → 启动时发布一个 rerender 版本',
      rrRow.source === 'rerender' && rrRow.versionNo! > rb.versionNo! && rr.versionNo === rrRow.versionNo,
    );
    check('重渲染：多一行 system 审计，causes 是 locked_sections', (await audits('sop.rerender')) === beforeRerender + 1);
    const cause = await asSuper(
      async () =>
        (
          await t.pg.query<{ diff: { causes: string[] }; actor_kind: string }>(
            `select diff, actor_kind from audit_log where tenant_id = $1 and action = 'sop.rerender' order by id desc limit 1`,
            [tenantId],
          )
        ).rows[0]!,
    );
    check(
      '重渲染：审计的 causes 与 actor_kind',
      cause.diff.causes.join(',') === 'locked_sections' && cause.actor_kind === 'system',
      JSON.stringify(cause),
    );
    check('重渲染：运营编辑过的可编辑节原样保留', bodyOf(rr.sections, 'tone') === bodyOf(rb.sections, 'tone'));
    const after = await sopApi.publishSopDraft(ctx, { rev: d.rev, changeNote: '重渲染之后发布草稿' });
    check(
      '验收 7：草稿拿到的版本号大于期间插入的回滚与 rerender 版本',
      after.versionNo! > rrRow.versionNo! && rrRow.versionNo! > rb.versionNo!,
    );
    check(
      '验收 10：发布结果含新锁定节和草稿里的编辑',
      joinSop(after.sections).includes('改单时先核对原订单号') &&
        bodyOf(after.sections, 'objections') === `${edited}\n\n`.replace(/\n+$/, '\n\n'),
    );

    // 回滚到重渲染之前的版本：中间隔了一次 rerender，哈希与目标不同
    const cross = await sopApi.rollbackSop(ctx, { versionId: v0.versionId, changeNote: '跨过 rerender 回滚' });
    check('回滚：中间插入过 rerender → sameHashAsTarget 为 false', !cross.sameHashAsTarget && cross.promptHash !== v0.promptHash);

    // 硬性要求变了 → causes 是 hard_rules
    await reinit({ imageSop: lockedImage, render: (s) => `${renderSystemPrompt(s)}\n- 新加的一条硬性要求` });
    const hard = await asSuper(
      async () =>
        (
          await t.pg.query<{ diff: { causes: string[] } }>(
            `select diff from audit_log where tenant_id = $1 and action = 'sop.rerender' order by id desc limit 1`,
            [tenantId],
          )
        ).rows[0]!,
    );
    check(
      '重渲染：硬性要求变了 → causes 是 hard_rules',
      hard.diff.causes.join(',') === 'hard_rules' && cfg.currentSop().renderedPrompt.endsWith('- 新加的一条硬性要求'),
    );

    // 只改工具定义 → prompt_hash 不变，tools_hash 与 prefix_hash 变了
    const beforeTools = cfg.currentSop();
    const tools = JSON.parse(imageCode().toolsJson) as { function: { description: string } }[];
    tools[0]!.function.description += '（改了一个字）';
    await reinit({
      imageSop: lockedImage,
      render: (s) => `${renderSystemPrompt(s)}\n- 新加的一条硬性要求`,
      toolsJson: JSON.stringify(tools),
    });
    const onlyTools = cfg.currentSop();
    check(
      '重渲染：只改工具定义 → prompt_hash 不变，tools_hash 与 prefix_hash 变了',
      onlyTools.versionNo > beforeTools.versionNo &&
        onlyTools.promptHash === beforeTools.promptHash &&
        onlyTools.toolsHash !== beforeTools.toolsHash &&
        onlyTools.prefixHash !== beforeTools.prefixHash,
    );

    // 失败分支：库都不变
    const count = await versions();
    const failing: [string, Partial<ConfigDeps>, string][] = [
      ['改动让契约不过（删掉「没有节假日价」）', { imageSop: lockedImage.replace('没有节假日价', '节假日另议') }, 'contract_failed'],
      [
        'toolNames 去掉了 SOP 点名的一项',
        { imageSop: lockedImage, toolNames: toolNames.filter((x) => x !== 'create_quote') },
        'contract_failed',
      ],
      [
        'knownFields 去掉了 SOP 点名的一项',
        { imageSop: lockedImage, knownFields: SOP_KNOWN_FIELDS.filter((x) => x !== 'payUrl') },
        'contract_failed',
      ],
    ];
    let k = 0;
    failing.push([
      '每次输出不同的 render',
      { imageSop: lockedImage, render: (s) => `${renderSystemPrompt(s)}${k++}` },
      'renderer_nondeterministic',
    ]);
    for (const [what, over, reason] of failing) {
      cfg.__configTest.reset();
      let got = 'ok';
      try {
        await cfg.initConfig(testConfigDeps(t, over));
      } catch (e) {
        got = e instanceof cfg.ConfigStartupError ? e.reason : String(e);
      }
      check(`重渲染：${what} → ${reason}，库不变`, got === reason && (await versions()) === count, got);
    }
    // 产品库装载失败（没有 active 线路）时，即使 SOP 需要 rerender，库里也没有新版本
    const noRoutesCount = await asSuper(
      async () =>
        (
          await t.pg.query<{ n: number }>(
            `select count(*)::int as n from sop_versions v join tenants x on x.id = v.tenant_id where x.slug = 'no-routes'`,
          )
        ).rows[0]!.n,
    );
    cfg.__configTest.reset();
    let nr = 'ok';
    try {
      await cfg.initConfig(testConfigDeps(t, { tenantSlug: 'no-routes', render: (s) => `${renderSystemPrompt(s)}\n- 新加的一条硬性要求` }));
    } catch (e) {
      nr = e instanceof cfg.ConfigStartupError ? e.reason : String(e);
    }
    const noRoutesAfter = await asSuper(
      async () =>
        (
          await t.pg.query<{ n: number }>(
            `select count(*)::int as n from sop_versions v join tenants x on x.id = v.tenant_id where x.slug = 'no-routes'`,
          )
        ).rows[0]!.n,
    );
    check('重渲染：没有 active 线路时即使要重渲染也不写新版本', nr === 'no_active_routes' && noRoutesAfter === noRoutesCount, nr);

    // 验收 3 的最后一条：先导入、再以 DB 模式启动产生 rerender 版本、再 import：仍是退出码 0
    await reinit({ imageSop: md });
    const reimport = await imp('fresh');
    check('导入：租户已有 rerender 版本时再 import，仍是退出码 0', reimport.code === EXIT.ok, reimport.message);
  }
  cfg.__configTest.reset();
}

// ---------------- 产品库编辑流程（第 8 步：验收 9，以及 10 的产品库部分） ----------------
{
  const cat = await import('./catalog.js');
  cfg.__configTest.reset();
  await cfg.initConfig(testConfigDeps(t));
  const tenantId = cfg.currentCatalog().tenantId;
  const ctx: import('../db/client.js').TenantCtx = { tenantId, actor: { kind: 'user', userId: null, name: '运营乙', ip: null } };
  const CODE = 'r-tibet-lux';
  const errOf = async (p: Promise<unknown>): Promise<{ name: string; fields?: string[]; issues?: unknown[] }> => {
    try {
      await p;
      return { name: 'ok' };
    } catch (e) {
      return {
        name: e instanceof Error ? e.constructor.name : String(e),
        fields: (e as { fields?: string[] }).fields,
        issues: (e as { issues?: unknown[] }).issues,
      };
    }
  };
  const dbPayload = async (code: string): Promise<string> => JSON.stringify((await cat.getCatalogItem(ctx, 'route', code))!.payload);
  const snapPayload = (code: string): string => JSON.stringify(cfg.currentCatalog().routes.find((r) => r.id === code));
  const others = (): string =>
    cfg
      .currentCatalog()
      .routes.filter((r) => r.id !== CODE)
      .map((r) => JSON.stringify(r))
      .join('\n');
  const audit = async (action: string): Promise<{ diff: unknown }[]> =>
    asSuper(
      async () =>
        (
          await t.pg.query<{ diff: unknown }>('select diff from audit_log where tenant_id = $1 and action = $2 order by id', [
            tenantId,
            action,
          ])
        ).rows,
    );

  const item0 = (await cat.getCatalogItem(ctx, 'route', CODE))!;
  const r0 = item0.payload as Route;
  check(
    '产品库：条目是 active、payload 与文件相同',
    item0.status === 'active' && JSON.stringify(r0) === JSON.stringify((JSON.parse(routesRaw) as Route[]).find((r) => r.id === CODE)),
  );

  // 锁定字段：逐个改，422 并逐个点名，库和快照都不变
  const lockedEdits: [string, Record<string, unknown>][] = [
    ['priceFrom', { priceFrom: r0.priceFrom + 1 }],
    ['bestSeason', { bestSeason: '6-9月' }],
    ['segments', { segments: [...r0.segments].toReversed() }],
    ['aliases', { aliases: [...r0.aliases!, '新别名'] }],
    ['maxAltitude', { maxAltitude: r0.maxAltitude! + 1 }],
    ['overseas', { overseas: !r0.overseas }],
    ['destination', { destination: '别处' }],
    ['days', { days: r0.days + 1 }],
    ['title', { title: '新标题' }],
    ['inclusions', { inclusions: [...r0.inclusions!, '新含'] }],
    ['exclusions', { exclusions: [...r0.exclusions!, '新不含'] }],
    ['tags:国内', { tags: r0.tags.filter((x) => x !== '国内') }],
  ];
  const beforeDb = await dbPayload(CODE);
  const beforeSnap = snapPayload(CODE);
  for (const [field, set] of lockedEdits) {
    const e = await errOf(cat.updateCatalogItem(ctx, 'route', CODE, { rev: item0.rev, set }));
    check(
      `锁定：active 线路改 ${field} → CatalogLockedFieldError 点名 ${field}`,
      e.name === 'CatalogLockedFieldError' && e.fields?.join(',') === field,
      `${e.name} ${e.fields}`,
    );
  }
  check('锁定：被拒之后库和快照都没变', (await dbPayload(CODE)) === beforeDb && snapPayload(CODE) === beforeSnap);
  const unsetLocked = await errOf(cat.updateCatalogItem(ctx, 'route', CODE, { rev: item0.rev, set: {}, unset: ['inclusions'] }));
  check('锁定：unset 锁定字段也拒', unsetLocked.name === 'CatalogLockedFieldError' && unsetLocked.fields?.join(',') === 'inclusions');

  // 改 highlights：200，下一次 get_route_detail 返回新内容；其他条目不变，这一条除 highlights 外的字节也不变
  const proposalQuote = async (): Promise<string> => {
    const { app } = await import('../server.js');
    const body = (await (await app.request(`/api/proposal/${CODE}?travelers=2&departDate=${peakDate}`)).json()) as { quote?: unknown };
    return JSON.stringify(body.quote);
  };
  const quoteBefore = await proposalQuote();
  const othersBefore = others();
  const gen0 = cfg.currentCatalog().generation;
  const hl = ['雪山脚下的私享营地', ...r0.highlights.slice(1)];
  const u1 = await cat.updateCatalogItem(ctx, 'route', CODE, { rev: item0.rev, set: { highlights: hl } });
  const expectHl = JSON.stringify({ ...r0, highlights: hl });
  check('补丁：改 highlights 成功，rev 加 1', u1.rev === item0.rev + 1 && JSON.stringify(u1.payload) === expectHl);
  check('补丁：库与快照里这一条只有 highlights 变了', (await dbPayload(CODE)) === expectHl && snapPayload(CODE) === expectHl);
  check('补丁：其他条目的字节不变，快照代际加 1', others() === othersBefore && cfg.currentCatalog().generation === gen0 + 1);
  check('补丁：新快照照样冻结', Object.isFrozen(cfg.currentCatalog().routes.find((r) => r.id === CODE)!.highlights));
  check(
    '补丁：下一次 get_route_detail 返回新内容',
    (await executeTool('get_route_detail', { routeId: CODE }, freshSession())).includes('雪山脚下的私享营地'),
  );
  check('补丁：允许的编辑前后方案书的报价不变', (await proposalQuote()) === quoteBefore && quoteBefore !== undefined);

  // 只改 itinerary[0].detail：表单把整个 itinerary 序列化回来，键序被表单重排过，写库仍按原键序，别的字节不变
  const itin = r0.itinerary!.map((d, i) => {
    const reordered = Object.fromEntries(Object.entries(d).toReversed());
    return i === 0 ? { ...reordered, detail: `${d.detail}（加一句）` } : reordered;
  });
  const u2 = await cat.updateCatalogItem(ctx, 'route', CODE, { rev: u1.rev, set: { itinerary: itin } });
  const expectItin = JSON.stringify({
    ...r0,
    highlights: hl,
    itinerary: r0.itinerary!.map((d, i) => (i === 0 ? { ...d, detail: `${d.detail}（加一句）` } : d)),
  });
  check(
    '补丁：只改 itinerary[0].detail，各层键序保持、别的字节不变',
    JSON.stringify(u2.payload) === expectItin && (await dbPayload(CODE)) === expectItin,
  );

  // 把 GET 回来的 payload 原样经表单序列化再提交：审计 diff 为空，字节不变
  const got = (await cat.getCatalogItem(ctx, 'route', CODE))!;
  const form = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(got.payload)) as Record<string, unknown>).toReversed());
  const u3 = await cat.updateCatalogItem(ctx, 'route', CODE, { rev: got.rev, set: form });
  const lastDiff = (await audit('catalog.update')).at(-1)?.diff;
  check(
    '补丁：原样提交回去，字节不变、审计 diff 为空',
    JSON.stringify(u3.payload) === JSON.stringify(got.payload) && JSON.stringify(lastDiff) === '{}',
    JSON.stringify(lastDiff),
  );

  // 不合格的补丁：422
  const invalid: [string, Record<string, unknown>][] = [
    ['itinerary 改空', { itinerary: [] }],
    ['itinerary 条数不等于 days', { itinerary: r0.itinerary!.slice(0, -1) }],
    ['带未知键', { discount: 0.9 }],
    ['数值字段传字符串', { itinerary: r0.itinerary!.map((d, i) => (i === 0 ? { ...d, day: '1' } : d)) }],
  ];
  for (const [what, set] of invalid) {
    const e = await errOf(cat.updateCatalogItem(ctx, 'route', CODE, { rev: u3.rev, set }));
    check(`补丁：${what} → CatalogValidationError`, e.name === 'CatalogValidationError' && (e.issues?.length ?? 0) > 0, e.name);
  }

  // draft 条目：除 id 以外都能改；上架后进快照
  const draftPayload = { ...(JSON.parse(routesRaw) as Record<string, unknown>[])[0]!, id: 'r-new-draft', title: '新线路草稿' };
  const created = await cat.createCatalogItem(ctx, 'route', draftPayload);
  const maxOrdActive = Math.max(...(await cat.listCatalog(ctx, 'route')).filter((x) => x.code !== 'r-new-draft').map((x) => x.ord));
  check(
    '新建：draft、ord 取最大加 1、不进快照',
    created.status === 'draft' && created.ord === maxOrdActive + 1 && !cfg.currentCatalog().routes.some((r) => r.id === 'r-new-draft'),
  );
  check(
    '新建：同一个 code 再建 → CatalogCodeTakenError',
    (await errOf(cat.createCatalogItem(ctx, 'route', draftPayload))).name === 'CatalogCodeTakenError',
  );
  check(
    '新建：不合格的条目 → CatalogValidationError',
    (await errOf(cat.createCatalogItem(ctx, 'route', { ...draftPayload, id: 'r-bad', days: 0 }))).name === 'CatalogValidationError',
  );
  const d1 = await cat.updateCatalogItem(ctx, 'route', 'r-new-draft', { rev: created.rev, set: { priceFrom: 1, title: '改过的草稿' } });
  check('draft：计价与识别字段都能改', (d1.payload as Route).priceFrom === 1 && (d1.payload as Route).title === '改过的草稿');
  const idChange = await errOf(cat.updateCatalogItem(ctx, 'route', 'r-new-draft', { rev: d1.rev, set: { id: 'r-other' } }));
  check(
    'draft：改 id → CatalogLockedFieldError 点名 id',
    idChange.name === 'CatalogLockedFieldError' && idChange.fields?.join(',') === 'id',
  );
  const genBefore = cfg.currentCatalog().generation;
  const act = await cat.activateCatalogItem(ctx, 'route', 'r-new-draft', { rev: d1.rev });
  const pos = cfg.currentCatalog().routes.findIndex((r) => r.id === 'r-new-draft');
  check(
    '上架：draft → active，按 ord 插到快照末尾，代际加 1',
    act.status === 'active' && pos === cfg.currentCatalog().routes.length - 1 && cfg.currentCatalog().generation === genBefore + 1,
  );
  check(
    '上架：已上架的再上架原样返回、快照不动',
    (await cat.activateCatalogItem(ctx, 'route', 'r-new-draft', { rev: act.rev })).status === 'active' &&
      cfg.currentCatalog().generation === genBefore + 1,
  );
  check(
    '上架：上架后锁定字段不能再改',
    (await errOf(cat.updateCatalogItem(ctx, 'route', 'r-new-draft', { rev: act.rev, set: { priceFrom: 2 } }))).name ===
      'CatalogLockedFieldError',
  );
  check(
    '审计：新建、更新、上架各有记录',
    (await audit('catalog.create')).length === 1 &&
      (await audit('catalog.activate')).length === 1 &&
      (await audit('catalog.update')).length >= 4,
  );

  // 验收 10：两次 PATCH 带同一个 rev，第二次 409；并发新建同一个 code 一个成功一个 409；并发新建不同 code 拿到不同 ord
  const cur = (await cat.getCatalogItem(ctx, 'route', CODE))!;
  await cat.updateCatalogItem(ctx, 'route', CODE, { rev: cur.rev, set: { hotelLevel: '奢华' } });
  check(
    '并发：同一个 rev 第二次 PATCH → CatalogRevConflictError',
    (await errOf(cat.updateCatalogItem(ctx, 'route', CODE, { rev: cur.rev, set: { hotelLevel: '五星' } }))).name ===
      'CatalogRevConflictError',
  );
  const same = { ...draftPayload, id: 'r-race' };
  const race = await Promise.allSettled([cat.createCatalogItem(ctx, 'route', same), cat.createCatalogItem(ctx, 'route', same)]);
  const raceNames = race
    .map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).constructor.name))
    .toSorted()
    .join(',');
  check('并发：两个同 code 的新建一个成功、一个 CatalogCodeTakenError', raceNames === 'CatalogCodeTakenError,ok', raceNames);
  const two = await Promise.all([
    cat.createCatalogItem(ctx, 'route', { ...draftPayload, id: 'r-race-a' }),
    cat.createCatalogItem(ctx, 'route', { ...draftPayload, id: 'r-race-b' }),
  ]);
  check('并发：两个不同 code 的新建拿到不同的 ord', two[0].ord !== two[1].ord);

  // catalog-fix：停应用之后改 priceFrom，写一行带 reason 的审计，重启后快照是新值
  cfg.__configTest.reset();
  const fixed = await cat.fixLockedFields({
    db: t.db,
    tenantSlug: 'demo',
    kind: 'route',
    code: CODE,
    set: { priceFrom: r0.priceFrom + 100 },
    reason: '供应商调价',
  });
  const fixAudit = (await audit('catalog.locked_fix')).at(-1)?.diff as Record<string, unknown> | undefined;
  check(
    'catalog-fix：改 priceFrom 成功，审计带 reason 与字段 diff',
    (fixed.payload as Route).priceFrom === r0.priceFrom + 100 &&
      fixAudit?.reason === '供应商调价' &&
      JSON.stringify(fixAudit?.priceFrom) === JSON.stringify([r0.priceFrom, r0.priceFrom + 100]),
  );
  check(
    'catalog-fix：id 还是不能改',
    (await errOf(cat.fixLockedFields({ db: t.db, tenantSlug: 'demo', kind: 'route', code: CODE, set: { id: 'r-x' }, reason: 'x' })))
      .name === 'CatalogLockedFieldError',
  );
  await cfg.initConfig(testConfigDeps(t));
  check('catalog-fix：重启后快照是新值', cfg.currentCatalog().routes.find((r) => r.id === CODE)?.priceFrom === r0.priceFrom + 100);
  cfg.__configTest.reset();
}

// ---------------- 后台新建的目的地：地名按整词认，大区叫法也认得新线路 ----------------
{
  const cat = await import('./catalog.js');
  const { searchRoutes, offCatalogPlaces, visitedDestinations } = await import('../tools.js');
  const base = (JSON.parse(routesRaw) as Record<string, unknown>[])[0]!;
  const ids = async (destination: string): Promise<string> => (await searchRoutes({ destination })).map((r) => r.id).join(',');
  const offKws = (text: string): string =>
    offCatalogPlaces(text)
      .map((p) => p.kw)
      .join(',');
  const rejected = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof cat.CatalogValidationError ? e.issues.map((i) => i.path).join(',') : String(e);
    }
  };

  // 新建与上架时拒掉「另一个更长地名的一截」的目的地和别名：客户说「北海道」「内蒙古」时，引擎会把它认成这条线
  cfg.__configTest.reset();
  await cfg.initConfig(testConfigDeps(t));
  const ctx: import('../db/client.js').TenantCtx = {
    tenantId: cfg.currentCatalog().tenantId,
    actor: { kind: 'user', userId: null, name: '运营丁', ip: null },
  };
  check(
    '地名：新建目的地「北海」→ CatalogValidationError 点名 destination',
    (await rejected(cat.createCatalogItem(ctx, 'route', { ...base, id: 'r-beihai', destination: '北海' }))) === 'destination',
  );
  check(
    '地名：别名里有「蒙古」→ 点名 aliases.1',
    (await rejected(cat.createCatalogItem(ctx, 'route', { ...base, id: 'r-mongol', aliases: ['草原', '蒙古'] }))) === 'aliases.1',
  );
  const rome = await cat.createCatalogItem(ctx, 'route', { ...base, id: 'r-rome', destination: '意大利' });
  const toRome = await cat.updateCatalogItem(ctx, 'route', 'r-rome', { rev: rome.rev, set: { destination: '罗马' } });
  check(
    '地名：draft 改成「罗马」照存，上架时拒、不进快照',
    (await rejected(cat.activateCatalogItem(ctx, 'route', 'r-rome', { rev: toRome.rev }))) === 'destination' &&
      !cfg.currentCatalog().routes.some((r) => r.id === 'r-rome'),
  );
  const gx = await cat.createCatalogItem(ctx, 'route', {
    ...base,
    id: 'r-gx-beihai',
    destination: '广西北海',
    title: '广西北海 涠洲岛 8 日',
  });
  await cat.activateCatalogItem(ctx, 'route', 'r-gx-beihai', { rev: gx.rev });
  check(
    '地名：写全称「广西北海」能上架，北海认成这条线，北海道仍按库外认',
    (await ids('北海')) === 'r-gx-beihai' && offKws('想去北海玩') === '' && offKws('想去北海道滑雪') === '北海道',
  );
  // 大区叫法：片区表只列了种子数据的目的地，后台新建的「西北」线也要在 search_routes(西北) 里
  const nw = await cat.createCatalogItem(ctx, 'route', {
    ...base,
    id: 'r-northwest',
    destination: '西北',
    title: '西北 甘青大环线 8 日',
    priceFrom: 1000,
  });
  await cat.activateCatalogItem(ctx, 'route', 'r-northwest', { rev: nw.rev });
  const northwest = (await ids('西北')).split(',');
  check(
    '大区：后台新建的「西北」线在 search_routes(西北) 里，片区表里的西安照旧在',
    northwest.includes('r-northwest') && northwest.includes('r-xian'),
    northwest.join(','),
  );
  cfg.__configTest.reset();

  // 绕过了上架检查的数据（文件模式、catalog-fix）：目的地是更长地名的一截时，认线路也按地名表的边界
  const fixture = path.join(process.env.VAR_DIR!, 'routes-places.json');
  const noAliases = Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'aliases'));
  const mk = (id: string, destination: string): Route =>
    ({ ...noAliases, id, destination, title: `${destination} 深度游 8 日` }) as unknown as Route;
  const fx = [
    ...(JSON.parse(routesRaw) as Route[]),
    mk('r-beihai', '北海'),
    mk('r-hokkaido', '北海道'),
    mk('r-mongolia', '蒙古'),
    mk('r-rome', '罗马'),
  ];
  fs.writeFileSync(fixture, JSON.stringify(fx));
  const savedRoutesPath = process.env.ROUTES_PATH;
  process.env.ROUTES_PATH = fixture;
  try {
    const hokkaido = await ids('北海道');
    const beihai = await ids('北海');
    check(
      '整词：search_routes(北海道) 只给北海道线，search_routes(北海) 只给北海线',
      hokkaido === 'r-hokkaido' && beihai === 'r-beihai',
      `${hokkaido} / ${beihai}`,
    );
    const inner = await ids('内蒙古');
    check('整词：内蒙古不算蒙古线，仍按库外认', !inner.includes('r-mongolia') && offKws('想去内蒙古草原骑马') === '内蒙古', inner);
    check('整词：罗马尼亚不算罗马线', !(await ids('罗马尼亚')).includes('r-rome') && (await ids('罗马')) === 'r-rome');
    const been = visitedDestinations(['北海道去过了', '内蒙古玩过'], fx).join(',');
    check('整词：说去过北海道、内蒙古，不算去过北海、蒙古', been === '北海道', been);
  } finally {
    if (savedRoutesPath === undefined) delete process.env.ROUTES_PATH;
    else process.env.ROUTES_PATH = savedRoutesPath;
  }
}

// ---------------- 公开页：产品库文本是不可信输入（spec「编辑规则」最后一条） ----------------
{
  const vm = await import('node:vm');
  const { app } = await import('../server.js');
  const { createOrder, supersedeOrder } = await import('../store.js');
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const titleOf = (html: string): string | undefined => /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
  const scripts = (html: string): number => html.split('<script').length - 1;
  // String.replace 的替换串里 $` $' $& 有特殊含义：写进 head 时不能被展开成页面源码的前后两截
  const title = '测试线$`路$&';
  const highlight = "川西$'亮点$`";
  const r0 = (JSON.parse(routesRaw) as Route[])[0]!;
  const fixture = path.join(process.env.VAR_DIR!, 'routes-dollar.json');
  fs.writeFileSync(fixture, JSON.stringify([{ ...r0, title, hotelLevel: '奢$$华', highlights: [highlight, ...r0.highlights.slice(1)] }]));
  const savedRoutesPath = process.env.ROUTES_PATH;
  process.env.ROUTES_PATH = fixture;
  try {
    const page = await (await app.request(`/proposal/${r0.id}/2`)).text();
    check(
      '方案页：标题、亮点里的 $ 替换符原样写进 title 与分享摘要，页面只有一段脚本',
      scripts(page) === 1 &&
        titleOf(page) === `${esc(title)} · 行程方案书` &&
        page.includes(`<meta name="description" content="${r0.days} 天 · 2 位出行 · 奢$$华｜${esc(highlight)}">`),
      `${scripts(page)} ${titleOf(page)?.slice(0, 120)}`,
    );
    const order = { sessionId: 's-dollar', routeId: r0.id, routeTitle: title, travelers: 2, departDate: '', totalPrice: 100 };
    const pending = createOrder(order);
    const pay = await (await app.request(`/pay/${pending.id}`)).text();
    const old = createOrder(order);
    supersedeOrder(old.id, pending.id);
    const oldPay = await (await app.request(`/pay/${old.id}`)).text();
    check(
      '支付页：线路标题里的 $ 替换符原样写进 title（待付款与被替代的旧单都是），页面只有一段脚本',
      scripts(pay) === 1 &&
        titleOf(pay) === `${esc(title)} · 订单支付` &&
        scripts(oldPay) === 1 &&
        titleOf(oldPay) === `${esc(title)} · 订单已被替代`,
      `${titleOf(pay)?.slice(0, 80)} / ${titleOf(oldPay)?.slice(0, 80)}`,
    );
  } finally {
    if (savedRoutesPath === undefined) delete process.env.ROUTES_PATH;
    else process.env.ROUTES_PATH = savedRoutesPath;
  }

  // proposal.html 在浏览器里渲染：数值字段先过 Number()，接口回来的不是数也只显示成 NaN，不会当标记插进页面
  const html = fs.readFileSync(path.join(root, 'public', 'proposal.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const mark = '<img src=x onerror=alert(1)>';
  const shown = { innerHTML: '' };
  const data = {
    route: { ...r0, days: mark, itinerary: [{ day: mark, title: '第一天', detail: '行程', hotel: '酒店', meals: '早' }] },
    travelers: mark,
    quote: { total: 1, perPerson: 1, note: '说明' },
  };
  vm.runInNewContext(script, {
    document: { getElementById: () => shown, title: '行程方案书 · 云途定制旅行' },
    location: { pathname: `/proposal/${r0.id}/2` },
    URLSearchParams,
    encodeURIComponent,
    fetch: async () => ({ ok: true, json: async () => data }),
  });
  for (let i = 0; i < 100 && !shown.innerHTML.includes('<header>'); i++) await new Promise((r) => setTimeout(r, 1));
  check(
    '方案页脚本：天数、天号、人数不是数时显示成 NaN，不当标记插进页面',
    shown.innerHTML.includes('<header>') && !shown.innerHTML.includes('<img src=x') && shown.innerHTML.includes('>DNaN<'),
    shown.innerHTML.slice(0, 200),
  );
}

// ---------------- 检索（第 9 步：验收 11） ----------------
{
  const http = await import('node:http');
  const retrieval = await import('../retrieval.js');
  const cat = await import('./catalog.js');
  // 计数的假 embedding 服务：只数建索引的请求（一次送整库，input 不止一条），不数 semanticRecall 的单条查询。
  // 向量按字符码位落到 1024 维上，用罕见字就能让某条线路在召回里排第一
  let buildRequests = 0;
  let failBuilds = 0;
  let delayNextBuildMs = 0;
  const vec = (text: string): number[] => {
    const v = Array.from({ length: 1024 }, () => 0);
    for (const c of text) v[c.codePointAt(0)! % 1024]! += 1;
    return v;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      void (async () => {
        const { input } = JSON.parse(body) as { input: string[] };
        const isBuild = input.length > 1;
        if (isBuild) buildRequests++;
        if (isBuild && failBuilds > 0) {
          failBuilds--;
          res.statusCode = 500;
          res.end('{}');
          return;
        }
        if (isBuild && delayNextBuildMs) {
          const wait = delayNextBuildMs;
          delayNextBuildMs = 0;
          await new Promise((r) => setTimeout(r, wait));
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: input.map((x) => ({ embedding: vec(x) })), usage: { prompt_tokens: input.length } }));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const saved = { mock: process.env.LLM_MOCK, url: process.env.EMBED_BASE_URL, key: process.env.EMBED_API_KEY };
  process.env.LLM_MOCK = '';
  process.env.EMBED_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.EMBED_API_KEY = 'fake';
  const waitFor = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
    for (let i = 0; i < ms / 10 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    return cond();
  };
  const idle = (): boolean => !retrieval.indexHealth().stale;
  try {
    cfg.__configTest.reset();
    retrieval.__retrievalTest.reset();
    retrieval.__retrievalTest.setBackoff([20]);
    await cfg.initConfig(testConfigDeps(t));
    const tenantId = cfg.currentCatalog().tenantId;
    const ctx: import('../db/client.js').TenantCtx = { tenantId, actor: { kind: 'user', userId: null, name: '运营丙', ip: null } };
    const base = (JSON.parse(routesRaw) as Record<string, unknown>[])[0]!;
    const addRoute = async (id: string, marker: string): Promise<void> => {
      const created = await cat.createCatalogItem(ctx, 'route', {
        ...base,
        id,
        title: `${marker}${marker}${marker}专线`,
        highlights: [marker.repeat(12)],
      });
      await cat.activateCatalogItem(ctx, 'route', id, { rev: created.rev });
    };
    const topHit = async (q: string): Promise<string | undefined> => (await retrieval.semanticRecall(q, 1))?.[0]?.id;
    const snapshotIds = (): string =>
      cfg
        .currentCatalog()
        .routes.map((r) => r.id)
        .join(',');

    await retrieval.buildIndex();
    check(
      '检索：DB 模式启动后建一次索引',
      buildRequests === 1 && retrieval.indexHealth().indexGeneration === cfg.currentCatalog().generation,
      String(buildRequests),
    );

    // 新建并上架一条：之后恰好一次全量构建，能召回它
    buildRequests = 0;
    await addRoute('r-whale', '鲸');
    check('检索：上架后等到新索引就绪', await waitFor(idle));
    check('检索：新建（draft）不触发构建，上架之后恰好一次全量构建', buildRequests === 1, String(buildRequests));
    check('检索：semanticRecall 能召回新上架的线路', (await topHit('鲸鲸鲸')) === 'r-whale');

    // 一次构建还没结束时又上架了一条：丢掉过期的结果、按新快照再建，最终索引与快照一致
    delayNextBuildMs = 150;
    await addRoute('r-shark', '鲨');
    await new Promise((r) => setTimeout(r, 30));
    await addRoute('r-croc', '鳄');
    check(
      '检索：构建期间又上架一条，最终索引的 id 集合等于快照的线路 id',
      (await waitFor(idle)) && retrieval.__retrievalTest.indexIds().join(',') === snapshotIds(),
      `${retrieval.__retrievalTest.indexIds().length} vs ${cfg.currentCatalog().routes.length}`,
    );
    check('检索：两条都召回得到', (await topHit('鲨鲨鲨')) === 'r-shark' && (await topHit('鳄鳄鳄')) === 'r-croc');

    // 上架后构建失败：报出过期，放行之后退避重试成功、能召回。embedding 走的网关自己会重试 5xx，
    // 所以让假服务一直失败，直到看到「过期」再放行
    retrieval.__retrievalTest.setBackoff([200]);
    failBuilds = Number.MAX_SAFE_INTEGER;
    await addRoute('r-turtle', '鳌');
    await waitFor(() => retrieval.indexHealth().lastError !== null, 10_000);
    const failed = retrieval.indexHealth();
    check(
      '检索：构建失败时报过期与错误，旧索引照常服务',
      failed.stale &&
        failed.lastError !== null &&
        failed.indexGeneration! < failed.snapshotGeneration &&
        (await topHit('鲸鲸鲸')) === 'r-whale',
      JSON.stringify(failed),
    );
    failBuilds = 0;
    check('检索：退避重试成功后不再过期', await waitFor(idle, 10_000));
    check('检索：重试之后能召回新线路', (await topHit('鳌鳌鳌')) === 'r-turtle');
    // DB 模式下的首次构建就失败（启动时 embedding 挂了）：同样报过期并按退避重试
    retrieval.__retrievalTest.reset();
    retrieval.__retrievalTest.setBackoff([200]);
    fs.rmSync(path.join(process.env.VAR_DIR!, 'route-vectors.json'), { force: true }); // 否则直接命中刚写的缓存，不发请求
    failBuilds = Number.MAX_SAFE_INTEGER;
    await retrieval.buildIndex();
    const first = retrieval.indexHealth();
    check(
      '检索：DB 模式首次构建失败也报过期',
      first.stale && first.lastError !== null && first.indexGeneration === null,
      JSON.stringify(first),
    );
    failBuilds = 0;
    check(
      '检索：首次构建失败后退避重试成功',
      (await waitFor(idle, 10_000)) && retrieval.indexHealth().indexGeneration === cfg.currentCatalog().generation,
    );

    // 文件模式：行为与原来相同——建一次就不再建，失效什么都不做，缓存格式与键不变（重置内存后命中缓存）
    cfg.__configTest.reset();
    retrieval.__retrievalTest.reset();
    const cacheFile = path.join(process.env.VAR_DIR!, 'route-vectors.json');
    fs.rmSync(cacheFile, { force: true });
    buildRequests = 0;
    await retrieval.buildIndex();
    await retrieval.buildIndex();
    retrieval.invalidateIndex();
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { fp: string; model: string; items: { id: string; vec: number[] }[] };
    const fileIds = (JSON.parse(routesRaw) as { id: string }[]).map((r) => r.id);
    check('检索：文件模式建一次，再调与失效都不发请求', buildRequests === 1 && !retrieval.indexHealth().stale, String(buildRequests));
    check(
      '检索：缓存文件仍是 { fp, model, items }，fp 以条数开头，条目按文件顺序',
      Object.keys(cache).join(',') === 'fp,model,items' &&
        cache.fp.startsWith(`${fileIds.length}:`) &&
        cache.items.map((i) => i.id).join(',') === fileIds.join(','),
    );
    retrieval.__retrievalTest.reset();
    await retrieval.buildIndex();
    check('检索：重启（清掉内存）后命中同一份缓存，不再请求', buildRequests === 1 && retrieval.indexReady());
    check('检索：没有留下临时文件', !fs.readdirSync(process.env.VAR_DIR!).some((f) => f.startsWith('route-vectors.json.tmp')));
  } finally {
    process.env.LLM_MOCK = saved.mock;
    process.env.EMBED_BASE_URL = saved.url ?? '';
    process.env.EMBED_API_KEY = saved.key ?? '';
    retrieval.__retrievalTest.reset();
    cfg.__configTest.reset();
    server.close();
  }
}

// ---------------- 部署 profile：配了企微凭据就必须显式设置（00 开放问题 1，2026-09-26 owner 定） ----------------
{
  const { resolveProfile } = await import('../profile.js');
  const { spawnSync } = await import('node:child_process');
  const reason = (env: Record<string, string>): string => {
    try {
      resolveProfile(env);
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  for (const k of ['WECOM_CORP_ID', 'WECOM_APP_SECRET', 'WECOM_KF_OPEN_KFID']) {
    check(`profile：配了 ${k} 却没设 DEPLOY_PROFILE → 拒绝并点名 ${k}`, reason({ [k]: 'x' }).includes(k), reason({ [k]: 'x' }));
  }
  check('profile：DEPLOY_PROFILE 是空串也算没设，照样拒绝', reason({ DEPLOY_PROFILE: '', WECOM_CORP_ID: 'x' }) !== 'ok');
  check(
    'profile：显式设成 demo 或 prod 就照常',
    reason({ DEPLOY_PROFILE: 'demo', WECOM_CORP_ID: 'x' }) === 'ok' &&
      reason({ DEPLOY_PROFILE: 'prod', WECOM_CORP_ID: 'x', WECOM_APP_SECRET: 'y', WECOM_KF_OPEN_KFID: 'z' }) === 'ok',
  );
  check(
    'profile：没配企微凭据时没设 profile 仍按 demo（空串的凭据不算配了）',
    reason({}) === 'ok' && resolveProfile({}).name === 'demo' && reason({ WECOM_CORP_ID: '' }) === 'ok',
  );
  check('profile：只配了回调的 token / key 不算接了企微', reason({ WECOM_CALLBACK_TOKEN: 'x', WECOM_CALLBACK_AES_KEY: 'y' }) === 'ok');
  // 真的拒绝启动：子进程只加载 profile-boot（它不读 .env），不带 DEPLOY_PROFILE、带一个企微凭据
  const boot = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'profile-boot.ts')], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
  const refused = boot({ WECOM_KF_OPEN_KFID: 'x' });
  check(
    'profile-boot：配了企微凭据却没设 DEPLOY_PROFILE → 以 1 退出并打出原因',
    refused.status === 1 && refused.stderr.includes('拒绝启动') && refused.stderr.includes('DEPLOY_PROFILE'),
    `${refused.status} ${refused.stderr.slice(0, 200)}`,
  );
  const started = boot({ WECOM_KF_OPEN_KFID: 'x', DEPLOY_PROFILE: 'demo' });
  check(
    'profile-boot：显式 demo 时照常（退出码 0，打出 profile）',
    started.status === 0 && started.stdout.includes('[profile] demo'),
    `${started.status} ${started.stderr.slice(0, 200)}`,
  );
}

await t.close();

if (fails.length) {
  console.error(`CONFIG SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `CONFIG SELFTEST PASS: ${pass} 项断言全通（节表与 data/sop.md 往返 / 规范形与 GET→PUT / 编码检查 / 结构 / 合并 / 渲染等价 / 契约的每种 violation / 清单不漂移 / 产品库 schema、锁定字段、键序合并、补丁与表单往返、快照冻结 / DB 模式：两种模式逐字节等价、快照冻结、每轮不查库、/healthz、导入导出、锁状态机与重读、启动顺序与各个失败分支 / SOP 编辑：草稿、检查、发布、回滚、丢弃、rebase、契约闸、启动重渲染 / 产品库编辑：锁定字段、补丁与键序、表单往返、新建与上架、并发、catalog-fix / 检索：上架后恰好重建一次、构建中又上架、失败退避、文件模式不变 / 配了企微凭据必须显式设置 profile）`,
);
process.exit(0);
