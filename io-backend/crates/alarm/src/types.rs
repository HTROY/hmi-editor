//! Shared domain types for alarm rules, occurrences, stream events and SOE.

use hmi_io_db::repo::{
    AlarmOccurrenceRow, AlarmRuleRow, AlarmStreamEventRow, SoeRow,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Major,
    Minor,
    Warning,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::Major => "major",
            Severity::Minor => "minor",
            Severity::Warning => "warning",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "critical" => Some(Severity::Critical),
            "major" => Some(Severity::Major),
            "minor" => Some(Severity::Minor),
            "warning" => Some(Severity::Warning),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Condition {
    High,
    Low,
    Equal,
    NotEqual,
    Change,
}

impl Condition {
    pub fn as_str(&self) -> &'static str {
        match self {
            Condition::High => "high",
            Condition::Low => "low",
            Condition::Equal => "equal",
            Condition::NotEqual => "notEqual",
            Condition::Change => "change",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "high" => Some(Condition::High),
            "low" => Some(Condition::Low),
            "equal" => Some(Condition::Equal),
            "notEqual" => Some(Condition::NotEqual),
            "change" => Some(Condition::Change),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OccurrenceStatus {
    Active,
    Acknowledged,
    Recovered,
}

impl OccurrenceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OccurrenceStatus::Active => "active",
            OccurrenceStatus::Acknowledged => "acknowledged",
            OccurrenceStatus::Recovered => "recovered",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamEventType {
    Trigger,
    Ack,
    Recover,
    RuleDisabled,
}

impl StreamEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            StreamEventType::Trigger => "trigger",
            StreamEventType::Ack => "ack",
            StreamEventType::Recover => "recover",
            StreamEventType::RuleDisabled => "rule_disabled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRule {
    pub id: String,
    pub variable_id: String,
    pub name: String,
    pub description: String,
    pub severity: Severity,
    pub group: String,
    pub condition: Condition,
    pub threshold: f64,
    pub enabled: bool,
    pub hysteresis: f64,
    pub confirm_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmOccurrence {
    pub id: String,
    pub rule_id: String,
    pub variable_id: String,
    pub name: String,
    pub severity: Severity,
    pub group: String,
    pub message: String,
    pub value: Value,
    pub threshold: f64,
    pub status: OccurrenceStatus,
    pub triggered_at: u64,
    pub recovered_at: Option<u64>,
    pub recovered_reason: String,
    pub acknowledged_at: Option<u64>,
    pub acknowledged_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmStreamEvent {
    pub id: i64,
    pub occurrence_id: String,
    pub event_type: StreamEventType,
    pub at_ms: u64,
    pub by_user: String,
    pub value: Value,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoeRecord {
    pub id: i64,
    pub seq: i64,
    pub variable_id: String,
    pub value: Value,
    pub quality: String,
    pub device_time: u64,
    pub receive_time: u64,
    pub source: String,
}

/// Event emitted by the engine; persisted and broadcast by the persister task.
#[derive(Debug, Clone)]
pub enum OutEvent {
    Occurrence {
        occurrence: AlarmOccurrence,
        event: AlarmStreamEvent,
    },
    Soe(SoeRecord),
    RulesChanged,
}

impl From<AlarmRuleRow> for AlarmRule {
    fn from(r: AlarmRuleRow) -> Self {
        let severity = Severity::parse(&r.severity).unwrap_or(Severity::Warning);
        let condition = Condition::parse(&r.condition).unwrap_or(Condition::High);
        AlarmRule {
            id: r.id,
            variable_id: r.variable_id,
            name: r.name,
            description: r.description,
            severity,
            group: r.group_name,
            condition,
            threshold: r.threshold,
            enabled: r.enabled,
            hysteresis: r.hysteresis,
            confirm_ms: r.confirm_ms,
        }
    }
}

impl From<AlarmOccurrenceRow> for AlarmOccurrence {
    fn from(r: AlarmOccurrenceRow) -> Self {
        AlarmOccurrence {
            id: r.id,
            rule_id: r.rule_id,
            variable_id: r.variable_id,
            name: r.name,
            severity: Severity::parse(&r.severity).unwrap_or(Severity::Warning),
            group: r.group_name,
            message: r.message,
            value: serde_json::from_str(&r.value).unwrap_or(Value::Number(0.into())),
            threshold: r.threshold,
            status: match r.status.as_str() {
                "acknowledged" => OccurrenceStatus::Acknowledged,
                "recovered" => OccurrenceStatus::Recovered,
                _ => OccurrenceStatus::Active,
            },
            triggered_at: r.triggered_at,
            recovered_at: r.recovered_at,
            recovered_reason: r.recovered_reason,
            acknowledged_at: r.acknowledged_at,
            acknowledged_by: r.acknowledged_by,
        }
    }
}

impl From<AlarmStreamEventRow> for AlarmStreamEvent {
    fn from(r: AlarmStreamEventRow) -> Self {
        AlarmStreamEvent {
            id: r.id,
            occurrence_id: r.occurrence_id,
            event_type: match r.event_type.as_str() {
                "ack" => StreamEventType::Ack,
                "recover" => StreamEventType::Recover,
                "rule_disabled" => StreamEventType::RuleDisabled,
                _ => StreamEventType::Trigger,
            },
            at_ms: r.at_ms,
            by_user: r.by_user,
            value: serde_json::from_str(&r.value).unwrap_or(Value::Number(0.into())),
            message: r.message,
        }
    }
}

impl From<SoeRow> for SoeRecord {
    fn from(r: SoeRow) -> Self {
        SoeRecord {
            id: r.id,
            seq: r.seq,
            variable_id: r.variable_id,
            value: serde_json::from_str(&r.value).unwrap_or(Value::Number(0.into())),
            quality: r.quality,
            device_time: r.device_time,
            receive_time: r.receive_time,
            source: r.source,
        }
    }
}

impl From<&AlarmRule> for AlarmRuleRow {
    fn from(r: &AlarmRule) -> Self {
        AlarmRuleRow {
            id: r.id.clone(),
            variable_id: r.variable_id.clone(),
            name: r.name.clone(),
            description: r.description.clone(),
            severity: r.severity.as_str().into(),
            group_name: r.group.clone(),
            condition: r.condition.as_str().into(),
            threshold: r.threshold,
            enabled: r.enabled,
            hysteresis: r.hysteresis,
            confirm_ms: r.confirm_ms,
        }
    }
}

impl From<&AlarmOccurrence> for AlarmOccurrenceRow {
    fn from(o: &AlarmOccurrence) -> Self {
        AlarmOccurrenceRow {
            id: o.id.clone(),
            rule_id: o.rule_id.clone(),
            variable_id: o.variable_id.clone(),
            name: o.name.clone(),
            severity: o.severity.as_str().into(),
            group_name: o.group.clone(),
            message: o.message.clone(),
            value: o.value.to_string(),
            threshold: o.threshold,
            status: o.status.as_str().into(),
            triggered_at: o.triggered_at,
            recovered_at: o.recovered_at,
            recovered_reason: o.recovered_reason.clone(),
            acknowledged_at: o.acknowledged_at,
            acknowledged_by: o.acknowledged_by.clone(),
        }
    }
}

impl From<&AlarmStreamEvent> for AlarmStreamEventRow {
    fn from(e: &AlarmStreamEvent) -> Self {
        AlarmStreamEventRow {
            id: e.id,
            occurrence_id: e.occurrence_id.clone(),
            event_type: e.event_type.as_str().into(),
            at_ms: e.at_ms,
            by_user: e.by_user.clone(),
            value: e.value.to_string(),
            message: e.message.clone(),
        }
    }
}

impl From<&SoeRecord> for SoeRow {
    fn from(s: &SoeRecord) -> Self {
        SoeRow {
            id: s.id,
            seq: s.seq,
            variable_id: s.variable_id.clone(),
            value: s.value.to_string(),
            quality: s.quality.clone(),
            device_time: s.device_time,
            receive_time: s.receive_time,
            source: s.source.clone(),
        }
    }
}
