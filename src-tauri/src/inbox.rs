//! The message inbox: hooks/hangar_notify.py appends one JSON line per Claude Code reply
//! ("done") or wait ("waiting") to <app data>/inbox.jsonl. Hangar shows them under the bell.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct InboxItem {
    id: String,
    at: f64,
    kind: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    project: String,
    /// The session's AI title ("notes app search"), when the transcript has one.
    #[serde(default)]
    title: String,
    text: String,
}

#[derive(Serialize)]
pub struct InboxRead {
    /// Changes whenever the file changes; send it back to skip unchanged reads.
    sig: String,
    items: Option<Vec<InboxItem>>,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn inbox_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("inbox.jsonl"))
}

pub fn parse_lines(text: &str, keep: usize) -> Vec<InboxItem> {
    let mut items: Vec<InboxItem> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let n = items.len();
    if n > keep {
        items.drain(..n - keep);
    }
    items
}

/// Returns the newest items, or items: null when the file is unchanged since `known_sig`.
#[tauri::command]
pub fn inbox_read(app: tauri::AppHandle, known_sig: Option<String>) -> Result<InboxRead, String> {
    let p = inbox_path(&app)?;
    let Ok(meta) = std::fs::metadata(&p) else {
        return Ok(InboxRead { sig: "none".into(), items: Some(vec![]) });
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sig = format!("{}-{}", meta.len(), mtime);
    if known_sig.as_deref() == Some(sig.as_str()) {
        return Ok(InboxRead { sig, items: None });
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(InboxRead { sig, items: Some(parse_lines(&String::from_utf8_lossy(&bytes), 300)) })
}

/// Sends the inbox file to the Recycle Bin; the hook starts a fresh one on the next reply.
#[tauri::command]
pub fn inbox_clear(app: tauri::AppHandle) -> Result<(), String> {
    let p = inbox_path(&app)?;
    if p.exists() {
        trash::delete(&p).map_err(|e| format!("Couldn't move the inbox to the Recycle Bin: {e}"))?;
    }
    Ok(())
}

/// Settings the hook reads (chime on or off). Hangar keeps its own copy in its store too.
#[tauri::command]
pub fn notify_settings_set(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    let p = data_dir(&app)?.join("notify.json");
    std::fs::write(&p, serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_the_newest_and_skips_bad_lines() {
        let text = "{\"id\":\"a\",\"at\":1,\"kind\":\"done\",\"text\":\"one\"}\nnot json\n\
                    {\"id\":\"b\",\"at\":2,\"kind\":\"waiting\",\"text\":\"two\"}\n\
                    {\"id\":\"c\",\"at\":3,\"kind\":\"done\",\"text\":\"three\",\"project\":\"hangar\"}\n";
        let items = super::parse_lines(text, 2);
        assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
        assert_eq!(items[1].project, "hangar");
    }
}
