import { createApp, h, ref } from 'vue'
import LabelsPreview from '../analysis/LabelsPreview.vue'
import { setLocale } from '../i18n'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#60a5fa',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountPreviewForSmoke = (o: { theme: 'light' | 'dark'; width: number; active: unknown }) => {
    w.__pvApp?.unmount()
    setLocale('zh-CN')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0;overflow:auto`)
    const box = document.createElement('div')
    box.setAttribute('style', `margin:16px;width:${o.width}px;box-sizing:border-box`)
    root.appendChild(box)
    host.appendChild(root)
    const cfg = {
      pivot: {
        rows: [{ field: 'region', label: '<img src=x onerror=alert(1)>' + 'x'.repeat(200), valueLabels: { '0': '否', a: 'مبيعات 🚀 {{x}}' }, nullLabel: '未知' }],
        columns: [{ field: 'q', label: '&amp;"季度"' }],
        values: [{ field: 'amount', agg: 'sum', label: '销售额', format: { kind: 'thousands', unit: '万元', scale: 10000 } }, { field: 'cost', agg: 'sum', label: '成本' }],
        summaryLabel: '合计',
      },
      chart: { type: 'bar', title: '<b>标题</b>' + 'y'.repeat(200), axisTitles: { x: 'X', y: 'Y', legend: 'L' } },
    }
    const active = ref<unknown>(o.active)
    w.__pvSetActive = (a: unknown) => { active.value = a }
    w.__pvApp = createApp({ render: () => h(LabelsPreview as any, { cfg, ctx: { empty: '(空)', summary: '汇总' }, categories: { rows: [['0', 'a', null]], columns: [['Q1', 'Q2']] }, active: active.value }) })
    w.__pvApp.mount(box)
  }
}
