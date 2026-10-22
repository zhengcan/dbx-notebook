import { describe, it, expect, vi } from 'vitest';

// The DBX plugin sandbox CSP forbids 'unsafe-eval'; anything that calls
// `new Function(...)` (e.g. Ajv at runtime) breaks the whole UI at import time.
describe('format library works without eval', () => {
  it('imports and validates with the Function constructor disabled', async () => {
    const Original = globalThis.Function;
    vi.resetModules();
    (globalThis as any).Function = function () {
      throw new EvalError("Refused to evaluate a string as JavaScript: 'unsafe-eval' is not allowed");
    };
    try {
      const m = await import('../src/index');
      expect(m.validateNotebook({ sqlnb: '1', blocks: [] }).valid).toBe(true);
      expect(m.validateNotebook({ sqlnb: '1' }).valid).toBe(false);
      expect(m.validateNotebook({ sqlnb: '1', blocks: [{ type: 'sql' }] }).valid).toBe(false);
    } finally {
      (globalThis as any).Function = Original;
    }
  });
});
