// 月份条（设计系统 §6.1）：S 号在列表里，L 号在表单预览和只读里。12 个月各一格，选中的格连成圆角段（段的首尾格才有圆角），
// 跨年区间（11月-次年4月）画成两段；当前月 S 号是一根竖线，L 号是数字下方的圆点。
// 只用 class，不写内联样式。解析与文字取 src/shared/format.ts，与上架前检查、schema 同一个判定
import { monthRangeSpoken, type MonthRange } from '../../../src/shared/format.js';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export interface MonthStripProps {
  range: MonthRange;
  size: 'S' | 'L';
  /** 读屏的前半句，一般是字段标签：「最佳季节：5月到10月」 */
  label: string;
  /** 解析成「全年」时读的字，默认「全年」 */
  yearRoundLabel?: string;
  /** 当前月（1–12），标一根竖线或一个圆点；不给就不标 */
  current?: number;
}

export function MonthStrip({ range, size, label, yearRoundLabel, current }: MonthStripProps) {
  const on = new Set(range.kind === 'months' ? range.months : []);
  return (
    <span
      className={`month-strip month-strip-${size}${range.kind === 'yearRound' ? ' is-year-round' : ''}`}
      role="img"
      aria-label={`${label}：${monthRangeSpoken(range, yearRoundLabel)}`}
    >
      {MONTHS.map((m) => {
        const cls = ['ms-cell'];
        if (on.has(m)) {
          cls.push('on');
          // 条上 12 月与 1 月不相邻：跨年区间是两段，各自有圆角
          if (m === 1 || !on.has(m - 1)) cls.push('start');
          if (m === 12 || !on.has(m + 1)) cls.push('end');
        }
        if (m === current) cls.push('now');
        return (
          <span key={m} className={cls.join(' ')}>
            {size === 'L' ? m : null}
          </span>
        );
      })}
    </span>
  );
}
