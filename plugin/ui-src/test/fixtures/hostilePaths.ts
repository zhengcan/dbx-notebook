// Shared table for the TS image policy (imagePolicy.test.ts). Mirrors the Rust `resolve_rel_rejects_hostile` /
// `resolve_rel_accepts_good` lists in plugin/backend/notebook-files/src/images.rs; keep both in sync.
// TS decodes once first, so `a%2fb.png` is the harmless `a/b.png` here (Rust sees the decoded string only).
export const HOSTILE_SRCS: string[] = [
  '', '   ', '../a.png', 'a/../../b.png', '/etc/hosts', '\\\\server\\share\\x.png', 'C:\\x.png', 'C:/x.png',
  'file:///etc/passwd', 'http://h/x.png', 'https://h/x.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+',
  'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/avif;base64,AAAA', 'data:image/jxl;base64,AAAA', 'data:image/heic;base64,AAAA',
  'data:image/png;base64,AA AA', 'data:image/png,AAAA', 'a\\b.png', '%2e%2e/a.png', '%2E%2E%2Fa.png', '%252e%252e/a.png',
  'a%00.png', 'a%0a.png', 'CON.png', 'dir/NUL', 'dir/lpt9', 'a.png.', 'a.png%20', '~/x.png', '//host/x.png', 'a/../b.png', '..',
  'a//b.png', 'a.png:stream', 'a\nb.png', 'a\tb.png', '%ZZ.png', '%', 'a|b.png', 'a*b.png', 'a<b.png', '#frag', '?q=1',
  'a/'.repeat(600) + 'x.png',
]

export const GOOD_SRCS: Array<[string, string]> = [
  ['./pic.png', './pic.png'],
  ['assets/pic.png', 'assets/pic.png'],
  ['book.sqlnb.assets/a.png', 'book.sqlnb.assets/a.png'],
  ['%E5%9B%BE%20%E7%89%87/%C3%A9%20a%20b.png', '图 片/é a b.png'],
  ['A.PNG', 'A.PNG'],
  ['a.png?v=2', 'a.png'],
  ['a.png#x', 'a.png'],
]
