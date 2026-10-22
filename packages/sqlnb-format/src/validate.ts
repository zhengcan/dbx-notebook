// Precompiled from spec/sqlnb-v1.schema.json by scripts/gen-validator.mjs (no runtime eval:
// the DBX plugin sandbox CSP forbids 'unsafe-eval', which Ajv's compile() needs).
import validateFn from './schemaValidator.generated.js';

interface AjvError { instancePath: string; keyword: string; params: Record<string, unknown>; message?: string }
type CompiledValidator = ((data: unknown) => boolean) & { errors?: AjvError[] | null };
const validate = validateFn as unknown as CompiledValidator;

export interface ValidationError { path: string; message: string }

export function validateNotebook(nb: unknown): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (!validate(nb)) {
    for (const e of validate.errors ?? []) {
      let path = e.instancePath;
      if (e.keyword === 'required' && typeof (e.params as any).missingProperty === 'string') {
        path += `/${(e.params as any).missingProperty}`;
      }
      errors.push({ path, message: e.message ?? 'invalid' });
    }
  }
  const blocks = (nb as any)?.blocks;
  if (Array.isArray(blocks)) {
    const ids = new Set<string>();
    const names = new Set<string>();
    blocks.forEach((b: any, i: number) => {
      if (typeof b?.id === 'string') {
        if (ids.has(b.id)) errors.push({ path: `/blocks/${i}/id`, message: `duplicate block id "${b.id}"` });
        ids.add(b.id);
      }
      const rn = b?.type === 'sql' ? b?.metadata?.resultName : undefined;
      if (typeof rn === 'string') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rn)) {
          if (!errors.some((e) => e.path === `/blocks/${i}/metadata/resultName`)) {
            errors.push({ path: `/blocks/${i}/metadata/resultName`, message: 'invalid resultName' });
          }
        }
        if (names.has(rn)) errors.push({ path: `/blocks/${i}/metadata/resultName`, message: `duplicate resultName "${rn}"` });
        names.add(rn);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}
