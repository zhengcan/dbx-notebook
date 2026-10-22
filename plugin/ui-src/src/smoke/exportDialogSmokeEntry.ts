import { createApp, h } from 'vue'
import ExportDialog from '../export/ExportDialog.vue'
import { setLocale } from '../i18n'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-destructive:#dc2626;--color-warning:#b45309',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-destructive:#f87171;--color-warning:#fbbf24',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountExportDialogForSmoke = (o: { theme: 'light' | 'dark'; locale: 'zh-CN' | 'en'; exporterName: string | null }) => {
    w.__sqlnbDialogApp?.unmount()
    setLocale(o.locale)
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0`)
    host.appendChild(root)
    const model: any = { documentTitle: '', exportedAt: '', runTimes: [], exporter: null, dataSources: [], note: '', sections: [], catalog: [], skipped: [], staleBlockIds: [], estimate: { totalRows: 0, bigTables: [] }, exportable: true }
    w.__sqlnbDialogApp = createApp({ render: () => h(ExportDialog, { model, browser: { found: true, path: '/usr/bin/chrome', checking: false }, busy: false, initialFolder: '/out', initialName: 'report.pdf', exporterName: o.exporterName }) })
    w.__sqlnbDialogApp.mount(root)
  }
}
