import { describe, it, expect } from 'vitest'
import { groupConnections, groupNames } from '../src/connections/groups'

const c = (id: string, name: string, connected: boolean) => ({ id, name, dialect: 'x', connected, readOnly: false }) as any

describe('connection groups', () => {
  it('sorts each group by name; connected-first; duplicate names stay distinct in groupConnections but unique in groupNames; any-connected name counts as connected', () => {
    const l = [c('3', 'b', false), c('1', 'b', true), c('2', 'a', false), c('4', 'z', true), c('0', 'a', false)]
    const g = groupConnections(l)
    expect(g.connected.map((x) => x.id)).toEqual(['1', '4'])
    expect(g.disconnected.map((x) => x.id)).toEqual(['0', '2', '3'])
    expect(groupNames(l)).toEqual({ connected: ['b', 'z'], disconnected: ['a'] })
  })
})
