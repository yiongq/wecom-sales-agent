// 产品库表单的纯逻辑（不依赖 React 与 rjsf，console.selftest 直接 import）：表单值 → 要提交的 payload，以及与原条目的差异
import { sameValue } from '../../src/shared/catalog.js';

export type Payload = Record<string, unknown>;

const isEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length === 0 : !!v && typeof v === 'object' && Object.values(v).every((x) => x === undefined);

/**
 * rjsf 删掉可选数组的最后一项时留下 []，清空可选对象（intensity）的各项时留下全是 undefined 的对象；
 * 共用 schema 里空的可选字段就是键不存在（可选数组 min(1)、对象的成员必填），原样交上去整张表单都过不了校验。
 * 所以非必填的顶层字段是这两种空值时当成没填：校验、比较差异、新建提交之前都先过一遍。必填的（tags 可以是 []）不动
 */
export function formPayload(formData: Payload, required: readonly string[]): Payload {
  return Object.fromEntries(Object.entries(formData).filter(([k, v]) => required.includes(k) || !isEmpty(v)));
}

/** 与原条目比：改过的顶层字段整体放进 set，原来有、现在没了的放进 unset */
export function diffPayload(prev: Payload, next: Payload): { set: Payload; unset: string[] } {
  const set: Payload = {};
  for (const [k, v] of Object.entries(next)) if (v !== undefined && !sameValue(prev[k], v)) set[k] = v;
  const unset = Object.keys(prev).filter((k) => next[k] === undefined);
  return { set, unset };
}
