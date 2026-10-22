import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChatPane from '../src/ai/ChatPane.vue'

let ws: VueWrapper[] = []
afterEach(() => { ws.forEach((w) => w.unmount()); ws = []; document.body.innerHTML = '' })
const mk = (role: 'user' | 'assistant', text: string, busy = false) => {
  const w = mount(ChatPane, { props: { messages: [{ id: 'm', role, at: 1, parts: [{ kind: 'text', text }] }], busy, progress: '', error: '', rawOutput: '', placeholder: 'p' }, attachTo: document.body })
  ws.push(w)
  return w
}
const md = (text: string) => mk('assistant', text).find('[data-test=chat-md]')

describe('chat markdown', () => {
  it('strips scripts, raw html, dangerous links and images', () => {
    const w = md('<script>window.__x=1</script>\n\n<img src=x onerror="window.__x=1">\n\n<iframe src="https://e"></iframe>\n\n<b style="color:red">b</b>\n\n[a](javascript:alert(1)) [d](data:text/html,hi) ![t](https://evil/x.png)')
    const el = w.element as HTMLElement
    expect(el.querySelector('script,iframe,img,[style],[onerror]')).toBeNull()
    expect(el.querySelector('a[href^="javascript"],a[href^="data"]')).toBeNull()
    expect((window as any).__x).toBeUndefined()
  })
  it('hostile fenced code stays inert text', () => {
    const el = md('```html\n<script>x</script><img src=x onerror=y>\n```').element as HTMLElement
    expect(el.querySelector('script,img')).toBeNull()
    expect(el.textContent).toContain('<script>')
  })
  it('user markdown stays literal', () => {
    const w = mk('user', '**bold** <b>x</b>')
    expect(w.find('strong,b').exists()).toBe(false)
    expect(w.find('.txt').text()).toBe('**bold** <b>x</b>')
  })
  it('renders list, table (scrollable), sql highlighting', () => {
    const w = md('- a\n- b\n\n| h |\n|---|\n| c |\n\n```sql\nSELECT 1\n```')
    expect(w.find('ul li').exists()).toBe(true)
    expect(w.find('.tbl[tabindex="0"] table').exists()).toBe(true)
    expect(w.find('.sql-keyword').exists()).toBe(true)
  })
  it('links safe and keyboard reachable', () => {
    const a = md('see http://a.b and [m](mailto:x@y.z)').find('a')
    expect(a.attributes('rel')).toContain('noopener')
    expect(a.attributes('target')).toBeUndefined()
    expect(a.attributes('tabindex')).toBeUndefined()
    expect(md('[m](mailto:x@y.z)').find('a[href]').exists()).toBe(false)
  })
  it('streams plain then renders on completion', async () => {
    const w = mk('assistant', 'a **b**', true)
    expect(w.find('strong').exists()).toBe(false)
    expect(w.text()).toContain('**b**')
    await w.setProps({ busy: false })
    expect(w.find('strong').exists()).toBe(true)
  })
  it('long message renders fast', () => {
    const t0 = performance.now()
    md(Array.from({ length: 2000 }, (_, i) => `- item **${i}**`).join('\n'))
    expect(performance.now() - t0).toBeLessThan(3000)
  })
  it('markdown-only reply is not empty', () => {
    expect(md('# T').text()).toBe('T')
  })
})

describe('chat markdown contrast guard while streaming', () => {
  it('attaches when the bubble first mounts streaming and later finishes', async () => {
    const { default: MarkdownMessage } = await import('../src/ai/MarkdownMessage.vue')
    const w = mount(MarkdownMessage, { props: { text: '```sql\nselect 1\n```', streaming: true }, attachTo: document.body })
    ws.push(w as any)
    await w.setProps({ streaming: false })
    await new Promise((r) => setTimeout(r, 20))
    expect((w.find('[data-test=chat-md]').element as HTMLElement).style.getPropertyValue('--sql-keyword')).not.toBe('')
  })
})
