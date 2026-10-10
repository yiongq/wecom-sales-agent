// 企微回调按账号路由（docs/architecture/03-channels-v2/spec.md R12、「会话 id、账号与回调」、不变量 20、验收 12）。
// server.ts 只做 HTTP 那一层：企微状态在库里时 /wecom/callback 与 /wecom/callback/:key 都交到这里；文件存储与还没导入、已导出时
// /wecom/callback 照 02 读 env 的回调凭据（server.ts 里原样），/wecom/callback/:key 也交到这里——那时没有库里的企微账号，一律当作不存在。
//
// - /wecom/callback/:key 只认库里启用的企微账号（网页账号的 key、env 账号的 key `env`、停用的账号都当作不存在）；
//   /wecom/callback 留给前缀是 wecom: 的那个库里账号，线上已配好的地址不用改。
// - 只用路由所指账号的回调 Token 与 EncodingAESKey 验签、解密；库里的账号遇到空的或不等于 corp_id 的 receiveid 不拉取。
// - 解密后按明文里的 OpenKfId 找本租户启用的、同一 corp_id 的企微账号去拉（几个客服账号共用一个自建应用时只能配一个回调地址），
//   找不到只记日志；明文里没有 OpenKfId 时按路由的账号拉。
// - GET（企微后台校验地址）：不存在、停用、不是企微的 key 回 404；路由到了账号但参数不全、验签、解密、receiveid 任何一步不过也回 404
//   （与不存在的 key 分不出来，不给逐个试 key 的人留信号），原因只进日志。POST 一律回 success（企微会重推），出错只记一行日志。
// 日志里只有账号 key、签名前 8 位与时间戳，不写凭据、corp_id、open_kfid 与明文。
import { DEFAULT_WECOM_PREFIX, isEnabled, loadedAccounts, type ChannelAccount } from '../channels/accounts.js';
import { loadedChannels } from '../channels/registry.js';
import type { WecomSecrets } from '../channels/secrets.js';
import { computeSignature, decryptWecom, safeEqual } from '../wecom-crypto.js';
import { syncAccountFromCallback } from './wecom.js';

/** server.ts 的 extractTag：线性扫描取第一个 <tag> 的文本（防构造输入的回溯，见那里的注释） */
export type TagReader = (xml: string, tag: string) => string | undefined;

export interface CallbackQuery {
  msg_signature?: string;
  timestamp?: string;
  nonce?: string;
  echostr?: string;
}

/** 账号 key 的形状（R8）：日志里只照抄合规的 key，路径里别的东西不进日志 */
const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;
const routeLabel = (key: string | null): string =>
  key === null ? '/wecom/callback' : KEY_RE.test(key) ? `/wecom/callback/${key}` : '/wecom/callback/（不合规的 key）';
const tagOf = (a: ChannelAccount): string => `[wecom acct=${a.key}]`;

/** 库里的企微账号（任何状态） */
const dbWecom = (): ChannelAccount[] => loadedAccounts().filter((a) => a.kind === 'wecom_kf' && a.source === 'db' && a.wecom);

type Route = { account: ChannelAccount; secrets: WecomSecrets } | { why: string };

/** 路由指向的账号：带 key 的按 key 找，不带的是前缀为 wecom: 的那个；要启用的、凭据装上了的 */
function routeOf(key: string | null): Route {
  const account = dbWecom().find((a) => (key === null ? a.wecom!.idPrefix === DEFAULT_WECOM_PREFIX : a.key === key));
  if (!account) return { why: '没有这个库里的企微账号' };
  if (!isEnabled(account)) return { why: '账号已停用' };
  const secrets = loadedChannels().get(account.id)?.secrets;
  if (!secrets) return { why: '账号的凭据没有装上' };
  return { account, secrets: secrets.reveal() };
}

/** 库里的账号：receiveid 必须非空、等于账号的 corp_id（env 账号照 02 放行空的，在 server.ts 里） */
const receiveIdOk = (account: ChannelAccount, receiveId: string): boolean => receiveId !== '' && receiveId === account.wecom!.corpId;

/** GET：企微后台校验回调地址。通过返回解密出的 echostr，其余一律 404 */
export function accountCallbackGet(key: string | null, q: CallbackQuery): { status: 200 | 404; text: string } {
  const notFound = { status: 404 as const, text: 'not found' };
  const r = routeOf(key);
  if ('why' in r) {
    console.warn(`[wecom] 回调地址校验：${routeLabel(key)} ${r.why}，回 404`);
    return notFound;
  }
  const { account, secrets } = r;
  const { msg_signature: sig, timestamp, nonce, echostr } = q;
  if (!sig || !timestamp || !nonce || !echostr) {
    console.warn(`${tagOf(account)} 回调地址校验：参数不完整（缺 msg_signature/timestamp/nonce/echostr），回 404`);
    return notFound;
  }
  if (!safeEqual(computeSignature(secrets.callbackToken, timestamp, nonce, echostr), sig)) {
    console.warn(`${tagOf(account)} ⚠️ 回调地址校验：验签失败（企微后台填的 Token 与这个账号的回调 Token 不一致），回 404`);
    return notFound;
  }
  try {
    const { msg, receiveId } = decryptWecom(secrets.callbackAesKey, echostr);
    if (!receiveIdOk(account, receiveId)) {
      console.warn(`${tagOf(account)} ⚠️ 回调地址校验：receiveid ${receiveId ? '与账号的 corp_id 对不上' : '是空的'}，回 404`);
      return notFound;
    }
    return { status: 200, text: msg };
  } catch (err) {
    console.warn(`${tagOf(account)} 回调地址校验：echostr 解密失败（${err instanceof Error ? err.message : 'unknown'}），回 404`);
    return notFound;
  }
}

/**
 * POST：企微推来加密的 kf_msg_or_event 事件 → 验签、解密 → 按 OpenKfId 找账号、用明文里的 Token 拉。调用方随即回 success
 * （拉取异步做），这里出错只记日志
 */
export function accountCallbackPost(key: string | null, q: CallbackQuery, encrypt: string | undefined, readTag: TagReader): void {
  const r = routeOf(key);
  if ('why' in r) {
    console.error(`[wecom] 收到回调：${routeLabel(key)} ${r.why}，这次不拉`);
    return;
  }
  const { account, secrets } = r;
  const tag = tagOf(account);
  const { msg_signature: sig, timestamp, nonce } = q;
  if (!sig || !timestamp || !nonce || !encrypt) {
    console.error(`${tag} 回调参数不完整（缺 msg_signature/timestamp/nonce/Encrypt），已丢弃`);
    return;
  }
  // 验签失败不能静默：Token 抄错一位时每条客户消息的回调都会在这里被丢掉，消息只能靠兜底轮询，首响明显变慢
  if (!safeEqual(computeSignature(secrets.callbackToken, timestamp, nonce, encrypt), sig)) {
    // sig、timestamp 来自请求：只照抄形状对的部分，换行之类进不了日志
    const sigHead = sig.slice(0, 8).replace(/[^0-9a-fA-F]/g, '?');
    const ts = /^\d{1,12}$/.test(timestamp) ? timestamp : '（不是数字）';
    console.error(
      `${tag} ⚠️ 回调验签失败（sig=${sigHead}… timestamp=${ts}）：` +
        '不是用这个账号的回调 Token 签的（企微后台配置不一致，或配错了地址），这次不拉',
    );
    return;
  }
  let msg: string;
  let receiveId: string;
  try {
    ({ msg, receiveId } = decryptWecom(secrets.callbackAesKey, encrypt));
  } catch (err) {
    console.error(`${tag} 回调事件解密失败（${err instanceof Error ? err.message : 'unknown'}），这次不拉`);
    return;
  }
  if (!receiveIdOk(account, receiveId)) {
    console.error(`${tag} ⚠️ 回调的 receiveid ${receiveId ? '与账号的 corp_id 对不上' : '是空的'}，这次不拉`);
    return;
  }
  // kf 事件明文里带 <Token>，用它调 sync_msg 才不限频；<OpenKfId> 指明是哪个客服账号的消息（没有时按路由的账号）
  const syncToken = readTag(msg, 'Token');
  const openKfId = readTag(msg, 'OpenKfId');
  const corpId = account.wecom!.corpId;
  const target = openKfId
    ? dbWecom().find((a) => isEnabled(a) && a.wecom!.corpId === corpId && a.wecom!.openKfId === openKfId && loadedChannels().has(a.id))
    : account;
  if (!target) {
    console.error(`${tag} 回调明文里的 OpenKfId 对不上本租户启用的、同一企业的客服账号，只记日志、不拉`);
    return;
  }
  console.log(
    `${tagOf(target)} 收到回调事件${target === account ? '' : `（经 ${routeLabel(key)}，按 OpenKfId 分派）`}` +
      `${syncToken ? '（含 token，立即拉取）' : '（无 token）'}`,
  );
  if (syncToken) void syncAccountFromCallback(target.id, syncToken);
}
