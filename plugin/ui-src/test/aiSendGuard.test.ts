/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'

const SRC_FILES = import.meta.glob('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// Display-only reads (checkbox state) are the only allowed direct reads of the fail-open `send` ref.
const DISPLAY_ONLY = new Set(['shell/StartPage.vue'])
// Pure functions that receive already-resolved (fail-closed) options as an argument named `send`.
const PURE_CONSUMERS = new Set(['ai/chartAiGate.ts', 'ai/interpretGate.ts', 'ai/metricsAiGate.ts', 'ai/prompt.ts', 'ai/promptChat.ts'])
// Best-effort speed bump, NOT proof: a regex scan of comment-stripped file text. Dynamic access, other aliases or
// re-exports can still bypass it; the real protection is code review plus the behavioural probe tests.
const PATTERNS = [
  /[sS]ettings\w*\s*\??\.?\s*\[\s*['"`]send['"`]\s*\]/,
  /[sS]ettings\w*\s*\??\s*\.\s*send\b(?!Options)/,
  /\{[^{}]*\bsend\b[^{}]*\}\s*=\s*\w*[sS]ettings\b/,
  /\.\s*send\s*\??\.\s*(value|data|schema|sql)\b/,
]
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

export function directSendReads(files: Record<string, string>): string[] {
  const hits: string[] = []
  for (const [file, text] of Object.entries(files)) {
    if (file === 'ai/aiSettings.ts' || DISPLAY_ONLY.has(file) || PURE_CONSUMERS.has(file)) continue
    const code = stripComments(text)
    if (PATTERNS.some((re) => re.test(code))) hits.push(file)
  }
  return hits
}

describe('AI send options are only read through the fail-closed accessor', () => {
  it('detects direct reads (guard self-check)', () => {
    expect(directSendReads({ 'a.ts': 'if (aiSettings.send.value.data) {}' })).toHaveLength(1)
    expect(directSendReads({ 'a.ts': 'const { send } = aiSettings' })).toHaveLength(1)
    expect(directSendReads({ 'a.ts': 'const s = await aiSettings.sendOptions()' })).toHaveLength(0)
    expect(directSendReads({ 'a.ts': '// never read aiSettings.send directly' })).toHaveLength(0)
    expect(directSendReads({ 'a.ts': '/* aiSettings.send.value\n   aiSettings.send */ const ok = 1' })).toHaveLength(0)
  })
  it('catches bracket, multi-line, alias and chained forms', () => {
    const bad: Record<string, string> = {
      bracket: "const s = aiSettings['send']",
      bracketDq: 'const s = aiSettings["send"].value',
      optional: 'const s = aiSettings?.send',
      optionalBracket: "const s = aiSettings?.['send']",
      split: 'const s = aiSettings\n  .send\n  .value',
      destructure: 'const {\n  send\n} = aiSettings',
      destructureMore: 'const { model, send: s } = aiSettings',
      aliasValue: 'const a = aiSettings\nconst d = a.send.value.data',
      aliasData: 'if (opts.send.data) {}',
      aliasSql: 'x.send.sql',
      aliasSchema: 'x.send.schema',
      commentThenCode: '// ok\nconst s = aiSettings.send.value',
    }
    for (const [name, text] of Object.entries(bad)) expect(directSendReads({ 'a.ts': text }), name).toHaveLength(1)
  })
  it('does not flag the accessor or unrelated names', () => {
    expect(directSendReads({ 'a.ts': 'const { sendOptions } = aiSettings\nawait aiSettings.sendOptions()' })).toHaveLength(0)
    expect(directSendReads({ 'a.ts': 'const { model } = aiSettings; const sender = 1' })).toHaveLength(0)
  })
  it('no source file outside aiSettings.ts reads aiSettings.send', () => {
    const files = Object.fromEntries(Object.entries(SRC_FILES).map(([p, text]) => [p.replace('../src/', ''), text]))
    expect(Object.keys(files).length).toBeGreaterThan(50)
    expect(directSendReads(files)).toEqual([])
    // display-only exception must stay display-only
    expect(files['shell/StartPage.vue'].match(/aiSettings\.send\b/g)?.length).toBe(1)
  })
})
