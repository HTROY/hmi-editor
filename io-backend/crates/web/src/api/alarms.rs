//! Alarm & SOE API handlers.

use super::{api_error, bump_version_and_push, AppState};
use axum::{
    extract::{Extension, Json, Path, Query, State},
    http::StatusCode,
};
use hmi_io_alarm::engine::AlarmEngine;
use hmi_io_alarm::types::{AlarmOccurrence, AlarmRule, AlarmStreamEvent};
use hmi_io_db::repo::{AlarmRuleRow, Repo};
use hmi_io_point::redundancy::RedundancyEngine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub async fn list_alarm_rules(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
) -> Json<Vec<AlarmRule>> {
    Json(alarm_engine.rules())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRuleUpsert {
    #[serde(default)]
    pub id: Option<String>,
    pub variable_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub severity: hmi_io_alarm::types::Severity,
    #[serde(default)]
    pub group: String,
    pub condition: hmi_io_alarm::types::Condition,
    pub threshold: f64,
    #[serde(default = "default_rule_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub hysteresis: f64,
    #[serde(default)]
    pub confirm_ms: u64,
}

fn default_rule_enabled() -> bool {
    true
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static RULE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Build a rule from the upsert body. `path_id` (PUT /{id}) wins over the body
/// id; when both are absent, an id is generated server-side.
pub(crate) fn rule_from_upsert(body: AlarmRuleUpsert, path_id: Option<String>) -> AlarmRule {
    let id = match path_id.or(body.id) {
        Some(id) if !id.trim().is_empty() => id,
        _ => format!(
            "rule_{}_{}",
            now_ms(),
            RULE_SEQ.fetch_add(1, Ordering::Relaxed)
        ),
    };
    AlarmRule {
        id,
        variable_id: body.variable_id,
        name: body.name,
        description: body.description,
        severity: body.severity,
        group: body.group,
        condition: body.condition,
        threshold: body.threshold,
        enabled: body.enabled,
        hysteresis: body.hysteresis,
        confirm_ms: body.confirm_ms,
    }
}

async fn save_alarm_rule(
    repo: Arc<Repo>,
    alarm_engine: Arc<AlarmEngine>,
    engine: Arc<RedundancyEngine>,
    rule: AlarmRule,
) -> Result<Json<AlarmRule>, StatusCode> {
    let row: AlarmRuleRow = (&rule).into();
    repo.insert_alarm_rule(&row).await.map_err(api_error)?;
    alarm_engine.set_rule(rule.clone());
    bump_version_and_push(repo, engine).await;
    Ok(Json(rule))
}

pub async fn upsert_alarm_rule(
    State(repo): State<AppState>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<AlarmRuleUpsert>,
) -> Result<Json<AlarmRule>, StatusCode> {
    let rule = rule_from_upsert(body, None);
    save_alarm_rule(repo, alarm_engine, engine, rule).await
}

pub async fn update_alarm_rule(
    State(repo): State<AppState>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<String>,
    Json(body): Json<AlarmRuleUpsert>,
) -> Result<Json<AlarmRule>, StatusCode> {
    let rule = rule_from_upsert(body, Some(id));
    save_alarm_rule(repo, alarm_engine, engine, rule).await
}

pub async fn delete_alarm_rule(
    State(repo): State<AppState>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    alarm_engine.remove_rule(&id);
    repo.delete_alarm_rule(&id).await.map_err(api_error)?;
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(StatusCode::OK)
}

pub async fn alarm_active(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
) -> Json<Vec<AlarmOccurrence>> {
    Json(alarm_engine.active_occurrences())
}

#[derive(Deserialize)]
pub struct AlarmHistoryQuery {
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub severity: Option<String>,
    pub group: Option<String>,
    pub variable_id: Option<String>,
    pub status: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub async fn alarm_history(
    State(repo): State<AppState>,
    Query(q): Query<AlarmHistoryQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (total, rows) = repo
        .query_alarm_occurrences(
            q.from,
            q.to,
            q.severity.as_deref(),
            q.group.as_deref(),
            q.variable_id.as_deref(),
            q.status.as_deref(),
            q.page.unwrap_or(1),
            q.page_size.unwrap_or(50),
        )
        .await
        .map_err(api_error)?;
    let items: Vec<AlarmOccurrence> = rows.into_iter().map(AlarmOccurrence::from).collect();
    Ok(Json(serde_json::json!({ "total": total, "items": items })))
}

pub async fn alarm_occurrence_events(
    State(repo): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<AlarmStreamEvent>>, StatusCode> {
    let items: Vec<AlarmStreamEvent> = repo
        .query_occurrence_stream_events(&id)
        .await
        .map_err(api_error)?
        .into_iter()
        .map(AlarmStreamEvent::from)
        .collect();
    Ok(Json(items))
}

#[derive(Deserialize)]
pub struct SoeQuery {
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub variable_id: Option<String>,
    pub quality: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub async fn soe_query(
    State(repo): State<AppState>,
    Query(q): Query<SoeQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (total, rows) = repo
        .query_soe(
            q.from,
            q.to,
            q.variable_id.as_deref(),
            q.quality.as_deref(),
            q.page.unwrap_or(1),
            q.page_size.unwrap_or(50),
        )
        .await
        .map_err(api_error)?;
    let items: Vec<hmi_io_alarm::types::SoeRecord> = rows
        .into_iter()
        .map(hmi_io_alarm::types::SoeRecord::from)
        .collect();
    Ok(Json(serde_json::json!({ "total": total, "items": items })))
}

#[derive(Deserialize)]
pub struct AckBody {
    pub id: String,
    pub user: String,
}

pub async fn alarm_ack(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Json(body): Json<AckBody>,
) -> Result<StatusCode, StatusCode> {
    if alarm_engine.ack(&body.id, &body.user) {
        Ok(StatusCode::OK)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

#[derive(Deserialize)]
pub struct AckAllBody {
    pub user: String,
}

pub async fn alarm_ack_all(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Json(body): Json<AckAllBody>,
) -> Json<serde_json::Value> {
    let n = alarm_engine.ack_all(&body.user);
    Json(serde_json::json!({ "acknowledged": n }))
}

#[derive(Serialize, Deserialize)]
pub struct AlarmConfigBody {
    pub alarm_retention_days: u32,
    pub soe_retention_days: u32,
}

pub async fn get_alarm_config(State(repo): State<AppState>) -> Json<AlarmConfigBody> {
    Json(AlarmConfigBody {
        alarm_retention_days: repo
            .get_config("alarm_retention_days")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(90),
        soe_retention_days: repo
            .get_config("soe_retention_days")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(30),
    })
}

pub async fn put_alarm_config(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<AlarmConfigBody>,
) -> Result<StatusCode, StatusCode> {
    repo.set_config(
        "alarm_retention_days",
        &body.alarm_retention_days.to_string(),
    )
    .await
    .map_err(api_error)?;
    repo.set_config("soe_retention_days", &body.soe_retention_days.to_string())
        .await
        .map_err(api_error)?;
    if let Err(e) = repo
        .prune_alarm_data(
            body.alarm_retention_days as u64,
            body.soe_retention_days as u64,
        )
        .await
    {
        log::error!("prune alarm data failed: {}", e);
    }
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(StatusCode::OK)
}
