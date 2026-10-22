import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { runExport } from '../src/export/runExport'
import { buildExportLabels } from '../src/export/labels'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'
import { setLocale, t } from '../src/i18n'
import { renderMarkdownForExport, createImageBudget, EXPORT_IMAGE_BUDGET } from '../src/export/markdown'
import { ImageError, type LoadedImage } from '../src/files/imageClient'

const li = (n: number, len = 20): LoadedImage => ({ mime: 'image/png', dataUri: 'data:image/png;base64,' + 'A'.repeat(len) + n, size: 10, mtimeMs: 1, width: 4, height: 3 })
const NB = '/n/a.sqlnb'
const srcs = (html: string) => Array.from(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img')).map((i) => i.getAttribute('src'))

describe('renderMarkdownForExport', () => {
  it('embeds relative images as data URIs; nothing but data: remains', async () => {
    const client = vi.fn(async (_n: string, rel: string) => li(rel.length))
    const r = await renderMarkdownForExport('![a](pic.png) and ![b](assets/b.png) ![c](https://x/y.png) ![d](../up.png)', { notebookPath: NB, client })
    expect(r.embedded).toBe(2)
    expect(r.skipped).toBe(0)
    expect(srcs(r.html).length).toBe(2)
    for (const s of srcs(r.html)) expect(s).toMatch(/^data:image\/png;base64,/)
    expect(r.html).not.toContain('data-sqlnb-src')
    expect(r.html).not.toMatch(/\ssrc="(?!data:)/)
    expect(r.html).not.toContain('https://x/y.png')
    expect(client.mock.calls.map((c) => c[1])).toEqual(['pic.png', 'assets/b.png'])
    expect(client.mock.calls.every((c) => c[0] === NB)).toBe(true)
  })
  it('inline data images stay and are not counted', async () => {
    const r = await renderMarkdownForExport('![a](data:image/png;base64,AAAA)', { notebookPath: NB, client: vi.fn() })
    expect(r).toMatchObject({ embedded: 0, skipped: 0 })
    expect(srcs(r.html)).toEqual(['data:image/png;base64,AAAA'])
  })
  it('over the total budget becomes alt text and is counted', async () => {
    const budget = createImageBudget(100)
    const client = async (_n: string, rel: string) => li(Number(rel[0]), 50)
    const r = await renderMarkdownForExport('![one](1.png) ![two](2.png) ![three](3.png)', { notebookPath: NB, client, budget })
    expect(r.embedded).toBe(1)
    expect(r.skipped).toBe(2)
    expect(r.html).toContain('<span class="sqlnb-img-missing">two</span>')
    expect(r.html).toContain('<span class="sqlnb-img-missing">three</span>')
    expect(budget.remaining).toBeGreaterThanOrEqual(0)
  })
  it('the default budget is 50 MiB and is shared via the budget object', async () => {
    expect(EXPORT_IMAGE_BUDGET).toBe(50 * 1024 * 1024)
    const budget = createImageBudget(60)
    const client = async () => li(1, 30)
    const a = await renderMarkdownForExport('![a](a.png)', { notebookPath: NB, client, budget })
    const b = await renderMarkdownForExport('![b](b.png)', { notebookPath: NB, client, budget })
    expect([a.embedded, b.embedded, b.skipped]).toEqual([1, 0, 1])
  })
  it('failures become alt text and count', async () => {
    const client = async (_n: string, rel: string) => { if (rel === 'bad.png') throw new ImageError('unsupported'); if (rel === 'gone.png') throw new ImageError('notFound'); return li(1) }
    const r = await renderMarkdownForExport('![ok](ok.png) ![bad](bad.png) ![gone](gone.png)', { notebookPath: NB, client })
    expect([r.embedded, r.skipped]).toEqual([1, 2])
    expect(r.html).toContain('class="sqlnb-img-missing">bad<')
    expect(r.html).toContain('class="sqlnb-img-missing">gone<')
    expect(r.html).not.toMatch(/bad\.png|gone\.png/)
  })
  it('unsaved notebook: all relative images are alt text, no client calls', async () => {
    const client = vi.fn()
    const r = await renderMarkdownForExport('![a](a.png) ![b](b.png)', { notebookPath: null, client })
    expect(client).not.toHaveBeenCalled()
    expect([r.embedded, r.skipped]).toEqual([0, 2])
    expect(srcs(r.html)).toEqual([])
    expect(r.html).toContain('>a<')
  })
  it('hostile alt text stays escaped', async () => {
    const r = await renderMarkdownForExport('![&quot;><script>x</script>](a.png)', { notebookPath: NB, client: async () => { throw new ImageError('notFound') } })
    expect(r.html).not.toContain('<script')
  })
  it('an oversized inline data image is skipped as alt text', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024 + 4)
    const r = await renderMarkdownForExport(`![huge](${big})`, { notebookPath: NB, client: vi.fn() })
    expect([r.embedded, r.skipped]).toEqual([0, 1])
    expect(r.html).toContain('sqlnb-img-missing">huge<')
    expect(r.html).not.toContain('base64')
  })
  it('keeps code highlighting', async () => {
    const r = await renderMarkdownForExport('```sql\nSELECT 1\n```', { notebookPath: NB, client: vi.fn() })
    expect(r.html).toContain('language-sql')
  })
})

describe('runExport embeds Markdown images', () => {
  const mk = (path: string | null, content: string) => ({
    nb: ref({ sqlnb: '1', metadata: {}, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'm', type: 'markdown', content, metadata: {} }] }),
    path: ref(path),
    runs: new Map(), analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
    dirty: ref(false), refreshAnalysis: vi.fn(async () => ({})), refreshBigNumber: vi.fn(async () => ({})),
  }) as any
  const run = async (store: any, readImage: any) => {
    setLocale('zh-CN')
    const saved: string[] = []
    const client: any = { saveHtml: vi.fn(async (_p: string, html: string) => { saved.push(html); return { bytes: 1 } }), pdf: vi.fn(), browserStatus: vi.fn() }
    const r = await runExport({ store, client, settings: { browserPath: ref('') }, labels: buildExportLabels((k, p) => t(k as any, p as any)), path: '/o/x.html', dataSourceName: () => undefined, readImage }, { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise
    expect(r.ok).toBe(true)
    return saved[0]
  }
  it('saved notebook: data URI embedded, no relative src, no skipped note', async () => {
    const html = await run(mk('/n/a.sqlnb', '![p](pic.png)'), async () => li(1))
    expect(html).toMatch(/<img alt="p" src="data:image\/png;base64,/)
    expect(html).not.toContain('pic.png')
    expect(html).not.toContain('未嵌入')
  })
  it('unsaved notebook: alt text, note with the count, no RPC', async () => {
    const read = vi.fn()
    const html = await run(mk(null, '![p](pic.png) ![q](b.png)'), read)
    expect(read).not.toHaveBeenCalled()
    expect(html).toContain('<span class="sqlnb-img-missing">p</span>')
    expect(html).toContain('2 张图片未嵌入')
    expect(html).not.toMatch(/\ssrc="(?!data:)/)
  })
  it('failed image: alt text and counted', async () => {
    const html = await run(mk('/n/a.sqlnb', '![p](pic.png)'), async () => { throw new ImageError('notFound') })
    expect(html).toContain('sqlnb-img-missing')
    expect(html).toContain('1 张图片未嵌入')
  })
})
