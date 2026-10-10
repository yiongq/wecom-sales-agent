// SOP 契约检查，也就是发布闸 v0（docs/architecture/01-pg-config-console/spec.md「契约检查」）。
// 纯数据加纯函数，不 import 引擎：发布、回滚、启动重渲染、导出都拿它核对一份 SOP 能不能交给模型。
// mock 回归从不读 system prompt，SOP 改成什么样 mock 都照样全过，所以闸只能是这里的静态检查。
import type { ContractViolation, ViolationCode } from '../shared/console-api.js';
import {
  editableChars,
  normalizeBody,
  sectionBody,
  SopEncodingError,
  SopStructureError,
  TRAVEL_SOP_SECTIONS,
  type SectionSpec,
  type SopSection,
} from './sections.js';

import { SOP_CONTRACT } from '../packs/travel/sop.js';
export { SOP_CONTRACT, SOP_KNOWN_FIELDS, KNOWN_FIELD_SOURCES } from '../packs/travel/sop.js';
export type { SopContractRule as ContractRule } from '../core/pack-api.js';

/** 可编辑节正文总长的上限：导入版本的 BUDGET_RATIO 倍（开放问题 7） */
export const BUDGET_RATIO = 1.2;

export type { ContractViolation, ViolationCode };

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
// 大写开头的词（酒店品牌名）和纯小写单词（greeting、emoji）都不查
const CAMEL = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g;

export function checkSopContract(input: {
  sections: readonly SopSection[];
  /** 镜像 data/sop.md 切出的节 */
  imageSections: readonly SopSection[];
  /** render(joinSop(sections)) */
  rendered: string;
  /** toolDefs 里的 function.name */
  toolNames: readonly string[];
  knownFields: readonly string[];
  /** 该租户导入版本（source='import'）的 editableChars。null 表示不查预算：启动重渲染和导出都传 null */
  baselineEditableChars: number | null;
  spec?: readonly SectionSpec[];
}): ContractViolation[] {
  const spec = input.spec ?? TRAVEL_SOP_SECTIONS;
  const out: ContractViolation[] = [];
  // match 是前端在正文里查找、生成说明用的原文（后台 UX spec「检查」）：只有短语与标识符四类有，其余不带这个键
  const add = (code: ViolationCode, sectionKey: string | null, detail: string, match?: string): void => {
    out.push(match === undefined ? { code, sectionKey, detail } : { code, sectionKey, detail, match });
  };

  // 结构：节的顺序与节表一致，每节的标题、空行、正文、规范形都对
  const keys = input.sections.map((s) => s.key).join(',');
  const specKeys = spec.map((s) => s.key).join(',');
  if (keys !== specKeys) add('structure', null, `节的顺序与节表不符：${keys}（应为 ${specKeys}）`);
  let structureOk = keys === specKeys;
  spec.forEach((s, i) => {
    const section = input.sections.find((x) => x.key === s.key);
    if (!section) return;
    try {
      const body = sectionBody(section, s);
      if (!body.trim()) throw new SopStructureError('正文为空');
      if (/^## /m.test(body)) throw new SopStructureError('正文里有以「## 」开头的行，会被当成新的一节');
      if (normalizeBody(body, i === spec.length - 1) !== body) throw new SopStructureError('不是规范形');
    } catch (e) {
      if (!(e instanceof SopStructureError || e instanceof SopEncodingError)) throw e;
      structureOk = false;
      add('structure', s.key, e.message);
    }
  });

  // 锁定节归代码所有：必须与镜像逐字节相同
  for (const s of spec) {
    if (!s.locked) continue;
    const mine = input.sections.find((x) => x.key === s.key);
    const image = input.imageSections.find((x) => x.key === s.key);
    if (mine && image && mine.text !== image.text)
      add('locked_changed', s.key, `锁定节「${s.heading ?? s.key}」与镜像里的 data/sop.md 不一致`);
  }

  // 短语：对整段 rendered 执行，与 selftest 的断言对象相同
  const holder = (hit: (text: string) => boolean): string | null => input.sections.find((x) => hit(x.text))?.key ?? null;
  for (const rule of SOP_CONTRACT) {
    if (rule.kind === 'include') {
      if (!input.rendered.includes(rule.text)) add('phrase_missing', null, `缺少「${rule.text}」（${rule.from}）`, rule.text);
    } else if (rule.kind === 'exclude') {
      if (input.rendered.includes(rule.text))
        add(
          'phrase_forbidden',
          holder((t) => t.includes(rule.text)),
          `不能出现「${rule.text}」（${rule.from}）`,
          rule.text,
        );
    } else {
      const m = rule.pattern.exec(input.rendered);
      if (m)
        add(
          'phrase_forbidden',
          holder((t) => rule.pattern.test(t)),
          `不能出现「${m[0]}」（${rule.from}）`,
          m[0],
        );
    }
  }

  // 标识符：每一节的标题与正文里点名的工具与字段必须真实存在
  const tools = new Set(input.toolNames);
  const fields = new Set(input.knownFields);
  for (const section of input.sections) {
    const seen = new Set<string>();
    for (const [name] of section.text.matchAll(SNAKE)) {
      if (tools.has(name) || seen.has(name)) continue;
      seen.add(name);
      add('unknown_tool', section.key, `「${name}」不是现有的工具名`, name);
    }
    for (const [name] of section.text.matchAll(CAMEL)) {
      if (fields.has(name) || seen.has(name)) continue;
      seen.add(name);
      add('unknown_field', section.key, `「${name}」不是工具参数或结果里的字段`, name);
    }
  }

  // 预算只管运营能控制的部分：可编辑节的正文
  if (input.baselineEditableChars !== null && structureOk) {
    const chars = editableChars(input.sections, spec);
    const limit = input.baselineEditableChars * BUDGET_RATIO;
    if (chars > limit) {
      add(
        'over_budget',
        null,
        `可编辑节正文共 ${chars} 字，超过上限 ${Math.floor(limit)}（导入时 ${input.baselineEditableChars} 的 ${BUDGET_RATIO} 倍）`,
      );
    }
  }
  return out;
}
