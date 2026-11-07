//! Embedded terminals for the Chats view: each one is a real console (ConPTY)
//! running a command such as `claude attach <id>`, streamed to xterm.js.
//! Output goes out as `hangar://pty` events {key, data (base64)}, so multi-byte
//! characters split across reads survive the trip.
//!
//! A console can be shared by the desktop window and the phone page (Hangar Remote).
//! `claude attach` allows one client per session (a second one kicks the first, "Session
//! opened in another window"), so whichever side opens a session's terminal second joins
//! the console that is already there instead of starting its own attach. The phone gets the
//! output through `phone_join` (a channel), the desktop through the `hangar://pty` events.
//! While a phone is watching, it sets the console's size; when it leaves, the desktop's size
//! comes back. A console only the phone held closes 30 s after the phone lets go.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// Output kept for a viewer that joins later (the phone opening a terminal the desktop holds).
const TAIL_MAX: usize = 256 * 1024;
/// A console only the phone held stays this long after the phone lets go (switching apps, a
/// dropped connection), so coming back is instant and keeps the scrollback.
const PHONE_GRACE: Duration = Duration::from_secs(30);
/// What the console asks to learn where the cursor is; it holds input back until it hears an answer.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static TERMS: LazyLock<Mutex<HashMap<String, Term>>> = LazyLock::new(Default::default);
static SERIAL: AtomicU64 = AtomicU64::new(1);

/// Lets the reader threads send `hangar://pty` events to the desktop window.
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn terms() -> MutexGuard<'static, HashMap<String, Term>> {
    TERMS.lock().unwrap_or_else(|e| e.into_inner())
}

fn next_serial() -> u64 {
    SERIAL.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize, Clone)]
struct PtyEvent {
    key: String,
    /// data | replay (what the console showed before this window joined) | phone ("on"/"off") | exit
    kind: &'static str,
    data: String,
}

fn emit(key: &str, kind: &'static str, data: String) {
    if let Some(app) = APP.get() {
        let _ = app.emit("hangar://pty", PtyEvent { key: key.to_string(), kind, data });
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// What a phone viewer receives.
#[derive(Debug, PartialEq)]
pub enum Chunk {
    Data(Vec<u8>),
    /// The desktop window resized the console (cols, rows): the phone's view no longer fits.
    Size(u16, u16),
    Exit,
}

#[derive(Default)]
struct Out {
    tail: Vec<u8>,
    /// Phone viewers: (id, channel).
    subs: Vec<(u64, UnboundedSender<Chunk>)>,
    ended: bool,
    last: Option<Instant>,
}

struct Term {
    serial: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    program: String,
    out: Arc<Mutex<Out>>,
    /// The desktop Chats view has this console open.
    desktop: bool,
    /// The size the desktop asked for last, restored when the phone leaves.
    desk_size: Option<(u16, u16)>,
    size: (u16, u16),
    started: Instant,
}

impl Term {
    fn out(&self) -> MutexGuard<'_, Out> {
        self.out.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn alive(&self) -> bool {
        !self.out().ended
    }
    fn phones(&self) -> usize {
        self.out().subs.len()
    }
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(bytes).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }
    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.max(20), rows.max(5));
        self.size = (cols, rows);
        self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
    }
    /// Makes Claude Code draw the whole screen again (it does on every resize), for a viewer
    /// that just joined at the size the console already has.
    fn redraw(&mut self) {
        let (cols, rows) = self.size;
        let _ = self.master.resize(PtySize { rows, cols: cols.saturating_sub(1).max(20), pixel_width: 0, pixel_height: 0 });
        std::thread::sleep(Duration::from_millis(60));
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    fn kill(mut self) {
        let _ = self.child.kill();
    }
}

/// `bytes` without the console's cursor-position questions. Sent to a viewer that joins late,
/// a replayed question would be answered by that viewer's xterm and the answer typed into Claude.
pub fn strip_cursor_queries(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(CURSOR_QUERY) {
            i += CURSOR_QUERY.len();
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Starts `program args` in `cwd` inside a new console. `answer_cursor`: the console's first
/// cursor question is answered here instead of by a viewer (the phone page never answers
/// anything itself; see remote/index.html).
fn spawn(key: &str, program: &str, args: &[String], cwd: &str, cols: u16, rows: u16, answer_cursor: bool, first_sub: Option<(u64, UnboundedSender<Chunk>)>) -> Result<Term, String> {
    let (cols, rows) = (cols.max(20), rows.max(5));
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    if std::path::Path::new(cwd).is_dir() {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {program}: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let out = Arc::new(Mutex::new(Out { subs: first_sub.into_iter().collect(), ..Default::default() }));
    let (key2, out2, w2) = (key.to_string(), out.clone(), writer.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut answered = !answer_cursor;
        let mut prev: Vec<u8> = Vec::new(); // the last few bytes, for a question split across reads
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];
            if !answered {
                let mut look = prev.clone();
                look.extend_from_slice(chunk);
                if look.windows(CURSOR_QUERY.len()).any(|w| w == CURSOR_QUERY) {
                    answered = true;
                    let mut w = w2.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = w.write_all(b"\x1b[1;1R").and_then(|_| w.flush());
                }
                prev = look[look.len().saturating_sub(CURSOR_QUERY.len() - 1)..].to_vec();
            }
            // A console that answers its own question shows nobody the question.
            let shown = if answer_cursor { strip_cursor_queries(chunk) } else { chunk.to_vec() };
            emit(&key2, "data", b64(&shown));
            let mut o = out2.lock().unwrap_or_else(|e| e.into_inner());
            o.last = Some(Instant::now());
            o.tail.extend_from_slice(&shown);
            let excess = o.tail.len().saturating_sub(TAIL_MAX);
            o.tail.drain(..excess);
            if !o.subs.is_empty() {
                let phone = strip_cursor_queries(&shown);
                o.subs.retain(|(_, tx)| tx.send(Chunk::Data(phone.clone())).is_ok());
            }
        }
        let mut o = out2.lock().unwrap_or_else(|e| e.into_inner());
        o.ended = true;
        for (_, tx) in o.subs.drain(..) {
            let _ = tx.send(Chunk::Exit);
        }
        drop(o);
        emit(&key2, "exit", String::new());
    });
    Ok(Term { serial: next_serial(), master: pair.master, writer, child, program: program.to_string(), out, desktop: false, desk_size: None, size: (cols, rows), started: Instant::now() })
}

// ---------- Desktop (Tauri commands) ----------

/// Starts `program args` in `cwd` inside a new console, unless `key` is already open: then the
/// desktop joins it (the phone opened it) and gets what it showed so far as a `replay` event.
#[tauri::command]
pub fn pty_open(app: tauri::AppHandle, key: String, program: String, args: Vec<String>, cwd: String, cols: u16, rows: u16) -> Result<bool, String> {
    init(app);
    let mut map = terms();
    if let Some(t) = map.get_mut(&key) {
        if t.alive() {
            t.desktop = true;
            t.desk_size = Some((cols, rows));
            emit(&key, "replay", b64(&strip_cursor_queries(&t.out().tail)));
            if t.phones() > 0 {
                emit(&key, "phone", "on".into());
            } else if t.size != (cols.max(20), rows.max(5)) {
                t.resize(cols, rows)?;
            } else {
                t.redraw();
            }
            return Ok(false);
        }
        if let Some(old) = map.remove(&key) {
            old.kill();
        }
    }
    let mut t = spawn(&key, &program, &args, &cwd, cols, rows, false, None)?;
    t.desktop = true;
    t.desk_size = Some((cols, rows));
    map.insert(key, t);
    Ok(true)
}

#[tauri::command]
pub fn pty_write(key: String, data: String) -> Result<(), String> {
    let map = terms();
    map.get(&key).ok_or("That terminal is closed")?.write(data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(key: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut map = terms();
    let Some(t) = map.get_mut(&key) else { return Ok(()) };
    t.desk_size = Some((cols, rows));
    let before = t.size;
    t.resize(cols, rows)?;
    if t.size != before {
        // A phone watching it now gets lines drawn for the PC's width: tell it.
        let size = t.size;
        t.out().subs.retain(|(_, tx)| tx.send(Chunk::Size(size.0, size.1)).is_ok());
    }
    Ok(())
}

/// Closes the console. For `claude attach` this only detaches: the session keeps running.
/// While a phone is watching it, the desktop only lets go and the phone keeps it.
#[tauri::command]
pub fn pty_close(key: String) {
    let mut map = terms();
    let Some(t) = map.get_mut(&key) else { return };
    if t.alive() && t.phones() > 0 {
        t.desktop = false;
        t.desk_size = None;
        return;
    }
    if let Some(t) = map.remove(&key) {
        t.kill();
    }
}

// ---------- Phone (Hangar Remote) ----------

/// A phone watching a console. Drop it through `phone_leave`.
pub struct PhoneView {
    pub serial: u64,
    pub sub: u64,
    pub rx: UnboundedReceiver<Chunk>,
    /// What the console showed before the phone joined.
    pub replay: Vec<u8>,
    /// The desktop window has this console open too.
    pub shared: bool,
    pub cols: u16,
    pub rows: u16,
}

/// Opens session `id` for the phone: joins the console already showing it (the desktop's,
/// or the phone's own from a moment ago), or starts `claude attach <id>` in `cwd`.
/// Callers check first that `id` is a background session Hangar lists.
pub fn phone_join(id: &str, cwd: &str, cols: u16, rows: u16) -> Result<PhoneView, String> {
    let mut map = terms();
    let sub = next_serial();
    let (tx, rx) = unbounded_channel();
    if let Some(t) = map.get_mut(id) {
        if t.alive() {
            if t.program != "claude" {
                return Err("Hangar has something else open under this name.".into());
            }
            let replay = {
                let mut o = t.out();
                o.subs.push((sub, tx));
                strip_cursor_queries(&o.tail)
            };
            if t.size != (cols.max(20), rows.max(5)) {
                t.resize(cols, rows)?;
            } else {
                t.redraw();
            }
            if t.desktop {
                emit(id, "phone", "on".into());
            }
            return Ok(PhoneView { serial: t.serial, sub, rx, replay, shared: t.desktop, cols: t.size.0, rows: t.size.1 });
        }
        if let Some(old) = map.remove(id) {
            old.kill();
        }
    }
    let args = vec!["attach".to_string(), id.to_string()];
    let t = spawn(id, "claude", &args, cwd, cols, rows, true, Some((sub, tx)))?;
    let view = PhoneView { serial: t.serial, sub, rx, replay: Vec::new(), shared: false, cols: t.size.0, rows: t.size.1 };
    map.insert(id.to_string(), t);
    Ok(view)
}

/// The phone stopped watching (switched to Chat, closed the chat, lost the connection).
pub fn phone_leave(id: &str, serial: u64, sub: u64) {
    let mut map = terms();
    let Some(t) = map.get_mut(id) else { return };
    if t.serial != serial {
        return;
    }
    let left = {
        let mut o = t.out();
        o.subs.retain(|(s, _)| *s != sub);
        o.subs.len()
    };
    if left > 0 {
        return;
    }
    if t.desktop {
        if let Some((c, r)) = t.desk_size {
            let _ = t.resize(c, r);
        }
        emit(id, "phone", "off".into());
        return;
    }
    if !t.alive() {
        if let Some(t) = map.remove(id) {
            t.kill();
        }
        return;
    }
    let id = id.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(PHONE_GRACE);
        let mut map = terms();
        let idle = map.get(&id).is_some_and(|t| t.serial == serial && !t.desktop && t.phones() == 0);
        if idle {
            if let Some(t) = map.remove(&id) {
                t.kill();
            }
        }
    });
}

/// Keys from the phone. Only into a Claude console a phone is watching.
pub fn phone_write(id: &str, data: &str) -> Result<(), String> {
    let map = terms();
    match map.get(id) {
        Some(t) if t.program == "claude" && t.alive() && t.phones() > 0 => t.write(data.as_bytes()),
        _ => Err("The terminal isn't open. Open it again.".into()),
    }
}

/// A console that just started drops keys while `claude attach` is still connecting, even though
/// the screen already shows (measured: Down tapped the moment a dialog appeared did
/// nothing; 2.5 s later it worked). How long to hold the phone's next keys, if at all.
const WARMUP: Duration = Duration::from_millis(2500);
pub fn phone_input_wait(id: &str) -> Option<Duration> {
    let map = terms();
    let t = map.get(id)?;
    WARMUP.checked_sub(t.started.elapsed()).filter(|d| !d.is_zero())
}

pub fn phone_resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let mut map = terms();
    match map.get_mut(id) {
        Some(t) if t.program == "claude" && t.alive() && t.phones() > 0 => t.resize(cols, rows),
        _ => Err("The terminal isn't open. Open it again.".into()),
    }
}

/// A live `claude` console for this session is open (on the desktop, the phone or both).
pub fn claude_open(id: &str) -> bool {
    terms().get(id).is_some_and(|t| t.program == "claude" && t.alive())
}

/// Types into that console (a chat message sent while a terminal holds the session).
pub fn type_into(id: &str, bytes: &[u8]) -> Result<(), String> {
    let map = terms();
    match map.get(id) {
        Some(t) if t.program == "claude" && t.alive() => t.write(bytes),
        _ => Err("The terminal closed.".into()),
    }
}

/// How long the console has been quiet (nothing printed), if it has printed anything.
pub fn quiet_for(id: &str) -> Option<Duration> {
    terms().get(id).and_then(|t| t.out().last.map(|l| l.elapsed()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_drop_cursor_questions() {
        assert_eq!(strip_cursor_queries(b"a\x1b[6nb\x1b[6n"), b"ab".to_vec());
        assert_eq!(strip_cursor_queries(b"\x1b[6"), b"\x1b[6".to_vec());
        assert_eq!(strip_cursor_queries(b"\x1b[2J\x1b[H"), b"\x1b[2J\x1b[H".to_vec());
    }

    /// A real console shared by "desktop" and "phone": the phone joins, sees the replay, types,
    /// and the console outlives the phone while the desktop holds it.
    #[test]
    fn phone_shares_a_desktop_console() {
        let key = format!("test-share-{}", std::process::id());
        // Not a claude console: the phone must refuse to join or type into it. (No xterm here to
        // answer the console's cursor question, so this one answers it itself.)
        let mut t = spawn(&key, "cmd.exe", &["/q".into(), "/k".into(), "echo READY".into()], "", 80, 24, true, None).unwrap();
        t.desktop = true;
        terms().insert(key.clone(), t);
        let t0 = Instant::now();
        while !String::from_utf8_lossy(&terms()[&key].out().tail).contains("READY") {
            assert!(t0.elapsed() < Duration::from_secs(15), "console printed nothing");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(phone_join(&key, "", 40, 20).is_err(), "phone joined a non-claude console");
        assert!(phone_write(&key, "x").is_err());

        // Pretend it is a claude console to exercise joining.
        terms().get_mut(&key).unwrap().program = "claude".into();
        let mut v = phone_join(&key, "", 40, 20).unwrap();
        assert!(v.shared);
        assert!(String::from_utf8_lossy(&v.replay).contains("READY"));
        assert_eq!(terms()[&key].size, (40, 20));
        phone_write(&key, "echo PHONE_TYPED\r").unwrap();
        let t0 = Instant::now();
        let mut seen = String::new();
        while !seen.contains("PHONE_TYPED") {
            assert!(t0.elapsed() < Duration::from_secs(15), "phone typing never echoed: {seen:?}");
            if let Ok(Chunk::Data(d)) = v.rx.try_recv() {
                seen.push_str(&String::from_utf8_lossy(&d));
            } else {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        // The desktop resizing while the phone watches tells the phone.
        pty_resize(key.clone(), 100, 30).unwrap();
        let t0 = Instant::now();
        loop {
            match v.rx.try_recv() {
                Ok(Chunk::Size(100, 30)) => break,
                _ if t0.elapsed() > Duration::from_secs(5) => panic!("no size notice"),
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        // The desktop closing while the phone watches keeps the console for the phone.
        pty_close(key.clone());
        assert!(claude_open(&key));
        assert!(!terms()[&key].desktop);
        // The phone leaving with nobody else: it stays for the grace period.
        phone_leave(&key, v.serial, v.sub);
        assert!(claude_open(&key));
        assert!(phone_write(&key, "x").is_err(), "typing without a phone watching");
        if let Some(t) = terms().remove(&key) {
            t.kill();
        }
    }
}
