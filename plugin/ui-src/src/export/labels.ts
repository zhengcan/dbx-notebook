import type { ExportLabels } from './html'
import { compareText } from '../analysis/compareText'

// The report language follows the UI locale: callers pass the current-locale `t`.
export function buildExportLabels(t: (key: string, params?: Record<string, unknown>) => string): ExportLabels {
  return {
    firstN: (n, m) => t('exp.lbl.firstN', { n, m }),
    truncatedAtRun: (k) => t('exp.lbl.truncatedAtRun', { k }),
    empty: t('exp.lbl.empty'),
    exportedAt: t('exp.hExportedAt'),
    dataRunAt: t('exp.hRunAt'),
    dataSource: t('exp.hDataSource'),
    exporter: t('exp.lbl.exporter'),
    chartUnavailable: t('exp.lbl.chartUnavailable'),
    noData: t('exp.lbl.noData'),
    page: t('exp.lbl.page'),
    serial: t('exp.lbl.serial'),
    summary: t('exp.lbl.summary'),
    continued: t('exp.lbl.continued'),
    notSet: t('exp.lbl.notSet'),
    colon: t('exp.lbl.colon'),
    listSep: t('exp.lbl.listSep'),
    compare: (c) => compareText(c, t),
  }
}
