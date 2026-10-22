export interface Rows { dims: string[]; measures: string[]; rows: unknown[][] }
export type AnalysisErrorCode = 'NO_SOURCE' | 'SOURCE_NOT_RUN' | 'BAD_FIELD' | 'ENGINE' | 'SQL'

export interface AnalysisResult {
  status: 'ok' | 'error' | 'empty'
  long?: Rows
  excludedDateRows: number
  partial: boolean
  tooManyPoints: boolean
  error?: { message: string; code: AnalysisErrorCode }
  sourceExecutedAt?: string
  ranAt: string
}

export type BigNumberErrorCode = AnalysisErrorCode | 'TYPE' | 'NO_FIELD' | 'BAD_AGG' | 'FILTER' | 'COMPARE'

// current/previous are 'YYYY-MM'. deltaPct = (currentValue - previousValue) / |previousValue|, null when
// previousValue is null/0 or either value is not a finite number.
export interface BigNumberCompare {
  kind: 'mom' | 'yoy'; current: string; previous: string
  currentValue: unknown; previousValue: unknown; deltaPct: number | null
}

export interface BigNumberItem {
  value: unknown
  error?: { message: string; code: BigNumberErrorCode }
  compare?: BigNumberCompare
  info?: { code: 'COMPARE_NO_DATES' }
}

// One entry per metric in `items`. `status` is 'error' when the block cannot run at all or every
// metric failed; `value`/`error` then mirror the first item (single-metric compatibility).
export interface BigNumberResult {
  status: 'ok' | 'error'
  value: unknown
  items: BigNumberItem[]
  error?: { message: string; code: BigNumberErrorCode }
  partial: boolean
  sourceExecutedAt?: string
  ranAt: string
}
