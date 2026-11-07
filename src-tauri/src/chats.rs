//! Chats: every Claude Code session on this PC (background jobs and interactive
//! terminals), from `claude agents --json --all`, with each job's last status
//! line from ~/.claude/jobs/<id>/state.json. Stop keeps the conversation.
//! Send types a message into a session through a hidden `claude attach`, so the chat
//! window works like a chat while the session stays a normal one VS Code can open.
//! Done archives a finished chat's files into ~/.claude/chat-archive (never deletes).

use crate::sessions;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct ChatSession {
    pub(crate) id: String,
    session_id: String,
    name: String,
    pub(crate) cwd: String,
    /// background | interactive
    pub(crate) kind: String,
    /// busy | idle | shell ... (live process status)
    status: String,
    /// working | done | blocked | failed ...
    state: String,
    /// The session's last one-line status, when it is a job.
    detail: String,
    /// Milliseconds since epoch of the last update (or start).
    updated: i64,
    running: bool,
}

/// The Claude Code program. Hangar needs `claude.exe` on PATH (Claude Code's native installer);
/// an npm install's `claude.cmd` can't be started directly.
pub(crate) fn claude_cmd() -> Command {
    let mut c = Command::new("claude");
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// How chats Hangar starts treat Claude's permission prompts. "default" = Claude Code's normal
/// prompts (answer them in the chat's Terminal); "acceptEdits" and "bypassPermissions" are opt-in
/// from Settings. Kept in the app data folder so the phone page uses the same choice.
const MODES: [&str; 3] = ["default", "acceptEdits", "bypassPermissions"];

fn mode_file() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("app.hangar.desktop").join("chat-settings.json")
}

pub fn permission_mode() -> String {
    std::fs::read_to_string(mode_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["permission_mode"].as_str().map(String::from))
        .filter(|m| MODES.contains(&m.as_str()))
        .unwrap_or_else(|| "default".into())
}

/// The `--permission-mode` flags for a new chat (none for Claude's default).
fn mode_flags() -> Vec<String> {
    let m = permission_mode();
    if m == "default" {
        vec![]
    } else {
        vec!["--permission-mode".into(), m]
    }
}

#[tauri::command]
pub fn chat_mode_get() -> String {
    permission_mode()
}

#[tauri::command]
pub fn chat_mode_set(mode: String) -> Result<String, String> {
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("Unknown permission mode: {mode}"));
    }
    let f = mode_file();
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&f, serde_json::to_string(&serde_json::json!({ "permission_mode": mode })).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(mode)
}

fn jobs_dir() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude").join("jobs")
}

fn ms(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => parse_iso_ms(s).unwrap_or(0),
        _ => 0,
    }
}

/// "2026-10-19T06:54:12.345Z" -> epoch ms (UTC). Enough for sorting and "5 min ago".
fn parse_iso_ms(s: &str) -> Option<i64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let time = time.split(['+']).next()?;
    let mut t = time.split(':');
    let (hh, mm) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let ss: f64 = t.next().unwrap_or("0").parse().ok()?;
    // Days from civil (Howard Hinnant).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hh * 3600 + mm * 60) as f64 * 1000.0 + ss * 1000.0) as i64)
}

fn job_state(id: &str) -> Option<Value> {
    let text = std::fs::read_to_string(jobs_dir().join(id).join("state.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Helper processes that keep pre-warmed Claude clients in a temp folder show up as idle
/// sessions; they aren't chats. Name the folder in HANGAR_HIDE_CWD (part of the path) to hide them.
fn is_clutter(a: &Value) -> bool {
    let Ok(hide) = std::env::var("HANGAR_HIDE_CWD") else { return false };
    let hide = hide.trim().to_ascii_lowercase();
    !hide.is_empty() && a["cwd"].as_str().is_some_and(|c| c.to_ascii_lowercase().contains(&hide))
}

fn build(list: Vec<Value>) -> Vec<ChatSession> {
    let mut out: Vec<ChatSession> = list
        .into_iter()
        .filter(|a| !is_clutter(a))
        .filter_map(|a| {
            let id = a["id"].as_str()?.to_string();
            let job = job_state(&id);
            let pick = |k: &str| -> String {
                a[k].as_str()
                    .or_else(|| job.as_ref().and_then(|j| j[k].as_str()))
                    .unwrap_or("")
                    .to_string()
            };
            let updated = job.as_ref().map(|j| ms(&j["updatedAt"])).filter(|v| *v > 0).unwrap_or_else(|| ms(&a["startedAt"]));
            Some(ChatSession {
                session_id: pick("sessionId"),
                name: pick("name"),
                cwd: pick("cwd"),
                kind: pick("kind"),
                status: a["status"].as_str().unwrap_or("").to_string(),
                state: pick("state"),
                detail: job.as_ref().and_then(|j| j["detail"].as_str()).unwrap_or("").chars().take(300).collect(),
                running: a["pid"].as_i64().is_some(),
                updated,
                id,
            })
        })
        .collect();
    out.sort_by(|a, b| b.running.cmp(&a.running).then(b.updated.cmp(&a.updated)));
    out
}

/// Live and recent sessions. `all` adds finished background sessions.
#[tauri::command]
pub async fn chats_list(all: bool) -> Result<Vec<ChatSession>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(build(agents_json(all)?)))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn agents_json(all: bool) -> Result<Vec<Value>, String> {
    let mut c = claude_cmd();
    c.args(["agents", "--json"]);
    if all {
        c.arg("--all");
    }
    let out = c.output().map_err(|e| format!("Couldn't run claude ({e}). Hangar needs Claude Code installed with its native installer, so claude.exe is on PATH."))?;
    let v: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| format!("claude agents gave no list: {}", String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()))?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

/// `claude --bg` prints the new session's id; take the first id-looking token.
fn bg_id(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric()))
        .find(|w| w.len() == 8 && w.chars().all(|c| c.is_ascii_hexdigit()))
        .map(String::from)
}

pub(crate) fn valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Stops a background session; its conversation is kept (attach or --resume brings it back).
#[tauri::command]
pub async fn chats_stop(id: String) -> Result<(), String> {
    if !valid(&id) {
        return Err("Not a session id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = claude_cmd().args(["stop", &id]).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn archive_root() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".claude").join("chat-archive")
}

/// Epoch ms -> "2026-10-19" (UTC), for archive folder names.
fn ymd(ms: i64) -> String {
    // Civil from days (Howard Hinnant), the inverse of parse_iso_ms.
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Moves `from` to `to`, retrying briefly: a session that was just stopped can still
/// hold its files open for a moment.
fn move_retry(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..10 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!("Couldn't move {}: {last}", from.display()))
}

/// Moves a chat's files into a new folder under `root` with an info.json saying where
/// each came from, so it can be put back by hand. Returns the folder, or None when
/// there was nothing on disk to move.
fn archive_files(root: &std::path::Path, id: &str, info: Value, files: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    let files: Vec<&PathBuf> = files.iter().filter(|p| p.exists()).collect();
    if files.is_empty() {
        return Ok(None);
    }
    let base = format!("{}_{id}", ymd(now_ms()));
    let mut dest = root.join(&base);
    let mut n = 2;
    while dest.exists() {
        dest = root.join(format!("{base}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut moved = Vec::new();
    let mut failed = None;
    for from in files {
        let to = dest.join(from.file_name().unwrap_or_default());
        match move_retry(from, &to) {
            Ok(()) => moved.push(json!({"from": from.display().to_string(), "to": to.display().to_string()})),
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }
    let mut info = info;
    info["archived_at"] = json!(now_ms());
    info["moved"] = json!(moved);
    let _ = std::fs::write(dest.join("info.json"), serde_json::to_string_pretty(&info).unwrap_or_default());
    match failed {
        Some(e) => Err(format!("{e}. What did move is in {}", dest.display())),
        None => Ok(Some(dest)),
    }
}

/// Done with a chat: stops it if it is running, then moves its job folder and transcript
/// into ~/.claude/chat-archive. Nothing is deleted (never `claude rm`, which is permanent).
/// Returns the archive folder, or "" when nothing was left on disk.
#[tauri::command]
pub async fn chats_done(id: String, session_id: String, cwd: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || done_blocking(&id, &session_id, &cwd, &name))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn done_blocking(id: &str, session_id: &str, cwd: &str, name: &str) -> Result<String, String> {
    if !valid(id) || (!session_id.is_empty() && !valid(session_id)) {
        return Err("Not a session id".into());
    }
    if !session_id.is_empty() && live_entry(session_id)?.is_some() {
        let out = claude_cmd().args(["stop", id]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect());
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        while live_entry(session_id)?.is_some() {
            if Instant::now() > deadline {
                return Err("Stopped it, but it is still running after 20 seconds. Try Done again in a moment.".into());
            }
            std::thread::sleep(Duration::from_millis(800));
        }
    }
    let mut files = vec![jobs_dir().join(id)];
    if let Some(t) = sessions::find_transcript(session_id, cwd) {
        // Subagent and tool-output files sit in a folder named after the session, next to it.
        files.push(t.with_extension(""));
        files.push(t);
    }
    let info = json!({"id": id, "session_id": session_id, "name": name, "cwd": cwd});
    Ok(archive_files(&archive_root(), id, info, &files)?.map(|p| p.display().to_string()).unwrap_or_default())
}

/// Starts a new background session in `cwd` and returns its id.
#[tauri::command]
pub async fn chats_new(cwd: String, name: String, prompt: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = if std::path::Path::new(&cwd).is_dir() { cwd } else { std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()) };
        let mut c = claude_cmd();
        c.current_dir(&dir).arg("--bg").args(mode_flags());
        if !name.trim().is_empty() {
            c.args(["-n", name.trim()]);
        }
        if !prompt.trim().is_empty() {
            c.arg(prompt.trim());
        }
        let out = c.output().map_err(|e| format!("Couldn't run claude ({e}). Hangar needs Claude Code installed with its native installer, so claude.exe is on PATH."))?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect());
        }
        bg_id(&text).ok_or_else(|| format!("Started, but couldn't read its id: {}", text.chars().take(200).collect::<String>()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug)]
pub struct Sent {
    /// The session the message went to. Differs from the one asked for when Claude Code
    /// had already forgotten that job and the chat continued as a new session.
    id: String,
    session_id: String,
    /// Claude was mid-task, so the message sits in Claude Code's queue until the current step ends.
    queued: bool,
}

/// Sends `text` as your next message in a background session, live or finished.
#[tauri::command]
pub async fn chats_send(id: String, session_id: String, cwd: String, name: String, text: String) -> Result<Sent, String> {
    tauri::async_runtime::spawn_blocking(move || send_blocking(&id, &session_id, &cwd, &name, &text))
        .await
        .map_err(|e| e.to_string())?
}

pub fn send_blocking(id: &str, session_id: &str, cwd: &str, name: &str, text: &str) -> Result<Sent, String> {
    if !valid(id) || !valid(session_id) {
        return Err("Not a session id".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("Nothing to send".into());
    }
    let dir = if std::path::Path::new(cwd).is_dir() { cwd.to_string() } else { std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()) };
    // A job Claude Code still knows reopens in place with `claude attach`, same session id.
    let job = job_state(id);
    if job.is_some() {
        match send_attached(id, session_id, &dir, text)? {
            Attached::Taken { queued } => return Ok(Sent { id: id.into(), session_id: session_id.into(), queued }),
            // Killed mid-start, e.g. by a PC restart: Claude Code won't start that job again
            // ("Session … can't start — exit 66 before init"). Continue it as a new one.
            Attached::CantStart => {}
        }
    }
    // Claude Code has pruned the job or can't start it: continue the conversation as a new
    // background session, with the flags it was running under when there are any.
    let mut c = claude_cmd();
    c.current_dir(&dir).args(["--bg", "--resume", session_id]).args(resume_flags(job.as_ref()));
    if !name.trim().is_empty() {
        c.args(["-n", name.trim()]);
    }
    let out = c.arg(text).output().map_err(|e| format!("Couldn't run claude ({e}). Hangar needs Claude Code installed with its native installer, so claude.exe is on PATH."))?;
    let printed = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect());
    }
    let new_id = bg_id(&printed).ok_or("Continued, but couldn't read the new session's id")?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let new_sid = loop {
        let found = agents_json(false)?.into_iter().find(|a| a["id"].as_str() == Some(new_id.as_str()));
        if let Some(sid) = found.and_then(|a| a["sessionId"].as_str().map(String::from)) {
            break sid;
        }
        if Instant::now() > deadline {
            return Err("Continued, but the new session didn't show up in the list".into());
        }
        std::thread::sleep(Duration::from_millis(800));
    };
    if job.is_some() {
        // The dead job would sit in the list next to its continuation and fail every send;
        // archive its folder (moved, not deleted). Its transcript stays where it is.
        let info = json!({"id": id, "session_id": session_id, "name": name, "cwd": cwd, "continued_as": new_id});
        if let Err(e) = archive_files(&archive_root(), id, info, &[jobs_dir().join(id)]) {
            eprintln!("chats_send: continued as {new_id}, but couldn't archive dead job {id}: {e}");
        }
    }
    Ok(Sent { id: new_id, session_id: new_sid, queued: false })
}

/// The job's own launch flags (agent, model, permission mode) from state.json, so a chat
/// continued as a new session runs the way it did. Without them: the permission mode set in Settings.
fn resume_flags(job: Option<&Value>) -> Vec<String> {
    let flags: Vec<String> = job
        .and_then(|j| j["respawnFlags"].as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if flags.is_empty() {
        mode_flags()
    } else {
        flags
    }
}

/// What `claude attach` prints when the daemon refuses to start a job again.
fn cant_start(screen: &str) -> bool {
    screen.contains("can't start") || screen.contains("can\u{2019}t start")
}

#[derive(Debug)]
enum Attached {
    /// The session took the message; `queued` when Claude was mid-task.
    Taken { queued: bool },
    /// Claude Code won't start this job any more.
    CantStart,
}

/// The session's live entry in `claude agents`, if it is running.
pub(crate) fn live_entry(session_id: &str) -> Result<Option<Value>, String> {
    Ok(agents_json(false)?.into_iter().find(|a| a["sessionId"].as_str() == Some(session_id) && a["pid"].is_number()))
}

/// A dialog (permission prompt or question) is open, so typed text would land in it.
/// Only `status: "waiting"` means that: Claude Code sets it when an elicitation is queued.
/// `state: "blocked"` is the job summary's "needs your input", set after any reply that ends
/// by asking you for something; the prompt is idle then and a plain message is the answer.
/// Treating "blocked" as a dialog refused every reply to such a turn, phone included.
fn asking_you(a: &Value) -> bool {
    a["status"].as_str() == Some("waiting")
}

/// Why a message wasn't sent while a dialog is open. The phone page spots it and offers its Terminal.
pub const DIALOG_OPEN: &str = "Claude is waiting on a question. Answer it in the Terminal tab.";

/// Types `text` into the session through a hidden `claude attach`, then lets go. Like typing in
/// the terminal: if Claude is mid-task, Claude Code queues the message and reads it after the
/// current step. Says whether it went into that queue, or that the job can't be started.
fn send_attached(id: &str, session_id: &str, dir: &str, text: &str) -> Result<Attached, String> {
    if let Some(a) = live_entry(session_id)? {
        if asking_you(&a) {
            return Err(DIALOG_OPEN.into());
        }
    }
    let after = sessions::transcript_lines(session_id, dir);
    // A terminal in Hangar (desktop or phone) already holds the session: a second attach would
    // kick it ("Session opened in another window"), so type into that one instead.
    if crate::pty::claude_open(id) {
        return send_through_terminal(id, session_id, dir, text, after);
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows: 40, cols: 160, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new("claude");
    cmd.args(["attach", id]);
    cmd.cwd(dir);
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't open the session: {e}"))?;
    drop(pair.slave);
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let screen = Arc::new(Mutex::new(Vec::<u8>::new()));
    let last_output = Arc::new(Mutex::new(Instant::now()));
    // The console must be read or the attach client stalls. It also asks where the cursor
    // is (ESC[6n) and holds back input until it hears back; xterm.js answers that for the
    // visible terminals, so the hidden one answers it here. Only the first time: the console
    // asks again a moment later, and a second answer was read as typing. It left a stray "C" in
    // the message box, so every message sent to a session that had to wake up began with "C"
    // (live_send_after_stop checks it).
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let (w2, s2, l2) = (writer.clone(), screen.clone(), last_output.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut answered = false;
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            *l2.lock().unwrap() = Instant::now();
            let mut s = s2.lock().unwrap();
            let from = s.len().saturating_sub(4);
            s.extend_from_slice(&buf[..n]);
            if !answered && s[from..].windows(4).any(|w| w == b"\x1b[6n") {
                answered = true;
                let mut w = w2.lock().unwrap();
                let _ = w.write_all(b"\x1b[1;1R").and_then(|_| w.flush());
            }
            let excess = s.len().saturating_sub(32 * 1024);
            s.drain(..excess);
        }
    });
    let type_in = |bytes: &[u8]| -> Result<(), String> {
        let mut w = writer.lock().unwrap();
        w.write_all(bytes).and_then(|_| w.flush()).map_err(|e| e.to_string())
    };

    // Waits until the screen has been still for `quiet` (the attach client finished drawing).
    let settle = |quiet: Duration, max: Duration| {
        let t0 = Instant::now();
        while t0.elapsed() < max && last_output.lock().unwrap().elapsed() < quiet {
            std::thread::sleep(Duration::from_millis(50));
        }
    };

    let result = (|| {
        // A stopped session restarts on attach; the replayed screen looks ready before it
        // takes input, so wait until Claude Code itself reports it running.
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if let Some(a) = live_entry(session_id)? {
                if asking_you(&a) {
                    return Err(DIALOG_OPEN.to_string());
                }
                if matches!(a["status"].as_str(), Some("idle" | "busy")) {
                    break;
                }
            }
            if matches!(child.try_wait(), Ok(Some(_))) {
                // The reader thread may still be draining the client's last words.
                std::thread::sleep(Duration::from_millis(300));
                if cant_start(&String::from_utf8_lossy(&screen.lock().unwrap())) {
                    return Ok(Attached::CantStart);
                }
                return Err("The session closed before it could take the message.".to_string());
            }
            if Instant::now() > deadline {
                return Err("The session wasn't ready within 90 seconds.".to_string());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        std::thread::sleep(Duration::from_millis(1200));
        settle(Duration::from_millis(700), Duration::from_secs(8));
        // Bracketed paste keeps line breaks inside the message instead of sending early.
        type_in(format!("\x1b[200~{text}\x1b[201~").as_bytes())?;
        // Enter only once the box has finished taking the paste; a long one takes a moment.
        std::thread::sleep(Duration::from_millis(300));
        settle(Duration::from_millis(400), Duration::from_secs(5));
        type_in(b"\r")?;
        let t0 = Instant::now();
        let mut retried = false;
        loop {
            if let Some(d) = sessions::delivery(session_id, dir, text, after) {
                return Ok(Attached::Taken { queued: d == sessions::Delivery::Queued });
            }
            // The Enter can land while the box is still redrawing: press it once more.
            if !retried && t0.elapsed() > Duration::from_secs(6) {
                retried = true;
                type_in(b"\r")?;
            }
            if t0.elapsed() > Duration::from_secs(25) {
                return Err("Typed it, but Claude hasn't taken it yet. It may be sitting in the message box: check the Terminal tab.".to_string());
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    })();
    if result.is_err() {
        // What the hidden terminal last showed, for the log.
        let tail = String::from_utf8_lossy(&screen.lock().unwrap()).chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect::<String>();
        eprintln!("chats_send: {:?}\n--- screen tail ---\n{}", result, tail.escape_debug());
    }
    // Closing the attach client only detaches; the session keeps running.
    let _ = child.kill();
    result
}

/// `send_attached` for a session a Hangar terminal already shows: same paste, Enter and check.
fn send_through_terminal(id: &str, session_id: &str, dir: &str, text: &str, after: usize) -> Result<Attached, String> {
    let settle = |quiet: Duration, max: Duration| {
        let t0 = Instant::now();
        while t0.elapsed() < max && crate::pty::quiet_for(id).is_some_and(|q| q < quiet) {
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    crate::pty::type_into(id, format!("\x1b[200~{text}\x1b[201~").as_bytes())?;
    std::thread::sleep(Duration::from_millis(300));
    settle(Duration::from_millis(400), Duration::from_secs(5));
    crate::pty::type_into(id, b"\r")?;
    let t0 = Instant::now();
    let mut retried = false;
    loop {
        if let Some(d) = sessions::delivery(session_id, dir, text, after) {
            return Ok(Attached::Taken { queued: d == sessions::Delivery::Queued });
        }
        if !retried && t0.elapsed() > Duration::from_secs(6) {
            retried = true;
            crate::pty::type_into(id, b"\r")?;
        }
        if t0.elapsed() > Duration::from_secs(25) {
            return Err("Typed it, but Claude hasn't taken it yet. It may be sitting in the message box: check the Terminal tab.".to_string());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// Opens the session in Windows Terminal instead of inside Hangar.
#[tauri::command]
pub fn chats_open_external(id: String, title: String) -> Result<(), String> {
    if !valid(&id) {
        return Err("Not a session id".into());
    }
    let tab = format!("Claude: {}", title.chars().take(40).collect::<String>());
    Command::new("wt.exe")
        .args(["-w", "0", "new-tab", "--title", &tab, "claude", "attach", &id])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_an_open_dialog_refuses_a_message() {
        // A reply that ended by asking something: idle prompt, message should go through.
        assert!(!asking_you(&json!({"state": "blocked", "status": "idle"})));
        assert!(!asking_you(&json!({"state": "working", "status": "busy"})));
        // A permission prompt or question dialog is open.
        assert!(asking_you(&json!({"state": "blocked", "status": "waiting"})));
        assert!(asking_you(&json!({"status": "waiting"})));
    }

    #[test]
    fn parses_iso_times() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-19T06:54:00.000Z"), Some(1_792_392_840_000));
    }

    #[test]
    fn reads_bg_ids() {
        assert_eq!(bg_id("backgrounded · 0850ae0d · hangar-bgtest\n  claude agents").as_deref(), Some("0850ae0d"));
        assert_eq!(bg_id("nothing here"), None);
        let rows = build(vec![json!({"id": "cccc3333", "name": "real", "kind": "background", "cwd": r"D:\Projects"})]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "real");
    }

    #[test]
    fn spots_jobs_that_cant_start_and_keeps_their_flags() {
        assert!(cant_start("\x1b[2KSession 136a569c can't start \u{2014} exit 66 before init\r\n"));
        assert!(cant_start("Session 136a569c can\u{2019}t start"));
        assert!(!cant_start("Session 136a569c ready"));
        let job = json!({"respawnFlags": ["--agent", "claude", "--permission-mode", "bypassPermissions", "--model", "opus"]});
        assert_eq!(resume_flags(Some(&job)), ["--agent", "claude", "--permission-mode", "bypassPermissions", "--model", "opus"]);
        assert_eq!(resume_flags(Some(&json!({}))), mode_flags());
        assert_eq!(resume_flags(None), mode_flags());
        assert!(MODES.contains(&permission_mode().as_str()));
    }

    /// Live tests run real Claude sessions in this folder: HANGAR_LIVE_DIR, else a temp folder.
    fn live_dir() -> String {
        std::env::var("HANGAR_LIVE_DIR").unwrap_or_else(|_| {
            let d = std::env::temp_dir().join("hangar-bgtest");
            let _ = std::fs::create_dir_all(&d);
            d.display().to_string()
        })
    }

    /// Waits up to 3 minutes for a Claude reply containing `want`.
    fn reply(sid: &str, want: &str) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(180) {
            let text = sessions::find_transcript(sid, &live_dir()).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
            if sessions::parse_transcript(&text).0.iter().any(|m| m.role == "assistant" && m.text.contains(want)) {
                return true;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        false
    }

    /// Starts a background chat and returns (id, session id).
    fn start_chat(name: &str, prompt: &str) -> (String, String) {
        std::fs::create_dir_all(&live_dir()).unwrap();
        let out = claude_cmd()
            .current_dir(&live_dir())
            .args(["--bg", "--permission-mode", "bypassPermissions", "-n", name, prompt])
            .output()
            .unwrap();
        let id = bg_id(&String::from_utf8_lossy(&out.stdout)).expect("bg id");
        let sid = agents_json(false).unwrap().into_iter().find(|a| a["id"].as_str() == Some(id.as_str())).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        (id, sid)
    }

    /// Talks to real Claude sessions (a few small turns on your Claude plan):
    /// `cargo test live_send -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_send() {
        let dir = &live_dir();
        let (id, sid) = start_chat("hangar-send-test", "Hangar send test. Reply with exactly: ONE-11");
        assert!(reply(&sid, "ONE-11"), "first reply");

        let s = send_blocking(&id, &sid, dir, "hangar-send-test", "Typed by Hangar into a live session.\nReply with exactly: TWO-22").unwrap();
        assert_eq!(s.session_id, sid);
        assert!(reply(&sid, "TWO-22"), "reply in the live session");

        claude_cmd().args(["stop", &id]).output().unwrap();
        let s = send_blocking(&id, &sid, dir, "hangar-send-test", "Sent after a stop. Reply with exactly: THREE-33").unwrap();
        assert_eq!(s.session_id, sid, "a stopped chat reopens as the same session");
        assert!(reply(&sid, "THREE-33"), "reply after reopening");
        claude_cmd().args(["stop", &id]).output().unwrap();
    }

    /// A job Claude Code can't start (killed by a PC restart) continues as a new session and
    /// its dead folder moves to the archive. Needs a real such job, since a crash can't be staged:
    /// `HANGAR_DEAD_JOB=<id> cargo test live_send_to_dead_job -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_send_to_dead_job() {
        let Ok(id) = std::env::var("HANGAR_DEAD_JOB") else { return };
        let job = job_state(&id).expect("dead job's state.json");
        let (sid, cwd) = (job["sessionId"].as_str().unwrap().to_string(), job["cwd"].as_str().unwrap().to_string());
        let s = send_blocking(&id, &sid, &cwd, "", "Hangar revive test after a PC restart. Change nothing; reply with exactly: REVIVED-77").unwrap();
        assert_ne!(s.id, id, "continued as a new session");
        assert!(!jobs_dir().join(&id).exists(), "dead job folder archived");
        let t0 = Instant::now();
        let ok = loop {
            let text = sessions::find_transcript(&s.session_id, &cwd).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
            if sessions::parse_transcript(&text).0.iter().any(|m| m.role == "assistant" && m.text.contains("REVIVED-77")) {
                break true;
            }
            if t0.elapsed() > Duration::from_secs(180) {
                break false;
            }
            std::thread::sleep(Duration::from_secs(2));
        };
        assert!(ok, "reply from the continued session {}", s.id);
        println!("continued {id} as {}", s.id);
    }

    /// A session woken up by the send gets exactly the typed text (a stray "C" used to lead it).
    /// `cargo test live_send_after_stop -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_send_after_stop() {
        let (id, sid) = start_chat("hangar-wake-test", "Hangar wake test. Reply with exactly: ONE-11");
        assert!(reply(&sid, "ONE-11"), "first reply");
        claude_cmd().args(["stop", &id]).output().unwrap();
        let text = "Sent after a stop. Reply with exactly: THREE-33";
        send_blocking(&id, &sid, &live_dir(), "hangar-wake-test", text).unwrap();
        assert!(reply(&sid, "THREE-33"), "reply after waking");
        claude_cmd().args(["stop", &id]).output().unwrap();
        let t = sessions::find_transcript(&sid, &live_dir()).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        let users: Vec<_> = sessions::parse_transcript(&t).0.into_iter().filter(|m| m.role == "user").map(|m| m.text).collect();
        assert!(users.iter().any(|u| u == text), "sent text arrives exactly: {users:?}");
    }

    /// Two chats at once, each sent a message at the same moment: every chat has its
    /// own hidden attach, so they don't get in each other's way.
    /// `cargo test live_parallel -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_parallel() {
        let a = start_chat("hangar-parallel-a", "Parallel test A. Reply with exactly: A-1");
        let b = start_chat("hangar-parallel-b", "Parallel test B. Reply with exactly: B-1");
        assert!(reply(&a.1, "A-1") && reply(&b.1, "B-1"), "first replies");
        let t0 = Instant::now();
        let sends: Vec<_> = [(a.clone(), "A-2"), (b.clone(), "B-2")]
            .into_iter()
            .map(|((id, sid), code)| {
                std::thread::spawn(move || send_blocking(&id, &sid, &live_dir(), "", &format!("Sent in parallel. Reply with exactly: {code}")))
            })
            .collect();
        for s in sends {
            s.join().unwrap().unwrap();
        }
        assert!(reply(&a.1, "A-2"), "chat A answered");
        assert!(reply(&b.1, "B-2"), "chat B answered");
        assert!(!reply_contains(&a.1, "B-2") && !reply_contains(&b.1, "A-2"), "no cross-talk");
        eprintln!("both parallel sends answered in {:.1}s", t0.elapsed().as_secs_f32());
        for (id, _) in [a, b] {
            claude_cmd().args(["stop", &id]).output().unwrap();
        }
    }

    /// Typing ahead like in the terminal: long, multi-line messages sent while Claude is busy are
    /// queued by Claude Code and answered in order; one sent in the end-of-turn window and one
    /// sent to an idle session both go in too.
    /// `cargo test live_queue -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_queue() {
        let (id, sid) = start_chat("hangar-queue-test", "Hangar queue test. Use the Bash tool to run `sleep 40`, then reply with exactly A-DONE.");
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(60) && !reply_contains_tool(&sid) {
            std::thread::sleep(Duration::from_secs(1));
        }
        let long = |code: &str| {
            let filler = "This is a long message typed into Hangar while Claude works, the way you might dictate a follow-up. ".repeat(10);
            format!("Queued follow-up.\n\n{filler}\n\nSecond paragraph, still the same message.\nReply with exactly {code}.")
        };
        let s1 = send_blocking(&id, &sid, &live_dir(), "", &long("Q-1")).unwrap();
        eprintln!("long message while busy: queued={}", s1.queued);
        assert!(s1.queued, "Claude was mid-task, so the message should be queued");
        let s2 = send_blocking(&id, &sid, &live_dir(), "", "Second queued message. Reply with exactly Q-2.").unwrap();
        eprintln!("second message while busy: queued={}", s2.queued);
        assert!(reply(&sid, "A-DONE"), "first task finished");
        assert!(reply(&sid, "Q-1"), "long queued message answered");
        assert!(reply(&sid, "Q-2"), "second queued message answered");
        let order = transcript_text(&sid);
        assert!(order.find("Q-1").unwrap() < order.rfind("Q-2").unwrap(), "answered in order");

        // Right as a reply lands Claude is still wrapping up (hooks, recap): the window that used to lose input.
        let s3 = send_blocking(&id, &sid, &live_dir(), "", "Sent in the end-of-turn window. Reply with exactly Q-3.").unwrap();
        eprintln!("end-of-turn message: queued={}", s3.queued);
        assert!(reply(&sid, "Q-3"), "end-of-turn message answered");

        // A long message to an idle session.
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(60) && live_entry(&sid).unwrap().is_some_and(|a| a["status"] != "idle") {
            std::thread::sleep(Duration::from_secs(1));
        }
        let s4 = send_blocking(&id, &sid, &live_dir(), "", &long("L-4")).unwrap();
        eprintln!("long message while idle: queued={}", s4.queued);
        assert!(reply(&sid, "L-4"), "long message to an idle session answered");
        claude_cmd().args(["stop", &id]).output().unwrap();
    }

    fn transcript_text(sid: &str) -> String {
        let text = sessions::find_transcript(sid, &live_dir()).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        sessions::parse_transcript(&text).0.iter().filter(|m| m.role == "assistant").map(|m| m.text.clone()).collect::<Vec<_>>().join("\n")
    }

    fn reply_contains_tool(sid: &str) -> bool {
        sessions::find_transcript(sid, &live_dir()).and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|t| t.contains("\"tool_use\""))
    }

    fn reply_contains(sid: &str, want: &str) -> bool {
        let text = sessions::find_transcript(sid, &live_dir()).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        sessions::parse_transcript(&text).0.iter().any(|m| m.text.contains(want))
    }

    #[test]
    fn formats_archive_dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_792_392_840_000), "2026-10-19");
        assert_eq!(ymd(parse_iso_ms("2024-02-29T23:59:00Z").unwrap()), "2024-02-29");
    }

    #[test]
    fn archives_files_and_records_where_they_came_from() {
        let tmp = std::env::temp_dir().join(format!("hangar-archive-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let job = tmp.join("jobs").join("abcd1234");
        std::fs::create_dir_all(&job).unwrap();
        std::fs::write(job.join("state.json"), "{}").unwrap();
        let transcript = tmp.join("projects").join("sid-1.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, "{}\n").unwrap();
        let root = tmp.join("archive");
        let files = [job.clone(), transcript.with_extension(""), transcript.clone()];

        let dest = archive_files(&root, "abcd1234", json!({"name": "t"}), &files).unwrap().unwrap();
        assert!(!job.exists() && !transcript.exists(), "originals moved away");
        assert!(dest.join("abcd1234").join("state.json").is_file());
        assert!(dest.join("sid-1.jsonl").is_file());
        let info: Value = serde_json::from_str(&std::fs::read_to_string(dest.join("info.json")).unwrap()).unwrap();
        assert_eq!(info["name"], "t");
        assert_eq!(info["moved"].as_array().unwrap().len(), 2);

        // Nothing left to move: no folder.
        assert!(archive_files(&root, "abcd1234", json!({}), &files).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Done on a real running chat: it stops, leaves `claude agents --all`, and its files
    /// land in ~/.claude/chat-archive. `cargo test live_done -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_done() {
        let (id, sid) = start_chat("hangar-done-test", "Hangar Done test. Reply with exactly: DONE-1");
        assert!(reply(&sid, "DONE-1"), "first reply");
        let dest = done_blocking(&id, &sid, &live_dir(), "hangar-done-test").unwrap();
        assert!(!dest.is_empty(), "something was archived");
        let dest = PathBuf::from(dest);
        assert!(dest.join(&id).join("state.json").is_file(), "job folder archived");
        assert!(dest.join(format!("{sid}.jsonl")).is_file(), "transcript archived");
        assert!(sessions::find_transcript(&sid, &live_dir()).is_none());
        assert!(!agents_json(true).unwrap().iter().any(|a| a["id"].as_str() == Some(id.as_str())), "gone from claude agents --all");
        eprintln!("archived to {}", dest.display());
    }

    #[test]
    fn builds_rows_and_puts_running_first() {
        let rows = build(vec![
            json!({"id": "aaaa1111", "name": "old", "status": "idle", "state": "done", "startedAt": 5}),
            json!({"pid": 1, "id": "bbbb2222", "name": "live", "status": "busy", "state": "working", "startedAt": 1, "kind": "background"}),
        ]);
        assert_eq!(rows[0].name, "live");
        assert!(rows[0].running && !rows[1].running);
        assert!(valid("bbbb2222") && !valid("a b") && !valid(""));
    }
}
