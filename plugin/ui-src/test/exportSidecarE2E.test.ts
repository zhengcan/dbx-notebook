// @ts-nocheck -- node-only: spawns a packaged sidecar; runs only with SQLNB_SIDECAR=/path/to/dbx-plugin-plugin
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'
import { runExport } from '../src/export/runExport'
import { createExportClient } from '../src/export/exportClient'
import { createHostBridge } from '../src/host/bridge'
import { setLocale, t } from '../src/i18n'
import { buildExportLabels } from '../src/export/labels'

const BIN = process.env.SQLNB_SIDECAR
setLocale('en')

function sidecar(dataDir: string) {
  const p = spawn(BIN!, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir } })
  let buf = ''; let id = 0
  const pend = new Map<number, (m: any) => void>()
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); pend.get(m.id)?.(m) } catch { /* not a response */ } } })
  const call = (method: string, params: unknown) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
  return { call, close: () => p.kill() }
}
const store = () => ({
  nb: ref({ sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'm1', type: 'markdown', content: 'hello', metadata: {} }] }),
  runs: new Map(), analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(), dirty: ref(false),
  refreshAnalysis: async () => ({}), refreshBigNumber: async () => ({}),
})

describe.skipIf(!BIN)('overwrite against the real sidecar over stdio', () => {
  for (const format of ['html', 'pdf'] as const) {
    it(`${format}: existing target -> target-exists -> retry with overwrite replaces the file`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlnb-e2e-'))
      const sc = sidecar(dir)
      window.dbxPlugin = {
        invoke: async (method: string, params: unknown) => {
          const m = await sc.call(method, params)
          if (m.error) throw new Error(m.error.message)
          return m.result
        },
      }
      const client = createExportClient(createHostBridge())
      const target = join(dir, `r.${format}`)
      writeFileSync(target, 'OLD')
      const mk = (overwrite?: boolean) => runExport({ store: store() as any, client, settings: { browserPath: ref('') }, labels: buildExportLabels((k, p) => t(k as any, p as any)), path: target, overwrite, dataSourceName: () => undefined }, { ...DEFAULT_EXPORT_OPTIONS, format }).promise
      const first = await mk()
      expect(first).toMatchObject({ ok: false, code: 'target-exists' })
      expect(readFileSync(target, 'utf8')).toBe('OLD')
      const second = await mk(true)
      expect(second).toMatchObject({ ok: true })
      const out = readFileSync(target)
      expect(out.slice(0, 4).toString()).toBe(format === 'pdf' ? '%PDF' : '<!DO')
      expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
      sc.close()
    }, 60_000)
  }
})
