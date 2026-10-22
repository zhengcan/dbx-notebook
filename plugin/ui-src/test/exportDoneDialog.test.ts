import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import ConfirmDialog from '../src/shell/ConfirmDialog.vue'
import { createDialogHost, buildExportDoneDialog } from '../src/shell/dialogHost'
import { createExportClient } from '../src/export/exportClient'
import { setLocale, t } from '../src/i18n'

let w: VueWrapper | undefined
afterEach(() => { w?.unmount(); w = undefined })

const labels = { ok: 'OK', open: 'Open', openFailed: 'FAILED', openUnsupported: 'NETWORK' }

async function setup(open: (() => Promise<void>) | undefined) {
  const host = createDialogHost()
  w = mount(defineComponent({
    setup: () => () => h(ConfirmDialog, { open: host.dlg.value !== null, title: 'Done', message: 'Exported', buttons: host.dlg.value?.buttons ?? [], initialFocus: host.dlg.value?.initialFocus, error: host.error.value, onChoose: host.choose }),
  }), { attachTo: document.body })
  let result: string | undefined
  const spec = buildExportDoneDialog({ path: '/out/r.html', client: { openFile: open && (() => open()) }, labels })
  void host.ask('Done', 'Exported', spec.buttons, spec.initialFocus, spec.guard).then((r) => { result = r })
  await flushPromises(); await new Promise((r) => setTimeout(r))
  return { host, result: () => result }
}

describe('export done dialog', () => {
  it('shows OK then Open, focus starts on OK', async () => {
    await setup(async () => {})
    const bs = w!.findAll('button')
    expect(bs.map((b) => b.text())).toEqual(['OK', 'Open'])
    expect((document.activeElement as HTMLElement).textContent).toBe('OK')
    expect(w!.find('[role=dialog]').attributes('aria-describedby')).toBeTruthy()
  })
  it('clicking the focused OK (what Enter does) closes without opening', async () => {
    const open = vi.fn(async () => {})
    const s = await setup(open)
    ;(document.activeElement as HTMLElement).click()
    await flushPromises()
    expect(s.result()).toBe('ok'); expect(open).not.toHaveBeenCalled()
  })
  it('Open calls the opener then closes', async () => {
    const open = vi.fn(async () => {})
    const s = await setup(open)
    await w!.find('[data-test=cd-open]').trigger('click'); await flushPromises()
    expect(open).toHaveBeenCalledTimes(1)
    expect(s.result()).toBe('open')
    expect(w!.find('[role=dialog]').exists()).toBe(false)
  })
  it('a failing Open keeps the dialog, shows an alert, OK still works', async () => {
    const open = vi.fn(async () => { throw new Error('boom /secret/path') })
    const s = await setup(open)
    await w!.find('[data-test=cd-open]').trigger('click'); await flushPromises()
    expect(s.result()).toBeUndefined()
    const alert = w!.find('[role=alert]')
    expect(alert.text()).toBe('FAILED')
    expect(w!.text()).not.toContain('secret')
    await w!.find('[data-test=cd-ok]').trigger('click'); await flushPromises()
    expect(s.result()).toBe('ok')
  })
  it('Esc closes like OK', async () => {
    const s = await setup(async () => {})
    await w!.find('[role=dialog]').trigger('keydown', { key: 'Escape' }); await flushPromises()
    expect(s.result()).toBe('ok')
  })
  it('Tab cycles OK -> Open -> OK', async () => {
    await setup(async () => {})
    const dlg = w!.find('[role=dialog]')
    await dlg.trigger('keydown', { key: 'Tab' })
    expect((document.activeElement as HTMLElement).textContent).toBe('Open')
    await dlg.trigger('keydown', { key: 'Tab' })
    expect((document.activeElement as HTMLElement).textContent).toBe('OK')
  })
  it('a second click while opening is ignored', async () => {
    let release!: () => void
    const open = vi.fn(() => new Promise<void>((r) => { release = r }))
    await setup(open)
    const b = w!.find('[data-test=cd-open]')
    await b.trigger('click'); await b.trigger('click')
    expect(open).toHaveBeenCalledTimes(1)
    release(); await flushPromises()
  })
})

describe('buildExportDoneDialog', () => {
  it('passes the exported path to the client', async () => {
    const openFile = vi.fn(async () => {})
    const spec = buildExportDoneDialog({ path: '/out/r.pdf', client: { openFile }, labels })
    expect(await spec.guard('open')).toBeNull()
    expect(openFile).toHaveBeenCalledWith('/out/r.pdf')
    expect(await spec.guard('ok')).toBeNull()
    expect(openFile).toHaveBeenCalledTimes(1)
  })
  it('initial focus is OK and Open is the second button', () => {
    const spec = buildExportDoneDialog({ path: '/x.html', client: { openFile: async () => {} }, labels })
    expect(spec.initialFocus).toBe('ok')
    expect(spec.buttons.map((b) => b.id)).toEqual(['ok', 'open'])
    expect(spec.buttons[0]).toMatchObject({ variant: 'primary', escape: true })
  })
  it('a client without openFile gets no Open button', async () => {
    const spec = buildExportDoneDialog({ path: '/x.html', client: {}, labels })
    expect(spec.buttons.map((b) => b.id)).toEqual(['ok'])
    expect(await spec.guard('open')).toBe('FAILED')
  })
  it('network-location refusal shows its own message, other failures the generic one, and both are logged', async () => {
    const seen: unknown[] = []
    const mk = (e: unknown) => buildExportDoneDialog({ path: '/x.html', client: { openFile: async () => { throw e } }, labels, onError: (x) => seen.push(x) })
    expect(await mk(new Error('[-32051] Files on network locations cannot be opened')).guard('open')).toBe('NETWORK')
    expect(await mk({ rpcCode: -32051, message: 'x' }).guard('open')).toBe('NETWORK')
    expect(await mk(new Error('[-32050] Not an exported file')).guard('open')).toBe('FAILED')
    expect(await mk('boom').guard('open')).toBe('FAILED')
    expect(seen.length).toBe(4)
  })
  it('the unsupported-location alert is shown in the dialog without closing it', async () => {
    const s = await setup(async () => { throw new Error('[-32051] network') })
    await w!.find('[data-test=cd-open]').trigger('click'); await flushPromises()
    expect(w!.find('[role=alert]').text()).toBe('NETWORK')
    expect(s.result()).toBeUndefined()
  })
  it('the dialog without Open shows only OK', async () => {
    await setup(undefined)
    expect(w!.findAll('button').map((b) => b.text())).toEqual(['OK'])
  })
  it('App builds the dialog through buildExportDoneDialog and shows the host error', async () => {
    const app = (await import('../src/App.vue?raw')).default as string
    expect(app).toContain('buildExportDoneDialog(')
    expect(app).toContain(':error="dlgError"')
  })
})

describe('export client openFile and i18n', () => {
  it('invokes export/openFile with the path only', async () => {
    const invoke = vi.fn(async () => ({ opened: true }))
    await createExportClient({ invoke } as any).openFile!('/a/b.html')
    expect(invoke).toHaveBeenCalledWith('export/openFile', { path: '/a/b.html' }, expect.anything())
  })
  it('both locales have the keys', () => {
    for (const l of ['zh-CN', 'en'] as const) {
      setLocale(l)
      for (const k of ['exp.openFile', 'exp.openFailed', 'exp.openNetwork']) expect(t(k as any)).not.toBe(k)
    }
    setLocale('en'); expect(t('exp.openFile' as any)).toBe('Open')
    setLocale('zh-CN'); expect(t('exp.openFile' as any)).toBe('打开')
  })
})
