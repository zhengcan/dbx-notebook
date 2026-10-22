import { createApp, h, ref } from 'vue'
import LabelsPreview from '../analysis/LabelsPreview.vue'
import { labelTargetId } from '../analysis/labelTargetId'
import { numberRows } from '../analysis/labelTabs'
import { setLocale } from '../i18n'
import type { LabelTarget } from '../analysis/labelResolve'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#60a5fa',
}
type Tab = 'table' | 'chart' | 'numbers' | 'categories'

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountBadgesForSmoke = (o: { theme: 'light' | 'dark'; width: number; tab: Tab; hostile?: boolean; badges?: boolean }) => {
    w.__pbApp?.unmount()
    setLocale('zh-CN')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0;overflow:auto`)
    const box = document.createElement('div')
    box.setAttribute('style', `margin:16px;width:${o.width}px;box-sizing:border-box`)
    root.appendChild(box)
    host.appendChild(root)
    const bad = (s: string, long = false) => (o.hostile ? (long ? '<img src=x onerror=alert(1)>' + 'x'.repeat(120) : s) : s)
    const cfg = {
      pivot: {
        rows: [{ field: 'region', label: bad('大区'), valueLabels: { a: bad('مبيعات 🚀') }, nullLabel: '未知' }, { field: 'city', label: '城市' }],
        columns: [{ field: 'q', label: '季度', valueLabels: { Q1: '一季' }, nullLabel: '无' }, { field: 'ch', label: '渠道' }],
        values: [{ field: 'amount', agg: 'sum', label: bad('销售额', true), format: { kind: 'thousands', unit: '万元', scale: 10000 } }, { field: 'cost', agg: 'sum', label: '成本', format: { kind: 'thousands', unit: '元' } }],
        summaryLabel: bad('合计', true),
      },
      chart: { type: 'bar', title: bad('标题', true), axisTitles: { x: 'X轴', y: 'Y轴', legend: '图例' } },
    }
    const categories = { rows: [['d1', 'd2', 'd3', 'a', 'k5', 'k6', null], ['c1', 'c2']], columns: [['Q1', 'Q2', null], ['o1', 'o2']] }
    const T: Record<Tab, LabelTarget[]> = {
      table: [{ kind: 'rowName', index: 0 }, { kind: 'rowName', index: 1 }, { kind: 'columnName', index: 0 }, { kind: 'columnName', index: 1 }, { kind: 'measureName', index: 0 }, { kind: 'measureName', index: 1 }, { kind: 'summary' }],
      chart: [{ kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }],
      numbers: [{ kind: 'unit', index: 0 }, { kind: 'scale', index: 0 }, { kind: 'unit', index: 1 }, { kind: 'scale', index: 1 }],
      categories: [
        { kind: 'category', axis: 'row', index: 0, key: 'k5' }, { kind: 'category', axis: 'row', index: 0, key: 'k6' }, { kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'nullLabel', axis: 'row', index: 0 },
        { kind: 'category', axis: 'row', index: 1, key: 'c1' }, { kind: 'category', axis: 'column', index: 0, key: 'Q1' }, { kind: 'nullLabel', axis: 'column', index: 0 }, { kind: 'category', axis: 'column', index: 1, key: 'o1' },
      ],
    }
    const map = numberRows(T[o.tab].map((t) => ({ id: labelTargetId(t) })))
    w.__pbTargets = T[o.tab].map((t) => ({ id: labelTargetId(t), n: map.get(labelTargetId(t)) }))
    const numbers = ref<Map<string, number> | undefined>(o.badges === false ? undefined : new Map(map))
    w.__pbSetBadges = (on: boolean) => { numbers.value = on ? new Map(map) : undefined }
    w.__pbApp = createApp({ render: () => h(LabelsPreview as any, { cfg, ctx: { empty: '(空)', summary: '汇总' }, categories, active: null, numbers: numbers.value }) })
    w.__pbApp.mount(box)
  }
}
