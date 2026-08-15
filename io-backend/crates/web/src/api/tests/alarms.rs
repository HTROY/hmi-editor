//! Tests for alarm rule upsert helpers.

use crate::api::alarms::{rule_from_upsert, AlarmRuleUpsert};

#[test]
fn alarm_rule_id_is_generated_when_absent() {
    let body = AlarmRuleUpsert {
        id: None,
        variable_id: "P1".into(),
        name: "测试".into(),
        description: String::new(),
        severity: hmi_io_alarm::types::Severity::Major,
        group: String::new(),
        condition: hmi_io_alarm::types::Condition::High,
        threshold: 100.0,
        enabled: true,
        hysteresis: 0.0,
        confirm_ms: 0,
    };
    let r1 = rule_from_upsert(body, None);
    assert!(r1.id.starts_with("rule_"));
    let body2 = AlarmRuleUpsert {
        id: Some("body-id".into()),
        variable_id: "P2".into(),
        name: String::new(),
        description: String::new(),
        severity: hmi_io_alarm::types::Severity::Warning,
        group: String::new(),
        condition: hmi_io_alarm::types::Condition::Low,
        threshold: 1.0,
        enabled: false,
        hysteresis: 1.0,
        confirm_ms: 500,
    };
    let r2 = rule_from_upsert(body2, Some("path-id".into()));
    assert_eq!(r2.id, "path-id");
    let r3 = rule_from_upsert(
        AlarmRuleUpsert {
            id: Some("body-id".into()),
            variable_id: "P3".into(),
            name: String::new(),
            description: String::new(),
            severity: hmi_io_alarm::types::Severity::Minor,
            group: String::new(),
            condition: hmi_io_alarm::types::Condition::NotEqual,
            threshold: 0.0,
            enabled: true,
            hysteresis: 0.0,
            confirm_ms: 0,
        },
        None,
    );
    assert_eq!(r3.id, "body-id");
}
