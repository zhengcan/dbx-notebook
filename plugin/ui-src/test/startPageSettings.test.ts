import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import StartPage from '../src/shell/StartPage.vue'
import { ExportClientKey, ExportSettingsKey } from '../src/injection'
import { createExportClient } from '../src/export/exportClient'
import { setLocale } from '../src/i18n'

function mk(opts: { path?: string; status?: any; pick?: any; statusFn?: any } = {}) {
  setLocale('en')
  const browserPath = ref(opts.path ?? '')
  const settings: any = {
    browserPath,
    load: vi.fn(async () => {}),
    setBrowserPath: vi.fn(async (p: string) => { browserPath.value = p.trim() }),
  }
  const client: any = {
    browserStatus: opts.statusFn ?? vi.fn(async () => opts.status ?? { found: true, path: '/c', source: 'auto' }),
    pickBrowser: opts.pick ?? vi.fn(async () => ({ cancelled: true })),
  }
  const w = mount(StartPage, { props: { recent: [], hasSidecar: true }, attachTo: document.body, global: { provide: { [ExportSettingsKey as symbol]: settings, [ExportClientKey as symbol]: client } } })
  return { w, settings, client }
}
const toggle = (w: any) => w.find('[data-test=settings-toggle]')
const body = (w: any) => w.find('[data-test=start-settings]')

describe('StartPage settings disclosure', () => {
  it('is collapsed by default with aria-expanded=false wired to its panel', async () => {
    const { w } = mk()
    await flushPromises()
    const t = toggle(w)
    expect(t.attributes('aria-expanded')).toBe('false')
    const id = t.attributes('aria-controls')!
    expect(id).toBeTruthy()
    expect(w.find(`#${id}`).exists()).toBe(true)
    expect(body(w).isVisible()).toBe(false)
    expect(t.element.tagName).toBe('BUTTON')
    expect(t.element.closest('h3')).not.toBeNull()
    expect(t.text()).toContain('Settings')
  })
  it('toggles open and closed by click and keeps the panel id stable', async () => {
    const { w } = mk()
    await flushPromises()
    await toggle(w).trigger('click')
    expect(toggle(w).attributes('aria-expanded')).toBe('true')
    expect(body(w).isVisible()).toBe(true)
    await toggle(w).trigger('click')
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    expect(body(w).isVisible()).toBe(false)
  })
  it('a valid or empty browser path does not auto-open and shows no warning', async () => {
    const { w } = mk({ path: '/ok/chrome', status: { found: true, path: '/ok/chrome', source: 'manual' } })
    await flushPromises()
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test=settings-warning]').exists()).toBe(false)
  })
  it('an invalid configured browser path flags the header and opens the section', async () => {
    const { w } = mk({ path: '/bad', status: { found: false, source: 'manual', reason: 'x', code: 'notFound' } })
    await flushPromises()
    expect(toggle(w).attributes('aria-expanded')).toBe('true')
    const warn = w.find('[data-test=settings-warning]')
    expect(warn.exists()).toBe(true)
    expect(toggle(w).attributes('aria-label') ?? toggle(w).text()).toMatch(/problem/i)
  })
  it('does not re-open after the user collapsed it, but keeps the warning marker', async () => {
    const { w } = mk({ path: '/bad', status: { found: false, source: 'manual', code: 'notFound' } })
    await flushPromises()
    await toggle(w).trigger('click')
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test=settings-warning]').exists()).toBe(true)
  })
  it('no browser at all (nothing configured) is not a settings problem', async () => {
    const { w } = mk({ status: { found: false, source: 'none', code: 'notFound' } })
    await flushPromises()
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test=settings-warning]').exists()).toBe(false)
  })
})

describe('StartPage browser path picker', () => {
  const file = (w: any) => w.find('[data-test=browser-pick-file]')
  const dir = (w: any) => w.find('[data-test=browser-pick-dir]')
  it('renders both buttons with accessible names while the input stays editable', async () => {
    const { w } = mk()
    await flushPromises()
    expect(file(w).text()).toBe('Choose file…')
    expect(dir(w).text()).toBe('Choose folder…')
    expect(file(w).attributes('type')).toBe('button')
    expect(file(w).attributes('aria-label')).toMatch(/browser/i)
    expect(dir(w).attributes('aria-label')).toMatch(/browser/i)
    expect((w.find('[data-test=browser-path]').element as HTMLInputElement).readOnly).toBe(false)
  })
  it('a picked file is saved, shown in the input and re-validated', async () => {
    const pick = vi.fn(async () => ({ path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }))
    const { w, settings, client } = mk({ pick })
    await flushPromises()
    client.browserStatus.mockClear()
    await file(w).trigger('click')
    await flushPromises()
    expect(pick).toHaveBeenCalledWith('file')
    expect(settings.setBrowserPath).toHaveBeenCalledWith('/Applications/Chromium.app/Contents/MacOS/Chromium')
    expect((w.find('[data-test=browser-path]').element as HTMLInputElement).value).toBe('/Applications/Chromium.app/Contents/MacOS/Chromium')
    expect(client.browserStatus).toHaveBeenCalledWith('/Applications/Chromium.app/Contents/MacOS/Chromium')
  })
  it('the directory button asks for a directory', async () => {
    const pick = vi.fn(async () => ({ path: '/x/chrome' }))
    const { w } = mk({ pick })
    await flushPromises()
    await dir(w).trigger('click')
    await flushPromises()
    expect(pick).toHaveBeenCalledWith('dir')
  })
  it('cancelling changes nothing and re-enables the buttons', async () => {
    const { w, settings } = mk({ path: '/keep' })
    await flushPromises()
    await file(w).trigger('click')
    await flushPromises()
    expect(settings.setBrowserPath).not.toHaveBeenCalled()
    expect((file(w).element as HTMLButtonElement).disabled).toBe(false)
    expect((w.find('[data-test=browser-path]').element as HTMLInputElement).value).toBe('/keep')
  })
  it('disables both buttons while the dialog is open and ignores a second click', async () => {
    let done!: (v: any) => void
    const pick = vi.fn(() => new Promise((r) => { done = r }))
    const { w } = mk({ pick })
    await flushPromises()
    await file(w).trigger('click')
    expect((file(w).element as HTMLButtonElement).disabled).toBe(true)
    expect((dir(w).element as HTMLButtonElement).disabled).toBe(true)
    await file(w).trigger('click')
    expect(pick).toHaveBeenCalledTimes(1)
    done({ cancelled: true })
    await flushPromises()
    expect((file(w).element as HTMLButtonElement).disabled).toBe(false)
  })
  it('a failing picker is announced inline and leaves the value alone', async () => {
    const pick = vi.fn(async () => { throw new Error('no dialog here') })
    const { w, settings } = mk({ pick, path: '/keep' })
    await flushPromises()
    await dir(w).trigger('click')
    await flushPromises()
    const err = w.find('[data-test=browser-pick-error]')
    expect(err.exists()).toBe(true)
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toContain('no dialog here')
    expect(settings.setBrowserPath).not.toHaveBeenCalled()
    expect((dir(w).element as HTMLButtonElement).disabled).toBe(false)
  })
  it('typing a path still saves it on change', async () => {
    const { w, settings } = mk()
    await flushPromises()
    const input = w.find('[data-test=browser-path]')
    await input.setValue('/opt/chrome')
    await input.trigger('change')
    expect(settings.setBrowserPath).toHaveBeenCalledWith('/opt/chrome')
  })
  it('status line distinguishes found / not executable / not found', async () => {
    const line = (w: any) => w.find('[data-test=browser-status]')
    let m = mk({ path: '/a', status: { found: true, path: '/a', source: 'manual' } }); await flushPromises()
    expect(line(m.w).text()).toContain('/a'); expect(line(m.w).attributes('data-state')).toBe('found')
    m = mk({ path: '/b', status: { found: false, source: 'manual', code: 'notExecutable', reason: 'r' } }); await flushPromises()
    expect(line(m.w).attributes('data-state')).toBe('notExecutable'); expect(line(m.w).text()).toMatch(/not executable/i)
    m = mk({ path: '/c', status: { found: false, source: 'manual', code: 'notFound', reason: 'r' } }); await flushPromises()
    expect(line(m.w).attributes('data-state')).toBe('notFound'); expect(line(m.w).text()).toMatch(/invalid path/i)
    expect(line(m.w).attributes('role')).toBe('status')
  })
})

describe('exportClient.pickBrowser', () => {
  it('invokes export/pickBrowser with the kind and passes the result through', async () => {
    const calls: any[] = []
    const bridge: any = { invoke: async (method: string, params: any) => { calls.push({ method, params }); return { path: '/x' } } }
    expect(await createExportClient(bridge).pickBrowser!('dir')).toEqual({ path: '/x' })
    expect(calls[0]).toEqual({ method: 'export/pickBrowser', params: { kind: 'dir' } })
  })
})
