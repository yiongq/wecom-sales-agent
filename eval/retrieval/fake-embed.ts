/** 确定性的字符 1/2/3-gram 哈希，仅用于离线评测；不模拟真实语义质量。 */
export function fakeEmbed(text: string, dimensions = 256): number[] {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('无效维度');
  const vector = Array<number>(dimensions).fill(0);
  const normalized = text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s\-_/]/g, '');
  for (let n = 1; n <= 3; n++) {
    for (let start = 0; start <= normalized.length - n; start++) {
      let hash = 2166136261;
      for (const char of normalized.slice(start, start + n)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
      vector[hash % dimensions]! += 1;
    }
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}
export function fakeCosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('维度不一致');
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
