import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Block, Notebook } from '@sqlnb/format'
import { deltaBytes, sameDelta } from './docHistory'

export interface DocDelta {
  blocks: Map<string, Block | null>
  order?: string[]
  settings?: Notebook['settings']
  connections?: Notebook['connections']
  metadata?: Notebook['metadata']
}

export interface HistoryEntry {
  id: string
  label: string
  source: string
  blockIds: string[]
  seq?: number
  bytes?: number
  check(dir: 'undo' | 'redo'): 'ok' | 'conflict'
  undo(): void
  redo(): void
}

export interface DocEntry extends HistoryEntry {
  seq: number
  before: DocDelta
  after: DocDelta
  bytes: number
  sealed: boolean
  key?: string
  at: number
}

export type HistoryResult =
  | { ok: true; entry: HistoryEntry }
  | { ok: false; reason: 'empty' | 'conflict'; entry?: HistoryEntry }

export class HistoryStack {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private readonly cap: number
  private readonly maxBytes: number
  private readonly onChange?: () => void
  private counter = 0
  private floor = 0
  savepoint: number | null = 0

  constructor(opts: { cap?: number; maxBytes?: number; onChange?: () => void } = {}) {
    this.cap = opts.cap ?? 200
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024
    this.onChange = opts.onChange
  }

  private bytesTotal(): number { return this.undoStack.reduce((n, e) => n + (e.bytes ?? 0), 0) }
  topSeq(): number { return this.undoStack[this.undoStack.length - 1]?.seq ?? this.floor }
  isAtSavepoint(): boolean { return this.savepoint !== null && this.savepoint === this.topSeq() }
  markSavepoint(): void { this.seal(); this.savepoint = this.topSeq() }
  seal(): void {
    const top = this.undoStack[this.undoStack.length - 1] as DocEntry | undefined
    if (top && 'sealed' in top) top.sealed = true
  }
  coalesceInto(key: string, at: number, windowMs: number, after: DocDelta): boolean {
    const top = this.undoStack[this.undoStack.length - 1] as DocEntry | undefined
    if (!top || this.redoStack.length || top.sealed !== false || top.key !== key || at - top.at > windowMs || at < top.at) return false
    if (sameDelta(top.before, after)) {
      this.undoStack.pop()
      this.onChange?.()
      return true
    }
    top.after = after
    top.at = at
    top.bytes = deltaBytes(top.before) + deltaBytes(after)
    this.onChange?.()
    return true
  }

  get undoDepth() { return this.undoStack.length }
  get redoDepth() { return this.redoStack.length }
  canUndo() { return this.undoStack.length > 0 }
  canRedo() { return this.redoStack.length > 0 }
  peekUndo(): HistoryEntry | undefined { return this.undoStack[this.undoStack.length - 1] }

  push(e: HistoryEntry): void {
    e.seq = ++this.counter
    if (this.savepoint !== null && this.savepoint > this.topSeq()) this.savepoint = null
    this.undoStack.push(e)
    this.redoStack = []
    const drop = () => {
      const d = this.undoStack.shift()!
      this.floor = d.seq!
      if (this.savepoint === d.seq) this.savepoint = null
    }
    while (this.undoStack.length > this.cap) drop()
    while (this.undoStack.length > 1 && this.bytesTotal() > this.maxBytes) drop()
    this.onChange?.()
  }

  undo(): HistoryResult { return this.step('undo') }
  redo(): HistoryResult { return this.step('redo') }

  clear(): void {
    this.savepoint = 0
    this.floor = 0
    if (!this.undoStack.length && !this.redoStack.length) return
    this.undoStack = []
    this.redoStack = []
    this.onChange?.()
  }

  private step(dir: 'undo' | 'redo'): HistoryResult {
    const from = dir === 'undo' ? this.undoStack : this.redoStack
    const to = dir === 'undo' ? this.redoStack : this.undoStack
    const entry = from[from.length - 1]
    if (!entry) return { ok: false, reason: 'empty' }
    if (entry.check(dir) === 'conflict') {
      from.pop()
      if (dir === 'undo') {
        if (this.savepoint === entry.seq) this.savepoint = this.topSeq()
        else if (this.savepoint === this.topSeq()) this.savepoint = null
      } else if (this.savepoint === entry.seq) this.savepoint = null
      this.onChange?.()
      return { ok: false, reason: 'conflict', entry }
    }
    if (dir === 'undo') entry.undo(); else entry.redo()
    from.pop()
    to.push(entry)
    this.onChange?.()
    return { ok: true, entry }
  }
}

export function createHistory(opts: { cap?: number; maxBytes?: number; onChange?: () => void } = {}): {
  stack: HistoryStack
  undoDepth: Ref<number>
  redoDepth: Ref<number>
  canUndo: ComputedRef<boolean>
  canRedo: ComputedRef<boolean>
  lastLabel: Ref<string | null>
  clear(): void
} {
  const undoDepth = ref(0)
  const redoDepth = ref(0)
  const lastLabel = ref<string | null>(null)
  const stack: HistoryStack = new HistoryStack({
    cap: opts.cap,
    maxBytes: opts.maxBytes,
    onChange: () => {
      undoDepth.value = stack.undoDepth
      redoDepth.value = stack.redoDepth
      lastLabel.value = stack.peekUndo()?.label ?? null
      opts.onChange?.()
    },
  })
  return { stack, undoDepth, redoDepth, canUndo: computed(() => undoDepth.value > 0), canRedo: computed(() => redoDepth.value > 0), lastLabel, clear: () => stack.clear() }
}
