import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { extractImageFiles, inspectTransfer, filesToBase64, sniffMime, MAX_IMAGES, MAX_IMAGE_BYTES } from '../src/blocks/mdImagePaste'
import { encodeRelPath, collectRelImageLinks, rewriteImageLinks } from '../src/markdown/assetLinks'
import { classifySrc } from '../src/markdown/imagePolicy'
import { sanitizeMarkdownHtml } from '../src/markdown/sanitize'
import { file, fakeDt, PNG_BYTES, SVG_BYTES, JPG_BYTES, GIF_BYTES, WEBP_BYTES } from './mdImageHelpers'

describe('extractImageFiles', () => {
  it('clipboard image/png only -> files', () => {
    const f = file('image.png', 'image/png')
    expect(extractImageFiles(fakeDt([f]), 'paste')).toEqual([f])
  })
  it('text + image on paste -> [] (text wins)', () => {
    expect(extractImageFiles(fakeDt([file('a.png', 'image/png')], 'hello'), 'paste')).toEqual([])
    const r = inspectTransfer(fakeDt([file('a.png', 'image/png')], 'hello'), 'paste')
    expect(r).toMatchObject({ files: [], unsupported: 0, truncated: 0 })
  })
  it('null / empty -> []', () => {
    expect(extractImageFiles(null, 'paste')).toEqual([])
    expect(extractImageFiles(fakeDt([]), 'drop')).toEqual([])
  })
  it('allow-list is png/jpeg/gif/webp only', () => {
    const ok = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].map((t, i) => file(`f${i}`, t))
    expect(extractImageFiles(fakeDt(ok), 'drop')).toEqual(ok)
  })
  it('dropped .avif/.jxl/.svg/.heic are ignored and counted as unsupported', () => {
    const bad = [file('a.avif', 'image/avif'), file('b.jxl', ''), file('c.svg', 'image/svg+xml'), file('d.heic', 'image/heic'), file('e.HEIF', ''), file('f.svg', '')]
    const r = inspectTransfer(fakeDt(bad), 'drop')
    expect(r.files).toEqual([])
    expect(r.unsupported).toBe(6)
  })
  it('non-image drop is ignored (not counted, not claimed)', () => {
    const r = inspectTransfer(fakeDt([file('a.txt', 'text/plain'), file('b.pdf', 'application/pdf')]), 'drop')
    expect(r).toMatchObject({ files: [], unsupported: 0, claimed: false })
  })
  it('mixed png + txt + svg: only the png is kept, svg counted', () => {
    const png = file('a.png', 'image/png')
    const r = inspectTransfer(fakeDt([png, file('b.txt', 'text/plain'), file('c.svg', 'image/svg+xml')]), 'drop')
    expect(r.files).toEqual([png])
    expect(r.unsupported).toBe(1)
    expect(r.claimed).toBe(true)
  })
  it('extension decides when the MIME is empty (drops)', () => {
    const a = file('shot.PNG', ''), b = file('p.jpeg', ''), c = file('x.webp', ''), d = file('y.gif', '')
    expect(extractImageFiles(fakeDt([a, b, c, d]), 'drop')).toEqual([a, b, c, d])
  })
  it('11 images -> first 10 plus truncated count', () => {
    const fs = Array.from({ length: 11 }, (_, i) => file(`${i}.png`, 'image/png'))
    const r = inspectTransfer(fakeDt(fs), 'drop')
    expect(r.files).toHaveLength(MAX_IMAGES)
    expect(r.files).toEqual(fs.slice(0, 10))
    expect(r.truncated).toBe(1)
  })
})

describe('sniff / filesToBase64', () => {
  it('sniffs the four types and rejects svg/html/empty', async () => {
    expect(await sniffMime(file('a', '', PNG_BYTES))).toBe('image/png')
    expect(await sniffMime(file('a', '', JPG_BYTES))).toBe('image/jpeg')
    expect(await sniffMime(file('a', '', GIF_BYTES))).toBe('image/gif')
    expect(await sniffMime(file('a', '', WEBP_BYTES))).toBe('image/webp')
    expect(await sniffMime(file('a.png', 'image/png', SVG_BYTES))).toBeNull()
    expect(await sniffMime(file('a.png', 'image/png', new Uint8Array()))).toBeNull()
  })
  it('returns mime from the bytes and base64 without prefix', async () => {
    const r = await filesToBase64([file('a.jpg', 'image/png', JPG_BYTES)])
    expect(r[0].mime).toBe('image/jpeg')
    expect(r[0].base64).toBe(btoa(String.fromCharCode(...JPG_BYTES)))
  })
  it('SVG named .png is unsupported', async () => {
    await expect(filesToBase64([file('a.png', 'image/png', SVG_BYTES)])).rejects.toMatchObject({ code: 'unsupported' })
  })
  it('> 10 MiB is rejected from File.size without reading', async () => {
    const big = file('big.png', 'image/png')
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })
    let read = false
    ;(big as any).slice = () => { read = true; return new Blob() }
    ;(big as any).arrayBuffer = () => { read = true; return Promise.resolve(new ArrayBuffer(0)) }
    await expect(filesToBase64([big])).rejects.toMatchObject({ code: 'tooLarge' })
    expect(read).toBe(false)
  })
})

describe('link encoding round-trips through markdown-it, sanitiser and classifySrc', () => {
  const md = new MarkdownIt({ html: false, linkify: true })
  const names = [
    'report.sqlnb.assets/image-20260101-000000-abcd1234.png',
    'my notes.sqlnb.assets/image-1.png',
    'a (1).sqlnb.assets/image-1.png',
    'a (b)).sqlnb.assets/i.png',
    'x[1].sqlnb.assets/i.png', 'x]y.sqlnb.assets/i.png',
    '报告 终稿.sqlnb.assets/图 1.png',
    'émoji 😀.sqlnb.assets/i.png',
    "q'uote !~.sqlnb.assets/i.png",
    'a&b=c.sqlnb.assets/i.png',
    'sub dir/中文 (x).png',
    'a`b.png', 'a$b@c,d;e+f.png',
  ]
  for (const rel of names) {
    it(`round-trips ${JSON.stringify(rel)}`, () => {
      const enc = encodeRelPath(rel)
      expect(enc).not.toMatch(/[\s()<>[\]]/)
      const src = `![](${enc})`
      const html = sanitizeMarkdownHtml(md.render(src), { allowRelative: true })
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const img = doc.querySelector('img')!
      const attr = img.getAttribute('data-sqlnb-src') ?? img.getAttribute('src')!
      expect(classifySrc(attr)).toEqual({ kind: 'relative', rel })
      expect(collectRelImageLinks(src)).toEqual([rel])
    })
  }
  it('percent, hash and question mark in a name are encoded and decode once to the original', () => {
    for (const rel of ['a#b.png', 'a?b.png', '100%.png', 'a%20b.png']) {
      const enc = encodeRelPath(rel)
      expect(enc).not.toMatch(/[#?]/)
      expect(decodeURIComponent(enc)).toBe(rel)
    }
  })
})

describe('collect / rewrite image links', () => {
  it('collects relative links only, deduped, skipping code and non-relative', () => {
    const md = [
      '![a](x.assets/a.png) ![b](./pic.png "t") ![a](x.assets/a.png)',
      '![r](https://e.x/y.png) ![d](data:image/png;base64,AAAA) ![up](../up.png) ![abs](/etc/p.png)',
      '```', '![c](code.png)', '```', '    ![i](indented.png)', '![e](sp%20ace/e.png)', '![<>](<with space/f.png>)',
    ].join('\n')
    expect(collectRelImageLinks(md)).toEqual(['x.assets/a.png', './pic.png', 'sp ace/e.png', 'with space/f.png'])
  })
  it('rewrites mapped links only (encoded), keeps title and query, skips code', () => {
    const md = '![a](old.sqlnb.assets/a.png "t") text ![b](./pic.png) ![c](old.sqlnb.assets/c%20d.png)\n```\n![x](old.sqlnb.assets/a.png)\n```'
    const out = rewriteImageLinks(md, { 'old.sqlnb.assets/a.png': 'new name.sqlnb.assets/a.png', 'old.sqlnb.assets/c d.png': 'new name.sqlnb.assets/c d-2.png', './pic.png': 'pic.png' })
    expect(out).toBe('![a](new%20name.sqlnb.assets/a.png "t") text ![b](./pic.png) ![c](new%20name.sqlnb.assets/c%20d-2.png)\n```\n![x](old.sqlnb.assets/a.png)\n```')
  })
  it('no mapping change returns the same string', () => {
    const md = '![a](a.png)'
    expect(rewriteImageLinks(md, {})).toBe(md)
    expect(rewriteImageLinks(md, { 'a.png': 'a.png' })).toBe(md)
  })
})
