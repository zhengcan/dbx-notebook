export const IME_WINDOW_MS = 50

// macOS WebKit fires the Enter that commits an IME candidate AFTER compositionend, with isComposing=false
// and keyCode 229 / key 'Process'. Track composition ourselves and keep a short grace window after it ends.
export function createImeGuard(now: () => number = () => performance.now()) {
  let composing = false
  let endedAt = -Infinity
  return {
    onCompositionStart(): void { composing = true },
    onReset(): void { composing = false },
    onCompositionEnd(): void { composing = false; endedAt = now() },
    isImeEnter(e: KeyboardEvent): boolean {
      return composing || e.isComposing || e.keyCode === 229 || e.key === 'Process' || now() - endedAt <= IME_WINDOW_MS
    },
  }
}
