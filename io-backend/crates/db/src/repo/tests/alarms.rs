//! Alarm / SOE persistence tests.

use crate::repo::{AlarmOccurrenceRow, Repo};

#[tokio::test]
async fn alarm_history_ack_filter_matches_acknowledgement_state() {
    let repo = Repo::new(":memory:").await.unwrap();
    let mut row = AlarmOccurrenceRow {
        id: String::new(),
        rule_id: "R1".into(),
        variable_id: "P1".into(),
        name: "test".into(),
        severity: "major".into(),
        group_name: "g".into(),
        message: "m".into(),
        value: "1".into(),
        threshold: 0.0,
        status: "active".into(),
        triggered_at: 100,
        recovered_at: None,
        recovered_reason: String::new(),
        acknowledged_at: None,
        acknowledged_by: String::new(),
    };

    row.id = "OCC_ACTIVE_UNACK".into();
    repo.upsert_alarm_occurrence(&row).await.unwrap();

    row.id = "OCC_ACTIVE_ACK".into();
    row.status = "acknowledged".into();
    row.acknowledged_at = Some(200);
    row.acknowledged_by = "op".into();
    repo.upsert_alarm_occurrence(&row).await.unwrap();

    row.id = "OCC_RECOVERED_ACK".into();
    row.status = "recovered".into();
    row.recovered_at = Some(300);
    repo.upsert_alarm_occurrence(&row).await.unwrap();

    row.id = "OCC_RECOVERED_UNACK".into();
    row.status = "recovered".into();
    row.acknowledged_at = None;
    row.acknowledged_by = String::new();
    repo.upsert_alarm_occurrence(&row).await.unwrap();

    let (total_ack, rows_ack) = repo
        .query_alarm_occurrences(None, None, None, None, None, Some("acknowledged"), 1, 10)
        .await
        .unwrap();
    assert_eq!(total_ack, 2);
    let ack_ids: Vec<&str> = rows_ack.iter().map(|r| r.id.as_str()).collect();
    assert!(ack_ids.contains(&"OCC_ACTIVE_ACK"));
    assert!(ack_ids.contains(&"OCC_RECOVERED_ACK"));

    let (total_unack, _) = repo
        .query_alarm_occurrences(None, None, None, None, None, Some("unacknowledged"), 1, 10)
        .await
        .unwrap();
    assert_eq!(total_unack, 2);

    let (total_recovered, _) = repo
        .query_alarm_occurrences(None, None, None, None, None, Some("recovered"), 1, 10)
        .await
        .unwrap();
    assert_eq!(total_recovered, 2);
}
