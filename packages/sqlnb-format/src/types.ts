export type BlockType = 'markdown' | 'sql' | 'chart' | 'input' | 'big-number' | (string & {});
export interface Block { id: string; type: BlockType; content?: string; metadata?: Record<string, unknown>; outputs?: unknown; [extra: string]: unknown }
export interface SqlBlockMeta { resultName?: string; connection?: string; database?: string; schema?: string; source?: 'database' | 'results' }
export interface ConnectionRef { name: string; dialect?: string; [extra: string]: unknown }
export interface Notebook {
  sqlnb: '1';
  metadata: { createdAt?: string; modifiedAt?: string; [k: string]: unknown };
  settings: { defaultConnection?: string; defaultDatabase?: string; defaultSchema?: string; maxRows?: number; outputs: 'separate' | 'inline' | 'none'; [k: string]: unknown };
  connections: ConnectionRef[];
  blocks: Block[];
  clients?: Record<string, Record<string, unknown>>;
  [extra: string]: unknown;
}
