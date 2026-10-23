// AI 记录的 search 参数（07 spec R24）：时间段与四个筛选都写在地址里，刷新、后退、分享链接都能还原（后台 UX spec 不变量 22）。
// router.tsx 与自测都用它，所以单放一个文件：router.tsx 读 import.meta.env，自测在 Node 里 import 不了它。
// 只放写法检查，不 import console-api.ts 的值（它的 zod schema 会进入口集合）也不 import ui-labels 的表：取值对不对（结果、护栏、转人工原因
// 认不认识）由页面在 traces/model.ts 里按真实的表再筛一遍，认不得的当没写，不发给接口。

export interface TracesSearch {
  /** 时间段：不写是近 7 天（1d 近 24 小时、30d 近 30 天、all 全部） */
  range?: '1d' | '30d' | 'all';
  /** 结果（TraceOutcome 的取值） */
  outcome?: string;
  /** 触发的护栏（主回复步骤的 id） */
  guard?: string;
  /** 转人工原因（HandoffKind 的取值） */
  handoff?: string;
  /** 只看回复仍超长的；没开不写 */
  over?: 1;
}

const word = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);

/**
 * 写法不合规的参数丢掉。键总是写出来（不合规时是 undefined）：TanStack Router 把地址里原样的参数和这里的结果合在一起给 useSearch，
 * 不写出来的键会原样留着（第 4 步的记录）。range=7d 是默认，不留
 */
export const tracesSearch = (s: Record<string, unknown>): TracesSearch => ({
  range: s.range === '1d' || s.range === '30d' || s.range === 'all' ? s.range : undefined,
  outcome: word(s.outcome, /^[a-z]{1,20}$/),
  guard: word(s.guard, /^[a-z][a-z0-9_:-]{0,63}$/),
  handoff: word(s.handoff, /^[a-z]{1,20}$/),
  over: s.over === 1 || s.over === '1' ? 1 : undefined,
});
