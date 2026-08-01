use crate::config::{AppConfig, PointMapping};
use crate::point::types::PointValue;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub(crate) struct CachedPoint {
    pub mapping: PointMapping,
    pub last_value: Option<PointValue>,
}

pub struct PointManager {
    points: HashMap<String, CachedPoint>,
}

impl PointManager {
    pub fn from_config(config: &AppConfig) -> Self {
        let mut points = HashMap::new();
        for inst in &config.plugins.instances {
            for pt in &inst.points {
                points.insert(
                    pt.id.clone(),
                    CachedPoint {
                        mapping: pt.clone(),
                        last_value: None,
                    },
                );
            }
        }
        log::info!("PointManager: {} points configured", points.len());
        Self { points }
    }

    pub fn update(&mut self, raw: PointValue) -> Option<PointValue> {
        let id = raw.id.clone();
        if let Some(cached) = self.points.get_mut(&id) {
            let scale = cached.mapping.scale;
            let offset = cached.mapping.offset;
            let scaled = apply_scaling(raw, scale, offset);
            let is_new = cached.last_value.is_none();
            let is_changed = match &cached.last_value {
                Some(prev) => prev.value != scaled.value,
                None => true,
            };
            if is_new || is_changed {
                cached.last_value = Some(scaled.clone());
                Some(scaled)
            } else {
                None
            }
        } else {
            Some(raw)
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
}
