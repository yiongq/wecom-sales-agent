// 等价套件两个子进程的钟（parity.selftest.ts 以 --import 预加载，只给它用）。父进程定一个基准时刻（当天本地 12:00），经
// PARITY_CLOCK_MS 传给两个子进程：Date.now() 与无参 new Date() 都从这个时刻起走，钟照常往前走。两个子进程先后跑，各自现取
// 「今天」的话，跨过本地零点时转人工备注里的「按今天（…）算是」就成了假差异；钉在正午也让套件不受在几点跑的影响。
// 偏移按装上这一刻的 Date.now() 算（之前已被别的预载拨过也一样对齐）。PGlite 的 now() 取的也是 Date.now()，库里的触发器
// （updated_at 不晚于现在 5 分钟）看到的是同一个钟
const base = Number(process.env.PARITY_CLOCK_MS);
if (!Number.isSafeInteger(base) || base <= 0)
  throw new Error(`parity-clock：PARITY_CLOCK_MS 不是毫秒时刻（${process.env.PARITY_CLOCK_MS}）`);
const RealDate = Date;
const offset = base - RealDate.now();
class ParityDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [string]));
  }
  static override now(): number {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ParityDate as DateConstructor;
