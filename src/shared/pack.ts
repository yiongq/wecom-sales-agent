// 行业包的界面配置（docs/features/console-ux/spec.md「行业包通用架构」，设计系统 §9，ADR-004）。前后端共用，只依赖 src/shared。
// 行业包只提供配置：实体、字段、销售阶段、话术节表、词汇和导航；界面按字段类型渲染，不认具体行业。
// 各包的取值放在 src/packs/<包>/console-pack.ts，经 src/packs/registry.ts 注册，由 GET /api/console/pack 下发；
// console/src 不 import 任何包模块，只读接口返回的这份结构。

/** 字段类型是界面和行业包之间的契约：新增一种要改 console 的渲染器表（Record<FieldType, …>） */
export type FieldType =
  | 'text'
  | 'longText'
  | 'money'
  | 'intUnit'
  | 'monthRange'
  | 'enum'
  | 'tags'
  | 'boolean'
  | 'subItems'
  | 'reference'
  | 'status';

export interface FieldDef {
  /** payload 路径，如 'priceFrom'、'intensity.level'；'$code'、'$status'、'$updated' 是系统字段 */
  key: string;
  type: FieldType;
  /** 中文标签，不带冒号 */
  label: string;
  /** 表单分组，指向 EntityType.groups 的 key；有序子项里的子字段写空串 */
  group: string;
  /** 常驻在字段下方 */
  help?: string;
  /** 只放示例，以「例：」开头 */
  placeholder?: string;
  /** 默认 true；false 时标签后加「（选填）」。数组类型的必填只要求键存在，可以是空数组，要至少几项用 min */
  required?: boolean;
  /** 上架后锁定；tags 可以只锁其中几项 */
  lockedWhenActive?: true | { members: string[] };
  /** 指向 EntityType.lockGroups 的 key */
  lockGroup?: string;
  /** 条件显示；显示出来就必填 */
  showWhen?: { key: string; filled: true };
  unit?: string;
  /** 单位取另一个 enum 字段的值 */
  unitFrom?: string;
  /** intUnit、money 是数值上下限；数组类型（tags、多选 enum、subItems）的 min 是至少几项，拦上架 */
  min?: number;
  max?: number;
  /** longText：超过时提示，不拦 */
  softMax?: number;
  options?: string[];
  /** enum 多选 */
  multiple?: boolean;
  /** enum 多选存成字符串：按 join 连起来，一项都没选时存 empty */
  storeAs?: { join: string; empty: string };
  /** text / tags 的联想来源：'distinct' 取已有值 */
  suggest?: 'distinct' | string[];
  /** boolean 的两种文字 */
  trueLabel?: string;
  falseLabel?: string;
  /** monthRange 高亮月份的含义 */
  monthMeaning?: string;
  /** monthRange 解析成「全年」时显示的文字，默认「全年」 */
  yearRoundLabel?: string;
  /** 不拦上架的建议项 */
  recommend?: true | { min?: number; max?: number };
  /** reference：引用哪个实体的 kind */
  to?: string;
  /** reference：存编号还是名称 */
  store?: 'code' | 'label';
  /** reference：可以写库外的文本 */
  allowFree?: boolean;
  /** reference：按本条目的哪个字段筛候选 */
  filterBy?: string;
  /** subItems：子字段；只有一个 key 为空串的 text 子字段时存 string[] */
  item?: FieldDef[];
  /** subItems：量词，如「天」「条」 */
  itemNoun?: string;
  /** subItems：序号的写法，{n} 换成序号，如「D{n}」 */
  indexLabel?: string;
  /** subItems：条数要等于这个字段的值 */
  countFrom?: string;
  /** subItems：自动编号、只读的子字段 */
  autoIndexKey?: string;
}

export interface EntityType {
  /** URL 用：/catalog/{kind} */
  kind: string;
  /** 导航和页标题用 */
  label: string;
  /** lucide 名称，只能取设计系统 §7 的实体图标集合 */
  icon: string;
  codeLabel: string;
  codeExample: string;
  titleKey: string;
  /** 列表首列的次行 */
  subtitleKeys: string[];
  /** 表单卡片，按顺序 */
  groups: { key: string; label: string }[];
  /** 锁定组：卡片头的 Tag 与原因，每组只说一次 */
  lockGroups: Record<string, { tag: string; reason: string }>;
  fields: FieldDef[];
  list: { columns: string[]; filters: string[]; search: string[]; defaultSort: '-$updated' };
  /** 能否导入 CSV；false 时不渲染入口 */
  csvImport: boolean;
  /** 上架确认的第一句，{字段 key} 会被替换成当前值 */
  activateLine: string;
}

export interface SalesStageDef {
  key: string;
  label: string;
  /** 分支阶段（如异议）排在它的主阶段后面 */
  branchOf?: string;
  /** 终态不进「客户停在哪一步」 */
  terminal?: boolean;
}

export interface SopSectionDef {
  key: string;
  heading: string | null;
  locked: boolean;
  /** 固定规则节为什么不能改，写成人话 */
  lockReason?: string;
}

export interface IndustryPack {
  id: string;
  name: string;
  vocabulary: {
    customer: string;
    advisor: string;
    /** 总览上「在售{productNoun}」 */
    productNoun: string;
    /** 工具原名 → 中文名，话术芯片用 */
    tools: Record<string, string>;
    /** 话术可以点名的字段 → 中文名 */
    sopFields: Record<string, string>;
  };
  entities: EntityType[];
  stages: SalesStageDef[];
  sopSections: SopSectionDef[];
  nav: { catalogGroup: string; entities: string[] };
}

/** 上架前检查：必须项与建议项 */
export interface ItemCheck {
  required: CheckIssue[];
  recommended: CheckIssue[];
}

/** label 是中文路径，例如「逐日行程 · 第4天 · 当天餐食」 */
export interface CheckIssue {
  path: string;
  label: string;
  message: string;
}
