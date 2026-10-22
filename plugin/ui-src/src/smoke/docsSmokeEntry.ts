import { computed, createApp, h, provide, ref } from 'vue'
import NotebookView from '../shell/NotebookView.vue'
import LabelsDialog from '../analysis/LabelsDialog.vue'
import LabelsPreview from '../analysis/LabelsPreview.vue'
import ExportDialog from '../export/ExportDialog.vue'
import { buildExportModel } from '../export/model'
import { DEFAULT_EXPORT_OPTIONS } from '../export/options'
import { useNotebookStore } from '../state/notebookStore'
import { hashSql } from '../state/hash'
import { createConnectionsStore } from '../connections/hostConnections'
import StartPage from '../shell/StartPage.vue'
import { ExportClientKey, ExportSettingsKey, BridgeKey, ConnectionsKey, StoreKey } from '../injection'
import { setLocale } from '../i18n'
import MarkdownBlock from '../blocks/MarkdownBlock.vue'

// Light-theme DBX tokens used for the documentation screenshots.
const TOKENS = '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb;--color-primary-foreground:#fff;--color-warning:#b45309;--color-destructive:#dc2626'
const ROOT_STYLE = `${TOKENS};background:var(--color-background);color:var(--color-foreground);font:14px var(--docs-font,system-ui,-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif)`

const REGIONS = ['华东', '华北', '华南']
const MONTHS = ['2026-01', '2026-02', '2026-03']
const BASE: Record<string, number> = { 华东: 128000, 华北: 96000, 华南: 74000 }
const amountOf = (r: string, m: number) => Math.round((BASE[r] * (1 + m * 0.07 + ((m * 7 + r.length * 3) % 5) * 0.02)) / 100) * 100
const ordersOf = (r: string, m: number) => Math.round(amountOf(r, m) / 410)

const SQL_ORDERS = `SELECT region, month, COUNT(*) AS orders, SUM(amount) AS amount
FROM orders
WHERE order_date >= {{ start_date }}
  AND channel = {{ channel }}
GROUP BY region, month
ORDER BY region, month`
const SQL_LOCAL = `SELECT region, SUM(amount) AS amount, SUM(orders) AS orders
FROM sales
GROUP BY region
ORDER BY amount DESC`
const T0 = '2026-10-21T09:30:00.000Z'

function fakeBridge(): any {
  return {
    ready: async () => {}, capabilities: () => ({ dataApi: true, schemaMetadataApi: false, storage: false, aiCompletion: false, connectionsApi: true }),
    locale: () => 'zh-CN', context: () => ({}), onContext: () => () => {}, theme: () => ({ appearance: 'light' }), onEnv: () => () => {},
    queryData: async () => { throw new Error('offline') }, getTableMetadata: async () => ({ columns: [] }),
    storageGet: async () => null, storageSet: async () => {}, invoke: async () => { throw new Error('offline') }, request: async () => { throw new Error('offline') },
    setTitle: async () => {}, getTitle: async () => '', getConnections: async () => [{ id: 'c1', name: 'sales-db', dialect: 'postgres', connected: true, readOnly: true }], onEvent: () => () => {},
  }
}

// Neutral bar-chart-like PNG drawn on a canvas (no text, so it does not depend on installed fonts).
async function chartPng(): Promise<{ mime: string; base64: string; size: number; mtimeMs: number; width: number; height: number }> {
  const width = 560, height = 200
  const c = document.createElement('canvas')
  c.width = width; c.height = height
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height)
  g.fillStyle = '#e5e5e5'
  for (let y = 30; y <= 170; y += 35) g.fillRect(40, y, 500, 1)
  const colors = ['#2563eb', '#60a5fa', '#a3a3a3']
  const vals = [[0.62, 0.71, 0.8], [0.47, 0.53, 0.6], [0.36, 0.42, 0.49]]
  vals.forEach((group, gi) => group.forEach((v, mi) => {
    const x = 70 + gi * 160 + mi * 40
    g.fillStyle = colors[mi]
    g.fillRect(x, 170 - v * 140, 30, v * 140)
  }))
  g.fillStyle = '#737373'; g.fillRect(40, 170, 500, 2)
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return { mime: 'image/png', base64: btoa(s), size: bytes.length, mtimeMs: 1, width, height }
}

function buildStore() {
  const store = useNotebookStore({ now: () => new Date(T0) })
  const nbText = JSON.stringify({
    sqlnb: '1', metadata: { createdAt: T0 }, settings: { defaultConnection: 'sales-db', outputs: 'separate' }, connections: [{ name: 'sales-db', dialect: 'postgres' }],
    blocks: [
      { id: 'b_intro', type: 'markdown', content: '# 月度销售分析\n\n按**区域**和**月份**汇总 2026 年第一季度的订单，数据来自 `sales-db`。\n\n- 先用输入变量选择起始日期和渠道\n- 再运行 SQL，下面的图表和大数字会基于结果继续计算\n' },
      { id: 'b_start', type: 'input', metadata: { variable: 'start_date', inputType: 'date', value: '2026-01-01' } },
      { id: 'b_channel', type: 'input', metadata: { variable: 'channel', inputType: 'select', value: '线上', options: ['线上', '门店', '分销'] } },
      { id: 'b_sql', type: 'sql', content: SQL_ORDERS, metadata: { resultName: 'sales', connection: 'sales-db' } },
      { id: 'b_local', type: 'sql', content: SQL_LOCAL, metadata: { source: 'results', resultName: 'by_region' } },
      { id: 'b_chart', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar', title: '各区域月度销售额', axisTitles: { x: '月份', y: '销售额（元）', legend: '区域' } }, pivot: { rows: [{ field: 'month', label: '月份' }], columns: [{ field: 'region', label: '区域' }], values: [{ field: 'amount', agg: 'sum', label: '销售额', format: { kind: 'thousands' } }], totals: { row: true, column: true, grand: true }, summaryLabel: '合计' } } },
      { id: 'b_bn', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' }, metrics: [{ field: 'amount', aggregate: 'sum', label: '销售额', format: { kind: 'thousands' } }, { field: 'orders', aggregate: 'sum', label: '订单数', format: { kind: 'thousands' } }, { field: 'amount', aggregate: 'mean', label: '平均月销售额', format: { kind: 'thousands' } }] } },
    ],
  })
  store.load(nbText, '/demo/monthly-sales.sqlnb', 0)
  const rows: unknown[][] = []
  const long: unknown[][] = []
  const byRegion = new Map<string, [number, number]>()
  for (const r of REGIONS) MONTHS.forEach((mo, m) => {
    const a = amountOf(r, m), o = ordersOf(r, m)
    rows.push([r, mo, o, a]); long.push([mo, r, a])
    const cur = byRegion.get(r) ?? [0, 0]; byRegion.set(r, [cur[0] + a, cur[1] + o])
  })
  const params = { start_date: '2026-01-01', channel: '线上' }
  store.runs.set('b_sql', {
    status: 'ok', executedAt: T0, ranSqlHash: hashSql(SQL_ORDERS), ranSource: 'database', params,
    result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'month', dataType: 'text' }, { name: 'orders', dataType: 'bigint' }, { name: 'amount', dataType: 'numeric' }], rows, truncated: false, elapsedMs: 42, dbType: 'postgres' },
  } as any)
  const local = [...byRegion.entries()].sort((a, b) => b[1][0] - a[1][0]).map(([r, [a, o]]) => [r, a, o])
  store.runs.set('b_local', {
    status: 'ok', executedAt: T0, ranSqlHash: hashSql(SQL_LOCAL), ranSource: 'results', upstream: { sales: T0 },
    result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'numeric' }, { name: 'orders', dataType: 'bigint' }], rows: local, truncated: false, elapsedMs: 3, dbType: 'local' },
  } as any)
  store.analysis.set('b_chart', { status: 'ok', long: { dims: ['month', 'region'], measures: ['amount'], rows: long }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: T0, sourceExecutedAt: T0 } as any)
  const sum = (i: number) => rows.reduce((s, r) => s + (r[i] as number), 0)
  const items = [{ value: sum(3) }, { value: sum(2) }, { value: sum(3) / MONTHS.length }]
  store.bigNumbers.set('b_bn', { status: 'ok', value: items[0].value, items, partial: false, ranAt: T0, sourceExecutedAt: T0 } as any)
  return store
}

// Wide enough that block header action buttons (delete, move up/down) stay on one line.
export const DOCS_ROOT_WIDTH = 1200

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__docsMount = async (scene: 'notebook' | 'labels' | 'export' | 'start' | 'mdimage' | 'mdtoolbar') => {
    w.__docsApp?.unmount()
    setLocale('zh-CN')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.id = 'docs-root'
    root.setAttribute('style', `${ROOT_STYLE};width:${DOCS_ROOT_WIDTH}px;padding:16px;box-sizing:border-box`)
    host.appendChild(root)
    if (scene === 'start') {
      root.style.width = '760px'
      const MAC = '/Applications/Google Chrome.app'
      const browserPath = ref(MAC)
      const settings: any = { browserPath, load: async () => {}, setBrowserPath: async (p: string) => { browserPath.value = p.trim() } }
      const client: any = { browserStatus: async (m?: string) => ({ found: true, path: (m || MAC) + '/Contents/MacOS/Google Chrome', source: m ? 'manual' : 'auto' }), pickBrowser: async () => ({ cancelled: true }) }
      const ago = (m: number) => Date.now() - m * 60000
      const recent = [{ path: '~/notebooks/monthly-sales.sqlnb', openedAt: ago(12) }, { path: '~/notebooks/churn-review.sqlnb', openedAt: ago(26 * 60) }, { path: '~/notebooks/inventory.sqlnb', openedAt: ago(4 * 1440) }]
      const Root = { setup() { provide(ExportSettingsKey as any, settings); provide(ExportClientKey as any, client); return () => h(StartPage, { recent, hasSidecar: true }) } }
      w.__docsApp = createApp(Root)
      w.__docsApp.mount(root)
      return
    }
    if (scene === 'mdtoolbar') {
      const content = '## 区域销售概览\n\n按**区域**汇总第一季度订单，数据来自 `sales-db`。\n\n- 先选择起始日期\n- 再运行 SQL'
      root.style.width = '720px'
      w.__docsApp = createApp({ render: () => h(MarkdownBlock, { modelValue: content }) })
      w.__docsApp.mount(root)
      return
    }
    if (scene === 'mdimage') {
      const REL = 'monthly-sales.sqlnb.assets/image-20261021-093000-3f9a1c2e.png'
      const png = await chartPng()
      const bridge = { invoke: async (method: string, params: any) => { if (method === 'notebook/readImage' && params.relPath === REL) return png; throw new Error('[-32040] [notFound] image not found') } }
      const content = `## 区域销售概览\n\n下图是 2026 年第一季度各区域销售额的示意图：\n\n![各区域销售额示意图](${REL})\n\n图片是笔记本旁边的文件，用相对路径引用；\`.sqlnb\` 文件里只保存上面这一行文字。`
      root.style.width = '720px'
      w.__docsApp = createApp({ render: () => h(MarkdownBlock, { modelValue: content }) })
      w.__docsApp.provide(BridgeKey, bridge as any)
      w.__docsApp.provide(StoreKey, { path: ref('/demo/monthly-sales.sqlnb') } as any)
      w.__docsApp.mount(root)
      return
    }
    const store = buildStore()
    if (scene === 'notebook') {
      const bridge = fakeBridge()
      const connections = createConnectionsStore(bridge)
      await connections.refresh()
      w.__docsApp = createApp({ render: () => h(NotebookView) })
      w.__docsApp.provide(StoreKey, store)
      w.__docsApp.provide(BridgeKey, bridge)
      w.__docsApp.provide(ConnectionsKey, connections)
      w.__docsApp.mount(root)
    } else if (scene === 'labels') {
      const meta = () => store.nb.value.blocks.find((b) => b.id === 'b_chart')!.metadata as any
      const cfg = computed(() => ({ pivot: meta().pivot, chart: meta().chartOptions }))
      const cats = { row: [MONTHS], column: [REGIONS] }
      const ctx = { empty: '(空)', summary: '合计' }
      const holder = ref<HTMLElement | null>(null)
      w.__docsApp = createApp({
        render: () => h('div', { ref: holder, style: 'position:relative;height:100%' }, holder.value ? [h(LabelsDialog, { cfg: cfg.value, categories: cats, ctx, container: holder.value, returnFocus: null, onCommit: () => {}, onClose: () => {} }, { preview: ({ active, numbers }: any) => h(LabelsPreview, { cfg: cfg.value, ctx, active, numbers, categories: { rows: cats.row, columns: cats.column } }) })] : []),
      })
      w.__docsApp.mount(root)
    } else {
      root.style.cssText = `${ROOT_STYLE};position:fixed;inset:0;width:auto;padding:0`
      const model = buildExportModel({
        store: store as any, options: { ...DEFAULT_EXPORT_OPTIONS, note: '' }, now: new Date(T0), documentTitle: '月度销售分析', exporter: '示例用户',
        dataSourceName: () => 'sales-db', labels: { empty: '(空)', summary: '合计' },
      } as any)
      w.__docsApp = createApp({ render: () => h(ExportDialog, { model, browser: { found: true, path: '/usr/bin/chrome', checking: false }, busy: false, initialFolder: '~/Documents', initialName: '月度销售分析.pdf', exporterName: '示例用户' }) })
      w.__docsApp.mount(root)
    }
  }
}
