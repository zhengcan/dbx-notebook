use base64::Engine;
use carbonpdf::{PageSize, PdfBuilder};
use std::time::Instant;

const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240" width="480" height="240" font-family="sans-serif" font-size="11">
<rect width="480" height="240" fill="#fff"/>
<g stroke="#ddd"><line x1="40" y1="20" x2="470" y2="20"/><line x1="40" y1="70" x2="470" y2="70"/><line x1="40" y1="120" x2="470" y2="120"/><line x1="40" y1="170" x2="470" y2="170"/></g>
<line x1="40" y1="200" x2="470" y2="200" stroke="#333"/>
<g fill="#4c78a8"><rect x="60" y="60" width="40" height="140"/><rect x="130" y="100" width="40" height="100"/><rect x="200" y="40" width="40" height="160"/><rect x="270" y="120" width="40" height="80"/><rect x="340" y="80" width="40" height="120"/><rect x="410" y="30" width="40" height="170"/></g>
<g text-anchor="middle" fill="#333"><text x="80" y="216">一月</text><text x="150" y="216">二月</text><text x="220" y="216">三月</text><text x="290" y="216">四月</text><text x="360" y="216">五月</text><text x="430" y="216">六月</text></g>
<text x="240" y="236" text-anchor="middle" fill="#333">月度销量 Monthly sales</text>
</svg>"##;

fn html(png: Option<Vec<u8>>) -> String {
    let mut rows = String::new();
    let st = ["进行中", "已完成", "待处理"];
    for i in 1..=60 {
        rows += &format!("<tr><td>{}</td><td>产品 {}</td><td>{}</td><td>{:.2}</td><td>{}</td><td>备注内容 note {}</td></tr>\n", i, i, i * 7 % 50 + 1, i as f64 * 3.14, st[i % 3], i);
    }
    let chart = match png {
        Some(b) => format!("<img src=\"data:image/png;base64,{}\" width=\"480\">", base64::engine::general_purpose::STANDARD.encode(b)),
        None => SVG.to_string(),
    };
    format!(r#"<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 20mm 15mm 20mm 15mm; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{ font-family: "PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei",sans-serif; font-size: 10.5pt; line-height: 1.6; color:#222; }}
h1 {{ font-size: 22pt; border-bottom: 2px solid #4c78a8; padding-bottom: 4pt; }}
h2 {{ font-size: 14pt; margin-top: 18pt; break-after: avoid; }}
pre {{ font-family: "SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace; font-size: 9pt; background:#f5f6f8; border:1px solid #dde; border-radius:4px; padding:8pt; white-space:pre-wrap; break-inside: avoid; }}
table {{ width:100%; border-collapse: collapse; font-size: 9.5pt; }}
thead {{ display: table-header-group; }}
th {{ background:#4c78a8; color:#fff; text-align:left; padding:4pt 6pt; }}
td {{ padding:3pt 6pt; border-bottom:1px solid #e3e3e3; }}
tr {{ break-inside: avoid; }}
tbody tr:nth-child(even) {{ background:#f7f9fb; }}
figure {{ margin:12pt 0; text-align:center; break-inside: avoid; }}
figcaption {{ font-size:9pt; color:#666; }}
</style></head><body>
<h1>SQL 笔记本导出测试</h1>
<p>这是一段中文段落：数据库查询结果与图表导出。<b>加粗文字</b>、<i>斜体</i>、<code>inline_code</code>。Hello, world 123.</p>
<p>第二段较长文字，用于检查换行与标点挤压：笔记本中的每个单元格都会按顺序导出，包含查询语句、结果表格以及可视化图表，方便分享与归档。</p>
<h2>查询</h2>
<pre>SELECT id, name, SUM(qty) AS total
FROM orders
WHERE status = '进行中'
GROUP BY id, name
ORDER BY total DESC
LIMIT 100;</pre>
<h2>图表</h2>
<figure>{chart}<figcaption>图 1：月度销量</figcaption></figure>
<h2>结果表格</h2>
<table><thead><tr><th>编号</th><th>名称</th><th>数量</th><th>单价</th><th>状态</th><th>备注</th></tr></thead><tbody>
{rows}</tbody></table>
</body></html>"#)
}

#[tokio::main]
async fn main() -> carbonpdf::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("svg");
    let out = args.get(2).cloned().unwrap_or_else(|| format!("out/{mode}.pdf"));
    let png = if mode == "png" { Some(std::fs::read("out/chart.png").expect("out/chart.png")) } else { None };
    let tpl_h = r#"<div style="font-size:8px;width:100%;padding:0 15mm;color:#888;display:flex;justify-content:space-between"><span>SQL 笔记本导出测试</span><span class="date"></span></div>"#;
    let tpl_f = r#"<div style="font-size:8px;width:100%;text-align:center;color:#888">第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>"#;
    let t = Instant::now();
    let mut b = PdfBuilder::new()
        .html(html(png))
        .page_size(PageSize::A4)
        .print_background(true)
        .header(tpl_h)
        .footer(tpl_f)
        // carbonpdf 0.2.0 sets display_header_footer from header/footer? set margins explicitly in inches
        .margins(0.8, 0.6, 0.8, 0.6)
        .chrome_args(if std::env::var("HEADFUL").is_ok() { vec![] } else { vec!["--headless=new"] }); // carbonpdf 0.2.0 inverts `headless` (calls with_head when true)
    if std::env::var("NO_SANDBOX").is_ok() { b = b.no_sandbox(); }
    if let Ok(p) = std::env::var("CHROME") { b = b.chrome_path(p); }
    let pdf = b.build().await?;
    std::fs::write(&out, &pdf).unwrap();
    println!("wrote {out} ({} bytes) in {:?}", pdf.len(), t.elapsed());
    Ok(())
}
