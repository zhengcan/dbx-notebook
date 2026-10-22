// Single source of truth for which Markdown image sources may be shown (preview and export).
// Mirrors `check_rel` in plugin/backend/notebook-files/src/images.rs; the sidecar re-checks every path.
export const MAX_REL_LEN = 1024
export const ALLOWED_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/

export type SrcClass = { kind: 'data'; src: string } | { kind: 'relative'; rel: string } | { kind: 'blocked' }

const BLOCKED: SrcClass = { kind: 'blocked' }
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const BAD_CHARS = /[\\%:?#*<>|"]/

/** Lexical check of a decoded notebook-relative path. */
export function isSafeRel(rel: string): boolean {
  if (!rel || rel.length > MAX_REL_LEN) return false
  if (/^[/\\~]/.test(rel) || CONTROL.test(rel) || BAD_CHARS.test(rel)) return false
  for (const seg of rel.split('/')) {
    // `..` is rejected by the trailing-dot rule (it ends with '.' and is not '.'); test: imageResolverShared '.. segments'.
    if (seg === '' || (seg.endsWith('.') && seg !== '.') || seg.endsWith(' ')) return false
    if (RESERVED.test(seg.split('.')[0])) return false
  }
  return true
}

export function classifySrc(src: string): SrcClass {
  if (typeof src !== 'string') return BLOCKED
  const s = src.trim()
  if (/^data:/i.test(s)) return ALLOWED_DATA.test(s) ? { kind: 'data', src: s } : BLOCKED
  if (!s || s.length > MAX_REL_LEN * 3) return BLOCKED
  const bare = s.replace(/[?#].*$/s, '')
  if (!bare || CONTROL.test(bare)) return BLOCKED
  let rel: string
  try { rel = decodeURIComponent(bare) } catch { return BLOCKED }
  return isSafeRel(rel) ? { kind: 'relative', rel } : BLOCKED
}
