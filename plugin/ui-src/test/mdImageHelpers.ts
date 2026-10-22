export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
export const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
export const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
export const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
export const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

export function file(name: string, type: string, bytes: Uint8Array = PNG_BYTES): File {
  return new File([bytes as BlobPart], name, { type })
}

export function fakeDt(files: File[], text = '', extraTypes: string[] = []): DataTransfer {
  const types = [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : []), ...extraTypes]
  return {
    files: Object.assign([...files], { item: (i: number) => files[i] }) as unknown as FileList,
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })) as unknown as DataTransferItemList,
    types,
    getData: (k: string) => (k === 'text/plain' || k === 'text' ? text : ''),
    dropEffect: 'none',
  } as unknown as DataTransfer
}
