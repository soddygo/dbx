use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::agent_driver::AgentDriverClient;
use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegistry {
    pub jre: JreInfo,
    pub drivers: std::collections::HashMap<String, DriverInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JreInfo {
    pub version: String,
    pub platforms: std::collections::HashMap<String, ArtifactInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverInfo {
    pub version: String,
    pub label: String,
    pub min_app_version: String,
    pub jar: ArtifactInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactInfo {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    #[serde(default)]
    pub jre_version: Option<String>,
    #[serde(default)]
    pub installed_drivers: std::collections::HashMap<String, InstalledDriver>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledDriver {
    pub version: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDriverInfo {
    pub db_type: String,
    pub label: String,
    pub version: String,
    pub size: u64,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

pub struct AgentManager {
    base_dir: PathBuf,
}

impl AgentManager {
    pub fn new() -> Self {
        let home =
            std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| ".".to_string());
        Self { base_dir: PathBuf::from(home).join(".dbx").join("agents") }
    }

    pub fn base_dir(&self) -> &PathBuf {
        &self.base_dir
    }

    pub fn jre_java_path(&self) -> PathBuf {
        if cfg!(windows) {
            self.base_dir.join("jre").join("bin").join("java.exe")
        } else {
            self.base_dir.join("jre").join("bin").join("java")
        }
    }

    pub fn driver_jar_path(&self, db_type: &str) -> PathBuf {
        self.base_dir.join("drivers").join(db_type).join("agent.jar")
    }

    fn state_path(&self) -> PathBuf {
        self.base_dir.join("state.json")
    }

    pub fn load_state(&self) -> AgentState {
        std::fs::read_to_string(self.state_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(AgentState { jre_version: None, installed_drivers: Default::default() })
    }

    pub fn save_state(&self, state: &AgentState) -> Result<(), String> {
        let dir = self.base_dir.clone();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        std::fs::write(self.state_path(), json).map_err(|e| e.to_string())
    }

    pub fn is_jre_installed(&self) -> bool {
        self.jre_java_path().exists()
    }

    pub fn is_driver_installed(&self, db_type: &str) -> bool {
        self.driver_jar_path(db_type).exists()
    }

    pub fn db_type_to_agent_key(db_type: &DatabaseType) -> Option<&'static str> {
        match db_type {
            DatabaseType::Dameng => Some("dameng"),
            DatabaseType::Kingbase => Some("kingbase"),
            DatabaseType::Vastbase => Some("vastbase"),
            DatabaseType::Goldendb => Some("goldendb"),
            _ => None,
        }
    }

    pub fn is_agent_type(db_type: &DatabaseType) -> bool {
        Self::db_type_to_agent_key(db_type).is_some()
    }

    pub async fn spawn(&self, db_type: &DatabaseType) -> Result<AgentDriverClient, String> {
        let key = Self::db_type_to_agent_key(db_type)
            .ok_or_else(|| format!("{:?} is not an agent-driven database type", db_type))?;

        if !self.is_jre_installed() {
            return Err("JRE runtime is not installed. Please install it from the Driver Manager.".to_string());
        }
        if !self.is_driver_installed(key) {
            return Err(format!("{key} driver is not installed. Please install it from the Driver Manager."));
        }

        let java = self.jre_java_path().to_string_lossy().to_string();
        let jar = self.driver_jar_path(key).to_string_lossy().to_string();
        AgentDriverClient::spawn(&java, &jar).await
    }

    pub async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let resp = reqwest::get(url).await.map_err(|e| format!("Download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed with status: {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Download read failed: {e}"))?;
        std::fs::write(dest, &bytes).map_err(|e| format!("Failed to write file: {e}"))
    }

    pub fn current_platform() -> &'static str {
        if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "macos-aarch64"
        } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
            "macos-x64"
        } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
            "linux-aarch64"
        } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
            "linux-x64"
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "aarch64") {
            "windows-aarch64"
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            "windows-x64"
        } else {
            "unknown"
        }
    }
}
