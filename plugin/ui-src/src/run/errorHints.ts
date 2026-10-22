export function splitDbxBoilerplate(message: string): { main: string; redacted?: string } {
  const m = /SQL text omitted from user-facing error[^.]*\.?/i.exec(message)
  if (!m) return { main: message.trim() }
  return { main: message.slice(0, m.index).trim(), redacted: message.slice(m.index).trim() }
}

export function isMissingObjectError(message: string): boolean {
  return /does not exist|doesn't exist|不存在|unknown (table|database|column)|undefined (table|column)|no such table|invalid object name/i.test(message)
}
