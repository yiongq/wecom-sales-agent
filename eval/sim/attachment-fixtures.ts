// 12 R13：评测用的合成附件（eval/fixtures/attachments/）。v2 回合、模拟客户与识别准确率脚本共用。
// 放在 eval/sim/ 里：发布闸的评测子进程只带 eval/sim（Dockerfile），runtime.ts 静态 import 它，不能放到 eval/ 的别处。
// 附件走与渠道同一个入口：prepareAttachment（判类、去元数据、按 R1 决定存不存原件），再由引擎的 handleMessage 收下。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleOpts } from '../../src/core/engine/index.js';
import type { AttachmentClass } from '../../src/shared/channel-types.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/attachments/', import.meta.url));
/** 样本只能按文件名取，不带路径，免得用例文件里的名字跳出样本目录 */
export const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function fixtureBytes(file: string): Buffer {
  if (!FIXTURE_NAME.test(file)) throw new Error(`附件样本名不合法：${file}`);
  const target = path.join(FIXTURE_DIR, file);
  if (!fs.existsSync(target)) throw new Error(`没有这个附件样本：${file}`);
  return fs.readFileSync(target);
}

export interface TruthLine {
  partNo: string;
  qty: number | null;
}
export interface TruthEntry {
  class: AttachmentClass;
  /** 图片样本：视觉应输出的类型 */
  kind?: 'list' | 'nameplate';
  /** 有可读询价行的样本（图片、表格）：逐行的型号与数量，qty 为 null 表示数量读不出来 */
  lines?: TruthLine[];
}

export function readTruth(): Record<string, TruthEntry> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'truth.json'), 'utf8')) as Record<string, TruthEntry>;
}

/** 渠道给客户消息写的占位：网页路由与企微适配器同款，名称不进正文 */
export const placeholderOf = (cls: AttachmentClass): '[图片]' | '[文件]' => (cls === 'image' ? '[图片]' : '[文件]');

export interface PreparedFixture {
  cls: AttachmentClass;
  /** 交给 handleMessage 的客户消息文字：只有占位 */
  text: '[图片]' | '[文件]';
  /** 交给 handleMessage 的第四个参数：引用、待提交的附件行、去过元数据的字节、渠道消息 id */
  opts: HandleOpts;
}

/**
 * 把一个样本准备成渠道收到附件时交给引擎的那一套参数。动态 import：入口模块依赖 store，
 * 调用方要先把 VAR_DIR 等环境设好、再走到这里（v2 worker 与模拟运行时都满足）。
 * name 缺省取样本文件名；要测「文件名叫投诉.xlsx」这类，用 name 单独指定，名称只进附件元数据，不进消息正文。
 */
export async function prepareFixture(file: string, sourceKey: string, name?: string): Promise<PreparedFixture> {
  const bytes = fixtureBytes(file);
  const { prepareAttachment } = await import('../../src/core/attachment-intake.js');
  const result = await prepareAttachment({ bytes, name: name ?? file, channel: 'web', sourceKey });
  if (!result.ok) throw new Error(`附件没有通过接收入口（${result.cls}）：${result.text}`);
  const { attachment, attachmentItem, attachmentBytes } = result.value;
  return {
    cls: attachment.cls,
    text: placeholderOf(attachment.cls),
    opts: { attachment, attachmentItem, ...(attachmentBytes ? { attachmentBytes } : {}), msgid: sourceKey },
  };
}
