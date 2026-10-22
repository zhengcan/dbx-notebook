export function dateComparisonHint(sql: string, vars: { name: string; inputType: string }[]): boolean {
  if (!sql.includes('{{')) return false
  for (const v of vars) {
    if (v.inputType !== 'date') continue
    const name = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const ph = `\\{\\{\\s*${name}\\s*\\}\\}`
    const re = new RegExp(`(?:<=|(?<![<>!=])==?(?!=)|\\bBETWEEN\\b[^;]*?\\bAND\\b)\\s*${ph}`, 'i')
    if (re.test(sql)) return true
  }
  return false
}
