//! Excel import/export handlers for plugin point tables.

use super::{api_error, bump_version_and_push, AppState};
use axum::{
    extract::{Extension, Multipart, Path, State},
    http::StatusCode,
    response::Json,
};
use calamine::Reader;
use hmi_io_point::redundancy::RedundancyEngine;
use std::sync::Arc;

pub async fn import_excel(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(plugin_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, StatusCode> {
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            let data = field.bytes().await.map_err(|_| StatusCode::BAD_REQUEST)?;
            let cursor = std::io::Cursor::new(data);
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor).map_err(|e| {
                log::error!("Excel: {}", e);
                StatusCode::BAD_REQUEST
            })?;
            let mut imported: usize = 0;
            if let Some(Ok(range)) = workbook.worksheet_range_at(0) {
                let rows = range.rows();
                for (i, row) in rows.enumerate() {
                    if i == 0 {
                        continue;
                    }
                    if row.len() < 7 {
                        continue;
                    }
                    let var_id = row[0].to_string().trim().to_string();
                    if var_id.is_empty() {
                        continue;
                    }
                    let addr = row[1].to_string().trim().to_string();
                    let dtype = if row.len() > 2 {
                        row[2].to_string().trim().to_string()
                    } else {
                        "uint16".into()
                    };
                    let border = if row.len() > 3 {
                        row[3].to_string().trim().to_string()
                    } else {
                        "big_endian".into()
                    };
                    let scale: f64 = if row.len() > 4 {
                        row[4].to_string().trim().parse().unwrap_or(1.0)
                    } else {
                        1.0
                    };
                    let off: f64 = if row.len() > 5 {
                        row[5].to_string().trim().parse().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    let vtype = if row.len() > 6 {
                        row[6].to_string().trim().to_string()
                    } else {
                        "AI".into()
                    };
                    let desc = if row.len() > 7 {
                        row[7].to_string().trim().to_string()
                    } else {
                        String::new()
                    };
                    if let Err(e) = repo
                        .insert_point(
                            plugin_id, &var_id, &addr, &dtype, &border, scale, off, &vtype, &desc,
                        )
                        .await
                    {
                        log::error!("import row {}: {}", i, e);
                    } else {
                        imported += 1;
                    }
                }
            }
            bump_version_and_push(repo.clone(), engine.clone()).await;
            return Ok(Json(serde_json::json!({"imported": imported})));
        }
    }
    Err(StatusCode::BAD_REQUEST)
}

pub async fn export_excel(
    State(repo): State<AppState>,
    Path(plugin_id): Path<i64>,
) -> Result<(StatusCode, [(String, String); 2], Vec<u8>), StatusCode> {
    let points = repo.list_points(Some(plugin_id)).await.map_err(api_error)?;
    let mut wb = rust_xlsxwriter::Workbook::new();
    let sheet = wb.add_worksheet();
    let headers: [&str; 8] = [
        "variable_id",
        "address",
        "data_type",
        "byte_order",
        "scale",
        "offset",
        "var_type",
        "description",
    ];
    for (c, h) in headers.iter().enumerate() {
        let _ = sheet.write_string(0, c as u16, *h);
    }
    for (r, pt) in points.iter().enumerate() {
        let row = (r + 1) as u32;
        let _ = sheet.write_string(row, 0, pt.variable_id.as_str());
        let _ = sheet.write_string(row, 1, pt.address.as_str());
        let _ = sheet.write_string(row, 2, pt.data_type.as_str());
        let _ = sheet.write_string(row, 3, pt.byte_order.as_str());
        let _ = sheet.write_number(row, 4, pt.scale);
        let _ = sheet.write_number(row, 5, pt.offset_val);
        let _ = sheet.write_string(row, 6, pt.var_type.as_str());
        let _ = sheet.write_string(row, 7, pt.description.as_str());
    }
    let buf = wb
        .save_to_buffer()
        .map_err(|e| api_error(anyhow::anyhow!("xlsx: {}", e)))?;
    Ok((
        StatusCode::OK,
        [
            (
                "Content-Type".into(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
            ),
            (
                "Content-Disposition".into(),
                format!("attachment; filename=points_{}.xlsx", plugin_id),
            ),
        ],
        buf,
    ))
}
