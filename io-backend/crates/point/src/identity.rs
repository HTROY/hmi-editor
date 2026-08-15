//! 点位身份（Point Identity）——逻辑键与活跃发布者的唯一事实来源。
//!
//! 实例级冗余组内点位以组名作逻辑键前缀（`{组}:{变量}`），独立实例以
//! 实例名作前缀（`{实例}:{变量}`）。此前该规则在 manager / registry / web
//! 各自 `if redundancy_group.is_empty()` 重推，改一处要改三处；
//! 现在逻辑键推导、键拆分与活跃发布者判定全部收敛在本模块。

use std::collections::HashMap;

use hmi_io_config::AppConfig;

use crate::types::point_key;

/// 逻辑键规则：组内点位用组名作前缀，独立实例用实例名作前缀。
///
/// 前缀统一按 trim 后的组名判定（与 config 校验一致），
/// 保证 manager / registry / web 产出的键永远一致。
pub fn logical_key(group: &str, instance: &str, variable_id: &str) -> String {
    let prefix = if group.trim().is_empty() {
        instance
    } else {
        group.trim()
    };
    point_key(prefix, variable_id)
}

/// 按第一个 `:` 拆分逻辑键 → `(前缀, 变量ID)`。
/// 变量 ID 约定不含冒号；即便含冒号也以首个冒号为界（全系统同一规则）。
pub fn split_key(key: &str) -> (&str, &str) {
    match key.split_once(':') {
        Some((prefix, variable)) => (prefix, variable),
        None => (key, ""),
    }
}

/// 组路由：实例原始键 → 逻辑键的映射，以及冗余组当前活跃发布者。
///
/// 由配置构建一次，实例级接管时经 [`Self::set_active_instance`] 更新；
/// PointManager 用它完成「非活跃成员数据丢弃」的门控，
/// 逻辑键推导与写点目标解析也以它为同一接口。
#[derive(Debug, Default)]
pub struct GroupRouting {
    /// `{实例}:{变量}` → `{组}:{变量}`（仅组内实例）
    instance_to_logical: HashMap<String, String>,
    /// 组 → 当前活跃发布者实例名（键为 trim 后的组名）
    active_group_instance: HashMap<String, String>,
}

impl GroupRouting {
    /// 从插件实例配置构建映射（组内主实例为初始活跃发布者）。
    pub fn from_config(config: &AppConfig) -> Self {
        let mut routing = GroupRouting::default();
        for inst in &config.plugins.instances {
            let group = inst.redundancy_group.trim();
            if group.is_empty() {
                continue;
            }
            for pt in &inst.points {
                routing
                    .instance_to_logical
                    .insert(point_key(&inst.name, &pt.id), logical_key(group, &inst.name, &pt.id));
            }
            if inst.redundancy_role == "primary" {
                routing
                    .active_group_instance
                    .insert(group.to_string(), inst.name.clone());
            }
        }
        routing
    }

    /// 实例级接管后更新组的活跃发布者。
    pub fn set_active_instance(&mut self, group: &str, instance: &str) {
        self.active_group_instance
            .insert(group.trim().to_string(), instance.to_string());
    }

    /// 原始实例键 → 逻辑键（未分组键原样返回）。
    pub fn logical_id(&self, raw_key: &str) -> String {
        self.instance_to_logical
            .get(raw_key)
            .cloned()
            .unwrap_or_else(|| raw_key.to_string())
    }

    /// 该原始键当前是否由活跃发布者产生：
    /// 未分组键恒发布；组内键仅活跃成员发布，其余成员数据丢弃。
    pub fn is_published(&self, raw_key: &str) -> bool {
        let Some(logical) = self.instance_to_logical.get(raw_key) else {
            return true;
        };
        let Some((group, _)) = logical.split_once(':') else {
            return true;
        };
        let Some(active) = self.active_group_instance.get(group) else {
            return true;
        };
        let Some((instance, _)) = raw_key.split_once(':') else {
            return true;
        };
        instance == active
    }

    /// 组当前活跃发布者实例名。
    pub fn active_instance(&self, group: &str) -> Option<&str> {
        self.active_group_instance
            .get(group.trim())
            .map(|s| s.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_config::PluginInstance as PluginInstanceConfig;

    fn mapping(id: &str) -> hmi_io_config::PointMapping {
        hmi_io_config::PointMapping {
            id: id.into(),
            address: "addr".into(),
            data_type: "uint16".into(),
            byte_order: "big_endian".into(),
            scale: 1.0,
            offset: 0.0,
            var_type: "AI".into(),
        }
    }

    fn instance(
        name: &str,
        group: &str,
        role: &str,
        priority: u32,
    ) -> PluginInstanceConfig {
        PluginInstanceConfig {
            name: name.into(),
            wasm_file: "modbus.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: group.into(),
            redundancy_role: role.into(),
            priority,
        }
    }

    #[test]
    fn logical_key_uses_group_prefix_for_grouped_points() {
        assert_eq!(
            logical_key("mb-link", "mb1", "P1"),
            "mb-link:P1"
        );
        assert_eq!(logical_key("", "mb1", "P1"), "mb1:P1");
    }

    #[test]
    fn logical_key_trims_group_whitespace() {
        assert_eq!(
            logical_key("  mb-link  ", "mb1", "P1"),
            "mb-link:P1"
        );
        assert_eq!(logical_key("   ", "mb1", "P1"), "mb1:P1");
    }

    #[test]
    fn split_key_splits_at_first_colon() {
        assert_eq!(split_key("mb-link:P1"), ("mb-link", "P1"));
        assert_eq!(split_key("no-colon"), ("no-colon", ""));
        assert_eq!(split_key("a:b:c"), ("a", "b:c"));
    }

    fn group_config() -> AppConfig {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            instance("mb1", "mb-link", "primary", 0),
            instance("mb2", "mb-link", "backup", 1),
            instance("mb3", "", "", 0),
        ];
        cfg
    }

    #[test]
    fn routing_maps_instance_keys_to_logical_keys() {
        let routing = GroupRouting::from_config(&group_config());
        assert_eq!(routing.logical_id("mb1:P1"), "mb-link:P1");
        assert_eq!(routing.logical_id("mb2:P1"), "mb-link:P1");
        // 未分组实例键原样返回
        assert_eq!(routing.logical_id("mb3:P1"), "mb3:P1");
        // 未知键原样返回
        assert_eq!(routing.logical_id("ghost:P1"), "ghost:P1");
    }

    #[test]
    fn routing_gates_non_active_members() {
        let routing = GroupRouting::from_config(&group_config());
        // 活跃主实例发布
        assert!(routing.is_published("mb1:P1"));
        // 备实例被门控丢弃
        assert!(!routing.is_published("mb2:P1"));
        // 未分组与未知键恒发布
        assert!(routing.is_published("mb3:P1"));
        assert!(routing.is_published("ghost:P1"));
        assert_eq!(routing.active_instance("mb-link"), Some("mb1"));
    }

    #[test]
    fn routing_switch_flips_publisher() {
        let mut routing = GroupRouting::from_config(&group_config());
        routing.set_active_instance("mb-link", "mb2");
        assert!(!routing.is_published("mb1:P1"));
        assert!(routing.is_published("mb2:P1"));
        assert_eq!(routing.active_instance("mb-link"), Some("mb2"));
        // 逻辑键在切换前后保持不变
        assert_eq!(routing.logical_id("mb2:P1"), "mb-link:P1");
    }

    #[test]
    fn routing_key_rule_agrees_with_manager_mapping() {
        // 与 PointManager 行为的一致性：组内两个实例映射到同一个逻辑点
        let routing = GroupRouting::from_config(&group_config());
        assert_eq!(routing.logical_id("mb1:P1"), routing.logical_id("mb2:P1"));
    }
}
