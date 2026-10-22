import { createApp, h, provide, ref } from 'vue'
import StartPage from '../shell/StartPage.vue'
import { ExportClientKey, ExportSettingsKey } from '../injection'
import { setLocale } from '../i18n'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#171717;--color-destructive:#dc2626',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#fafafa;--color-destructive:#f87171',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountStartPageForSmoke = (o: { theme: 'light' | 'dark'; locale: 'zh-CN' | 'en'; path: string; bad: boolean; pick?: string }) => {
    w.__sqlnbStartApp?.unmount()
    setLocale(o.locale)
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;min-height:100vh`)
    host.appendChild(root)
    const browserPath = ref(o.path)
    const settings: any = { browserPath, load: async () => {}, setBrowserPath: async (p: string) => { browserPath.value = p.trim() } }
    const client: any = {
      browserStatus: async (m?: string) => (m && o.bad ? { found: false, source: 'manual', code: 'notFound', reason: 'x' } : { found: true, path: m || '/usr/bin/chrome', source: m ? 'manual' : 'auto' }),
      pickBrowser: async (kind: string) => (o.pick ? { path: o.pick + '/' + kind } : { cancelled: true }),
    }
    const Root = { setup() { provide(ExportSettingsKey as any, settings); provide(ExportClientKey as any, client); return () => h(StartPage, { recent: [], hasSidecar: true }) } }
    w.__sqlnbStartApp = createApp(Root)
    w.__sqlnbStartApp.mount(root)
  }
}
