// 审计句子与界面固定文案的自测（docs/features/console-ux/spec.md「审计日志」，设计系统 §10.0、§10.2 A 页与 K 页；plan 第 3.4 步）：
// 1. describeAudit：设计系统 §10.0 场景里的每一条写成的句子逐字相同（总览一行写完的样子，审计页的句子加改动摘要）；
//    实体名、字段名、话术节名取自传进来的行业包：同样的记录换一个包，句子跟着换；对象名依次取 diff、产品库缓存、编号；
//    表里没有的动作兜底，动作编码不上句子；diff 形状不对也不抛；
// 2. auditRuns：同一操作者、同一动作、同一实体、相邻不超过 5 分钟的产品库记录合成一句，别的不合；
// 3. ui-labels：类别与「显示登录记录」换算成的 actions 过得了 AuditQuery；角色、动作只认自有属性；话术检查项 7 个。
// 行业包用本文件里的夹具（src/shared 不 import src/packs）；用真实旅游包对真实审计记录的核对在 console.selftest.ts。
// 用法：npx tsx src/shared/audit-text.selftest.ts
import { auditActor, auditFieldLabels, auditRuns, describeAudit, type AuditText } from './audit-text.js';
import { AuditQuery, type AuditEntryView } from './console-api.js';
import type { EntityType, FieldDef, IndustryPack } from './pack.js';
import { AUDIT_ACTIONS, auditAction, auditActionsParam, auditGroups, roleLabel, SOP_CHECKS } from './ui-labels.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

// ---------------- 夹具 ----------------

const field = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'text', group: 'g', ...extra });
const entity = (kind: string, label: string, titleKey: string, fields: FieldDef[]): EntityType => ({
  kind,
  label,
  icon: 'box',
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey,
  subtitleKeys: [],
  groups: [{ key: 'g', label: '基本' }],
  lockGroups: {},
  fields,
  list: { columns: [], filters: [], search: [], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});
/** 旅游包里与审计有关的那几项（字段顺序照 src/packs/travel/console-pack.ts：住宿档次在行程亮点前面） */
const TRAVEL: IndustryPack = {
  id: 'travel',
  name: '旅游',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [
    entity('route', '线路', 'title', [
      field('$code', '线路编号'),
      field('title', '线路名称'),
      field('days', '天数', { type: 'intUnit', unit: '天' }),
      field('intensity.level', '体力强度', { type: 'enum' }),
      field('intensity.hardest', '最累的一段'),
      field('hotelLevel', '住宿档次'),
      field('highlights', '行程亮点', { type: 'subItems' }),
    ]),
    entity('hotel', '酒店', 'name', [
      field('$code', '酒店编号'),
      field('name', '酒店名称'),
      field('nightlyFrom', '每晚起价', { type: 'money' }),
    ]),
  ],
  stages: [],
  sopSections: [
    { key: 'preamble', heading: null, locked: false },
    { key: 'tone', heading: '话术原则', locked: false },
    { key: 'objections', heading: '异议处理', locked: false },
  ],
  nav: { catalogGroup: '产品库', entities: ['route', 'hotel'] },
};
/** 同样的 kind 与字段 key，名字全换掉：句子跟着包走，不是写死的 */
const RENAMED: IndustryPack = {
  ...TRAVEL,
  vocabulary: { ...TRAVEL.vocabulary, productNoun: '商品' },
  entities: [
    entity('route', '套餐', 'title', [
      field('$code', '套餐编号'),
      field('title', '套餐名称'),
      field('hotelLevel', '档次'),
      field('highlights', '卖点'),
    ]),
  ],
  sopSections: [{ key: 'objections', heading: '客户嫌贵怎么答', locked: false }],
};

let nextId = 100;
const at = (hm: string, day = '2026-09-26'): string => new Date(`${day}T${hm}+08:00`).toISOString();
const entry = (e: Partial<AuditEntryView> & Pick<AuditEntryView, 'action'>): AuditEntryView => ({
  id: (nextId -= 1),
  at: at('14:00:00'),
  actorKind: 'user',
  actorName: '小林',
  targetType: null,
  targetId: null,
  diff: null,
  ...e,
});
const cli = (name: string) => ({ actorKind: 'platform' as const, actorName: name });
/** 总览一行写完的样子：句子加补充 */
const line = (t: AuditText): string => t.text;
/** 审计页的样子：句子（不带补充）与下一行的摘要 */
const twoLines = (t: AuditText): [string, string | null] => [`${t.actor.name} ${t.parts.map((p) => p.text).join('')}`, t.summary];
const strongs = (t: AuditText): string[] => t.parts.filter((p) => p.strong).map((p) => p.text);

const GUIZHOU = '贵州 小七孔·西江千户苗寨 5 日';
const SICHUAN = '四川 稻城亚丁·色达秘境 8 日';
const lookups = { itemName: (kind: string, code: string) => (kind === 'route' && code === 'r-sichuan-lux' ? SICHUAN : undefined) };

// ---------------- 1. 设计系统 §10.0 的场景 ----------------

const create = entry({
  action: 'catalog.create',
  at: at('13:40:00'),
  targetType: 'route',
  targetId: 'r-guizhou-5d',
  diff: { id: [null, 'r-guizhou-5d'], title: [null, GUIZHOU], days: [null, 5] },
});
const createText = describeAudit(create, TRAVEL, lookups);
eq('新建线路草稿：名称取 diff 里的新值', line(createText), `小林 新建了线路草稿「${GUIZHOU}」`);
eq('新建线路草稿：操作者与对象用 500，引号不加粗', [createText.actor, strongs(createText)], [{ name: '小林', human: true }, [GUIZHOU]]);
eq('新建线路草稿：分组与图标来自 AUDIT_ACTIONS', [createText.group, createText.icon, createText.count], ['catalog', 'plus', 1]);

const hotels = Array.from({ length: 6 }, (_, i) =>
  entry({
    action: 'catalog.create',
    at: at(`11:20:0${5 - i}`),
    targetType: 'hotel',
    targetId: `h-csv-${i}`,
    diff: { id: [null, `h-csv-${i}`], name: [null, `酒店${i}`] },
  }),
);
const update = entry({
  action: 'catalog.update',
  at: at('10:12:44'),
  targetType: 'route',
  targetId: 'r-sichuan-lux',
  // diff 的键序与包里字段的顺序相反：摘要按包的顺序写
  diff: { highlights: [['a'], ['b']], hotelLevel: ['顶级精品', '顶级野奢'] },
});
const publish = entry({
  action: 'sop.publish',
  at: at('18:30:00', '2026-09-25'),
  actorName: '老板',
  targetType: 'sop_version',
  targetId: '9b2f0f5e-0000-4000-8000-000000000001',
  diff: { versionNo: 2, changedKeys: ['objections'] },
});
const userCreate = (email: string, role: string, hm: string) =>
  entry({
    action: 'platform.user_create',
    at: at(hm, '2026-09-24'),
    ...cli('user-create'),
    targetType: 'user',
    targetId: '9b2f0f5e-0000-4000-8000-000000000002',
    diff: { email, role, created: true },
  });
const importConfig = entry({
  action: 'config.import',
  at: at('10:02:00', '2026-09-24'),
  ...cli('import-config'),
  diff: { sections: 11, routes: 20, hotels: 23 },
});
const tenant = entry({
  action: 'platform.tenant_create',
  at: at('10:01:00', '2026-09-24'),
  ...cli('tenant-create'),
  targetType: 'tenant',
  diff: { slug: 'demo', name: '云途定制旅行', packId: 'travel' },
});
// 设计系统 §10.0 的审计（新的在前）
const scenario = [
  create,
  ...hotels,
  update,
  publish,
  userCreate('xiaolin@yuntu.test', 'admin', '10:05:00'),
  userCreate('boss@yuntu.test', 'owner', '10:03:00'),
  importConfig,
  tenant,
];
const runs = auditRuns(scenario);
eq(
  '§10.0 的审计：合并后 8 句，逐字相同（总览一行写完）',
  runs.map((r) => line(describeAudit(r, TRAVEL, lookups))),
  [
    `小林 新建了线路草稿「${GUIZHOU}」`,
    '小林 新建了6条酒店草稿',
    `小林 修改了线路「${SICHUAN}」的住宿档次、行程亮点`,
    '老板 发布了话术v2，改了1节（异议处理）',
    '命令行 为xiaolin@yuntu.test建了账号（角色：管理员）',
    '命令行 为boss@yuntu.test建了账号（角色：所有者）',
    '命令行 导入了初始配置',
    '命令行 建了租户',
  ],
);
eq('合并的那一句：6 条，新的在前', [runs[1]!.length, runs[1]!.map((e) => e.targetId)], [6, hotels.map((e) => e.targetId)]);
eq('审计页的两行：句子加改动摘要（K 页「改了：住宿档次、行程亮点」）', twoLines(describeAudit(update, TRAVEL, lookups)), [
  `小林 修改了线路「${SICHUAN}」`,
  '改了：住宿档次、行程亮点',
]);
eq('审计页的两行：发布', twoLines(describeAudit(publish, TRAVEL)), ['老板 发布了话术v2', '改了1节：异议处理']);
eq('命令行是非人操作者（画方块图标）', describeAudit(importConfig, TRAVEL).actor, { name: '命令行', human: false });
eq('对象名：产品库缓存里没有时用编号', line(describeAudit(update, TRAVEL)), '小林 修改了线路「r-sichuan-lux」的住宿档次、行程亮点');
eq(
  '对象名：改了名的，写 diff 里的新名字，不写缓存里的',
  line(describeAudit({ ...update, diff: { title: ['旧的名字', '新的名字'] } }, TRAVEL, lookups)),
  '小林 修改了线路「新的名字」的线路名称',
);

// ---------------- 名字取自行业包 ----------------

eq(
  '换一个包：实体名、字段名、话术节名跟着包走',
  [line(describeAudit(create, RENAMED)), line(describeAudit(update, RENAMED, lookups)), line(describeAudit(publish, RENAMED))],
  [`小林 新建了套餐草稿「${GUIZHOU}」`, `小林 修改了套餐「${SICHUAN}」的档次、卖点`, '老板 发布了话术v2，改了1节（客户嫌贵怎么答）'],
);
eq('换一个包：合并的那一句用包里没有的实体时，写包的「产品」叫法', line(describeAudit(runs[1]!, RENAMED)), '小林 新建了6条商品草稿');
const route = TRAVEL.entities[0]!;
/** diff 里的一项：[原来, 现在] */
const pair = (was: unknown, now: unknown): [unknown, unknown] => [was, now];
const hard = (level: string, hardest: string) => ({ level, hardest });
eq(
  '字段名：id 是编号，嵌套字段形状认不出时取第一个子字段的标签，包里没有的合成「另N项」，按包里的顺序',
  auditFieldLabels(route, { nope: pair(1, 2), highlights: pair([], ['a']), intensity: '坏了', id: pair('a', 'b'), zzz: null }),
  ['线路编号', '体力强度', '行程亮点', '另2项'],
);
eq(
  '字段名：嵌套字段只写真正变了的子字段',
  [
    auditFieldLabels(route, { intensity: pair(hard('适中', '第3天徒步4小时'), hard('适中', '第3天徒步5小时')) }),
    auditFieldLabels(route, { intensity: pair(hard('适中', '第3天徒步4小时'), hard('较累', '第3天徒步4小时')) }),
    auditFieldLabels(route, { intensity: pair(hard('适中', '甲'), hard('较累', '乙')), hotelLevel: pair('四星', '五星') }),
  ],
  [['最累的一段'], ['体力强度'], ['体力强度', '最累的一段', '住宿档次']],
);
eq(
  '字段名：嵌套对象新加或删掉，写它里面有的子字段',
  [
    auditFieldLabels(route, { intensity: pair(null, hard('轻松', '没有长距离步行')) }),
    auditFieldLabels(route, { intensity: pair({ hardest: '第2天' }, null) }),
  ],
  [['体力强度', '最累的一段'], ['最累的一段']],
);
eq(
  '字段名：包里的子字段都没变（只换了键序、包外的子键变了）时不点名，算「另N项」',
  [
    auditFieldLabels(route, { intensity: pair(hard('适中', '甲'), { hardest: '甲', level: '适中' }) }),
    auditFieldLabels(route, { intensity: pair({ ...hard('适中', '甲'), x: 1 }, { ...hard('适中', '甲'), x: 2 }) }),
  ],
  [['另1项'], ['另1项']],
);
eq('字段名：没有实体时全算「另N项」', auditFieldLabels(null, { a: pair(1, 2), b: pair(1, 2) }), ['另2项']);
eq(
  '句子：只改了「最累的一段」，不写「体力强度」',
  twoLines(
    describeAudit(
      { ...update, diff: { intensity: pair(hard('适中', '第3天徒步4小时'), hard('适中', '第3天徒步5小时')) } },
      TRAVEL,
      lookups,
    ),
  ),
  [`小林 修改了线路「${SICHUAN}」`, '改了：最累的一段'],
);
eq(
  '话术节：前言写「前言」，认不出的节合成「另N节」',
  line(describeAudit({ ...publish, diff: { versionNo: 3, changedKeys: ['preamble', 'tone', 'ghost'] } }, TRAVEL)),
  '老板 发布了话术v3，改了3节（前言、话术原则、另1节）',
);
eq(
  '话术：没改节时不写补充',
  [
    line(describeAudit({ ...publish, diff: { versionNo: 4, changedKeys: [] } }, TRAVEL)),
    describeAudit({ ...publish, diff: { versionNo: 4, changedKeys: [] } }, TRAVEL).summary,
  ],
  ['老板 发布了话术v4', null],
);

// ---------------- 其余动作 ----------------

const S = (e: Partial<AuditEntryView> & Pick<AuditEntryView, 'action'>): [string, string | null] => {
  const t = describeAudit(entry(e), TRAVEL, lookups);
  return [line(t), t.summary];
};
const acct = { targetType: 'user', targetId: '9b2f0f5e-0000-4000-8000-000000000003' };
eq(
  '其余动作的句子与摘要',
  [
    S({
      action: 'sop.rollback',
      actorName: '老板',
      diff: { fromVersionNo: 2, toVersionNo: 3, targetVersionNo: 1, sameHashAsTarget: true },
    }),
    S({ action: 'sop.discard', actorName: '老板', targetType: 'sop_version' }),
    S({
      action: 'sop.rerender',
      actorKind: 'system',
      actorName: null,
      diff: { causes: ['hard_rules', 'tools', 'future_cause'], fromVersionNo: 2, toVersionNo: 3 },
    }),
    S({ action: 'catalog.activate', targetType: 'route', targetId: 'r-sichuan-lux', diff: { status: ['draft', 'active'] } }),
    S({
      action: 'catalog.locked_fix',
      ...cli('catalog-fix'),
      targetType: 'route',
      targetId: 'r-sichuan-lux',
      diff: { days: [8, 9], reason: '行程多写了一天' },
    }),
    S({ action: 'auth.login', ...acct }),
    S({ action: 'auth.logout', ...acct }),
    S({ action: 'platform.user_create', ...cli('user-create'), ...acct, diff: { email: 'a@b.test', role: 'agent', created: false } }),
    S({ action: 'platform.user_password', ...cli('user-password'), ...acct, diff: { email: 'a@b.test', revokedSessions: 2 } }),
    S({ action: 'platform.user_disable', ...cli('user-disable'), ...acct, diff: { email: 'a@b.test', revokedSessions: 0 } }),
    S({ action: 'platform.member_role', ...cli('member-role'), ...acct, diff: { email: 'a@b.test', role: ['admin', 'supervisor'] } }),
    S({ action: 'platform.member_remove', ...cli('member-remove'), ...acct, diff: { email: 'a@b.test', role: 'viewer' } }),
  ],
  [
    ['老板 把话术回滚到v1，生成v3', '生成v3'],
    ['老板 丢弃了话术草稿', null],
    ['系统 重新生成了话术v3（固定要求、工具定义变了）', '固定要求、工具定义变了'],
    [`小林 上架了线路「${SICHUAN}」`, null],
    [`命令行 修正了线路「${SICHUAN}」的天数`, '改了：天数'],
    ['小林 登录了', null],
    ['小林 退出了登录', null],
    ['命令行 把a@b.test加为成员（角色：坐席）', '角色：坐席'],
    ['命令行 为a@b.test重设了密码，退出了2处登录', '退出了2处登录'],
    ['命令行 停用了a@b.test', null],
    ['命令行 把a@b.test的角色改成主管（原来是管理员）', '原来是管理员'],
    ['命令行 把a@b.test移出了租户（原来是只读）', '原来是只读'],
  ],
);

// 以后新增的动作：兜底，动作编码不上句子
const future = describeAudit(
  entry({ action: 'billing.charge', actorName: '老板', targetType: 'order', targetId: 'o-1', diff: { amount: [0, 1] } }),
  TRAVEL,
);
eq(
  '表里没有的动作：「{操作者} 执行了一项操作」，没有分组，图标是 circle-dashed',
  [line(future), future.group, future.icon],
  ['老板 执行了一项操作', null, 'circle-dashed'],
);
eq('表里没有的动作：原型上的名字也不算认识', line(describeAudit(entry({ action: 'toString' }), TRAVEL)), '小林 执行了一项操作');
eq('操作者：成员被删了名字也没了', auditActor({ actorKind: 'user', actorName: null }), { name: '已删除的成员', human: true });

// 每种动作（加上兜底）的句子里，除了对象（邮箱、编号）和版本号「v3」，没有英文：不出现动作编码、字段原名、命令名
const everyAction = [...Object.keys(AUDIT_ACTIONS), 'billing.charge'].map((action) =>
  describeAudit(
    entry({
      action,
      ...(action.startsWith('platform.') || action === 'config.import' ? cli(action.replace('platform.', '').replace('_', '-')) : {}),
      targetType: action.startsWith('catalog.') ? 'route' : 'user',
      targetId: action.startsWith('catalog.') ? 'r-sichuan-lux' : 'u-1',
      diff: {
        email: 'a@b.test',
        role: 'admin',
        title: ['旧名', '新名'],
        hotelLevel: ['甲', '乙'],
        versionNo: 1,
        toVersionNo: 2,
        targetVersionNo: 1,
        changedKeys: ['tone'],
        causes: ['tools'],
        revokedSessions: 1,
      },
    }),
    TRAVEL,
  ),
);
const english = everyAction.filter((t) => {
  const rest = [t.actor.name, ...t.parts.filter((p) => !p.strong).map((p) => p.text), t.tail ?? '', t.summary ?? ''].join('');
  return /[A-Za-z_]/.test(rest.replace(/v\d+/g, ''));
});
check('每种动作：对象以外没有英文（动作编码、字段原名、命令名都不上句子）', english.length === 0, english.map(line).join(' | '));
check(
  '每种动作：句子里不出现任何动作编码（不变量 7）',
  everyAction.every((t) => !Object.keys(AUDIT_ACTIONS).some((a) => t.text.includes(a))),
);

// diff 形状不对：不抛，照常写出句子
const odd = [null, 'x', 42, [], { changedKeys: 'tone', versionNo: '2', role: 7, email: '', causes: 'tools', revokedSessions: -1 }];
const broken: string[] = [];
for (const action of Object.keys(AUDIT_ACTIONS)) {
  for (const diff of odd) {
    try {
      const t = describeAudit(entry({ action, targetType: 'route', targetId: 'r-x', diff }), TRAVEL);
      if (!t.text.startsWith('小林 ') || t.parts.some((p) => !p.text)) broken.push(`${action} ${JSON.stringify(diff)} → ${t.text}`);
    } catch (e) {
      broken.push(`${action} ${JSON.stringify(diff)} 抛了 ${String(e)}`);
    }
  }
}
check('diff 形状不对（null、字符串、数组、类型不对）：不抛，没有空的段', broken.length === 0, broken.slice(0, 3).join(' | '));
eq(
  'diff 形状不对：用得上的兜底',
  [
    line(describeAudit(entry({ action: 'catalog.update', targetType: 'route', targetId: 'r-x', diff: null }), TRAVEL)),
    line(describeAudit(entry({ action: 'platform.member_role', ...cli('member-role'), diff: { role: 'x' } }), TRAVEL)),
    line(describeAudit(entry({ action: 'catalog.create', targetType: 'route', targetId: null, diff: null }), TRAVEL)),
  ],
  ['小林 修改了线路「r-x」', '命令行 把一个账号的角色改成其他角色（原来是其他角色）', '小林 新建了线路草稿「—」'],
);

// ---------------- 2. auditRuns ----------------

const mk = (hm: string, over: Partial<AuditEntryView> = {}) =>
  entry({ action: 'catalog.create', at: at(hm), targetType: 'hotel', targetId: `h-${hm}`, ...over });
const shape = (rs: AuditEntryView[][]) => rs.map((r) => r.map((e) => e.targetId));
eq('合并：相邻相隔正好 5 分钟也合', shape(auditRuns([mk('11:10:00'), mk('11:05:00'), mk('11:00:00')])), [
  ['h-11:10:00', 'h-11:05:00', 'h-11:00:00'],
]);
eq('合并：相隔超过 5 分钟就断开', shape(auditRuns([mk('11:10:01'), mk('11:05:00')])), [['h-11:10:01'], ['h-11:05:00']]);
eq(
  '合并：操作者、动作、实体有一样不同就不合',
  shape(
    auditRuns([
      mk('11:04:00'),
      mk('11:03:00', { actorName: '老板' }),
      mk('11:02:00', { action: 'catalog.update' }),
      mk('11:01:00', { targetType: 'route' }),
      mk('11:00:00', { actorKind: 'platform' }),
    ]),
  ),
  [['h-11:04:00'], ['h-11:03:00'], ['h-11:02:00'], ['h-11:01:00'], ['h-11:00:00']],
);
eq(
  '合并：只合产品库的动作，登录这类不合',
  auditRuns([entry({ action: 'auth.login', at: at('09:01:00') }), entry({ action: 'auth.login', at: at('09:00:00') })]).length,
  2,
);
eq('合并：不相邻的同类不合，顺序不变', shape(auditRuns([mk('11:03:00'), mk('11:02:00', { action: 'catalog.update' }), mk('11:01:00')])), [
  ['h-11:03:00'],
  ['h-11:02:00'],
  ['h-11:01:00'],
]);
eq(
  '合并的句子',
  line(describeAudit(auditRuns([mk('11:03:00', { action: 'catalog.update' }), mk('11:02:00', { action: 'catalog.update' })])[0]!, TRAVEL)),
  '小林 修改了2条酒店',
);

// ---------------- 3. ui-labels ----------------

const parsed = (actions: string | undefined) => AuditQuery.safeParse(actions === undefined ? {} : { actions });
const groups = auditGroups(TRAVEL).map((g) => g.key);
eq(
  '审计类别：全部 / 销售话术 / 产品库 / 账号与登录 / 平台与配置',
  auditGroups(TRAVEL).map((g) => g.label),
  ['全部', '销售话术', '产品库', '账号与登录', '平台与配置'],
);
eq(
  '审计类别：产品库那一类的名字跟着行业包的侧栏分组名',
  auditGroups({ nav: { catalogGroup: '套餐与主材', entities: [] } }).map((g) => g.label),
  ['全部', '销售话术', '套餐与主材', '账号与登录', '平台与配置'],
);
check(
  '审计类别：每个动作都属于一个类别',
  Object.values(AUDIT_ACTIONS).every((d) => groups.includes(d.group)),
);
eq('actions：全部且显示登录记录时不过滤', auditActionsParam('all', true), undefined);
eq(
  'actions：全部、不显示登录记录 = 除登录、退出外的全部动作',
  auditActionsParam('all', false)?.split(','),
  Object.keys(AUDIT_ACTIONS).filter((a) => !a.startsWith('auth.')),
);
eq(
  'actions：账号与登录，不显示登录记录时不含登录、退出',
  auditActionsParam('account', false)
    ?.split(',')
    .filter((a) => a.startsWith('auth.')),
  [],
);
eq(
  'actions：账号与登录，显示登录记录时含登录、退出',
  auditActionsParam('account', true)
    ?.split(',')
    .filter((a) => a.startsWith('auth.')),
  ['auth.login', 'auth.logout'],
);
eq('actions：销售话术', auditActionsParam('sop', false), 'sop.publish,sop.rollback,sop.discard,sop.rerender');
const combos = groups.flatMap((g) => [true, false].map((l) => auditActionsParam(g, l)));
check(
  'actions：每种组合都过得了 AuditQuery（至多 32 个），且每个都在 AUDIT_ACTIONS 里',
  combos.every((c) => parsed(c).success && (c === undefined || c.split(',').every((a) => auditAction(a) !== null))),
);
eq('动作表：原型上的名字查不到', [auditAction('toString'), auditAction('__proto__'), auditAction('constructor')], [null, null, null]);
eq('角色：中文名；认不出的写「其他角色」', ['owner', 'agent', 'root', 'toString', 7].map(roleLabel), [
  '所有者',
  '坐席',
  '其他角色',
  '其他角色',
  '其他角色',
]);
eq(
  '话术检查项：7 个，按设计系统 §5.17 的顺序',
  SOP_CHECKS.map(([, label]) => label),
  ['结构完整', '固定规则节没改', '必备短语都在', '没有禁用短语', '工具名都存在', '字段名都存在', '字数在额度内'],
);

if (fails.length) {
  console.error(`AUDIT TEXT SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `AUDIT TEXT SELFTEST PASS: ${pass} 项断言全通（§10.0 场景的句子 / 名字取自行业包 / 兜底与形状不对的 diff / 合并连续同类 / 审计类别与 actions、角色、检查项）`,
);
