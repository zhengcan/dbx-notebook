export const SEARCH_CAP = 200
const norm = (s: string) => s.normalize('NFC').toLocaleLowerCase()
export const normQuery = (q: string) => norm(q.trim())
export const matchesText = (q: string, ...texts: (string | undefined)[]) => q === '' || texts.some((s) => s !== undefined && norm(s).includes(q))

export function filterCategories(keys: string[], valueLabels: Record<string, string> | undefined, query: string, cap: number): { keys: string[]; total: number; capped: boolean } {
  const q = normQuery(query)
  if (q === '') return { keys: keys.slice(0, cap), total: keys.length, capped: keys.length > cap }
  const out: string[] = []
  let total = 0
  for (const k of keys) {
    const lab = valueLabels && Object.prototype.hasOwnProperty.call(valueLabels, k) ? valueLabels[k] : undefined
    if (matchesText(q, k, lab)) { total++; if (out.length < cap) out.push(k) }
  }
  return { keys: out, total, capped: total > cap }
}
