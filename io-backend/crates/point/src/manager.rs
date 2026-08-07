use hmi_io_config::{AppConfig, PointMapping};
use crate::types::{point_key, PointValue};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub(crate) struct CachedPoint {
    pub mapping: PointMapping,
    pub last_value: Option<PointValue>,
}

pub struct PointManager {
    points: HashMap<String, CachedPoint>,
    active: bool,
    instance_to_logical: HashMap<String, String>,
    active_group_instance: HashMap<String, String>,
}

impl PointManager {
    pub fn from_config(config: &AppConfig) -> Self {
        let mut points = HashMap::new();
        let mut instance_to_logical = HashMap::new();
        let mut active_group_instance = HashMap::new();
        for inst in &config.plugins.instances {
            let group = inst.redundancy_group.trim();
            let logical_prefix = if group.is_empty() {
                inst.name.clone()
            } else {
                group.to_string()
            };
            for pt in &inst.points {
                let logical_key = point_key(&logical_prefix, &pt.id);
                points.insert(
                    logical_key.clone(),
                    CachedPoint {
                        mapping: pt.clone(),
                        last_value: None,
                    },
                );
                if !group.is_empty() {
                    instance_to_logical.insert(point_key(&inst.name, &pt.id), logical_key);
                }
            }
            if !group.is_empty() && inst.redundancy_role == "primary" {
                active_group_instance.insert(group.to_string(), inst.name.clone());
            }
        }
        log::info!("PointManager: {} points configured", points.len());
        Self {
            points,
            active: true,
            instance_to_logical,
            active_group_instance,
        }
    }

    /// 备机接收 Active 推送的已缩放点值，直接写入缓存（不二次缩放/去重）。
    pub fn apply_sync(&mut self, points: Vec<PointValue>) {
        for pv in points {
            if let Some(cached) = self.points.get_mut(&pv.id) {
                cached.last_value = Some(pv);
            }
        }
    }

    /// 设置节点是否处于 Active 角色（Standby 不广播、拒绝写）。
    pub fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Registry 实例级切换后同步组的活跃成员。
    pub fn set_active_instance(&mut self, group: &str, instance: &str) {
        self.active_group_instance
            .insert(group.to_string(), instance.to_string());
    }

    pub fn update(&mut self, raw: PointValue) -> Option<PointValue> {
        let id = raw.id.clone();
        // 组点：解析逻辑键并做活跃成员门控
        let logical_id = self
            .instance_to_logical
            .get(&id)
            .cloned()
            .unwrap_or_else(|| id.clone());
        if let Some(logical) = self.instance_to_logical.get(&id) {
            if let Some((group, _)) = logical.split_once(':') {
                if let Some(active_inst) = self.active_group_instance.get(group) {
                    if let Some((inst_name, _)) = id.split_once(':') {
                        if inst_name != active_inst {
                            return None; // 非活跃成员数据丢弃
                        }
                    }
                }
            }
        }
        let Some(cached) = self.points.get_mut(&logical_id) else {
            return Some(raw);
        };
        let scale = cached.mapping.scale;
        let offset = cached.mapping.offset;
        let mut scaled = apply_scaling(raw, scale, offset);
        scaled.id = logical_id.clone();
        let is_new = cached.last_value.is_none();
        let is_changed = match &cached.last_value {
            Some(prev) => prev.value != scaled.value || prev.quality != scaled.quality,
            None => true,
        };
        if is_new || is_changed {
            cached.last_value = Some(scaled.clone());
            Some(scaled)
        } else {
            None
        }
    }

    #[cfg(test)]
    pub fn insert_test_point(&mut self, id: &str, mapping: PointMapping) {
        self.points.insert(
            id.to_string(),
            CachedPoint {
                mapping,
                last_value: None,
            },
        );
    }

    pub fn get_all_values(&self) -> Vec<PointValue> {
        self.points
            .values()
            .filter_map(|cp| cp.last_value.clone())
            .collect()
    }

    /// 检查指定 variable_id 是否在管理范围内
    pub fn has_point(&self, id: &str) -> bool {
        self.points.contains_key(id)
    }

    pub fn count(&self) -> usize {
        self.points.len()
    }
}

fn apply_scaling(raw: PointValue, scale: f64, offset: f64) -> PointValue {
    if (scale - 1.0).abs() < f64::EPSILON && offset.abs() < f64::EPSILON {
        return raw;
    }
    if let Some(num) = raw.numeric_value() {
        PointValue::new(&raw.id, num * scale + offset, &raw.quality, raw.timestamp)
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_config::PluginInstance as PluginInstanceConfig;
    use crate::types::point_key;

    fn make_mapping(id: &str) -> PointMapping {
        PointMapping {
            id: id.into(),
            address: "addr".into(),
            data_type: "uint16".into(),
            byte_order: "big_endian".into(),
            scale: 1.0,
            offset: 0.0,
            var_type: "AI".into(),
        }
    }

    #[test]
    fn test_known_point_update() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        mgr.insert_test_point("pt1", make_mapping("pt1"));
        assert!(mgr
            .update(PointValue::new("pt1", 42.0, "good", 1000))
            .is_some());
    }

    #[test]
    fn test_duplicate_suppressed() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        mgr.insert_test_point("pt2", make_mapping("pt2"));
        assert!(mgr
            .update(PointValue::new("pt2", 100.0, "good", 1000))
            .is_some());
        assert!(mgr
            .update(PointValue::new("pt2", 100.0, "good", 2000))
            .is_none());
    }

    #[test]
    fn test_change_detected() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        mgr.insert_test_point("pt3", make_mapping("pt3"));
        assert!(mgr
            .update(PointValue::new("pt3", 50.0, "good", 1000))
            .is_some());
        assert!(mgr
            .update(PointValue::new("pt3", 75.0, "good", 2000))
            .is_some());
    }

    #[test]
    fn test_scaling() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        let mut m = make_mapping("pt4");
        m.scale = 0.5;
        m.offset = 10.0;
        mgr.insert_test_point("pt4", m);
        let r = mgr
            .update(PointValue::new("pt4", 100.0, "good", 1000))
            .unwrap();
        assert!((r.numeric_value().unwrap() - 60.0).abs() < 0.01);
    }

    #[test]
    fn test_get_all_values() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        mgr.insert_test_point("pt1", make_mapping("pt1"));
        mgr.insert_test_point("pt2", make_mapping("pt2"));
        mgr.update(PointValue::new("pt1", 10.0, "good", 1000));
        mgr.update(PointValue::new("pt2", 20.0, "good", 2000));
        let vals = mgr.get_all_values();
        assert_eq!(vals.len(), 2);
    }

    #[test]
    fn same_variable_id_across_instances_are_distinct() {
        let mut config = AppConfig::default_config();
        config.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
                redundancy_group: String::new(),
                redundancy_role: String::new(),
                priority: 0,
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
                redundancy_group: String::new(),
                redundancy_role: String::new(),
                priority: 0,
            },
        ];
        let mgr = PointManager::from_config(&config);
        assert_eq!(mgr.count(), 2);
        assert!(mgr.has_point(&point_key("mb1", "P1")));
        assert!(mgr.has_point(&point_key("mb2", "P1")));
    }

    #[test]
    fn same_variable_id_across_instances_update_independently() {
        let mut config = AppConfig::default_config();
        config.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
                redundancy_group: String::new(),
                redundancy_role: String::new(),
                priority: 0,
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
                redundancy_group: String::new(),
                redundancy_role: String::new(),
                priority: 0,
            },
        ];
        let mut mgr = PointManager::from_config(&config);
        mgr.update(PointValue::new(&point_key("mb1", "P1"), 1.0, "good", 1000));
        mgr.update(PointValue::new(&point_key("mb2", "P1"), 2.0, "good", 1001));
        let vals = mgr.get_all_values();
        assert_eq!(vals.len(), 2);
    }

    fn group_config() -> AppConfig {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
                redundancy_group: "mb-link".into(),
                redundancy_role: "primary".into(),
                priority: 0,
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
                redundancy_group: "mb-link".into(),
                redundancy_role: "backup".into(),
                priority: 1,
            },
        ];
        cfg
    }

    #[test]
    fn group_active_member_broadcasts_logical_id() {
        let mut mgr = PointManager::from_config(&group_config());
        assert_eq!(mgr.count(), 1); // 组内同名点只算一个逻辑点
        let r = mgr
            .update(PointValue::new(&point_key("mb1", "P1"), 10.0, "good", 1000))
            .unwrap();
        assert_eq!(r.id, "mb-link:P1");
        // 非活跃备成员的值被丢弃
        assert!(mgr
            .update(PointValue::new(&point_key("mb2", "P1"), 99.0, "good", 2000))
            .is_none());
    }

    #[test]
    fn group_switch_keeps_logical_id_stable() {
        let mut mgr = PointManager::from_config(&group_config());
        mgr.update(PointValue::new(&point_key("mb1", "P1"), 10.0, "good", 1000));
        mgr.set_active_instance("mb-link", "mb2");
        let r = mgr
            .update(PointValue::new(&point_key("mb2", "P1"), 20.0, "good", 3000))
            .unwrap();
        assert_eq!(r.id, "mb-link:P1");
        let vals = mgr.get_all_values();
        assert_eq!(vals.len(), 1);
        assert_eq!(vals[0].id, "mb-link:P1");
    }

    #[test]
    fn apply_sync_writes_known_point_without_rescaling() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        let mut m = make_mapping("pt5");
        m.scale = 2.0;
        m.offset = 1.0;
        mgr.insert_test_point("pt5", m);
        // Active 节点推送的是已缩放值，Standby 不应二次缩放
        mgr.apply_sync(vec![PointValue::new("pt5", 42.0, "good", 3000)]);
        let vals = mgr.get_all_values();
        assert_eq!(vals.len(), 1);
        assert!((vals[0].numeric_value().unwrap() - 42.0).abs() < 0.01);
        assert_eq!(vals[0].timestamp, 3000);
    }

    #[test]
    fn apply_sync_ignores_unknown_points() {
        let config = AppConfig::default_config();
        let mut mgr = PointManager::from_config(&config);
        mgr.insert_test_point("pt6", make_mapping("pt6"));
        mgr.apply_sync(vec![PointValue::new("ghost", 1.0, "good", 1)]);
        assert_eq!(mgr.count(), 1);
    }

    #[test]
    fn active_flag_gates_role() {
        let mut mgr = PointManager::from_config(&AppConfig::default_config());
        assert!(mgr.is_active());
        mgr.set_active(false);
        assert!(!mgr.is_active());
    }
}
