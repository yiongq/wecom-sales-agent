// 启动时判断来者（spec「外壳 · 启动」「行业包通用架构 · 下发」）：并发取 /me 与 /pack，两个都回来才定下是谁。
// 纯函数，不发请求；viewer.ts 把两个响应（或抛出的错）交给它，shell.selftest.ts 逐行核对 spec 的那张表。
//
// | /me、/pack                                  | 结果                                              |
// | ------------------------------------------- | ------------------------------------------------- |
// | 任一个 503 db_disabled                      | disabled：整页中性说明，没有按钮                  |
// | 任一个 503 not_ready                        | 抛出 not_ready：整页「系统正在启动 · 重试」       |
// | 任一个网络失败或 5xx                        | 抛出：整页「服务暂时连不上 · 重试」               |
// | 200、200                                    | 成员                                              |
// | 401、200                                    | demo 匿名                                         |
// | 401、401                                    | prod：登录页                                      |
// 成员身份下（本次启动时 /me 成功过、或在本页登录过）/me 没成功时抛出，不降成匿名：分不清身份，宁可重试（spec「会话过期的判定」）。
// 表外的组合（如 /me 200 而 /pack 401）也抛出，按错误文案显示
import type { ApiError, Me } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { HttpError } from '../api.js';

export type AnonViewer = { kind: 'anon'; pack: IndustryPack };

export type Viewer =
  | { kind: 'member'; me: Me; pack: IndustryPack }
  | AnonViewer
  /** demo：从匿名演示点「登录」进来时带着原来的匿名视图，登录页的「返回演示」回到它（spec「登录」） */
  | { kind: 'login'; demo?: AnonViewer }
  | { kind: 'disabled' };

/** 一个请求的结局：拿到了响应（状态码与解析出的 JSON），或者 fetch 自己抛了错（连不上） */
export type Outcome = { status: number; body: unknown } | { thrown: unknown };

const errorOf = (o: Outcome): string | null =>
  'status' in o && o.body && typeof o.body === 'object' && typeof (o.body as ApiError).error === 'string'
    ? (o.body as ApiError).error
    : null;
const is503 = (o: Outcome, code: string): boolean => 'status' in o && o.status === 503 && errorOf(o) === code;
const httpError = (o: { status: number; body: unknown }): HttpError =>
  new HttpError(o.status, errorOf(o) ? (o.body as ApiError) : { error: 'bad_response' });

export function resolveBoot(me: Outcome, pack: Outcome, memberSession: boolean): Viewer {
  if (is503(me, 'db_disabled') || is503(pack, 'db_disabled')) return { kind: 'disabled' };
  if (is503(me, 'not_ready')) throw httpError(me as { status: number; body: unknown });
  if (is503(pack, 'not_ready')) throw httpError(pack as { status: number; body: unknown });
  if ('thrown' in me) throw me.thrown;
  if ('thrown' in pack) throw pack.thrown;
  if (me.status >= 500) throw httpError(me);
  if (pack.status >= 500) throw httpError(pack);
  if (me.status === 200) {
    if (pack.status !== 200) throw httpError(pack);
    return { kind: 'member', me: me.body as Me, pack: pack.body as IndustryPack };
  }
  if (memberSession || me.status !== 401) throw httpError(me);
  if (pack.status === 200) return { kind: 'anon', pack: pack.body as IndustryPack };
  if (pack.status === 401) return { kind: 'login' };
  throw httpError(pack);
}
