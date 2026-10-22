import type { Capabilities } from '../host/bridge'
import type { AiSendOptions } from './aiSettings'
import type { BlockRunState } from '../state/notebookStore'

export type InterpretGate = { enabled: true } | { enabled: false; reason: 'no-data-setting' | 'no-result' | 'empty-result' | 'ai-busy' | 'unsupported' }

export function interpretGate(input: { caps: Capabilities; send: AiSendOptions; run: BlockRunState | undefined; busy: boolean }): InterpretGate {
  if (input.caps.aiCompletion !== true) return { enabled: false, reason: 'unsupported' }
  if (input.run?.status !== 'ok' || !input.run.result) return { enabled: false, reason: 'no-result' }
  if (input.run.result.rows.length === 0) return { enabled: false, reason: 'empty-result' }
  if (!input.send.data) return { enabled: false, reason: 'no-data-setting' }
  if (input.busy) return { enabled: false, reason: 'ai-busy' }
  return { enabled: true }
}
