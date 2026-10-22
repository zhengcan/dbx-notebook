import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { collectRelImageLinks, rewriteImageLinks } from '../src/markdown/assetLinks'

const MAP = { 'a.png': 'new/a.png', 'b c.png': 'new/b c.png' }

describe('assetLinks only touches links that render as images', () => {
  const masked: Array<[string, string]> = [
    ['inline code', 'see `![](a.png)` here'],
    ['double-backtick code span', 'see ``![](a.png) `x` `` here'],
    ['code span over a line break', 'see `x\n![](a.png)` here'],
    ['fenced code', '```md\n![](a.png)\n```'],
    ['tilde fence', '~~~\n![](a.png)\n~~~'],
    ['indented code', 'para\n\n    ![](a.png)\n\nafter'],
    ['literal img tag (html:false renders it as text)', 'x <img src="a.png"> y'],
    ['escaped bang', '\\![](a.png)'],
  ]
  for (const [name, src] of masked) {
    it(`${name}: not collected, not rewritten`, () => {
      expect(collectRelImageLinks(src)).toEqual([])
      expect(rewriteImageLinks(src, MAP)).toBe(src)
    })
    it(`${name}: a real image next to it is handled alone`, () => {
      const both = `![r](a.png)\n\n${src}`
      expect(collectRelImageLinks(both)).toEqual(['a.png'])
      expect(rewriteImageLinks(both, MAP)).toBe(`![r](new/a.png)\n\n${src}`)
    })
  }
  it('html comments are text under html:false, so an image inside one is rendered and handled like any other', () => {
    for (const src of ['x <!-- ![](a.png) --> y', '<!--\n![](a.png)\n-->']) {
      expect(collectRelImageLinks(src)).toEqual(['a.png'])
      expect(rewriteImageLinks(src, MAP)).toBe(src.replace('a.png', 'new/a.png'))
    }
  })
  it('collect agrees with what markdown-it renders as an image (html:false)', () => {
    const md = new MarkdownIt({ html: false, linkify: true })
    const cases = ['x <!-- ![](a.png) --> y', '`![](a.png)`', '```\n![](a.png)\n```', '    ![](a.png)', '\\![](a.png)', '<img src="a.png">', '<!-- <img src="a.png"> -->', '![](a.png)', '[![](a.png)](http://x.y)', '> ![](a.png)', '![x][r]\n\n[r]: a.png', '[x][r]\n\n[r]: a.png']
    for (const c of cases) expect(collectRelImageLinks(c).length > 0, JSON.stringify(c)).toBe(md.render(c).includes('<img'))
  })
  it('image after a closed code span on the same line is still handled', () => {
    expect(rewriteImageLinks('`x` ![](a.png) `y`', MAP)).toBe('`x` ![](new/a.png) `y`')
  })
  it('unclosed backtick does not hide later images', () => {
    expect(collectRelImageLinks('a ` b ![](a.png)')).toEqual(['a.png'])
  })
  it('title, angle destination and encoded links still match and are re-encoded', () => {
    const src = '![t](a.png "title") ![](<b c.png>) ![e](b%20c.png)'
    expect(collectRelImageLinks(src)).toEqual(['a.png', 'b c.png'])
    expect(rewriteImageLinks(src, MAP)).toBe('![t](new/a.png "title") ![](new/b%20c.png) ![e](new/b%20c.png)')
  })
  it('images in lists, quotes, headings and tables', () => {
    const src = '- ![](a.png)\n> ![](a.png)\n# ![](a.png)\n\n| h |\n|---|\n| ![](a.png) |'
    expect(collectRelImageLinks(src)).toEqual(['a.png'])
    expect(rewriteImageLinks(src, MAP).match(/new\/a\.png/g)).toHaveLength(4)
  })
  describe('reference-style images', () => {
    it('full, collapsed and shortcut references are collected and the definition is rewritten', () => {
      const src = '![alt][one]\n\n![two][]\n\n![three]\n\n[one]: a.png "t"\n[Two]: <b c.png>\n[three]: a.png'
      expect(collectRelImageLinks(src)).toEqual(['a.png', 'b c.png'])
      expect(rewriteImageLinks(src, MAP)).toBe('![alt][one]\n\n![two][]\n\n![three]\n\n[one]: new/a.png "t"\n[Two]: new/b%20c.png\n[three]: new/a.png')
    })
    it('definitions not used by an image are left alone (link-only, unused)', () => {
      const src = '[link][l] and ![i][img]\n\n[l]: a.png\n[img]: b%20c.png\n[unused]: a.png'
      expect(collectRelImageLinks(src)).toEqual(['b c.png'])
      expect(rewriteImageLinks(src, MAP)).toBe('[link][l] and ![i][img]\n\n[l]: a.png\n[img]: new/b%20c.png\n[unused]: a.png')
    })
    it('a reference inside code does not count as a use', () => {
      const src = '`![x][r]`\n\n[r]: a.png'
      expect(collectRelImageLinks(src)).toEqual([])
      expect(rewriteImageLinks(src, MAP)).toBe(src)
    })
    it('a definition inside a code block is not a definition', () => {
      const src = '![x][r]\n\n```\n[r]: a.png\n```'
      expect(collectRelImageLinks(src)).toEqual([])
    })
  })
})
