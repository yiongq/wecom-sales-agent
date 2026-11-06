import type { Part } from './catalog.js';

export interface AttributeVocabulary {
  values: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  categories: readonly string[];
}
export interface Attributes {
  category?: string;
  values: { key: string; value: string }[];
}
const compact = (text: string) => text.normalize('NFKC').toUpperCase().replace(/\s/g, '');
/** 只收库里确实有的规格；不把纯描述文字误拆成硬条件。 */
export function buildAttributes(parts: readonly Part[]): AttributeVocabulary {
  const values = new Map<string, Map<string, Set<string>>>();
  for (const part of parts) {
    for (const spec of part.specs) {
      const match = /^(.+?)(IP\d+|M\d+(?:[×X*]\d+(?:\.\d+)?)?|(?:AC|DC)?\d+(?:\.\d+)?(?:MM|CM|MPA|KV|MA|KW|HZ|V|A|W|M))$/.exec(
        compact(spec),
      );
      if (!match) continue;
      const [, key, value] = match;
      let byValue = values.get(key!);
      if (!byValue) values.set(key!, (byValue = new Map()));
      let ids = byValue.get(value!);
      if (!ids) byValue.set(value!, (ids = new Set()));
      ids.add(part.id);
    }
  }
  return { values, categories: [...new Set(parts.map((p) => p.category))] };
}
/** 多个键可解释同一无标签数值、或同一键出现冲突值时，舍弃该条件。 */
export function parseAttributes(query: string, vocabulary: AttributeVocabulary): Attributes {
  const text = query
    .normalize('NFKC')
    .toUpperCase()
    .replace(/(\d)\s+(MM|CM|MPA|KV|MA|KW|HZ|V|A|W|M)(?![A-Z])/g, '$1$2');
  const categories = vocabulary.categories.filter((name) => text.includes(compact(name)));
  const found = new Map<string, Set<string>>();
  const add = (key: string, value: string) => {
    let set = found.get(key);
    if (!set) found.set(key, (set = new Set()));
    set.add(value);
  };
  const labeled = new Set<string>();
  const uncertain = new Set<string>();
  for (const [key, values] of vocabulary.values) {
    // 标签后紧跟数值，或「25 内径」；只有库里同数值对应唯一单位才接受省略单位。
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const after = new RegExp(`${escaped}\\s*((?:AC|DC|IP|M)?\\d+(?:\\.\\d+)?(?:[A-Z]+)?)`, 'g');
    const before = new RegExp(`(?<![A-Z0-9.])((?:AC|DC|IP|M)?\\d+(?:\\.\\d+)?(?:[A-Z]+)?)\\s*${escaped}`, 'g');
    const reversed = [...text.matchAll(before)].filter((match) => {
      // 「内径25mm 外径52mm」中的 25mm 属于前一个标签，不是外径的逆序写法。
      const prefix = text.slice(0, match.index).trimEnd();
      return ![...vocabulary.values.keys()].some((label) => prefix.endsWith(label));
    });
    for (const match of [...text.matchAll(after), ...reversed]) {
      const raw = match[1]!;
      const candidates = [...values.keys()].filter((v) => v === raw || (/^\d+(?:\.\d+)?$/.test(raw) && v.replace(/[A-Z]+$/, '') === raw));
      if (candidates.length === 1) {
        add(key, candidates[0]!);
        labeled.add(candidates[0]!);
      } else uncertain.add(key);
    }
  }
  for (const match of text.matchAll(
    /(?<![A-Z0-9.])(?:IP\d+|M\d+(?:[×X*]\d+(?:\.\d+)?)?|(?:AC|DC)?\d+(?:\.\d+)?(?:MM|CM|MPA|KV|MA|KW|HZ|V|A|W|M))(?![A-Z0-9.])/g,
  )) {
    const value = match[0];
    if (labeled.has(value)) continue;
    const keys = [...vocabulary.values].filter(([, values]) => values.has(value)).map(([key]) => key);
    if (keys.length === 1) add(keys[0]!, value);
  }
  return {
    ...(categories.length === 1 ? { category: categories[0] } : {}),
    values: [...found].flatMap(([key, values]) => (values.size === 1 && !uncertain.has(key) ? [{ key, value: [...values][0]! }] : [])),
  };
}
export function filterAttributes(parts: readonly Part[], attrs: Attributes, vocabulary: AttributeVocabulary): Part[] {
  return parts.filter((part) => attrs.values.every(({ key, value }) => vocabulary.values.get(key)?.get(value)?.has(part.id)));
}
