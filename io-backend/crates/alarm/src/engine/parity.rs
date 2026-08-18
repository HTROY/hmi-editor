//! 前后端共享夹具对拍测试（F12 ④）。
//!
//! 读取 `packages/contracts/src/alarm-fixtures.json`（前端 vitest 与
//! 本测试共用同一份文件），逐 case 驱动本机 AlarmEngine 并断言
//! observable 状态（active 活跃数 / recoveredUnacked 已恢复未确认数），
//! 保证 Rust 引擎与前端 LocalAlarmEngine 的语义一致。
//!
//! steps 语义（与前端测试对齐）：
//! - `point`：喂入一个点位值；
//! - `tick`：推进虚拟时钟越过确认延时并执行一次 tick；
//! - `ack`：确认第一条活跃报警。

use super::{now_ms, AlarmEngine, ConfirmCandidate};
use crate::types::{AlarmRule, OccurrenceStatus};
use hmi_io_point::types::PointValue;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use sync_util::MutexExt;
use tokio::sync::mpsc;

const FIXTURE: &str = include_str!("../../../../../packages/contracts/src/alarm-fixtures.json");

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    name: String,
    rule: AlarmRule,
    steps: Vec<FixtureStep>,
    expect: Vec<FixtureExpect>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FixtureStep {
    Point {
        point: FixturePoint,
    },
    Tick {
        #[allow(dead_code)]
        tick: Value,
    },
    Ack {
        #[allow(dead_code)]
        ack: Value,
    },
}

#[derive(Deserialize)]
struct FixturePoint {
    value: f64,
    quality: String,
}

#[derive(Deserialize)]
struct FixtureExpect {
    active: usize,
    #[serde(rename = "recoveredUnacked")]
    recovered_unacked: usize,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("alarm fixture JSON must parse")
}

/// observable 状态快照：active = 状态为 Active 的发生数；
/// recoveredUnacked = 已恢复未确认的发生数。
fn observe(eng: &AlarmEngine) -> (usize, usize) {
    let active = eng
        .active_occurrences()
        .iter()
        .filter(|o| o.status == OccurrenceStatus::Active)
        .count();
    let recovered_unacked = eng.recovered_unacked().len();
    (active, recovered_unacked)
}

/// 推进虚拟时钟越过确认延时：把候选 since_ms 拨回 confirm_ms+1，再 tick。
fn tick_after_confirm(eng: &AlarmEngine, confirm_ms: u64) {
    {
        let now = now_ms();
        let mut confirm: std::sync::MutexGuard<'_, HashMap<String, ConfirmCandidate>> =
            eng.confirm.lock_recover();
        for c in confirm.values_mut() {
            c.since_ms = now.saturating_sub(confirm_ms.saturating_add(1));
        }
    }
    eng.tick();
}

#[test]
fn fixture_parity_all_cases() {
    let fx = fixture();
    assert!(!fx.cases.is_empty(), "fixture must contain cases");
    for case in &fx.cases {
        assert_eq!(
            case.steps.len(),
            case.expect.len(),
            "case '{}': steps and expect lengths differ",
            case.name
        );
        let (tx, _rx) = mpsc::unbounded_channel();
        let eng = AlarmEngine::new(tx);
        eng.load_rules(vec![case.rule.clone()]);
        for (idx, step) in case.steps.iter().enumerate() {
            match step {
                FixtureStep::Point { point } => {
                    eng.on_point(&PointValue::new(
                        &case.rule.variable_id,
                        point.value,
                        &point.quality,
                        idx as u64,
                    ));
                }
                FixtureStep::Tick { .. } => {
                    tick_after_confirm(&eng, case.rule.confirm_ms);
                }
                FixtureStep::Ack { .. } => {
                    let first_active = eng
                        .active_occurrences()
                        .into_iter()
                        .find(|o| o.status == OccurrenceStatus::Active)
                        .map(|o| o.id);
                    if let Some(id) = first_active {
                        eng.ack(&id, "operator");
                    }
                }
            }
            let want = &case.expect[idx];
            let (active, recovered_unacked) = observe(&eng);
            assert_eq!(
                (active, recovered_unacked),
                (want.active, want.recovered_unacked),
                "case '{}' step {}: expected active={} recoveredUnacked={}, got active={} recoveredUnacked={}",
                case.name,
                idx,
                want.active,
                want.recovered_unacked,
                active,
                recovered_unacked
            );
        }
    }
}
