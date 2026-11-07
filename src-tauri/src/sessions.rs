//! Claude Code conversations: find a session's transcript, turn it into plain you / Claude
//! messages, resume it in a terminal, and open hangar:// links from notifications.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn projects_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    Path::new(&home).join(".claude").join("projects")
}

/// Claude Code stores a session under its working folder with every non-alphanumeric
/// character turned into "-": D:\Projects -> D--Projects.
pub fn encode_cwd(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn find_transcript(session_id: &str, cwd: &str) -> Option<PathBuf> {
    if !valid_id(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    let base = projects_dir();
    if !cwd.is_empty() {
        let p = base.join(encode_cwd(cwd)).join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    std::fs::read_dir(&base).ok()?.flatten().map(|d| d.path().join(&name)).find(|p| p.is_file())
}

#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub role: &'static str,
    pub text: String,
    at: String,
}

#[derive(Serialize)]
pub struct Conversation {
    session_id: String,
    title: String,
    cwd: String,
    path: String,
    modified: u64,
    total: usize,
    messages: Vec<Message>,
}

/// Text a person typed, without the tags Claude Code wraps around commands and reminders.
fn clean_user_text(s: &str) -> Option<String> {
    let mut t = s.to_string();
    for tag in ["system-reminder", "command-message", "command-args", "local-command-stdout", "local-command-stderr", "local-command-caveat"] {
        loop {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            let Some(a) = t.find(&open) else { break };
            let end = t[a..].find(&close).map(|b| a + b + close.len()).unwrap_or(t.len());
            t.replace_range(a..end, "");
        }
    }
    // A pasted message is wrapped as <pasted_content id="N">...</pasted_content id="N">: keep the
    // text, drop only the tags (the chat's outbox matches it against what was typed).
    for open in ["<pasted_content", "</pasted_content"] {
        while let Some(a) = t.find(open) {
            let Some(b) = t[a..].find('>') else { break };
            t.replace_range(a..a + b + 1, "");
        }
    }
    // A slash command shows as its name.
    if let (Some(a), Some(b)) = (t.find("<command-name>"), t.find("</command-name>")) {
        let name = t[a + 14..b].to_string();
        t = format!("{name} {}", &t[b + 15..]);
    }
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

fn text_blocks(content: &Value) -> Vec<String> {
    match content {
        Value::String(s) => vec![s.clone()],
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str().map(String::from))
            .collect(),
        _ => vec![],
    }
}

/// One line for a tool call: its name plus the most telling argument.
fn tool_line(block: &Value) -> String {
    let name = block["name"].as_str().unwrap_or("tool");
    let input = &block["input"];
    let arg = ["command", "file_path", "pattern", "url", "query", "description", "prompt", "path"]
        .iter()
        .find_map(|k| input[*k].as_str())
        .unwrap_or("");
    let arg: String = arg.lines().next().unwrap_or("").chars().take(140).collect();
    if arg.is_empty() { name.to_string() } else { format!("{name}: {arg}") }
}

#[cfg(test)]
pub fn parse_transcript(text: &str) -> (Vec<Message>, String, String) {
    parse_transcript_with(text, false)
}

/// Like `parse_transcript`; with `tools`, each tool call also shows as a short "tool" line.
pub fn parse_transcript_with(text: &str, tools: bool) -> (Vec<Message>, String, String) {
    let mut msgs: Vec<Message> = Vec::new();
    let mut title = String::new();
    let mut cwd = String::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let kind = v["type"].as_str().unwrap_or("");
        if kind == "ai-title" {
            if let Some(t) = v["aiTitle"].as_str() {
                title = t.to_string();
            }
            continue;
        }
        if let Some(c) = v["cwd"].as_str() {
            cwd = c.to_string();
        }
        if v["isMeta"].as_bool() == Some(true) || v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        let at = v["timestamp"].as_str().unwrap_or("").to_string();
        match kind {
            "user" => {
                for t in text_blocks(&v["message"]["content"]) {
                    if let Some(t) = clean_user_text(&t) {
                        msgs.push(Message { role: "user", text: t, at: at.clone() });
                    }
                }
            }
            // A message typed while Claude is mid-task is taken into the running turn and saved as a
            // queued_command attachment, not a user line; without this the chat dropped every message
            // sent while Claude was working.
            "attachment" if v["attachment"]["type"] == "queued_command" => {
                let at = v["attachment"]["timestamp"].as_str().map(String::from).unwrap_or(at);
                for t in text_blocks(&v["attachment"]["prompt"]) {
                    if let Some(t) = clean_user_text(&t) {
                        if !matches!(msgs.last(), Some(last) if last.role == "user" && last.text == t) {
                            msgs.push(Message { role: "user", text: t, at: at.clone() });
                        }
                    }
                }
            }
            "assistant" => {
                if tools {
                    for b in v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_use") {
                        msgs.push(Message { role: "tool", text: tool_line(b), at: at.clone() });
                    }
                }
                let t = text_blocks(&v["message"]["content"]).join("\n\n");
                let t = t.trim();
                if t.is_empty() {
                    continue;
                }
                // One reply often spans several lines (one per block): join them.
                match msgs.last_mut() {
                    Some(last) if last.role == "assistant" => {
                        last.text.push_str("\n\n");
                        last.text.push_str(t);
                    }
                    _ => msgs.push(Message { role: "assistant", text: t.to_string(), at }),
                }
            }
            _ => {}
        }
    }
    (msgs, title, cwd)
}

#[tauri::command]
pub async fn session_read(session_id: String, cwd: String, limit: Option<usize>, tools: Option<bool>) -> Result<Conversation, String> {
    tokio::task::spawn_blocking(move || {
        let path = find_transcript(&session_id, &cwd)
            .ok_or_else(|| "That conversation's transcript isn't on this PC anymore (Claude Code cleans up old ones).".to_string())?;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let (msgs, title, found_cwd) = parse_transcript_with(&String::from_utf8_lossy(&bytes), tools.unwrap_or(false));
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|m| m.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs())
            .unwrap_or(0);
        let total = msgs.len();
        let keep = limit.unwrap_or(400);
        Ok(Conversation {
            session_id,
            title,
            cwd: if found_cwd.is_empty() { cwd } else { found_cwd },
            path: path.display().to_string(),
            modified,
            total,
            messages: msgs.into_iter().skip(total.saturating_sub(keep)).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many lines the transcript has (0 without one), to look only at what comes after.
pub fn transcript_lines(session_id: &str, cwd: &str) -> usize {
    find_transcript(session_id, cwd)
        .and_then(|p| std::fs::read(p).ok())
        .map(|b| String::from_utf8_lossy(&b).lines().count())
        .unwrap_or(0)
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Delivery {
    /// Claude Code took it as the next message.
    Sent,
    /// Claude was busy, so it sits in Claude Code's queue (like typing ahead in the terminal).
    Queued,
}

/// Whether `text` reached the session after transcript line `after`: as a message, or into the
/// queue Claude Code keeps while it works. None while neither has happened.
pub fn delivery(session_id: &str, cwd: &str, text: &str, after: usize) -> Option<Delivery> {
    let p = find_transcript(session_id, cwd)?;
    delivery_in(&String::from_utf8_lossy(&std::fs::read(p).ok()?), text, after)
}

fn delivery_in(all: &str, text: &str, after: usize) -> Option<Delivery> {
    let want: String = squash(text).chars().take(80).collect();
    let mut queued = false;
    for line in all.lines().skip(after) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v["type"].as_str() {
            Some("user") if text_blocks(&v["message"]["content"]).iter().any(|t| squash(t).contains(&want)) => {
                return Some(Delivery::Sent)
            }
            Some("queue-operation")
                if v["operation"] == "enqueue" && v["content"].as_str().is_some_and(|c| squash(c).contains(&want)) =>
            {
                queued = true
            }
            _ => {}
        }
    }
    queued.then_some(Delivery::Queued)
}

/// Size and modified time (ms) of a session's transcript, so a live view only re-reads it
/// when it changed. None when there is no transcript yet.
#[tauri::command]
pub fn session_stamp(session_id: String, cwd: String) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(find_transcript(&session_id, &cwd)?).ok()?;
    let ms = meta.modified().ok()?.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_millis() as u64;
    Some((meta.len(), ms))
}

/// Opens the conversation in a new Windows Terminal tab with `claude --resume`.
#[tauri::command]
pub fn session_resume(session_id: String, cwd: String, title: Option<String>) -> Result<(), String> {
    if !valid_id(&session_id) {
        return Err("Not a session id".into());
    }
    let dir = if Path::new(&cwd).is_dir() { cwd } else { std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()) };
    let tab = format!("Claude: {}", title.unwrap_or_default().chars().take(40).collect::<String>());
    let wt = Command::new("wt.exe")
        .args(["-w", "0", "new-tab", "--title", &tab, "-d", &dir, "claude", "--resume", &session_id])
        .spawn();
    if wt.is_ok() {
        return Ok(());
    }
    let line = format!("cd /d \"{dir}\" && claude --resume {session_id}");
    let mut c = Command::new("cmd.exe");
    c.args(["/c", "start", "Claude", "cmd", "/k", &line]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Where a conversation's transcript is on disk ("" when it can't be found), for "Show file".
#[tauri::command]
pub fn session_path(session_id: String, cwd: String) -> String {
    find_transcript(&session_id, &cwd).map(|p| p.display().to_string()).unwrap_or_default()
}

/// Brings up VS Code on the conversation's folder (focuses the window that has it open).
#[tauri::command]
pub fn vscode_open(cwd: String) -> Result<(), String> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("Folder not found: {cwd}"));
    }
    let mut c = Command::new("cmd.exe");
    c.args(["/c", "code", &cwd]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---- hangar:// links from notifications ----

#[derive(Default)]
pub struct PendingUrl(pub Mutex<Option<String>>);

pub fn url_from_args(args: &[String]) -> Option<String> {
    args.iter().find(|a| a.starts_with("hangar://")).cloned()
}

/// Shows the main window and hands the link to the page (or keeps it until the page asks).
pub fn deliver(app: &tauri::AppHandle, url: String) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    *app.state::<PendingUrl>().0.lock().unwrap() = Some(url.clone());
    let _ = app.emit("hangar://open-url", url);
}

/// A plain second launch (no link): just bring Hangar forward.
pub fn deliver_focus(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The link Hangar was started with (or the last one delivered), once.
#[tauri::command]
pub fn take_pending_url(state: tauri::State<'_, PendingUrl>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Points hangar:// at this exe (HKCU, no admin), so notification clicks always reach this build.
pub fn register_protocol() {
    let Ok(exe) = std::env::current_exe() else { return };
    let cmd = format!("\"{}\" \"%1\"", exe.display());
    let runs: [Vec<String>; 3] = [
        vec!["add".into(), r"HKCU\Software\Classes\hangar".into(), "/ve".into(), "/d".into(), "URL:Hangar".into(), "/f".into()],
        vec!["add".into(), r"HKCU\Software\Classes\hangar".into(), "/v".into(), "URL Protocol".into(), "/d".into(), "".into(), "/f".into()],
        vec!["add".into(), r"HKCU\Software\Classes\hangar\shell\open\command".into(), "/ve".into(), "/d".into(), cmd, "/f".into()],
    ];
    for args in runs {
        let mut c = Command::new("reg.exe");
        c.args(&args);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.output();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pasted_content_wrapper_is_dropped_but_its_text_kept() {
        let raw = "  <pasted_content id=\"1626\">
Report line

Second line
</pasted_content id=\"1626\">";
        assert_eq!(clean_user_text(raw).as_deref(), Some("Report line

Second line"));
        assert_eq!(clean_user_text("<pasted_content id=\"9\"></pasted_content id=\"9\">"), None);
        assert_eq!(clean_user_text("a <b> c").as_deref(), Some("a <b> c"));
    }

    use super::*;

    #[test]
    fn encodes_cwd_like_claude_code() {
        assert_eq!(encode_cwd(r"D:\Projects"), "D--Projects");
        assert_eq!(encode_cwd(r"C:\Users\me\.claude\jobs"), "C--Users-me--claude-jobs");
    }

    #[test]
    fn parses_messages_and_drops_noise() {
        let t = r#"{"type":"ai-title","aiTitle":"notes app search"}
{"type":"user","cwd":"D:\\Projects","timestamp":"t1","message":{"content":"<system-reminder>x</system-reminder>Add a search button"}}
{"type":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"On it."}]}}
{"type":"assistant","timestamp":"t3","message":{"content":[{"type":"tool_use","name":"Bash"}]}}
{"type":"user","timestamp":"t4","message":{"content":[{"type":"tool_result","content":"ok"}]}}
{"type":"assistant","timestamp":"t5","message":{"content":[{"type":"text","text":"Done: the button works."}]}}
{"type":"user","isMeta":true,"message":{"content":"meta"}}"#;
        let (m, title, cwd) = parse_transcript(t);
        assert_eq!(title, "notes app search");
        assert_eq!(cwd, r"D:\Projects");
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].text, "Add a search button");
        assert_eq!(m[1].text, "On it.\n\nDone: the button works.");

        // Messages sent while Claude was working arrive as queued_command attachments (text or blocks).
        let q = r#"{"type":"user","timestamp":"t1","message":{"content":"Fix the chat"}}
{"type":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"Looking."}]}}
{"type":"attachment","timestamp":"t3","attachment":{"type":"queued_command","prompt":"Also the composer","timestamp":"t3a"}}
{"type":"attachment","timestamp":"t4","attachment":{"type":"queued_command","prompt":[{"type":"text","text":"[Image #1] like this"},{"type":"image","source":{}}]}}
{"type":"attachment","timestamp":"t5","attachment":{"type":"hook_success","content":"noise"}}
{"type":"assistant","timestamp":"t6","message":{"content":[{"type":"text","text":"Got both."}]}}"#;
        let (m, _, _) = parse_transcript(q);
        let got: Vec<_> = m.iter().map(|x| (x.role, x.text.as_str(), x.at.as_str())).collect();
        assert_eq!(got, [("user", "Fix the chat", "t1"), ("assistant", "Looking.", "t2"), ("user", "Also the composer", "t3a"),
            ("user", "[Image #1] like this", "t4"), ("assistant", "Got both.", "t6")]);

        // With tools, the tool call splits the reply and shows as its own line.
        let (m, _, _) = parse_transcript_with(t, true);
        let roles: Vec<_> = m.iter().map(|x| x.role).collect();
        assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(m[2].text, "Bash");
    }

    #[test]
    fn delivery_sees_sent_and_queued_messages() {
        let mut t = String::from("{\"type\":\"user\",\"message\":{\"content\":\"old message\"}}\n");
        let after = t.lines().count();
        assert_eq!(delivery_in(&t, "old message", after), None, "only lines after the send count");
        t.push_str("{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"Extract   the models\\nplease\"}\n");
        assert_eq!(delivery_in(&t, "Extract the models\nplease", after), Some(Delivery::Queued));
        t.push_str("{\"type\":\"user\",\"message\":{\"content\":\"Extract the models\\nplease\"}}\n");
        assert_eq!(delivery_in(&t, "Extract the models please", after), Some(Delivery::Sent));
    }

    #[test]
    fn tool_lines_show_the_main_argument() {
        let b: Value = serde_json::from_str(r#"{"type":"tool_use","name":"Bash","input":{"command":"npm test\nnpm run build"}}"#).unwrap();
        assert_eq!(tool_line(&b), "Bash: npm test");
        let b: Value = serde_json::from_str(r#"{"type":"tool_use","name":"Read","input":{"file_path":"D:\\a.txt"}}"#).unwrap();
        assert_eq!(tool_line(&b), r"Read: D:\a.txt");
    }

    #[test]
    fn finds_a_real_transcript() {
        // Any transcript on this PC; skipped on a machine without Claude Code history.
        let Some(any) = std::fs::read_dir(projects_dir()).ok().and_then(|dirs| {
            dirs.filter_map(|d| std::fs::read_dir(d.ok()?.path()).ok()).flatten().find_map(|e| {
                let p = e.ok()?.path();
                (p.extension()? == "jsonl").then_some(p)
            })
        }) else { return };
        let id = any.file_stem().unwrap().to_string_lossy().to_string();
        assert_eq!(find_transcript(&id, r"D:\Projects").as_deref(), Some(any.as_path()));
        assert_eq!(find_transcript(&id, "").as_deref(), Some(any.as_path()));
        assert!(find_transcript("../../etc", "").is_none());
    }

    #[test]
    fn picks_the_hangar_link_from_args() {
        let a = vec!["hangar.exe".to_string(), "hangar://session/abc?item=1".to_string()];
        assert_eq!(url_from_args(&a).as_deref(), Some("hangar://session/abc?item=1"));
    }
}
