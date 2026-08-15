//! Persister task: writes engine events to SQLite and broadcasts them over WS.

use crate::types::{AlarmOccurrence, AlarmRule, OutEvent};
use hmi_io_db::repo::{AlarmOccurrenceRow, AlarmStreamEventRow, Repo, SoeRow};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

pub fn spawn_persister(
    mut rx: mpsc::UnboundedReceiver<OutEvent>,
    repo: Arc<Repo>,
    broadcast_tx: broadcast::Sender<String>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                OutEvent::Occurrence {
                    occurrence,
                    mut event,
                } => {
                    let occ_row: AlarmOccurrenceRow = (&occurrence).into();
                    let mut ev_row: AlarmStreamEventRow = (&event).into();
                    if let Err(e) = repo.upsert_alarm_occurrence(&occ_row).await {
                        log::error!("Persist alarm occurrence failed: {}", e);
                    }
                    match repo.insert_alarm_stream_event(&mut ev_row).await {
                        Ok(()) => event.id = ev_row.id,
                        Err(e) => log::error!("Persist alarm stream event failed: {}", e),
                    }
                    let payload = serde_json::json!({
                        "type": "alarm_update",
                        "data": {
                            "event_type": event.event_type.as_str(),
                            "occurrence": occurrence,
                        }
                    });
                    let _ = broadcast_tx.send(payload.to_string());
                }
                OutEvent::Soe(mut rec) => {
                    let mut row: SoeRow = (&rec).into();
                    match repo.insert_soe(&mut row).await {
                        Ok(()) => rec.id = row.id,
                        Err(e) => log::error!("Persist SOE failed: {}", e),
                    }
                    let payload = serde_json::json!({
                        "type": "soe",
                        "data": [rec],
                    });
                    let _ = broadcast_tx.send(payload.to_string());
                }
                OutEvent::RulesChanged => {
                    let _ = broadcast_tx.send(r#"{"type":"alarm_rules_changed"}"#.to_string());
                }
            }
        }
    })
}

pub fn alarm_snapshot_json(occurrences: &[AlarmOccurrence]) -> String {
    serde_json::json!({
        "type": "alarm_snapshot",
        "data": occurrences,
    })
    .to_string()
}

pub fn alarm_rules_json(rules: &[AlarmRule]) -> String {
    serde_json::json!({
        "type": "alarm_rules",
        "data": rules,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::AlarmEngine;
    use crate::types::OutEvent;
    use hmi_io_db::repo::AlarmRuleRow;
    use hmi_io_point::types::PointValue;
    use std::sync::Arc;
    use tokio::sync::{broadcast, mpsc};

    #[tokio::test]
    async fn persister_writes_db_and_broadcasts() {
        let repo = Arc::new(Repo::new(":memory:").await.unwrap());
        repo.insert_alarm_rule(&AlarmRuleRow {
            id: "R1".into(),
            variable_id: "P1".into(),
            name: "高限".into(),
            description: String::new(),
            severity: "major".into(),
            group_name: "测试".into(),
            condition: "high".into(),
            threshold: 100.0,
            enabled: true,
            hysteresis: 0.0,
            confirm_ms: 0,
        })
        .await
        .unwrap();

        let (tx, rx) = mpsc::unbounded_channel::<OutEvent>();
        let (btx, mut brx) = broadcast::channel::<String>(16);
        let _task = spawn_persister(rx, repo.clone(), btx);

        let eng = AlarmEngine::with_soe_seq(tx, repo.max_soe_seq().await);
        let rule: AlarmRule = repo.list_alarm_rules().await.unwrap()[0].clone().into();
        eng.load_rules(vec![rule]);

        eng.on_point(&PointValue::new("P1", 120.0, "good", 1000));
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;

        let occ_rows = repo.list_active_alarm_occurrences().await.unwrap();
        assert_eq!(occ_rows.len(), 1);
        let (_, soe_rows) = repo.query_soe(None, None, None, None, 1, 10).await.unwrap();
        assert_eq!(soe_rows.len(), 1);
        assert_eq!(soe_rows[0].device_time, 1000);
        assert_eq!(soe_rows[0].seq, 1);

        // Broadcast order: SOE first, then alarm_update.
        let m1 = brx.try_recv().unwrap();
        assert!(m1.contains("\"type\":\"soe\""));
        let m2 = brx.try_recv().unwrap();
        assert!(m2.contains("\"type\":\"alarm_update\""));
        assert!(m2.contains("\"event_type\":\"trigger\""));

        // Ack persists and appends a stream event.
        let occ_id = occ_rows[0].id.clone();
        eng.ack(&occ_id, "operator");
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        let (_, occ_after) = repo
            .query_alarm_occurrences(None, None, None, None, None, Some("acknowledged"), 1, 10)
            .await
            .unwrap();
        assert_eq!(occ_after.len(), 1);
        assert_eq!(occ_after[0].id, occ_id);
        assert_eq!(occ_after[0].status, "acknowledged");
        assert_eq!(occ_after[0].acknowledged_by, "operator");
        let evs = repo.query_occurrence_stream_events(&occ_id).await.unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[1].event_type, "ack");
        assert_eq!(evs[1].by_user, "operator");

        // Recovery moves the occurrence to recovered-unacked history.
        eng.on_point(&PointValue::new("P1", 90.0, "good", 2000));
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        let (_, recovered) = repo
            .query_alarm_occurrences(None, None, None, None, None, Some("recovered"), 1, 10)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].recovered_reason, "恢复正常");
        // Acked alarm stays acknowledged after recovery (not in unacked set).
        assert!(repo.list_recovered_unacked().await.unwrap().is_empty());
    }

    #[test]
    fn snapshot_json_helpers_emit_expected_types() {
        let rules: Vec<AlarmRule> = Vec::new();
        let occs: Vec<AlarmOccurrence> = Vec::new();
        assert!(alarm_rules_json(&rules).contains("\"type\":\"alarm_rules\""));
        assert!(alarm_snapshot_json(&occs).contains("\"type\":\"alarm_snapshot\""));
    }
}
