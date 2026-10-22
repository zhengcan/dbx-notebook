import { createApp, h, ref } from 'vue'
import PivotTable from '../analysis/PivotTable.vue'
import { buildPivotModel } from '../analysis/pivotModel'
import { resolveLabels } from '../analysis/labelResolve'
import { setLocale } from '../i18n'
import type { PivotConfig } from '@sqlnb/format'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#60a5fa',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountPivotForSmoke = (o: { theme: 'light' | 'dark' }) => {
    w.__sqlnbPivotApp?.unmount()
    setLocale('zh-CN')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0;padding:8px`)
    host.appendChild(root)
    const long = '很长的维度名称'.repeat(30)
    const pivot: PivotConfig = {
      rows: [{ field: 'region', label: long }, { field: 'flag', valueLabels: { '0': '是', '1': '否' }, nullLabel: '未知' }],
      columns: [{ field: 'month' }],
      values: [{ field: 'amt', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 2, scale: 10000, unit: '万元' } }],
      totals: { row: true, column: true, grand: true }, summaryLabel: '合计',
    }
    const rows: unknown[][] = []
    for (const r of ['华东', '华北', '华南']) for (const f of [0, 1, null]) for (let m = 1; m <= 12; m++) rows.push([r, f, 'M' + m, (m + 1) * 12345 * (f === null ? 3 : 1)])
    const res: any = { status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', long: { dims: ['region', 'flag', 'month'], measures: ['amt'], rows } }
    const resolved = resolveLabels({ pivot, chart: {} as any }, { empty: '（空）', summary: '合计' })
    const model = buildPivotModel(res, pivot, { resolved })
    const sort = ref<any>(null)
    w.__pivotEdits = []
    w.__pivotSort = () => sort.value
    w.__sqlnbPivotApp = createApp({ render: () => h(PivotTable, { model, sort: sort.value, editable: true, 'onUpdate:sort': (s: any) => { sort.value = s }, 'onEditLabel': (p: any) => w.__pivotEdits.push(p.target) }) })
    w.__sqlnbPivotApp.mount(root)
  }
}
