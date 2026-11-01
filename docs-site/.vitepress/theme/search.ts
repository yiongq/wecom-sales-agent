export interface SearchEntry {
  title: string;
  href: string;
  text: string;
}
export function searchGuides(entries: SearchEntry[], query: string): SearchEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries.filter((entry) => words.every((word) => `${entry.title} ${entry.text}`.toLocaleLowerCase().includes(word)));
}
export async function loadSearch(fetcher: typeof fetch, url: string): Promise<SearchEntry[]> {
  const response = await fetcher(url, { credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('search_unavailable');
  const value: unknown = await response.json();
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry.title !== 'string' || typeof entry.href !== 'string' || typeof entry.text !== 'string')
  )
    throw new Error('search_invalid');
  return value;
}
