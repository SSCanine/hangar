//! Hangar Remote: a phone page for Hangar on the home network (port 3622). Off until switched
//! on in Settings. A phone pairs once with a six-digit code Hangar shows and gets its own
//! token; remote.json keeps only the token's hash, so a device can be removed on its own.
//! Every API call needs the token, and only loopback and private-network addresses get an
//! answer at all. The page drives the same Rust the desktop window calls: Claude chats,
//! tool start and stop, and the meters. Home network only: there is no internet relay.

use crate::toolproxy::ToolPath;
use crate::{chats, inbox, registry, roles, sessions, system, toolproxy, tools, uploads, usage};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const PORT: u16 = 3622;
const PAIR_MINUTES: u64 = 10;
const PAIR_TRIES: u32 = 5;
const OLLAMA: &str = "http://127.0.0.1:11434";

const PAGE: &str = include_str!("../remote/index.html");
const MANIFEST: &str = include_str!("../remote/manifest.webmanifest");
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// The phone page with its version stamped in, and that version (a hash of the page). The page compares
/// it with `page` in /api/overview and reloads itself when Hangar has a newer one: a Home Screen app
/// resumed from the background otherwise keeps running the page it loaded before an update.
fn page_build() -> &'static (String, String) {
    static BUILD: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        let version = hash(PAGE)[..12].to_string();
        (PAGE.replace("__HANGAR_PAGE_VERSION__", &version), version)
    })
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
struct Device {
    id: String,
    name: String,
    /// sha256 of the token, hex.
    hash: String,
    created: i64,
    last_seen: i64,
    #[serde(default)]
    last_ip: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct Config {
    enabled: bool,
    #[serde(default)]
    devices: Vec<Device>,
}

struct Pairing {
    code: String,
    until: Instant,
    expires_ms: i64,
    fails: u32,
}

/// What the server and the Settings card share.
pub struct Ctx {
    /// Hangar's app data folder (remote.json, inbox.jsonl, claude-usage.json, logs).
    dir: PathBuf,
    pair: Mutex<Option<Pairing>>,
    /// Serializes remote.json read-modify-write.
    file: Mutex<()>,
    /// Registry file to read instead of the default (tests point this at their own file).
    registry: Option<PathBuf>,
    /// Cookie sessions for `/t/` tool pages (memory only).
    tools: toolproxy::ToolSessions,
}

impl Ctx {
    pub fn new(dir: PathBuf) -> Arc<Ctx> {
        Arc::new(Ctx { dir, pair: Mutex::new(None), file: Mutex::new(()), registry: None, tools: toolproxy::ToolSessions::new() })
    }

    #[cfg(test)]
    pub(crate) fn with_registry(dir: PathBuf, registry: PathBuf) -> Arc<Ctx> {
        Arc::new(Ctx { dir, pair: Mutex::new(None), file: Mutex::new(()), registry: Some(registry), tools: toolproxy::ToolSessions::new() })
    }

    fn registry(&self) -> Result<registry::Registry, String> {
        match &self.registry {
            Some(p) => registry::load_from(p),
            None => registry::load(),
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("remote.json")
    }

    fn load(&self) -> Config {
        std::fs::read_to_string(self.path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Read-modify-write of remote.json. The new file is written aside and renamed over the old
    /// one, so a `load()` running at the same time (a burst of proxied requests) never sees half a file.
    fn edit<T>(&self, f: impl FnOnce(&mut Config) -> T) -> Result<T, String> {
        let _g = self.file.lock().unwrap_or_else(|e| e.into_inner());
        let mut c = self.load();
        let out = f(&mut c);
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = self.dir.join("remote.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&c).unwrap_or_default()).map_err(|e| e.to_string())?;
        let mut tries = 0;
        // A reader holding the file open can make the replace fail for a moment on Windows.
        while let Err(e) = std::fs::rename(&tmp, self.path()) {
            tries += 1;
            if tries >= 5 {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(out)
    }

    /// The paired device a token belongs to; notes when and from where it was last seen.
    fn device_for(&self, token: &str, seen_from: &str) -> Option<String> {
        let hash = hash(token);
        let c = self.load();
        let d = c.devices.iter().find(|d| d.hash == hash)?;
        let now = now_ms();
        if now - d.last_seen > 60_000 || d.last_ip != seen_from {
            let _ = self.edit(|c| {
                if let Some(d) = c.devices.iter_mut().find(|d| d.hash == hash) {
                    d.last_seen = now;
                    d.last_ip = seen_from.to_string();
                }
            });
        }
        Some(d.id.clone())
    }

    fn logs(&self) -> PathBuf {
        self.dir.join("logs")
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source failed");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_code() -> String {
    let mut buf = [0u8; 4];
    getrandom::fill(&mut buf).expect("the OS random source failed");
    format!("{:06}", u32::from_le_bytes(buf) % 1_000_000)
}

/// Loopback and private (home network) ranges only.
pub fn allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback() || v.is_private(),
        IpAddr::V6(v) => v.is_loopback() || v.to_ipv4_mapped().is_some_and(|m| allowed_ip(IpAddr::V4(m))),
    }
}

/// This PC's home-network IPv4 addresses, 192.168.x first (a VPN adapter's 10.x comes last).
fn lan_ips() -> Vec<String> {
    let mut c = std::process::Command::new("ipconfig");
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let text = c.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    lan_ips_in(&text)
}

fn lan_ips_in(ipconfig: &str) -> Vec<String> {
    let mut ips: Vec<std::net::Ipv4Addr> = ipconfig
        .lines()
        .filter(|l| l.contains("IPv4"))
        .filter_map(|l| l.rsplit(':').next()?.trim().trim_end_matches("(Preferred)").trim().parse().ok())
        .filter(|ip: &std::net::Ipv4Addr| ip.is_private())
        .collect();
    ips.sort_by_key(|ip| match ip.octets()[0] {
        192 => 0,
        172 => 1,
        _ => 2,
    });
    ips.dedup();
    ips.into_iter().map(|ip| ip.to_string()).collect()
}

// ---------- Errors ----------

#[derive(Debug)]
struct ApiErr(StatusCode, String);

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<String> for ApiErr {
    fn from(s: String) -> Self {
        ApiErr(StatusCode::INTERNAL_SERVER_ERROR, s)
    }
}

type ApiResult = Result<Json<Value>, ApiErr>;

fn to_json<T: Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

// ---------- Gate ----------

/// The paired device a request was authenticated as.
#[derive(Clone)]
struct DeviceId(String);

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim()
        .to_string()
}

async fn gate(State(ctx): State<Arc<Ctx>>, ConnectInfo(addr): ConnectInfo<SocketAddr>, mut req: Request, next: Next) -> Response {
    let ip = addr.ip();
    if !allowed_ip(ip) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let seen_from = ip.to_string();
    let path = req.uri().path().to_string();
    // A `/t/` request let in by its `hangar_tool` cookie: (value, the session's time left).
    let mut cookie_auth: Option<(String, Duration)> = None;
    if path.starts_with("/api/") && path != "/api/pair" {
        // The cookie never counts here: only a Bearer token opens the API.
        let token = bearer(req.headers());
        match (!token.is_empty()).then(|| ctx.device_for(&token, &seen_from)).flatten() {
            Some(id) => {
                req.extensions_mut().insert(DeviceId(id));
            }
            None => return ApiErr(StatusCode::UNAUTHORIZED, "This phone isn't paired with Hangar.".into()).into_response(),
        }
    } else if path.starts_with("/t/") {
        let token = bearer(req.headers());
        let by_bearer = (!token.is_empty()).then(|| ctx.device_for(&token, &seen_from)).flatten();
        let id = match by_bearer {
            Some(id) => Some(id),
            None => toolproxy::cookie_value(req.headers(), toolproxy::TOOL_COOKIE).and_then(|c| {
                let (dev, left) = ctx.tools.check(&c, Instant::now())?;
                // The device must still be paired; an unpaired phone's cookie is dead.
                if ctx.load().devices.iter().any(|d| d.id == dev) {
                    cookie_auth = Some((c, left));
                    Some(dev)
                } else {
                    None
                }
            }),
        };
        match id {
            Some(id) => {
                req.extensions_mut().insert(DeviceId(id));
            }
            None => {
                if toolproxy::is_navigation(req.method(), req.headers()) {
                    return open_redirect(&req);
                }
                return ApiErr(StatusCode::UNAUTHORIZED, "This phone isn't paired with Hangar.".into()).into_response();
            }
        }
    }
    let mut res = next.run(req).await;
    res.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    res.headers_mut().insert("x-frame-options", "DENY".parse().unwrap());
    if let Some((c, left)) = cookie_auth {
        // Every proxied response re-sends the cookie so the idle window follows use;
        // its Max-Age is what the session has left (never past the 24 h cap).
        if let Ok(v) = HeaderValue::from_str(&toolproxy::tool_cookie(&c, false, left.as_secs())) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

/// A signed-out page load of /t/{id}/... goes to the phone page, which mints a cookie and comes back.
fn open_redirect(req: &Request) -> Response {
    let rest = req.uri().path().strip_prefix("/t/").unwrap_or("");
    let (id, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let mut path = tail.to_string();
    if let Some(q) = req.uri().query() {
        path.push('?');
        path.push_str(q);
    }
    let to = format!("/#open={}&path={}", pct_encode(id), pct_encode(&path));
    (StatusCode::SEE_OTHER, [(header::LOCATION, to)]).into_response()
}

pub fn router(ctx: Arc<Ctx>) -> Router {
    Router::new()
        .route("/", get(page))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.png", get(icon))
        .route("/api/pair", post(pair))
        .route("/api/tool-session", post(tool_session))
        .route("/api/me", get(me))
        .route("/api/overview", get(overview))
        .route("/api/tools", get(tools_list))
        .route("/api/tools/{id}/{action}", post(tool_action))
        .route("/api/chats", get(chats_list))
        .route("/api/chat", get(chat_read))
        .route("/api/chat/send", post(chat_send))
        .route("/api/chat/new", post(chat_new))
        .route("/api/chat/stop", post(chat_stop))
        .route("/api/chat/upload", post(chat_upload).layer(DefaultBodyLimit::max(uploads::UPLOAD_MAX)))
        .route("/api/term", get(term_stream))
        .route("/api/term/write", post(term_write))
        .route("/api/term/resize", post(term_resize))
        .route("/vendor/{file}", get(vendor))
        .route("/api/gpu/free", post(gpu_free))
        .route("/t/{*rest}", any(tool_proxy))
        .layer(middleware::from_fn_with_state(ctx.clone(), gate))
        .with_state(ctx)
}

// ---------- Page ----------

async fn page() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], page_build().0.as_str()).into_response()
}

async fn manifest() -> Response {
    ([(header::CONTENT_TYPE, "application/manifest+json")], MANIFEST).into_response()
}

async fn icon() -> Response {
    ([(header::CONTENT_TYPE, "image/png")], ICON).into_response()
}

// xterm.js for the phone's Terminal, the same build the desktop window uses (build.rs copies it
// out of node_modules). Served by Hangar itself: no CDN. Public library code, so no token needed.
const XTERM_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/xterm.js"));
const XTERM_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/xterm.css"));
const XTERM_FIT_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/addon-fit.js"));

async fn vendor(UrlPath(file): UrlPath<String>) -> Response {
    let (kind, body) = match file.as_str() {
        "xterm.js" => ("text/javascript; charset=utf-8", XTERM_JS),
        "xterm.css" => ("text/css; charset=utf-8", XTERM_CSS),
        "addon-fit.js" => ("text/javascript; charset=utf-8", XTERM_FIT_JS),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CONTENT_TYPE, kind)], body).into_response()
}

// ---------- Tool sessions ----------

/// Trades the paired token for a cookie that opens `/t/` pages (a browser navigation cannot send a Bearer header).
async fn tool_session(State(ctx): State<Arc<Ctx>>, Extension(DeviceId(device)): Extension<DeviceId>) -> Response {
    let value = ctx.tools.mint(&device, Instant::now());
    let cookie = toolproxy::tool_cookie(&value, false, toolproxy::TOOL_IDLE.as_secs());
    match HeaderValue::from_str(&cookie) {
        Ok(v) => ([(header::SET_COOKIE, v)], Json(json!({ "ok": true }))).into_response(),
        Err(e) => ApiErr(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ---------- Pairing ----------

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(default)]
    name: String,
}

async fn pair(State(ctx): State<Arc<Ctx>>, Json(b): Json<PairBody>) -> ApiResult {
    let ok = {
        let mut slot = ctx.pair.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_mut() {
            None => return Err(ApiErr(StatusCode::UNAUTHORIZED, "No pairing is open. In Hangar, open Settings > Phone remote > Pair a phone.".into())),
            Some(p) if Instant::now() > p.until => {
                *slot = None;
                return Err(ApiErr(StatusCode::UNAUTHORIZED, "That code ran out. Make a new one in Hangar.".into()));
            }
            Some(p) if p.code == b.code.trim() => true,
            Some(p) => {
                p.fails += 1;
                if p.fails >= PAIR_TRIES {
                    *slot = None;
                    return Err(ApiErr(StatusCode::UNAUTHORIZED, "Too many wrong codes. Make a new one in Hangar.".into()));
                }
                false
            }
        }
    };
    if !ok {
        return Err(ApiErr(StatusCode::UNAUTHORIZED, "Wrong code.".into()));
    }
    let token = random_hex(32);
    let name: String = b.name.trim().chars().take(40).collect();
    let device = Device {
        id: random_hex(4),
        name: if name.is_empty() { "Phone".into() } else { name },
        hash: hash(&token),
        created: now_ms(),
        last_seen: now_ms(),
        last_ip: String::new(),
    };
    let id = device.id.clone();
    ctx.edit(|c| c.devices.push(device))?;
    Ok(Json(json!({ "token": token, "device": id })))
}

async fn me(State(ctx): State<Arc<Ctx>>, headers: HeaderMap) -> ApiResult {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    let h = hash(token.trim());
    let c = ctx.load();
    let d = c.devices.iter().find(|d| d.hash == h);
    Ok(Json(json!({ "device": d.map(|d| d.id.clone()), "name": d.map(|d| d.name.clone()) })))
}

// ---------- Overview ----------

async fn overview(State(ctx): State<Arc<Ctx>>) -> ApiResult {
    let (sys, gpu) = tokio::join!(system::sys_stats(), system::gpu_stats());
    let inbox_text = std::fs::read(ctx.dir.join("inbox.jsonl")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let mut recent = inbox::parse_lines(&inbox_text, 25);
    recent.reverse();
    // Hangar's short briefs of these replies (lib/brief.ts), when it has made them.
    let briefs: Value = std::fs::read(ctx.dir.join("cache").join("inbox-briefs.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let mut recent = to_json(recent);
    if let Some(list) = recent.as_array_mut() {
        for item in list {
            let brief = item["id"].as_str().and_then(|id| briefs.get(id)).cloned();
            if let (Some(b), Some(obj)) = (brief, item.as_object_mut()) {
                obj.insert("brief".into(), b);
            }
        }
    }
    Ok(Json(json!({
        "sys": to_json(sys),
        "gpu": gpu.ok().map(to_json),
        "usage": usage::read(&ctx.dir.join("claude-usage.json")).map(to_json),
        "inbox": recent,
        "home": std::env::var("USERPROFILE").unwrap_or_default(),
        "open_tools": ctx.registry().ok().map(|r| open_tools(&r)).unwrap_or_default(),
        "page": page_build().1,
    })))
}

// ---------- Tools ----------

/// Tools the phone lists: everything except entries marked `"phone": false`.
fn on_phone(t: &registry::Tool) -> bool {
    t.extra.get("phone").and_then(Value::as_bool) != Some(false)
}

/// Tools the phone can open as pages: `phone_open` and not hidden, in registry order.
fn open_tools(reg: &registry::Registry) -> Vec<Value> {
    let list: Vec<&registry::Tool> = reg.tools.iter().filter(|t| t.phone_open && on_phone(t)).collect();
    list.iter().map(|t| json!({ "id": t.id, "name": t.name, "description": t.description })).collect()
}

async fn tools_list(State(ctx): State<Arc<Ctx>>) -> ApiResult {
    let reg = ctx.registry()?;
    let status = tools::status_all().await?;
    let running = |id: &str| status.iter().any(|s| s.id == id && s.running);
    let list: Vec<Value> = reg
        .tools
        .iter()
        .filter(|t| on_phone(t))
        .map(|t| {
            json!({
                "id": t.id,
                "name": t.name,
                "theme": t.theme,
                "kind": t.kind,
                "description": t.description,
                "gpu": t.gpu,
                "stoppable": t.stoppable,
                "notes": t.notes,
                "can_start": t.start.is_some() || t.exe.is_some(),
                "can_stop": t.port.is_some(),
                "hosted_in": t.hosted_in.as_ref().map(|h| h.tool.clone()),
                "part_of": t.part_of,
                "phone_open": t.phone_open,
                "running": running(&t.id),
            })
        })
        .collect();
    Ok(Json(json!({ "themes": to_json(&reg.themes), "tools": list })))
}

#[derive(Deserialize, Default)]
struct ToolBody {
    #[serde(default)]
    confirmed: bool,
}

async fn tool_action(State(ctx): State<Arc<Ctx>>, UrlPath((id, action)): UrlPath<(String, String)>, body: Option<Json<ToolBody>>) -> ApiResult {
    let tool = registry::find(&id)?;
    if !on_phone(&tool) {
        return Err(ApiErr(StatusCode::FORBIDDEN, format!("{} is not on the phone list", tool.name)));
    }
    match action.as_str() {
        "start" => {
            // Same as the desktop: a GPU tool first frees what Ollama holds, when that's switched on.
            if tool.gpu && tool.id != "ollama" {
                let unload = roles::roles_get().map(|r| r.config["unload_on_gpu_start"] == true).unwrap_or(false);
                if unload {
                    let _ = roles::ollama_unload(OLLAMA.into()).await;
                }
            }
            tools::start_by_id(&ctx.logs(), &id).await?;
            Ok(Json(json!({ "ok": true })))
        }
        "stop" => {
            let confirmed = body.map(|b| b.0.confirmed).unwrap_or(false);
            let n = tools::tool_stop(id, Some(confirmed)).await?;
            Ok(Json(json!({ "ok": true, "stopped": n })))
        }
        _ => Err(ApiErr(StatusCode::NOT_FOUND, "Unknown action".into())),
    }
}

// ---------- Tool pages (/t/{id}/...: the phone opening a local tool's page through Hangar) ----------

const NO_PAGE: &str = "No phone page for that tool.";

fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("the tool proxy's HTTP client")
    })
}

async fn send_upstream(method: &Method, url: &reqwest::Url, headers: &HeaderMap, body: &Bytes) -> reqwest::Result<reqwest::Response> {
    let mut rb = proxy_client().request(method.clone(), url.clone()).headers(headers.clone());
    if !body.is_empty() {
        rb = rb.body(body.clone());
    }
    rb.send().await
}

async fn port_open(url: &reqwest::Url) -> bool {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else { return false };
    let connect = tokio::net::TcpStream::connect(format!("{host}:{port}"));
    matches!(tokio::time::timeout(Duration::from_millis(500), connect).await, Ok(Ok(_)))
}

/// Buffers a small HTML page and adds the back link. A page that turns out bigger than
/// `INJECT_MAX` goes through untouched (what was read so far, then the rest of the stream).
async fn html_with_back_link(up: reqwest::Response) -> Body {
    use futures_util::StreamExt;
    let mut stream = up.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                buf.extend_from_slice(&c);
                if buf.len() > toolproxy::INJECT_MAX {
                    let head = futures_util::stream::once(async move { Ok::<Bytes, reqwest::Error>(Bytes::from(buf)) });
                    return Body::from_stream(head.chain(stream));
                }
            }
            // Cut the page off rather than send half of it as if it were whole.
            Err(e) => return Body::from_stream(futures_util::stream::once(async move { Err::<Bytes, reqwest::Error>(e) })),
        }
    }
    match String::from_utf8(buf) {
        Ok(text) => Body::from(toolproxy::inject_back(&text)),
        Err(e) => Body::from(e.into_bytes()),
    }
}

/// Passes `/t/{id}/...` to a `phone_open` tool on this PC and streams its answer back.
/// The gate has already checked the token or cookie; nothing secret goes on to the tool.
async fn tool_proxy(State(ctx): State<Arc<Ctx>>, req: Request) -> Response {
    let (id, rest) = match toolproxy::split_tool_path(req.uri().path()) {
        ToolPath::Ok { id, rest } => (id, rest),
        ToolPath::NeedsSlash { id } => {
            let mut to = format!("/t/{id}/");
            if let Some(q) = req.uri().query() {
                to.push('?');
                to.push_str(q);
            }
            return (StatusCode::PERMANENT_REDIRECT, [(header::LOCATION, to)]).into_response();
        }
        ToolPath::Bad => return ApiErr(StatusCode::BAD_REQUEST, "Bad path.".into()).into_response(),
        ToolPath::NotFound => return ApiErr(StatusCode::NOT_FOUND, NO_PAGE.into()).into_response(),
    };
    let reg = match ctx.registry() {
        Ok(r) => r,
        Err(e) => return ApiErr::from(e).into_response(),
    };
    let Some(tool) = reg.tools.into_iter().find(|t| t.id == id && t.phone_open && on_phone(t)) else {
        return ApiErr(StatusCode::NOT_FOUND, NO_PAGE.into()).into_response();
    };
    let base = tool.url.clone().unwrap_or_default();
    let (Ok(target), Ok(base_url)) = (toolproxy::target_url(&base, &rest, req.uri().query()), reqwest::Url::parse(&base)) else {
        return ApiErr(StatusCode::FORBIDDEN, "That tool isn't on this PC.".into()).into_response();
    };
    let (parts, body) = req.into_parts();
    let Ok(body) = axum::body::to_bytes(body, toolproxy::BODY_MAX).await else {
        return ApiErr(StatusCode::PAYLOAD_TOO_LARGE, "That's over 25 MB.".into()).into_response();
    };
    let headers = toolproxy::forward_request_headers(&parts.headers, &id);
    let document = toolproxy::is_document_request(&parts.method, &parts.headers);
    let method = parts.method;

    let mut sent = send_upstream(&method, &target, &headers, &body).await;
    if matches!(&sent, Err(e) if e.is_connect()) && (tool.start.is_some() || tool.exe.is_some()) {
        // Not running: start it like the Tools tab would, wait up to 15 s for its port, try once more.
        if tools::start_by_id(&ctx.logs(), &tool.id).await.is_ok() {
            let until = Instant::now() + Duration::from_secs(15);
            while Instant::now() < until && !port_open(&target).await {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            sent = send_upstream(&method, &target, &headers, &body).await;
        }
    }
    let up = match sent {
        Ok(r) => r,
        Err(e) if e.is_connect() => return ApiErr(StatusCode::BAD_GATEWAY, format!("{} isn't running and didn't start.", tool.name)).into_response(),
        Err(_) => return ApiErr(StatusCode::BAD_GATEWAY, format!("{} didn't answer.", tool.name)).into_response(),
    };

    let status = up.status();
    let out_headers = toolproxy::copy_response_headers(up.headers(), &base_url, &id);
    let is_html = up
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("text/html"));
    let injectable = document
        && is_html
        && !up.headers().contains_key(header::CONTENT_ENCODING)
        && up.content_length().is_none_or(|n| n <= toolproxy::INJECT_MAX as u64)
        && method != Method::HEAD
        && (status.is_success() || status.is_client_error() || status.is_server_error())
        && !matches!(status.as_u16(), 204 | 206);
    let body = if injectable { html_with_back_link(up).await } else { Body::from_stream(up.bytes_stream()) };
    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = out_headers;
    res
}

// ---------- Chats ----------

async fn chats_list() -> ApiResult {
    Ok(Json(to_json(chats::chats_list(true).await?)))
}

#[derive(Deserialize)]
struct ChatQuery {
    session_id: String,
    #[serde(default)]
    cwd: String,
    /// The stamp the page already has; unchanged = no messages sent back.
    #[serde(default)]
    known: String,
    #[serde(default)]
    limit: Option<usize>,
}

async fn chat_read(Query(q): Query<ChatQuery>) -> ApiResult {
    let Some((len, ms)) = sessions::session_stamp(q.session_id.clone(), q.cwd.clone()) else {
        // A session that just started has no transcript yet; the page keeps polling.
        return Ok(Json(json!({ "stamp": "", "conversation": null, "missing": true })));
    };
    let stamp = format!("{len}-{ms}");
    if !q.known.is_empty() && q.known == stamp {
        return Ok(Json(json!({ "stamp": stamp, "conversation": null })));
    }
    let conv = sessions::session_read(q.session_id, q.cwd, Some(q.limit.unwrap_or(80).min(400)), Some(false)).await?;
    Ok(Json(json!({ "stamp": stamp, "conversation": to_json(conv) })))
}

#[derive(Deserialize)]
struct SendBody {
    id: String,
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    name: String,
    text: String,
}

async fn chat_send(Json(b): Json<SendBody>) -> Response {
    match chats::chats_send(b.id, b.session_id, b.cwd, b.name, b.text).await {
        Ok(sent) => Json(to_json(sent)).into_response(),
        // A dialog is open: the page offers its Terminal instead of a dead end.
        Err(e) if e == chats::DIALOG_OPEN => (StatusCode::CONFLICT, Json(json!({ "error": "Claude is asking you something. Answer it in the Terminal.", "dialog": true }))).into_response(),
        Err(e) => ApiErr::from(e).into_response(),
    }
}

// ---------- Terminal (a chat's live console, shared with the desktop window) ----------

#[derive(Deserialize)]
struct TermQuery {
    id: String,
    #[serde(default)]
    cols: u16,
    #[serde(default)]
    rows: u16,
}

/// A background session `claude agents` lists, or why the phone can't open its terminal.
async fn listed_background(id: &str) -> Result<chats::ChatSession, ApiErr> {
    if !chats::valid(id) {
        return Err(ApiErr(StatusCode::BAD_REQUEST, "Not a session id".into()));
    }
    let list = chats::chats_list(true).await?;
    let Some(c) = list.into_iter().find(|c| c.id == id) else {
        return Err(ApiErr(StatusCode::NOT_FOUND, "Hangar doesn't list that session anymore.".into()));
    };
    if c.kind != "background" {
        return Err(ApiErr(StatusCode::BAD_REQUEST, "This chat runs in its own terminal or VS Code window, so Hangar can't open it here.".into()));
    }
    Ok(c)
}

fn sse(event: &str, data: &str) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

/// Lets go of the console when the phone's stream ends (closed, switched to Chat, connection lost).
struct Leave {
    id: String,
    serial: u64,
    sub: u64,
}

impl Drop for Leave {
    fn drop(&mut self) {
        crate::pty::phone_leave(&self.id, self.serial, self.sub);
    }
}

/// Opens a chat's terminal for the phone and streams it as server-sent events:
/// `hello` {shared, cols, rows}, `replay` and `data` (base64 console output), `size` (the PC
/// window resized it), `exit`. Only `claude attach` of a background session Hangar lists, never a shell.
async fn term_stream(Query(q): Query<TermQuery>) -> Result<Response, ApiErr> {
    let c = listed_background(&q.id).await?;
    let (id, cwd) = (q.id.clone(), c.cwd.clone());
    let (cols, rows) = (if q.cols == 0 { 50 } else { q.cols.min(400) }, if q.rows == 0 { 24 } else { q.rows.min(200) });
    let view = tokio::task::spawn_blocking(move || crate::pty::phone_join(&id, &cwd, cols, rows))
        .await
        .map_err(|e| ApiErr::from(e.to_string()))??;
    let b64 = |b: &[u8]| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b);
    let first = vec![
        sse("hello", &json!({ "shared": view.shared, "cols": view.cols, "rows": view.rows }).to_string()),
        sse("replay", &b64(&view.replay)),
    ];
    let leave = Leave { id: q.id.clone(), serial: view.serial, sub: view.sub };
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let state = (first.into_iter(), view.rx, leave, tick, false);
    let stream = futures_util::stream::unfold(state, move |(mut first, mut rx, leave, mut tick, done)| async move {
        if done {
            return None;
        }
        if let Some(f) = first.next() {
            return Some((Ok::<Bytes, std::convert::Infallible>(f), (first, rx, leave, tick, false)));
        }
        loop {
            tokio::select! {
                c = rx.recv() => {
                    let (frame, end) = match c {
                        Some(crate::pty::Chunk::Data(d)) => (sse("data", &b64(&d)), false),
                        Some(crate::pty::Chunk::Size(c, r)) => (sse("size", &json!({ "cols": c, "rows": r }).to_string()), false),
                        Some(crate::pty::Chunk::Exit) | None => (sse("exit", ""), true),
                    };
                    return Some((Ok(frame), (first, rx, leave, tick, end)));
                }
                // Keeps iOS from dropping a quiet stream, and notices a phone that left.
                _ = tick.tick() => return Some((Ok(Bytes::from_static(b": k\n\n")), (first, rx, leave, tick, false))),
            }
        }
    });
    let mut res = Response::new(Body::from_stream(stream));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    res.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(res)
}

#[derive(Deserialize)]
struct TermWrite {
    id: String,
    data: String,
}

async fn term_write(Json(b): Json<TermWrite>) -> ApiResult {
    if !chats::valid(&b.id) || b.data.len() > 16 * 1024 {
        return Err(ApiErr(StatusCode::BAD_REQUEST, "Not something to type".into()));
    }
    if let Some(wait) = crate::pty::phone_input_wait(&b.id) {
        tokio::time::sleep(wait).await;
    }
    crate::pty::phone_write(&b.id, &b.data).map_err(|e| ApiErr(StatusCode::NOT_FOUND, e))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TermSize {
    id: String,
    cols: u16,
    rows: u16,
}

async fn term_resize(Json(b): Json<TermSize>) -> ApiResult {
    if !chats::valid(&b.id) {
        return Err(ApiErr(StatusCode::BAD_REQUEST, "Not a session id".into()));
    }
    crate::pty::phone_resize(&b.id, b.cols.min(400), b.rows.min(200)).map_err(|e| ApiErr(StatusCode::NOT_FOUND, e))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NewBody {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    prompt: String,
}

async fn chat_new(Json(b): Json<NewBody>) -> ApiResult {
    let cwd = if b.cwd.trim().is_empty() { std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()) } else { b.cwd };
    let id = chats::chats_new(cwd, b.name, b.prompt).await?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct StopBody {
    id: String,
}

async fn chat_stop(Json(b): Json<StopBody>) -> ApiResult {
    chats::chats_stop(b.id).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- GPU ----------

async fn gpu_free() -> ApiResult {
    let gone = roles::ollama_unload(OLLAMA.into()).await?;
    Ok(Json(json!({ "unloaded": to_json(gone) })))
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    name: String,
}

/// Raw body upload; the route's DefaultBodyLimit answers 413 for anything over 25 MiB.
async fn chat_upload(State(ctx): State<Arc<Ctx>>, Query(q): Query<UploadQuery>, body: Bytes) -> ApiResult {
    if body.is_empty() {
        return Err(ApiErr(StatusCode::BAD_REQUEST, "Empty file.".into()));
    }
    let name = uploads::sanitize_name(&q.name);
    if !uploads::allowed_ext(&name) {
        return Err(ApiErr(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Hangar takes photos, PDFs, text and Office files.".into()));
    }
    let path = uploads::save_upload(&ctx.dir, &name, &body)?;
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Json(json!({ "path": path.to_string_lossy(), "name": file, "size": body.len() })))
}

// ---------- Server lifecycle + Settings commands ----------

pub struct RemoteState {
    ctx: Arc<Ctx>,
    server: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    error: Mutex<String>,
}

impl RemoteState {
    pub fn new(dir: PathBuf) -> Self {
        RemoteState { ctx: Ctx::new(dir), server: Mutex::new(None), error: Mutex::new(String::new()) }
    }

    fn set_error(&self, msg: &str) {
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = msg.to_string();
    }

    fn running(&self) -> bool {
        self.server.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|tx| !tx.is_closed())
    }

    fn start(&self) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        let tx = serve(self.ctx.clone(), PORT).map_err(|e| {
            let msg = format!("Couldn't open port {PORT}: {e}");
            self.set_error(&msg);
            msg
        })?;
        self.set_error("");
        *self.server.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        Ok(())
    }

    fn stop(&self) {
        if let Some(tx) = self.server.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
        }
        *self.ctx.pair.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.ctx.tools.clear();
    }
}

/// Binds now (so a busy port is reported right away) and serves until the sender fires.
pub fn serve(ctx: Arc<Ctx>, port: u16) -> std::io::Result<tokio::sync::oneshot::Sender<()>> {
    let listener = std::net::TcpListener::bind(("0.0.0.0", port))?;
    listener.set_nonblocking(true)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        let app = router(ctx).into_make_service_with_connect_info::<SocketAddr>();
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(tx)
}

/// Turns the server on at Hangar's start when it was left on.
pub fn autostart(app: &tauri::AppHandle) {
    let st = app.state::<RemoteState>();
    if st.ctx.load().enabled {
        let _ = st.start();
    }
}

/// Hangar is closing: stop serving (the server dies with the process anyway).
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(st) = app.try_state::<RemoteState>() {
        st.stop();
    }
}

#[derive(Serialize)]
pub struct DeviceView {
    id: String,
    name: String,
    created: i64,
    last_seen: i64,
    last_ip: String,
}

#[derive(Serialize)]
pub struct PairView {
    code: String,
    url: String,
    qr: String,
    expires: i64,
}

#[derive(Serialize)]
pub struct RemoteView {
    enabled: bool,
    running: bool,
    port: u16,
    urls: Vec<String>,
    devices: Vec<DeviceView>,
    error: String,
    pairing: Option<PairView>,
}

fn pair_view(code: &str, expires: i64, base: &str) -> PairView {
    let url = format!("{base}/#pair={code}");
    let qr = qrcode::QrCode::new(url.as_bytes())
        .map(|q| {
            q.render::<qrcode::render::svg::Color>()
                .min_dimensions(220, 220)
                .dark_color(qrcode::render::svg::Color("#161a2e"))
                .light_color(qrcode::render::svg::Color("#ffffff"))
                .build()
        })
        .unwrap_or_default();
    PairView { code: code.into(), url, qr, expires }
}

fn view(st: &RemoteState) -> RemoteView {
    let c = st.ctx.load();
    let urls: Vec<String> = lan_ips().into_iter().map(|ip| format!("http://{ip}:{PORT}")).collect();
    let pair_base = urls.first().cloned().unwrap_or_else(|| format!("http://127.0.0.1:{PORT}"));
    let pairing = {
        let slot = st.ctx.pair.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref().filter(|p| Instant::now() < p.until).map(|p| pair_view(&p.code, p.expires_ms, &pair_base))
    };
    RemoteView {
        enabled: c.enabled,
        running: st.running(),
        port: PORT,
        urls,
        devices: c
            .devices
            .into_iter()
            .map(|d| DeviceView {
                id: d.id,
                name: d.name,
                created: d.created,
                last_seen: d.last_seen,
                last_ip: d.last_ip,
            })
            .collect(),
        error: st.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        pairing,
    }
}

#[tauri::command]
pub fn remote_status(st: tauri::State<'_, RemoteState>) -> RemoteView {
    view(&st)
}

#[tauri::command]
pub fn remote_set(st: tauri::State<'_, RemoteState>, enabled: bool) -> Result<RemoteView, String> {
    st.ctx.edit(|c| c.enabled = enabled)?;
    if enabled {
        st.start()?;
    } else {
        st.stop();
    }
    Ok(view(&st))
}

/// Opens a ten-minute pairing window with a fresh six-digit code.
#[tauri::command]
pub fn remote_pair(st: tauri::State<'_, RemoteState>) -> Result<RemoteView, String> {
    if !st.running() {
        return Err("Turn Phone remote on first.".into());
    }
    let mins = Duration::from_secs(PAIR_MINUTES * 60);
    *st.ctx.pair.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Pairing { code: random_code(), until: Instant::now() + mins, expires_ms: now_ms() + mins.as_millis() as i64, fails: 0 });
    Ok(view(&st))
}

#[tauri::command]
pub fn remote_pair_cancel(st: tauri::State<'_, RemoteState>) -> RemoteView {
    *st.ctx.pair.lock().unwrap_or_else(|e| e.into_inner()) = None;
    view(&st)
}

/// Unpairs one device; its token stops working on its next request.
#[tauri::command]
pub fn remote_revoke(st: tauri::State<'_, RemoteState>, id: String) -> Result<RemoteView, String> {
    st.ctx.edit(|c| c.devices.retain(|d| d.id != id))?;
    st.ctx.tools.drop_device(&id);
    Ok(view(&st))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_home_addresses_pass() {
        for ip in ["127.0.0.1", "192.168.0.20", "10.0.0.5", "172.20.1.1", "::1", "::ffff:192.168.0.5"] {
            assert!(allowed_ip(ip.parse().unwrap()), "{ip} should pass");
        }
        for ip in ["8.8.8.8", "100.101.102.103", "100.128.0.1", "172.32.0.1", "2001:4860::1", "::ffff:1.1.1.1"] {
            assert!(!allowed_ip(ip.parse().unwrap()), "{ip} should be refused");
        }
    }

    #[test]
    fn page_carries_its_version() {
        let (page, version) = page_build();
        assert_eq!(version.len(), 12);
        assert!(!page.contains("__HANGAR_PAGE_VERSION__"));
        assert!(page.contains(&format!("const PAGE_VERSION = \"{version}\";")));
    }

    #[test]
    fn lan_ips_put_home_network_first() {
        let text = "   IPv4 Address. . . . . . . . . . . : 10.8.0.2\r\n\
                    \x20  IPv4 Address. . . . . . . . . . . : 192.168.0.20(Preferred)\r\n\
                    \x20  IPv4 Address. . . . . . . . . . . : 8.8.4.4\r\n";
        assert_eq!(lan_ips_in(text), vec!["192.168.0.20", "10.8.0.2"]);
    }

    #[test]
    fn codes_are_six_digits_and_tokens_hash_stably() {
        for _ in 0..50 {
            let c = random_code();
            assert!(c.len() == 6 && c.chars().all(|ch| ch.is_ascii_digit()));
        }
        assert_eq!(hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_ne!(random_hex(32), random_hex(32));
    }

    #[test]
    fn pair_qr_is_svg_with_code_in_link() {
        let p = pair_view("123456", 0, "http://192.168.0.20:3622");
        assert_eq!(p.url, "http://192.168.0.20:3622/#pair=123456");
        assert!(p.qr.contains("<svg"));
    }

    fn test_ctx(tag: &str) -> Arc<Ctx> {
        let dir = std::env::temp_dir().join(format!("hangar-remote-{tag}-{}-{}", std::process::id(), random_hex(3)));
        // Its own empty tool list: tests never read or create the repo's registry/tools.json.
        let reg = write_test_registry(&dir, json!([]));
        Ctx::with_registry(dir, reg)
    }

    /// End to end over real HTTP: refuses without a token, pairs with the code, wrong codes
    /// burn out, revoked tokens stop working. Read-only calls only (tools status, chats list).
    /// `REMOTE_HOLD_SECS=600 cargo test remote_live -- --ignored --nocapture` keeps it up for a browser.
    #[test]
    #[ignore]
    fn remote_live() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        tauri::async_runtime::set(rt.handle().clone());
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("hangar-remote-test-{}", std::process::id()));
            let ctx = Ctx::new(dir.clone());
            let port: u16 = std::env::var("REMOTE_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3629);
            let _tx = serve(ctx.clone(), port).unwrap();
            let base = format!("http://127.0.0.1:{port}");
            let c = reqwest::Client::builder().no_proxy().build().unwrap();

            assert_eq!(c.get(format!("{base}/api/tools")).send().await.unwrap().status(), 401);
            let r = c.post(format!("{base}/api/pair")).json(&json!({"code":"000000"})).send().await.unwrap();
            assert_eq!(r.status(), 401, "no pairing open yet");

            *ctx.pair.lock().unwrap() = Some(Pairing { code: "424242".into(), until: Instant::now() + Duration::from_secs(600), expires_ms: 0, fails: 0 });
            let r = c.post(format!("{base}/api/pair")).json(&json!({"code":"111111"})).send().await.unwrap();
            assert_eq!(r.status(), 401);
            let r: Value = c.post(format!("{base}/api/pair")).json(&json!({"code":"424242","name":"Test phone"})).send().await.unwrap().json().await.unwrap();
            let token = r["token"].as_str().unwrap().to_string();
            let auth = format!("Bearer {token}");

            let page = c.get(&base).send().await.unwrap().text().await.unwrap();
            assert!(page.contains("Hangar"));
            let tools: Value = c.get(format!("{base}/api/tools")).header("Authorization", &auth).send().await.unwrap().json().await.unwrap();
            let list = tools["tools"].as_array().unwrap();
            assert!(!list.is_empty(), "registry tools listed");
            let ov: Value = c.get(format!("{base}/api/overview")).header("Authorization", &auth).send().await.unwrap().json().await.unwrap();
            assert!(ov["sys"]["mem_total"].as_u64().unwrap() > 0);
            let chats = c.get(format!("{base}/api/chats")).header("Authorization", &auth).send().await.unwrap();
            assert_eq!(chats.status(), 200);

            if let Some(secs) = std::env::var("REMOTE_HOLD_SECS").ok().and_then(|s| s.parse::<u64>().ok()) {
                let code = random_code();
                *ctx.pair.lock().unwrap() = Some(Pairing { code: code.clone(), until: Instant::now() + Duration::from_secs(secs), expires_ms: 0, fails: 0 });
                println!("holding {base} for {secs}s, pair code {code}, token {token}");
                tokio::time::sleep(Duration::from_secs(secs)).await;
            }

            let id = ctx.load().devices[0].id.clone();
            ctx.edit(|c| c.devices.retain(|d| d.id != id)).unwrap();
            assert_eq!(c.get(format!("{base}/api/tools")).header("Authorization", &auth).send().await.unwrap().status(), 401);
            println!("test data left in {}", dir.display());
        });
    }

    async fn serve_test(ctx: Arc<Ctx>) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(l, router(ctx).into_make_service_with_connect_info::<SocketAddr>()).await;
        });
        format!("http://127.0.0.1:{port}")
    }

    fn pair_test_device(ctx: &Ctx, id: &str) -> String {
        let token = random_hex(16);
        let h = hash(&token);
        let id = id.to_string();
        ctx.edit(|c| c.devices.push(Device { id, name: "Test phone".into(), hash: h, created: now_ms(), last_seen: now_ms(), ..Default::default() })).unwrap();
        token
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
    }

    fn write_test_registry(dir: &std::path::Path, tools: Value) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("tools.json");
        std::fs::write(&p, serde_json::to_string(&json!({"version":1,"themes":[],"tools":tools})).unwrap()).unwrap();
        p
    }

    async fn mint_cookie(c: &reqwest::Client, base: &str, token: &str) -> String {
        let r = c.post(format!("{base}/api/tool-session")).header("Authorization", format!("Bearer {token}")).send().await.unwrap();
        let sc = r.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
        sc.split(';').next().unwrap().to_string() // hangar_tool=<value>
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tool_session_endpoint_sets_cookie() {
        let ctx = test_ctx("toolsess");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx.clone()).await;
        let c = test_client();
        let url = format!("{base}/api/tool-session");
        assert_eq!(c.post(&url).send().await.unwrap().status(), 401);
        let r = c.post(&url).header("Authorization", format!("Bearer {token}")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let sc = r.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
        assert!(sc.starts_with("hangar_tool="), "{sc}");
        for f in ["HttpOnly", "SameSite=Strict", "Path=/t/"] {
            assert!(sc.contains(f), "{sc}");
        }
        assert!(!sc.contains("Secure"), "{sc}");
        assert_eq!(r.json::<Value>().await.unwrap(), json!({"ok": true}));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cookie_passes_gate_for_t_paths() {
        let ctx = test_ctx("toolgate");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx.clone()).await;
        let c = test_client();
        let cookie = mint_cookie(&c, &base, &token).await;

        assert_eq!(c.get(format!("{base}/t/x/")).send().await.unwrap().status(), 401);
        let r = c.get(format!("{base}/t/x/")).header("Cookie", &cookie).send().await.unwrap();
        assert_eq!(r.status(), 404, "gate passed; no tool x");
        let refreshed = r.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(refreshed.starts_with(&cookie) && refreshed.contains("Max-Age=7200"), "{refreshed}");
        assert_eq!(c.get(format!("{base}/t/x/")).header("Authorization", format!("Bearer {token}")).send().await.unwrap().status(), 404);

        let r = c.get(format!("{base}/t/x/")).header("sec-fetch-mode", "navigate").send().await.unwrap();
        assert_eq!(r.status(), 303);
        assert_eq!(r.headers()[header::LOCATION], "/#open=x&path=%2F");
        let r = c.get(format!("{base}/t/x/a%20b?q=1")).header("sec-fetch-mode", "navigate").send().await.unwrap();
        assert_eq!(r.headers()[header::LOCATION], "/#open=x&path=%2Fa%2520b%3Fq%3D1");

        assert_eq!(c.get(format!("{base}/api/tools")).header("Cookie", &cookie).send().await.unwrap().status(), 401, "never on /api/");
        assert_eq!(c.get(format!("{base}/t/x/")).header("Cookie", "hangar_tool=deadbeef").send().await.unwrap().status(), 401);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn revoked_device_cookie_refused() {
        let ctx = test_ctx("toolrevoke");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx.clone()).await;
        let c = test_client();
        let cookie = mint_cookie(&c, &base, &token).await;
        assert_eq!(c.get(format!("{base}/t/x/")).header("Cookie", &cookie).send().await.unwrap().status(), 404);
        ctx.edit(|c| c.devices.retain(|d| d.id != "d1")).unwrap();
        assert_eq!(c.get(format!("{base}/t/x/")).header("Cookie", &cookie).send().await.unwrap().status(), 401);
    }


    /// remote.json is replaced whole: a reader racing a burst of writes never sees half a file
    /// (which `load()` would turn into "no devices" and a 401).
    #[test]
    fn remote_json_never_read_half_written() {
        let ctx = test_ctx("atomic");
        pair_test_device(&ctx, "d1");
        let writer = {
            let ctx = ctx.clone();
            std::thread::spawn(move || {
                for i in 0..300 {
                    ctx.edit(|c| c.devices[0].last_seen = i).unwrap();
                }
            })
        };
        let (mut reads, mut bad) = (0, Vec::new());
        while !writer.is_finished() {
            reads += 1;
            match std::fs::read_to_string(ctx.path()) {
                Ok(t) if serde_json::from_str::<Config>(&t).is_ok_and(|c| c.devices.len() == 1) => {}
                Ok(t) => bad.push(format!("parse: {:?}", t.chars().take(40).collect::<String>())),
                Err(e) => bad.push(format!("read: {e}")),
            }
        }
        writer.join().unwrap();
        assert!(bad.is_empty(), "{} of {reads} reads were bad, first: {}", bad.len(), bad[0]);
        assert_eq!(ctx.load().devices[0].last_seen, 299);
    }

    /// A stand-in tool on 127.0.0.1:0. Unknown paths echo the request back as JSON.
    async fn fake_tool() -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let app = Router::new()
            .route("/page", get(|| async { ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], "<html><body>hi</body></html>") }))
            .route("/redir-root", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/inside".to_string())]) }))
            .route("/redir-abs", get(move || async move { (StatusCode::FOUND, [(header::LOCATION, format!("http://127.0.0.1:{port}/abs"))]) }))
            .route("/redir-rel", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "next".to_string())]) }))
            .route("/set-cookie", get(|| async { ([(header::SET_COOKIE, "s=1")], "ok") }))
            .fallback(|req: Request| async move {
                let (parts, body) = req.into_parts();
                let body = axum::body::to_bytes(body, usize::MAX).await.unwrap();
                let headers: serde_json::Map<String, Value> = parts.headers.iter().map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or("")))).collect();
                Json(json!({
                    "method": parts.method.as_str(),
                    "path": parts.uri.path(),
                    "query": parts.uri.query(),
                    "body_len": body.len(),
                    "headers": headers,
                }))
            });
        tokio::spawn(async move {
            let _ = axum::serve(l, app).await;
        });
        port
    }

    /// A port nothing listens on.
    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn proxy_ctx(port: u16, down_port: u16) -> Arc<Ctx> {
        let dir = std::env::temp_dir().join(format!("hangar-proxy-{}-{}", std::process::id(), random_hex(3)));
        let tool = |id: &str, name: &str, url: String, extra: Value| {
            let mut v = json!({ "id": id, "name": name, "theme": "utility", "kind": "web", "url": url });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let reg = write_test_registry(
            &dir,
            json!([
                tool("nt", "Notes", format!("http://127.0.0.1:{port}/"), json!({ "phone_open": true })),
                tool("plain", "Plain", format!("http://127.0.0.1:{port}/"), json!({})),
                tool("hidden", "Hidden", format!("http://127.0.0.1:{port}/"), json!({ "phone_open": true, "phone": false })),
                tool("remote-ish", "Remote-ish", "http://example.com/".into(), json!({ "phone_open": true })),
                tool("down", "Down Tool", format!("http://127.0.0.1:{down_port}/"), json!({ "phone_open": true })),
            ]),
        );
        Ctx::with_registry(dir, reg)
    }

    /// (base, bearer token) for a proxy test server with one paired phone.
    async fn proxy_setup() -> (Arc<Ctx>, String, String) {
        let ctx = proxy_ctx(fake_tool().await, closed_port());
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx.clone()).await;
        (ctx, base, token)
    }

    fn bearer_of(token: &str) -> String {
        format!("Bearer {token}")
    }

    /// Status of a GET sent byte for byte (reqwest would tidy `%2e%2e` and `\` away before sending).
    async fn raw_get_status(base: &str, path: &str, token: &str) -> u16 {
        use std::io::{Read, Write};
        let addr = base.strip_prefix("http://").unwrap().to_string();
        let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n");
        tokio::task::spawn_blocking(move || {
            let mut s = std::net::TcpStream::connect(&addr).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut out = Vec::new();
            let _ = s.read_to_end(&mut out);
            String::from_utf8_lossy(&out)[9..12].parse().unwrap()
        })
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_requires_auth() {
        let (_ctx, base, _token) = proxy_setup().await;
        let c = test_client();
        assert_eq!(c.get(format!("{base}/t/nt/x")).send().await.unwrap().status(), 401);
        let r = c.get(format!("{base}/t/nt/page?a=1")).header("sec-fetch-mode", "navigate").send().await.unwrap();
        assert_eq!(r.status(), 303);
        assert_eq!(r.headers()[header::LOCATION], "/#open=nt&path=%2Fpage%3Fa%3D1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_forwards_with_bearer_and_cookie() {
        let (_ctx, base, token) = proxy_setup().await;
        let c = test_client();
        let r = c.get(format!("{base}/t/nt/api/echo")).header("Authorization", bearer_of(&token)).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.headers().get(header::SET_COOKIE).is_none(), "a Bearer request gets no cookie");
        assert_eq!(r.json::<Value>().await.unwrap()["path"], "/api/echo");

        let cookie = mint_cookie(&c, &base, &token).await;
        let r = c.get(format!("{base}/t/nt/api/echo")).header("Cookie", &cookie).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let sc = r.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
        assert!(sc.starts_with(&cookie) && sc.contains("Max-Age=7200") && !sc.contains("Secure"), "{sc}");
        assert_eq!(r.json::<Value>().await.unwrap()["path"], "/api/echo");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_strips_secrets_from_upstream_request() {
        let (_ctx, base, token) = proxy_setup().await;
        let c = test_client();
        let cookie = mint_cookie(&c, &base, &token).await;
        let r = c
            .post(format!("{base}/t/nt/api/echo?x=1&y=two"))
            .header("Authorization", bearer_of(&token))
            .header("Cookie", format!("{cookie}; other=1"))
            .header("content-type", "text/plain")
            .body("abc")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let echo: Value = r.json().await.unwrap();
        assert_eq!(echo["method"], "POST");
        assert_eq!(echo["query"], "x=1&y=two");
        assert_eq!(echo["body_len"], 3);
        let h = &echo["headers"];
        assert_eq!(h["content-type"], "text/plain");
        for k in ["authorization", "cookie"] {
            assert!(h.get(k).is_none(), "{k} reached the tool: {h}");
        }
        assert_eq!(h["x-forwarded-prefix"], "/t/nt");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_rewrites_redirects() {
        let (_ctx, base, token) = proxy_setup().await;
        let c = test_client();
        for (path, want) in [("redir-root", "/t/nt/inside"), ("redir-abs", "/t/nt/abs"), ("redir-rel", "next")] {
            let r = c.get(format!("{base}/t/nt/{path}")).header("Authorization", bearer_of(&token)).send().await.unwrap();
            assert_eq!(r.status(), 302, "{path}");
            assert_eq!(r.headers()[header::LOCATION], want, "{path}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_adds_trailing_slash() {
        let (_ctx, base, token) = proxy_setup().await;
        let r = test_client().get(format!("{base}/t/nt")).header("Authorization", bearer_of(&token)).send().await.unwrap();
        assert_eq!(r.status(), 308);
        assert_eq!(r.headers()[header::LOCATION], "/t/nt/");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_refuses_unlisted_tools() {
        let (_ctx, base, token) = proxy_setup().await;
        let c = test_client();
        for id in ["plain", "hidden", "nope"] {
            let r = c.get(format!("{base}/t/{id}/")).header("Authorization", bearer_of(&token)).send().await.unwrap();
            assert_eq!(r.status(), 404, "{id}");
            assert_eq!(r.json::<Value>().await.unwrap(), json!({"error": "No phone page for that tool."}));
        }
        let r = c.get(format!("{base}/t/remote-ish/")).header("Authorization", bearer_of(&token)).send().await.unwrap();
        assert_eq!(r.status(), 403);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({"error": "That tool isn't on this PC."}));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_rejects_path_tricks() {
        let (_ctx, base, token) = proxy_setup().await;
        for path in ["/t/nt/%2e%2e/x", "/t/nt/a/%2E%2e/x", "/t/nt/a%2Fb", "/t/nt/a%5cb", "/t/nt//evil.com/x"] {
            assert_eq!(raw_get_status(&base, path, &token).await, 400, "{path}");
        }
        let r = test_client().get(format!("{base}/t/nt/@example.com/x")).header("Authorization", bearer_of(&token)).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Value>().await.unwrap()["path"], "/@example.com/x");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_body_limit_413() {
        let (_ctx, base, token) = proxy_setup().await;
        let big = vec![b'x'; toolproxy::BODY_MAX + 1];
        let r = test_client().post(format!("{base}/t/nt/api/echo")).header("Authorization", bearer_of(&token)).body(big).send().await.unwrap();
        assert_eq!(r.status(), 413);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({"error": "That's over 25 MB."}));
        let ok = vec![b'x'; toolproxy::BODY_MAX];
        let r = test_client().post(format!("{base}/t/nt/api/echo")).header("Authorization", bearer_of(&token)).body(ok).send().await.unwrap();
        assert_eq!(r.json::<Value>().await.unwrap()["body_len"], toolproxy::BODY_MAX);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_upstream_down_502() {
        let (_ctx, base, token) = proxy_setup().await;
        let r = test_client().get(format!("{base}/t/down/")).header("Authorization", bearer_of(&token)).send().await.unwrap();
        assert_eq!(r.status(), 502);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({"error": "Down Tool isn't running and didn't start."}));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_drops_upstream_set_cookie() {
        let (_ctx, base, token) = proxy_setup().await;
        let r = test_client().get(format!("{base}/t/nt/set-cookie")).header("Authorization", bearer_of(&token)).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(r.text().await.unwrap(), "ok");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_injects_back_link_in_html() {
        let (_ctx, base, token) = proxy_setup().await;
        let c = test_client();
        let get = |dest: Option<&'static str>, accept: &'static str| {
            let mut r = c.get(format!("{base}/t/nt/page")).header("Authorization", bearer_of(&token)).header("accept", accept);
            if let Some(d) = dest {
                r = r.header("sec-fetch-dest", d);
            }
            r
        };
        // A document load (Fetch Metadata, or an older browser asking for HTML) gets the link.
        for req in [get(Some("document"), "*/*"), get(None, "text/html,application/xhtml+xml")] {
            let page = req.send().await.unwrap().text().await.unwrap();
            let (link, end) = (page.find(r#"id="hangar-back""#).expect("back link"), page.find("</body>").unwrap());
            assert!(link < end && page.starts_with("<html><body>hi<style>"), "{page}");
        }
        let echo = c.get(format!("{base}/t/nt/api/echo")).header("Authorization", bearer_of(&token)).send().await.unwrap().text().await.unwrap();
        assert!(!echo.contains("hangar-back"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_no_back_link_for_fetched_html() {
        let (_ctx, base, token) = proxy_setup().await;
        let c = test_client();
        // A tool's own fetch/XHR of an HTML fragment must come back exactly as the tool sent it.
        for (dest, mode, accept) in [("empty", "cors", "text/html"), ("iframe", "navigate", "text/html"), ("", "", "*/*")] {
            let mut r = c.get(format!("{base}/t/nt/page")).header("Authorization", bearer_of(&token)).header("accept", accept);
            if !dest.is_empty() {
                r = r.header("sec-fetch-dest", dest).header("sec-fetch-mode", mode);
            }
            let res = r.send().await.unwrap();
            assert_eq!(res.status(), 200);
            assert_eq!(res.text().await.unwrap(), "<html><body>hi</body></html>", "dest {dest:?}");
        }
    }

    #[test]
    fn open_tools_lists_only_phone_open() {
        let tool = |id: &str, extra: &str| -> registry::Tool {
            serde_json::from_str(&format!(
                r#"{{"id":"{id}","name":"{id}","theme":"utility","kind":"web","url":"http://127.0.0.1:1/"{extra}}}"#
            ))
            .unwrap()
        };
        let reg = registry::Registry {
            version: 1,
            themes: vec![],
            tools: vec![
                tool("other", r#","phone_open":true"#),
                tool("notes", r#","phone_open":true"#),
                tool("plain", ""),
                tool("hidden", r#","phone_open":true,"phone":false"#),
            ],
        };
        let ids: Vec<_> = open_tools(&reg).iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["other", "notes"]);
    }

    async fn upload_post(base: &str, token: Option<&str>, query: &str, body: Vec<u8>) -> reqwest::Response {
        let mut r = test_client().post(format!("{base}/api/chat/upload{query}")).body(body);
        if let Some(t) = token {
            r = r.header("Authorization", format!("Bearer {t}"));
        }
        r.send().await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_needs_token() {
        let base = serve_test(test_ctx("upauth")).await;
        assert_eq!(upload_post(&base, None, "?name=a.jpg", vec![1]).await.status(), 401);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_accepts_heic_and_sanitizes() {
        let ctx = test_ctx("upok");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx.clone()).await;
        let r = upload_post(&base, Some(&token), "?name=..%2F..%2FIMG%200042.HEIC", vec![7; 10]).await;
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        let p = PathBuf::from(v["path"].as_str().unwrap());
        assert!(p.is_absolute());
        assert_eq!(p.parent().unwrap(), ctx.dir.join("uploads").join(uploads::local_date()));
        assert!(p.to_str().unwrap().ends_with("-IMG_0042.HEIC"));
        assert_eq!(v["size"], 10);
        assert_eq!(v["name"], p.file_name().unwrap().to_str().unwrap());
        assert_eq!(std::fs::read(&p).unwrap(), vec![7; 10]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_refuses_bad_type() {
        let ctx = test_ctx("upbad");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx).await;
        assert_eq!(upload_post(&base, Some(&token), "?name=x.exe", vec![1]).await.status(), 415);
        assert_eq!(upload_post(&base, Some(&token), "?name=noext", vec![1]).await.status(), 415);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_empty_400() {
        let ctx = test_ctx("upempty");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx).await;
        assert_eq!(upload_post(&base, Some(&token), "?name=a.jpg", vec![]).await.status(), 400);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_too_big_413() {
        let ctx = test_ctx("upbig");
        let token = pair_test_device(&ctx, "d1");
        let base = serve_test(ctx).await;
        assert_eq!(upload_post(&base, Some(&token), "?name=a.jpg", vec![0; uploads::UPLOAD_MAX + 1]).await.status(), 413);
    }


}
