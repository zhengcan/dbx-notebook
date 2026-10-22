import { describe, it, expect } from 'vitest'
import type { Block } from '@sqlnb/format'
import { referencedResults as R, upstreamOf, DepError, resultNameOf, isResultsBlock } from '../src/run/deps'

const N = ['orders', 'a', 'b', 'Users']
const sb = (id: string, resultName?: string, source?: 'database' | 'results', content = ''): Block =>
  ({ id, type: 'sql', content, metadata: { ...(resultName !== undefined ? { resultName } : {}), ...(source ? { source } : {}) } }) as Block

describe('referencedResults', () => {
  it('plain, join, order, dedupe', () => {
    expect(R('SELECT * FROM orders', N)).toEqual(['orders'])
    expect(R('SELECT * FROM b JOIN orders ON 1 JOIN b', N)).toEqual(['b', 'orders'])
  })
  it('case-insensitive, returns spelling from names', () => {
    expect(R('select * from ORDERS join users', N)).toEqual(['orders', 'Users'])
    expect(R('SELECT * FROM "Orders"', N)).toEqual(['orders'])
  })
  it('quoted forms', () => {
    expect(R('SELECT * FROM `orders`', N)).toEqual(['orders'])
    expect(R('SELECT * FROM [orders]', N)).toEqual(['orders'])
    expect(R('SELECT * FROM "My Result"', ['My Result', 'orders'])).toEqual(['My Result'])
    expect(R('SELECT * FROM "a""b"', ['a'])).toEqual([])
  })
  it('ignores strings and comments', () => {
    expect(R("SELECT 'orders', 'it''s orders' FROM t", N)).toEqual([])
    expect(R('SELECT 1 -- orders\nFROM t', N)).toEqual([])
    expect(R('SELECT /* orders */ 1 /* a\n b */', N)).toEqual([])
    expect(R('/* x */ SELECT * FROM a', N)).toEqual(['a'])
  })
  it('only table position counts', () => {
    expect(R('SELECT orders FROM t', N)).toEqual([])
    expect(R('SELECT total AS orders FROM a', N)).toEqual(['a'])
    expect(R('SELECT count(orders) FROM t', N)).toEqual([])
    expect(R('SELECT orders.id FROM t', N)).toEqual([])
    expect(R('SELECT * FROM t WHERE orders = 1 ORDER BY orders', N)).toEqual([])
  })
  it('comma lists, joins, schema prefix, keywords', () => {
    expect(R('SELECT * FROM a, orders', N)).toEqual(['a', 'orders'])
    expect(R('SELECT * FROM a x, b y, orders z', N)).toEqual(['a', 'b', 'orders'])
    expect(R('SELECT * FROM a LEFT OUTER JOIN "Orders" o ON o.id = a.id', N)).toEqual(['a', 'orders'])
    expect(R('SELECT * FROM main.orders', N)).toEqual(['orders'])
    expect(R('INSERT INTO orders SELECT 1', N)).toEqual(['orders'])
    expect(R('UPDATE orders SET x = 1', N)).toEqual(['orders'])
  })
  it('comma after ON/WHERE is an expression list, not a table list (documented)', () => {
    expect(R('SELECT * FROM a JOIN b ON a.x = b.x, orders', N)).toEqual(['a', 'b'])
    expect(R('SELECT * FROM a WHERE x IN (1, 2), orders', N)).toEqual(['a'])
    expect(R('SELECT * FROM a JOIN b ON 1 JOIN orders ON 1', N)).toEqual(['a', 'b', 'orders'])
    expect(R('SELECT * FROM a GROUP BY x, orders', N)).toEqual(['a'])
    expect(R('SELECT * FROM a ORDER BY x, orders LIMIT 1, 2', N)).toEqual(['a'])
  })
  it('subqueries and CTE bodies', () => {
    expect(R('SELECT * FROM (SELECT * FROM orders)', N)).toEqual(['orders'])
    expect(R('SELECT * FROM t WHERE id IN (SELECT id FROM orders)', N)).toEqual(['orders'])
    expect(R('SELECT * FROM t JOIN orders o ON o.id = t.id', N)).toEqual(['orders'])
    expect(R('SELECT (SELECT max(x) FROM (SELECT x FROM a)) FROM t, (SELECT 1 FROM b)', N)).toEqual(['a', 'b'])
    expect(R('WITH x AS (SELECT * FROM orders) SELECT * FROM x', N)).toEqual(['orders'])
    expect(R('SELECT * FROM (a JOIN b ON 1), orders', N)).toEqual(['a', 'b', 'orders'])
    expect(R('SELECT 1 FROM t UNION SELECT orders FROM a', N)).toEqual(['a'])
  })
  it('keywords in strings/comments/quoted idents ignored', () => {
    expect(R("SELECT 'from orders' FROM t", N)).toEqual([])
    expect(R('SELECT 1 -- from orders\nFROM t', N)).toEqual([])
    expect(R('SELECT "from" orders FROM t', N)).toEqual([])
  })
  it('CTE shadowing', () => {
    expect(R('WITH orders AS (SELECT 1) SELECT * FROM orders', N)).toEqual([])
    expect(R('WITH a AS (SELECT * FROM orders) SELECT * FROM a', N)).toEqual(['orders'])
    expect(R('WITH a AS (SELECT 1), b AS (SELECT * FROM orders) SELECT * FROM a, b', N)).toEqual(['orders'])
    expect(R('WITH RECURSIVE a(x) AS (SELECT 1 UNION SELECT x FROM a) SELECT * FROM a', N)).toEqual([])
    expect(R('with a(x, y) as materialized (select 1,2) select * from a join orders', N)).toEqual(['orders'])
  })
  it('dots', () => {
    expect(R('SELECT x.orders FROM t x', N)).toEqual([])
    expect(R('SELECT * FROM main.orders', N)).toEqual(['orders'])
    expect(R('SELECT * FROM temp."a"', N)).toEqual(['a'])
    expect(R('SELECT * FROM other.orders', N)).toEqual([])
  })
  it('function-call lookalikes and AS alias ignored', () => {
    expect(R('SELECT orders(1), a (2) FROM t', N)).toEqual([])
    expect(R('SELECT x AS orders FROM t', N)).toEqual([])
  })
  it('robust', () => {
    expect(R("SELECT 'abc orders", N)).toEqual([])
    expect(R('SELECT /* orders', N)).toEqual([])
    expect(R('SELECT * FROM "orders', N)).toEqual(['orders'])
    expect(R('SELECT * FROM 数据', ['数据'])).toEqual([])
    expect(R('SELECT 1', [])).toEqual([])
  })
  it('long sql is fast', () => {
    const sql = 'SELECT a, b, c FROM t WHERE x = 1 /* c */ AND y = \'s\';\n'.repeat(4000) + 'SELECT * FROM orders'
    expect(sql.length).toBeGreaterThan(200000)
    const t = performance.now()
    expect(R(sql, N)).toEqual(['orders'])
    expect(performance.now() - t).toBeLessThan(200)
  })
})

describe('resultNameOf / isResultsBlock', () => {
  it('edge cases', () => {
    expect(resultNameOf(sb('1', ' x '))).toBe('x')
    expect(resultNameOf(sb('1', ''))).toBeUndefined()
    expect(resultNameOf(sb('1', '1x'))).toBeUndefined()
    expect(resultNameOf(sb('1', 'a b'))).toBeUndefined()
    expect(resultNameOf(sb('1', 'a'.repeat(63)))).toBe('a'.repeat(63))
    expect(resultNameOf(sb('1', 'a'.repeat(64)))).toBeUndefined()
    expect(resultNameOf({ id: '1', type: 'sql' } as Block)).toBeUndefined()
    expect(resultNameOf({ id: '1', type: 'sql', metadata: { resultName: 5 } } as unknown as Block)).toBeUndefined()
    expect(resultNameOf({ id: '1', type: 'markdown', metadata: { resultName: 'x' } } as unknown as Block)).toBeUndefined()
  })
  it('isResultsBlock', () => {
    expect(isResultsBlock(sb('1', undefined, 'results'))).toBe(true)
    expect(isResultsBlock(sb('1', undefined, 'database'))).toBe(false)
    expect(isResultsBlock(sb('1'))).toBe(false)
    expect(isResultsBlock({ id: '1', type: 'markdown', metadata: { source: 'results' } } as unknown as Block)).toBe(false)
  })
})

describe('upstreamOf', () => {
  it('returns referenced blocks in notebook order', () => {
    const A = sb('A', 'orders'), B = sb('B', 'Users'), C = sb('C', 'c', 'results', 'select * from users join ORDERS')
    expect(upstreamOf(C, [A, B, C])).toEqual([A, B])
  })
  it('non-results blocks → []', () => {
    const A = sb('A', 'orders'), B = sb('B', 'b', 'database', 'select * from orders')
    expect(upstreamOf(B, [A, B])).toEqual([])
    expect(upstreamOf(sb('C', undefined, undefined, 'select * from orders'), [A])).toEqual([])
  })
  it('SELF', () => {
    const A = sb('A', 'orders', 'results', 'select * from orders')
    try { upstreamOf(A, [A]); expect.unreachable() } catch (e) {
      expect(e).toBeInstanceOf(DepError)
      expect(e).toMatchObject({ code: 'SELF', blockId: 'A', name: 'orders' })
    }
  })
  it('FORWARD', () => {
    const A = sb('A', 'a', 'results', 'select * from b'), B = sb('B', 'b')
    expect(() => upstreamOf(A, [A, B])).toThrow(DepError)
    try { upstreamOf(A, [A, B]) } catch (e) { expect(e).toMatchObject({ code: 'FORWARD', blockId: 'A', name: 'b' }) }
  })
  it('DUPLICATE', () => {
    const A = sb('A', 'x'), B = sb('B', 'X'), C = sb('C', 'c', 'results', 'select * from x')
    try { upstreamOf(C, [A, B, C]); expect.unreachable() } catch (e) {
      expect(e).toMatchObject({ code: 'DUPLICATE', name: 'x' })
    }
  })
  it('column named like a later/own result is no dependency', () => {
    const A = sb('A', 'orders', 'results', 'select orders from t')
    expect(upstreamOf(A, [A])).toEqual([])
    const B = sb('B', 'b', 'results', 'select orders from t'), O = sb('O', 'orders')
    expect(upstreamOf(B, [B, O])).toEqual([])
    const C = sb('C', 'c', 'results', 'select * from orders')
    expect(() => upstreamOf(C, [C, O])).toThrow(DepError)
  })
  it('unknown names ignored; unnamed blocks never referenced; CTE shadow', () => {
    const A = sb('A'), C = sb('C', 'c', 'results', 'select * from nothing join a')
    expect(upstreamOf(C, [A, C])).toEqual([])
    const D = sb('D', 'd'), E = sb('E', 'e', 'results', 'with d as (select 1) select * from d')
    expect(upstreamOf(E, [D, E])).toEqual([])
  })
  it('{{ }} placeholders are not references', () => {
    const O = sb('O', 'orders')
    const C = sb('C', 'c', 'results', 'select * from t where a = {{ orders }} and b = {{orders}}')
    expect(upstreamOf(C, [O, C])).toEqual([])
    const D = sb('D', 'd', 'results', 'select * from orders where a = {{ orders }}')
    expect(upstreamOf(D, [O, D])).toEqual([O])
    expect(R("select '{{ orders }}' from orders", ['orders'])).toEqual(['orders'])
  })
})
