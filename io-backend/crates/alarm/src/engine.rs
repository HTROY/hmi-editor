//! IO-free alarm evaluation state machine.

use crate::types::{
    AlarmOccurrence, AlarmRule, AlarmStreamEvent, Condition, OccurrenceStatus, OutEvent, SoeRecord,
    StreamEventType,
};
use hmi_io_point::types::PointValue;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use sync_util::{MutexExt, RwLockExt};
use tokio::sync::mpsc;

#[cfg(test)]
mod parity;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn condition_triggered(cond: Condition, n: f64, threshold: f64) -> bool {
    match cond {
        Condition::High => n > threshold,
        Condition::Low => n < threshold,
        Condition::Equal => n == threshold,
        Condition::NotEqual => n != threshold,
        Condition::Change => false,
    }
}

/// Whether the value has left the hysteresis band and the alarm should recover.
fn should_recover(rule: &AlarmRule, n: f64) -> bool {
    match rule.condition {
        Condition::High => n <= rule.threshold - rule.hysteresis,
        Condition::Low => n >= rule.threshold + rule.hysteresis,
        Condition::Equal => n != rule.threshold,
        Condition::NotEqual => n == rule.threshold,
        Condition::Change => false,
    }
}

#[derive(Debug, Clone)]
struct ConfirmCandidate {
    since_ms: u64,
    last_value: Value,
}

pub struct AlarmEngine {
    rules: RwLock<HashMap<String, AlarmRule>>,
    active: Mutex<HashMap<String, AlarmOccurrence>>,
    recovered_unacked: Mutex<HashMap<String, AlarmOccurrence>>,
    last_values: Mutex<HashMap<String, PointValue>>,
    confirm: Mutex<HashMap<String, ConfirmCandidate>>,
    out_tx: mpsc::UnboundedSender<OutEvent>,
    soe_seq: AtomicI64,
    occ_counter: AtomicU64,
}

impl AlarmEngine {
    pub fn new(out_tx: mpsc::UnboundedSender<OutEvent>) -> Arc<Self> {
        Arc::new(Self {
            rules: RwLock::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            recovered_unacked: Mutex::new(HashMap::new()),
            last_values: Mutex::new(HashMap::new()),
            confirm: Mutex::new(HashMap::new()),
            out_tx,
            soe_seq: AtomicI64::new(0),
            occ_counter: AtomicU64::new(0),
        })
    }

    pub fn with_soe_seq(out_tx: mpsc::UnboundedSender<OutEvent>, base_seq: i64) -> Arc<Self> {
        Arc::new(Self {
            rules: RwLock::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            recovered_unacked: Mutex::new(HashMap::new()),
            last_values: Mutex::new(HashMap::new()),
            confirm: Mutex::new(HashMap::new()),
            out_tx,
            soe_seq: AtomicI64::new(base_seq),
            occ_counter: AtomicU64::new(0),
        })
    }

    // ---- Rules ----

    /// Load the full rule set, replacing whatever is in memory (no side effects).
    pub fn load_rules(&self, rules: Vec<AlarmRule>) {
        let map: HashMap<String, AlarmRule> =
            rules.into_iter().map(|r| (r.id.clone(), r)).collect();
        *self.rules.write_recover() = map;
    }

    /// Replace the rule set after a config push / CRUD change. Recovers active
    /// alarms whose rule was removed or disabled, then broadcasts the change.
    pub fn replace_rules(&self, rules: Vec<AlarmRule>) {
        let new_map: HashMap<String, AlarmRule> =
            rules.into_iter().map(|r| (r.id.clone(), r)).collect();
        {
            let old = self.rules.read_recover();
            for (id, rule) in old.iter() {
                match new_map.get(id) {
                    None => self.recover_rule(id, "规则删除"),
                    Some(nr) if nr.enabled != rule.enabled => {
                        if !nr.enabled {
                            self.recover_rule(id, "规则停用");
                        }
                    }
                    _ => {}
                }
            }
        }
        *self.rules.write_recover() = new_map;
        self.confirm.lock_recover().clear();
        let _ = self.out_tx.send(OutEvent::RulesChanged);
    }

    /// Upsert a single rule (used by CRUD APIs). Disabling recovers active alarms.
    pub fn set_rule(&self, rule: AlarmRule) {
        {
            let mut map = self.rules.write_recover();
            if rule.enabled {
                map.insert(rule.id.clone(), rule.clone());
            } else {
                map.insert(rule.id.clone(), rule.clone());
            }
        }
        if !rule.enabled {
            self.recover_rule(&rule.id, "规则停用");
        }
        let _ = self.out_tx.send(OutEvent::RulesChanged);
    }

    pub fn remove_rule(&self, id: &str) {
        self.recover_rule(id, "规则删除");
        self.rules.write_recover().remove(id);
        self.confirm.lock_recover().remove(id);
        let _ = self.out_tx.send(OutEvent::RulesChanged);
    }

    pub fn rules(&self) -> Vec<AlarmRule> {
        let mut v: Vec<AlarmRule> = self.rules.read_recover().values().cloned().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    // ---- State restore (startup / promotion) ----

    pub fn restore_occurrences(
        &self,
        active: Vec<AlarmOccurrence>,
        recovered_unacked: Vec<AlarmOccurrence>,
    ) {
        *self.active.lock_recover() = active.into_iter().map(|o| (o.id.clone(), o)).collect();
        *self.recovered_unacked.lock_recover() = recovered_unacked
            .into_iter()
            .map(|o| (o.id.clone(), o))
            .collect();
    }

    // ---- Point evaluation ----

    pub fn on_point(&self, pv: &PointValue) {
        let now = now_ms();
        let mut last = self.last_values.lock_recover();
        let prev = last.get(&pv.id).cloned();
        let value_changed = prev.as_ref().map(|p| p.value != pv.value).unwrap_or(true);
        let quality_changed = prev
            .as_ref()
            .map(|p| p.quality != pv.quality)
            .unwrap_or(true);
        if value_changed || quality_changed {
            self.emit_soe(pv, now);
        }
        last.insert(pv.id.clone(), pv.clone());
        drop(last);

        // Quality hold: don't evaluate thresholds on non-good data.
        if pv.quality != "good" {
            return;
        }

        let num = pv.numeric_value();
        let rules = self.rules.read_recover();
        for rule in rules
            .values()
            .filter(|r| r.enabled && r.variable_id == pv.id)
        {
            if rule.condition == Condition::Change {
                if value_changed {
                    self.trigger_change(rule, pv, now);
                }
                continue;
            }
            let Some(n) = num else { continue };
            let triggered = condition_triggered(rule.condition, n, rule.threshold);
            if triggered {
                if !self.has_active_for_rule(&rule.id) {
                    if rule.confirm_ms > 0 {
                        self.update_candidate(rule, n, now);
                    } else {
                        self.trigger(rule, pv, now);
                    }
                }
            } else if should_recover(rule, n) {
                self.clear_candidate(&rule.id);
                if let Some(occ_id) = self.active_id_for_rule(&rule.id) {
                    self.recover(&occ_id, now, "恢复正常");
                }
            }
        }
    }

    /// Periodic tick that finalizes confirm-delayed candidates.
    pub fn tick(&self) {
        let now = now_ms();
        let mut expired: Vec<(String, u64)> = Vec::new();
        {
            let confirm = self.confirm.lock_recover();
            for (id, c) in confirm.iter() {
                if now.saturating_sub(c.since_ms) >= self.rule_confirm_ms(id) {
                    expired.push((id.clone(), c.since_ms));
                }
            }
        }
        if expired.is_empty() {
            return;
        }
        let rules = self.rules.read_recover();
        for (rule_id, _since) in expired {
            let Some(rule) = rules.get(&rule_id).cloned() else {
                self.clear_candidate(&rule_id);
                continue;
            };
            if self.has_active_for_rule(&rule_id) {
                self.clear_candidate(&rule_id);
                continue;
            }
            let lv = self
                .last_values
                .lock()
                .unwrap()
                .get(&rule.variable_id)
                .cloned();
            if let Some(pv) = lv {
                if pv.quality == "good" {
                    if let Some(n) = pv.numeric_value() {
                        if condition_triggered(rule.condition, n, rule.threshold) {
                            self.trigger(&rule, &pv, now);
                        }
                    }
                }
            }
            self.clear_candidate(&rule_id);
        }
    }

    /// Re-evaluate persisted active alarms against current point values.
    /// Called on startup and on promotion to Active.
    pub fn rebuild(&self, values: &[PointValue]) {
        let now = now_ms();
        {
            let mut last = self.last_values.lock_recover();
            for pv in values {
                last.insert(pv.id.clone(), pv.clone());
            }
        }
        let active_ids: Vec<String> = self.active.lock_recover().keys().cloned().collect();
        let rules = self.rules.read_recover();
        for occ_id in active_ids {
            let occ = self.active.lock_recover().get(&occ_id).cloned();
            let Some(occ) = occ else { continue };
            let rule = rules.get(&occ.rule_id).cloned();
            match rule {
                None => self.recover(&occ_id, now, "规则删除"),
                Some(r) if !r.enabled => self.recover(&occ_id, now, "规则停用"),
                Some(r) => {
                    let lv = self
                        .last_values
                        .lock()
                        .unwrap()
                        .get(&r.variable_id)
                        .cloned();
                    if let Some(pv) = lv {
                        if pv.quality == "good" {
                            if let Some(n) = pv.numeric_value() {
                                if should_recover(&r, n) {
                                    self.recover(&occ_id, now, "恢复正常");
                                }
                            }
                        }
                    }
                }
            }
        }
        self.confirm.lock_recover().clear();
    }

    // ---- Acknowledgement ----

    pub fn ack(&self, occurrence_id: &str, user: &str) -> bool {
        let now = now_ms();
        let mut updated: Option<AlarmOccurrence> = None;
        {
            let mut active = self.active.lock_recover();
            if let Some(occ) = active.get_mut(occurrence_id) {
                if occ.status == OccurrenceStatus::Active {
                    occ.status = OccurrenceStatus::Acknowledged;
                    occ.acknowledged_at = Some(now);
                    occ.acknowledged_by = user.to_string();
                    updated = Some(occ.clone());
                }
            }
        }
        if updated.is_none() {
            let mut ru = self.recovered_unacked.lock_recover();
            if ru.contains_key(occurrence_id) {
                let mut occ = ru.remove(occurrence_id).unwrap();
                occ.status = OccurrenceStatus::Acknowledged;
                occ.acknowledged_at = Some(now);
                occ.acknowledged_by = user.to_string();
                updated = Some(occ);
            }
        }
        if let Some(occ) = updated {
            let event = self.stream_event(
                &occ,
                StreamEventType::Ack,
                now,
                user,
                occ.value.clone(),
                format!("{} 确认报警", user),
            );
            let _ = self.out_tx.send(OutEvent::Occurrence {
                occurrence: occ.clone(),
                event,
            });
            true
        } else {
            false
        }
    }

    pub fn ack_all(&self, user: &str) -> usize {
        let ids: Vec<String> = {
            let mut ids: Vec<String> = self
                .active
                .lock()
                .unwrap()
                .values()
                .filter(|o| o.status == OccurrenceStatus::Active)
                .map(|o| o.id.clone())
                .collect();
            ids.extend(self.recovered_unacked.lock_recover().keys().cloned());
            ids
        };
        let mut n = 0;
        for id in ids {
            if self.ack(&id, user) {
                n += 1;
            }
        }
        n
    }

    // ---- Queries ----

    pub fn active_occurrences(&self) -> Vec<AlarmOccurrence> {
        let mut v: Vec<AlarmOccurrence> = self.active.lock_recover().values().cloned().collect();
        v.sort_by(|a, b| b.triggered_at.cmp(&a.triggered_at));
        v
    }

    pub fn recovered_unacked(&self) -> Vec<AlarmOccurrence> {
        let mut v: Vec<AlarmOccurrence> = self
            .recovered_unacked
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        v.sort_by(|a, b| b.triggered_at.cmp(&a.triggered_at));
        v
    }

    pub fn unacked_count(&self) -> usize {
        self.active
            .lock()
            .unwrap()
            .values()
            .filter(|o| o.status == OccurrenceStatus::Active)
            .count()
            + self.recovered_unacked.lock_recover().len()
    }

    pub fn highest_severity(&self) -> Option<crate::types::Severity> {
        let mut sev = None;
        for occ in self.active.lock_recover().values() {
            match occ.severity {
                crate::types::Severity::Critical => return Some(crate::types::Severity::Critical),
                crate::types::Severity::Major => sev = Some(crate::types::Severity::Major),
                crate::types::Severity::Minor => {
                    if sev != Some(crate::types::Severity::Major) {
                        sev = Some(crate::types::Severity::Minor);
                    }
                }
                crate::types::Severity::Warning => {
                    if sev.is_none() {
                        sev = Some(crate::types::Severity::Warning);
                    }
                }
            }
        }
        sev
    }

    // ---- Internals ----

    fn rule_confirm_ms(&self, id: &str) -> u64 {
        self.rules
            .read()
            .unwrap()
            .get(id)
            .map(|r| r.confirm_ms)
            .unwrap_or(0)
    }

    fn has_active_for_rule(&self, rule_id: &str) -> bool {
        self.active
            .lock()
            .unwrap()
            .values()
            .any(|o| o.rule_id == rule_id)
    }

    fn active_id_for_rule(&self, rule_id: &str) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .values()
            .find(|o| o.rule_id == rule_id)
            .map(|o| o.id.clone())
    }

    fn update_candidate(&self, rule: &AlarmRule, n: f64, now: u64) {
        let mut confirm = self.confirm.lock_recover();
        match confirm.get_mut(&rule.id) {
            Some(c) => {
                c.last_value = Value::Number(
                    serde_json::Number::from_f64(n).unwrap_or(serde_json::Number::from(0)),
                );
            }
            None => {
                confirm.insert(
                    rule.id.clone(),
                    ConfirmCandidate {
                        since_ms: now,
                        last_value: Value::Number(
                            serde_json::Number::from_f64(n).unwrap_or(serde_json::Number::from(0)),
                        ),
                    },
                );
            }
        }
    }

    fn clear_candidate(&self, rule_id: &str) {
        self.confirm.lock_recover().remove(rule_id);
    }

    fn trigger(&self, rule: &AlarmRule, pv: &PointValue, now: u64) {
        let id = format!(
            "occ_{}_{}",
            now,
            self.occ_counter.fetch_add(1, Ordering::Relaxed)
        );
        let message = if rule.description.is_empty() {
            format!("{} 越限", rule.name)
        } else {
            rule.description.clone()
        };
        let occ = AlarmOccurrence {
            id: id.clone(),
            rule_id: rule.id.clone(),
            variable_id: rule.variable_id.clone(),
            name: rule.name.clone(),
            severity: rule.severity,
            group: rule.group.clone(),
            message: message.clone(),
            value: pv.value.clone(),
            threshold: rule.threshold,
            status: OccurrenceStatus::Active,
            triggered_at: now,
            recovered_at: None,
            recovered_reason: String::new(),
            acknowledged_at: None,
            acknowledged_by: String::new(),
        };
        self.active.lock_recover().insert(id.clone(), occ.clone());
        let event = self.stream_event(
            &occ,
            StreamEventType::Trigger,
            now,
            "",
            pv.value.clone(),
            message,
        );
        let _ = self.out_tx.send(OutEvent::Occurrence {
            occurrence: occ,
            event,
        });
    }

    fn trigger_change(&self, rule: &AlarmRule, pv: &PointValue, now: u64) {
        let id = format!(
            "occ_{}_{}",
            now,
            self.occ_counter.fetch_add(1, Ordering::Relaxed)
        );
        let message = if rule.description.is_empty() {
            format!("{} 变位", rule.name)
        } else {
            rule.description.clone()
        };
        let occ = AlarmOccurrence {
            id: id.clone(),
            rule_id: rule.id.clone(),
            variable_id: rule.variable_id.clone(),
            name: rule.name.clone(),
            severity: rule.severity,
            group: rule.group.clone(),
            message: message.clone(),
            value: pv.value.clone(),
            threshold: rule.threshold,
            status: OccurrenceStatus::Recovered,
            triggered_at: now,
            recovered_at: Some(now),
            recovered_reason: "瞬时变位".into(),
            acknowledged_at: None,
            acknowledged_by: String::new(),
        };
        self.recovered_unacked
            .lock()
            .unwrap()
            .insert(id.clone(), occ.clone());
        let event = self.stream_event(
            &occ,
            StreamEventType::Trigger,
            now,
            "",
            pv.value.clone(),
            message,
        );
        let _ = self.out_tx.send(OutEvent::Occurrence {
            occurrence: occ,
            event,
        });
    }

    fn recover(&self, occurrence_id: &str, now: u64, reason: &str) {
        let mut occ = {
            let mut active = self.active.lock_recover();
            match active.remove(occurrence_id) {
                Some(o) => o,
                None => return,
            }
        };
        occ.status = OccurrenceStatus::Recovered;
        occ.recovered_at = Some(now);
        occ.recovered_reason = reason.to_string();
        if occ.acknowledged_at.is_none() {
            self.recovered_unacked
                .lock()
                .unwrap()
                .insert(occ.id.clone(), occ.clone());
        }
        let event_type = match reason {
            "规则停用" | "规则删除" => StreamEventType::RuleDisabled,
            _ => StreamEventType::Recover,
        };
        let event = self.stream_event(
            &occ,
            event_type,
            now,
            "",
            occ.value.clone(),
            reason.to_string(),
        );
        let _ = self.out_tx.send(OutEvent::Occurrence {
            occurrence: occ,
            event,
        });
    }

    fn recover_rule(&self, rule_id: &str, reason: &str) {
        let ids: Vec<String> = self
            .active
            .lock()
            .unwrap()
            .values()
            .filter(|o| o.rule_id == rule_id)
            .map(|o| o.id.clone())
            .collect();
        for id in ids {
            self.recover(&id, now_ms(), reason);
        }
    }

    fn emit_soe(&self, pv: &PointValue, receive_ms: u64) {
        let seq = self.soe_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let rec = SoeRecord {
            id: 0,
            seq,
            variable_id: pv.id.clone(),
            value: pv.value.clone(),
            quality: pv.quality.clone(),
            device_time: pv.timestamp,
            receive_time: receive_ms,
            source: "backend".into(),
        };
        let _ = self.out_tx.send(OutEvent::Soe(rec));
    }

    fn stream_event(
        &self,
        occ: &AlarmOccurrence,
        event_type: StreamEventType,
        at_ms: u64,
        by_user: &str,
        value: Value,
        message: String,
    ) -> AlarmStreamEvent {
        AlarmStreamEvent {
            id: 0,
            occurrence_id: occ.id.clone(),
            event_type,
            at_ms,
            by_user: by_user.to_string(),
            value,
            message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_point::types::PointValue;
    use tokio::sync::mpsc;

    fn engine() -> (Arc<AlarmEngine>, mpsc::UnboundedReceiver<OutEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (AlarmEngine::new(tx), rx)
    }

    fn rule(id: &str, var: &str, condition: Condition, threshold: f64) -> AlarmRule {
        AlarmRule {
            id: id.into(),
            variable_id: var.into(),
            name: "测试报警".into(),
            description: String::new(),
            severity: crate::types::Severity::Major,
            group: "测试".into(),
            condition,
            threshold,
            enabled: true,
            hysteresis: 0.0,
            confirm_ms: 0,
        }
    }

    fn pv(id: &str, value: f64, quality: &str, ts: u64) -> PointValue {
        PointValue::new(id, value, quality, ts)
    }

    /// Skip SOE events and return the next occurrence update.
    fn next_occ(rx: &mut mpsc::UnboundedReceiver<OutEvent>) -> (AlarmOccurrence, AlarmStreamEvent) {
        loop {
            match rx.try_recv().unwrap() {
                OutEvent::Occurrence { occurrence, event } => return (occurrence, event),
                OutEvent::Soe(_) => continue,
                OutEvent::RulesChanged => continue,
            }
        }
    }

    #[test]
    fn high_alarm_triggers_and_recovers() {
        let (eng, mut rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::High, 100.0)]);
        eng.on_point(&pv("P1", 50.0, "good", 1));
        eng.on_point(&pv("P1", 120.0, "good", 2));
        let (occurrence, event) = next_occ(&mut rx);
        assert_eq!(occurrence.status, OccurrenceStatus::Active);
        assert_eq!(event.event_type, StreamEventType::Trigger);
        assert_eq!(eng.active_occurrences().len(), 1);
        eng.on_point(&pv("P1", 90.0, "good", 3));
        let (occurrence, event) = next_occ(&mut rx);
        assert_eq!(occurrence.status, OccurrenceStatus::Recovered);
        assert_eq!(event.event_type, StreamEventType::Recover);
        assert!(eng.active_occurrences().is_empty());
        assert_eq!(eng.recovered_unacked().len(), 1);
    }

    #[test]
    fn hysteresis_keeps_alarm_in_band() {
        let (eng, mut rx) = engine();
        let mut r = rule("r1", "P1", Condition::High, 100.0);
        r.hysteresis = 10.0;
        eng.load_rules(vec![r]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        assert_eq!(eng.active_occurrences().len(), 1);
        eng.on_point(&pv("P1", 95.0, "good", 2));
        // 95 is inside the hysteresis band (90..100): stays active
        assert_eq!(eng.active_occurrences().len(), 1);
        eng.on_point(&pv("P1", 85.0, "good", 3));
        assert!(eng.active_occurrences().is_empty());
        let _ = rx.try_recv().unwrap();
        let _ = rx.try_recv().unwrap();
    }

    #[test]
    fn change_condition_is_transient() {
        let (eng, mut rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::Change, 0.0)]);
        eng.on_point(&pv("P1", 1.0, "good", 1));
        eng.on_point(&pv("P1", 0.0, "good", 2));
        let (occurrence, event) = next_occ(&mut rx);
        assert_eq!(occurrence.status, OccurrenceStatus::Recovered);
        assert_eq!(event.event_type, StreamEventType::Trigger);
        assert!(eng.active_occurrences().is_empty());
        // Two value changes -> two transient occurrences.
        assert_eq!(eng.recovered_unacked().len(), 2);
    }

    #[test]
    fn confirm_delay_fires_only_after_deadline() {
        let (eng, mut rx) = engine();
        let mut r = rule("r1", "P1", Condition::High, 100.0);
        r.confirm_ms = 1000;
        eng.load_rules(vec![r]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        assert!(eng.active_occurrences().is_empty());
        eng.tick();
        assert!(eng.active_occurrences().is_empty());
        // Simulate time passing by forcing the candidate's start back.
        {
            let mut confirm = eng.confirm.lock_recover();
            if let Some(c) = confirm.get_mut("r1") {
                c.since_ms = now_ms() - 2000;
            }
        }
        eng.tick();
        assert_eq!(eng.active_occurrences().len(), 1);
        let _ = rx.try_recv().unwrap();
    }

    #[test]
    fn quality_hold_skips_evaluation_and_emits_soe() {
        let (eng, _rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::High, 100.0)]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        assert_eq!(eng.active_occurrences().len(), 1);
        eng.on_point(&pv("P1", 90.0, "bad", 2));
        // Non-good quality: no recovery.
        assert_eq!(eng.active_occurrences().len(), 1);
        eng.on_point(&pv("P1", 90.0, "good", 3));
        // Back to good: value is below threshold -> recovers.
        assert!(eng.active_occurrences().is_empty());
    }

    #[test]
    fn ack_active_and_recovered_unacked() {
        let (eng, mut rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::High, 100.0)]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        let occ = eng.active_occurrences()[0].clone();
        let _ = next_occ(&mut rx);
        assert!(eng.ack(&occ.id, "operator"));
        assert_eq!(eng.unacked_count(), 0);
        let (occurrence, event) = next_occ(&mut rx);
        assert_eq!(occurrence.status, OccurrenceStatus::Acknowledged);
        assert_eq!(occurrence.acknowledged_by, "operator");
        assert_eq!(event.event_type, StreamEventType::Ack);
        // Recovery of an acknowledged alarm goes straight to history.
        eng.on_point(&pv("P1", 90.0, "good", 2));
        assert!(eng.recovered_unacked().is_empty());
    }

    #[test]
    fn disable_rule_recovers_active_alarm() {
        let (eng, mut rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::High, 100.0)]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        assert_eq!(eng.active_occurrences().len(), 1);
        let _ = next_occ(&mut rx);
        let mut r = rule("r1", "P1", Condition::High, 100.0);
        r.enabled = false;
        eng.set_rule(r);
        assert!(eng.active_occurrences().is_empty());
        let (occurrence, event) = next_occ(&mut rx);
        assert_eq!(occurrence.recovered_reason, "规则停用");
        assert_eq!(event.event_type, StreamEventType::RuleDisabled);
    }

    #[test]
    fn rebuild_recovers_stale_active_alarm() {
        let (eng, mut rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::High, 100.0)]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        assert_eq!(eng.active_occurrences().len(), 1);
        eng.rebuild(&[pv("P1", 50.0, "good", 2)]);
        assert!(eng.active_occurrences().is_empty());
        let _ = rx.try_recv().unwrap();
        let _ = rx.try_recv().unwrap();
    }

    #[test]
    fn soe_seq_increments_on_value_changes() {
        let (eng, mut rx) = engine();
        eng.on_point(&pv("P1", 1.0, "good", 10));
        eng.on_point(&pv("P1", 2.0, "good", 20));
        let first = match rx.try_recv().unwrap() {
            OutEvent::Soe(s) => s,
            _ => panic!("expected soe"),
        };
        let second = match rx.try_recv().unwrap() {
            OutEvent::Soe(s) => s,
            _ => panic!("expected soe"),
        };
        assert_eq!(first.seq + 1, second.seq);
        assert_eq!(first.device_time, 10);
        assert_eq!(second.device_time, 20);
    }

    #[test]
    fn ack_all_covers_recovered_unacked() {
        let (eng, _rx) = engine();
        eng.load_rules(vec![rule("r1", "P1", Condition::High, 100.0)]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        eng.on_point(&pv("P1", 90.0, "good", 2));
        assert_eq!(eng.unacked_count(), 1);
        let n = eng.ack_all("operator");
        assert_eq!(n, 1);
        assert_eq!(eng.unacked_count(), 0);
    }

    #[test]
    fn equal_and_not_equal_conditions() {
        let (eng, _rx) = engine();
        eng.load_rules(vec![
            rule("eq", "P2", Condition::Equal, 1.0),
            rule("ne", "P3", Condition::NotEqual, 1.0),
        ]);
        eng.on_point(&pv("P2", 1.0, "good", 1));
        eng.on_point(&pv("P3", 2.0, "good", 1));
        assert_eq!(eng.active_occurrences().len(), 2);
        eng.on_point(&pv("P2", 0.0, "good", 2));
        eng.on_point(&pv("P3", 1.0, "good", 2));
        assert!(eng.active_occurrences().is_empty());
    }

    #[test]
    fn no_soe_duplicate_when_value_unchanged() {
        let (eng, mut rx) = engine();
        eng.on_point(&pv("P1", 5.0, "good", 1));
        let _ = rx.try_recv().unwrap();
        eng.on_point(&pv("P1", 5.0, "good", 2));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn point_quality_change_emits_soe() {
        let (eng, mut rx) = engine();
        eng.on_point(&pv("P1", 5.0, "good", 1));
        let _ = rx.try_recv().unwrap();
        eng.on_point(&pv("P1", 5.0, "bad", 2));
        let rec = match rx.try_recv().unwrap() {
            OutEvent::Soe(s) => s,
            _ => panic!("expected soe"),
        };
        assert_eq!(rec.quality, "bad");
    }

    #[test]
    fn confirm_candidate_cleared_when_value_recovers() {
        let (eng, _rx) = engine();
        let mut r = rule("r1", "P1", Condition::High, 100.0);
        r.confirm_ms = 1000;
        eng.load_rules(vec![r]);
        eng.on_point(&pv("P1", 120.0, "good", 1));
        eng.on_point(&pv("P1", 50.0, "good", 2));
        {
            let confirm = eng.confirm.lock_recover();
            assert!(confirm.is_empty());
        }
    }
}
