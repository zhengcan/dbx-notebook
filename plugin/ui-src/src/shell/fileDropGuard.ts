// Dropping a file on a page that does not handle it makes the webview navigate to that file, replacing the plugin.
// Block-level handlers run first (they bubble up here); this only catches what nobody took. Text, link and
// in-app selection drags carry no 'Files' type and are never touched.
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

export function installFileDropGuard(doc: Document): () => void {
  const over = (e: Event) => {
    const ev = e as DragEvent
    if (ev.defaultPrevented || !hasFiles(ev)) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none'
  }
  const drop = (e: Event) => {
    const ev = e as DragEvent
    if (!ev.defaultPrevented && hasFiles(ev)) ev.preventDefault()
  }
  doc.addEventListener('dragover', over)
  doc.addEventListener('drop', drop)
  return () => { doc.removeEventListener('dragover', over); doc.removeEventListener('drop', drop) }
}
