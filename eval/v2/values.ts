export interface Values {
  calls: Map<string, unknown>;
  orders: () => unknown[];
}

function field(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** 整串占位保留值类型（工具的数字参数）；混合文字占位按字符串插入。 */
export function resolveValues(value: unknown, values: Values, nativeWhole = true): unknown {
  if (typeof value === 'string') {
    const resolve = (raw: string, kind: string, name: string, path: string): unknown => {
      const base = kind === 'call' ? values.calls.get(name) : values.orders()[Number(name)];
      const found = field(base, path);
      if (found === undefined) throw new Error(`占位解析不到：${raw}`);
      return found;
    };
    const pattern = /\{\{(call|order):([^.{}]+)\.([^{}]+)\}\}/g;
    const all = [...value.matchAll(pattern)];
    if (nativeWhole && all.length === 1 && all[0][0] === value) return resolve(all[0][0], all[0][1], all[0][2], all[0][3]);
    const replaced = value.replace(pattern, (raw, kind: string, name: string, path: string) => String(resolve(raw, kind, name, path)));
    const malformed = replaced.match(/\{\{(?:call|order):[^}]*\}\}/);
    if (malformed) throw new Error(`占位解析不到：${malformed[0]}`);
    return replaced;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValues(v, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValues(v, values)]));
  return value;
}

/** v1 方案链接不带版本；v2+ 的 ?v=N / &v=N 都去掉，保留其它查询参数。 */
export function normalize(text: string): string {
  return text
    .replace(/ord_[0-9a-f]{24}/g, 'ord_NORMALIZED')
    .replace(/(\\?)([?&])v=\d+(&?)/g, (_raw, escape: string, lead: string, tail: string) => (tail ? escape + lead : ''));
}

/** 回复断言仍是正则；插入的动态值按字面量匹配，避免链接或标题改变正则含义。 */
export function resolvePattern(pattern: string, values: Values): string {
  return normalize(
    pattern.replace(/\{\{(?:call|order):[^}]+\}\}/g, (raw) =>
      normalize(String(resolveValues(raw, values))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ),
  );
}
