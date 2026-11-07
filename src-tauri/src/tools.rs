//! Status checks, start, stop and focus for tools in the registry.

use crate::procs;
use crate::registry::{self, Tool};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Serialize, Clone)]
pub struct ToolStatus {
    pub id: String,
    pub running: bool,
    /// How the check was done: http | tcp | process | none
    pub via: &'static str,
    pub ms: u64,
}

fn host_of(tool: &Tool) -> String {
    tool.url
        .as_deref()
        .and_then(|u| u.split("://").nth(1))
        .and_then(|rest| rest.split(['/', ':']).next())
        .filter(|h| !h.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string()
}

async fn tcp_open(host: &str, port: u16) -> bool {
    let hosts: Vec<String> = if host == "localhost" {
        vec!["127.0.0.1".into(), "[::1]".into()]
    } else {
        vec![host.to_string()]
    };
    for h in hosts {
        let fut = tokio::net::TcpStream::connect(format!("{h}:{port}"));
        if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(600), fut).await {
            return true;
        }
    }
    false
}

async fn check(client: &reqwest::Client, tool: &Tool, procs_snapshot: &[procs::Proc]) -> ToolStatus {
    let t0 = Instant::now();
    let (running, via) = if let Some(port) = tool.port {
        let host = host_of(tool);
        match &tool.health {
            Some(path) if !path.is_empty() => {
                let url = format!("http://{host}:{port}{path}");
                let ok = client.get(&url).send().await.map(|r| r.status().as_u16() < 500).unwrap_or(false);
                (ok, "http")
            }
            _ => (tcp_open(&host, port).await, "tcp"),
        }
    } else if let Some(exe) = &tool.exe {
        (!procs::pids_for_exe_in(procs_snapshot, exe).is_empty(), "process")
    } else {
        (false, "none")
    };
    ToolStatus { id: tool.id.clone(), running, via, ms: t0.elapsed().as_millis() as u64 }
}

#[tauri::command]
pub async fn status_all() -> Result<Vec<ToolStatus>, String> {
    let reg = registry::load()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let snapshot = tokio::task::spawn_blocking(procs::list).await.map_err(|e| e.to_string())?;
    let checks = reg.tools.iter().map(|t| check(&client, t, &snapshot));
    Ok(futures_util::future::join_all(checks).await)
}

fn log_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("hangar"))
        .join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn quote(arg: &str) -> String {
    if arg.is_empty() || arg.contains([' ', '\t', '&', '(', ')', '^']) {
        format!("\"{arg}\"")
    } else {
        arg.to_string()
    }
}

#[cfg(windows)]
fn spawn_with_breakaway(mut build: impl FnMut() -> Command, flags: u32) -> std::io::Result<()> {
    // Breaking away from a job keeps the tool alive if whatever launched Hangar
    // closes its job. Some jobs forbid it, so fall back without the flag.
    match build().creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB).spawn() {
        Ok(_) => Ok(()),
        Err(_) => build().creation_flags(flags).spawn().map(|_| ()),
    }
}

#[cfg(not(windows))]
fn spawn_with_breakaway(mut build: impl FnMut() -> Command, _flags: u32) -> std::io::Result<()> {
    build().spawn().map(|_| ())
}

pub fn start_tool(app: &tauri::AppHandle, tool: &Tool) -> Result<(), String> {
    start_tool_in(&log_dir(app), tool)
}

/// Starts a tool, writing hidden tools' output to `<logs>/<id>.log`.
pub fn start_tool_in(logs: &Path, tool: &Tool) -> Result<(), String> {
    let _ = std::fs::create_dir_all(logs);
    let log_path = logs.join(format!("{}.log", tool.id));

    let (cmd, cwd, window): (Vec<String>, Option<String>, String) = match (&tool.start, &tool.exe) {
        (Some(s), _) => (s.cmd.clone(), s.cwd.clone(), s.window.clone()),
        (None, Some(exe)) => {
            let dir = Path::new(exe).parent().map(|p| p.display().to_string());
            (vec![exe.clone()], dir, "detached".into())
        }
        (None, None) => return Err(format!("{} has no start command", tool.name)),
    };
    if cmd.is_empty() {
        return Err(format!("{} has an empty start command", tool.name));
    }
    if let Some(dir) = &cwd {
        if !Path::new(dir).is_dir() {
            return Err(format!("Start folder not found: {dir}"));
        }
    }
    let strip = tool.env_strip_claude;
    let extra_env = tool.start.as_ref().map(|s| s.env.clone()).unwrap_or_default();

    let base = |program: &str| {
        let mut c = Command::new(program);
        if let Some(dir) = &cwd {
            c.current_dir(dir);
        }
        if strip {
            for (k, _) in std::env::vars() {
                let up = k.to_uppercase();
                if up.starts_with("CLAUDE") || up == "ANTHROPIC_API_KEY" {
                    c.env_remove(k);
                }
            }
        }
        for (k, v) in &extra_env {
            if k == "PATH_PREPEND" {
                let path = std::env::var("PATH").unwrap_or_default();
                c.env("PATH", format!("{v};{path}"));
            } else {
                c.env(k, v);
            }
        }
        c
    };

    let result = match window.as_str() {
        "console" => spawn_with_breakaway(
            || {
                let mut c = base(&cmd[0]);
                c.args(&cmd[1..]);
                c
            },
            CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP,
        ),
        "minimized" => {
            let line = cmd.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
            spawn_with_breakaway(
                || {
                    let mut c = base("cmd.exe");
                    #[cfg(windows)]
                    c.raw_arg(format!("/c start \"\" /min {line}"));
                    c
                },
                CREATE_NO_WINDOW,
            )
        }
        "detached" => spawn_with_breakaway(
            || {
                let mut c = base(&cmd[0]);
                c.args(&cmd[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                c
            },
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        ),
        _ => {
            let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
            let log2 = log.try_clone().map_err(|e| e.to_string())?;
            let mut slot = Some((log, log2));
            spawn_with_breakaway(
                || {
                    let mut c = base(&cmd[0]);
                    c.args(&cmd[1..]).stdin(Stdio::null());
                    match slot.take() {
                        Some((a, b)) => {
                            c.stdout(a).stderr(b);
                        }
                        None => {
                            // Retry path: reopen the log in append mode.
                            if let Ok(f) = std::fs::OpenOptions::new().append(true).open(&log_path) {
                                if let Ok(f2) = f.try_clone() {
                                    c.stdout(f).stderr(f2);
                                }
                            }
                        }
                    }
                    c
                },
                CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
            )
        }
    };
    result.map_err(|e| format!("Couldn't start {}: {e}", tool.name))
}

#[tauri::command]
pub async fn tool_start(app: tauri::AppHandle, id: String) -> Result<(), String> {
    start_by_id(&log_dir(&app), &id).await
}

/// How long a `restart_stuck` tool's app may run with its port closed (it may still be
/// starting) before Turn on treats it as stuck and restarts it.
const STUCK_GRACE: Duration = Duration::from_secs(8);
const STUCK_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, PartialEq)]
enum StartPlan {
    AlreadyUp,
    Start,
    /// The app runs (these pids) but its port never came up: kill it, then start.
    Restart(Vec<u32>),
}

/// The exe a tool is started with (first word of its start command, else `exe`).
fn start_exe(tool: &Tool) -> Option<String> {
    tool.start
        .as_ref()
        .and_then(|s| s.cmd.first().cloned())
        .or_else(|| tool.exe.clone())
}

/// Polls `open` until it says true or `grace` runs out.
async fn port_comes_up<F, Fut>(mut open: F, grace: Duration, poll: Duration) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + grace;
    loop {
        if open().await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(poll).await;
    }
}

/// Decides what Turn on does. `app_pids` = running processes of the tool's start exe.
async fn plan_start<F, Fut>(tool: &Tool, app_pids: Vec<u32>, mut open: F, grace: Duration, poll: Duration) -> StartPlan
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    if tool.port.is_none() {
        return StartPlan::Start;
    }
    if open().await {
        return StartPlan::AlreadyUp;
    }
    if !tool.restart_stuck || app_pids.is_empty() {
        return StartPlan::Start;
    }
    if port_comes_up(open, grace, poll).await {
        StartPlan::AlreadyUp
    } else {
        StartPlan::Restart(app_pids)
    }
}

fn kill_trees(pids: &[u32]) {
    for pid in pids {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.output();
    }
}

pub async fn start_by_id(logs: &Path, id: &str) -> Result<(), String> {
    let tool = registry::find(id)?;
    let app_pids = match (tool.restart_stuck, start_exe(&tool)) {
        (true, Some(exe)) => tokio::task::spawn_blocking(move || procs::pids_for_exe_in(&procs::list(), &exe))
            .await
            .map_err(|e| e.to_string())?,
        _ => Vec::new(),
    };
    let host = host_of(&tool);
    let port = tool.port.unwrap_or(0);
    match plan_start(&tool, app_pids, || tcp_open(&host, port), STUCK_GRACE, STUCK_POLL).await {
        StartPlan::AlreadyUp => Ok(()),
        StartPlan::Start => start_tool_in(logs, &tool),
        StartPlan::Restart(pids) => {
            tokio::task::spawn_blocking(move || kill_trees(&pids)).await.map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_millis(1500)).await; // let the old app let go of its tray icon and files
            start_tool_in(logs, &tool)
        }
    }
}

fn listening_pids(port: u16) -> Vec<u32> {
    let mut c = Command::new("netstat");
    c.args(["-ano"]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = c.output() else { return Vec::new() };
    parse_netstat(&String::from_utf8_lossy(&out.stdout), port)
}

fn parse_netstat(text: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut pids: Vec<u32> = text
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.len() == 5 && f[0] == "TCP" && f[3] == "LISTENING" && f[1].ends_with(&suffix))
                .then(|| f[4].parse().ok())
                .flatten()
        })
        .filter(|&p: &u32| p > 4 && p != std::process::id())
        .collect();
    pids.sort();
    pids.dedup();
    pids
}

/// Stops whatever listens on the tool's port. Tools marked not safe to stop
/// need `confirmed` (the UI asks first and shows the tool's note).
#[tauri::command]
pub async fn tool_stop(id: String, confirmed: Option<bool>) -> Result<u32, String> {
    let tool = registry::find(&id)?;
    if !tool.stoppable && !confirmed.unwrap_or(false) {
        return Err(format!("{} is marked as not safe to stop from Hangar", tool.name));
    }
    let port = tool.port.ok_or_else(|| format!("{} has no port to stop", tool.name))?;
    tokio::task::spawn_blocking(move || {
        let pids = listening_pids(port);
        for pid in &pids {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            #[cfg(windows)]
            c.creation_flags(CREATE_NO_WINDOW);
            let _ = c.output();
        }
        pids.len() as u32
    })
    .await
    .map_err(|e| e.to_string())
}

/// Brings a desktop app's window to the front, starting it first if it isn't running.
/// Returns "focused" or "started".
#[tauri::command]
pub async fn tool_focus(app: tauri::AppHandle, id: String) -> Result<&'static str, String> {
    let tool = registry::find(&id)?;
    let exe = tool.exe.clone().ok_or_else(|| format!("{} has no exe to focus", tool.name))?;
    let pids = tokio::task::spawn_blocking(move || procs::pids_for_exe_in(&procs::list(), &exe))
        .await
        .map_err(|e| e.to_string())?;
    if !pids.is_empty() && procs::focus(&pids) {
        return Ok("focused");
    }
    if !pids.is_empty() {
        return Ok("focused"); // running but windowless (tray); nothing more to do
    }
    start_tool(&app, &tool)?;
    Ok("started")
}

/// The page token for tools that need one (see `token_file`).
#[tauri::command]
pub fn tool_token(id: String) -> Result<Option<String>, String> {
    let tool = registry::find(&id)?;
    let Some(file) = tool.token_file else { return Ok(None) };
    let text = std::fs::read_to_string(&file).map_err(|e| format!("Couldn't read {file}: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["token"].as_str().map(String::from))
}

/// `<logs>/<id>.log`, for a tool id only (letters, digits, `-`, `_`), so the
/// name can never climb out of the logs folder (`..\..\x` is refused).
fn log_file(logs: &Path, id: &str) -> Option<PathBuf> {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then(|| logs.join(format!("{id}.log")))
}

#[tauri::command]
pub fn tool_log(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let path = log_file(&log_dir(&app), &id).ok_or_else(|| "Not a tool id".to_string())?;
    let text = std::fs::read(&path).map_err(|_| "Hangar hasn't started this tool yet, so there's no log".to_string())?;
    let text = String::from_utf8_lossy(&text);
    let lines: Vec<&str> = text.lines().collect();
    Ok(lines[lines.len().saturating_sub(300)..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_parse_picks_listeners_on_exact_port() {
        let text = "  TCP    127.0.0.1:5050    0.0.0.0:0    LISTENING    1234\n\
                    \x20 TCP    127.0.0.1:50500   0.0.0.0:0    LISTENING    999\n\
                    \x20 TCP    [::1]:5050        [::]:0       LISTENING    1234\n\
                    \x20 TCP    127.0.0.1:50000   127.0.0.1:5050 ESTABLISHED 77\n";
        assert_eq!(parse_netstat(text, 5050), vec![1234]);
    }

    #[test]
    fn log_file_stays_in_the_logs_folder() {
        let logs = Path::new("logs");
        assert_eq!(log_file(logs, "hangar-stt"), Some(logs.join("hangar-stt.log")));
        assert_eq!(log_file(logs, "my_tool2"), Some(logs.join("my_tool2.log")));
        for bad in ["", "..", "../x", r"..\..\Windows\x", "a/b", "C:x", "a.b", "a b", &"a".repeat(65)] {
            assert_eq!(log_file(logs, bad), None, "{bad}");
        }
    }

    #[test]
    fn host_defaults_to_loopback() {
        let t: Tool = serde_json::from_str(r#"{"id":"a","name":"A","theme":"ai","kind":"web","url":"http://localhost:7000/x"}"#).unwrap();
        assert_eq!(host_of(&t), "localhost");
        let t: Tool = serde_json::from_str(r#"{"id":"a","name":"A","theme":"ai","kind":"service","port":1}"#).unwrap();
        assert_eq!(host_of(&t), "127.0.0.1");
    }

    fn svc(restart_stuck: bool) -> Tool {
        let mut t: Tool = serde_json::from_str(
            r#"{"id":"ollama","name":"Ollama","theme":"ai","kind":"service","port":11434,
                "start":{"cmd":["C:\\Ollama\\ollama app.exe"]}}"#,
        )
        .unwrap();
        t.restart_stuck = restart_stuck;
        t
    }

    const G: Duration = Duration::from_millis(60);
    const P: Duration = Duration::from_millis(5);

    #[test]
    fn start_exe_is_first_word_of_start_command() {
        assert_eq!(start_exe(&svc(true)).as_deref(), Some("C:\\Ollama\\ollama app.exe"));
    }

    #[test]
    fn restart_stuck_round_trips_and_defaults_off() {
        let t: Tool = serde_json::from_str(r#"{"id":"a","name":"A","theme":"ai","kind":"service","restart_stuck":true}"#).unwrap();
        assert!(t.restart_stuck);
        assert!(serde_json::to_string(&t).unwrap().contains("\"restart_stuck\":true"));
        let t: Tool = serde_json::from_str(r#"{"id":"a","name":"A","theme":"ai","kind":"service"}"#).unwrap();
        assert!(!t.restart_stuck);
        assert!(!serde_json::to_string(&t).unwrap().contains("restart_stuck"));
    }

    #[tokio::test]
    async fn port_up_means_nothing_to_do() {
        let plan = plan_start(&svc(true), vec![42], || async { true }, G, P).await;
        assert_eq!(plan, StartPlan::AlreadyUp);
    }

    #[tokio::test]
    async fn app_not_running_just_starts() {
        let plan = plan_start(&svc(true), vec![], || async { false }, G, P).await;
        assert_eq!(plan, StartPlan::Start);
    }

    #[tokio::test]
    async fn without_the_flag_a_running_app_is_left_alone() {
        let plan = plan_start(&svc(false), vec![42], || async { false }, G, P).await;
        assert_eq!(plan, StartPlan::Start);
    }

    #[tokio::test]
    async fn dead_port_after_grace_restarts_the_app() {
        let t0 = Instant::now();
        let plan = plan_start(&svc(true), vec![42, 43], || async { false }, G, P).await;
        assert_eq!(plan, StartPlan::Restart(vec![42, 43]));
        assert!(t0.elapsed() >= G, "waited the grace period first");
    }

    #[tokio::test]
    async fn port_coming_up_during_grace_is_not_stuck() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let calls = AtomicU32::new(0);
        // Closed for the first check and two polls, then the server answers.
        let plan = plan_start(&svc(true), vec![42], || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move { n >= 3 }
        }, G, P)
        .await;
        assert_eq!(plan, StartPlan::AlreadyUp);
        assert!(calls.load(Ordering::SeqCst) >= 4);
    }
}
