import { describe, expect, it } from 'vitest'
import { createDropGate, dropSignature } from '../src/blocks/dropGate'

function mk() {
  let t = 1000
  const gate = createDropGate(() => t)
  return { gate, adv: (n: number) => { t += n } }
}

describe('dropGate', () => {
  it('host then html5 within window → second rejected', () => {
    const { gate, adv } = mk()
    expect(gate.claim('host', 'a:1')).toBe('ok')
    adv(500)
    expect(gate.claim('html5', 'a:1')).toBe('duplicate')
  })
  it('html5 then host → second rejected', () => {
    const { gate, adv } = mk()
    expect(gate.claim('html5', 'a:1')).toBe('ok')
    adv(500)
    expect(gate.claim('host', 'a:1')).toBe('duplicate')
  })
  it('allowed again after 1001 ms', () => {
    const { gate, adv } = mk()
    gate.claim('host', 'a:1')
    adv(1001)
    expect(gate.claim('host', 'a:1')).toBe('ok')
  })
  it('different signature passes', () => {
    const { gate } = mk()
    gate.claim('host', 'a:1')
    expect(gate.claim('host', 'b:1')).toBe('ok')
  })
  it('same dropId twice rejected even after window', () => {
    const { gate, adv } = mk()
    expect(gate.claim('host', 'a:1', 'd1')).toBe('ok')
    adv(5000)
    expect(gate.claim('host', 'a:1', 'd1')).toBe('duplicate')
  })
  it('remembers only the last 32 dropIds', () => {
    const { gate, adv } = mk()
    gate.claim('host', 's0', 'd0')
    for (let i = 1; i <= 32; i++) { adv(2000); gate.claim('host', `s${i}`, `d${i}`) }
    adv(2000)
    expect(gate.claim('host', 'x', 'd0')).toBe('ok')
    adv(2000)
    expect(gate.claim('host', 'y', 'd5')).toBe('duplicate')
  })
  it('signature is order independent', () => {
    expect(dropSignature([{ name: 'b', size: 2 }, { name: 'a', size: 1 }])).toBe(dropSignature([{ name: 'a', size: 1 }, { name: 'b', size: 2 }]))
  })

  it('window boundary: 1000 ms rejected, 1001 ms allowed', () => {
    const { gate, adv } = mk()
    gate.claim('host', 'a:1')
    adv(1000)
    expect(gate.claim('html5', 'a:1')).toBe('duplicate')
    const g2 = mk()
    g2.gate.claim('host', 'a:1')
    g2.adv(1001)
    expect(g2.gate.claim('html5', 'a:1')).toBe('ok')
  })
  it('clock going backwards counts as expired and refreshes the record', () => {
    const { gate, adv } = mk()
    gate.claim('html5', 'a:1')
    adv(-5000)
    expect(gate.claim('html5', 'a:1')).toBe('ok')
    adv(100)
    expect(gate.claim('html5', 'a:1')).toBe('duplicate')
  })
  it('host drops with different dropIds and the same name:size both pass', () => {
    const { gate, adv } = mk()
    expect(gate.claim('host', 'a:1', 'd1')).toBe('ok')
    adv(500)
    expect(gate.claim('host', 'a:1', 'd2')).toBe('ok')
    adv(100)
    expect(gate.claim('host', 'a:1', 'd2')).toBe('duplicate')
  })
  it('html5 and host with the same signature dedupe in both orders even with a dropId', () => {
    const a = mk()
    expect(a.gate.claim('html5', 'a:1')).toBe('ok')
    expect(a.gate.claim('host', 'a:1', 'd1')).toBe('duplicate')
    const b = mk()
    expect(b.gate.claim('host', 'a:1', 'd1')).toBe('ok')
    expect(b.gate.claim('html5', 'a:1')).toBe('duplicate')
  })
})
