// Writes highlight.html (export with highlighted SQL + Markdown fences) and sources.json for scripts/export-highlight-check.mjs (vite-node).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { virtualConsole: new VirtualConsole() })
for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'NodeFilter']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : (dom.window as any)[k], configurable: true, writable: true })
}
const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })
const { renderExportHtml } = await import('../src/export/html')
const { DEFAULT_EXPORT_OPTIONS } = await import('../src/export/options')

const SQL = "-- revenue by region\nSELECT region, count(*) AS n, 'ok' AS s\nFROM orders\nWHERE amount > 100 AND note <> '</span><script>window.__pwned=1</script>'\nGROUP BY region;"
const FENCES: Record<string, string> = {
  sql: "SELECT id, 'x' FROM t WHERE n >= 10 -- c",
  json: '{"name": "demo", "n": [1, 2.5, true, null]}',
  yaml: '# cfg\nname: demo\nitems:\n  - 1\n  - "two"',
  javascript: 'const f = (a) => a + 1 // c\nconsole.log("hi", 42)',
  typescript: 'interface A { x: number }\nconst a: A = { x: 1 }',
  python: 'def f(x):\n    # c\n    return "s" + str(1)',
  bash: 'if [ -f a ]; then echo "x"; fi # c',
}
const md = Object.entries(FENCES).map(([l, c]) => '```' + l + '\n' + c + '\n```').join('\n\n') + '\n\n```cobol\nMOVE 1 TO X\n```\n'
const L: any = { exporter: '', firstN: () => '', truncatedAtRun: () => '', empty: '', exportedAt: '', dataRunAt: '', dataSource: '', chartUnavailable: '', noData: '', page: '', serial: '#', summary: '', notSet: '', continued: '', colon: ':', listSep: ';' }
const model: any = {
  documentTitle: 'T', exportedAt: '2026-10-18T00:00:00.000Z', runTimes: [], exporter: null, dataSources: [], note: '', catalog: [], skipped: [], staleBlockIds: [], estimate: { totalRows: 1, bigTables: [] }, exportable: true,
  sections: [
    { kind: 'table', blockId: 't', columns: ['region', 'n'], rows: [['a', '1']], nullMask: [[false, false]], totalRows: 1, shownRows: 1, limitedNote: null, groups: [{ cols: [0, 1] }], numeric: [false, true], sql: SQL },
    { kind: 'markdown', blockId: 'm', source: md },
  ],
}
writeFileSync(join(outDir, 'highlight.html'), renderExportHtml(model, DEFAULT_EXPORT_OPTIONS, {}, L))
writeFileSync(join(outDir, 'sources.json'), JSON.stringify({ sql: SQL, fences: FENCES }))
