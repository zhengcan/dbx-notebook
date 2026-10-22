import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '../scripts/gen-validator.mjs';

describe('precompiled validator', () => {
  it('is up to date with spec/sqlnb-v1.schema.json (run `npm run gen:validator -w packages/sqlnb-format`)', () => {
    const current = readFileSync(fileURLToPath(new URL('../src/schemaValidator.generated.js', import.meta.url)), 'utf8');
    expect(current).toBe(generate());
  });
});
