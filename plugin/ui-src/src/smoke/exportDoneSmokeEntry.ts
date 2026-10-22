import { createApp, h } from 'vue'
import ConfirmDialog from '../shell/ConfirmDialog.vue'
import { createDialogHost, buildExportDoneDialog } from '../shell/dialogHost'
import { setLocale, t } from '../i18n'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#1d4ed8;--color-primary-foreground:#ffffff;--color-destructive:#b91c1c',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#3b82f6;--color-primary-foreground:#0a0a0a;--color-destructive:#f87171',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbOpenCalls = 0
  w.__sqlnbDoneResult = null
  w.__sqlnbMountExportDoneForSmoke = (o: { theme: 'light' | 'dark'; locale: 'zh-CN' | 'en'; failOpen: boolean | 'network' }) => {
    w.__sqlnbDoneApp?.unmount()
    w.__sqlnbOpenCalls = 0
    w.__sqlnbDoneResult = null
    setLocale(o.locale)
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0`)
    host.appendChild(root)
    const dh = createDialogHost()
    w.__sqlnbDoneApp = createApp({
      render: () => h(ConfirmDialog, { open: dh.dlg.value !== null, title: dh.dlg.value?.title ?? '', message: dh.dlg.value?.message ?? '', buttons: dh.dlg.value?.buttons ?? [], initialFocus: dh.dlg.value?.initialFocus, error: dh.error.value, onChoose: dh.choose }),
    })
    w.__sqlnbDoneApp.mount(root)
    const spec = buildExportDoneDialog({
      path: '/out/report.pdf',
      client: { openFile: async () => { w.__sqlnbOpenCalls++; if (o.failOpen === 'network') throw new Error('[-32051] network'); if (o.failOpen) throw new Error('x') } },
      labels: { ok: t('dlg.ok'), open: t('exp.openFile'), openFailed: t('exp.openFailed'), openUnsupported: t('exp.openNetwork') },
    })
    void dh.ask(t('exp.doneTitle'), t('exp.doneMsg', { path: '/out/report.pdf' }), spec.buttons, spec.initialFocus, spec.guard).then((r) => { w.__sqlnbDoneResult = r })
  }
}
