import type { Orientation } from './options'
import { codeThemeCss } from './codeHighlight'
import { markdownCss, MD_EXPORT_VARS } from '../ui/markdownCss'

export const CJK_FONTS = `-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei","Segoe UI",Helvetica,Arial,sans-serif`

export function printCss(o: { orientation: Orientation }): string {
  return `@page{ size: A4 ${o.orientation}; margin: 14mm 12mm }
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#1f2328}
body{font-family:${CJK_FONTS};font-size:13px;line-height:1.5;padding:0 4px}
h1{font-size:22px;margin:0 0 6px}
.meta{color:#57606a;font-size:12px;margin:0 0 2px}
.export-info{break-inside:avoid;margin-top:6px;color:#57606a;font-size:12px;overflow-wrap:anywhere}
.export-info ul{margin:0 0 2px;padding-left:18px}
.info-sep{border:0;border-top:1px solid #d0d7de;margin:2.5em 0 8px}
hr{break-after:avoid}
.note{white-space:pre-wrap;margin:10px 0;padding:8px 10px;background:#f6f8fa;border-left:3px solid #d0d7de;overflow-wrap:anywhere}
.in-var{margin:6px 0;color:#57606a;font-size:12px;overflow-wrap:anywhere;break-after:avoid}
section{margin:14px 0}
h2{font-size:15px;margin:0 0 6px}
caption{font-size:15px;font-weight:bold;text-align:left;margin:0 0 6px}
pre.sql{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;padding:6px 8px;font-size:11px;margin:0 0 6px;font-family:ui-monospace,Menlo,Consolas,monospace}
table{border-collapse:collapse;width:100%}
table.grid{table-layout:auto;width:100%}
th,td{border:1px solid #d0d7de;padding:3px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#f6f8fa;font-weight:600}
th.serial,td.serial{width:var(--serial,4ch);min-width:var(--serial,4ch);white-space:nowrap;word-break:normal;color:#57606a;text-align:right}
th.rowname,td.rowname{width:var(--name,12ch);min-width:var(--name,12ch);font-weight:600;background:#f6f8fa;overflow-wrap:anywhere}
th.nw,td.nw{white-space:nowrap;word-break:normal;overflow-wrap:normal}
th.num,td.num{white-space:nowrap;word-break:normal;text-align:right;font-variant-numeric:tabular-nums}
td.null{background:#fafbfc}
thead{display:table-header-group}
tr{break-inside:avoid}
.cont{margin:0 0 6px;font-weight:600}
.pg-break{break-before:page}
section.split + *{break-before:page}
.note-after{color:#57606a;font-size:12px;margin:4px 0 0}
.empty{color:#57606a;font-style:italic}
.big-number{display:flex;flex-wrap:wrap;gap:12px}
.big-number{align-items:stretch}
.big-number .bn{border:1px solid #d0d7de;padding:8px 14px;min-width:120px;max-width:260px;break-inside:avoid}
.bn .v{font-size:26px;font-weight:600}
.bn .l{color:#57606a;font-size:12px;line-height:1.3;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.bn .c{color:#57606a;font-size:12px}
.chart svg{max-width:100%;height:auto}
.md img{max-width:100%}
.md{overflow-wrap:anywhere}
${markdownCss('.md', MD_EXPORT_VARS)}
${codeThemeCss()}
@media print{body{padding:0 2px 0 0}.md{overflow:visible}.md pre,.md blockquote{break-inside:avoid}}`
}
