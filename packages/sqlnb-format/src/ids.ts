import type { Notebook } from './types';

export function newBlockId(existing: Iterable<string>): string {
  const used = new Set(existing);
  for (;;) {
    let s = '';
    for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 36).toString(36);
    const id = `b_${s}`;
    if (!used.has(id)) return id;
  }
}

export function createEmptyNotebook(): Notebook {
  const now = new Date().toISOString();
  return {
    sqlnb: '1',
    metadata: { createdAt: now, modifiedAt: now },
    settings: { outputs: 'separate' },
    connections: [],
    blocks: [],
  };
}
