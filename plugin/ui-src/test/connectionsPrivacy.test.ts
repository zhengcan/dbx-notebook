import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { makeConnections } from './connectionsEnv'
import { buildSqlPrompt, buildInterpretPrompt } from '../src/ai/prompt'
import { buildChatPrompt } from '../src/ai/promptChat'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'
import { buildExportModel } from '../src/export/model'

const S = 'SENTINEL_HOST_CONN_ZZ'
const ID = 'sid-secret-9'
const send = { schema: true, sql: true, data: true }

describe('host connection list never reaches AI prompt builders or the export path', () => {
  it('Interpret/Chart/SQL prompts, promptChat and export model carry no connection data', async () => {
    const { connections } = await makeConnections([{ id: ID, name: S, dialect: 'SENTINELDIALECT', readOnly: true }])
    expect(connections.list().map((c) => c.name)).toContain(S)

    const result = { totalRows: 1, shownRows: 1, columns: [{ name: 'x' }], rows: [['1']], truncatedAtRun: false } as any
    const base = { locale: 'en' as const, dialect: 'postgres', send, schemas: [], result, currentSql: 'select 1', userText: 'hi' }
    const out: string[] = [
      buildSqlPrompt(base).text,
      buildInterpretPrompt(base).text,
      buildSqlPrompt({ ...base, chart: { current: { type: 'bar' }, columns: [{ name: 'x' }] } }).text,
    ]
    for (const purpose of ['sql', 'interpret', 'chart'] as const) {
      out.push(buildChatPrompt({ locale: 'en', dialect: 'postgres', send, purpose, schemas: [], result, history: [], userText: 'q', chart: purpose === 'chart' ? { current: {}, columns: [{ name: 'x' }] } : undefined }).text)
    }
    const nb = { sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'a', type: 'sql', content: 'select 1', metadata: { resultName: 'A' } }] }
    const model = buildExportModel({
      store: { nb: ref(nb), runs: new Map([['a', { status: 'ok', result: { columns: [{ name: 'x' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'x' }, executedAt: '2026-10-18T09:00:00Z' }]]), analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map() } as any,
      options: DEFAULT_EXPORT_OPTIONS, now: new Date('2026-10-18T10:00:00Z'), dataSourceName: () => 'db',
    })
    out.push(JSON.stringify(model))
    const all = out.join('\n')
    expect(out.every((s) => s.length > 0)).toBe(true)
    for (const bad of [S, ID, 'SENTINELDIALECT']) expect(all).not.toContain(bad)
  })
})
