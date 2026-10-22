import { describe, it, expect } from 'vitest'
import { applyMarkdownAction, changedSpan, type MdAction, type Placeholders } from '../src/markdown/toolbarActions'

// ⟦…⟧ marks a range selection, ‸ marks a caret.
function parse(s: string): { text: string; from: number; to: number } {
  const a = s.indexOf('⟦')
  if (a >= 0) {
    const b = s.indexOf('⟧')
    const text = s.slice(0, a) + s.slice(a + 1, b) + s.slice(b + 1)
    return { text, from: a, to: b - 1 }
  }
  const c = s.indexOf('‸')
  return { text: s.slice(0, c) + s.slice(c + 1), from: c, to: c }
}
function show(text: string, from: number, to: number): string {
  if (from === to) return text.slice(0, from) + '‸' + text.slice(from)
  return text.slice(0, from) + '⟦' + text.slice(from, to) + '⟧' + text.slice(to)
}
function run(src: string, action: MdAction, opts?: { eol?: '\n' | '\r\n'; placeholders?: Placeholders }): string {
  const p = parse(src)
  const r = applyMarkdownAction(p.text, { from: p.from, to: p.to }, action, opts)
  return show(r.text, r.from, r.to)
}

describe('bold', () => {
  it('wraps a selection and keeps it on the text', () => {
    expect(run('⟦abc⟧', 'bold')).toBe('**⟦abc⟧**')
  })
  it('unwraps when the markers are outside the selection', () => {
    expect(run('**⟦abc⟧**', 'bold')).toBe('⟦abc⟧')
  })
  it('unwraps when the selection contains the markers', () => {
    expect(run('⟦**abc**⟧', 'bold')).toBe('⟦abc⟧')
  })
  it('inserts a selected placeholder for an empty selection', () => {
    expect(run('a‸b', 'bold')).toBe('a**⟦粗体文字⟧**b')
  })
  it('removes an empty pair around the caret', () => {
    expect(run('a**‸**b', 'bold')).toBe('a‸b')
  })
  it('does not split a surrogate pair', () => {
    expect(run('中文⟦😀⟧', 'bold')).toBe('中文**⟦😀⟧**')
  })
  it('aligns a selection that starts or ends inside a pair', () => {
    const r = applyMarkdownAction('a😀b', { from: 2, to: 3 }, 'bold')
    expect(r.text).toBe('a**😀**b')
    expect(show(r.text, r.from, r.to)).toBe('a**⟦😀⟧**b')
  })
  it('wraps italic inside bold content without confusion', () => {
    expect(run('⟦*a*⟧', 'bold')).toBe('**⟦*a*⟧**')
  })
  it('keeps surrounding whitespace outside the markers', () => {
    expect(run('⟦ abc ⟧', 'bold')).toBe(' **⟦abc⟧** ')
  })
  it('does not treat an escaped star as a marker', () => {
    expect(run('\\***⟦abc⟧**', 'bold')).toBe('\\*⟦abc⟧')
  })
  it('removes bold from bold-italic', () => {
    expect(run('***⟦abc⟧***', 'bold')).toBe('*⟦abc⟧*')
  })
  it('honours custom placeholders', () => {
    const ph: Placeholders = { bold: 'B', italic: 'I', code: 'C', linkText: 'T', linkUrl: 'U', cell: 'V' }
    expect(run('‸', 'bold', { placeholders: ph })).toBe('**⟦B⟧**')
  })
})

describe('italic', () => {
  it('wraps and unwraps', () => {
    expect(run('⟦abc⟧', 'italic')).toBe('*⟦abc⟧*')
    expect(run('*⟦abc⟧*', 'italic')).toBe('⟦abc⟧')
    expect(run('⟦*abc*⟧', 'italic')).toBe('⟦abc⟧')
  })
  it('adds to bold making bold-italic and removes it again', () => {
    expect(run('**⟦abc⟧**', 'italic')).toBe('***⟦abc⟧***')
    expect(run('***⟦abc⟧***', 'italic')).toBe('**⟦abc⟧**')
  })
  it('inserts a placeholder when empty', () => {
    expect(run('‸', 'italic')).toBe('*⟦斜体文字⟧*')
  })
  it('does not treat an escaped star as a marker', () => {
    expect(run('\\*⟦abc⟧*', 'italic')).toBe('\\*⟦abc⟧')
  })
})

describe('inline code', () => {
  it('wraps and unwraps', () => {
    expect(run('⟦a⟧', 'code')).toBe('`⟦a⟧`')
    expect(run('`⟦a⟧`', 'code')).toBe('⟦a⟧')
    expect(run('⟦`a`⟧', 'code')).toBe('⟦a⟧')
  })
  it('uses a longer fence when the selection contains a backtick', () => {
    expect(run('⟦a`b⟧', 'code')).toBe('``⟦a`b⟧``')
    expect(run('``⟦a`b⟧``', 'code')).toBe('⟦a`b⟧')
  })
  it('pads when the content starts or ends with a backtick, and toggles back', () => {
    expect(run('⟦`a⟧', 'code')).toBe('`` ⟦`a⟧ ``')
    expect(run('`` ⟦`a⟧ ``', 'code')).toBe('⟦`a⟧')
  })
  it('inserts a placeholder when empty', () => {
    expect(run('‸', 'code')).toBe('`⟦代码⟧`')
    expect(run('x`‸`y', 'code')).toBe('x‸y')
  })
})

describe('heading', () => {
  it('cycles # ## ### none', () => {
    expect(run('⟦标题⟧', 'heading')).toBe('# ⟦标题⟧')
    expect(run('# ⟦标题⟧', 'heading')).toBe('## ⟦标题⟧')
    expect(run('## ⟦标题⟧', 'heading')).toBe('### ⟦标题⟧')
    expect(run('### ⟦标题⟧', 'heading')).toBe('⟦标题⟧')
  })
  it('removes levels deeper than 3', () => {
    expect(run('#### x‸', 'heading')).toBe('x‸')
  })
  it('does not treat #tag as a heading', () => {
    expect(run('#tag‸', 'heading')).toBe('# #tag‸')
  })
  it('only changes the line holding the selection start', () => {
    expect(run('⟦a\nb\nc⟧', 'heading')).toBe('# ⟦a\nb\nc⟧')
  })
  it('puts the caret after the prefix on an empty line', () => {
    expect(run('‸', 'heading')).toBe('# ‸')
  })
  it('keeps CRLF', () => {
    expect(run('x\r\n⟦a⟧\r\ny', 'heading')).toBe('x\r\n# ⟦a⟧\r\ny')
  })
})

describe('line prefixes', () => {
  it('prefixes every non-blank line and toggles back', () => {
    expect(run('⟦a\n\nb⟧', 'quote')).toBe('> ⟦a\n\n> b⟧')
    expect(run('> ⟦a\n\n> b⟧', 'quote')).toBe('⟦a\n\nb⟧')
  })
  it('adds only the missing prefixes when mixed', () => {
    expect(run('⟦- a\nb⟧', 'ul')).toBe('⟦- a\n- b⟧')
  })
  it('numbers ordered lists and renumbers', () => {
    expect(run('⟦a\nb\nc⟧', 'ol')).toBe('1. ⟦a\n2. b\n3. c⟧')
    expect(run('⟦1. a\n5. b\nc⟧', 'ol')).toBe('⟦1. a\n2. b\n3. c⟧')
    expect(run('1. ⟦a\n2. b⟧', 'ol')).toBe('⟦a\nb⟧')
  })
  it('replaces the prefix when switching list kind', () => {
    expect(run('- ⟦a\n- b⟧', 'ol')).toBe('1. ⟦a\n2. b⟧')
    expect(run('1. ⟦a\n2. b⟧', 'ul')).toBe('- ⟦a\n- b⟧')
  })
  it('excludes a last line when the selection ends at its column 0', () => {
    expect(run('⟦a\n⟧b', 'ul')).toBe('- ⟦a\n⟧b')
  })
  it('adds a prefix on an empty line with the caret after it', () => {
    expect(run('a\n‸\nb', 'ul')).toBe('a\n- ‸\nb')
    expect(run('‸', 'quote')).toBe('> ‸')
  })
  it('keeps indentation', () => {
    expect(run('  ‸a', 'ul')).toBe('  - ‸a')
    expect(run('  - ‸a', 'ul')).toBe('  ‸a')
  })
  it('keeps CRLF', () => {
    expect(run('⟦a\r\nb⟧\r\nc', 'ul')).toBe('- ⟦a\r\n- b⟧\r\nc')
  })
  it('does not mistake bold for a bullet', () => {
    expect(run('**a**‸', 'ul')).toBe('- **a**‸')
  })
  it('leaves blank-only multi-line selections alone', () => {
    expect(run('⟦\n\n⟧', 'ul')).toBe('⟦\n\n⟧')
  })
  it('handles CJK and emoji lines', () => {
    expect(run('⟦中文\n😀⟧', 'quote')).toBe('> ⟦中文\n> 😀⟧')
  })
  it('keeps tabs as indentation', () => {
    expect(run('\t‸a', 'quote')).toBe('\t> ‸a')
  })
})

describe('code block', () => {
  it('fences whole selected lines', () => {
    expect(run('x\n⟦a\nb⟧\ny', 'codeBlock')).toBe('x\n```\n⟦a\nb⟧\n```\ny')
  })
  it('removes fences when the caret is inside a fenced block', () => {
    expect(run('x\n```sql\na‸\n```\ny', 'codeBlock')).toBe('x\na‸\ny')
    expect(run('```\n⟦a\nb⟧\n```', 'codeBlock')).toBe('⟦a\nb⟧')
  })
  it('inserts an empty block with the caret in the middle', () => {
    expect(run('‸', 'codeBlock')).toBe('```\n‸\n```')
  })
  it('adds newlines around glued text only when missing', () => {
    expect(run('ab‸cd', 'codeBlock')).toBe('ab\n```\n‸\n```\ncd')
    expect(run('ab\n‸\ncd', 'codeBlock')).toBe('ab\n```\n‸\n```\ncd')
  })
  it('uses a longer fence when the content has a fence', () => {
    expect(run('⟦x ``` y⟧', 'codeBlock')).toBe('````\n⟦x ``` y⟧\n````')
  })
  it('keeps a missing trailing newline missing', () => {
    expect(run('⟦a⟧', 'codeBlock')).toBe('```\n⟦a⟧\n```')
  })
  it('uses CRLF throughout', () => {
    expect(run('⟦a\r\nb⟧', 'codeBlock')).toBe('```\r\n⟦a\r\nb⟧\r\n```')
  })
  it('ignores an unclosed fence', () => {
    expect(run('```\na‸', 'codeBlock')).toBe('```\na\n```\n‸\n```')
  })
})

describe('link', () => {
  it('uses a url selection as target', () => {
    expect(run('⟦https://x.com⟧', 'link')).toBe('[⟦链接文字⟧](https://x.com)')
  })
  it('uses other text as link text and selects the url placeholder', () => {
    expect(run('⟦文字⟧', 'link')).toBe('[文字](⟦https://⟧)')
  })
  it('unwraps a selected link', () => {
    expect(run('⟦[a](b)⟧', 'link')).toBe('⟦a⟧')
  })
  it('unwraps when the selection is the link text or the url', () => {
    expect(run('[⟦a⟧](b)', 'link')).toBe('⟦a⟧')
    expect(run('[a](⟦https://⟧)', 'link')).toBe('⟦a⟧')
  })
  it('inserts a template when empty', () => {
    expect(run('‸', 'link')).toBe('[⟦链接文字⟧](https://)')
  })
  it('does not split emoji', () => {
    expect(run('⟦😀⟧', 'link')).toBe('[😀](⟦https://⟧)')
  })
})

describe('table', () => {
  const tbl = '| 列1 | 列2 |\n| --- | --- |\n| 值 | 值 |'
  it('inserts after the line holding the selection end with a blank line', () => {
    const r = run('a⟦b⟧\nc', 'table')
    expect(r.replace(/[⟦⟧]/g, '')).toBe('ab\n\n' + tbl + '\n\nc')
    expect(r).toContain('| ⟦列1⟧ | 列2 |')
  })
  it('adds a missing trailing newline and no trailing one afterwards', () => {
    expect(run('a‸', 'table').replace(/[⟦⟧]/g, '')).toBe('a\n\n' + tbl)
  })
  it('keeps a trailing newline', () => {
    expect(run('a‸\n', 'table').replace(/[⟦⟧]/g, '')).toBe('a\n\n' + tbl + '\n')
  })
  it('does not add a blank line after an existing one', () => {
    expect(run('a‸\n\nc', 'table').replace(/[⟦⟧]/g, '')).toBe('a\n\n' + tbl + '\n\nc')
  })
  it('works on empty text', () => {
    expect(run('‸', 'table')).toBe('| ⟦列1⟧ | 列2 |\n| --- | --- |\n| 值 | 值 |')
  })
  it('uses CRLF throughout', () => {
    const r = run('a‸\r\nc', 'table').replace(/[⟦⟧]/g, '')
    expect(r).toBe(('a\n\n' + tbl + '\n\nc').replace(/\n/g, '\r\n'))
    expect(r.replace(/\r\n/g, '')).not.toContain('\n')
  })
  it('honours custom placeholders', () => {
    const ph: Placeholders = { bold: 'B', italic: 'I', code: 'C', linkText: 'T', linkUrl: 'U', cell: 'V', col1: 'H1', col2: 'H2' }
    expect(run('‸', 'table', { placeholders: ph })).toBe('| ⟦H1⟧ | H2 |\n| --- | --- |\n| V | V |')
  })
  it('keeps the selected text untouched', () => {
    const r = applyMarkdownAction('abc', { from: 0, to: 3 }, 'table')
    expect(r.text.startsWith('abc\n\n')).toBe(true)
  })
})

describe('robustness', () => {
  const actions: MdAction[] = ['heading', 'bold', 'italic', 'code', 'codeBlock', 'link', 'quote', 'ul', 'ol', 'table']
  it('clamps out-of-range, negative, reversed and NaN selections', () => {
    for (const a of actions) {
      for (const sel of [{ from: -5, to: 99 }, { from: 9, to: 1 }, { from: NaN, to: NaN }, { from: 99, to: 100 }]) {
        const r = applyMarkdownAction('ab\ncd', sel, a)
        expect(r.from).toBeGreaterThanOrEqual(0)
        expect(r.to).toBeLessThanOrEqual(r.text.length)
        expect(r.from).toBeLessThanOrEqual(r.to)
      }
    }
  })
  it('reversed selection equals the ordered one', () => {
    expect(applyMarkdownAction('abcd', { from: 3, to: 1 }, 'bold')).toEqual(applyMarkdownAction('abcd', { from: 1, to: 3 }, 'bold'))
  })
  it('works on empty text for every action', () => {
    for (const a of actions) {
      const r = applyMarkdownAction('', { from: 0, to: 0 }, a)
      expect(r.text.length).toBeGreaterThan(0)
      expect(r.to).toBeLessThanOrEqual(r.text.length)
    }
  })
  it('does not move a caret that sits inside a CRLF', () => {
    const r = applyMarkdownAction('a\r\nb', { from: 2, to: 2 }, 'ul')
    expect(r.text).toBe('- a\r\nb')
  })
  it('respects an explicit eol option for inserted breaks', () => {
    expect(applyMarkdownAction('', { from: 0, to: 0 }, 'codeBlock', { eol: '\r\n' }).text).toBe('```\r\n\r\n```')
  })
})

describe('changedSpan', () => {
  it('describes a replacement', () => {
    expect(changedSpan('abc', 'aXc')).toEqual({ from: 1, to: 2 })
  })
  it('describes an insertion and a deletion', () => {
    expect(changedSpan('ac', 'abc')).toEqual({ from: 1, to: 2 })
    expect(changedSpan('abc', 'ac')).toEqual({ from: 1, to: 1 })
  })
  it('collapses at the end for identical strings', () => {
    expect(changedSpan('abc', 'abc')).toEqual({ from: 3, to: 3 })
  })
  it('does not split a surrogate pair', () => {
    expect(changedSpan('a😀b', 'a😁b')).toEqual({ from: 1, to: 3 })
    expect(changedSpan('😀', '😁')).toEqual({ from: 0, to: 2 })
  })
  it('handles repeated characters', () => {
    expect(changedSpan('aa', 'aaa')).toEqual({ from: 2, to: 3 })
  })
})

describe('round 2: fenced block removal at the end of text', () => {
  const inRange = (text: string, r: { text: string; from: number; to: number }) => {
    expect(r.from).toBeGreaterThanOrEqual(0)
    expect(r.from).toBeLessThanOrEqual(r.to)
    expect(r.to).toBeLessThanOrEqual(r.text.length)
    expect(text).toBeDefined()
  }
  it('removes an empty CRLF block that is the whole text', () => {
    const r = applyMarkdownAction('```\r\n```', { from: 6, to: 4 }, 'codeBlock')
    expect(r).toEqual({ text: '', from: 0, to: 0 })
  })
  it('maps the selection exactly across the removed fences', () => {
    expect(applyMarkdownAction('x\r\n```\r\n```', { from: 11, to: 11 }, 'codeBlock')).toEqual({ text: 'x\r\n', from: 3, to: 3 })
    expect(applyMarkdownAction('x\r\n```\r\n```', { from: 3, to: 11 }, 'codeBlock')).toEqual({ text: 'x\r\n', from: 3, to: 3 })
    expect(applyMarkdownAction('```\r\n```', { from: 8, to: 8 }, 'codeBlock')).toEqual({ text: '', from: 0, to: 0 })
    expect(applyMarkdownAction('```\n```', { from: 7, to: 7 }, 'codeBlock')).toEqual({ text: '', from: 0, to: 0 })
  })
  it('removes a CRLF block with content at the end', () => {
    const r = applyMarkdownAction('```\r\na\r\n```', { from: 5, to: 5 }, 'codeBlock')
    expect(r.text).toBe('a')
    inRange('', r)
  })
  it('produces exact text for blocks at the end (LF/CRLF)', () => {
    for (const e of ['\n', '\r\n']) {
      expect(applyMarkdownAction(`x${e}\`\`\`${e}a${e}\`\`\``, { from: 5, to: 5 }, 'codeBlock').text).toBe(`x${e}a`)
      expect(applyMarkdownAction(`x${e}\`\`\`${e}\`\`\``, { from: 0, to: 20 }, 'codeBlock').text).toBe(`x${e}`)
      expect(applyMarkdownAction(`\`\`\`sql${e}a${e}b${e}\`\`\``, { from: 8, to: 8 }, 'codeBlock').text).toBe(`a${e}b`)
      expect(applyMarkdownAction(`\`\`\`${e}\`\`\``, { from: 0, to: 0 }, 'codeBlock').text).toBe('')
    }
  })
  it('keeps the selection contract for every shape (LF/CRLF, empty/content, end/middle, caret/range)', () => {
    for (const e of ['\n', '\r\n']) {
      for (const body of ['', 'a' + e, 'a' + e + 'b' + e]) {
        for (const [pre, post] of [['', ''], ['x' + e, ''], ['', e + 'y'], ['x' + e, e + 'y'], ['', e]]) {
          const text = pre + '```' + e + body + '```' + post
          for (let a = 0; a <= text.length; a++) {
            for (const b of [a, text.length, Math.max(0, a - 2)]) {
              const r = applyMarkdownAction(text, { from: a, to: b }, 'codeBlock')
              inRange(text, r)
            }
          }
          const r = applyMarkdownAction(text, { from: pre.length + 4, to: pre.length + 4 }, 'codeBlock')
          expect(r.text).not.toContain('```')
          expect(r.text.includes('\r\n') ? r.text.replace(/\r\n/g, '').includes('\n') : false).toBe(false)
        }
      }
    }
  })
})

describe('round 2: bold / italic over several segments', () => {
  it('cancels every bold segment when the selection holds several', () => {
    expect(run('⟦**a** **b**⟧', 'bold')).toBe('⟦a b⟧')
  })
  it('strips the inner pair and wraps once when one segment does not fill the selection', () => {
    expect(run('⟦**a** b⟧', 'bold')).toBe('**⟦a b⟧**')
    expect(run('⟦a **b** c⟧', 'bold')).toBe('**⟦a b c⟧**')
  })
  it('does the same for italic', () => {
    expect(run('⟦*a* *b*⟧', 'italic')).toBe('⟦a b⟧')
    expect(run('⟦*a* b⟧', 'italic')).toBe('*⟦a b⟧*')
  })
  it('recognises an unclosed marker and cancels it', () => {
    expect(run('⟦**x⟧', 'bold')).toBe('⟦x⟧')
    expect(run('**⟦x⟧', 'bold')).toBe('⟦x⟧')
    expect(run('⟦x⟧**', 'bold')).toBe('⟦x⟧')
    expect(run('⟦a** b⟧', 'bold')).toBe('⟦a b⟧')
    expect(run('*⟦x⟧', 'italic')).toBe('⟦x⟧')
  })
  it('still wraps a word inside a closed bold phrase', () => {
    expect(run('**⟦x⟧ y**', 'bold')).toBe('****⟦x⟧** y**')
  })
})

describe('round 2: table placement', () => {
  const tbl = '| 列1 | 列2 |\n| --- | --- |\n| 值 | 值 |'
  const plain = (s: string) => s.replace(/[⟦⟧]/g, '')
  it('goes after an existing table when the caret is inside it', () => {
    expect(plain(run('‸| a | b |\n| - | - |\nx', 'table'))).toBe('| a | b |\n| - | - |\n\n' + tbl + '\n\nx')
    expect(plain(run('| a | b |\n‸| - | - |\nx', 'table'))).toBe('| a | b |\n| - | - |\n\n' + tbl + '\n\nx')
  })
  it('handles a table at the end and CRLF', () => {
    expect(plain(run('| a |\n| - |‸', 'table'))).toBe('| a |\n| - |\n\n' + tbl)
    expect(plain(run('| a |\r\n‸| - |\r\nx', 'table'))).toBe(('| a |\n| - |\n\n' + tbl + '\n\nx').replace(/\n/g, '\r\n'))
  })
  it('a selection ending inside the table also goes after it', () => {
    expect(plain(run('⟦t\n| a |⟧\n| - |\nz', 'table'))).toBe('t\n| a |\n| - |\n\n' + tbl + '\n\nz')
  })
  it('inserts after the line when the caret is mid-line outside a table', () => {
    expect(plain(run('ab‸cd\n| a |', 'table'))).toBe('abcd\n\n' + tbl + '\n\n| a |')
  })
})

describe('round 2: line prefixes inside quotes, links', () => {
  it('treats a list inside a quote as the list', () => {
    expect(run('> - ‸x', 'ul')).toBe('> ‸x')
    expect(run('> ‸x', 'ul')).toBe('> - ‸x')
    expect(run('> ‸x', 'ol')).toBe('> 1. ‸x')
    expect(run('> 1. ‸x', 'ul')).toBe('> - ‸x')
  })
  it('still nests quotes', () => {
    expect(run('> ‸x', 'quote')).toBe('‸x')
  })
  it('accepts www. and mailto: as urls', () => {
    expect(run('⟦www.x.com⟧', 'link')).toBe('[⟦链接文字⟧](www.x.com)')
    expect(run('⟦mailto:a@b.c⟧', 'link')).toBe('[⟦链接文字⟧](mailto:a@b.c)')
  })
  it('unlinks every link in a selection instead of nesting', () => {
    expect(run('⟦[a](b) [c](d)⟧', 'link')).toBe('⟦a c⟧')
    expect(run('⟦see [a](b) now⟧', 'link')).toBe('⟦see a now⟧')
  })
  it('does not unlink an image', () => {
    expect(run('⟦![a](b)⟧', 'link')).toBe('[![a](b)](⟦https://⟧)')
  })
})

describe('round 3: literal stars are never touched', () => {
  const inputs = ['x = a * b', '2 * 3', '2 * 3 * 4', 'f(a*b) and g(c*d)', '`a*b*c`', '`**a**`', 'a * b\n2 * 3']
  it('wraps once and returns to the original text, bold and italic', () => {
    for (const src of inputs) {
      for (const [a, m] of [['bold', '**'], ['italic', '*']] as const) {
        const p = parse('⟦' + src + '⟧')
        const one = applyMarkdownAction(p.text, { from: 0, to: p.text.length }, a)
        expect(one.text).toBe(m + src + m)
        expect(one.text.slice(one.from, one.to)).toBe(src)
        const two = applyMarkdownAction(one.text, one, a)
        expect(two.text).toBe(src)
      }
    }
  })
  it('keeps a bullet list intact and wraps after the first marker', () => {
    expect(run('⟦* a\n* b\n* c⟧', 'bold')).toBe('* **⟦a\n* b\n* c⟧**')
    expect(run('⟦* a\n* b\n* c⟧', 'italic')).toBe('* *⟦a\n* b\n* c⟧*')
    expect(run('* **⟦a\n* b\n* c⟧**', 'bold')).toBe('* ⟦a\n* b\n* c⟧')
  })
  it('does not count stars in urls', () => {
    expect(run('⟦see https://x.com/a*b*c now⟧', 'italic')).toBe('*⟦see https://x.com/a*b*c now⟧*')
  })
  it('real markers next to literal stars still toggle', () => {
    expect(run('⟦*a * b*⟧', 'italic')).toBe('⟦a * b⟧')
    expect(run('*⟦a * b⟧*', 'italic')).toBe('⟦a * b⟧')
    expect(run('⟦**a * b**⟧', 'bold')).toBe('⟦a * b⟧')
  })
  it('leaves a selection strictly inside inline code or a url alone', () => {
    expect(applyMarkdownAction('`a*b*c`', { from: 2, to: 5 }, 'bold')).toEqual({ text: '`a*b*c`', from: 2, to: 5 })
    expect(applyMarkdownAction('``a`b``', { from: 3, to: 4 }, 'italic')).toEqual({ text: '``a`b``', from: 3, to: 4 })
    expect(applyMarkdownAction('`a b`', { from: 2, to: 2 }, 'bold')).toEqual({ text: '`a b`', from: 2, to: 2 })
    expect(applyMarkdownAction('https://x.com/a*b', { from: 14, to: 17 }, 'italic').text).toBe('https://x.com/a*b')
  })
  it('still wraps a whole code span or url', () => {
    expect(run('⟦`a`⟧', 'bold')).toBe('**⟦`a`⟧**')
    expect(run('⟦https://x.com⟧', 'bold')).toBe('**⟦https://x.com⟧**')
  })
})
