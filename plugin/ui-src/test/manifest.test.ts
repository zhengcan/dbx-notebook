import { describe, expect, it } from 'vitest'
import raw from '../../manifest.json'
const manifest: any = raw
const ID = 'io.github.zhengcan.dbx-notebook'

describe('manifest', () => {
  it('permissions equal exactly the six strings', () => {
    const want = ['host.data:read', 'host.schema:read', 'host.ai', 'host.storage', 'host.workbench', 'host.connections:read']
    expect(manifest.permissions).toHaveLength(6)
    expect(new Set(manifest.permissions)).toEqual(new Set(want))
  })
  it("includes 'host.connections:read' and not the double-colon spelling", () => {
    expect(manifest.permissions).toContain('host.connections:read')
    expect(manifest.permissions).not.toContain('host.connections::read')
  })
  it('engines floor and host_api', () => {
    expect(manifest.engines.dbx).toBe('>=0.6.48')
    expect(manifest.engines.host_api).toBe('^1.4')
  })
  it('no contribution id or localization key mentions register-connection', () => {
    expect(JSON.stringify(manifest.contributions)).not.toContain('register-connection')
    expect(JSON.stringify(manifest.localizations)).not.toContain('register-connection')
  })
  it('use-connection context-menu contribution is unchanged', () => {
    const c = manifest.contributions.find((x: any) => x.id === `${ID}.use-connection`)
    expect(c).toEqual({
      type: 'context-menu',
      id: `${ID}.use-connection`,
      label: '新建 SQL 笔记本',
      menu: 'connection',
      action: { type: 'open-workbench', workbench: `${ID}.notebook` },
    })
    expect(manifest.localizations.en.contributions[`${ID}.use-connection`].label).toBe('New SQL Notebook')
  })
  it('contributions are exactly workbench + use-connection', () => {
    expect(manifest.contributions.map((c: any) => c.id)).toEqual([`${ID}.notebook`, `${ID}.use-connection`])
  })
  it('localizations have no key for a removed contribution', () => {
    const ids = new Set(manifest.contributions.map((c: any) => c.id))
    for (const loc of Object.values<any>(manifest.localizations))
      for (const k of Object.keys(loc.contributions ?? {})) expect(ids.has(k)).toBe(true)
  })
})
