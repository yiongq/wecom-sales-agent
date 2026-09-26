// 最佳季解析（01 spec「模块与依赖方向」）：createQuote 按它判旺季，产品库的 schema 按它校验 bestSeason 能不能解析，
// 所以放在前后端共用的 shared/ 里。tools.ts 再导出。

// bestSeason 是自由文本（如「6-9月」「11月-次年4月」「全年」），
// 展开其中的月份区间做旺季判定，保证规则确定可复现
export function peakMonths(bestSeason: string): Set<number> {
  const months = new Set<number>();
  // 「全年适游」不等于「全年旺季」。原先展开成 12 个月，结果是这条线任何日期都
  // 上浮 10%，还附一句「X 月为最佳出行季，价格上浮 10%」——等于全年溢价还讲不出理由。
  if (bestSeason.includes('全年')) return months;
  for (const m of bestSeason.matchAll(/(\d{1,2})\s*(?:月)?\s*[-–~至到]\s*(?:次年)?\s*(\d{1,2})\s*月/g)) {
    let from = Number(m[1]);
    const to = Number(m[2]);
    // 跨年区间如 11月-次年4月
    for (let i = 0; i < 12; i++) {
      months.add(from);
      if (from === to) break;
      from = (from % 12) + 1;
    }
  }
  for (const m of bestSeason.matchAll(/(\d{1,2})\s*月/g)) months.add(Number(m[1]));
  return months;
}
