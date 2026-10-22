// Inner markup of 16x16 stroke icons (rendered inside an aria-hidden <svg>, drawn with currentColor).
export type ToolbarIcon = 'heading' | 'bold' | 'italic' | 'code' | 'codeBlock' | 'link' | 'quote' | 'ul' | 'ol' | 'table' | 'image'

export const ICONS: Record<ToolbarIcon, string> = {
  heading: '<path d="M4 3v10M12 3v10M4 8h8"/>',
  bold: '<path d="M4.5 3h4a2.5 2.5 0 010 5h-4zM4.5 8h4.5a2.5 2.5 0 010 5H4.5z"/>',
  italic: '<path d="M7 3h5M4 13h5M10 3L6 13"/>',
  code: '<path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4"/>',
  codeBlock: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 6.5L4.8 8 6 9.5M10 6.5L11.2 8 10 9.5"/>',
  link: '<path d="M7 9a2.5 2.5 0 003.5 0l2-2a2.5 2.5 0 00-3.5-3.5l-.8.8M9 7a2.5 2.5 0 00-3.5 0l-2 2A2.5 2.5 0 007 12.5l.8-.8"/>',
  quote: '<path d="M3 4v8M6.5 5h7M6.5 8h7M6.5 11h4"/>',
  ul: '<path d="M6 4h8M6 8h8M6 12h8"/><circle class="fl" cx="2.8" cy="4" r=".9"/><circle class="fl" cx="2.8" cy="8" r=".9"/><circle class="fl" cx="2.8" cy="12" r=".9"/>',
  ol: '<path d="M7 4h7M7 8h7M7 12h7"/><text x="1.5" y="5.6">1</text><text x="1.5" y="9.6">2</text><text x="1.5" y="13.6">3</text>',
  table: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 7h12M7 7v6"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.6" cy="6.5" r="1"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
}
