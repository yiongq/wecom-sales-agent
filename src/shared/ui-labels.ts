// 界面自己的固定文案（docs/features/console-ux/spec.md「通用部件 · 错误文案」「审计日志」，设计系统 §5.17、§11）：
// 话术检查项名、角色、审计动作（中文、分组、图标名）、错误文案。前后端共用，不依赖 React。
// 行业相关的词（实体名、字段名、阶段名、客户的叫法）不在这里，都来自行业包（src/shared/pack.ts）。
// 这里的字符串会显示在后台上，也是 UI 优先片的用字来源（scripts/fonts/ui-text.ts）：改了文案要重跑 scripts/fonts/build.ts。
import type { ApiError, Role, ViolationCode } from './console-api.js';
import type { IndustryPack } from './pack.js';

// ---------------- 角色 ----------------

/** 角色的中文名：用户行、用户菜单、「只读」胶囊的说明、审计句子 */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: '所有者',
  admin: '管理员',
  supervisor: '主管',
  agent: '坐席',
  viewer: '只读',
};

/** 取角色的中文名；审计 diff 里的角色是库里的原文，认不出时写「其他角色」，不把英文原码显示出来 */
export const roleLabel = (role: unknown): string =>
  typeof role === 'string' && Object.hasOwn(ROLE_LABEL, role) ? ROLE_LABEL[role as Role] : '其他角色';

// ---------------- 话术检查项 ----------------

/** 发布前检查的 7 项，名字固定，与 ViolationCode 一一对应，按这个顺序列（设计系统 §5.17） */
export const SOP_CHECK_LABEL: Readonly<Record<ViolationCode, string>> = {
  structure: '结构完整',
  locked_changed: '固定规则节没改',
  phrase_missing: '必备短语都在',
  phrase_forbidden: '没有禁用短语',
  unknown_tool: '工具名都存在',
  unknown_field: '字段名都存在',
  over_budget: '字数在额度内',
};

/** 按显示顺序排好的检查项 */
export const SOP_CHECKS = Object.entries(SOP_CHECK_LABEL) as ReadonlyArray<readonly [ViolationCode, string]>;

// ---------------- 审计动作 ----------------

/** 审计页的类别（spec「审计日志 · 筛选」）；「全部」不是类别 */
export type AuditGroup = 'sop' | 'catalog' | 'account' | 'platform';

/**
 * 审计页的类别与名字，按显示顺序。产品库那一类的名字取行业包的 nav.catalogGroup，与侧栏的分组名相同
 * （旅游包是「产品库」，spec K 页照旅游包写）；其余几类是界面自己的词
 */
export function auditGroups(pack: Pick<IndustryPack, 'nav'>): ReadonlyArray<{ key: AuditGroup | 'all'; label: string }> {
  return [
    { key: 'all', label: '全部' },
    { key: 'sop', label: '销售话术' },
    { key: 'catalog', label: pack.nav.catalogGroup },
    { key: 'account', label: '账号与登录' },
    { key: 'platform', label: '平台与配置' },
  ];
}

export interface AuditActionDef {
  /** 动作的中文，如「发布话术」：详情抽屉、筛选这类要单独说出动作的地方。句子由 describeAudit 生成 */
  label: string;
  group: AuditGroup;
  /** lucide 名称 */
  icon: string;
  /** 登录记录：「显示登录记录」关着时不列（spec「审计日志 · 筛选」） */
  login?: true;
}

/**
 * 系统里写审计的全部动作（src/ 下 writeAudit 的 action）。动作编码只进技术详情，页面上写 label 或 describeAudit 的句子
 * （不变量 7）。新加一种动作而这里没有时，describeAudit 兜底为「{操作者} 执行了一项操作」。
 * 顺序照原来审计页的动作下拉（第 14 步换成类别筛选之前，下拉按这里的顺序列）。图标不取设计系统 §7 的实体图标集合里的名字
 */
export const AUDIT_ACTIONS: Readonly<Record<string, AuditActionDef>> = {
  'sop.publish': { label: '发布话术', group: 'sop', icon: 'message-square-text' },
  'sop.rollback': { label: '回滚话术', group: 'sop', icon: 'undo-2' },
  'sop.discard': { label: '丢弃话术草稿', group: 'sop', icon: 'trash-2' },
  'sop.rerender': { label: '重新生成话术', group: 'sop', icon: 'refresh-cw' },
  'catalog.create': { label: '新建草稿', group: 'catalog', icon: 'plus' },
  'catalog.update': { label: '修改', group: 'catalog', icon: 'pencil-line' },
  'catalog.activate': { label: '上架', group: 'catalog', icon: 'circle-check' },
  'catalog.locked_fix': { label: '修正锁定内容', group: 'catalog', icon: 'lock' },
  'auth.login': { label: '登录', group: 'account', icon: 'log-in', login: true },
  'auth.logout': { label: '退出登录', group: 'account', icon: 'log-out', login: true },
  'config.import': { label: '导入初始配置', group: 'platform', icon: 'download' },
  'platform.tenant_create': { label: '建租户', group: 'platform', icon: 'building' },
  'platform.user_create': { label: '建账号', group: 'account', icon: 'user-plus' },
  'platform.user_password': { label: '重设密码', group: 'account', icon: 'key-round' },
  'platform.user_disable': { label: '停用账号', group: 'account', icon: 'user-x' },
  'platform.member_role': { label: '改角色', group: 'account', icon: 'user-cog' },
  'platform.member_remove': { label: '移出租户', group: 'account', icon: 'user-minus' },
};

/** 这个动作的定义；表里没有（以后新增的动作）时是 null。只认自有属性，toString 这类原型上的名字查不到 */
export const auditAction = (action: string): AuditActionDef | null =>
  Object.hasOwn(AUDIT_ACTIONS, action) ? AUDIT_ACTIONS[action]! : null;

/**
 * 审计页的类别和「显示登录记录」换算成 `AuditQuery.actions`（逗号分隔）。「全部」且显示登录记录时不过滤（undefined），
 * 这样表里还没有的新动作也列得出来；其余情况只列表里的动作
 */
export function auditActionsParam(group: AuditGroup | 'all', showLogin: boolean): string | undefined {
  if (group === 'all' && showLogin) return undefined;
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, d]) => (group === 'all' || d.group === group) && (showLogin || !d.login))
    .map(([action]) => action)
    .join(',');
}

/** 非人操作者的名字（设计系统 §11：写「命令行」，不写 import-config、user-create 这类命令名） */
export const ACTOR_KIND_LABEL: Readonly<Record<'system' | 'platform', string>> = { system: '系统', platform: '命令行' };

/** 启动重渲染的原因（sop.rerender 的 diff.causes，src/config/source.ts 的 CAUSE） */
export const RERENDER_CAUSE_LABEL: Readonly<Record<string, string>> = {
  hard_rules: '固定要求',
  locked_sections: '固定规则节',
  section_table: '话术分节',
  tools: '工具定义',
};

// ---------------- 错误文案 ----------------

/** spec 表里的「颜色」：中性 / 留意 / 出错 */
export type ErrorTone = 'neutral' | 'caution' | 'danger';

/** spec 表里的「形式」：显示在哪。页面按它放；ErrorAlert 与 StateView 只管画 */
export type ErrorPlace = 'relogin' | 'page' | 'banner' | 'field' | 'checklist' | 'whole' | 'form' | 'inline';

/** 下一步对应的按钮。页面给了对应的回调才画 */
export type ErrorAction = 'relogin' | 'refresh' | 'reload' | 'merge' | 'retry' | 'back';

export const ERROR_ACTION_LABEL: Readonly<Record<ErrorAction, string>> = {
  relogin: '重新登录',
  refresh: '刷新',
  reload: '载入最新内容',
  merge: '去合并',
  retry: '重试',
  back: '回到列表',
};

/** 文案里要换成中文名的东西（锁定字段）：由页面按行业包传入，没传就不列 */
export interface CopyContext {
  fieldLabel?: (key: string) => string;
}

export interface ErrorEntry {
  title: string | ((body: ApiError, ctx: CopyContext) => string);
  next: string | null;
  place: ErrorPlace;
  tone: ErrorTone;
  action?: ErrorAction;
}

const count = (n: number | undefined): number => n ?? 0;
const issueCount = (b: ApiError): number => count(b.issues?.length) + (b.rows ?? []).reduce((s, r) => s + r.issues.length, 0);

/**
 * 错误文案（spec「通用部件 · 错误文案（ERROR_COPY）」）：按 ApiError.error 映射成固定的中文，不拼接服务端的 detail；
 * detail 与原码只进「技术详情」。spec 表之外多一条 invalid_credentials（登录页的「文案取 ERROR_COPY」，spec 顶部 Revisions）
 */
export const ERROR_COPY: Readonly<Record<string, ErrorEntry>> = {
  unauthorized: { title: '登录已过期', next: '重新登录后接着刚才的操作', place: 'relogin', tone: 'neutral', action: 'relogin' },
  forbidden: { title: '你的角色无法执行这项操作', next: '需要所有者或管理员', place: 'page', tone: 'caution' },
  csrf: { title: '页面已过期', next: '刷新后重试', place: 'page', tone: 'danger', action: 'refresh' },
  cross_site: { title: '页面已过期', next: '刷新后重试', place: 'page', tone: 'danger', action: 'refresh' },
  rev_conflict: {
    title: '别人刚改过这里',
    next: '载入最新内容（你的改动以对比形式保留）',
    place: 'banner',
    tone: 'danger',
    action: 'reload',
  },
  sop_conflict: {
    title: (b) => `有${count(b.keys?.length)}节在你改的同时被改了`,
    next: '去合并',
    place: 'banner',
    tone: 'danger',
    action: 'merge',
  },
  catalog_code_taken: { title: '这个编号已经有了', next: '换一个', place: 'field', tone: 'danger' },
  contract: { title: (b) => `有${count(b.violations?.length)}处需要改`, next: '点一处跳过去', place: 'checklist', tone: 'danger' },
  locked_field: {
    title: (b, ctx) => {
      const names = ctx.fieldLabel ? (b.fields ?? []).map(ctx.fieldLabel) : [];
      return names.length ? `这些内容上架后锁定了：${names.join('、')}` : '这些内容上架后锁定了';
    },
    next: null,
    place: 'page',
    tone: 'danger',
  },
  invalid_item: { title: (b) => `有${issueCount(b)}处要改`, next: null, place: 'field', tone: 'danger' },
  invalid_csv: { title: (b) => `有${issueCount(b)}处要改`, next: null, place: 'field', tone: 'danger' },
  invalid_sop: { title: '无法保存这份话术：格式不对', next: '撤回刚才的改动再试', place: 'banner', tone: 'danger' },
  locked_section: { title: '固定规则节不能改', next: '撤回这一节的改动', place: 'banner', tone: 'danger' },
  not_found: { title: '没有这项内容：可能已被删除或地址写错了', next: '回到列表', place: 'whole', tone: 'neutral', action: 'back' },
  conflict: { title: '刚才有人同时在改', next: '刷新后重来', place: 'banner', tone: 'danger', action: 'refresh' },
  bad_request: { title: '无法完成这项操作', next: '刷新页面后重试', place: 'page', tone: 'danger', action: 'refresh' },
  unsupported_media_type: { title: '无法完成这项操作', next: '刷新页面后重试', place: 'page', tone: 'danger', action: 'refresh' },
  rate_limited: { title: '尝试太频繁', next: '稍后再试', place: 'form', tone: 'danger' },
  busy: { title: '尝试太频繁', next: '稍后再试', place: 'form', tone: 'danger' },
  lock_lost: {
    title: '暂时无法保存：系统在重连数据库，线上内容不受影响',
    next: '稍后重试',
    place: 'banner',
    tone: 'danger',
    action: 'retry',
  },
  not_ready: { title: '系统正在启动', next: '重试', place: 'inline', tone: 'neutral', action: 'retry' },
  db_disabled: { title: '后台只在数据库模式下可用', next: null, place: 'whole', tone: 'neutral' },
  invalid_credentials: { title: '邮箱或密码不对', next: '检查后重试', place: 'form', tone: 'danger' },
};

/** 网络失败、表里没有的 5xx（含 internal） */
export const NETWORK_COPY: ErrorEntry = { title: '服务暂时连不上', next: '重试', place: 'inline', tone: 'danger', action: 'retry' };
/** 表里没有的 error：原码进技术详情 */
export const FALLBACK_COPY: ErrorEntry = { title: '无法完成这项操作', next: '重试', place: 'inline', tone: 'danger', action: 'retry' };
