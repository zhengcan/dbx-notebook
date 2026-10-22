const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor'

// The native menu (copy/paste/...) is only useful in editable areas and over selected text;
// everywhere else the host webview's menu ("Open Frame In New Window", ...) is suppressed.
export function allowNativeContextMenu(target: EventTarget | null, selection: Selection | null): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (el?.closest(EDITABLE)) return true
  if (!el || !selection || selection.isCollapsed || !selection.toString()) return false
  try {
    for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(target as Node)) return true
  } catch { /* ignore */ }
  return false
}
