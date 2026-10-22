import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import src from '../src/export/ExportDialog.vue?raw'
import ExportDialog from '../src/export/ExportDialog.vue'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'

const css = (sel: string) => {
  const m = new RegExp(`(^|\\n)${sel.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`).exec(src.slice(src.indexOf('<style')))
  return m?.[2] ?? ''
}
const model: any = { sections: [], skipped: [], staleBlockIds: [], exportable: true, catalog: [] }
const mk = (o: any = {}) => mount(ExportDialog, { props: { model, browser: { found: false, checking: false }, busy: false, initialFolder: '/o', initialName: 'r', initial: DEFAULT_EXPORT_OPTIONS, ...o }, attachTo: document.body })

describe('export dialog header option columns', () => {
  it('CSS: two-column grid, shrinkable wrapping labels, tokens only', () => {
    expect(css('.ed-cols')).toMatch(/display:\s*grid/)
    expect(css('.ed-cols')).toMatch(/grid-template-columns:\s*1fr 1fr/)
    expect(css('.ed-cols > div')).toMatch(/min-width:\s*0/)
    expect(css('.ed-cols')).not.toMatch(/#[0-9a-f]{3,6}\b|rgb/i)
  })
})

describe('export dialog layout: every control + button pair is one nowrap row, button at the right', () => {
  const pairs: [string, string, string][] = [
    ['folder', 'file-folder', 'choose'],
    ['format', 'fmt-html', 'browser-settings-btn'],
    ['browser hint', 'browser-hint', 'browser-hint-open'],
  ]
  for (const [name, ctl, btn] of pairs) {
    it(`${name}: the button follows the control inside the same .ed-line`, () => {
      const w = mk()
      const c = w.find(`[data-test=${ctl}]`).element as HTMLElement
      const b = w.find(`[data-test=${btn}]`).element as HTMLElement
      const row = b.closest('.ed-line')!
      expect(row).not.toBeNull()
      expect(row.contains(c) || row === c).toBe(true)
      expect(c.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      w.unmount()
    })
  }
  it('browser path field and its Apply button share a row; the input can shrink', async () => {
    const w = mk()
    await w.find('[data-test=browser-settings-btn]').trigger('click')
    const input = w.find('[data-test=browser-manual]').element
    const apply = w.find('[data-test=browser-apply]').element
    expect(apply.closest('.ed-line')).toBe(input.closest('.ed-line'))
    expect(input.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    w.unmount()
  })
  it('file name input, extension and the footer are rows too', () => {
    const w = mk()
    expect(w.find('[data-test=file-name]').element.closest('.ed-line')).toBe(w.find('[data-test=file-ext]').element.closest('.ed-line'))
    const actions = w.find('.ed-actions').element
    expect(Array.from(actions.children).map((e) => e.getAttribute('data-test'))).toEqual(['close', 'go'])
    w.unmount()
  })
  it('CSS: rows are nowrap flex, buttons never wrap or shrink, inputs may shrink, footer is right-aligned', () => {
    expect(css('.ed-line')).toMatch(/display:\s*flex/)
    expect(css('.ed-line')).toMatch(/flex-wrap:\s*nowrap/)
    expect(css('.ed-line > .ed-btn')).toMatch(/white-space:\s*nowrap/)
    expect(css('.ed-line > .ed-btn')).toMatch(/flex:\s*none/)
    expect(css('.ed-grow')).toMatch(/min-width:\s*0/)
    expect(css('.ed-name')).toMatch(/min-width:\s*0/)
    expect(css('.ed-wide')).toMatch(/min-width:\s*0/)
    expect(css('.ed-actions')).toMatch(/justify-content:\s*flex-end/)
    expect(css('.ed-actions')).toMatch(/flex-wrap:\s*nowrap/)
    expect(css('.ed-actions .ed-btn')).toMatch(/white-space:\s*nowrap/)
  })
  it('spinner animates but respects prefers-reduced-motion', () => {
    expect(css('.ed-spin')).toMatch(/animation:\s*ed-spin/)
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ed-spin\s*\{\s*animation:\s*none/)
  })
})
