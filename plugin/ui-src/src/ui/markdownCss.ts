export interface MdVars { fg: string; mut: string; bd: string; sub: string; ac: string; cbg: string }

export const MD_TOKEN_VARS: MdVars = {
  fg: 'var(--color-foreground,inherit)',
  mut: 'var(--color-muted-foreground,#656d76)',
  bd: 'var(--color-border,#d0d7de)',
  sub: 'var(--color-muted,color-mix(in srgb,currentColor 6%,transparent))',
  ac: 'var(--color-primary,#0969da)',
  cbg: 'color-mix(in srgb, var(--color-foreground,currentColor) 8%, transparent)',
}

export const MD_EXPORT_VARS: MdVars = {
  fg: '#1f2328', mut: '#57606a', bd: '#d0d7de', sub: '#f6f8fa', ac: '#0969da', cbg: '#eff1f3',
}

export function markdownCss(s: string, v: MdVars): string {
  return [
    `${s}{line-height:1.7;overflow-x:auto}`,
    `${s}>:first-child{margin-top:0}`,
    `${s} h1{font-size:2.1em;line-height:1.25;font-weight:750;margin:1.2em 0 .6em;padding-bottom:.3em;color:${v.ac};border-bottom:2px solid ${v.ac}}`,
    `${s} h2{font-size:1.6em;line-height:1.3;font-weight:700;margin:1.5em 0 .55em;padding:.1em 0 .1em 12px;border-left:5px solid ${v.ac}}`,
    `${s} h3{font-size:1.3em;font-weight:650;margin:1.3em 0 .4em}`,
    `${s} h4{font-size:1.1em;font-weight:650;margin:1.2em 0 .3em;color:${v.ac}}`,
    `${s} h5{font-size:1em;font-weight:650;margin:1em 0 .3em;color:${v.mut}}`,
    `${s} h6{font-size:.9em;font-weight:600;margin:1em 0 .3em;color:${v.mut};letter-spacing:.04em}`,
    `${s} p{margin:0 0 .8em}`,
    `${s} a{color:${v.ac};text-decoration:underline;text-underline-offset:3px}`,
    `${s} strong{font-weight:700}`,
    `${s} del{color:${v.mut}}`,
    `${s} hr{border:0;height:1px;background:${v.bd};margin:1.6em 0}`,
    `${s} code{background:${v.cbg};padding:.12em .4em;border-radius:4px;font:.88em ui-monospace,Menlo,monospace}`,
    `${s} pre{background:${v.sub};border:1px solid ${v.bd};border-left:3px solid ${v.ac};border-radius:4px;padding:10px 12px;overflow:auto;margin:0 0 .9em}`,
    `${s} pre code{background:none;padding:0}`,
    `${s} blockquote{margin:0 0 .9em;padding:8px 14px;background:color-mix(in srgb,${v.ac} 10%,transparent);border-radius:6px}`,
    `${s} blockquote p:last-child{margin:0}`,
    `${s} blockquote blockquote{background:color-mix(in srgb,${v.ac} 8%,transparent);margin:.5em 0 0}`,
    `${s} ul,${s} ol{margin:0 0 .8em;padding-left:1.5em}`,
    `${s} li{margin:.15em 0}`,
    `${s} li::marker{color:${v.ac}}`,
    `${s} ul ul,${s} ol ol,${s} ul ol,${s} ol ul{margin:.2em 0}`,
    `${s} table{border-collapse:separate;border-spacing:0;margin:0 0 .9em;width:100%;border:1px solid ${v.bd};border-radius:6px}`,
    `${s} th{background:${v.sub};padding:7px 12px;font-weight:600;border:0;border-bottom:1px solid ${v.bd}}`,
    `${s} td{padding:7px 12px;border:0;border-bottom:1px solid ${v.bd}}`,
    `${s} tr:last-child td{border-bottom:0}`,
    `${s} th:first-child{border-top-left-radius:5px}`,
    `${s} th:last-child{border-top-right-radius:5px}`,
    `${s} tr:last-child td:first-child{border-bottom-left-radius:5px}`,
    `${s} tr:last-child td:last-child{border-bottom-right-radius:5px}`,
    `${s} img{max-width:100%;height:auto;vertical-align:middle}`,
    `${s} .sqlnb-img{display:inline-block;max-width:100%;box-sizing:border-box;vertical-align:middle;border-radius:4px}`,
    `${s} .sqlnb-img-loading{background:${v.sub};border:1px solid ${v.bd}}`,
    `${s} .sqlnb-img-error{padding:4px 8px;border:1px dashed ${v.bd};background:${v.sub};color:${v.fg};line-height:1.4}`,
    `${s} .sqlnb-img-alt{margin-right:.6em}`,
    `${s} .sqlnb-img-hint{color:${v.mut};font-size:.9em}`,
    `${s} .sqlnb-img-missing{color:${v.mut};font-style:italic}`,
    `${s} tbody tr:nth-child(2n) td{background:color-mix(in srgb,${v.sub} 50%,transparent)}`,
  ].join('\n')
}

export function installMarkdownCss(): void {
  if (document.head.querySelector('style[data-md-css]')) return
  const el = document.createElement('style')
  el.setAttribute('data-md-css', '')
  el.textContent = markdownCss('.md-view', MD_TOKEN_VARS)
  document.head.appendChild(el)
}
