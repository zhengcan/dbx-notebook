import { ref, reactive, watch, type Ref } from 'vue'
import { parseNotebook, serializeNotebook, validateNotebook, clone, newBlockId, normalizeAnalysis, buildPortableSpec, type PivotConfig, type View, type ChartOptions, isValidEntry, clampMaxRows, DEFAULT_MAX_ROWS, type OutputEntry, type Block, type InputVar, type Notebook, type ValidationError } from '@sqlnb/format'
import type { QueryResult, HostErrorCode } from '../host/bridge'
import { runToEntry, entryToRun } from './outputs'
import { staleReasons as computeStale, type StaleReason } from './staleness'
import type { AnalysisResult, BigNumberResult } from '../analysis/analysisState'
import { normalizeBigNumber, normalizeFormat, BIG_AGGS, MAX_LABEL, MAX_METRICS, type Metric, type MetricFilter, type MetricCompare } from '../analysis/bigNumberConfig'
import { findSourceBlock, resolveSource } from '../analysis/source'
import { guessAnalysis } from '../analysis/guess'
import { createHistory, type DocDelta, type DocEntry, type HistoryResult } from './history'
import { cloneTouched, applyDelta, deltaBytes, sameDelta, checkDelta, type Touched } from './docHistory'
import { alignDown, alignUp } from '../markdown/codePoint'
import { imageLinkText, rewriteImageLinks } from '../markdown/assetLinks'
import { isResultsBlock, resultNameOf, upstreamOf, DepError } from '../run/deps'

export interface BigNumberDef { data: string; metrics: Metric[] }

export interface AiTx {
  updateContent(id: string, content: string): void
  insertAfter(type: 'sql' | 'markdown', afterId: string, content: string): string
  setAnalysis(id: string, patch: { data?: string; pivot?: Partial<PivotConfig>; view?: View; chartOptions?: Partial<ChartOptions> }): void
  setBigNumberDef(id: string, def: BigNumberDef): void
  insertBigNumberAfter(afterId: string, def: BigNumberDef): string
}

const INPUT_TYPES = ['text', 'number', 'date', 'boolean', 'select']

export interface BlockRunState {
  status: 'idle' | 'running' | 'ok' | 'error'
  result?: QueryResult
  error?: { code: HostErrorCode; message: string; kind?: 'param' | 'engine'; hint?: string; variable?: string; paramCode?: 'UNRESOLVED' | 'UNSET' | 'INVALID' | 'FORBIDDEN_POSITION' | 'DUPLICATE' }
  ranSqlHash?: string
  ranSource?: 'database' | 'results'
  params?: Record<string, unknown>
  upstream?: Record<string, string>
  partial?: boolean
  executedAt?: string
  fromFile?: boolean
}

export class NotebookInvalidError extends Error {
  errors: ValidationError[]
  constructor(errors: ValidationError[]) {
    super(errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`).join('; '))
    this.name = 'NotebookInvalidError'
    this.errors = errors
  }
}

const emptyNb = (): Notebook => ({ sqlnb: '1', metadata: {}, settings: { outputs: 'separate' }, connections: [], blocks: [] })

export type AppliedOutcome =
  | { kind: 'ran' }
  | { kind: 'failed'; message: string }
  | { kind: 'skipped'; reason: 'not-select' | 'multiple' | 'unsupported-syntax' | 'unresolved-params' | 'stale-upstream' | 'no-connection' | 'busy'; detail?: string }

export function useNotebookStore(opts: { now?: () => Date; upstream?: (block: Block) => StaleReason | null; maxRows?: () => number } = {}) {
  const now = opts.now ?? (() => new Date())
  const nb = ref<Notebook>(emptyNb()) as Ref<Notebook>
  const path = ref<string | null>(null)
  const dirty = ref(false)
  const resultsDirty = ref(false)
  const resultsRevision = ref(0)
  const generation = ref(0)
  const revision = ref(0)
  const mtimeMs = ref<number | null>(null)
  const runs = reactive(new Map<string, BlockRunState>()) as Map<string, BlockRunState>

  const analysis = reactive(new Map<string, AnalysisResult>()) as Map<string, AnalysisResult>
  let analysisRunner: ((id: string) => Promise<AnalysisResult>) | null = null
  function setAnalysisRunner(fn: ((id: string) => Promise<AnalysisResult>) | null) { analysisRunner = fn }
  function refreshAnalysis(id: string): Promise<AnalysisResult> {
    if (!analysisRunner) return Promise.reject(new Error('analysis runner not set'))
    return analysisRunner(id)
  }

  const bigNumbers = reactive(new Map<string, BigNumberResult>()) as Map<string, BigNumberResult>
  let bigNumberRunner: ((id: string) => Promise<BigNumberResult>) | null = null
  function setBigNumberRunner(fn: ((id: string) => Promise<BigNumberResult>) | null) { bigNumberRunner = fn }
  function refreshBigNumber(id: string): Promise<BigNumberResult> {
    if (!bigNumberRunner) return Promise.reject(new Error('big number runner not set'))
    return bigNumberRunner(id)
  }

  // Per-block transposed-result preference; persisted as metadata.clients.dbx.transposed
  const transposed = reactive(new Map<string, boolean>()) as Map<string, boolean>

  let baselineDirty = false
  let recording = 0
  const history = createHistory({ onChange: () => { dirty.value = baselineDirty || !history.stack.isAtSavepoint() } })
  const appliedNotice = ref<{ blockId: string; revision: number; conflict: boolean; outcome?: AppliedOutcome } | null>(null)
  const loadNotices = ref<string[]>([])
  let loading = false
  const index = (id: string) => nb.value.blocks.findIndex((b) => b.id === id)
  const allIds = () => nb.value.blocks.map((b) => b.id)

  function load(text: string, p: string | null, m: number | null) {
    const parsed = parseNotebook(text)
    const v = validateNotebook(parsed)
    if (!v.valid) throw new NotebookInvalidError(v.errors)
    parsed.metadata = { ...(parsed.metadata ?? {}) }
    parsed.settings = { ...(parsed.settings ?? {}) } as Notebook['settings']
    parsed.settings.outputs ??= 'separate'
    parsed.connections = parsed.connections ?? []
    history.clear()
    appliedNotice.value = null
    loading = true
    try {
      nb.value = parsed
      path.value = p
      mtimeMs.value = m
      runs.clear()
      analysis.clear()
      bigNumbers.clear()
      transposed.clear()
      for (const b of parsed.blocks) {
        const cl = b.metadata?.clients as Record<string, Record<string, unknown>> | undefined
        if (b.type === 'sql' && cl?.dbx?.transposed === true) transposed.set(b.id, true)
      }
      loadNotices.value = []
      for (const b of parsed.blocks) {
        if (b.type === 'sql' && isValidEntry(b.outputs)) runs.set(b.id, entryToRun(b.outputs))
      }
      let changed = false
      for (const b of parsed.blocks) {
        if (b.type !== 'chart') continue
        if (repairAnalysis(b)) { changed = true; loadNotices.value.push(b.id) }
        if (regenSpec(b)) changed = true
      }
      for (const b of parsed.blocks) {
        if (b.type !== 'big-number') continue
        if (repairBigNumber(b)) { changed = true; loadNotices.value.push(b.id) }
      }
      baselineDirty = changed
      dirty.value = changed
      if (changed) revision.value++
    } finally { loading = false }
    resultsDirty.value = false
    generation.value++
  }

  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

  function repairAnalysis(b: Block): boolean {
    const m = { ...(b.metadata ?? {}) } as Record<string, unknown>
    const before = JSON.stringify([m.pivot, m.view, m.chartOptions])
    if ('pivot' in m && !isObj(m.pivot)) {
      if (isObj(m.spec) && Object.keys(m.spec).length > 0) delete m.pivot
      else m.pivot = { rows: [], columns: [], values: [] }
    }
    const norm = normalizeAnalysis(m)
    if (norm.warnings.length > 0) {
      if (isObj(m.pivot) && norm.pivot) m.pivot = norm.pivot
      if ('view' in m) m.view = norm.view
      if ('chartOptions' in m) m.chartOptions = norm.chart
    }
    if (JSON.stringify([m.pivot, m.view, m.chartOptions]) === before) return false
    b.metadata = m
    return true
  }

  // Writes data + metrics; value/label/format always mirror metrics[0]. `metrics` itself is only
  // written for blocks that already have it (or just got a second metric).
  function bigNumberMeta(m: Record<string, unknown>, data: string, metrics: Metric[], withMetrics: boolean): Record<string, unknown> {
    const first = metrics[0]
    const value: Record<string, unknown> = { ...(isObj(m.value) ? m.value : {}), field: first.field }
    if (first.aggregate !== undefined) value.aggregate = first.aggregate
    const next: Record<string, unknown> = { ...m, data, value }
    if (first.label !== undefined && first.label !== '') next.label = first.label; else delete next.label
    if (first.format !== undefined) next.format = first.format; else delete next.format
    if (withMetrics || metrics.some((x) => x.filter !== undefined || x.compare !== undefined)) next.metrics = metrics.map((x) => {
      const o: Metric = { ...x }
      if (o.label === '' || o.label === undefined) delete o.label
      return o
    })
    return next
  }

  function repairBigNumber(b: Block): boolean {
    const m = (b.metadata ?? {}) as Record<string, unknown>
    const c = normalizeBigNumber(m)
    if (c.warnings.length === 0) return false
    b.metadata = bigNumberMeta(m, c.data, c.metrics, c.hasMetrics)
    return true
  }

  function hasPivot(b: Block): boolean {
    const p = b.metadata?.pivot
    return b.type === 'chart' && !!p && typeof p === 'object' && !Array.isArray(p)
  }

  function regenSpec(b: Block): boolean {
    const m = b.metadata ?? {}
    const norm = normalizeAnalysis(m)
    const data = typeof m.data === 'string' ? m.data : ''
    if (!norm.pivot) return false
    const src = resolveSource({ nb, runs, isPartial }, data)
    if ('error' in src) return false
    const r = buildPortableSpec({ pivot: norm.pivot, chart: norm.chart, columns: src.columns, dataName: data })
    if ('error' in r) return false
    if (JSON.stringify(r.spec) === JSON.stringify(m.spec)) return false
    b.metadata = { ...m, spec: r.spec }
    return true
  }

  function sourceSignature(): string {
    return JSON.stringify(nb.value.blocks.filter(hasPivot).map((b) => {
      const d = b.metadata!.data
      const src = resolveSource({ nb, runs, isPartial }, typeof d === 'string' ? d : '')
      return 'error' in src ? null : src.columns
    }))
  }
  watch(sourceSignature, () => {
    if (loading) return
    let changed = false
    for (const b of nb.value.blocks) if (hasPivot(b) && regenSpec(b)) changed = true
    if (changed) touchKeepingNotice()
  }, { flush: 'sync' })

  function touch() {
    if (!recording) {
      baselineDirty = true
      dirty.value = true
    }
    revision.value++
  }
  // Derived refreshes (chart spec regenerated after an upstream run, inline outputs) must not hide the "Applied · Undo" bar.
  function touchKeepingNotice() {
    const keep = appliedNotice.value?.revision === revision.value
    touch()
    if (keep && appliedNotice.value) appliedNotice.value = { ...appliedNotice.value, revision: revision.value }
  }

  function toText(rewriteLinks?: Record<string, string>): string {
    nb.value.metadata ??= {}
    nb.value.metadata.modifiedAt = now().toISOString()
    const copy = clone(nb.value) as Notebook
    const inline = copy.settings?.outputs === 'inline'
    for (const b of copy.blocks) {
      delete b.outputs
      if (rewriteLinks && b.type === 'markdown' && typeof b.content === 'string') b.content = rewriteImageLinks(b.content, rewriteLinks)
      if (!inline) continue
      const run = runs.get(b.id)
      const e = run ? runToEntry(b, run, now().toISOString()) : null
      if (e) b.outputs = e
    }
    return serializeNotebook(copy)
  }

  function collectEntries(): Record<string, OutputEntry> {
    const out: Record<string, OutputEntry> = {}
    const stamp = now().toISOString()
    for (const b of [...nb.value.blocks].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
      const run = runs.get(b.id)
      const e = run ? runToEntry(b, run, stamp) : null
      if (e) out[b.id] = e
    }
    return out
  }

  function applyEntries(entries: Record<string, OutputEntry>, dbType?: string, o: { overwrite?: boolean } = {}) {
    for (const b of nb.value.blocks) {
      if (b.type !== 'sql' || !Object.prototype.hasOwnProperty.call(entries, b.id)) continue
      const cur = runs.get(b.id)
      if (cur && !(o.overwrite && cur.fromFile)) continue
      runs.set(b.id, entryToRun(entries[b.id], dbType))
    }
  }

  function setOutputsMode(mode: 'separate' | 'inline' | 'none') {
    if (nb.value.settings.outputs === mode) return
    docEdit(() => { nb.value.settings.outputs = mode; touch() })
  }

  const nowIso = () => now().toISOString()
  const effectiveMaxRows = () => clampMaxRows((opts.maxRows ?? (() => DEFAULT_MAX_ROWS))())

  function markResultsSaved(rev?: number) {
    if (rev !== undefined && rev !== resultsRevision.value) return
    resultsDirty.value = false
  }

  function noteRunFinished(_blockId: string) {
    resultsRevision.value++
    if (nb.value.settings?.outputs === 'inline') {
      touchKeepingNotice()
    } else resultsDirty.value = true
  }

  function markSaved(p: string, m: number, savedRevision?: number) {
    path.value = p
    mtimeMs.value = m
    if (savedRevision === undefined || savedRevision === revision.value) {
      baselineDirty = false
      history.stack.markSavepoint()
      dirty.value = false
    } else baselineDirty = true
  }

  function usedVariables(exceptId?: string): Set<string> {
    return new Set(
      nb.value.blocks
        .filter((b) => b.type === 'input' && b.id !== exceptId)
        .map((b) => b.metadata?.variable)
        .filter((v): v is string => typeof v === 'string'),
    )
  }

  function uniqueVariableName(base: string, exceptBlockId?: string): string {
    const taken = usedVariables(exceptBlockId)
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`
  }

  function inputVars(): InputVar[] {
    const out: InputVar[] = []
    for (const b of nb.value.blocks) {
      if (b.type !== 'input') continue
      const m = b.metadata
      if (!m || typeof m.variable !== 'string' || !INPUT_TYPES.includes(m.inputType as string)) continue
      out.push({ name: m.variable, inputType: m.inputType as InputVar['inputType'], value: Array.isArray(m.value) ? [...m.value] : m.value, multiple: m.multiple as boolean | undefined })
    }
    return out
  }

  function addBlock(type: 'markdown' | 'sql' | 'input' | 'results' | 'chart' | 'big-number', afterId: string | null): string {
    if (afterId !== null && index(afterId) < 0) throw new Error('anchor-missing')
    const id = newBlockId(allIds())
    let block: Block
    if (type === 'sql') block = { id, type, content: '', metadata: {} }
    else if (type === 'chart') block = { id, type, metadata: { data: '', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } } } as Block
    else if (type === 'big-number') block = { id, type, metadata: { data: '', value: { field: '', aggregate: 'count' } } } as Block
    else if (type === 'results') block = { id, type: 'sql', content: '', metadata: { source: 'results' } }
    else if (type === 'input') {
      const taken = usedVariables()
      let n = 1
      while (taken.has(`var${n}`)) n++
      block = { id, type, metadata: { variable: `var${n}`, inputType: 'text', value: '' } } as Block
    } else block = { id, type, content: '' }
    // afterId === null inserts at the top (existing API, empty-notebook buttons); an unknown id throws, never appends
    recordEdit('history.label.addBlock', 'user', { ids: [id], order: true }, () => insertBlock(afterId, block))
    return id
  }
  function insertBlock(afterId: string | null, block: Block) {
    const i = afterId === null ? -1 : index(afterId)
    nb.value.blocks.splice(i + 1, 0, block)
    touch()
  }

  const visualizeNotice = ref<{ blockId: string; name: string } | null>(null)
  function visualizeResult(sourceId: string): string | null {
    const src = nb.value.blocks[index(sourceId)]
    const run = runs.get(sourceId)
    if (!src || src.type !== 'sql' || run?.status !== 'ok' || !run.result || run.result.columns.length === 0) return null
    let name = resultNameOf(src)
    visualizeNotice.value = null
    const id = newBlockId(allIds())
    recordEdit('history.label.visualize', 'user', { ids: [sourceId, id], order: true }, () => {
      if (name === undefined) {
        const taken = new Set(nb.value.blocks.map((b) => resultNameOf(b)?.toLowerCase()).filter((v): v is string => !!v))
        let n = 1
        while (taken.has(`result_${n}`)) n++
        name = `result_${n}`
        src.metadata = { ...(src.metadata ?? {}), resultName: name }
        visualizeNotice.value = { blockId: sourceId, name }
      }
      insertBlock(sourceId, { id, type: 'chart', metadata: { data: '', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } } } as Block)
      const rs = resolveSource({ nb, runs, isPartial }, name)
      const g = guessAnalysis('error' in rs ? [] : rs.columns)
      writeAnalysis(id, { data: name, pivot: g.pivot, view: g.view, chartOptions: g.chart })
    })
    clearTimeout(refreshTimers.get(id))
    refreshTimers.delete(id)
    if (analysisRunner) analysisRunner(id).catch((e) => setAnalysisError(id, e))
    return id
  }

  function removeBlock(id: string) {
    const i = index(id)
    if (i < 0) return
    recordEdit('history.label.deleteBlock', 'user', { ids: [id], order: true }, () => {
      nb.value.blocks.splice(i, 1)
      touch()
    })
    runs.delete(id)
    analysis.delete(id)
    bigNumbers.delete(id)
    transposed.delete(id)
  }

  function setTransposed(id: string, v: boolean) {
    const i = index(id)
    if (i < 0) return
    if ((transposed.get(id) === true) === v) return
    recordEdit('history.label.editMeta', 'user', { ids: [id] }, () => {
    const b = nb.value.blocks[i]
    const m = { ...(b.metadata ?? {}) } as Record<string, any>
    const clients = { ...(isObj(m.clients) ? m.clients : {}) } as Record<string, any>
    const dbx = { ...(isObj(clients.dbx) ? clients.dbx : {}) }
    if (v) dbx.transposed = true
    else delete dbx.transposed
    if (Object.keys(dbx).length) clients.dbx = dbx
    else delete clients.dbx
    if (Object.keys(clients).length) m.clients = clients
    else delete m.clients
    b.metadata = m
    if (v) transposed.set(id, true)
    else transposed.delete(id)
    touch()
    })
  }

  function moveBlock(id: string, delta: -1 | 1) {
    const i = index(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= nb.value.blocks.length) return
    recordEdit('history.label.moveBlock', 'user', { ids: [id], order: true }, () => {
      const [b] = nb.value.blocks.splice(i, 1)
      nb.value.blocks.splice(j, 0, b)
      touch()
    })
  }

  function duplicateBlock(id: string): string {
    const i = index(id)
    if (i < 0) throw new Error(`unknown block ${id}`)
    const copy: Block = clone(nb.value.blocks[i]) as Block
    copy.id = newBlockId(allIds())
    const rn = copy.metadata?.resultName
    if (typeof rn === 'string' && rn) {
      const taken = new Set(
        nb.value.blocks.map((b) => b.metadata?.resultName).filter((v): v is string => typeof v === 'string'),
      )
      const takenLc = new Set([...taken].map((v) => v.toLowerCase()))
      const make = (suffix: string) => `${rn.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`
      let name = make('_copy')
      for (let n = 2; takenLc.has(name.toLowerCase()); n++) name = make(`_copy${n}`)
      copy.metadata!.resultName = name
    }
    if (copy.type === 'input' && typeof copy.metadata?.variable === 'string') {
      copy.metadata.variable = uniqueVariableName(copy.metadata.variable)
    }
    recordEdit('history.label.duplicateBlock', 'user', { ids: [copy.id], order: true }, () => insertBlock(id, copy))
    if (transposed.get(id)) transposed.set(copy.id, true)
    return copy.id
  }

  function setAnalysisError(id: string, e: unknown) {
    if (index(id) < 0) return
    analysis.set(id, { status: 'error', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: nowIso(), error: { code: 'ENGINE', message: e instanceof Error ? e.message : String(e) } })
  }

  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  type AnalysisPatch = { data?: string; pivot?: Partial<PivotConfig>; view?: View; chartOptions?: Partial<ChartOptions> }
  // A key whose value is undefined deletes it (normalizer omits it); axisTitles merges per key; a patch that changes nothing is a no-op.
  function writeAnalysis(id: string, patch: AnalysisPatch): boolean {
    const b = nb.value.blocks[index(id)]
    if (!b || b.type !== 'chart') return false
    const m = b.metadata ?? {}
    const cur = normalizeAnalysis(m)
    const data = patch.data ?? (typeof m.data === 'string' ? m.data : '')
    const norm = normalizeAnalysis({
      pivot: { ...(cur.pivot ?? { rows: [], columns: [], values: [] }), ...(patch.pivot ?? {}) },
      view: patch.view ?? cur.view,
      chartOptions: {
        ...cur.chart, ...(patch.chartOptions ?? {}),
        ...(patch.chartOptions && 'axisTitles' in patch.chartOptions
          ? { axisTitles: patch.chartOptions.axisTitles === undefined ? undefined : { ...(cur.chart.axisTitles ?? {}), ...patch.chartOptions.axisTitles } }
          : {}),
      },
    })
    const next: Record<string, unknown> = { ...m, data, pivot: norm.pivot, view: norm.view, chartOptions: norm.chart }
    const src = resolveSource({ nb, runs, isPartial }, data)
    if (!('error' in src) && norm.pivot) {
      const r = buildPortableSpec({ pivot: norm.pivot, chart: norm.chart, columns: src.columns, dataName: data })
      if (!('error' in r)) next.spec = r.spec
    }
    const semantic = (o: { data: unknown; pivot: unknown; view: unknown; chart: unknown }) => JSON.stringify([o.data, o.pivot, o.view, o.chart])
    if (semantic({ data, pivot: norm.pivot, view: norm.view, chart: norm.chart }) === semantic({ data: m.data ?? '', pivot: cur.pivot, view: cur.view, chart: cur.chart })) return false
    b.metadata = next
    touch()
    scheduleAnalysis(id)
    return true
  }
  function scheduleAnalysis(id: string) {
    clearTimeout(refreshTimers.get(id))
    refreshTimers.set(id, setTimeout(() => {
      refreshTimers.delete(id)
      if (analysisRunner && index(id) >= 0) analysisRunner(id).catch((e) => setAnalysisError(id, e))
    }, 100))
  }
  function setAnalysis(id: string, patch: AnalysisPatch) {
    const b0 = nb.value.blocks[index(id)]
    if (!b0 || b0.type !== 'chart') return
    recordEdit('history.label.editChart', 'user', { ids: [id] }, () => { writeAnalysis(id, patch) })
  }

  function pushDocEntry(label: string, source: string, before: DocDelta, after: DocDelta, o: { key?: string } = {}) {
    const at = now().getTime()
    if (o.key && history.stack.coalesceInto(o.key, at, 800, after)) return
    const entry: DocEntry = {
      id: `h${++entrySeq}`, label, source, seq: 0, before, after, sealed: false, key: o.key, at,
      bytes: deltaBytes(before) + deltaBytes(after),
      blockIds: [...new Set([...before.blocks.keys(), ...after.blocks.keys()])],
      check: (dir) => checkDelta(nb.value, entry, dir),
      undo: () => applyDelta(nb.value, entry.before),
      redo: () => applyDelta(nb.value, entry.after),
    }
    history.stack.push(entry)
  }

  function recordEdit(label: string, source: string, touched: Touched, mutate: () => void, o: { key?: string } = {}): void {
    if (recording) { mutate(); return }
    const before = cloneTouched(nb.value, touched)
    const rev0 = revision.value
    recording++
    try { mutate() } finally { recording-- }
    const after = cloneTouched(nb.value, touched)
    if (sameDelta(before, after)) { revision.value = rev0; return }
    if (revision.value === rev0) revision.value++
    pushDocEntry(label, source, before, after, o)
  }

  type BigNumberPatch = { index?: number; data?: string; field?: string; aggregate?: string; label?: string; format?: { kind: string; decimals?: number } | null; filter?: MetricFilter[] | null; compare?: MetricCompare | null }
  function scheduleBigNumber(id: string) {
    clearTimeout(refreshTimers.get(id))
    refreshTimers.set(id, setTimeout(() => {
      refreshTimers.delete(id)
      if (bigNumberRunner && index(id) >= 0) bigNumberRunner(id).catch((e) => {
        bigNumbers.set(id, { status: 'error', value: null, items: [], partial: false, ranAt: nowIso(), error: { code: 'ENGINE', message: e instanceof Error ? e.message : String(e) } })
      })
    }, 100))
  }

  function writeBigNumber(id: string, edit: (cur: ReturnType<typeof normalizeBigNumber>) => { data: string; metrics: Metric[]; withMetrics: boolean } | null, run: boolean, key?: string) {
    const b = nb.value.blocks[index(id)]
    if (!b || b.type !== 'big-number') return
    const m = (b.metadata ?? {}) as Record<string, unknown>
    const r = edit(normalizeBigNumber(m))
    if (!r) return
    recordEdit('history.label.editBigNumber', 'user', { ids: [id] }, () => {
      b.metadata = bigNumberMeta(m, r.data, r.metrics, r.withMetrics)
      touch()
    }, key ? { key } : {})
    if (run) scheduleBigNumber(id)
  }

  function setBigNumber(id: string, patch: BigNumberPatch, o: { coalesce?: boolean } = {}) {
    writeBigNumber(id, (cur) => {
      const i = Math.min(Math.max(patch.index ?? 0, 0), cur.metrics.length - 1)
      const metrics = cur.metrics.map((x) => ({ ...x }))
      const mt = metrics[i]
      if (patch.field !== undefined) mt.field = patch.field
      if (patch.aggregate !== undefined) mt.aggregate = (BIG_AGGS as readonly string[]).includes(patch.aggregate) ? patch.aggregate : 'count'
      if (patch.label !== undefined) {
        const l = patch.label.slice(0, MAX_LABEL)
        if (l) mt.label = l; else delete mt.label
      }
      if (patch.format !== undefined) {
        const f = patch.format === null ? null : normalizeFormat(patch.format)
        if (f) mt.format = f; else delete mt.format
      }
      if (patch.filter !== undefined) {
        if (patch.filter === null || patch.filter.length === 0) delete mt.filter; else mt.filter = patch.filter.map((x) => ({ ...x, ...(Array.isArray(x.value) ? { value: [...x.value] } : {}) }))
      }
      if (patch.compare !== undefined) {
        if (patch.compare === null) delete mt.compare; else mt.compare = { ...patch.compare }
      }
      return { data: patch.data ?? cur.data, metrics, withMetrics: cur.hasMetrics }
    }, patch.data !== undefined || patch.field !== undefined || patch.aggregate !== undefined || patch.filter !== undefined || patch.compare !== undefined, o.coalesce ? `${id}:bn:${patch.index ?? 0}:${Object.keys(patch).filter((k) => k !== 'index').join(',')}` : undefined)
  }

  function addBigNumberMetric(id: string) {
    writeBigNumber(id, (cur) => cur.metrics.length >= MAX_METRICS ? null : { data: cur.data, metrics: [...cur.metrics, { field: '', aggregate: 'count' }], withMetrics: true }, true)
  }

  function removeBigNumberMetric(id: string, i: number) {
    writeBigNumber(id, (cur) => cur.metrics.length <= 1 || i < 0 || i >= cur.metrics.length ? null : { data: cur.data, metrics: cur.metrics.filter((_, k) => k !== i), withMetrics: cur.hasMetrics }, true)
  }

  function moveBigNumberMetric(id: string, i: number, delta: -1 | 1) {
    writeBigNumber(id, (cur) => {
      const j = i + delta
      if (i < 0 || j < 0 || i >= cur.metrics.length || j >= cur.metrics.length) return null
      const metrics = [...cur.metrics]
      ;[metrics[i], metrics[j]] = [metrics[j], metrics[i]]
      return { data: cur.data, metrics, withMetrics: cur.hasMetrics }
    }, true)
  }

  function updateContent(id: string, content: string, o: { coalesce?: boolean } = {}) {
    if (!nb.value.blocks[index(id)]) return
    recordEdit(blockLabel(id), 'user', { ids: [id] }, () => {
      const b = nb.value.blocks[index(id)]
      b.content = content
      touch()
    }, o.coalesce ? { key: `${id}:content` } : {})
  }

  function checkDef(def: BigNumberDef) {
    if (def.metrics.length === 0) throw new Error('empty')
    if (def.metrics.length > MAX_METRICS) throw new Error('too-many-metrics')
  }
  function writeDef(id: string, def: BigNumberDef) {
    const b = nb.value.blocks[index(id)]
    const m = (b.metadata ?? {}) as Record<string, unknown>
    const cur = normalizeBigNumber(m)
    b.metadata = bigNumberMeta(m, def.data, def.metrics.map((x) => clone(x) as Metric), def.metrics.length > 1 || cur.hasMetrics)
  }

  const blockLabel = (id: string, fallback = 'history.label.editMeta') => {
    const ty = nb.value.blocks[index(id)]?.type
    return ty === 'sql' ? 'history.label.editSql' : ty === 'markdown' ? 'history.label.editMarkdown' : ty === 'input' ? 'history.label.editInput' : ty === 'big-number' ? 'history.label.editBigNumber' : fallback
  }
  function sealHistory() { history.stack.seal() }

  /** Pasted/dropped images: one sealed history entry; refs are decoded notebook-relative paths (encoded here). Returns the new caret offset. */
  function insertMarkdownImages(id: string, refs: string[], range: { from: number; to: number }, prefix = ''): number | null {
    const b = nb.value.blocks[index(id)]
    if (!b || b.type !== 'markdown' || refs.length === 0) return null
    const cur = b.content ?? ''
    const from = alignDown(cur, range.from)
    const to = range.to <= range.from ? from : Math.max(from, alignUp(cur, range.to))
    const ins = prefix + refs.map(imageLinkText).join('\n')
    sealHistory()
    recordEdit('history.label.insertImage', 'user', { ids: [id] }, () => {
      b.content = cur.slice(0, from) + ins + cur.slice(to)
      touch()
    })
    sealHistory()
    return from + ins.length
  }

  /** One toolbar action = one sealed history entry (never coalesced with typing). */
  function replaceMarkdown(id: string, content: string): void {
    const b = nb.value.blocks[index(id)]
    if (!b || b.type !== 'markdown') return
    sealHistory()
    recordEdit('history.label.mdFormat', 'user', { ids: [id] }, () => {
      b.content = content
      touch()
    })
    sealHistory()
  }

  /** Save As: rewrites image links in Markdown blocks (old relPath -> new relPath) as one edit. */
  function rewriteMarkdownImageLinks(mapping: Record<string, string>): number {
    const changed = nb.value.blocks.filter((b) => b.type === 'markdown' && typeof b.content === 'string' && rewriteImageLinks(b.content, mapping) !== b.content)
    if (changed.length === 0) return 0
    recordEdit('history.label.editMarkdown', 'user', { ids: changed.map((b) => b.id) }, () => {
      for (const b of changed) b.content = rewriteImageLinks(b.content as string, mapping)
      touch()
    })
    return changed.length
  }
  function markClean() {
    baselineDirty = false
    history.stack.markSavepoint()
    dirty.value = false
  }
  function editBlock(id: string, mutate: () => void, o: { key?: string } = {}) {
    const ty = nb.value.blocks[index(id)]?.type
    recordEdit(ty === 'input' ? 'history.label.editInput' : ty === 'big-number' ? 'history.label.editBigNumber' : 'history.label.editMeta', 'user', { ids: [id] }, mutate, o)
  }
  const docEdit = (mutate: () => void) => recordEdit('history.label.setting', 'user', { ids: [], doc: ['settings', 'connections'] }, mutate)

  function afterHistory(r: HistoryResult): HistoryResult {
    if (r.ok) {
      for (const id of r.entry?.blockIds ?? []) {
        const b = nb.value.blocks[index(id)]
        if (b?.type === 'big-number') scheduleBigNumber(id)
        else if (b?.type === 'chart') { if (hasPivot(b) && regenSpec(b)) touch(); scheduleAnalysis(id) }
        else if (b?.type === 'sql') { if (b.metadata?.clients && (b.metadata.clients as any).dbx?.transposed === true) transposed.set(id, true); else transposed.delete(id) }
        else if (!b) { runs.delete(id); analysis.delete(id); bigNumbers.delete(id); transposed.delete(id) }
      }
      revision.value++
      dirty.value = baselineDirty || !history.stack.isAtSavepoint()
      appliedNotice.value = null
    } else if (r.reason === 'conflict') {
      appliedNotice.value = { blockId: r.entry?.blockIds[0] ?? '', revision: revision.value, conflict: true }
    }
    return r
  }
  const undo = (): HistoryResult => { history.stack.seal(); return afterHistory(history.stack.undo()) }
  const redo = (): HistoryResult => { history.stack.seal(); return afterHistory(history.stack.redo()) }

  let entrySeq = 0
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)

  function applyAiEdit(edit: { label: string; run: (tx: AiTx) => void }): void {
    const before = new Map<string, Block>()
    const touched: string[] = []
    const inserted: string[] = []
    const orderBefore = allIds()
    const note = (id: string) => {
      if (before.has(id) || inserted.includes(id)) return
      const b = nb.value.blocks[index(id)]
      if (!b) return
      before.set(id, clone(b) as Block)
      touched.push(id)
    }
    const tx: AiTx = {
      updateContent(id, content) { note(id); updateContent(id, content) },
      setAnalysis(id, patch) { note(id); writeAnalysis(id, patch) },
      setBigNumberDef(id, def) {
        const b = nb.value.blocks[index(id)]
        if (!b) throw new Error('block-gone')
        if (b.type !== 'big-number') throw new Error('not-big-number')
        checkDef(def)
        note(id)
        writeDef(id, def)
      },
      insertBigNumberAfter(afterId, def) {
        if (index(afterId) < 0) throw new Error('anchor-missing')
        checkDef(def)
        const id = addBlock('big-number', afterId)
        inserted.push(id)
        writeDef(id, def)
        return id
      },
      insertAfter(type, afterId, content) {
        if (index(afterId) < 0) throw new Error('anchor-missing')
        const id = addBlock(type, afterId)
        const b = nb.value.blocks[index(id)]
        b.content = content
        inserted.push(id)
        return id
      },
    }
    const rev0 = revision.value
    const dirty0 = dirty.value
    recording++
    try {
      edit.run(tx)
    } catch (e) {
      for (const id of inserted) {
        const i = index(id)
        if (i >= 0) nb.value.blocks.splice(i, 1)
        runs.delete(id); analysis.delete(id); bigNumbers.delete(id); transposed.delete(id)
      }
      for (const id of touched) {
        const i = index(id)
        if (i >= 0) nb.value.blocks[i] = clone(before.get(id)) as Block
      }
      revision.value = rev0
      dirty.value = dirty0
      throw e
    } finally { recording-- }
    if (!touched.length && !inserted.length) return
    const beforeDelta: DocDelta = { blocks: new Map<string, Block | null>() }
    const afterDelta: DocDelta = { blocks: new Map<string, Block | null>() }
    for (const id of touched) beforeDelta.blocks.set(id, before.get(id)!)
    for (const id of inserted) beforeDelta.blocks.set(id, null)
    for (const id of [...touched, ...inserted]) {
      const b = nb.value.blocks[index(id)]
      afterDelta.blocks.set(id, b ? (clone(b) as Block) : null)
    }
    if (inserted.length) { beforeDelta.order = orderBefore; afterDelta.order = allIds() }
    if (revision.value === rev0) revision.value++
    pushDocEntry(edit.label, 'ai', beforeDelta, afterDelta)
    appliedNotice.value = { blockId: touched[0] ?? inserted[0], revision: revision.value, conflict: false }
  }

  function updateMeta(id: string, patch: Record<string, unknown>, o: { coalesce?: string } = {}) {
    if (!nb.value.blocks[index(id)]) return
    recordEdit(blockLabel(id) === 'history.label.editInput' ? 'history.label.editInput' : 'history.label.editMeta', 'user', { ids: [id] }, () => {
      const b = nb.value.blocks[index(id)]
      b.metadata = { ...(b.metadata ?? {}), ...patch }
      touch()
    }, o.coalesce ? { key: `${id}:meta:${o.coalesce}` } : {})
  }

  function removeMetaKey(id: string, key: string, o: { coalesce?: string } = {}) {
    const b = nb.value.blocks[index(id)]
    if (!b || !b.metadata || !(key in b.metadata)) return
    recordEdit(blockLabel(id) === 'history.label.editInput' ? 'history.label.editInput' : 'history.label.editMeta', 'user', { ids: [id] }, () => {
      const m = { ...b.metadata }
      delete m[key]
      b.metadata = m
      touch()
    }, o.coalesce ? { key: `${id}:meta:${o.coalesce}` } : {})
  }

  function setDefaultConnection(name: string, dialect?: string) {
    docEdit(() => {
      nb.value.settings ??= { outputs: 'separate' }
      nb.value.connections ??= []
      nb.value.settings.defaultConnection = name
      if (!nb.value.connections.some((c) => c.name === name)) {
        nb.value.connections.push(dialect !== undefined ? { name, dialect } : { name })
      }
      touch()
    })
  }

  function setDefaultCatalog(database?: string, schema?: string) {
    docEdit(() => {
      const settings = (nb.value.settings ??= { outputs: 'separate' })
      settings.outputs ??= 'separate'
      let changed = false
      for (const [key, raw] of [['defaultDatabase', database], ['defaultSchema', schema]] as const) {
        const v = raw?.trim() || undefined
        if (settings[key] === v) continue
        if (v === undefined) delete settings[key]
        else settings[key] = v
        changed = true
      }
      if (changed) touch()
    })
  }

  function blockById(id: string) {
    return nb.value.blocks.find((b) => b.id === id)
  }

  function reasonsFor(b: Block, seen: Set<string>): StaleReason[] {
    return computeStale(b, runs.get(b.id), { vars: inputVars(), upstream: opts.upstream ?? ((x) => upstreamStale(x, seen)) })
  }

  function upstreamStale(b: Block, seen: Set<string>): StaleReason | null {
    if (!isResultsBlock(b)) return null
    if (seen.has(b.id)) return null
    const next = new Set(seen).add(b.id)
    let ups: Block[]
    try { ups = upstreamOf(b, nb.value.blocks) } catch (e) {
      if (e instanceof DepError) return 'upstream'
      throw e
    }
    const rec = runs.get(b.id)?.upstream
    const present = new Set(ups.map((u) => resultNameOf(u)!))
    if (rec && Object.keys(rec).some((k) => !present.has(k))) return 'upstream'
    for (const u of ups) {
      const run = runs.get(u.id)
      if (run?.status === 'running') continue
      if (!run || run.status !== 'ok') return 'upstream'
      if (reasonsFor(u, next).length > 0) return 'upstream'
      const name = resultNameOf(u)!
      if (rec?.[name] === undefined || (run.executedAt ?? '') !== rec[name]) return 'upstream'
    }
    return null
  }

  function chartStale(b: Block): StaleReason[] {
    const res = b.type === 'big-number' ? bigNumbers.get(b.id) : analysis.get(b.id)
    if (!res) return []
    const data = typeof b.metadata?.data === 'string' ? b.metadata.data : ''
    const src = findSourceBlock({ nb }, data)
    const run = src ? runs.get(src.id) : undefined
    if (run?.status === 'running') return []
    if (run?.status === 'ok') return run.executedAt !== res.sourceExecutedAt ? ['upstream'] : []
    return res.sourceExecutedAt !== undefined ? ['upstream'] : []
  }

  function staleReasons(id: string): StaleReason[] {
    const b = blockById(id)
    if (!b) return []
    if (b.type === 'chart' || b.type === 'big-number') return chartStale(b)
    return reasonsFor(b, new Set())
  }

  function isPartial(id: string, seen: Set<string> = new Set()): boolean {
    const run = runs.get(id)
    if (!run || run.status !== 'ok') return false
    if (run.partial !== undefined) return run.partial
    if (run.result?.truncated) return true
    if (seen.has(id)) return false
    seen.add(id)
    const names = Object.keys(run.upstream ?? {}).map((n) => n.toLowerCase())
    return nb.value.blocks.some((u) => {
      const n = resultNameOf(u)
      return n !== undefined && names.includes(n.toLowerCase()) && isPartial(u.id, seen)
    })
  }

  function isStale(id: string): boolean {
    return staleReasons(id).length > 0
  }

  return {
    nb, path, dirty, resultsDirty, resultsRevision, collectEntries, applyEntries, setOutputsMode, effectiveMaxRows, nowIso, markResultsSaved, noteRunFinished, revision, mtimeMs, runs, generation, loadNotices, analysis, transposed, setTransposed, setAnalysisRunner, refreshAnalysis, bigNumbers, setBigNumberRunner, refreshBigNumber, setBigNumber, addBigNumberMetric, removeBigNumberMetric, moveBigNumberMetric,
    load, toText, markSaved, addBlock, visualizeResult, visualizeNotice, removeBlock, moveBlock, duplicateBlock,
    history, appliedNotice, undo, redo, applyAiEdit, recordEdit, editBlock, sealHistory, markClean, insertMarkdownImages, replaceMarkdown, rewriteMarkdownImageLinks,
    updateContent, setAnalysis, updateMeta, removeMetaKey, setDefaultConnection, setDefaultCatalog, isStale, staleReasons, isPartial,
    inputVars, uniqueVariableName,
  }
}
