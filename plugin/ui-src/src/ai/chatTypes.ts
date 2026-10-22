export type ChatPart = { kind: 'text'; text: string } | { kind: 'data'; text: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; parts: ChatPart[]; at: number; sqlAfter?: string; markdownAfter?: string; chartAfter?: string; metricsAfter?: string; metricsSampled?: boolean; metricsSchema?: boolean; resultSig?: string; catalog?: { list?: boolean; tables?: string[] } }
export interface ChatRecord { v: 1; messages: ChatMessage[]; baseline?: string; updated: number }
