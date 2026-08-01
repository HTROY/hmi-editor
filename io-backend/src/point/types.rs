use serde::{Deserialize, Serialize};

/// Runtime value of an I/O point — mirrors the frontend VariableValue
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointValue {
    pub id: String,
    pub value: serde_json::Value,
    pub quality: String,
    pub timestamp: u64,
}

impl PointValue {
    pub fn new(id: &str, value: f64, quality: &str, timestamp: u64) -> Self {
        Self {
            id: id.to_string(),
            value: serde_json::Value::Number(
                serde_json::Number::from_f64((value * 100.0).round() / 100.0)
                    .unwrap_or(serde_json::Number::from(0)),
            ),
            quality: quality.to_string(),
            timestamp,
        }
    }

    pub fn numeric_value(&self) -> Option<f64> {
        match &self.value {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }
}

/// WebSocket outgoing data message — compatible with frontend WebSocketClient
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsDataMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub data: Vec<PointValue>,
}

impl WsDataMessage {
    pub fn new(points: Vec<PointValue>) -> Self {
        Self {
            msg_type: "data".into(),
            data: points,
        }
    }
}

/// WebSocket config change notification — sent when points are modified via Web UI
#[derive(Debug, Clone, Serialize)]
pub struct WsConfigChangeMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: String,
    pub variable_id: String,
    pub plugin_id: i64,
}

impl WsConfigChangeMessage {
    pub fn new(action: &str, variable_id: &str, plugin_id: i64) -> Self {
        Self {
            msg_type: "config_change".into(),
            action: action.to_string(),
            variable_id: variable_id.to_string(),
            plugin_id,
        }
    }
}
