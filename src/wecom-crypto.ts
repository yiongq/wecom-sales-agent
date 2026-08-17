// 企业微信回调加解密（官方方案的最小实现：SHA1 验签 + AES-256-CBC 解密）。
// 明文结构：16 字节随机串 | 4 字节消息长度(大端) | 消息体 | receiveId(corpid)
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export function computeSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex');
}

/** 恒定时间字符串比较（长度不等直接判否），验签/鉴权用，防时序侧信道 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function decryptWecom(encodingAesKey: string, cipherB64: string): { msg: string; receiveId: string } {
  const aesKey = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (aesKey.length !== 32) throw new Error('EncodingAESKey 无效（base64 解码后应为 32 字节）');
  const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let buf = Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]);
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) throw new Error('PKCS7 填充无效');
  buf = buf.subarray(0, buf.length - pad);
  const msgLen = buf.readUInt32BE(16);
  return {
    msg: buf.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: buf.subarray(20 + msgLen).toString('utf8'),
  };
}
