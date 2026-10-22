use pdf_oxide::geometry::Rect;
use pdf_oxide::writer::{DocumentBuilder, EmbeddedFont, StreamingColumn, StreamingTableConfig};

const CJK_FONT: &str = "/Library/Fonts/Arial Unicode.ttf";
const CJK_FONT_ALT: &str = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";

fn chart_png() -> Vec<u8> {
    let (w, h) = (600u32, 300u32);
    let mut px = vec![255u8; (w * h * 3) as usize];
    let vals = [40u32, 90, 65, 140, 200, 120, 170, 230];
    let bw = w / vals.len() as u32;
    for (i, v) in vals.iter().enumerate() {
        for x in (i as u32 * bw + 8)..((i as u32 + 1) * bw - 8) {
            for y in (h - 10 - v)..(h - 10) {
                let o = ((y * w + x) * 3) as usize;
                px[o..o + 3].copy_from_slice(&[40 + i as u8 * 20, 110, 200]);
            }
        }
    }
    for x in 0..w {
        let o = (((h - 10) * w + x) * 3) as usize;
        px[o..o + 3].copy_from_slice(&[0, 0, 0]);
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&px).unwrap();
    out
}

fn main() {
    let path = [CJK_FONT, CJK_FONT_ALT]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .expect("no CJK font");
    let font = EmbeddedFont::from_file(path).expect("load font");
    let font_b = EmbeddedFont::from_file(path).expect("load font");
    // Streaming-table headers request "<font>-Bold"; register an alias so CJK headers resolve.
    let mut doc = DocumentBuilder::new()
        .register_embedded_font("CJK", font)
        .register_embedded_font("CJK-Bold", font_b);
    let cfg = [("编号", 50.0), ("名称", 100.0), ("数量", 60.0), ("单价", 70.0), ("状态", 80.0), ("备注", 90.0)]
        .iter()
        .fold(StreamingTableConfig::new().repeat_header(true), |c, (h, w)| {
            c.column(StreamingColumn::new(*h).width_pt(*w))
        });
    let page = doc
        .a4_page()
        .font("CJK", 20.0)
        .at(72.0, 760.0)
        .text("SQL 笔记本导出测试")
        .font("CJK", 11.0)
        .at(72.0, 730.0)
        .text("这是一段中文段落：数据库查询结果与图表导出。Hello, world 123.")
        .at(72.0, 700.0)
        .text("下面是一段等宽字体的 SQL：")
        .at(72.0, 680.0)
        .code_block("sql", "SELECT id, name, SUM(qty) AS total\nFROM orders\nWHERE status = 'open'\nGROUP BY id, name\nORDER BY total DESC\nLIMIT 100;")
        .image_from_bytes(&chart_png(), Rect::new(72.0, 380.0, 360.0, 180.0))
        .expect("image")
        .at(72.0, 340.0)
        .font("CJK", 10.0);
    let mut t = page.streaming_table(cfg);
    for i in 1..=60 {
        t.push_row(|r| {
            r.cell(format!("{i}"))
                .cell(format!("产品{i}"))
                .cell(format!("{}", i * 7 % 50))
                .cell(format!("{:.2}", i as f32 * 1.37))
                .cell(if i % 2 == 0 { "完成" } else { "进行中" })
                .cell(format!("note {i}"));
        })
        .expect("row");
    }
    t.finish().done();
    let bytes = doc.build().expect("build");
    std::fs::create_dir_all("out").unwrap();
    std::fs::write("out/spike.pdf", &bytes).unwrap();
    println!("wrote out/spike.pdf {} bytes", bytes.len());
}
