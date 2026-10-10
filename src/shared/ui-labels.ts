// 界面自己的固定文案（docs/features/console-ux/spec.md「通用部件 · 错误文案」「审计日志」，设计系统 §5.17、§11）：
// 话术检查项名、角色、审计动作（中文、分组、图标名）、错误文案。前后端共用，不依赖 React。
// 行业相关的词（实体名、字段名、阶段名、客户的叫法）不在这里，都来自行业包（src/shared/pack.ts）。
// 这里的字符串会显示在后台上，也是 UI 优先片的用字来源（scripts/fonts/ui-text.ts）：改了文案要重跑 scripts/fonts/build.ts。
import type { ApiError, Role, ViolationCode } from './console-api.js';
import { QUOTA_EXHAUSTED_TEXT, WINDOW_CLOSED_TEXT } from './conversation-types.js';
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

/** 审计页的类别（spec「审计日志 · 筛选」；02 加「会话与订单」）；「全部」不是类别 */
export type AuditGroup = 'sop' | 'catalog' | 'conversation' | 'account' | 'platform';

/**
 * 审计页的类别与名字，按显示顺序。产品库那一类的名字取行业包的 nav.catalogGroup，与侧栏的分组名相同
 * （旅游包是「产品库」，spec K 页照旅游包写）；其余几类是界面自己的词。
 * 「会话与订单」是 02 spec「后台接口」加的一段：接手、改派、交还、确认价格、确认收款、取消订单
 */
export function auditGroups(pack: Pick<IndustryPack, 'nav'>): ReadonlyArray<{ key: AuditGroup | 'all'; label: string }> {
  return [
    { key: 'all', label: '全部' },
    { key: 'sop', label: '销售话术' },
    { key: 'catalog', label: pack.nav.catalogGroup },
    { key: 'conversation', label: '会话与订单' },
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
  // 02「报价快照」：上架、改了已上架条目的内容、启动补写时记下的条目版本；方案书链接按版本号固定报价
  'catalog.version': { label: '记下新版本', group: 'catalog', icon: 'history' },
  'auth.login': { label: '登录', group: 'account', icon: 'log-in', login: true },
  'auth.logout': { label: '退出登录', group: 'account', icon: 'log-out', login: true },
  'config.import': { label: '导入初始配置', group: 'platform', icon: 'download' },
  'tenant.brand_set': { label: '设置企业信息', group: 'platform', icon: 'building' },
  'tenant.brand_clear': { label: '清除企业信息', group: 'platform', icon: 'building' },
  'platform.tenant_create': { label: '建租户', group: 'platform', icon: 'building' },
  'platform.user_create': { label: '建账号', group: 'account', icon: 'user-plus' },
  'platform.user_password': { label: '重设密码', group: 'account', icon: 'key-round' },
  'platform.user_disable': { label: '停用账号', group: 'account', icon: 'user-x' },
  'platform.member_role': { label: '改角色', group: 'account', icon: 'user-cog' },
  'platform.member_remove': { label: '移出租户', group: 'account', icon: 'user-minus' },
  // 02 spec「后台接口」的新动作。会话类的 target 是会话行的 ref（不含客户标识），diff 带短码；订单类的 target 是订单号
  'conversation.takeover': { label: '接手会话', group: 'conversation', icon: 'hand' },
  'conversation.reassign': { label: '换人处理', group: 'conversation', icon: 'arrow-right-left' },
  'conversation.release': { label: '交还AI', group: 'conversation', icon: 'bot' },
  'order.confirm': { label: '确认价格', group: 'conversation', icon: 'badge-check' },
  'order.mark_paid': { label: '确认收款', group: 'conversation', icon: 'banknote' },
  'order.cancel': { label: '取消订单', group: 'conversation', icon: 'circle-x' },
  // 快捷回复（J 页右栏插进输入框的模板）随会话工作台归在「会话与订单」一类。第 13 步先写「常用回复」（那时「快捷」两字
  // 还不在 UI 优先片里）；J 页右栏卡片标题（第 20.2 步）已经用上「快捷回复」，字已经在优先片里了，这里改回 spec 原词
  'quick_reply.create': { label: '新建快捷回复', group: 'conversation', icon: 'message-square-plus' },
  'quick_reply.update': { label: '修改快捷回复', group: 'conversation', icon: 'square-pen' },
  'quick_reply.archive': { label: '收起快捷回复', group: 'conversation', icon: 'archive' },
  'quick_reply.move': { label: '移动快捷回复', group: 'conversation', icon: 'arrow-up-down' },
  // 02 spec「隐私说明、敏感信息同意、保留期与行权」（第 16 步）：发布说明、设保留期是平台命令行；行权删除与保留期清理
  // 不存会话 id（只有条数），归「平台与配置」。「隐私」的「私」不在 UI 优先片里，这几条的字都是已在片里的
  'privacy.publish': { label: '发布须知', group: 'platform', icon: 'shield-check' },
  'platform.tenant_retention': { label: '设置保留期', group: 'platform', icon: 'calendar-clock' },
  'platform.erase': { label: '删除会话', group: 'platform', icon: 'eraser' },
  'system.purge': { label: '保留期清理', group: 'platform', icon: 'trash' },
  'channel.account_create': { label: '新建入口账号', group: 'platform', icon: 'plus' },
  'channel.account_update': { label: '修改入口账号', group: 'platform', icon: 'pencil-line' },
  // 使用 UI 优先字体片已有的字；认证信息包含三项凭据，加密设置指数据库加密密钥的轮换。
  'channel.secrets_update': { label: '更新入口认证信息', group: 'platform', icon: 'key-round' },
  'channel.rekey': { label: '轮换入口加密设置', group: 'platform', icon: 'refresh-cw' },
  'channel.import': { label: '导入入口状态', group: 'platform', icon: 'refresh-cw' },
  'channel.export': { label: '导出入口状态', group: 'platform', icon: 'refresh-cw' },
  // 03 第 12 步 restore-cutoff：从备份恢复之后设截止点、取消截止点之前没发的（「截止」两字不在 UI 优先片里）
  'channel.restore_cutoff': { label: '备份恢复处理', group: 'platform', icon: 'history' },
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

/**
 * 命令行写进条目更新人的命令名（src/config/transfer.ts 的 import-config、src/config/catalog.ts 的 catalog-fix），界面上按
 * 设计系统 §11 换掉：导入写「系统导入」，别的命令写「命令行」。库里存的是命令名，已有的租户库也是，所以在显示时换
 */
export const CLI_ACTOR_LABEL: Readonly<Record<string, string>> = { 'import-config': '系统导入', 'catalog-fix': '命令行' };

/** 显示用的更新人：命令名换成 §11 的写法，人名原样；没有名字时是 null，由调用处决定写什么 */
export function actorName(name: string | null | undefined): string | null {
  if (!name) return null;
  return Object.hasOwn(CLI_ACTOR_LABEL, name) ? CLI_ACTOR_LABEL[name]! : name;
}

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
  /** 02 spec「后台页面」J 页：会话过了保留期、被删除或不是本租户的（第 19 步，占位的 J 页先接住这一个错误码） */
  conversation_not_found: { title: '这个会话已经不在了', next: '回到列表', place: 'whole', tone: 'neutral', action: 'back' },
  // 02 第 20.2 步新增（J 页：接手、交还、人工回复、订单动作）。assigneeName／closesAt／remaining／status 取自
  // ApiError 的同名字段（服务端 mapError 填的），不是服务端的 detail（不变量 8）
  assigned_to_other: {
    title: (b) => `${b.assigneeName ?? '别人'}正在处理这个会话`,
    next: null,
    place: 'inline',
    tone: 'neutral',
  },
  not_assignee: { title: '只有接手人本人能做这件事', next: null, place: 'inline', tone: 'caution' },
  consent_declined: { title: '客户没有同意，不能交给AI', next: null, place: 'inline', tone: 'neutral' },
  // 字面直接引用 src/quota/ledger.ts 给顾问看的同一句话（经 conversation-types.ts 转手），不手写一份措辞不同的文案
  send_window_closed: { title: WINDOW_CLOSED_TEXT, next: null, place: 'inline', tone: 'caution' },
  send_quota_exhausted: { title: QUOTA_EXHAUSTED_TEXT, next: null, place: 'inline', tone: 'caution' },
  order_state: {
    title: (b) => (b.status === 'unconfirmed' ? '还没确认价格，不能确认收款' : '这个操作对当前订单状态不适用'),
    next: null,
    place: 'inline',
    tone: 'caution',
  },
  store_file_mode: { title: '这项内容只在数据库模式下可用', next: null, place: 'inline', tone: 'neutral' },
  store_lagging: { title: '已生效，记录稍后保存', next: null, place: 'inline', tone: 'neutral' },
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
