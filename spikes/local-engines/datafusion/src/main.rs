#![allow(dead_code)]
include!("../../common/data.rs");
use datafusion::arrow::array::*;
use datafusion::arrow::datatypes::*;
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::arrow::util::display::array_value_to_string;
use datafusion::datasource::MemTable;
use datafusion::prelude::*;
use std::sync::Arc;

fn main() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async_main());
}

async fn async_main() {
    let ctx = SessionContext::new();
    let cs = cols();
    let rs = rows(NROWS);
    let t0 = Instant::now();
    let mut fields = vec![]; let mut arrays: Vec<ArrayRef> = vec![];
    for (ci, (n, k)) in cs.iter().enumerate() {
        let col = rs.iter().map(|r| &r[ci]);
        let (dt, arr): (DataType, ArrayRef) = match *k {
            "int" | "nint" => (DataType::Int64, Arc::new(Int64Array::from_iter(col.map(|c| if let Cell::Int(i) = c { Some(*i) } else { None })))),
            "dbl" => (DataType::Float64, Arc::new(Float64Array::from_iter(col.map(|c| if let Cell::Dbl(f) = c { Some(*f) } else { None })))),
            "dec" => (DataType::Decimal128(12, 2), Arc::new(Decimal128Array::from_iter(col.map(|c| if let Cell::Dbl(f) = c { Some((f * 100.0).round() as i128) } else { None })).with_precision_and_scale(12, 2).unwrap())),
            "txt" | "ntxt" => (DataType::Utf8, Arc::new(StringArray::from_iter(col.map(|c| if let Cell::Txt(s) = c { Some(s.as_str()) } else { None })))),
            "bool" => (DataType::Boolean, Arc::new(BooleanArray::from_iter(col.map(|c| if let Cell::Bool(b) = c { Some(*b) } else { None })))),
            "date" => (DataType::Date32, Arc::new(Date32Array::from_iter(col.map(|c| if let Cell::Date(d) = c { Some(*d) } else { None })))),
            _ => (DataType::Timestamp(TimeUnit::Microsecond, None), Arc::new(TimestampMicrosecondArray::from_iter(col.map(|c| if let Cell::Ts(t) = c { Some(*t) } else { None })))),
        };
        fields.push(Field::new(n, dt, true)); arrays.push(arr);
    }
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new(schema.clone(), arrays).unwrap();
    ctx.register_table("t", Arc::new(MemTable::try_new(schema, vec![vec![batch]]).unwrap())).unwrap();
    let dim = dim_rows();
    let ds = Arc::new(Schema::new(vec![Field::new("grp", DataType::Utf8, true), Field::new("region", DataType::Utf8, true)]));
    let db = RecordBatch::try_new(ds.clone(), vec![Arc::new(StringArray::from_iter_values(dim.iter().map(|d| d.0.clone()))), Arc::new(StringArray::from_iter_values(dim.iter().map(|d| d.1.clone())))]).unwrap();
    ctx.register_table("dim", Arc::new(MemTable::try_new(ds, vec![vec![db]]).unwrap())).unwrap();
    println!("LOAD 5000x{} = {:.1}ms", cs.len(), t0.elapsed().as_secs_f64() * 1000.0);

    // run_suite takes a sync closure; DataFusion is async -> block_in_place
    let handle = tokio::runtime::Handle::current();
    tokio::task::block_in_place(|| {
        run_suite(|sql| {
            handle.block_on(async {
                let df = ctx.sql(sql).await.map_err(|e| e.to_string())?;
                let bs = df.collect().await.map_err(|e| e.to_string())?;
                let sch = bs.first().map(|b| b.schema()).ok_or("no batches")?;
                let n: usize = bs.iter().map(|b| b.num_rows()).sum();
                let types = sch.fields().iter().map(|f| format!("{}:{}", f.name(), f.data_type())).collect::<Vec<_>>().join(", ");
                let b = bs.iter().find(|b| b.num_rows() > 0);
                let sample = b.map(|b| (0..b.num_columns()).map(|i| array_value_to_string(b.column(i), 0).unwrap_or("?".into())).collect::<Vec<_>>().join("; ")).unwrap_or_default();
                Ok(QRes { rows: n, ncols: sch.fields().len(), types, sample })
            })
        }, |name| match &name[..2] {
            "06" => vec!["SELECT grp, median(amount) AS med FROM t GROUP BY grp ORDER BY grp"],
            _ => vec![],
        });
    });
}
