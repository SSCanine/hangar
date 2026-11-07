//! Claude plan usage for the title-bar meter. Claude Code's status line runs
//! tools/claude-usage-statusline.mjs, which writes <app data>/claude-usage.json from the
//! documented `rate_limits` stdin fields. Hangar only reads that file: it never touches
//! Claude credentials or calls a usage API.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::SystemTime;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageWindow {
    /// Percent used, 0-100.
    pub pct: f64,
    /// When the window resets, epoch seconds.
    #[serde(default)]
    pub resets_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct UsageFile {
    /// A missing window means unknown, never 0%.
    #[serde(default)]
    pub five_hour: Option<UsageWindow>,
    #[serde(default)]
    pub seven_day: Option<UsageWindow>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Serialize)]
pub struct ClaudeUsage {
    #[serde(flatten)]
    file: UsageFile,
    /// Seconds since the file was last written (by mtime).
    age_secs: u64,
}

pub fn parse(text: &str) -> Option<UsageFile> {
    serde_json::from_str(text).ok()
}

pub fn read(path: &Path) -> Option<ClaudeUsage> {
    let text = std::fs::read_to_string(path).ok()?;
    let file = parse(&text)?;
    let age_secs = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    Some(ClaudeUsage { file, age_secs })
}

/// The parsed usage file plus its age, or null when it is missing or unreadable.
#[tauri::command]
pub fn claude_usage(app: tauri::AppHandle) -> Option<ClaudeUsage> {
    let dir = app.path().app_data_dir().ok()?;
    read(&dir.join("claude-usage.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_file() {
        let f = parse(r#"{"five_hour":{"pct":5,"resets_at":1792365600},"seven_day":{"pct":87,"resets_at":1792404000},"updated_at":1792350115,"session_id":"abc"}"#).unwrap();
        assert_eq!(f.five_hour, Some(UsageWindow { pct: 5.0, resets_at: Some(1792365600) }));
        assert_eq!(f.seven_day.unwrap().pct, 87.0);
        assert_eq!(f.updated_at, Some(1792350115));
    }

    #[test]
    fn missing_or_null_windows_stay_unknown() {
        let f = parse(r#"{"five_hour":null,"updated_at":1}"#).unwrap();
        assert!(f.five_hour.is_none() && f.seven_day.is_none());
        assert!(parse("not json").is_none());
    }

    #[test]
    fn read_reports_age() {
        let p = std::env::temp_dir().join(format!("hangar-usage-test-{}.json", std::process::id()));
        std::fs::write(&p, r#"{"seven_day":{"pct":42.5}}"#).unwrap();
        let u = read(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(u.file.seven_day.unwrap().pct, 42.5);
        assert!(u.age_secs < 60);
        assert!(read(&std::env::temp_dir().join("hangar-usage-missing.json")).is_none());
    }
}
