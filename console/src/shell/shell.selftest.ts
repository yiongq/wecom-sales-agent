// 外壳的自测（console UX spec「逐页设计 · 外壳」「信息架构、导航与路由」、不变量 19、23，plan 第 2.2 步）：
// 1. 启动：/me 与 /pack 的每种组合按 spec「外壳 · 启动」那张表定下来是谁、或按哪条文案整页出错；成员身份下 /me 失败不降成匿名；
// 2. 侧栏由行业包生成：分组、顺序、图标名；会话只给成员，审计日志只给所有者、管理员；每个路由恰有一个选中项；
// 3. 标签页标题「页名 · 租户名」，匿名是「· 演示」，各页互不相同；搜索占位、徽标文字、头像取色、会话标签（相对时间挪到
//    src/shared/format.selftest.ts）；
// 4. 视口三档与侧栏形态、进入销售话术页默认收起；铃铛与软徽标的两个查询真的按轮询参数挂上（画出 Bell 后看查询缓存）；
// 5. ⌘K：原文、拼音与首字母匹配（真实的 pinyin-match），分组顺序，各组的加载与出错，会话按短码，匿名没有会话组，
//    ↑↓ / Enter / 输入法组字 / 不响应 J、K；快捷键按平台只认一种；打开时只取还没载入的列表（真的 QueryObserver 加假 fetch）；
//    任何行业包的实体都进侧栏、占位和 ⌘K（kind 只转类型、不筛）；
// 6. 画出来的页头：非编辑角色有「只读」胶囊（说明写角色），编辑角色没有；匿名有演示横幅；用户行的角色在 DOM 里（读屏读得到）；
//    租户行：匿名没有铃铛；用户按钮的名字是「名字，角色」；用户菜单的外观与减少动态效果带 aria-checked。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/shell/shell.selftest.ts
process.env.TZ = 'Asia/Shanghai';

import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import dynamicIconImports from 'lucide-react/dynamicIconImports.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationRow, Me, Role } from '../../../src/shared/console-api.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { AUDIT_ACTIONS } from '../../../src/shared/ui-labels.js';
import { catalogKind, HttpError } from '../api.js';
import { errorCopy } from '../parts/errors.js';
import { paletteConversationsQuery, paletteListQuery } from '../queries.js';
import { VIEWER_KEY } from '../viewer.js';
import { Bell } from './Bell.js';
import { resolveBoot, type Outcome, type Viewer } from './boot.js';
import { ENTITY_ICON_NAMES } from './icons.js';
import { __liveTest, type EventSourceLike, GRACE_MS, INITIAL_LIVE, onClose, onGraceExpired, onOpen, startLiveEvents } from './live.js';
import { notificationPermission, notifyHandoff, requestNotificationPermission } from './notifications.js';
import {
  avatarIndex,
  badgeText,
  buildNav,
  collapsedByDefault,
  conversationLabel,
  documentTitle,
  packEntities,
  POLL,
  searchPlaceholder,
  selectedNavKey,
  type ShellViewer,
  sidebarMode,
  tabTitlePrefix,
  viewportTier,
  workbenchHref,
  workbenchPath,
} from './model.js';
import { PageHeader } from './PageHeader.js';
import {
  fieldText,
  isPaletteShortcut,
  moveActive,
  paletteKey,
  paletteShortcut,
  type PinyinLib,
  pinyinMatcher,
  plainMatch,
  searchGroups,
  selectableRows,
  type SearchInput,
} from './search.js';
import { TenantRow } from './Sidebar.js';
import { UserMenu, userMenuItems, UserNames } from './UserMenu.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

// ---------------- 夹具 ----------------

const entity = (kind: string, label: string, icon: string, search: string[]): EntityType => ({
  kind,
  label,
  icon,
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey: 'title',
  subtitleKeys: ['destination', '$code'],
  groups: [],
  lockGroups: {},
  fields: [],
  list: { columns: [], filters: [], search, defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});
// pack.entities 与 nav.entities 的顺序故意不同：侧栏按 nav.entities 排
const PACK: IndustryPack = {
  id: 'fixture',
  name: '夹具包',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [
    entity('hotel', '酒店', 'bed-double', ['title', '$code']),
    entity('route', '线路', 'route', ['title', 'destination', 'aliases', '$code']),
  ],
  stages: [],
  sopSections: [],
  nav: { catalogGroup: '产品库', entities: ['route', 'hotel'] },
};
const me = (role: Role, name = '老板'): Me => ({
  userId: 'u1',
  displayName: name,
  role,
  csrf: 'c1',
  tenantSlug: 'yuntu',
  tenantName: '云途定制旅行',
});
const member = (role: Role): ShellViewer => ({ kind: 'member', me: me(role) });
const ANON: ShellViewer = { kind: 'anon' };
const ROLES: readonly Role[] = ['owner', 'admin', 'supervisor', 'agent', 'viewer'];

// ---------------- 1. 启动 ----------------

const res = (status: number, body: unknown): Outcome => ({ status, body });
const ok = (body: unknown): Outcome => res(200, body);
const E401 = res(401, { error: 'unauthorized' });
const DISABLED = res(503, { error: 'db_disabled' });
const NOT_READY = res(503, { error: 'not_ready' });
const DOWN: Outcome = { thrown: new TypeError('fetch failed') };
const E500 = res(500, { error: 'internal' });

/** 判定出的身份，或抛出的错按 ERROR_COPY 显示的标题 */
function boot(meO: Outcome, packO: Outcome, memberSession = false): string {
  try {
    const v: Viewer = resolveBoot(meO, packO, memberSession);
    if (v.kind === 'member') return `member:${v.me.displayName}:${v.pack.id}`;
    if (v.kind === 'anon') return `anon:${v.pack.id}`;
    return v.kind;
  } catch (e) {
    return `error:${errorCopy(e).title}:${errorCopy(e).tone}`;
  }
}

const PACK_OK = ok(PACK);
eq('启动：/me 200、/pack 200 → 成员外壳', boot(ok(me('owner')), PACK_OK), 'member:老板:fixture');
eq('启动：/me 401、/pack 200 → demo 匿名外壳', boot(E401, PACK_OK), 'anon:fixture');
eq('启动：/me 401、/pack 401 → prod 登录页', boot(E401, E401), 'login');
eq('启动：/me 503 db_disabled → 整页中性说明', boot(DISABLED, E401), 'disabled');
eq('启动：/pack 503 db_disabled → 整页中性说明', boot(ok(me('owner')), DISABLED), 'disabled');
eq('启动：/me 503 not_ready → 系统正在启动（中性）', boot(NOT_READY, PACK_OK), 'error:系统正在启动:neutral');
eq('启动：/pack 503 not_ready → 系统正在启动（中性）', boot(E401, NOT_READY), 'error:系统正在启动:neutral');
eq('启动：/me 网络失败 → 服务暂时连不上', boot(DOWN, PACK_OK), 'error:服务暂时连不上:danger');
eq('启动：/me 5xx → 服务暂时连不上，不按匿名显示', boot(E500, PACK_OK), 'error:服务暂时连不上:danger');
eq('启动：/pack 网络失败（/me 401）→ 服务暂时连不上', boot(E401, DOWN), 'error:服务暂时连不上:danger');
eq('启动：/pack 5xx（/me 200）→ 服务暂时连不上', boot(ok(me('owner')), E500), 'error:服务暂时连不上:danger');
eq('启动：/pack 5xx（/me 401）→ 服务暂时连不上', boot(E401, E500), 'error:服务暂时连不上:danger');
check('启动：成员身份下 /me 401 不降成匿名', boot(E401, PACK_OK, true).startsWith('error:'), boot(E401, PACK_OK, true));
check('启动：/me 200 而 /pack 401（表外）按错误显示', boot(ok(me('owner')), E401).startsWith('error:'), boot(ok(me('owner')), E401));
check('启动：/me 403（表外）按错误显示', boot(res(403, { error: 'forbidden' }), PACK_OK).startsWith('error:'));
check('启动：/me 回的不是 JSON 也不崩', boot(res(502, 'Bad Gateway'), PACK_OK) === 'error:服务暂时连不上:danger');
// 表里「/pack 5xx」一行不看 /me：/me 回了表外的状态、或成员身份下 /me 没成功，照样是「服务暂时连不上」
eq('启动：/pack 5xx（/me 403）→ 服务暂时连不上', boot(res(403, { error: 'forbidden' }), E500), 'error:服务暂时连不上:danger');
eq('启动：/pack 5xx（成员身份下 /me 401）→ 服务暂时连不上', boot(E401, E500, true), 'error:服务暂时连不上:danger');
eq('启动：not_ready 先于网络失败（服务端说在启动，比连不上更具体）', boot(NOT_READY, DOWN), 'error:系统正在启动:neutral');
check(
  '启动：db_disabled 先于网络失败（两个同时来）',
  boot(DISABLED, DOWN) === 'disabled' && boot(DOWN, DISABLED) === 'disabled',
  `${boot(DISABLED, DOWN)} / ${boot(DOWN, DISABLED)}`,
);
{
  let thrown: unknown = null;
  try {
    resolveBoot(NOT_READY, PACK_OK, false);
  } catch (e) {
    thrown = e;
  }
  check('启动：not_ready 抛的是 HttpError 503', thrown instanceof HttpError && thrown.status === 503 && thrown.body.error === 'not_ready');
}

// ---------------- 2. 侧栏 ----------------

const shape0 = (pack: IndustryPack, v: ShellViewer): string[] =>
  buildNav(pack, v).map((g) => `${g.title ?? '-'}:${g.items.map((i) => `${i.label}${i.entity ? `(${i.entity})` : ''}`).join(',')}`);
const shape = (v: ShellViewer): string[] => shape0(PACK, v);
const EDITOR_NAV = ['-:总览,销售话术', '产品库:线路(route),酒店(hotel)', '运营:会话,审计日志'];
eq('侧栏：所有者', shape(member('owner')), EDITOR_NAV);
eq('侧栏：管理员', shape(member('admin')), EDITOR_NAV);
for (const r of ['supervisor', 'agent', 'viewer'] as const) {
  eq(`侧栏：${r} 没有审计日志`, shape(member(r)), ['-:总览,销售话术', '产品库:线路(route),酒店(hotel)', '运营:会话']);
}
eq('侧栏：匿名没有会话、审计入口（也没有「运营」组）', shape(ANON), ['-:总览,销售话术', '产品库:线路(route),酒店(hotel)']);
{
  const nav = buildNav(PACK, member('owner'));
  const items = nav.flatMap((g) => g.items);
  eq(
    '侧栏：实体图标取自行业包',
    items.filter((i) => 'entity' in i.icon).map((i) => ('entity' in i.icon ? i.icon.entity : '')),
    ['route', 'bed-double'],
  );
  eq(
    '侧栏：只有会话项带等人接手的软徽标',
    items.filter((i) => i.waiting).map((i) => i.key),
    ['/conversations'],
  );
  const other: IndustryPack = { ...PACK, nav: { catalogGroup: '套餐与主材', entities: ['hotel', 'nope'] } };
  eq(
    '侧栏：分组名与实体顺序跟着行业包，nav 里不存在的实体跳过',
    buildNav(other, ANON).map((g) => `${g.title ?? '-'}:${g.items.map((i) => i.label).join(',')}`),
    ['-:总览,销售话术', '套餐与主材:酒店'],
  );

  // 审计动作的图标名（src/shared/ui-labels.ts 的 AUDIT_ACTIONS，加上兜底的 circle-dashed）都是 lucide-react 里有的图标
  const lucideNames = new Set(Object.keys(dynamicIconImports));
  const auditIcons = [...Object.values(AUDIT_ACTIONS).map((d) => d.icon), 'circle-dashed'];
  check(
    '审计动作的图标都是 lucide 的图标名',
    lucideNames.size > 1000 && auditIcons.every((n) => lucideNames.has(n)),
    auditIcons.filter((n) => !lucideNames.has(n)).join(','),
  );
  // 审计动作的图标不取实体图标集合里的名字（设计系统 §7）：否则某个包给实体配了它，侧栏的实体和审计的动作画成同一个图标
  check(
    '审计动作的图标不与实体图标集合重名',
    ENTITY_ICON_NAMES.length === 24 && auditIcons.every((n) => !ENTITY_ICON_NAMES.includes(n)),
    auditIcons.filter((n) => ENTITY_ICON_NAMES.includes(n)).join(','),
  );

  // 每个路由恰有一个选中项（不变量 23），带不带 /console 都认，按整段比
  const routes: Array<[string, string | null]> = [
    ['/console/sop', '/sop'],
    ['/sop', '/sop'],
    ['/console/catalog/route', '/catalog/route'],
    ['/console/catalog/hotel', '/catalog/hotel'],
    ['/console/catalog/hotel/h-1', '/catalog/hotel'],
    ['/console/conversations', '/conversations'],
    ['/console/audit', '/audit'],
    ['/console', '/'],
    ['/console/', '/'],
    ['/', '/'],
    ['/console/sopx', null],
    ['/console/catalog/routes', null],
    ['/console/overview', null],
  ];
  for (const [path, want] of routes) eq(`选中项：${path}`, selectedNavKey(path, nav), want);
  const counted = items.map((i) => items.filter((j) => selectedNavKey(`/console${i.key}`, nav) === j.key).length);
  check(
    '选中项：每个导航项的路由下恰好一个',
    counted.every((n) => n === 1),
    JSON.stringify(counted),
  );

  // 标签页标题：「页名 · 租户名」，各页互不相同；匿名以「 · 演示」结尾
  const titles = items.map((i) => documentTitle([i.label], member('owner')));
  eq('标题：成员', titles.slice(0, 2), ['总览 · 云途定制旅行', '销售话术 · 云途定制旅行']);
  check('标题：各页互不相同', new Set(titles).size === titles.length, JSON.stringify(titles));
  check(
    '标题：以「 · 租户名」结尾',
    titles.every((t) => t.endsWith(' · 云途定制旅行')),
  );
  eq('标题：匿名', documentTitle(['线路'], ANON), '线路 · 演示');
  eq(
    '标题：详情页',
    documentTitle(['贵州 小七孔·西江千户苗寨 5 日', '线路'], member('admin')),
    '贵州 小七孔·西江千户苗寨 5 日 · 线路 · 云途定制旅行',
  );
}
eq('搜索占位：成员', searchPlaceholder(PACK, member('agent')), '搜索线路、酒店、会话…');
eq('搜索占位：匿名没有会话', searchPlaceholder(PACK, ANON), '搜索线路、酒店…');
{
  // 界面不认行业（spec「加一个行业包」：console/src 零改动）：接口枚举里没有的 kind 照样进侧栏、占位和 ⌘K，
  // 发出去的请求就是这个 kind（验收 5 的假包走查拦的是 /catalog/package、/catalog/material）
  const home: IndustryPack = {
    ...PACK,
    entities: [entity('package', '装修套餐', 'package', ['title', '$code']), entity('material', '主材', 'layers', ['title'])],
    nav: { catalogGroup: '产品库', entities: ['package', 'material'] },
  };
  eq('别的行业包：侧栏', shape0(home, member('owner')), [
    '-:总览,销售话术',
    '产品库:装修套餐(package),主材(material)',
    '运营:会话,审计日志',
  ]);
  eq('别的行业包：搜索占位', searchPlaceholder(home, member('owner')), '搜索装修套餐、主材、会话…');
  eq(
    '别的行业包：⌘K 的实体表与侧栏同源',
    packEntities(home).map((e) => e.kind),
    ['package', 'material'],
  );
  eq('别的行业包：kind 只转类型、不筛', ['package', 'material', 'route'].map(catalogKind), ['package', 'material', 'route']);
  eq('别的行业包：列表请求的 queryKey 带原来的 kind', paletteListQuery(catalogKind('package'), true).queryKey, ['catalog', 'package']);
}

// ---------------- 3. 徽标、头像、会话、时间 ----------------

eq('徽标：0、负数、没有数都不画', [badgeText(0), badgeText(-1), badgeText(undefined), badgeText(Number.NaN)], [null, null, null, null]);
eq('徽标：1、99 照写，100 起写 99+', [badgeText(1), badgeText(99), badgeText(100), badgeText(1234)], ['1', '99', '99+', '99+']);
// 老 U+8001 + 板 U+677F = 59264，mod 6 = 2 → 3；小 U+5C0F + 林 U+6797 = 50086，mod 6 = 4 → 5
eq('头像：老板取 av3、小林取 av5', [avatarIndex('老板'), avatarIndex('小林')], [3, 5]);
// 😀 是 UTF-16 的两个码元 D83D DE00，相加 112189，mod 6 = 1 → 2（按码点 128512 算会是 5）
eq('头像：按 UTF-16 码元相加', avatarIndex('😀'), 2);
check(
  '头像：总在 1–6',
  ['', '技术支持', 'Ada', '云途定制旅行'].every((n) => avatarIndex(n) >= 1 && avatarIndex(n) <= 6),
);

const row = (id: string, channel = 'wecom'): ConversationRow => ({
  id,
  channel,
  stage: 'quote',
  handedOver: true,
  messageCount: 2,
  updatedAt: '',
  needSummary: null,
  assignee: null,
  handoff: null,
  lastCustomerAt: null,
});
eq('会话标签：企微客户 · F01', conversationLabel(row('wecom:cust_F01'), PACK), ['企微客户', 'F01']);
eq(
  '会话标签：客户的叫法取自行业包',
  conversationLabel(row('wecom:cust_A01'), { ...PACK, vocabulary: { ...PACK.vocabulary, customer: '业主' } }),
  ['企微业主', 'A01'],
);
eq('会话标签：不认识的渠道只写客户', conversationLabel(row('cust_B01', 'mail'), PACK), ['客户', 'B01']);
eq('会话标签：没有字母数字时写占位', conversationLabel(row('wecom:cust_'), PACK)[1], '····');
eq('工作台深链：#s=<id>，id 按 URL 编码', workbenchHref('wecom:cust F01'), '/admin.html#s=wecom%3Acust%20F01');

// ---------------- 4. 视口、收起、轮询 ----------------

eq('视口三档', [1440, 1280, 1279, 992, 991, 375].map(viewportTier), ['wide', 'wide', 'rail', 'rail', 'narrow', 'narrow']);
eq(
  '侧栏形态',
  [
    sidebarMode('wide', false),
    sidebarMode('wide', true),
    sidebarMode('rail', false),
    sidebarMode('narrow', false),
    sidebarMode('narrow', true),
  ],
  ['expanded', 'collapsed', 'collapsed', 'hidden', 'hidden'],
);
eq(
  '进入销售话术页、会话工作台默认收起；I 页本身不收起',
  [
    '/console/sop',
    '/sop',
    '/console/catalog/route',
    '/console/sopx',
    '/console/conversations',
    '/console/conversations/wecom:cust_F01',
    '/conversations/sim-abc',
  ].map(collapsedByDefault),
  [true, true, false, false, false, true, true],
);
eq('轮询：可见时每 30 秒，隐藏时停', POLL, { refetchInterval: 30_000, refetchIntervalInBackground: false });
{
  // 事件流接上之后（spec「通知」）：这三个查询不再固定 30 秒轮询，连着（或还在断线的 30 秒宽限内）不轮询，
  // 断线满 30 秒才退回、重连立刻停（shell/live.ts）。画一次 Bell，看查询缓存里这几个查询建起来时带的选项；
  // 这里没有调 startLiveEvents，live 的模块状态是初始值（没连、没到退回轮询的点），所以是 false，不是 30 秒
  __liveTest.reset();
  const qc = new QueryClient();
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Bell, { pack: PACK, placement: 'rightTop' })));
  const opts = (key: readonly string[]) => {
    const o = qc.getQueryCache().find({ queryKey: [...key], exact: true })?.options as Record<string, unknown> | undefined;
    return o ? { refetchInterval: o.refetchInterval, refetchIntervalInBackground: o.refetchIntervalInBackground } : null;
  };
  const DISCONNECTED = { refetchInterval: false, refetchIntervalInBackground: false };
  eq('轮询：铃铛与软徽标的计数查询——事件流还没确认断线时不轮询', opts(['conversations', 'counts']), DISCONNECTED);
  eq('轮询：铃铛的等人接手列表——同上', opts(['conversations', 'human']), DISCONNECTED);
  eq('轮询：铃铛的「已成交客户要人工」列表——同上', opts(['conversations', 'paidNeedsHuman']), DISCONNECTED);
  // 退回轮询之后变成 30 秒：useLivePollInterval 本身是 `state.polling ? pollMs : false` 这一句，
  // state.polling 从 false 变 true 的那条规则已经在下面的纯函数（onGraceExpired）与 startLiveEvents 接线里测过；
  // renderToStaticMarkup 对 useSyncExternalStore 一律走 getServerSnapshot（同 useViewport 在 SSR 下的写法），
  // 改模块状态在这种渲染方式下看不出来，这里不重复造一套真实 DOM 挂载
  __liveTest.reset();
}
{
  // 徽标与标签页标题前缀只数 human，不把 assigned、已成交客户要人工也算进去（不变量 45）：
  // counts 里 assigned 有数、paidNeedsHuman 也有会话时，铃铛的徽标只显示 human 那个数
  const qc = new QueryClient();
  qc.setQueryData(['conversations', 'counts'], {
    total: 10,
    byState: { ai: 3, human: 2, assigned: 5, paid: 0 },
    aiByStage: {},
    updatedToday: 0,
  });
  qc.setQueryData(['conversations', 'paidNeedsHuman'], { items: [row('wecom:cust_Z1'), row('wecom:cust_Z2'), row('wecom:cust_Z3')] });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(Bell, { pack: PACK, placement: 'rightTop' })),
  );
  check(
    '徽标：只数 human（2），不把 assigned（5）与已成交客户要人工（3）也算进去',
    html.includes('>2<') && !html.includes('>7<') && !html.includes('>5<'),
    html.match(/badge-solid[^>]*>(\d+)</)?.[1],
  );
}

// ---------------- 5. ⌘K ----------------

check('原文匹配：不分大小写、忽略空白', plainMatch('R-GuiZhou 5d', 'guizhou5D') && !plainMatch('酒店', '') && !plainMatch('酒店', '  '));
const lib = (await import('pinyin-match')).default as PinyinLib;
const py = pinyinMatcher(lib);
check('拼音：首字母 jd → 酒店', py('酒店', 'jd'));
check('拼音：全拼 xianlu → 线路', py('线路', 'xianlu'));
check('拼音：kh → 客户，大写也认', py('客户', 'kh') && py('客户', 'KH'));
check('拼音：不相干的不命中', !py('酒店', 'xl') && !py('线路', 'zzz'));
check('拼音：原文照样命中', py('r-guizhou-5d', 'guizhou') && py('贵州 小七孔', '小七'));

type A = string;
const items = [
  { code: 'r-guizhou-5d', payload: { title: '贵州 小七孔·西江千户苗寨 5 日', destination: '贵州', aliases: ['黔东南'] } },
  { code: 'r-sichuan-lux', payload: { title: '四川 稻城亚丁·色达秘境 8 日', destination: '四川', aliases: [] } },
  ...Array.from({ length: 7 }, (_, i) => ({ code: `r-yn-${i}`, payload: { title: `云南 第${i}条`, destination: '云南' } })),
];
const hotels = [{ code: 'h-amandayan', payload: { title: '大研安缦', destination: '云南' } }];
const convs: ConversationRow[] = [row('wecom:cust_F01'), row('wecom:cust_A01'), row('wecom:cust_F02')];
const base = (over: Partial<SearchInput<A>> = {}): SearchInput<A> => ({
  query: '',
  match: py,
  pages: [
    { key: 'page:/sop', label: '销售话术', action: 'go:/sop' },
    { key: 'page:/conversations', label: '会话', action: 'go:/conversations' },
  ],
  entities: [
    { entity: PACK.entities[1]!, state: 'ok', items },
    { entity: PACK.entities[0]!, state: 'ok', items: hotels },
  ],
  conversations: { state: 'ok', rows: convs, label: (r) => conversationLabel(r, PACK), hint: () => '8分钟前' },
  actions: [
    { key: 'appearance:dark', label: '外观：深色', action: 'dark' },
    { key: 'about', label: '关于', action: 'about' },
  ],
  entityAction: (kind, code) => `open:${kind}:${code}`,
  conversationAction: (r) => `conv:${r.id}`,
  ...over,
});
const groupsOf = (input: SearchInput<A>): string[] => searchGroups(input).map((g) => `${g.title}/${g.state}/${g.rows.length}`);

eq('⌘K：没输入时只列页面与操作', groupsOf(base()), ['页面/ok/2', '操作/ok/2']);
eq('⌘K：没输入时还在取的组也不出现', groupsOf(base({ entities: [{ entity: PACK.entities[1]!, state: 'loading', items: [] }] })), [
  '页面/ok/2',
  '操作/ok/2',
]);
{
  const g = searchGroups(base({ query: '贵州' }));
  eq(
    '⌘K：按目的地、名称匹配，只列命中的组',
    g.map((x) => x.title),
    ['线路'],
  );
  eq(
    '⌘K：实体行的标签、补充与动作',
    [g[0]!.rows[0]!.label, g[0]!.rows[0]!.hint, g[0]!.rows[0]!.action],
    ['贵州 小七孔·西江千户苗寨 5 日', ['贵州', 'r-guizhou-5d'], 'open:route:r-guizhou-5d'],
  );
}
eq(
  '⌘K：数组字段（其他叫法）参与匹配',
  searchGroups(base({ query: '黔东南' }))[0]?.rows.map((r) => r.action),
  ['open:route:r-guizhou-5d'],
);
eq(
  '⌘K：编号参与匹配',
  searchGroups(base({ query: 'sichuan' }))[0]?.rows.map((r) => r.action),
  ['open:route:r-sichuan-lux'],
);
eq('⌘K：不在 list.search 里的字段不匹配（酒店不搜目的地）', groupsOf(base({ query: '云南' })), ['线路/ok/5']);
eq(
  '⌘K：拼音首字母搜实体',
  searchGroups(base({ query: 'dyam' }))[0]?.rows.map((r) => r.action),
  ['open:hotel:h-amandayan'],
);
eq('⌘K：每组最多 5 条', searchGroups(base({ query: 'yn' }))[0]?.rows.length, 5);
eq('⌘K：页面与操作也按拼音匹配', groupsOf(base({ query: 'wg' })), ['操作/ok/1']);
{
  const g = searchGroups(base({ query: 'f0' }));
  eq(
    '⌘K：会话按短码匹配（不分大小写）',
    g.map((x) => `${x.title}:${x.rows.map((r) => r.action).join(',')}`),
    ['会话:conv:wecom:cust_F01,conv:wecom:cust_F02'],
  );
  eq('⌘K：会话组底写只搜最近100个', g[0]?.footer, '只搜最近100个会话');
  eq('⌘K：会话行的标签是两段', g[0]?.rows[0]?.label, ['企微客户', 'F01']);
}
eq('⌘K：会话不按标签匹配', groupsOf(base({ query: '企微' })), []);
eq('⌘K：匿名没有会话组', groupsOf(base({ query: 'f01', conversations: null })), []);
eq(
  '⌘K：分组顺序是页面 / 各实体 / 会话 / 操作',
  groupsOf(
    base({
      query: 'a',
      pages: [{ key: 'p', label: 'a页', action: 'p' }],
      actions: [{ key: 'x', label: 'a操作', action: 'x' }],
      entities: [
        { entity: PACK.entities[1]!, state: 'ok', items: [{ code: 'a-1', payload: { title: 'a线' } }] },
        { entity: PACK.entities[0]!, state: 'ok', items: [{ code: 'a-2', payload: { title: 'a店' } }] },
      ],
    }),
  ),
  ['页面/ok/1', '线路/ok/1', '酒店/ok/1', '会话/ok/1', '操作/ok/1'],
);
eq(
  '⌘K：还在取的组给一行骨架，取失败的组给一行出错，其他组照常',
  groupsOf(
    base({
      query: '贵州',
      entities: [
        { entity: PACK.entities[1]!, state: 'ok', items },
        { entity: PACK.entities[0]!, state: 'error', items: [] },
      ],
      conversations: { state: 'loading', rows: [], label: () => [], hint: () => '' },
    }),
  ),
  ['线路/ok/1', '酒店/error/0', '会话/loading/0'],
);
eq('⌘K：没有结果时一组都不剩（页面写「没有找到」）', groupsOf(base({ query: 'zzzz' })), []);
eq(
  '⌘K：可选的行按显示顺序排成一列',
  selectableRows(searchGroups(base({ query: 'f0' }))).map((r) => r.action),
  ['conv:wecom:cust_F01', 'conv:wecom:cust_F02'],
);

eq(
  '键盘：↑↓ 与 Enter',
  [paletteKey({ key: 'ArrowDown' }), paletteKey({ key: 'ArrowUp' }), paletteKey({ key: 'Enter' })],
  ['down', 'up', 'open'],
);
eq(
  '键盘：不响应不带修饰键的 J / K',
  [paletteKey({ key: 'j' }), paletteKey({ key: 'k' }), paletteKey({ key: 'J' }), paletteKey({ key: 'K' })],
  [null, null, null, null],
);
eq(
  '键盘：输入法组字时 Enter 不打开',
  [
    paletteKey({ key: 'Enter', isComposing: true }),
    paletteKey({ key: 'Enter', keyCode: 229 }),
    paletteKey({ key: 'ArrowDown', isComposing: true }),
  ],
  [null, null, null],
);
eq(
  '键盘：↓ 从头、↑ 从尾，首尾循环',
  [moveActive(-1, 3, 'down'), moveActive(-1, 3, 'up'), moveActive(2, 3, 'down'), moveActive(0, 3, 'up'), moveActive(0, 0, 'down')],
  [0, 2, 0, 2, -1],
);
const key = (k: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...m,
});
eq(
  '快捷键：Mac 只认 ⌘K（Ctrl+K 留给文本框删到行尾），单独的 K、带 Shift 或 Alt 的不算',
  [
    isPaletteShortcut(key('k', { metaKey: true }), true),
    isPaletteShortcut(key('K', { metaKey: true }), true),
    isPaletteShortcut(key('k', { ctrlKey: true }), true),
    isPaletteShortcut(key('k', { metaKey: true, ctrlKey: true }), true),
    isPaletteShortcut(key('k', {}), true),
    isPaletteShortcut(key('k', { metaKey: true, shiftKey: true }), true),
    isPaletteShortcut(key('k', { metaKey: true, altKey: true }), true),
    isPaletteShortcut(key('j', { metaKey: true }), true),
  ],
  [true, true, false, false, false, false, false, false],
);
eq(
  '快捷键：其余平台只认 Ctrl+K',
  [
    isPaletteShortcut(key('k', { ctrlKey: true }), false),
    isPaletteShortcut(key('K', { ctrlKey: true }), false),
    isPaletteShortcut(key('k', { metaKey: true }), false),
    isPaletteShortcut(key('k', { ctrlKey: true, shiftKey: true }), false),
    isPaletteShortcut(key('k', { ctrlKey: true, altKey: true }), false),
  ],
  [true, true, false, false, false],
);
check(
  '快捷键：别处已经处理过的按键（defaultPrevented）不打开',
  !isPaletteShortcut({ ...key('k', { metaKey: true }), defaultPrevented: true }, true) &&
    !isPaletteShortcut({ ...key('k', { ctrlKey: true }), defaultPrevented: true }, false),
);
eq(
  '快捷键：提示与 aria-keyshortcuts 按平台',
  [paletteShortcut(true), paletteShortcut(false)],
  [
    { label: '⌘K', aria: 'Meta+K' },
    { label: 'Ctrl+K', aria: 'Control+K' },
  ],
);

// ⌘K 打开时只取还没载入的：用真的 QueryObserver 与假 fetch 数请求。侧栏或列表页已经取过的列表，开多少次 ⌘K 都不再取
{
  const realFetch = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    hits.push(url.replace(/^.*\/api\/console/, ''));
    const body = url.includes('/catalog/') ? { items: [] } : { items: [], total: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  try {
    const qc = new QueryClient();
    qc.setQueryData(['catalog', 'route'], { items: [] });
    const route = new QueryObserver(qc, paletteListQuery(catalogKind('route'), false));
    const hotel = new QueryObserver(qc, paletteListQuery(catalogKind('hotel'), false));
    const conv = new QueryObserver(qc, paletteConversationsQuery(false));
    const offs = [route, hotel, conv].map((o) => o.subscribe(() => undefined));
    await settle();
    eq('⌘K 数据：关着时一个请求都不发', hits, []);
    const openAll = (open: boolean): void => {
      route.setOptions(paletteListQuery(catalogKind('route'), open));
      hotel.setOptions(paletteListQuery(catalogKind('hotel'), open));
      conv.setOptions(paletteConversationsQuery(open));
    };
    openAll(true);
    await settle();
    eq('⌘K 数据：第一次打开只取没载入的（酒店、最近会话），线路已在缓存里', hits.slice().sort(), [
      '/catalog/hotel',
      '/conversations?limit=100&order=waiting_first',
    ]);
    for (let i = 0; i < 3; i += 1) {
      openAll(false);
      openAll(true);
    }
    await settle();
    eq('⌘K 数据：马上再开三次，一个请求都不多发', hits.length, 2);
    await qc.invalidateQueries({ queryKey: ['catalog', 'route'] });
    await settle();
    check('⌘K 数据：列表页保存后作废的列表，⌘K 开着时照样重取', hits.includes('/catalog/route'), JSON.stringify(hits));
    for (const off of offs) off();
  } finally {
    globalThis.fetch = realFetch;
  }
}
eq(
  '条目取值：编号、嵌套路径、数组；原型上的名字取不到',
  [
    fieldText({ code: 'r-1', payload: {} }, '$code'),
    fieldText({ code: 'r-1', payload: { intensity: { level: '轻松' } } }, 'intensity.level'),
    fieldText({ code: 'r-1', payload: { tags: ['亲子', '银发', 3] } }, 'tags'),
    fieldText({ code: 'r-1', payload: {} }, 'toString'),
    fieldText({ code: 'r-1', payload: { a: { b: 1 } } }, 'a'),
  ],
  ['r-1', '轻松', '亲子 银发 3', '', ''],
);

// ---------------- 6. 画出来的页头与用户行 ----------------

function header(viewer: Viewer): string {
  const qc = new QueryClient();
  qc.setQueryData(VIEWER_KEY, viewer);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(PageHeader, { title: '销售话术' })));
}
const text = (html: string): string => html.replace(/<[^>]+>/g, '');
for (const r of ROLES) {
  const html = header({ kind: 'member', me: me(r), pack: PACK });
  const editor = r === 'owner' || r === 'admin';
  const pill = html.includes('readonly-pill');
  check(`页头：${r} ${editor ? '没有' : '有'}「只读」胶囊`, pill === !editor);
  check(`页头：${r} 没有演示横幅`, !html.includes('演示模式'));
}
{
  const html = header({ kind: 'member', me: me('agent'), pack: PACK });
  check('页头：只读胶囊的说明写出角色', html.includes('只读：你的角色是坐席，只能查看'), html);
  check('页头：只读胶囊是 Status 的中性胶囊', html.includes('status status-readonly') && text(html).includes('只读'));
  const anon = header({ kind: 'anon', pack: PACK });
  check(
    '页头：匿名有演示横幅，带「去体验对话」「登录后编辑」',
    ['演示模式', '只读：这里配置的销售话术和产品库', '去体验对话', '登录后编辑'].every((s) => text(anon).includes(s)),
    text(anon),
  );
  check('页头：演示横幅是 info，不是 warning', anon.includes('ant-alert-info') && !anon.includes('ant-alert-warning'));
  check('页头：匿名没有只读胶囊', !anon.includes('readonly-pill'));
  check('页头：标题是 h1', /<h1 class="page-title">销售话术<\/h1>/.test(header({ kind: 'member', me: me('owner'), pack: PACK })));
}
{
  const html = renderToStaticMarkup(createElement(UserNames, { name: '一二三四五六七', role: '所有者' }));
  check(
    '用户行：名字与角色都在 DOM 里（放不下时由 CSS 裁掉角色，读屏照样读到）',
    text(html) === '一二三四五六七所有者' && html.includes('user-role'),
    html,
  );
}

{
  // 租户行：成员有铃铛，匿名没有（spec「外壳 · 匿名 demo」）；收起时 logo 是 role="img"，名字是租户名
  const row = (viewer: ShellViewer, collapsed: boolean): string => {
    const qc = new QueryClient();
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TenantRow, { viewer, pack: PACK, collapsed, bellPlacement: 'rightTop' }),
      ),
    );
  };
  check('租户行：成员有铃铛', row(member('agent'), false).includes('aria-label="等人接手的会话"'));
  for (const collapsed of [false, true]) {
    const html = row(ANON, collapsed);
    check(`租户行：匿名没有铃铛（${collapsed ? '收起' : '展开'}）`, !html.includes('等人接手') && !html.includes('bell'), html);
  }
  check('租户行：匿名写「演示」', text(row(ANON, false)).includes('演示'));
  check('租户行：收起时 logo 是有名字的图', row(member('owner'), true).includes('role="img" tabindex="0" aria-label="云途定制旅行"'));
}
{
  // 用户按钮收起时名字、角色都不画（display:none），读屏靠 aria-label 读出「名字，角色」
  const html = renderToStaticMarkup(
    createElement(UserMenu, { me: me('supervisor', '小林'), collapsed: true, onAbout: () => undefined, onSignOut: () => undefined }),
  );
  check('用户行：用户按钮的名字是「名字，角色」', html.includes('aria-label="小林，主管"') && html.includes('aria-haspopup="menu"'), html);
  const items = (a: 'light' | 'dark' | 'system', reduce: boolean) => userMenuItems({ appearance: a, reduce });
  const attrs = (it: unknown): unknown => {
    const o = it as Record<string, unknown>;
    return [o.key, o.role ?? null, o['aria-checked'] ?? null];
  };
  const appearanceOf = (list: ReturnType<typeof items>): unknown[] => ((list[0] as { children?: unknown[] }).children ?? []).map(attrs);
  eq('用户菜单：外观三项是 menuitemradio，当前项 aria-checked', appearanceOf(items('dark', false)), [
    ['appearance:light', 'menuitemradio', false],
    ['appearance:dark', 'menuitemradio', true],
    ['appearance:system', 'menuitemradio', false],
  ]);
  eq(
    '用户菜单：减少动态效果是 menuitemcheckbox，开关状态在 aria-checked 里',
    [attrs(items('light', false)[1]), attrs(items('light', true)[1])],
    [
      ['reduce-motion', 'menuitemcheckbox', false],
      ['reduce-motion', 'menuitemcheckbox', true],
    ],
  );
}

// 产品库的一条与新建（plan 第 10.1 步）：选中的都是这一类实体，恰好一个（不变量 23）
{
  const nav = buildNav(PACK, member('owner'));
  const cases: Array<[string, string | null]> = [
    ['/console/catalog/route/r-sichuan-lux', '/catalog/route'],
    ['/console/catalog/new/route', '/catalog/route'],
    ['/console/catalog/new/hotel', '/catalog/hotel'],
    ['/catalog/new/hotel', '/catalog/hotel'],
    ['/console/catalog/new/package', null],
    ['/console/catalog/new', null],
  ];
  for (const [path, want] of cases) eq(`选中项：${path}`, selectedNavKey(path, nav), want);
}

// ---------------- 7. 事件流（shell/live.ts）与桌面提醒（notifications.ts，02 spec「通知」） ----------------

eq(
  '标签页标题前缀：N 为 0、没取到、负数、非数都没有前缀；N>0 写「(N) 」（不变量 45）',
  [0, undefined, -1, Number.NaN, 1, 23].map(tabTitlePrefix),
  ['', '', '', '', '(1) ', '(23) '],
);
eq('J 页路径：/conversations/$id，$id 经 encodeURIComponent', workbenchPath('wecom:cust F01'), '/conversations/wecom%3Acust%20F01');

eq('live：初始状态没连、不轮询', INITIAL_LIVE, { connected: false, polling: false });
eq('live：连上立刻停轮询', onOpen(), { connected: true, polling: false });
eq(
  'live：断线只改连接状态，轮询状态不变（由计时器到期才决定）',
  [onClose({ connected: true, polling: false }), onClose({ connected: true, polling: true })],
  [
    { connected: false, polling: false },
    { connected: false, polling: true },
  ],
);
eq(
  'live：断线满宽限退回轮询；已经重连上的这一条不生效',
  [onGraceExpired({ connected: false, polling: false }), onGraceExpired({ connected: true, polling: false })],
  [
    { connected: false, polling: true },
    { connected: true, polling: false },
  ],
);
eq('live：断线超过 30 秒退回轮询（spec「通知」）', GRACE_MS, 30_000);

{
  // startLiveEvents 的接线：假 EventSource（EventTarget 子类），手动派发 open / error / 命名事件，看模块状态与副作用。
  // graceMs 给很小的数（20ms），不用真的等 30 秒
  class FakeSource extends EventTarget implements EventSourceLike {
    closed = false;
    close(): void {
      this.closed = true;
    }
  }
  const sources: FakeSource[] = [];
  const createEventSource = (url: string): EventSourceLike => {
    check('live：接的地址是 /api/console/events', url === '/api/console/events', url);
    const s = new FakeSource();
    sources.push(s);
    return s;
  };
  const send = (s: FakeSource, type: string, data?: unknown): void => {
    const ev = Object.assign(new Event(type), { data: JSON.stringify(data ?? {}) });
    s.dispatchEvent(ev);
  };

  const qc = new QueryClient();
  const notified: unknown[] = [];
  const stop = startLiveEvents({ qc, onNotify: (d) => notified.push(d), graceMs: 20, createEventSource });
  const s = sources[0]!;
  check('live：一上来还没连，不轮询（还在宽限内）', !__liveTest.get().connected && !__liveTest.get().polling);

  send(s, 'open');
  check('live：open 事件之后连上、不轮询', __liveTest.get().connected && !__liveTest.get().polling);

  send(s, 'error');
  check('live：error 事件之后断线，轮询状态还没变（没到宽限）', !__liveTest.get().connected && !__liveTest.get().polling);
  // 真实 Chromium 复验带出的细节：react-query 的 refetchInterval 从「现在」起才等一整个间隔，刚退回轮询那一刻
  // 不补一次的话，第一次真的轮询请求要等到宽限之后再等一整个 30 秒（约 60 秒），不是宽限那 30 秒
  qc.setQueryData(['conversations', 'human'], { items: [], total: 0 });
  await new Promise((r) => setTimeout(r, 60));
  check('live：断线满宽限（20ms）退回轮询', !__liveTest.get().connected && __liveTest.get().polling);
  check(
    'live：刚退回轮询那一刻顺手补一次重取，不用等 refetchInterval 的第一个整间隔',
    qc.getQueryState(['conversations', 'human'])?.isInvalidated === true,
  );

  send(s, 'open');
  check('live：重连立刻停轮询', __liveTest.get().connected && !__liveTest.get().polling);

  // counts：直接写进 React Query 缓存，不用等 refetch
  const COUNTS_SAMPLE = { total: 1, byState: { ai: 0, human: 1, assigned: 0, paid: 0 }, aiByStage: {}, updatedToday: 1 };
  send(s, 'counts', COUNTS_SAMPLE);
  eq('live：counts 事件直接写进 React Query 缓存', qc.getQueryData(['conversations', 'counts']), COUNTS_SAMPLE);

  // 其余具名事件：让 conversations 开头的查询失效（铃铛的等人接手列表、I 页的列表都跟着重取）
  qc.setQueryData(['conversations', 'human'], { items: [], total: 0 });
  const invalidated = () => qc.getQueryState(['conversations', 'human'])?.isInvalidated === true;
  check('live：handoff 事件之前，human 查询不是 invalidated', !invalidated());
  send(s, 'handoff', {
    id: 'wecom:cust_X01',
    kind: 'request',
    at: new Date().toISOString(),
    escalated: false,
    paidCustomer: false,
    assigned: false,
  });
  check('live：handoff 事件让 conversations 开头的查询失效', invalidated());
  eq('live：handoff 事件（assigned 为假）转给 onNotify（标题、授权、点击打开 J 页由调用方决定，这个模块只转发）', notified.length, 1);

  // 审查第 2 条（minor）：assigned 为真（顾问自己点「接手」触发的那一次）不弹浏览器通知，铃铛与计数照旧更新
  qc.setQueryData(['conversations', 'human'], { items: [], total: 0 });
  send(s, 'handoff', {
    id: 'wecom:cust_X02',
    kind: 'agent',
    at: new Date().toISOString(),
    escalated: false,
    paidCustomer: false,
    assigned: true,
  });
  check('live：assigned 为真时仍让查询失效（铃铛与计数照旧更新）', invalidated());
  eq('live：assigned 为真时不转给 onNotify（不弹浏览器通知）', notified.length, 1);

  qc.setQueryData(['conversations', 'human'], { items: [], total: 0 });
  send(s, 'resync');
  check('live：resync 事件同样整体重取', invalidated());

  // auth：关闭连接、与退出登录同一套——离开成员身份、清掉除 viewer 外的查询缓存
  qc.setQueryData(VIEWER_KEY, { kind: 'member' });
  qc.setQueryData(['sop'], { x: 1 });
  send(s, 'auth');
  check('live：auth 事件关闭连接', s.closed);
  check('live：auth 事件清掉除 viewer 外的查询（回登录页靠 viewer 重取判定）', qc.getQueryData(['sop']) === undefined);

  stop();
  __liveTest.reset();
}

{
  // 审查第 1 条（blocker，真实 Chromium 复现）：真实浏览器的 EventSource 断线后约每 3 秒自动重连一次，每次失败
  // 都触发 error；如果每次都重排宽限计时器，30 秒倒计时永远被拨回起点，onGraceExpired 永远不触发——持续 70 秒
  // 只看到 /events 每 3 秒重试，counts 与列表从没退回轮询。这里按比例缩小：graceMs 100ms，每 20ms 发一次 error，
  // 连续 7 次（140ms，超过宽限），断言宽限到点仍退回轮询，不是被一直拨回起点
  class FakeSource2 extends EventTarget implements EventSourceLike {
    closed = false;
    close(): void {
      this.closed = true;
    }
  }
  let src2: FakeSource2 | null = null;
  const createEventSource2 = (_url: string): EventSourceLike => {
    src2 = new FakeSource2();
    return src2;
  };
  const qc2 = new QueryClient();
  const stop2 = startLiveEvents({ qc: qc2, onNotify: () => undefined, graceMs: 100, createEventSource: createEventSource2 });
  for (let i = 0; i < 7; i += 1) {
    src2!.dispatchEvent(new Event('error'));
    await new Promise((r) => setTimeout(r, 20));
  }
  check(
    'live：连续多次 error（模拟真实重连节奏）不会把宽限拨回起点，到点仍退回轮询',
    !__liveTest.get().connected && __liveTest.get().polling,
  );
  src2!.dispatchEvent(new Event('open'));
  check('live：退回轮询之后重连，立刻停轮询', __liveTest.get().connected && !__liveTest.get().polling);
  stop2();
  __liveTest.reset();
}

{
  // 桌面提醒（notifications.ts）：没有 Notification API 时算 unsupported；授权只在点了才申请
  const realNotification = (globalThis as { Notification?: unknown }).Notification;
  delete (globalThis as { Notification?: unknown }).Notification;
  eq('通知：没有 Notification API 时是 unsupported', notificationPermission(), 'unsupported');
  eq('通知：不支持时申请也只回 unsupported，不报错', await requestNotificationPermission(), 'unsupported');
  check(
    '通知：不支持时 notifyHandoff 什么都不做',
    notifyHandoff({ id: 'x', kind: 'request', at: '', escalated: false, paidCustomer: false, assigned: false }, PACK, () => undefined) ===
      null,
  );

  // 假的 Notification：记下构造参数与 permission、申请授权被调了几次，模拟已授权、已拒绝两种
  class FakeNotification extends EventTarget {
    static permission: NotificationPermission = 'default';
    static requestCount = 0;
    static requestPermission = async (): Promise<NotificationPermission> => {
      FakeNotification.requestCount += 1;
      return FakeNotification.permission;
    };
    title: string;
    options: NotificationOptions | undefined;
    constructor(title: string, options?: NotificationOptions) {
      super();
      this.title = title;
      this.options = options;
    }
    close(): void {}
  }
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;

  // 铃铛弹层只在用户点「开启桌面提醒」时才申请授权（spec「通知」）：光画出铃铛（哪怕弹层开着、permission 还是
  // default）不该申请；画 Bell 只测初始渲染，真的点击在 happy-dom 的 conversations/conversations.selftest.tsx
  // 已经间接盖住铃铛同一套交互模式，这里单独确认「不画就不申请」这条底线
  {
    const qc = new QueryClient();
    FakeNotification.requestCount = 0;
    renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Bell, { pack: PACK, placement: 'rightTop' })));
    eq('通知：画出铃铛不会自动申请授权，只有点「开启桌面提醒」才申请', FakeNotification.requestCount, 0);
  }

  FakeNotification.permission = 'denied';
  check(
    '通知：被拒绝时 notifyHandoff 什么都不做',
    notifyHandoff({ id: 'x', kind: 'request', at: '', escalated: false, paidCustomer: false, assigned: false }, PACK, () => undefined) ===
      null,
  );

  FakeNotification.permission = 'granted';
  let openedId: string | null = null;
  const n = notifyHandoff(
    { id: 'wecom:cust_7F3A', kind: 'complaint', at: '', escalated: false, paidCustomer: false, assigned: false },
    PACK,
    (id) => (openedId = id),
  ) as unknown as FakeNotification;
  eq(
    '通知：标题是「渠道+客户 · 短码 等人接手」，正文是类型的中文，tag 是 handoff:<id>，不含客户原话',
    [n.title, n.options?.body, n.options?.tag],
    ['企微客户 · 7F3A 等人接手', '客户要投诉', 'handoff:wecom:cust_7F3A'],
  );
  n.dispatchEvent(new Event('click'));
  eq('通知：点击打开对应会话的 J 页', openedId, 'wecom:cust_7F3A');

  FakeNotification.permission = 'granted';
  eq(
    '通知：紧急情况与已成交客户要人工的标题写法',
    [
      notifyHandoff(
        { id: 'wecom:cust_A1', kind: 'emergency', at: '', escalated: true, paidCustomer: false, assigned: false },
        PACK,
        () => undefined,
      ),
      notifyHandoff(
        { id: 'wecom:cust_A2', kind: 'request', at: '', escalated: false, paidCustomer: true, assigned: false },
        PACK,
        () => undefined,
      ),
    ].map((x) => (x as unknown as FakeNotification).title),
    ['紧急 · 企微客户 · A1', '已成交客户要人工 · 企微客户 · A2'],
  );

  if (realNotification === undefined) delete (globalThis as { Notification?: unknown }).Notification;
  else (globalThis as { Notification?: unknown }).Notification = realNotification;
}

if (fails.length) {
  console.error(`shell: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`shell: ${pass} 条断言全部通过`);
