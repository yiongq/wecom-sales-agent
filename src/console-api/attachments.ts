// 12 R12：工作台下载客户发来的附件原件。原件只经后台这条鉴权路由读出（不落 public/、不进公开路由，不变量 5）；
// 响应只出白名单类型并强制下载，文件名按 RFC 5987 编码。读原件与写审计在同一个事务里，审计写不进就不给文件。
import type { Tx } from '../db/client.js';
import { readAttachment as readAttachmentRow } from '../db/repo/attachments.js';
import { writeAudit } from '../db/repo/audit.js';
import { readAttachment as readStoredAttachment } from '../store.js';

/** 附件 id 的形状（att_ 加 24 位十六进制）；不合的当不存在，不去查库，也不会让文件后端抛错 */
export function isAttachmentId(id: string): boolean {
  return /^att_[0-9a-f]{24}$/.test(id);
}

/** 上传方声明的类型不可信：白名单（JPEG、PNG、XLSX、CSV）之外一律 application/octet-stream */
function safeMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/png':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'text/csv':
      return mime;
    default:
      return 'application/octet-stream';
  }
}

/** 没有文件名时拼名字用的扩展名，跟着响应的类型走 */
function extensionOf(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'text/csv':
      return 'csv';
    case 'application/octet-stream':
      return 'bin';
    default:
      return 'xlsx';
  }
}

/**
 * 客户给的文件名进响应头之前先清一遍：控制字符、孤立的代理项（encodeURIComponent 遇到会抛错）、路径分隔符换成下划线，
 * 去首尾空白，最多 200 个字符。清完是空的（或原本就没有）返回 null，由调用方用「附件-<id 后 6 位>.<扩展名>」
 */
function cleanName(name: string | null): string | null {
  if (name === null) return null;
  const cleaned = [...name]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff) || ch === '/' || ch === '\\' ? '_' : ch;
    })
    .join('')
    .trim();
  return cleaned ? [...cleaned].slice(0, 200).join('') : null;
}

/** RFC 5987 的 ext-value：encodeURIComponent 之外，!'()* 也按百分号编码 */
function encodeName(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 下载响应的头：类型走白名单，一律 attachment，不缓存，禁止嗅探。filename 给纯 ASCII 的兜底名，filename* 给真实文件名
 * （没有名字时是「附件-<id 后 6 位>.<扩展名>」），文件名与内容都不会进头的其他位置
 */
export function attachmentHeaders(row: { id: string; mime: string; name: string | null }): Record<string, string> {
  const mime = safeMime(row.mime);
  const tail = row.id.slice(-6);
  const ext = extensionOf(mime);
  const name = cleanName(row.name) ?? `附件-${tail}.${ext}`;
  return {
    'content-type': mime,
    'content-disposition': `attachment; filename="attachment-${tail}.${ext}"; filename*=UTF-8''${encodeName(name)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

export interface AttachmentDownload {
  bytes: Uint8Array;
  headers: Record<string, string>;
}

/** 附件行从哪读：'db' 经调用者的事务；文件后端的那一行（demo 类会话、文件存储）由调用者在事务外先读好交进来 */
export type AttachmentSource = 'db' | Awaited<ReturnType<typeof readStoredAttachment>>;

/**
 * 文件后端里的附件行（含字节）。要在开事务之前调：db 存储下 store 的 readAttachment 自己开一个短事务，
 * 嵌在别的事务里会占两条连接（单连接的测试库里直接死等）
 */
export function readFileAttachment(id: string): Promise<AttachmentSource> {
  return isAttachmentId(id) ? readStoredAttachment(id, true) : Promise.resolve(null);
}

/**
 * 在调用者开的租户事务里：读出原件，写一行审计 attachment.download（diff 只有附件 id、类别、大小，不含文件名与内容），返回字节与响应头。
 * 审计写不进去就抛错，事务回滚，调用方拿不到文件。
 * 附件必须属于这个会话；没有原件（没存、超出每日字节上限、30 天后清掉了字节）和 id 不合格一样返回 null。
 * source 是 'db' 时经这个事务读库（本租户、RLS）；否则是 readFileAttachment 先读好的文件后端的行
 */
export async function downloadAttachment(
  tx: Tx,
  conversationId: string,
  id: string,
  source: AttachmentSource,
): Promise<AttachmentDownload | null> {
  if (!isAttachmentId(id)) return null;
  const row = source === 'db' ? await readAttachmentRow(tx, id, true) : source;
  if (!row || row.id !== id || row.conversationId !== conversationId || !('bytes' in row) || row.bytes === null) return null;
  await writeAudit(tx, {
    action: 'attachment.download',
    targetType: 'attachment',
    targetId: row.id,
    diff: { id: row.id, cls: row.cls, size: row.bytes.byteLength },
  });
  return { bytes: row.bytes, headers: attachmentHeaders(row) };
}
