//! 实例级冗余监督决策（纯逻辑，无 IO）。
//!
//! 把「活跃成员健康 → 失败计数 → 阈值/冷却 → 下一个成员」与
//! 插件重连限速、primary 回切探测周期等判定从 registry 的异步执行中抽出：
//! 决策在这里单测，registry 只负责收集运行时输入并执行决策结果。

use std::time::Duration;

/// 组内成员（primary 在前，backup 按 priority 升序，由 rebuild_groups 排定）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberRef {
    pub name: String,
    pub role: String,
    pub priority: u32,
}

/// 成员接管顺序（环形）：当前活跃成员之后的下一个。
pub fn next_member(members: &[MemberRef], active: &str) -> Option<String> {
    let idx = members.iter().position(|m| m.name == active)?;
    let next = (idx + 1) % members.len();
    Some(members[next].name.clone())
}

/// 单个组的监督输入快照（由 registry 从运行时状态收集）。
#[derive(Debug, Clone)]
pub struct GroupHealth {
    /// 当前活跃成员
    pub active: String,
    /// 已连续失败次数（不含本次）
    pub failures: u32,
    /// 上次切换时间戳（毫秒）
    pub last_switch_ms: u64,
    /// 活跃成员当前是否健康（connected 且扫描新鲜）
    pub active_healthy: bool,
    /// 接管顺序（primary 在前，backup 按 priority 升序）
    pub members: Vec<MemberRef>,
}

/// 一次监督 tick 对单个组的决策结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisionDecision {
    /// 活跃成员健康：重置失败计数
    Healthy,
    /// 不健康但未达阈值或未过冷却：继续计数
    KeepCounting,
    /// 切换活跃成员
    Switch { next: String },
}

/// 活跃成员健康检查后的监督决策：
/// 连续 `threshold` 次不健康且距上次切换超过 `cooldown_ms` 才切换，
/// 按接管顺序取下一个成员（无下一个或单成员组不切换）。
pub fn evaluate_group(
    g: &GroupHealth,
    now_ms: u64,
    threshold: u32,
    cooldown_ms: u64,
) -> SupervisionDecision {
    if g.active_healthy {
        return SupervisionDecision::Healthy;
    }
    let failures = g.failures + 1;
    if failures < threshold.max(1) || now_ms.saturating_sub(g.last_switch_ms) < cooldown_ms {
        return SupervisionDecision::KeepCounting;
    }
    match next_member(&g.members, &g.active) {
        Some(next) if next != g.active => SupervisionDecision::Switch { next },
        _ => SupervisionDecision::KeepCounting,
    }
}

/// primary 回切探测周期判定：活跃成员非 primary，且探测次数
/// × 扫描周期已到回切延迟（至少一拍）。
pub fn should_probe_primary(
    probe_ticks: u32,
    scan_interval_ms: u64,
    failback_delay_ms: u64,
) -> bool {
    let interval = scan_interval_ms.max(100);
    (probe_ticks as u64) * interval >= failback_delay_ms.max(interval)
}

/// 插件链路丢失后的重连决策：
/// 扫描返回非零码、连接状态非 connected(2)、且距上次重连已过限速间隔。
pub fn should_reconnect(
    scan_code: u32,
    connection_state: u32,
    since_last_reconnect: Duration,
    min_interval: Duration,
) -> bool {
    scan_code != 0 && connection_state != 2 && since_last_reconnect >= min_interval
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(name: &str, role: &str, priority: u32) -> MemberRef {
        MemberRef {
            name: name.into(),
            role: role.into(),
            priority,
        }
    }

    fn health(active: &str, failures: u32, last_switch_ms: u64, healthy: bool) -> GroupHealth {
        GroupHealth {
            active: active.into(),
            failures,
            last_switch_ms,
            active_healthy: healthy,
            members: vec![
                member("p", "primary", 0),
                member("b1", "backup", 1),
                member("b2", "backup", 2),
            ],
        }
    }

    #[test]
    fn next_member_follows_order_and_wraps() {
        let members = vec![member("p", "primary", 0), member("b1", "backup", 1), member("b2", "backup", 2)];
        assert_eq!(next_member(&members, "p"), Some("b1".to_string()));
        assert_eq!(next_member(&members, "b1"), Some("b2".to_string()));
        assert_eq!(next_member(&members, "b2"), Some("p".to_string()));
        assert_eq!(next_member(&members, "ghost"), None);
    }

    #[test]
    fn healthy_group_resets_failures() {
        let g = health("p", 5, 0, true);
        assert_eq!(evaluate_group(&g, 1000, 3, 0), SupervisionDecision::Healthy);
    }

    #[test]
    fn unhealthy_below_threshold_keeps_counting() {
        let g = health("p", 1, 0, false);
        assert_eq!(
            evaluate_group(&g, 1000, 3, 0),
            SupervisionDecision::KeepCounting
        );
    }

    #[test]
    fn unhealthy_within_cooldown_keeps_counting() {
        // 已失败 2 次（本次为第 3 次）达阈值，但距上次切换仅 500ms < 冷却 60s
        let g = health("p", 2, 10_000, false);
        assert_eq!(
            evaluate_group(&g, 10_500, 3, 60_000),
            SupervisionDecision::KeepCounting
        );
    }

    #[test]
    fn threshold_and_cooldown_switch_to_next_member() {
        let g = health("p", 2, 10_000, false);
        assert_eq!(
            evaluate_group(&g, 70_100, 3, 60_000),
            SupervisionDecision::Switch { next: "b1".into() }
        );
    }

    #[test]
    fn single_member_group_never_switches() {
        let g = GroupHealth {
            active: "solo".into(),
            failures: 99,
            last_switch_ms: 0,
            active_healthy: false,
            members: vec![member("solo", "primary", 0)],
        };
        assert_eq!(
            evaluate_group(&g, 1_000_000, 3, 0),
            SupervisionDecision::KeepCounting
        );
    }

    #[test]
    fn probe_primary_waits_for_failback_delay() {
        // 扫描周期 1000ms：3 拍（3000ms）< 延迟 5000ms → 不探测
        assert!(!should_probe_primary(3, 1000, 5000));
        // 5 拍（5000ms）达标 → 探测
        assert!(should_probe_primary(5, 1000, 5000));
        // 延迟小于一拍时至少一拍后探测
        assert!(!should_probe_primary(0, 1000, 100));
        assert!(should_probe_primary(1, 1000, 100));
    }

    #[test]
    fn reconnect_respects_code_status_and_interval() {
        let min = Duration::from_secs(5);
        assert!(should_reconnect(1, 0, Duration::from_secs(6), min));
        // 扫描成功码不重连
        assert!(!should_reconnect(0, 0, Duration::from_secs(6), min));
        // 已连接（status=2）不重连
        assert!(!should_reconnect(1, 2, Duration::from_secs(6), min));
        // 未过限速间隔不重连
        assert!(!should_reconnect(1, 0, Duration::from_secs(4), min));
    }
}
