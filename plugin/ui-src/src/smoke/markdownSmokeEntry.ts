import { createApp, h, ref } from 'vue'
import MarkdownBlock from '../blocks/MarkdownBlock.vue'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#1f2328;--color-muted:#f6f8fa;--color-muted-foreground:#656d76;--color-border:#d0d7de;--color-primary:#0969da',
  dark: '--color-background:#1a1a1a;--color-foreground:#eeeeee;--color-muted:#2a2a2a;--color-muted-foreground:#a1a1aa;--color-border:#444;--color-primary:#58a6ff',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountMdForSmoke = (o: { theme: 'light' | 'dark'; value: string; width?: number; spacer?: number }) => {
    w.__sqlnbMdApp?.unmount()
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.className = 'app'
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;padding:8px;width:${o.width ?? 720}px`)
    root.innerHTML = `<div id="prev" style="height:40px">above</div><div id="blk"></div><div id="next" style="height:40px">below</div><div style="height:${o.spacer ?? 0}px"></div>`
    host.appendChild(root)
    const value = ref(o.value)
    w.__sqlnbMdSetValue = (v: string) => { value.value = v }
    w.__sqlnbMdApp = createApp({ render: () => h(MarkdownBlock, { modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v } }) })
    w.__sqlnbMdApp.mount(root.querySelector('#blk')!)
  }
}
