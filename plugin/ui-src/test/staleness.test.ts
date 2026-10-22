import { describe, it, expect } from 'vitest'
import { computed } from 'vue'
import type { Block, InputVar } from '@sqlnb/format'
import { staleReasons, type StaleReason } from '../src/state/staleness'
import { hashSql } from '../src/state/hash'
import { useNotebookStore, type BlockRunState } from '../src/state/notebookStore'

const sql = (content: string): Block => ({ id: 'b1', type: 'sql', content, metadata: {} }) as Block
const v = (name: string, value: unknown, inputType: InputVar['inputType'] = 'text', multiple?: boolean): InputVar =>
  ({ name, inputType, value, multiple }) as InputVar
const ran = (s: string, params?: Record<string, unknown>, status: BlockRunState['status'] = 'ok'): BlockRunState =>
  ({ status, ranSqlHash: hashSql(s), params })

describe('staleReasons', () => {
  const cases: Array<[string, Block, BlockRunState | undefined, InputVar[], ((b: Block) => StaleReason | null) | undefined, StaleReason[]]> = [
    ['no run', sql('select 1'), undefined, [], undefined, []],
    ['idle', sql('select 2'), ran('select 1', undefined, 'idle'), [], undefined, []],
    ['running', sql('select 2'), ran('select 1', undefined, 'running'), [], undefined, []],
    ['unchanged', sql('select 1'), ran('select 1', { a: 1 }), [v('a', 1, 'number')], undefined, []],
    ['whitespace only', sql('  select 1  \r\n\r\n'), ran('select 1'), [], undefined, []],
    ['sql changed', sql('select 2'), ran('select 1'), [], undefined, ['sql']],
    ['sql changed, error run', sql('select 2'), ran('select 1', undefined, 'error'), [], undefined, ['sql']],
    ['missing ranSqlHash', sql('select 1'), { status: 'ok' }, [], undefined, ['sql']],
    ['param changed', sql('x'), ran('x', { a: 'p' }), [v('a', 'q')], undefined, ['params']],
    ['param changed, error run', sql('x'), ran('x', { a: 'p' }, 'error'), [v('a', 'q')], undefined, ['params']],
    ['param revert', sql('x'), ran('x', { a: 'p' }), [v('a', 'p')], undefined, []],
    ['var deleted', sql('x'), ran('x', { a: 'p' }), [], undefined, ['params']],
    ['type changed', sql('x'), ran('x', { a: 1 }), [v('a', '1', 'text')], undefined, ['params']],
    ['array same', sql('x'), ran('x', { a: ['x', 'y'] }), [v('a', ['x', 'y'], 'select', true)], undefined, []],
    ['array reorder', sql('x'), ran('x', { a: ['x', 'y'] }), [v('a', ['y', 'x'], 'select', true)], undefined, ['params']],
    ['array longer', sql('x'), ran('x', { a: ['x'] }), [v('a', ['x', 'y'], 'select', true)], undefined, ['params']],
    ['unused var changes ignored', sql('x'), ran('x', { a: 1 }), [v('a', 1, 'number'), v('z', 9, 'number')], undefined, []],
    ['sql and params', sql('y'), ran('x', { a: 1 }), [v('a', 2, 'number')], undefined, ['sql', 'params']],
    ['upstream', sql('x'), ran('x'), [], () => 'upstream', ['upstream']],
    ['upstream null', sql('x'), ran('x'), [], () => null, []],
    ['all three', sql('y'), ran('x', { a: 1 }), [], () => 'upstream', ['sql', 'params', 'upstream']],
    ['upstream ignored without run', sql('x'), undefined, [], () => 'upstream', []],
  ]
  it.each(cases)('%s', (_n, block, run, vars, upstream, expected) => {
    expect(staleReasons(block, run, { vars, upstream })).toEqual(expected)
  })
})

describe('hashSql normalisation', () => {
  it('ignores CRLF, trailing spaces, leading/trailing blank lines', () => {
    const base = hashSql('select 1\nfrom t')
    expect(hashSql('select 1\r\nfrom t')).toBe(base)
    expect(hashSql('select 1\rfrom t')).toBe(base)
    expect(hashSql('select 1   \nfrom t\t')).toBe(base)
    expect(hashSql('\n\n  \nselect 1\nfrom t\n\n  ')).toBe(base)
  })
  it('keeps inner spacing and case significant', () => {
    expect(hashSql('select  1')).not.toBe(hashSql('select 1'))
    expect(hashSql('SELECT 1')).not.toBe(hashSql('select 1'))
  })
})

describe('store staleness reactivity', () => {
  it('input value change flips staleReasons without re-run', () => {
    const s = useNotebookStore()
    s.nb.value.blocks.push({ id: 'i1', type: 'input', metadata: { variable: 'a', inputType: 'text', value: 'p' } } as Block)
    s.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'x', metadata: {} } as Block)
    s.runs.set('b1', ran('x', { a: 'p' }))
    const r = computed(() => s.staleReasons('b1'))
    expect(r.value).toEqual([])
    s.updateMeta('i1', { value: 'q' })
    expect(r.value).toEqual(['params'])
    expect(s.isStale('b1')).toBe(true)
    s.updateMeta('i1', { value: 'p' })
    expect(r.value).toEqual([])
  })
  it('markdown and unknown ids give []', () => {
    const s = useNotebookStore()
    s.nb.value.blocks.push({ id: 'm', type: 'markdown', content: '' } as Block)
    s.runs.set('m', { status: 'ok' })
    expect(s.staleReasons('m')).toEqual([])
    expect(s.isStale('m')).toBe(false)
    expect(s.staleReasons('zz')).toEqual([])
  })
  it('local result block goes stale on input change and fresh again', () => {
    const s = useNotebookStore()
    s.nb.value.blocks.push({ id: 'i1', type: 'input', metadata: { variable: 'region', inputType: 'text', value: 'eu' } } as Block)
    s.nb.value.blocks.push({ id: 'l1', type: 'sql', content: 'select {{ region }}', metadata: { source: 'results' } } as Block)
    s.runs.set('l1', { status: 'ok', ranSqlHash: hashSql('select {{ region }}'), ranSource: 'results', params: { region: 'eu' }, upstream: {} } as any)
    expect(s.staleReasons('l1')).toEqual([])
    s.updateMeta('i1', { value: 'us' })
    expect(s.staleReasons('l1')).toEqual(['params'])
    s.updateMeta('i1', { value: 'eu' })
    expect(s.staleReasons('l1')).toEqual([])
  })
})
