//! A small JSON cache in the app data folder (cache/<ns>.json), used for the inbox briefs.

use serde_json::{Map, Value};
use std::path::PathBuf;
use tauri::Manager;

fn cache_file(app: &tauri::AppHandle, ns: &str) -> Result<PathBuf, String> {
    if ns.is_empty() || !ns.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad cache name".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{ns}.json")))
}

#[tauri::command]
pub fn cache_get(app: tauri::AppHandle, ns: String) -> Result<Value, String> {
    let f = cache_file(&app, &ns)?;
    let text = std::fs::read_to_string(&f).unwrap_or_else(|_| "{}".into());
    Ok(serde_json::from_str(&text).unwrap_or(Value::Object(Map::new())))
}

/// Merges `entries` (an object) into the cache file and saves it atomically.
#[tauri::command]
pub fn cache_merge(app: tauri::AppHandle, ns: String, entries: Map<String, Value>) -> Result<(), String> {
    let f = cache_file(&app, &ns)?;
    let mut cur: Map<String, Value> = std::fs::read_to_string(&f)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    cur.extend(entries);
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&cur).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}
