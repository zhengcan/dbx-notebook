import type { DropSummary, ImageSource } from './mdImagePaste'

export interface DropTarget {
  id: string
  el: HTMLElement | null
  isEditing(): boolean
  insert(sources: ImageSource[], o: { signal?: AbortSignal; summary: DropSummary; viaRecent: boolean }): Promise<void>
}

export type DropReason = 'editing' | 'recent' | 'sole' | 'none'

export function createDropTargets() {
  const targets: DropTarget[] = []
  const touched = new Map<string, number>()
  let seq = 0
  let last: string | null = null
  return {
    register(t: DropTarget): () => void {
      targets.push(t)
      return () => {
        const i = targets.indexOf(t)
        if (i >= 0) targets.splice(i, 1)
        touched.delete(t.id)
        if (last === t.id) last = null
      }
    },
    touch(id: string) {
      if (!targets.some((t) => t.id === id)) return
      touched.set(id, ++seq)
      last = id
    },
    list(): DropTarget[] {
      return [...targets].sort((a, b) => (touched.get(a.id) ?? 0) - (touched.get(b.id) ?? 0))
    },
    lastActiveId(): string | null {
      return last
    },
  }
}

export function pickDropTarget(blocks: DropTarget[], lastActiveId: string | null): { target: DropTarget | null; reason: DropReason } {
  const editing = blocks.filter((b) => b.isEditing())
  if (editing.length) return { target: editing.find((b) => b.id === lastActiveId) ?? editing[editing.length - 1], reason: 'editing' }
  const recent = lastActiveId ? blocks.find((b) => b.id === lastActiveId) : undefined
  if (recent) return { target: recent, reason: 'recent' }
  if (blocks.length === 1) return { target: blocks[0], reason: 'sole' }
  return { target: null, reason: 'none' }
}
