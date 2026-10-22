import type { ExportFormat } from './options'

export function splitPath(p: string): { folder: string; name: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return { folder: '', name: p }
  return { folder: i === 0 ? p.slice(0, 1) : p.slice(0, i), name: p.slice(i + 1) }
}

export function joinPath(folder: string, name: string): string {
  if (!folder) return name
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return /[\\/]$/.test(folder) ? folder + name : folder + sep + name
}

export function withExt(name: string, ext: ExportFormat): string {
  if (!name) return name
  return `${name.replace(/\.(pdf|html)$/i, '')}.${ext}`
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function suggestFileName(fileName: string, now: Date, ext: ExportFormat, untitled: string): string {
  const clean = (s: string) => s.replace(/\.sqlnb$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim()
  const base = clean(fileName) || clean(untitled) || 'notebook'
  return `${base}-${stamp(now)}.${ext}`
}

const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f]/

/** `name` is the editable base name (the extension is fixed by the format and appended automatically). */
export function validateBaseName(name: string): 'empty' | 'invalid' | null {
  const n = name.replace(/\.(pdf|html)$/i, '').trim()
  if (!n) return 'empty'
  if (BAD_CHARS.test(n) || n === '.' || n === '..' || /[. ]$/.test(n)) return 'invalid'
  return null
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.(pdf|html)$/i, '')
}
