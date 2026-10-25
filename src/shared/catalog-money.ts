// 08 R7：产品库仍存元；核心按声明取值，在定价或核对金额时换成整数分。

/** 容许浮点运算误差，不容许舍入掉角分；分也必须是安全整数。 */
export function yuanToFen(yuan: number): number {
  const fen = Math.round(yuan * 100);
  if (!Number.isFinite(yuan) || !Number.isSafeInteger(fen) || Math.abs(yuan - fen / 100) >= 1e-9) {
    throw new Error('Invalid yuan amount');
  }
  return fen;
}

/** 只沿自有属性取声明的金额，展开 []（可以嵌套）；缺失的选填字段不产出值，形状错误则拒绝。 */
export function catalogMoneyValues(
  payload: Readonly<Record<string, unknown>>,
  moneyFields: readonly { path: string; decimals: 0 | 2 }[],
): number[] {
  const read = (value: unknown, parts: readonly string[], path: string): number[] => {
    if (value === undefined) return [];
    if (!parts.length) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid money field: ${path}`);
      return [value];
    }
    const [part, ...rest] = parts;
    const array = part!.endsWith('[]');
    const key = array ? part!.slice(0, -2) : part!;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid money path: ${path}`);
    if (!Object.hasOwn(value, key)) return [];
    const next = (value as Record<string, unknown>)[key];
    if (!array) return read(next, rest, path);
    if (!Array.isArray(next)) throw new Error(`Invalid money array: ${path}`);
    return next.flatMap((item) => read(item, rest, path));
  };
  return moneyFields.flatMap(({ path }) => read(payload, path.split('.'), path));
}
