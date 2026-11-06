/** 18 R5：无 I/O、无行业依赖；编号归一规则由包传入。 */
export function tokenize(text: string, normalize: (value: string) => string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.normalize('NFKC').match(/[\p{Script=Han}]+|[A-Za-z0-9]+(?:[_/*×✕.-]+[A-Za-z0-9]+)*/gu) ?? []) {
    if (/\p{Script=Han}/u.test(chunk)) {
      for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2));
      if (chunk.length === 1) tokens.push(chunk);
    } else {
      const token = normalize(chunk);
      if (token) tokens.push(token);
    }
  }
  return tokens;
}
export interface KeywordIndex {
  lengths: ReadonlyMap<string, number>;
  postings: ReadonlyMap<string, ReadonlyMap<string, number>>;
}
export interface RankedHit {
  id: string;
  score: number;
}
export function buildKeywordIndex(documents: readonly { id: string; text: string }[], normalize: (value: string) => string): KeywordIndex {
  const lengths = new Map<string, number>();
  const postings = new Map<string, Map<string, number>>();
  for (const doc of documents) {
    const tokens = tokenize(doc.text, normalize);
    lengths.set(doc.id, tokens.length);
    for (const token of tokens) {
      let posting = postings.get(token);
      if (!posting) postings.set(token, (posting = new Map()));
      posting.set(doc.id, (posting.get(doc.id) ?? 0) + 1);
    }
  }
  return { lengths, postings };
}
/** BM25 的统计量也只取候选集；k1=1.2、b=0.75，空/零分文档不召回。 */
export function bm25(index: KeywordIndex, tokens: readonly string[], candidates: ReadonlySet<string>): RankedHit[] {
  if (!candidates.size) return [];
  let total = 0;
  for (const id of candidates) total += index.lengths.get(id) ?? 0;
  const average = total / candidates.size || 1;
  const scores = new Map<string, number>();
  for (const token of new Set(tokens)) {
    const posting = index.postings.get(token);
    if (!posting) continue;
    let df = 0;
    for (const id of posting.keys()) if (candidates.has(id)) df++;
    const idf = Math.log(1 + (candidates.size - df + 0.5) / (df + 0.5));
    for (const [id, tf] of posting) {
      if (!candidates.has(id)) continue;
      const denominator = tf + 1.2 * (0.25 + (0.75 * (index.lengths.get(id) ?? 0)) / average);
      scores.set(id, (scores.get(id) ?? 0) + (idf * tf * 2.2) / denominator);
    }
  }
  return [...scores].map(([id, score]) => ({ id, score })).toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
/** 每路每个 id 只计一次；同分的业务顺序由调用者提供。 */
export function rrf(rankings: readonly (readonly RankedHit[])[], tie: (a: string, b: string) => number): RankedHit[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    let rank = 0;
    for (const { id } of ranking) {
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + ++rank));
    }
  }
  return [...scores].map(([id, score]) => ({ id, score })).toSorted((a, b) => b.score - a.score || tie(a.id, b.id));
}
