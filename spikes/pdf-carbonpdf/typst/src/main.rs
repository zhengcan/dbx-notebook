use typst_as_lib::TypstEngine;

fn main() {
    let sans = std::fs::read("/System/Library/Fonts/STHeiti Medium.ttc").expect("font");
    let sans_l = std::fs::read("/System/Library/Fonts/STHeiti Light.ttc").expect("font");
    let mono = std::fs::read("/System/Library/Fonts/Menlo.ttc").expect("font");
    let svg = std::fs::read_to_string("out/chart.svg").unwrap().replace("sans-serif", "Heiti SC");
    let st = ["进行中", "已完成", "待处理"];
    let mut rows = String::new();
    for i in 1..=60usize {
        rows += &format!("[{}],[产品 {}],[{}],[{:.2}],[{}],[备注内容 note {}],\n", i, i, i * 7 % 50 + 1, i as f64 * 3.14, st[i % 3], i);
    }
    let src = format!(r##"
#set page(paper: "a4", margin: (x: 15mm, top: 22mm, bottom: 22mm),
  header: [#set text(8pt, fill: gray); SQL 笔记本导出测试 #h(1fr) 2026-10-17],
  footer: context [#set text(8pt, fill: gray); #align(center)[第 #counter(page).display() / #counter(page).final().first() 页]])
#set text(font: ("Heiti SC", "Menlo"), size: 10.5pt, lang: "zh")
#set par(justify: false, leading: 0.9em)
#show raw: set text(font: "Menlo", size: 9pt)
#show heading: set block(above: 1.4em, below: 0.8em)
= SQL 笔记本导出测试
这是一段中文段落：数据库查询结果与图表导出。*加粗文字*、_斜体_、`inline_code`。Hello, world 123.

第二段较长文字，用于检查换行与标点挤压：笔记本中的每个单元格都会按顺序导出，包含查询语句、结果表格以及可视化图表，方便分享与归档。
== 查询
#block(fill: rgb("#f5f6f8"), stroke: 0.5pt + rgb("#dde"), radius: 3pt, inset: 8pt, width: 100%, breakable: false)[
```sql
SELECT id, name, SUM(qty) AS total
FROM orders
WHERE status = '进行中'
GROUP BY id, name
ORDER BY total DESC
LIMIT 100;
```]
== 图表
#figure(image("chart.svg", width: 480pt * 0.75), caption: [图 1：月度销量])
== 结果表格
#table(columns: (1fr,)*6, align: left, stroke: (x: none, y: 0.5pt + luma(220)),
  fill: (_, y) => if y == 0 {{ rgb("#4c78a8") }} else if calc.even(y) {{ rgb("#f7f9fb") }},
  inset: (x: 6pt, y: 4pt),
  table.header(..([编号],[名称],[数量],[单价],[状态],[备注]).map(h => text(fill: white, h))),
  {rows}
)
"##);
    let engine = TypstEngine::builder()
        .main_file(src)
        .fonts([sans, sans_l, mono])
        .with_static_file_resolver([("chart.svg", svg.into_bytes())])
        .build();
    let t = std::time::Instant::now();
    let r = engine.compile();
    for w in &r.warnings { eprintln!("warn: {:?}", w.message); }
    let doc = r.output.unwrap_or_else(|e| panic!("{e:?}"));
    let pdf = typst_pdf::pdf(&doc, &Default::default()).expect("pdf");
    std::fs::write("out/typst.pdf", &pdf).unwrap();
    println!("typst.pdf {} bytes, {} pages, {:?}", pdf.len(), doc.pages().len(), t.elapsed());
}
