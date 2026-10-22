import { t, type MessageKey } from '../i18n'

const RULES = ['cast_operator', 'ilike', 'distinct_on', 'filter_clause', 'within_group', 'regex_operator']

export function engineHintText(rule: string | undefined): string | undefined {
  if (!rule || !RULES.includes(rule)) return undefined
  return t(`hint.${rule}` as MessageKey)
}
