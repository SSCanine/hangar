//! GPU readout, project index, and opening folders/links.

use serde::Serialize;
use serde_json::Value;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Default)]
pub struct GpuStats {
    pub name: String,
    pub util: u32,
    pub mem_used: u32,
    pub mem_total: u32,
    pub temp: u32,
    pub power: f32,
}

fn parse_gpu(line: &str) -> Option<GpuStats> {
    let f: Vec<&str> = line.split(',').map(str::trim).collect();
    if f.len() < 6 {
        return None;
    }
    Some(GpuStats {
        name: f[0].to_string(),
        util: f[1].parse().ok()?,
        mem_used: f[2].parse().ok()?,
        mem_total: f[3].parse().ok()?,
        temp: f[4].parse().ok()?,
        power: f[5].parse().unwrap_or(0.0),
    })
}

#[tauri::command]
pub async fn gpu_stats() -> Result<GpuStats, String> {
    tokio::task::spawn_blocking(|| {
        let mut c = Command::new("nvidia-smi");
        c.args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ]);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        let out = c.output().map_err(|e| format!("nvidia-smi not available: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines().next().and_then(parse_gpu).ok_or_else(|| "nvidia-smi gave no GPU line".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The optional project list: registry/projects.json (same folder as tools.json).
/// Missing file = empty list, so the Projects page simply shows nothing.
#[tauri::command]
pub fn projects_get() -> Result<Value, String> {
    let path = crate::registry::registry_dir().join("projects.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!({ "groups": [] })),
    }
}

#[tauri::command]
pub fn path_exists(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

/// Shows a folder (or a file, selected) in Explorer. `raw_arg` keeps the quotes exactly as
/// written, so paths with spaces or commas don't fall back to Documents.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Folder not found: {path}"));
    }
    if path.contains('"') {
        return Err("Unsupported path".into());
    }
    let mut c = Command::new("explorer.exe");
    if p.is_dir() {
        c.raw_arg(format!("\"{path}\""));
    } else {
        c.raw_arg(format!("/select,\"{path}\""));
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Your home folder (USERPROFILE), the starting folder for new chats.
#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

/// Opens a file with its default app.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("File not found: {path}"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// Puts text on the Windows clipboard (clip.exe reads UTF-16 with a BOM correctly).
#[tauri::command]
pub fn clipboard_set(text: String) -> Result<(), String> {
    use std::io::Write;
    let mut child = Command::new("clip.exe")
        .stdin(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    child.stdin.take().ok_or("no stdin")?.write_all(&bytes).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_nvidia_smi_line() {
        let g = super::parse_gpu("NVIDIA GeForce RTX 4070, 12, 4310, 12282, 51, 78.40").unwrap();
        assert_eq!((g.util, g.mem_used, g.mem_total, g.temp), (12, 4310, 12282, 51));
    }
}

#[derive(Serialize, Default)]
pub struct SysStats {
    /// Whole-machine CPU load since the previous call, 0-100.
    pub cpu: f32,
    pub threads: usize,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Commit charge (RAM + pagefile in use) and its limit, in MB.
    pub commit_used: u64,
    pub commit_total: u64,
}

#[cfg(windows)]
mod win {
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::GetSystemTimes;

    static LAST: Mutex<Option<(u64, u64)>> = Mutex::new(None);

    fn ft(f: &FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    /// (idle, busy+idle) ticks since boot.
    fn times() -> Option<(u64, u64)> {
        let mut idle: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel = idle;
        let mut user = idle;
        let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        // Kernel time already includes idle time.
        (ok != 0).then(|| (ft(&idle), ft(&kernel) + ft(&user)))
    }

    pub fn cpu_percent() -> f32 {
        let Some(now) = times() else { return 0.0 };
        let prev = {
            let mut last = LAST.lock().unwrap();
            let prev = *last;
            *last = Some(now);
            prev
        };
        // First call: take a short second sample so the number means "right now".
        let (prev, now) = match prev {
            Some(p) => (p, now),
            None => {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let Some(n2) = times() else { return 0.0 };
                *LAST.lock().unwrap() = Some(n2);
                (now, n2)
            }
        };
        super::busy_percent(prev, now)
    }

    pub fn memory() -> (u64, u64, u64, u64) {
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 {
            return (0, 0, 0, 0);
        }
        const MB: u64 = 1024 * 1024;
        (
            (m.ullTotalPhys - m.ullAvailPhys) / MB,
            m.ullTotalPhys / MB,
            (m.ullTotalPageFile - m.ullAvailPageFile) / MB,
            m.ullTotalPageFile / MB,
        )
    }
}

fn busy_percent(prev: (u64, u64), now: (u64, u64)) -> f32 {
    let idle = now.0.saturating_sub(prev.0) as f64;
    let total = now.1.saturating_sub(prev.1) as f64;
    if total <= 0.0 {
        return 0.0;
    }
    (((total - idle) / total) * 100.0).clamp(0.0, 100.0) as f32
}

#[tauri::command]
pub async fn sys_stats() -> SysStats {
    tokio::task::spawn_blocking(|| {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
        #[cfg(windows)]
        {
            let (mem_used, mem_total, commit_used, commit_total) = win::memory();
            SysStats { cpu: win::cpu_percent(), threads, mem_used, mem_total, commit_used, commit_total }
        }
        #[cfg(not(windows))]
        SysStats { threads, ..Default::default() }
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod sys_tests {
    #[test]
    fn busy_percent_math() {
        assert_eq!(super::busy_percent((100, 1000), (150, 1100)), 50.0);
        assert_eq!(super::busy_percent((0, 0), (0, 0)), 0.0);
    }

    #[test]
    #[cfg(windows)]
    fn reads_real_memory() {
        let (used, total, _, commit_total) = super::win::memory();
        assert!(total > 0 && used <= total && commit_total >= total);
        let cpu = super::win::cpu_percent();
        assert!((0.0..=100.0).contains(&cpu));
    }
}
