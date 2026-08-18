//! 共享点表配置（三插件一致，原各 guest 内重复的 `Pc`）。

use serde::{Deserialize, Serialize};

/// 单个采集点配置（与后端 `PointMapping` 字段对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointCfg {
    pub variable_id: String,
    pub address: String,
    pub var_type: String,
    #[serde(default)]
    pub data_type: String,
    #[serde(default)]
    pub byte_order: String,
    #[serde(default)]
    pub scale: f64,
    #[serde(default)]
    pub offset: f64,
}
