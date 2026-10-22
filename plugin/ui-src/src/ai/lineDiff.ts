export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

const MAX_LINES = 2000
const lines = (s: string) => (s === '' ? [] : s.split(/\r\n|\r|\n/))

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = lines(a)
  const y = lines(b)
  if (x.length > MAX_LINES || y.length > MAX_LINES) {
    return [...x.map((text) => ({ kind: 'del' as const, text })), ...y.map((text) => ({ kind: 'add' as const, text }))]
  }
  const n = x.length
  const m = y.length
  const w = m + 1
  const dp = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ kind: 'del', text: x[i++] })
    else out.push({ kind: 'add', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] })
  while (j < m) out.push({ kind: 'add', text: y[j++] })
  return out
}
