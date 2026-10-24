// 08 R4：画像与会话状态槽里属于核心的那几步——合并、发给模型的画像、重置。不 import 任何行业包，只读包运行时给的钩子。
import type { CustomerProfile, Session } from '../types.js';
import type { PackRuntime } from './pack-api.js';

/**
 * 合并本轮抽出的画像：旧画像打底、本轮抽到的覆盖（今天的浅合并，旅游的字段照旧），只有 attrs 按键合并而不是整块覆盖。
 * 两边都没有 attrs 时不写这个键（连 attrs: undefined 也没有：Object.keys 会数到它）
 */
export function mergeProfile(base: CustomerProfile, extracted: Partial<CustomerProfile>): CustomerProfile {
  const merged: CustomerProfile = { ...base, ...extracted };
  if (base.attrs || extracted.attrs) merged.attrs = { ...base.attrs, ...extracted.attrs };
  else delete merged.attrs;
  return merged;
}

/**
 * 发给模型的画像：包的 profileForPrompt 之后，核心再删一次昵称与头像（不依赖包自觉），attrs 再按包声明的 profileFields 筛一次。
 * 只按键过滤，不重建、不重排：旅游的输出（没有 attrs）逐字节等于包的返回
 */
export function profileForModel(
  runtime: Pick<PackRuntime, 'profileForPrompt' | 'profileFields'>,
  profile: CustomerProfile,
): Record<string, unknown> {
  const out = { ...runtime.profileForPrompt(profile) };
  delete out.nickname;
  delete out.avatar;
  if (Object.hasOwn(out, 'attrs')) {
    const allowed = new Set((runtime.profileFields ?? []).map((f) => f.key));
    const attrs: unknown = out.attrs;
    const kept =
      attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)
        ? Object.fromEntries(Object.entries(attrs).filter(([key]) => allowed.has(key)))
        : {};
    if (Object.keys(kept).length) out.attrs = kept;
    else delete out.attrs;
  }
  return out;
}

/**
 * 重置会话时清包的状态槽：只清 resetKeys 里的键，其余保留；槽里没有键了就去掉 packState 这个键。
 * 没声明 sessionState 的包（旅游）什么都不做，不会多出这个键
 */
export function resetPackState(runtime: Pick<PackRuntime, 'sessionState'>, session: Session): void {
  const state = session.packState;
  const keys = runtime.sessionState?.resetKeys;
  if (!state || !keys) return;
  for (const key of keys) delete state[key];
  if (!Object.keys(state).length) delete session.packState;
}
