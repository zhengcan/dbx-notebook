import { it, expect } from 'vitest';
import { newBlockId } from '../src/index';

it('generates unique ids', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const id = newBlockId(seen);
    expect(id).toMatch(/^b_[0-9a-z]{6}$/);
    expect(seen.has(id)).toBe(false);
    seen.add(id);
  }
});
