import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { serializeNotebook, createEmptyNotebook, parseNotebook } from '@sqlnb/format'
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'

const OLD_TITLE = 'LEGACY-TITLE-SENTINEL'
const CONN = 'CONN-SENTINEL-HOST'
function oldFile() {
  const nb = createEmptyNotebook() as any
  nb.metadata = { ...(nb.metadata ?? {}), title: OLD_TITLE }
  nb.blocks.push(
    { id: 'i1', type: 'input', content: '', metadata: { variable: 'region', inputType: 'text', value: 'EU' } },
    { id: 'm1', type: 'markdown', content: 'FIRST-BLOCK', metadata: {} },
    { id: 'i2', type: 'input', content: '', metadata: { variable: 'owner', inputType: 'text', value: '' } },
    { id: 'm2', type: 'markdown', content: 'SECOND-BLOCK', metadata: {} },
  )
  return serializeNotebook(nb)
}

describe('export + connections polish integration', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  const q = (k: string) => document.querySelector(`[data-test=${k}]`) as HTMLElement | null
  const click = async (el: Element | null | undefined) => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }

  async function run(user: () => unknown) {
    setLocale('en')
    const written: string[] = []
    const writes: string[] = []
    const bridge: any = createFakeBridge({
      invokeHandlers: {
        'notebook/recent': () => ({ items: [] }),
        'notebook/read': () => ({ text: oldFile(), mtimeMs: 1 }),
        'notebook/write': (p: any) => { writes.push(p.text); return { mtimeMs: 2 } },
        'notebook/touchRecent': () => ({}),
        'export/browserStatus': () => ({ found: true, path: '/c', source: 'auto' }),
        'export/pickFolder': () => ({ path: '/o' }),
        'system/user': user,
        'export/saveHtml': (p: any) => { written.push(p.html); return { path: '/o/r.html', bytes: 5 } },
      },
    } as any)
    const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
    await flushPromises()
    await w.find('.sp-path input').setValue('/n/a.sqlnb')
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
    await w.find('[data-test=export]').trigger('click'); await flushPromises()
    await click(q('fmt-html')); await click(q('choose'))
    await click(q('go'))
    return { w, written, writes, bridge }
  }

  it('input lines in place, info block last, no title, no aggregate; failing exporter route still exports', async () => {
    const { w, written } = await run(() => { throw new Error('nope') })
    const html = written[0]
    expect(html).toBeDefined()
    const pos = ['region', 'FIRST-BLOCK', 'owner', 'SECOND-BLOCK', 'info-sep', 'export-info'].map((s) => html.indexOf(s, html.indexOf('<body')))
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    expect(html).toContain('class="in-var"')
    expect(html).not.toContain(OLD_TITLE)
    expect(html).not.toContain('<h1')
    expect(html).not.toContain(CONN)
    w.unmount()
  })

  it('old-file title survives an edit+save but never reaches the export', async () => {
    const { w, writes } = await run(() => ({ name: 'u' }))
    document.querySelectorAll('.cd-btn').forEach((b) => (b as HTMLElement).click())
    await flushPromises()
    ;(w.vm as any).store.addBlock('markdown', null)
    await flushPromises()
    await w.find('[data-test=save]').trigger('click')
    await flushPromises()
    expect(writes.length).toBeGreaterThan(0)
    expect((parseNotebook(writes[writes.length - 1]) as any).metadata?.title ?? JSON.parse(writes[writes.length - 1]).metadata?.title).toBe(OLD_TITLE)
    w.unmount()
  })
})
