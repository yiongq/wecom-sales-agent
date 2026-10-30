// 10 R3 / R11 的固定句与文字询价行抽取；独立成文件，免得附件识别与回合判定互相引用。
export const FIXED = {
  nonstandard: '非标和来图加工需要顾问确认，我请顾问继续跟您核对。',
  credit: '账期和月结需要顾问确认，我请顾问继续跟您核对。',
  sample: '样品需求需要顾问确认，我请顾问继续跟您核对。',
  long: '询价超过30行，我请顾问继续跟您核对。',
  accepted: '好的，顾问会尽快联系您确认付款和发货',
  pending: '最新的报价单还在顾问审核，审好马上发您',
} as const;
export function inquiryLines(text: string): { query: string; qty: number }[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => {
      // 只数当前消息内显式的型号 + 数量，不把型号自身的数字当数量。
      const match =
        /^\s*(?:型号[:：]?\s*)?([A-Za-z0-9][A-Za-z0-9×*\-_/ .]*?)\s*(?:[，,:：=]\s*|\s+|[×*]\s*)(\d+)\s*(?:件|个|套|米|千克|盒|pcs)?\s*$/i.exec(
          line,
        );
      return match && /[A-Za-z]/.test(match[1]!) ? [{ query: match[1]!.trim(), qty: Number(match[2]) }] : [];
    });
}
