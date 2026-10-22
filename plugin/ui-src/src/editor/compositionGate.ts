// Holds back document updates while an IME composition is active and emits the settled document once.
export function createCompositionGate(emit: (doc: string) => void) {
  let pending = false
  return {
    update(docChanged: boolean, composing: boolean, doc: string): void {
      if (docChanged && composing) { pending = true; return }
      if (docChanged || (pending && !composing)) { pending = false; emit(doc) }
    },
    end(doc: string): void {
      if (pending) { pending = false; emit(doc) }
    },
  }
}
