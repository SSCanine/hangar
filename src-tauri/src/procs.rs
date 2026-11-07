//! Windows process helpers: find running copies of an exe and bring its window forward.

#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
}

#[cfg(windows)]
mod imp {
    use super::Proc;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, INVALID_HANDLE_VALUE, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };

    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    pub fn list() -> Vec<Proc> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    out.push(Proc { pid: entry.th32ProcessID, name: wide_to_string(&entry.szExeFile) });
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        out
    }

    pub fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    struct Search {
        pids: Vec<u32>,
        found: HWND,
    }

    unsafe extern "system" fn each_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let s = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if s.pids.contains(&pid)
            && IsWindowVisible(hwnd) != 0
            && GetWindow(hwnd, GW_OWNER).is_null()
            && GetWindowTextLengthW(hwnd) > 0
        {
            s.found = hwnd;
            return 0;
        }
        1
    }

    pub fn focus_pids(pids: &[u32]) -> bool {
        let mut s = Search { pids: pids.to_vec(), found: std::ptr::null_mut() };
        unsafe {
            EnumWindows(Some(each_window), &mut s as *mut Search as LPARAM);
            if s.found.is_null() {
                return false;
            }
            if IsIconic(s.found) != 0 {
                ShowWindow(s.found, SW_RESTORE);
            }
            SetForegroundWindow(s.found);
        }
        true
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Proc;
    pub fn list() -> Vec<Proc> {
        Vec::new()
    }
    pub fn image_path(_pid: u32) -> Option<String> {
        None
    }
    pub fn focus_pids(_pids: &[u32]) -> bool {
        false
    }
}

fn norm(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// PIDs whose image is exactly `exe` (full path, case-insensitive).
pub fn pids_for_exe_in(procs: &[Proc], exe: &str) -> Vec<u32> {
    let want = norm(exe);
    let file = want.rsplit('\\').next().unwrap_or(&want).to_string();
    procs
        .iter()
        .filter(|p| p.name.to_lowercase() == file)
        .filter(|p| imp::image_path(p.pid).map(|i| norm(&i) == want).unwrap_or(false))
        .map(|p| p.pid)
        .collect()
}

pub fn list() -> Vec<Proc> {
    imp::list()
}

pub fn focus(pids: &[u32]) -> bool {
    imp::focus_pids(pids)
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(windows)]
    fn finds_this_test_process() {
        let me = std::env::current_exe().unwrap();
        let procs = super::list();
        let pids = super::pids_for_exe_in(&procs, &me.display().to_string());
        assert!(pids.contains(&std::process::id()));
    }
}
