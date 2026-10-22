import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

export const T0 = Date.UTC(2026, 0, 1)
export function mkStore(blocks?: any[]) {
  const clock = { t: T0 }
  const s = useNotebookStore({ now: () => new Date(clock.t) })
  const nb: any = createEmptyNotebook()
  nb.blocks = blocks ?? [
    { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales', connection: 'c' } },
    { id: 'm1', type: 'markdown', content: 'hello' },
    { id: 'i1', type: 'input', metadata: { variable: 'v', inputType: 'select', options: [1, 2, 3], value: 1 } },
    { id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' } } },
  ]
  s.load(serializeNotebook(nb), '/x.sqlnb', 1)
  const text = () => { const keep = clock.t; clock.t = T0; const r = s.toText(); clock.t = keep; return r }
  const blk = (id: string) => s.nb.value.blocks.find((b) => b.id === id)! as any
  return { s, clock, text, blk }
}
