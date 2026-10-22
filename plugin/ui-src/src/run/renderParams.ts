import { renderSql, ParamError } from '@sqlnb/format'
import type { useNotebookStore, BlockRunState } from '../state/notebookStore'
import { t } from '../i18n'

type Store = ReturnType<typeof useNotebookStore>
type ParamCode = NonNullable<NonNullable<BlockRunState['error']>['paramCode']>

export type RenderedParams =
  | { ok: true; sql: string; used: Record<string, unknown> }
  | { ok: false; message: string; variable?: string; paramCode: ParamCode }

export function renderBlockParams(store: Store, sql: string, dbType: string): RenderedParams {
  try {
    const vars = store.inputVars().map((v) => (v.value === '' ? { ...v, value: undefined } : v))
    const r = renderSql(sql, vars, dbType)
    return { ok: true, sql: r.sql, used: r.used }
  } catch (e) {
    if (!(e instanceof ParamError)) throw e
    const name = e.variable ?? ''
    const message =
      e.code === 'UNRESOLVED' ? t('param.unresolved', { name })
      : e.code === 'UNSET' ? t('param.unset', { name })
      : e.code === 'FORBIDDEN_POSITION' ? t('param.forbidden', { name, offset: e.offset ?? 0 })
      : e.code === 'DUPLICATE' ? t('param.duplicate', { name })
      : t('param.invalid', { name })
    return { ok: false, message, variable: e.variable, paramCode: e.code as ParamCode }
  }
}
