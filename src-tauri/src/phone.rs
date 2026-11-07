//! Phone access: a hidden `claude remote-control` server in one folder, so the Claude
//! phone app and claude.ai/code can start and drive sessions on this PC. Off until
//! switched on, and switched off when Hangar closes. Its pid lives in phone.json, so a
//! restarted Hangar still sees it and can turn it off.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Phone {
    running: bool,
    pid: u32,
    cwd: String,
    /// Epoch ms it was switched on.
    started: i64,
    /// claude.ai/code link to this PC's sessions, once the server has printed it.
    url: String,
}

fn state_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("phone.json"))
}

fn load(path: &Path) -> Phone {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(path: &Path, p: &Phone) {
    let _ = std::fs::write(path, serde_json::to_string_pretty(p).unwrap_or_default());
}

fn alive(pid: u32) -> bool {
    pid != 0 && crate::procs::list().iter().any(|p| p.pid == pid && p.name.eq_ignore_ascii_case("claude.exe"))
}

/// The file's record, with `running` checked against the live process list.
fn current(path: &Path) -> Phone {
    let mut p = load(path);
    p.running = alive(p.pid);
    p
}

/// Drops terminal escape codes (colors, cursor moves, OSC 8 links) from server output.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.next() {
            // CSI: ESC [ ... final byte in @..~
            Some('[') => {
                for c in it.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC \
            Some(']') => {
                while let Some(c) = it.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && it.peek() == Some(&'\\') {
                        it.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The "open this PC's sessions" link the server prints once it is connected.
fn find_url(text: &str) -> Option<String> {
    let at = text.find("https://claude.ai/code?environment=")?;
    Some(text[at..].split(|c: char| c.is_whitespace()).next()?.to_string())
}

#[tauri::command]
pub async fn phone_status(app: tauri::AppHandle) -> Result<Phone, String> {
    let path = state_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || Ok(current(&path))).await.map_err(|e| e.to_string())?
}

/// Switches phone access on in `cwd`. Waits until the server is connected (or fails).
#[tauri::command]
pub async fn phone_start(app: tauri::AppHandle, cwd: String) -> Result<Phone, String> {
    let path = state_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || start_blocking(&path, &cwd)).await.map_err(|e| e.to_string())?
}

fn start_blocking(path: &Path, cwd: &str) -> Result<Phone, String> {
    let now = current(path);
    if now.running {
        return Ok(now);
    }
    if !Path::new(cwd).is_dir() {
        return Err(format!("Folder not found: {cwd}"));
    }
    let mut c = Command::new("claude");
    c.current_dir(cwd)
        .args(["remote-control", "--name", "Hangar"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let mut child = c.spawn().map_err(|e| format!("Couldn't run claude: {e}"))?;
    let rec = Phone { running: true, pid: child.id(), cwd: cwd.to_string(), started: now_ms(), url: String::new() };
    save(path, &rec);

    // Both streams go into one buffer: the link shows up on stdout, errors on stderr.
    let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let seen = seen.clone();
        let (path, pid) = (path.to_path_buf(), rec.pid);
        std::thread::spawn(move || {
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut s = seen.lock().unwrap();
                s.push_str(&strip_ansi(&String::from_utf8_lossy(&buf[..n])));
                let excess = s.len().saturating_sub(16 * 1024);
                if excess > 0 {
                    let cut = (excess..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
                    s.drain(..cut);
                }
                // Keep reading after the link (the pipe must drain), but record it once.
                if let Some(url) = find_url(&s) {
                    let mut p = load(&path);
                    if p.pid == pid && p.url != url {
                        p.url = url;
                        save(&path, &p);
                    }
                }
            }
        });
    }

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let text = seen.lock().unwrap().trim().to_string();
            let mut p = load(path);
            p.running = false;
            save(path, &p);
            let tail: String = text.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" / ");
            return Err(if tail.is_empty() { format!("Phone access stopped right away ({status}).") } else { format!("Phone access stopped right away: {tail}") });
        }
        let p = load(path);
        if !p.url.is_empty() || Instant::now() > deadline {
            // Still connecting after 30 s is fine: it keeps going, and status picks up the link.
            return Ok(Phone { running: true, ..p });
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Switches phone access off: ends the server and the sessions it started (their
/// conversations are kept, like closing a terminal).
#[tauri::command]
pub async fn phone_stop(app: tauri::AppHandle) -> Result<Phone, String> {
    let path = state_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || stop_blocking(&path)).await.map_err(|e| e.to_string())?
}

fn stop_blocking(path: &Path) -> Result<Phone, String> {
    let mut p = load(path);
    if alive(p.pid) {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &p.pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.output();
        if alive(p.pid) {
            return Err("Couldn't stop phone access. It is still running.".into());
        }
    }
    p.running = false;
    p.url.clear();
    save(path, &p);
    Ok(p)
}

/// Hangar is closing: phone access goes off with it.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Ok(path) = state_file(app) {
        let _ = stop_blocking(&path);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_link_through_terminal_codes() {
        let raw = "\x1b[1A\x1b[J· Connected · Claude · HEAD\n    \x1b]8;;https://claude.ai/code/session_01M?from=cli\x07Hangar\x1b]8;;\x07\n\nContinue coding in the Claude mobile app or https://claude.ai/code?environment=env_014ox\nspace to show QR code";
        let clean = strip_ansi(raw);
        assert!(clean.contains("Connected") && clean.contains("    Hangar\n") && !clean.contains('\x1b'));
        assert_eq!(find_url(&clean).as_deref(), Some("https://claude.ai/code?environment=env_014ox"));
        assert_eq!(find_url("Connecting"), None);
    }

    #[test]
    fn a_dead_pid_is_not_running() {
        let tmp = std::env::temp_dir().join(format!("hangar-phone-test-{}.json", std::process::id()));
        save(&tmp, &Phone { running: true, pid: 0, cwd: "D:\\Projects".into(), started: 1, url: "x".into() });
        assert!(!current(&tmp).running);
        let p = stop_blocking(&tmp).unwrap();
        assert!(!p.running && p.url.is_empty() && p.cwd == "D:\\Projects");
        let _ = std::fs::remove_file(&tmp);
    }

    /// Switches real phone access on in your home folder for a moment, then off again.
    /// `cargo test live_phone -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_phone() {
        let tmp = std::env::temp_dir().join(format!("hangar-phone-live-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let home = std::env::var("USERPROFILE").unwrap();
        let p = start_blocking(&tmp, &home).unwrap();
        eprintln!("on: {p:?}");
        assert!(p.running && alive(p.pid));
        assert!(p.url.starts_with("https://claude.ai/code?environment="), "link read");
        assert!(start_blocking(&tmp, &home).unwrap().pid == p.pid, "a second start reuses it");
        let off = stop_blocking(&tmp).unwrap();
        assert!(!off.running && !alive(p.pid));
        let _ = std::fs::remove_file(&tmp);
    }
}
