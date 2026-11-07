//! Close a Claude session completely: end the session (which also drops its link to
//! claude.ai and the phone app), kill every process it started, and archive its
//! conversation (moved into ~/.claude/chat-archive, never deleted).
//!
//! A session's processes are found two ways: everything under the session's own process,
//! and anything carrying `CLAUDE_CODE_SESSION_ID=<session>` in its environment. Claude Code
//! sets that for every command it runs and children inherit it, so a dev server whose
//! launching shell exited long ago is still found. Hangar itself, whatever launched it and
//! whatever it launched are never touched (a session that started Hangar passed its id on).

use crate::{chats, monitor};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const SID_VAR: &str = "CLAUDE_CODE_SESSION_ID=";

#[derive(Clone, Debug)]
struct P {
    pid: u32,
    ppid: Option<u32>,
    name: String,
    /// Start time (s since epoch): with the pid, it tells a process from a later one that reused its pid.
    start: u64,
    cmd: String,
    mem: u64,
    sid: Option<String>,
}

fn snapshot() -> Vec<P> {
    let mut sys = System::new();
    let kind = ProcessRefreshKind::nothing().with_memory().with_cmd(UpdateKind::Always).with_environ(UpdateKind::Always);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    sys.processes()
        .iter()
        .filter(|(pid, _)| pid.as_u32() > 4)
        .map(|(pid, p)| P {
            pid: pid.as_u32(),
            ppid: p.parent().map(|x| x.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            start: p.start_time(),
            cmd: p
                .cmd()
                .iter()
                .map(|a| {
                    let a = a.to_string_lossy();
                    if a.contains(' ') { format!("\"{a}\"") } else { a.into_owned() }
                })
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(300)
                .collect(),
            mem: p.memory() / (1024 * 1024),
            sid: p.environ().iter().find_map(|e| e.to_str()?.strip_prefix(SID_VAR).map(String::from)),
        })
        .collect()
}

fn is_claude(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "claude.exe" | "claude")
}

/// Every process below `root`. A child must have started after its parent, so a pid Windows
/// handed to something new after the real parent exited doesn't drag in strangers.
fn descendants(procs: &[P], root: u32) -> HashSet<u32> {
    let by_pid: HashMap<u32, &P> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        if let Some(pp) = p.ppid {
            if by_pid.get(&pp).is_none_or(|parent| parent.start <= p.start) {
                kids.entry(pp).or_default().push(p.pid);
            }
        }
    }
    let mut out = HashSet::new();
    let mut todo = vec![root];
    while let Some(pid) = todo.pop() {
        for &k in kids.get(&pid).into_iter().flatten() {
            if out.insert(k) {
                todo.push(k);
            }
        }
    }
    out
}

fn ancestors(procs: &[P], pid: u32) -> HashSet<u32> {
    let by_pid: HashMap<u32, &P> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut out = HashSet::new();
    let mut cur = by_pid.get(&pid).copied();
    while let Some(p) = cur {
        let Some(parent) = p.ppid.and_then(|pp| by_pid.get(&pp).copied()) else { break };
        if parent.start > p.start || !out.insert(parent.pid) {
            break;
        }
        cur = Some(parent);
    }
    out
}

/// The session's processes, each with how it was found: "child" (below the session's own
/// process) or "env" (carries the session id). Never the session process itself, never Hangar
/// (`me`), its children or its parents. Other Claude processes only count when they run below
/// this session: the Claude Code daemon can carry the id of whichever session started it.
fn pick(procs: &[P], sid: &str, worker: Option<u32>, me: u32) -> Vec<(u32, &'static str)> {
    let mut hangar = descendants(procs, me);
    hangar.extend(ancestors(procs, me));
    hangar.insert(me);
    let under = worker.map(|w| descendants(procs, w)).unwrap_or_default();
    procs
        .iter()
        .filter(|p| Some(p.pid) != worker && !hangar.contains(&p.pid))
        .filter_map(|p| {
            if under.contains(&p.pid) {
                Some((p.pid, "child"))
            } else if p.sid.as_deref() == Some(sid) && !is_claude(&p.name) {
                Some((p.pid, "env"))
            } else {
                None
            }
        })
        .collect()
}

#[derive(Serialize)]
pub struct SessionProc {
    pid: u32,
    name: String,
    cmd: String,
    ports: Vec<u16>,
    mem: u64,
    /// "child" (runs under the session) or "env" (started by it; its parent is gone).
    via: &'static str,
    /// Why Hangar won't kill it (part of Windows), if so.
    refused: Option<String>,
    /// A desktop app you likely use yourself (a session that ran `code .` passed its id on to
    /// VS Code): starts unticked in the dialog.
    yours: bool,
}

/// Apps that inherit a session's id when it opens them, but are yours to close.
fn likely_yours(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const APPS: [&str; 12] = [
        "code.exe", "cursor.exe", "windowsterminal.exe", "wt.exe", "chrome.exe", "msedge.exe", "firefox.exe", "obs64.exe",
        "discord.exe", "telegram.exe", "notepad.exe", "notepad++.exe",
    ];
    APPS.contains(&n.as_str())
}

#[derive(Serialize)]
pub struct SessionProcs {
    running: bool,
    /// background | interactive ("" when it isn't running).
    kind: String,
    /// The session's own Claude process.
    worker: Option<u32>,
    procs: Vec<SessionProc>,
}

fn rows(procs: &[P], picked: &[(u32, &'static str)]) -> Vec<SessionProc> {
    let ports = monitor::listening_ports();
    let by_pid: HashMap<u32, &P> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut out: Vec<SessionProc> = picked
        .iter()
        .filter_map(|(pid, via)| {
            let p = by_pid.get(pid)?;
            Some(SessionProc {
                pid: *pid,
                name: p.name.clone(),
                cmd: p.cmd.clone(),
                ports: ports.get(pid).cloned().unwrap_or_default(),
                mem: p.mem,
                via,
                refused: monitor::refusal(&p.name).map(|w| format!("{} {w}", p.name)),
                yours: likely_yours(&p.name),
            })
        })
        .collect();
    // Servers first (they hold ports), then the biggest.
    out.sort_by(|a, b| a.ports.is_empty().cmp(&b.ports.is_empty()).then(b.mem.cmp(&a.mem)));
    out
}

fn check(id: &str, session_id: &str) -> Result<(), String> {
    if !chats::valid(session_id) || (!id.is_empty() && !chats::valid(id)) {
        return Err("Not a session id".into());
    }
    Ok(())
}

/// What closing a session would end: whether it runs, and every process it started.
#[tauri::command]
pub async fn chats_procs(session_id: String) -> Result<SessionProcs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check("", &session_id)?;
        let live = chats::live_entry(&session_id)?;
        let worker = live.as_ref().and_then(|a| a["pid"].as_u64()).map(|p| p as u32);
        let procs = snapshot();
        let picked = pick(&procs, &session_id, worker, std::process::id());
        Ok(SessionProcs {
            running: live.is_some(),
            kind: live.as_ref().and_then(|a| a["kind"].as_str()).unwrap_or("").to_string(),
            worker,
            procs: rows(&procs, &picked),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Closed {
    /// The session was running and has ended.
    ended: bool,
    /// "name (pid)" of each process killed.
    killed: Vec<String>,
    /// Ones still alive afterwards.
    left: Vec<String>,
    /// The archive folder, "" when not archived (or nothing was left on disk).
    archived: String,
}

fn wait_gone(session_id: &str, secs: u64) -> Result<bool, String> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while chats::live_entry(session_id)?.is_some() {
        if Instant::now() > deadline {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    Ok(true)
}

/// Kills exactly these processes (no /T: whatever runs under them was matched on its own, and
/// a tree kill could reach Hangar when a session started it). A pid only counts while it is still
/// the process that was matched (same start time).
fn kill_exact(targets: &HashMap<u32, (u64, String)>) -> Vec<String> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut killed = Vec::new();
    for (pid, (start, name)) in targets {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            if p.start_time() == *start && p.kill() {
                killed.push(format!("{name} ({pid})"));
            }
        }
    }
    killed.sort();
    killed
}

/// Ends the session, kills its processes except the pids in `keep`, and (with `archive`) moves
/// its conversation into the chat archive.
#[tauri::command]
pub async fn chats_close(id: String, session_id: String, cwd: String, name: String, keep: Vec<u32>, archive: bool) -> Result<Closed, String> {
    tauri::async_runtime::spawn_blocking(move || close_blocking(&id, &session_id, &cwd, &name, &keep, archive))
        .await
        .map_err(|e| e.to_string())?
}

/// The background job id Claude Code knows this session by ("" for terminal / VS Code sessions).
/// Callers that only have the session id (the bell) leave `id` empty.
fn job_id(session_id: &str) -> Result<String, String> {
    Ok(chats::agents_json(true)?
        .into_iter()
        .find(|a| a["sessionId"].as_str() == Some(session_id) && a["kind"].as_str() == Some("background"))
        .and_then(|a| a["id"].as_str().map(String::from))
        .unwrap_or_default())
}

fn close_blocking(id: &str, session_id: &str, cwd: &str, name: &str, keep: &[u32], archive: bool) -> Result<Closed, String> {
    check(id, session_id)?;
    let found;
    let id = if id.is_empty() {
        found = job_id(session_id)?;
        found.as_str()
    } else {
        id
    };
    let me = std::process::id();
    let live = chats::live_entry(session_id)?;
    let worker = live.as_ref().and_then(|a| a["pid"].as_u64()).map(|p| p as u32);
    let before = snapshot();
    let mut targets: HashMap<u32, (u64, String)> = HashMap::new();
    let mut add = |procs: &[P], picked: Vec<(u32, &'static str)>| {
        for (pid, _) in picked {
            if let Some(p) = procs.iter().find(|p| p.pid == pid) {
                targets.entry(pid).or_insert((p.start, p.name.clone()));
            }
        }
    };
    // Matched before the session ends: once its process is gone, "runs under it" can't be seen.
    add(&before, pick(&before, session_id, worker, me));

    // 1. End the session.
    let mut ended = false;
    if let Some(a) = &live {
        if a["kind"].as_str() == Some("background") {
            if id.is_empty() {
                return Err("No job id for this background session".into());
            }
            let out = chats::claude_cmd().args(["stop", id]).output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect());
            }
            if !wait_gone(session_id, 20)? {
                return Err("Asked it to stop, but it is still running after 20 seconds. Nothing else was touched; try again in a moment.".into());
            }
        } else {
            // A terminal or VS Code session: Claude Code can't stop those from outside, so end its process.
            let w = worker.ok_or("Couldn't find the session's process")?;
            let p = before.iter().find(|p| p.pid == w).ok_or("The session's process is already gone")?;
            if !is_claude(&p.name) && !p.cmd.to_ascii_lowercase().contains("claude") {
                return Err(format!("Process {w} ({}) doesn't look like Claude Code, so Hangar left it alone.", p.name));
            }
            kill_exact(&HashMap::from([(w, (p.start, p.name.clone()))]));
            if !wait_gone(session_id, 10)? {
                return Err("Ended its process, but Claude Code still lists it as running. Try again in a moment.".into());
            }
        }
        ended = true;
    }

    // 2. Everything it started, including anything that appeared while it was stopping.
    let after = snapshot();
    add(&after, pick(&after, session_id, None, me));
    targets.retain(|pid, (_, name)| !keep.contains(pid) && monitor::refusal(name).is_none() && *pid != me);
    let killed = kill_exact(&targets);
    std::thread::sleep(Duration::from_millis(800));
    let still: HashMap<u32, u64> = snapshot().into_iter().map(|p| (p.pid, p.start)).collect();
    let mut left: Vec<String> = targets
        .iter()
        .filter(|(pid, (start, _))| still.get(pid) == Some(start))
        .map(|(pid, (_, name))| format!("{name} ({pid})"))
        .collect();
    left.sort();

    // 3. The conversation goes to the archive (moved, not deleted).
    // Terminal / VS Code sessions have no job folder; their archive folder takes the session id's
    // first 8 characters, which is how Claude Code names job ids too.
    let label = if id.is_empty() { &session_id[..session_id.len().min(8)] } else { id };
    let archived = if archive { chats::done_blocking(label, session_id, cwd, name)? } else { String::new() };
    Ok(Closed { ended, killed, left, archived })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, name: &str, start: u64, sid: Option<&str>) -> P {
        P { pid, ppid: Some(ppid), name: name.into(), start, cmd: String::new(), mem: 0, sid: sid.map(String::from) }
    }

    const SID: &str = "aaaa1111-2222-3333-4444-555566667777";

    #[test]
    fn picks_what_the_session_started_and_spares_hangar() {
        let procs = vec![
            p(10, 1, "claude.exe", 100, None),           // the session (worker)
            p(11, 10, "bash.exe", 110, Some(SID)),       // its shell
            p(12, 11, "node.exe", 120, Some(SID)),       // a dev server it started
            p(13, 10, "python.exe", 115, None),          // an MCP server without the variable
            p(20, 999, "python.exe", 130, Some(SID)),    // orphaned: its shell exited
            p(30, 1, "claude.exe", 50, Some(SID)),       // the daemon, started by this session
            p(40, 11, "hangar.exe", 140, Some(SID)),       // Hangar, launched by the session
            p(41, 40, "uvicorn.exe", 150, Some(SID)),    // a tool Hangar started
            p(50, 1, "node.exe", 160, Some("other-session")),
        ];
        let mut got: Vec<_> = pick(&procs, SID, Some(10), 40);
        got.sort();
        // 11 (bash) launched Hangar, so it is spared too: ending it could take Hangar along.
        assert_eq!(got, vec![(12, "child"), (13, "child"), (20, "env")]);
    }

    #[test]
    fn desktop_apps_start_unticked() {
        assert!(likely_yours("Code.exe") && likely_yours("obs64.exe") && likely_yours("msedge.exe"));
        assert!(!likely_yours("node.exe") && !likely_yours("python.exe"));
    }

    #[test]
    fn a_reused_pid_is_not_a_child() {
        // 61's parent pid is 60, but 60 started after it: Windows reused the pid.
        let procs = vec![p(60, 1, "claude.exe", 200, None), p(61, 60, "notepad.exe", 100, None)];
        assert!(pick(&procs, SID, Some(60), 999).is_empty());
    }

    #[test]
    fn past_sessions_match_by_environment_only() {
        let procs = vec![p(70, 1, "node.exe", 10, Some(SID)), p(71, 70, "esbuild.exe", 11, Some(SID)), p(72, 1, "claude.exe", 12, Some(SID))];
        let mut got = pick(&procs, SID, None, 999);
        got.sort();
        assert_eq!(got, vec![(70, "env"), (71, "env")]);
    }

    /// The session id is read from a process's environment (this test's own, run from Claude Code or not).
    #[test]
    #[cfg(windows)]
    fn reads_environments() {
        let me = snapshot().into_iter().find(|p| p.pid == std::process::id()).expect("own process listed");
        assert_eq!(me.sid, std::env::var("CLAUDE_CODE_SESSION_ID").ok());
    }
}
