import { vi } from 'vitest'
export const fakeEditorFactory = () =>
  vi.fn((_p: HTMLElement, o: any) => {
    let doc: string = o.doc
    return { opts: o, setDoc: (x: string) => { doc = x }, getDoc: () => doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {} }
  }) as any
