export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME_RE.test(name)
}
