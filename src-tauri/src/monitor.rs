//! Process monitor behind the CPU / RAM / GPU meters: every process with its
//! command line, folder, CPU share, memory, listening ports and GPU use, plus
//! a guarded kill.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static SYS: Mutex<Option<System>> = Mutex::new(None);

#[derive(Serialize)]
pub struct ProcRow {
    pid: u32,
    ppid: Option<u32>,
    name: String,
    exe: String,
    cmd: String,
    /// The real argv (first 24 args, each capped), so matching never re-splits `cmd`:
    /// a path quoted inside one long argument (a system prompt) is not an argument.
    args: Vec<String>,
    cwd: String,
    /// Share of the whole machine, 0-100.
    cpu: f32,
    /// Working set, MB.
    mem: u64,
    ports: Vec<u16>,
    /// VRAM resident on the card, MB (None when the GPU counters are unavailable).
    vram: Option<u64>,
    /// GPU engine load for this process, 0-100.
    gpu_load: f32,
    gpu: bool,
}

#[derive(Serialize)]
pub struct ProcSnapshot {
    self_pid: u32,
    rows: Vec<ProcRow>,
}

/// pid -> listening TCP ports, from `netstat -ano`.
pub(crate) fn listening_ports() -> HashMap<u32, Vec<u16>> {
    let mut c = Command::new("netstat");
    c.args(["-ano", "-p", "TCP"]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    let Ok(out) = c.output() else { return map };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() == 5 && f[0] == "TCP" && f[3] == "LISTENING" {
            let port = f[1].rsplit(':').next().and_then(|p| p.parse().ok());
            if let (Some(port), Ok(pid)) = (port, f[4].parse::<u32>()) {
                let v = map.entry(pid).or_default();
                if !v.contains(&port) {
                    v.push(port);
                }
            }
        }
    }
    map
}

/// Per-process GPU use from the Windows "GPU Process Memory" and "GPU Engine"
/// performance counters (what Task Manager shows). Covers graphics apps too,
/// not just CUDA ones.
#[cfg(windows)]
mod gpu {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows_sys::Win32::System::Performance::*;

    struct Query {
        q: isize,
        mem: isize,
        eng: isize,
    }

    static QUERY: Mutex<Option<Query>> = Mutex::new(None);
    /// Not exported by windows-sys: lets engine percentages exceed 100 before we cap them.
    const PDH_FMT_NOCAP100: u32 = 0x0000_8000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open() -> Option<Query> {
        unsafe {
            let mut q = 0isize;
            if PdhOpenQueryW(std::ptr::null(), 0, &mut q) != 0 {
                return None;
            }
            let mut mem = 0isize;
            let mut eng = 0isize;
            // Local Usage = this process's allocations resident in the card's own memory; the
            // per-process values add up to what the driver reports. "Dedicated Usage" charges
            // shared surfaces to every process that maps them, so its totals can exceed the card.
            let p1 = wide(r"\GPU Process Memory(*)\Local Usage");
            let p2 = wide(r"\GPU Engine(*)\Utilization Percentage");
            if PdhAddEnglishCounterW(q, p1.as_ptr(), 0, &mut mem) != 0 || PdhAddEnglishCounterW(q, p2.as_ptr(), 0, &mut eng) != 0 {
                PdhCloseQuery(q);
                return None;
            }
            PdhCollectQueryData(q); // first sample; rates need a second one
            Some(Query { q, mem, eng })
        }
    }

    /// Instance names look like "pid_1234_luid_0x..._phys_0".
    fn pid_of(name: &str) -> Option<u32> {
        name.strip_prefix("pid_")?.split('_').next()?.parse().ok()
    }

    fn read(counter: isize, format: u32) -> Vec<(String, f64)> {
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            let r = PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, std::ptr::null_mut());
            if r != PDH_MORE_DATA || size == 0 {
                return Vec::new();
            }
            // Items plus the name strings they point into, in one aligned buffer.
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, items) != 0 {
                return Vec::new();
            }
            (0..count as usize)
                .filter_map(|i| {
                    let it = &*items.add(i);
                    if it.FmtValue.CStatus > 1 {
                        return None; // PDH_CSTATUS_VALID_DATA = 0, NEW_DATA = 1
                    }
                    let mut len = 0;
                    while *it.szName.add(len) != 0 {
                        len += 1;
                    }
                    let name = String::from_utf16_lossy(std::slice::from_raw_parts(it.szName, len));
                    let v = if format == PDH_FMT_LARGE {
                        it.FmtValue.Anonymous.largeValue as f64
                    } else {
                        it.FmtValue.Anonymous.doubleValue
                    };
                    Some((name, v))
                })
                .collect()
        }
    }

    /// pid -> (resident VRAM MB, engine load %). None if counters are unavailable.
    pub fn sample() -> Option<HashMap<u32, (u64, f32)>> {
        let mut guard = QUERY.lock().unwrap();
        if guard.is_none() {
            *guard = open();
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let q = guard.as_ref()?;
        unsafe {
            if PdhCollectQueryData(q.q) != 0 {
                return None;
            }
        }
        let mut out: HashMap<u32, (u64, f32)> = HashMap::new();
        for (name, bytes) in read(q.mem, PDH_FMT_LARGE) {
            if let Some(pid) = pid_of(&name) {
                out.entry(pid).or_default().0 += (bytes as u64) / (1024 * 1024);
            }
        }
        // Several engines per process (3D, Copy, Video...); take the busiest.
        for (name, pct) in read(q.eng, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100) {
            if let Some(pid) = pid_of(&name) {
                let e = out.entry(pid).or_default();
                e.1 = e.1.max(pct as f32);
            }
        }
        Some(out)
    }

    #[cfg(test)]
    #[test]
    fn parses_instance_pid() {
        assert_eq!(pid_of("pid_1234_luid_0x00000000_0x0000D1F3_phys_0"), Some(1234));
        assert_eq!(pid_of("_Total"), None);
    }
}

#[cfg(not(windows))]
mod gpu {
    pub fn sample() -> Option<std::collections::HashMap<u32, (u64, f32)>> {
        None
    }
}

fn os(s: &std::ffi::OsStr) -> String {
    s.to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn proc_list() -> Result<ProcSnapshot, String> {
    tokio::task::spawn_blocking(|| {
        let kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet);
        let mut guard = SYS.lock().unwrap();
        let first = guard.is_none();
        let sys = guard.get_or_insert_with(System::new);
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        if first {
            // CPU use is a rate: it needs two samples.
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(std::time::Duration::from_millis(250)));
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
        let ports = listening_ports();
        let gpu = gpu::sample();

        let rows = sys
            .processes()
            .iter()
            .filter(|(pid, _)| pid.as_u32() > 4)
            .map(|(pid, p)| {
                let pid = pid.as_u32();
                let argv = p.cmd().iter().map(|a| os(a)).collect::<Vec<_>>();
                let args = argv.iter().take(24).map(|a| a.chars().take(400).collect()).collect();
                let cmd = argv
                    .iter()
                    .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })
                    .collect::<Vec<_>>()
                    .join(" ");
                let g = gpu.as_ref().and_then(|m| m.get(&pid)).copied();
                ProcRow {
                    pid,
                    ppid: p.parent().map(|x| x.as_u32()),
                    name: os(p.name()),
                    exe: p.exe().map(|e| e.display().to_string()).unwrap_or_default(),
                    cmd: cmd.chars().take(1200).collect(),
                    args,
                    cwd: p.cwd().map(|e| e.display().to_string()).unwrap_or_default(),
                    cpu: p.cpu_usage() / threads,
                    mem: p.memory() / (1024 * 1024),
                    ports: ports.get(&pid).cloned().unwrap_or_default(),
                    vram: gpu.as_ref().map(|_| g.map(|x| x.0).unwrap_or(0)),
                    gpu_load: g.map(|x| x.1).unwrap_or(0.0),
                    gpu: g.map(|x| x.0 > 0 || x.1 > 0.0).unwrap_or(false),
                }
            })
            .collect();
        ProcSnapshot { self_pid: std::process::id(), rows }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Processes Hangar will never kill, with the reason shown.
pub fn refusal(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    const CRITICAL: [&str; 14] = [
        "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
        "svchost.exe", "dwm.exe", "explorer.exe", "fontdrvhost.exe", "msmpeng.exe", "memcompression",
    ];
    if CRITICAL.contains(&n.as_str()) {
        return Some("is part of Windows; Hangar won't kill it");
    }
    None
}

/// Kills each pid and its children. Returns how many were killed.
#[tauri::command]
pub async fn proc_kill(pids: Vec<u32>) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let me = std::process::id();
        let names: HashMap<u32, String> = {
            let mut guard = SYS.lock().unwrap();
            let sys = guard.get_or_insert_with(System::new);
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
            pids.iter()
                .filter_map(|p| sys.process(Pid::from_u32(*p)).map(|pr| (*p, os(pr.name()))))
                .collect()
        };
        for pid in &pids {
            if *pid <= 4 || *pid == me {
                return Err("Hangar won't kill itself or the system".to_string());
            }
            if let Some(name) = names.get(pid) {
                if let Some(why) = refusal(name) {
                    return Err(format!("{name} {why}"));
                }
            }
        }
        let mut killed = 0;
        for pid in pids {
            if !names.contains_key(&pid) {
                continue; // already gone
            }
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            #[cfg(windows)]
            c.creation_flags(CREATE_NO_WINDOW);
            if c.output().map(|o| o.status.success()).unwrap_or(false) {
                killed += 1;
            }
        }
        Ok(killed)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn refuses_windows_processes() {
        assert!(super::refusal("csrss.exe").is_some());
        assert!(super::refusal("python.exe").is_none());
    }

    #[tokio::test]
    async fn lists_processes_with_this_one_in_it() {
        let snap = super::proc_list().await.unwrap();
        let me = snap.rows.iter().find(|r| r.pid == snap.self_pid).expect("own process listed");
        assert!(me.mem > 0);
        assert!(!me.cmd.is_empty());
        assert!(snap.rows.len() > 20);
    }
}
