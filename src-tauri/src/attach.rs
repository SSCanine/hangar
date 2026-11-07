//! Files for a chat message on the desktop: what's on the clipboard (Ctrl+V with no text,
//! or Alt+V like Claude Code), and files dropped on the chat. Files that already live on
//! disk are passed by their own path; only clipboard images and path-less drops (an image
//! dragged out of a browser) are saved, under Hangar's app data `uploads/<date>/`, next to the
//! phone's uploads. Nothing here deletes anything.

use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ceiling for a path-less drop that has to be copied (a file with a path is never copied).
pub const DROP_SAVE_MAX: usize = 200 * 1024 * 1024;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ClipGrab {
    /// Files copied in Explorer (their own paths), or the saved clipboard image.
    pub files: Vec<String>,
    /// Plain text, when the clipboard holds no files or image.
    pub text: Option<String>,
}

fn uploads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("uploads").join(crate::uploads::local_date());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the uploads folder: {e}"))?;
    Ok(dir)
}

/// WinForms' clipboard needs STA, which Windows PowerShell 5.1 is by default. Lines out:
/// `F<tab>path` per copied file, `I<tab>path` for a saved image, or `T<tab>` + base64 text.
const GRAB_PS: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$c = [Windows.Forms.Clipboard]
$f = $c::GetFileDropList()
if ($f -and $f.Count) { foreach ($p in $f) { "F`t$p" }; exit 0 }
if ($c::ContainsImage()) {
  $img = $c::GetImage()
  $out = Join-Path $env:HANGAR_PASTE_DIR ('paste-' + (Get-Date -Format 'HHmmss-fff') + '.png')
  $img.Save($out, [Drawing.Imaging.ImageFormat]::Png)
  "I`t$out"; exit 0
}
if ($c::ContainsText()) { "T`t" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c::GetText())) }
"#;

fn parse_grab(out: &str) -> ClipGrab {
    use base64::Engine;
    let mut g = ClipGrab::default();
    for line in out.lines() {
        let Some((tag, rest)) = line.split_once('\t') else { continue };
        let rest = rest.trim_end_matches('\r');
        match tag {
            "F" | "I" if !rest.is_empty() => g.files.push(rest.to_string()),
            "T" => {
                g.text = base64::engine::general_purpose::STANDARD.decode(rest.trim()).ok().and_then(|b| String::from_utf8(b).ok()).filter(|t| !t.is_empty());
            }
            _ => {}
        }
    }
    g
}

/// Reads the Windows clipboard for the chat box: copied files, else an image (saved as PNG),
/// else text. Empty when there's nothing usable.
#[tauri::command]
pub async fn clipboard_grab(app: tauri::AppHandle) -> Result<ClipGrab, String> {
    use base64::Engine;
    let dir = uploads_dir(&app)?;
    // -EncodedCommand (UTF-16LE base64) so the script's quotes survive Windows argument quoting.
    let script: Vec<u8> = GRAB_PS.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(script);
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = std::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded]).env("HANGAR_PASTE_DIR", &dir);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        let out = c.output().map_err(|e| format!("Couldn't read the clipboard: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("Couldn't read the clipboard: {}", err.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('<')).unwrap_or("PowerShell failed")));
        }
        Ok(parse_grab(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves a dropped file that came without a path (dragged out of a browser, say) and
/// returns where it went. Files with a path never come through here.
#[tauri::command]
pub async fn attach_save(app: tauri::AppHandle, name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err(format!("{name} is empty."));
    }
    if bytes.len() > DROP_SAVE_MAX {
        return Err(format!("{name} is over {} MB; drop it from a folder instead.", DROP_SAVE_MAX / 1024 / 1024));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || crate::uploads::save_upload(&dir, &name, &bytes).map(|p| p.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

/// The page sends `{"hangarDrop": "<token>"}` with the dropped File objects through
/// `chrome.webview.postMessageWithAdditionalObjects`; WebView2 hands the host each file's real
/// path, which goes back as a `hangar://drop` event `{token, paths}`. Tauri's own IPC handler
/// sees the same message, fails to parse it as a command and only logs to the console.
#[derive(Serialize, Clone)]
struct Dropped {
    token: String,
    paths: Vec<String>,
}

fn drop_token(msg: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(msg).ok()?;
    let t = v.get("hangarDrop")?.as_str()?;
    (!t.is_empty() && t.len() <= 64).then(|| t.to_string())
}

/// Hangar's own page only (built app or the dev server), never a tool's page.
fn own_origin(url: &str) -> bool {
    ["http://tauri.localhost/", "https://tauri.localhost/", "tauri://localhost/", "http://localhost:3620/"].iter().any(|o| url.starts_with(o))
}

#[cfg(windows)]
pub fn install_drop_bridge(app: &tauri::AppHandle) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, PWSTR};

    let Some(win) = app.get_webview_window("main") else { return };
    let app = app.clone();
    let _ = win.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut src = PWSTR::null();
            args.Source(&mut src)?;
            if !own_origin(&take_pwstr(src)) {
                return Ok(());
            }
            let mut s = PWSTR::null();
            // Not a string message: not ours.
            if args.TryGetWebMessageAsString(&mut s).is_err() {
                return Ok(());
            }
            let Some(token) = drop_token(&take_pwstr(s)) else { return Ok(()) };
            let mut paths = Vec::new();
            if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                if let Ok(objs) = args2.AdditionalObjects() {
                    let mut n = 0u32;
                    let _ = objs.Count(&mut n);
                    for i in 0..n {
                        let Ok(f) = objs.GetValueAtIndex(i).and_then(|o| o.cast::<ICoreWebView2File>()) else {
                            paths.push(String::new()); // keeps the index lined up with the page's list
                            continue;
                        };
                        let mut p = PWSTR::null();
                        paths.push(if f.Path(&mut p).is_ok() { take_pwstr(p) } else { String::new() });
                    }
                }
            }
            let _ = app.emit("hangar://drop", Dropped { token, paths });
            Ok(())
        }));
        let mut tok = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut tok);
    });
}

#[cfg(not(windows))]
pub fn install_drop_bridge(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grab_files_and_image() {
        let g = parse_grab("F\tC:\\a b\\x.png\r\nF\tD:\\y.mp4\r\n");
        assert_eq!(g.files, vec!["C:\\a b\\x.png", "D:\\y.mp4"]);
        assert_eq!(g.text, None);
        let g = parse_grab("I\tC:\\Users\\me\\paste-1.png\n");
        assert_eq!(g.files, vec!["C:\\Users\\me\\paste-1.png"]);
    }

    #[test]
    fn grab_text_roundtrips_unicode() {
        use base64::Engine;
        let t = "héllo\n\tworld 🌍";
        let g = parse_grab(&format!("T\t{}\r\n", base64::engine::general_purpose::STANDARD.encode(t)));
        assert_eq!(g.text.as_deref(), Some(t));
        assert!(g.files.is_empty());
        assert_eq!(parse_grab(""), ClipGrab::default());
        assert_eq!(parse_grab("T\t\n").text, None);
    }

    #[test]
    fn drop_token_only_ours() {
        assert_eq!(drop_token(r#"{"hangarDrop":"abc123"}"#).as_deref(), Some("abc123"));
        assert_eq!(drop_token(r#"{"cmd":"x","callback":1}"#), None);
        assert_eq!(drop_token("not json"), None);
        assert_eq!(drop_token(r#"{"hangarDrop":""}"#), None);
    }

    #[test]
    fn origin_check() {
        assert!(own_origin("http://tauri.localhost/index.html"));
        assert!(own_origin("http://localhost:3620/"));
        assert!(!own_origin("http://localhost:5173/"));
        assert!(!own_origin("http://tauri.localhost.evil.com/"));
    }
}
