// 错误文案与通用部件（console UX spec「通用部件」、不变量 6、8）：
// 1. ERROR_COPY 与 spec 的表逐条相同（标题、下一步、颜色、形式），多一条少一条都算失败；N 换成真实的数；
//    表里没有的 error 用兜底，网络失败与表里没有的 5xx 是「服务暂时连不上」；
// 2. 画出来的 ErrorAlert、StateView 里，服务端的 detail 只在折叠的「技术详情」（<details>）里；
//    出错是「没取到」加文案，中性的错误不画红色；有回调才画按钮；路由接住的错误里，页面块没取到算连不上，
//    页面渲染时抛的错走兜底（RouteError）；
// 3. Status 每种状态是圆点加一个固定的词，不出现四种会话状态之外的叫法。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/parts/errors.selftest.ts（要按 react-jsx 编译 .tsx）
import { ConfigProvider } from 'antd';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiError } from '../../../src/shared/console-api.js';
import { HttpError } from '../api.js';
import { ErrorAlert } from './ErrorAlert.js';
import { ERROR_COPY, errorCopy, isChunkLoadError, PageCrash } from './errors.js';
import { PageSkeleton, RouteError, StateView } from './StateView.js';
import { Status, STATUS_LABEL, type StatusKind } from './Status.js';
import { TechDetails } from './TechDetails.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}

/** 服务端 detail 的哨兵：只准出现在技术详情里 */
const SENTINEL = '服务端原文ZQX';
const err = (status: number, body: Omit<ApiError, 'detail'>): HttpError => new HttpError(status, { ...body, detail: SENTINEL });

// ---------------- 1. 与 spec 的表逐条相同 ----------------
// [error, 状态码, 标题, 下一步, 颜色, 形式]；照抄 spec「错误文案（ERROR_COPY）」，外加登录失败一条（spec 顶部 Revisions）
const SPEC: ReadonlyArray<readonly [string, number, string, string | null, string, string]> = [
  ['unauthorized', 401, '登录已过期', '重新登录后接着刚才的操作', 'neutral', 'relogin'],
  ['forbidden', 403, '你的角色无法执行这项操作', '需要所有者或管理员', 'caution', 'page'],
  ['csrf', 403, '页面已过期', '刷新后重试', 'danger', 'page'],
  ['cross_site', 403, '页面已过期', '刷新后重试', 'danger', 'page'],
  ['rev_conflict', 409, '别人刚改过这里', '载入最新内容（你的改动以对比形式保留）', 'danger', 'banner'],
  ['sop_conflict', 409, '有0节在你改的同时被改了', '去合并', 'danger', 'banner'],
  ['catalog_code_taken', 409, '这个编号已经有了', '换一个', 'danger', 'field'],
  ['contract', 422, '有0处需要改', '点一处跳过去', 'danger', 'checklist'],
  ['locked_field', 422, '这些内容上架后锁定了', null, 'danger', 'page'],
  ['invalid_item', 422, '有0处要改', null, 'danger', 'field'],
  ['invalid_csv', 422, '有0处要改', null, 'danger', 'field'],
  ['invalid_sop', 422, '无法保存这份话术：格式不对', '撤回刚才的改动再试', 'danger', 'banner'],
  ['locked_section', 422, '固定规则节不能改', '撤回这一节的改动', 'danger', 'banner'],
  ['not_found', 404, '没有这项内容：可能已被删除或地址写错了', '回到列表', 'neutral', 'whole'],
  // 02 spec「后台接口」新错误码，第 19 步先接住 J 页占位用到的这一个
  ['conversation_not_found', 404, '这个会话已经不在了', '回到列表', 'neutral', 'whole'],
  // 02 第 20.2 步加的其余几个（接手、交还、人工回复、订单动作；assignedName／status 没传时按兜底文案算）
  ['assigned_to_other', 409, '别人正在处理这个会话', null, 'neutral', 'inline'],
  ['not_assignee', 409, '只有接手人本人能做这件事', null, 'caution', 'inline'],
  ['consent_declined', 409, '客户没有同意，不能交给AI', null, 'neutral', 'inline'],
  ['send_window_closed', 409, '企微超过48小时没有新消息，这条发不出去了', null, 'caution', 'inline'],
  ['send_quota_exhausted', 409, '这一轮已经发满5条，等客户回复后才能再发', null, 'caution', 'inline'],
  ['order_state', 409, '这个操作对当前订单状态不适用', null, 'caution', 'inline'],
  ['store_file_mode', 503, '这项内容只在数据库模式下可用', null, 'neutral', 'inline'],
  ['store_lagging', 503, '已生效，记录稍后保存', null, 'neutral', 'inline'],
  ['conflict', 409, '刚才有人同时在改', '刷新后重来', 'danger', 'banner'],
  ['bad_request', 400, '无法完成这项操作', '刷新页面后重试', 'danger', 'page'],
  ['unsupported_media_type', 415, '无法完成这项操作', '刷新页面后重试', 'danger', 'page'],
  ['rate_limited', 429, '尝试太频繁', '稍后再试', 'danger', 'form'],
  ['busy', 429, '尝试太频繁', '稍后再试', 'danger', 'form'],
  ['lock_lost', 503, '暂时无法保存：系统在重连数据库，线上内容不受影响', '稍后重试', 'danger', 'banner'],
  ['not_ready', 503, '系统正在启动', '重试', 'neutral', 'inline'],
  ['db_disabled', 503, '后台只在数据库模式下可用', null, 'neutral', 'whole'],
  ['invalid_credentials', 401, '邮箱或密码不对', '检查后重试', 'danger', 'form'],
];

for (const [code, status, title, next, tone, place] of SPEC) {
  const c = errorCopy(err(status, { error: code }));
  check(`ERROR_COPY ${code}`, c.title === title && c.next === next && c.tone === tone && c.place === place, JSON.stringify(c));
  check(`ERROR_COPY ${code}：不拼服务端的 detail`, !`${c.title}${c.next ?? ''}`.includes(SENTINEL));
}
const specCodes = new Set(SPEC.map((r) => r[0]));
const extra = Object.keys(ERROR_COPY).filter((k) => !specCodes.has(k));
const missing = [...specCodes].filter((k) => !Object.hasOwn(ERROR_COPY, k));
check('ERROR_COPY 与 spec 的表一条不多、一条不少', !extra.length && !missing.length, `多 ${extra.join(',')}；少 ${missing.join(',')}`);

check('sop_conflict：N 是冲突的节数', errorCopy(err(409, { error: 'sop_conflict', keys: ['a', 'b'] })).title === '有2节在你改的同时被改了');
check(
  'contract：N 是违规条数',
  errorCopy(
    err(422, {
      error: 'contract',
      violations: [1, 2, 3].map(() => ({ code: 'structure' as const, sectionKey: null, detail: SENTINEL })),
    }),
  ).title === '有3处需要改',
);
check(
  'invalid_item：N 是问题条数',
  errorCopy(
    err(422, {
      error: 'invalid_item',
      issues: [
        { path: 'a', message: 'x' },
        { path: 'b', message: 'y' },
      ],
    }),
  ).title === '有2处要改',
);
check(
  'invalid_csv：N 是各行问题之和',
  errorCopy(
    err(422, {
      error: 'invalid_csv',
      rows: [
        { row: 1, issues: [{ path: 'a', message: 'x' }] },
        {
          row: 3,
          issues: [
            { path: 'b', message: 'y' },
            { path: 'c', message: 'z' },
          ],
        },
      ],
    }),
  ).title === '有3处要改',
);
const LABELS: Record<string, string> = { priceFrom: '每人起价', days: '天数' };
check(
  'locked_field：给了字段名表就列出中文字段名',
  errorCopy(err(422, { error: 'locked_field', fields: ['priceFrom', 'days'] }), { fieldLabel: (k) => LABELS[k] ?? k }).title ===
    '这些内容上架后锁定了：每人起价、天数',
);

const fallback = errorCopy(err(418, { error: 'teapot' }));
check(
  '表里没有的 error：兜底「无法完成这项操作 · 重试」',
  fallback.title === '无法完成这项操作' && fallback.next === '重试' && fallback.tone === 'danger',
);
check('原型链上的名字不算表里有（toString）', errorCopy(err(400, { error: 'toString' })).title === '无法完成这项操作');
for (const [name, e] of [
  ['500 internal', err(500, { error: 'internal' })],
  ['502 读不出响应体', new HttpError(502, { error: 'bad_response' })],
  ['fetch 连不上（TypeError）', new TypeError('Failed to fetch')],
] as const) {
  const c = errorCopy(e);
  check(`网络失败与 5xx（${name}）：「服务暂时连不上 · 重试」`, c.title === '服务暂时连不上' && c.next === '重试' && c.tone === 'danger');
}
check('别的异常：兜底', errorCopy(new Error('boom')).title === '无法完成这项操作');

// ---------------- 2. 画出来的样子 ----------------
// 按钮照全站的配置不在两个汉字之间插空格（ThemeProvider 要读 document，这里只取这一项）
const html = (el: ReactElement): string => renderToStaticMarkup(createElement(ConfigProvider, { button: { autoInsertSpace: false } }, el));
/** 去掉 <details>…</details>，剩下的就是默认看得见的部分 */
const outsideDetails = (s: string): string => s.replace(/<details[\s\S]*?<\/details>/g, '');

const conflict = err(409, { error: 'rev_conflict' });
const a = html(createElement(ErrorAlert, { error: conflict, onReload: () => undefined }));
check('ErrorAlert：detail 只在技术详情里', a.includes(SENTINEL) && !outsideDetails(a).includes(SENTINEL), a.slice(0, 300));
check('ErrorAlert：技术详情默认折叠，写着状态码与原码', /<details(?![^>]*\bopen)[^>]*>/.test(a) && a.includes('HTTP 409 · rev_conflict'));
check('ErrorAlert：文案与按钮', a.includes('别人刚改过这里') && a.includes('ant-alert-error') && a.includes('载入最新内容</'));
const noHandler = html(createElement(ErrorAlert, { error: conflict }));
check('ErrorAlert：没给回调就不画按钮', !noHandler.includes('<button type="button" class="ant-btn'));

const loadFailed = html(createElement(StateView, { error: new TypeError('Failed to fetch'), onRetry: () => undefined }));
check(
  'StateView 出错：「没取到」加文案，重试按钮',
  loadFailed.includes('没取到') &&
    loadFailed.includes('服务暂时连不上') &&
    loadFailed.includes('重试') &&
    loadFailed.includes('ant-alert-error'),
);
const neutral = html(createElement(StateView, { error: err(503, { error: 'not_ready' }), onRetry: () => undefined }));
check(
  'StateView 中性的错误：不画红色、不写「没取到」',
  neutral.includes('系统正在启动') && neutral.includes('重试') && !neutral.includes('没取到') && !neutral.includes('ant-alert'),
);
check('StateView 中性的错误：detail 也只在技术详情里', !outsideDetails(neutral).includes(SENTINEL));
const forbidden = html(createElement(StateView, { error: err(403, { error: 'forbidden' }) }));
check('StateView 留意：warning 色，写明下一步', forbidden.includes('ant-alert-warning') && forbidden.includes('需要所有者或管理员'));
const loading = html(createElement(StateView, { pending: true }));
check('StateView 加载：骨架，不转圈', loading.includes('state-skeleton') && !loading.includes('ant-spin'));
check('StateView 空：替换整块内容', html(createElement(StateView, { empty: { title: '还没有线路' } }, 'X')).includes('还没有线路'));
check('TechDetails：没东西可列时不画', html(createElement(TechDetails, {})) === '');

// 路由接住的错误（router.tsx 的 defaultErrorComponent，第 2.4 步）：页面块没取到是「没取到 · 服务暂时连不上」；
// 页面渲染时抛的错（哪怕是 TypeError）是兜底「无法完成这项操作」，不写「没取到」、不说连不上，原来的类型与消息在技术详情里
const CHUNK_ERRORS: ReadonlyArray<readonly [string, Error]> = [
  ['Chromium', new TypeError('Failed to fetch dynamically imported module: https://x.test/console/assets/audit.lazy-AbCd1234.js')],
  ['Firefox', new TypeError('error loading dynamically imported module: https://x.test/console/assets/audit.lazy-AbCd1234.js')],
  ['WebKit', new TypeError('Importing a module script failed.')],
  ['vite 预载 CSS', new Error('Unable to preload CSS for /console/assets/audit.lazy-AbCd1234.css')],
];
for (const [name, e] of CHUNK_ERRORS) {
  check(`页面块没取到（${name}）：认得出来`, isChunkLoadError(e));
  check(`页面块没取到（${name}）：「服务暂时连不上」`, errorCopy(e).title === '服务暂时连不上');
  const v = outsideDetails(html(createElement(RouteError, { error: e, onRetry: () => undefined })));
  check(
    `路由出错，页面块没取到（${name}）：「没取到 · 服务暂时连不上」加重试`,
    v.includes('没取到') && v.includes('服务暂时连不上') && v.includes('重试'),
    v,
  );
}
const CRASH = "Cannot read properties of undefined (reading 'rows')";
for (const [name, e] of [
  ['TypeError', new TypeError(CRASH)],
  ['Error', new Error('boom')],
  ['抛出的不是 Error', 'boom'],
] as const) {
  check(`渲染时抛错（${name}）：不当成页面块没取到`, !isChunkLoadError(e));
  const r = html(createElement(RouteError, { error: e, onRetry: () => undefined }));
  const v = outsideDetails(r);
  check(
    `路由出错，渲染时抛错（${name}）：兜底「无法完成这项操作」加重试，不写「没取到」和「服务暂时连不上」`,
    v.includes('无法完成这项操作') &&
      v.includes('重试') &&
      v.includes('ant-alert-error') &&
      !v.includes('没取到') &&
      !v.includes('服务暂时连不上'),
    v,
  );
}
const crash = html(createElement(RouteError, { error: new TypeError(CRASH), onRetry: () => undefined }));
check('路由出错，渲染时抛错：技术详情里是原来的类型与消息', crash.includes(`TypeError: ${CRASH.replace(/'/g, '&#x27;')}`), crash);
check('PageCrash：文案走兜底', errorCopy(new PageCrash(new TypeError(CRASH))).title === '无法完成这项操作');
const httpInRoute = outsideDetails(html(createElement(RouteError, { error: err(503, { error: 'not_ready' }), onRetry: () => undefined })));
check(
  '路由出错，接口的错误：照 ERROR_COPY',
  httpInRoute.includes('系统正在启动') && !httpInRoute.includes('无法完成这项操作'),
  httpInRoute,
);
const pageSkeleton = html(createElement(PageSkeleton));
check(
  'PageSkeleton：页头一行加表格 8 行',
  (pageSkeleton.match(/class="skeleton-page-title"/g) ?? []).length === 1 &&
    (pageSkeleton.match(/class="skeleton-row"/g) ?? []).length === 8,
  pageSkeleton,
);

// ---------------- 3. Status ----------------
for (const kind of Object.keys(STATUS_LABEL) as StatusKind[]) {
  const s = html(createElement(Status, { kind }));
  check(`Status ${kind}：圆点加「${STATUS_LABEL[kind]}」`, s.includes('status-dot') && s.includes(STATUS_LABEL[kind]));
}
// 02 spec R12 加了第四态「顾问处理中」（assigned）：会话状态恰是这四种叫法
check(
  'Status：会话状态恰是 AI接待中、等人接手、顾问处理中、已成交，之外的叫法一个都没有',
  [STATUS_LABEL.ai, STATUS_LABEL.human, STATUS_LABEL.assigned, STATUS_LABEL.paid].join() === 'AI接待中,等人接手,顾问处理中,已成交' &&
    !Object.values(STATUS_LABEL).some((l) => ['待人工', '已转人工', '待接管', '需要介入'].includes(l)),
);

if (fails.length) {
  console.error(`parts: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`parts: ${pass} 条断言全部通过`);
