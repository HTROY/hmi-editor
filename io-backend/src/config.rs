use serde::{Deserialize, Serialize};

/// Top-level configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub plugins: PluginsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_path")]
    pub path: String,
    /// Batch interval in milliseconds for WebSocket data push (default 100ms)
    #[serde(default = "default_batch_interval")]
    pub batch_interval_ms: u64,
}

fn default_host() -> String {
    "0.0.0.0".into()
}
fn default_port() -> u16 {
    8080
}
fn default_path() -> String {
    "/iscs/data".into()
}
fn default_batch_interval() -> u64 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginsConfig {
    #[serde(default = "default_plugin_dir")]
    pub directory: String,
    #[serde(default = "default_scan_interval")]
    pub scan_interval_ms: u64,
    #[serde(default)]
    pub instances: Vec<PluginInstance>,
}

fn default_plugin_dir() -> String {
    "./plugins".into()
}
fn default_scan_interval() -> u64 {
    500
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInstance {
    pub name: String,
    pub wasm_file: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub points: Vec<PointMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointMapping {
    pub id: String,
    pub address: String,
    #[serde(default = "default_data_type")]
    pub data_type: String,
    #[serde(default = "default_byte_order")]
    pub byte_order: String,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default)]
    pub offset: f64,
    #[serde(default = "default_var_type")]
    pub var_type: String,
}

fn default_data_type() -> String {
    "uint16".into()
}
fn default_byte_order() -> String {
    "big_endian".into()
}
fn default_scale() -> f64 {
    1.0
}
fn default_var_type() -> String {
    "AI".into()
}

impl AppConfig {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Ok(serde_yaml::from_str(&content)?)
    }

    pub fn default_config() -> Self {
        Self {
            server: ServerConfig {
                host: default_host(),
                port: default_port(),
                path: default_path(),
                batch_interval_ms: default_batch_interval(),
            },
            plugins: PluginsConfig {
                directory: default_plugin_dir(),
                scan_interval_ms: default_scan_interval(),
                instances: vec![],
            },
        }
    }

    /// Build AppConfig from the database via Repo
    pub fn from_repo_sync(repo: &crate::db::repo::Repo) -> Self {
        let scan_interval_ms: u64 = repo
            .get_config("scan_interval_ms")
            .unwrap_or_else(|| "500".into())
            .parse()
            .unwrap_or(500);
        let batch_interval_ms: u64 = repo
            .get_config("batch_interval_ms")
            .unwrap_or_else(|| "100".into())
            .parse()
            .unwrap_or(100);
        let plugin_dir = repo
            .get_config("plugin_dir")
            .unwrap_or_else(|| "./plugins".into());

        let instances = match repo.list_plugins_with_points() {
            Ok(pws) => pws
                .into_iter()
                .filter(|pw| pw.plugin.enabled)
                .map(|pw| PluginInstance {
                    name: pw.plugin.name,
                    wasm_file: pw.plugin.wasm_file,
                    config: serde_json::from_str(&pw.plugin.config_json)
                        .unwrap_or(serde_json::json!({})),
                    points: pw
                        .points
                        .into_iter()
                        .map(|p| PointMapping {
                            id: p.variable_id,
                            address: p.address,
                            data_type: p.data_type,
                            byte_order: p.byte_order,
                            scale: p.scale,
                            offset: p.offset_val,
                            var_type: p.var_type,
                        })
                        .collect(),
                })
                .collect(),
            Err(e) => {
                log::error!("Failed to load plugins from DB: {}", e);
                vec![]
            }
        };

        AppConfig {
            server: ServerConfig {
                host: repo
                    .get_config("ws_host")
                    .unwrap_or_else(|| "0.0.0.0".into()),
                port: repo
                    .get_config("ws_port")
                    .unwrap_or_else(|| "8080".into())
                    .parse()
                    .unwrap_or(8080),
                path: "/iscs/data".into(),
                batch_interval_ms,
            },
            plugins: PluginsConfig {
                directory: plugin_dir,
                scan_interval_ms,
                instances,
            },
        }
    }
}
