//! Model jobs: one JSON file (registry/model-roles.json) that maps plain-language
//! jobs (Quick, Writer, Coder...) to local Ollama models, best first. Also frees
//! the GPU by unloading whatever Ollama has loaded.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub fn roles_path() -> PathBuf {
    if let Ok(p) = std::env::var("HANGAR_ROLES") {
        return PathBuf::from(p);
    }
    crate::registry::registry_dir().join("model-roles.json")
}

fn load() -> Result<Value, String> {
    let path = roles_path();
    crate::registry::ensure_from_example(&path, "model-roles.example.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Couldn't read the model jobs at {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("The model jobs file has a JSON error: {e}"))
}

#[derive(Serialize)]
pub struct RolesPayload {
    pub path: String,
    pub config: Value,
}

#[tauri::command]
pub fn roles_get() -> Result<RolesPayload, String> {
    Ok(RolesPayload { path: roles_path().display().to_string(), config: load()? })
}

#[tauri::command]
pub fn roles_save(config: Value) -> Result<(), String> {
    if !config["roles"].is_array() {
        return Err("The model jobs need a \"roles\" list".into());
    }
    let path = roles_path();
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Opens the jobs file in the default editor, for prompts and backup models.
#[tauri::command]
pub fn roles_open() -> Result<(), String> {
    let mut c = std::process::Command::new("cmd");
    c.args(["/c", "start", "", &roles_path().display().to_string()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Loaded {
    name: String,
    /// MiB held in VRAM.
    vram: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

/// Models Ollama has in memory right now (empty when it's off).
#[tauri::command]
pub async fn ollama_loaded(host: String) -> Vec<Loaded> {
    let Ok(c) = client() else { return vec![] };
    let url = format!("{}/api/ps", host.trim_end_matches('/'));
    let Ok(resp) = c.get(&url).send().await else { return vec![] };
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    v["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(Loaded {
                        name: m["name"].as_str()?.to_string(),
                        vram: m["size_vram"].as_u64().unwrap_or(0) / (1024 * 1024),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Unloads every model Ollama holds. Returns what was unloaded.
#[tauri::command]
pub async fn ollama_unload(host: String) -> Result<Vec<Loaded>, String> {
    let host = host.trim_end_matches('/').to_string();
    let loaded = ollama_loaded(host.clone()).await;
    let c = client()?;
    let url = format!("{host}/api/generate");
    for m in &loaded {
        let resp = c
            .post(&url)
            .json(&json!({ "model": m.name, "keep_alive": 0 }))
            .send()
            .await
            .map_err(|e| format!("Couldn't unload {}: {e}", m.name))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Couldn't unload {}: {status} {}", m.name, body.chars().take(200).collect::<String>()));
        }
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_file_parses_and_ids_are_unique() {
        let text = std::fs::read_to_string(crate::registry::registry_dir().join("model-roles.example.json")).expect("example file");
        let v: Value = serde_json::from_str(&text).expect("registry/model-roles.example.json must parse");
        let roles = v["roles"].as_array().expect("roles list");
        let mut ids: Vec<&str> = roles.iter().map(|r| r["id"].as_str().expect("id")).collect();
        assert!(roles.iter().all(|r| r["models"].as_array().is_some_and(|m| !m.is_empty())));
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n, "role ids must be unique");
    }
}
