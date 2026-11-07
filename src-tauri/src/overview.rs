//! The System page: per-core CPU, the full GPU readout, drives, network and
//! host facts. Rates (disk and network bytes per second) come from the gap
//! between two calls, so the first call reports zero rates.

use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, DiskKind, DiskRefreshKind, Disks, Networks, System};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Free space barely moves; asking every volume each tick is wasted work.
const STORAGE_EVERY: Duration = Duration::from_secs(30);

struct State {
    sys: System,
    disks: Disks,
    nets: Networks,
    at: Instant,
    storage_at: Instant,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

#[derive(Serialize)]
pub struct Host {
    name: String,
    os: String,
    uptime_s: u64,
    cpu: String,
    cores: usize,
    threads: usize,
}

#[derive(Serialize, Default)]
pub struct GpuDetail {
    name: String,
    driver: String,
    util: Option<f32>,
    mem_util: Option<f32>,
    mem_used: Option<f32>,
    mem_total: Option<f32>,
    temp: Option<f32>,
    power: Option<f32>,
    power_limit: Option<f32>,
    fan: Option<f32>,
    clock_gr: Option<f32>,
    clock_mem: Option<f32>,
    clock_gr_max: Option<f32>,
    clock_mem_max: Option<f32>,
    pstate: String,
    encoder: Option<f32>,
    decoder: Option<f32>,
    pcie_gen: Option<f32>,
    pcie_width: Option<f32>,
}

#[derive(Serialize)]
pub struct DiskRow {
    mount: String,
    label: String,
    fs: String,
    /// "SSD", "HDD" or "".
    kind: &'static str,
    total: u64,
    free: u64,
    removable: bool,
    read_bps: f64,
    write_bps: f64,
}

#[derive(Serialize)]
pub struct NetRow {
    name: String,
    rx_bps: f64,
    tx_bps: f64,
    total_rx: u64,
    total_tx: u64,
}

#[derive(Serialize)]
pub struct Overview {
    host: Host,
    /// Load per logical processor, 0-100.
    cores: Vec<f32>,
    /// Average reported clock, MHz.
    cpu_mhz: u64,
    gpu: Option<GpuDetail>,
    disks: Vec<DiskRow>,
    nets: Vec<NetRow>,
}

const GPU_FIELDS: &str = "name,driver_version,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,\
power.draw,power.limit,fan.speed,clocks.gr,clocks.mem,clocks.max.gr,clocks.max.mem,pstate,utilization.encoder,\
utilization.decoder,pcie.link.gen.current,pcie.link.width.current";

/// One nvidia-smi CSV line in GPU_FIELDS order. "[N/A]" and "N/A" become None.
fn parse_gpu_detail(line: &str) -> Option<GpuDetail> {
    let f: Vec<&str> = line.split(',').map(str::trim).collect();
    if f.len() < 19 {
        return None;
    }
    let n = |i: usize| f[i].parse::<f32>().ok();
    Some(GpuDetail {
        name: f[0].to_string(),
        driver: f[1].to_string(),
        util: n(2),
        mem_util: n(3),
        mem_used: n(4),
        mem_total: n(5),
        temp: n(6),
        power: n(7),
        power_limit: n(8),
        fan: n(9),
        clock_gr: n(10),
        clock_mem: n(11),
        clock_gr_max: n(12),
        clock_mem_max: n(13),
        pstate: f[14].to_string(),
        encoder: n(15),
        decoder: n(16),
        pcie_gen: n(17),
        pcie_width: n(18),
    })
}

fn gpu_detail() -> Option<GpuDetail> {
    let mut c = Command::new("nvidia-smi");
    c.args([&format!("--query-gpu={GPU_FIELDS}"), "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let out = c.output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next().and_then(parse_gpu_detail)
}

/// Interfaces worth showing: real adapters that have moved bytes. Windows lists
/// many filter/virtual layers per adapter (WFP, QoS, Npcap...); they repeat the
/// same traffic.
fn real_interface(name: &str) -> bool {
    let n = name.to_lowercase();
    const SKIP: [&str; 9] = ["loopback", "-wfp", "-qos", "-npcap", "filter", "isatap", "teredo", "6to4", "pseudo"];
    !SKIP.iter().any(|s| n.contains(s))
}

fn rate(bytes: u64, secs: f64) -> f64 {
    if secs <= 0.0 {
        0.0
    } else {
        bytes as f64 / secs
    }
}

#[tauri::command]
pub async fn system_overview() -> Result<Overview, String> {
    tokio::task::spawn_blocking(|| {
        // nvidia-smi takes ~150 ms; run it while the counters refresh.
        let gpu = std::thread::spawn(gpu_detail);

        let mut guard = STATE.lock().unwrap();
        let first = guard.is_none();
        let st = guard.get_or_insert_with(|| {
            let mut sys = System::new();
            sys.refresh_cpu_specifics(CpuRefreshKind::everything());
            State {
                sys,
                disks: Disks::new_with_refreshed_list_specifics(DiskRefreshKind::everything()),
                nets: Networks::new_with_refreshed_list(),
                at: Instant::now(),
                storage_at: Instant::now(),
            }
        });
        if first {
            // Load is a rate: give it a real interval before the second sample.
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(250)));
        }
        let secs = st.at.elapsed().as_secs_f64();
        st.at = Instant::now();
        st.sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage().with_frequency());
        let mut kind = DiskRefreshKind::nothing().with_io_usage();
        if st.storage_at.elapsed() >= STORAGE_EVERY {
            kind = kind.with_storage();
            st.storage_at = Instant::now();
        }
        st.disks.refresh_specifics(true, kind);
        st.nets.refresh(true);

        let cpus = st.sys.cpus();
        let cores = cpus.iter().map(|c| c.cpu_usage()).collect::<Vec<_>>();
        let cpu_mhz = if cpus.is_empty() { 0 } else { cpus.iter().map(|c| c.frequency()).sum::<u64>() / cpus.len() as u64 };

        let mut disks = st
            .disks
            .list()
            .iter()
            .filter(|d| d.total_space() > 0)
            .map(|d| {
                let u = d.usage();
                DiskRow {
                    mount: d.mount_point().display().to_string(),
                    label: d.name().to_string_lossy().into_owned(),
                    fs: d.file_system().to_string_lossy().into_owned(),
                    kind: match d.kind() {
                        DiskKind::SSD => "SSD",
                        DiskKind::HDD => "HDD",
                        _ => "",
                    },
                    total: d.total_space(),
                    free: d.available_space(),
                    removable: d.is_removable(),
                    // The first call has no earlier sample to compare with.
                    read_bps: if first { 0.0 } else { rate(u.read_bytes, secs) },
                    write_bps: if first { 0.0 } else { rate(u.written_bytes, secs) },
                }
            })
            .collect::<Vec<_>>();
        disks.sort_by(|a, b| a.mount.cmp(&b.mount));

        let mut nets = st
            .nets
            .list()
            .iter()
            .filter(|(name, n)| real_interface(name) && n.total_received() + n.total_transmitted() > 0)
            .map(|(name, n)| NetRow {
                name: name.clone(),
                rx_bps: if first { 0.0 } else { rate(n.received(), secs) },
                tx_bps: if first { 0.0 } else { rate(n.transmitted(), secs) },
                total_rx: n.total_received(),
                total_tx: n.total_transmitted(),
            })
            .collect::<Vec<_>>();
        nets.sort_by(|a, b| (b.total_rx + b.total_tx).cmp(&(a.total_rx + a.total_tx)));

        let host = Host {
            name: System::host_name().unwrap_or_default(),
            os: System::long_os_version().unwrap_or_default(),
            uptime_s: System::uptime(),
            cpu: cpus.first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
            cores: System::physical_core_count().unwrap_or(0),
            threads: cpus.len(),
        };
        drop(guard);
        Overview { host, cores, cpu_mhz, gpu: gpu.join().ok().flatten(), disks, nets }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Opens one of the Windows monitors. A fixed list: nothing else can be launched.
#[tauri::command]
pub fn open_system_app(app: String) -> Result<(), String> {
    let exe = match app.as_str() {
        "taskmgr" => "taskmgr.exe",
        "resmon" => "resmon.exe",
        "storage" => "ms-settings:storagesense",
        _ => return Err(format!("Unknown app: {app}")),
    };
    // Through `start` so Windows handles elevation (Task Manager asks for it on some setups).
    let mut c = Command::new("cmd");
    c.args(["/C", "start", "", exe]);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_full_gpu_line() {
        let g = super::parse_gpu_detail(
            "NVIDIA GeForce RTX 4070, 560.00, 8, 1, 5725, 12282, 43, 37.14, 200.00, 0, 360, 10501, 2760, 10501, P0, 0, 2, 4, 16",
        )
        .unwrap();
        assert_eq!(g.util, Some(8.0));
        assert_eq!(g.power_limit, Some(200.0));
        assert_eq!(g.pstate, "P0");
        assert_eq!(g.pcie_width, Some(16.0));
    }

    #[test]
    fn missing_gpu_values_become_none() {
        let g = super::parse_gpu_detail("GPU, 1.0, [N/A], 1, 2, 3, 4, N/A, 5, [N/A], 1, 1, 1, 1, P8, 0, 0, 1, 1").unwrap();
        assert_eq!(g.util, None);
        assert_eq!(g.power, None);
        assert_eq!(g.fan, None);
        assert!(super::parse_gpu_detail("too, short").is_none());
    }

    #[test]
    fn skips_virtual_interfaces() {
        assert!(super::real_interface("Ethernet"));
        assert!(!super::real_interface("Ethernet-WFP Native MAC Layer LightWeight Filter-0000"));
        assert!(!super::real_interface("Loopback Pseudo-Interface 1"));
    }

    #[tokio::test]
    async fn reads_this_machine() {
        let _ = super::system_overview().await.unwrap();
        let o = super::system_overview().await.unwrap();
        assert!(!o.cores.is_empty());
        assert!(o.cores.iter().all(|c| (0.0..=100.0).contains(c)));
        assert!(o.host.uptime_s > 0);
        assert!(o.disks.iter().any(|d| d.total > 0));
    }
}
