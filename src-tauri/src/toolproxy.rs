//! Phone access to local tools: short-lived cookie sessions for `/t/` pages.
//!
//! A proxied page is opened by a plain browser navigation, which cannot carry the
//! paired token, so the phone page first trades its Bearer token for a cookie here.
//! Only the sha256 of the cookie value is kept, in memory, and the cookie is only ever
//! accepted on `/t/` paths (it is scoped `Path=/t/`; `remote::gate` never reads it for `/api/`).

use axum::http::{header, HeaderMap, HeaderValue, Method};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TOOL_COOKIE: &str = "hangar_tool";
/// A session unused for this long is gone; every use slides the window.
pub const TOOL_IDLE: Duration = Duration::from_secs(2 * 3600);
/// No session outlives this, however busy.
pub const TOOL_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
pub const MAX_SESSIONS: usize = 64;

struct Session {
    hash: [u8; 32],
    device: String,
    idle_until: Instant,
    hard_until: Instant,
}

#[derive(Default)]
pub struct ToolSessions {
    list: Mutex<Vec<Session>>,
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

/// Compares without stopping at the first differing byte.
fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl ToolSessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Session>> {
        self.list.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts a session for `device`; returns the cookie value (32 random bytes, hex).
    pub fn mint(&self, device: &str, now: Instant) -> String {
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).expect("the OS random source failed");
        let value: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let hard = now + TOOL_MAX_AGE;
        let mut list = self.lock();
        list.retain(|s| now <= s.idle_until && now <= s.hard_until);
        list.push(Session { hash: digest(&value), device: device.to_string(), idle_until: (now + TOOL_IDLE).min(hard), hard_until: hard });
        while list.len() > MAX_SESSIONS {
            list.remove(0); // oldest first: sessions are pushed in mint order
        }
        value
    }

    /// The device a live cookie belongs to and how long the session has left
    /// (the cookie's Max-Age on refresh); slides the idle window.
    pub fn check(&self, cookie: &str, now: Instant) -> Option<(String, Duration)> {
        if cookie.is_empty() {
            return None;
        }
        let want = digest(cookie);
        let mut list = self.lock();
        list.retain(|s| now <= s.idle_until && now <= s.hard_until);
        let mut found = None;
        for s in list.iter_mut() {
            // Visit every entry so timing does not tell which one matched.
            if ct_eq(&s.hash, &want) {
                s.idle_until = (now + TOOL_IDLE).min(s.hard_until);
                found = Some((s.device.clone(), s.idle_until.saturating_duration_since(now)));
            }
        }
        found
    }

    pub fn drop_device(&self, device: &str) {
        self.lock().retain(|s| s.device != device);
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}

/// The Set-Cookie value for a tool session. `secure` adds the Secure flag (for an https front end).
pub fn tool_cookie(value: &str, secure: bool, max_age_secs: u64) -> String {
    let mut c = format!("{TOOL_COOKIE}={value}; Path=/t/; Max-Age={max_age_secs}; HttpOnly; SameSite=Strict");
    if secure {
        c.push_str("; Secure");
    }
    c
}

/// One cookie's value from the request's Cookie header(s).
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim().to_string())
}

/// A top-level page load (as opposed to a fetch/XHR/subresource request).
pub fn is_navigation(method: &Method, headers: &HeaderMap) -> bool {
    if method != Method::GET {
        return false;
    }
    match headers.get("sec-fetch-mode").and_then(|v| v.to_str().ok()) {
        Some(mode) => mode == "navigate",
        None => headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html")),
    }
}

/// A request whose answer becomes a whole page (so the back link belongs in it): Fetch Metadata
/// `sec-fetch-dest: document`, or, from a browser that doesn't send that header, a navigation.
/// A tool's own fetch/XHR of an HTML fragment, or an iframe, is left alone.
pub fn is_document_request(method: &Method, headers: &HeaderMap) -> bool {
    match headers.get("sec-fetch-dest").and_then(|v| v.to_str().ok()) {
        Some(dest) => dest == "document",
        None => is_navigation(method, headers),
    }
}

// ---------- The /t/{id}/... proxy: pure path, URL and header helpers ----------

/// Largest request body the proxy passes on.
pub const BODY_MAX: usize = 25 * 1024 * 1024;
/// HTML pages up to this size get the back link; bigger ones stream through untouched.
pub const INJECT_MAX: usize = 2 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum ToolPath {
    Ok { id: String, rest: String },
    NeedsSlash { id: String },
    Bad,
    NotFound,
}

/// Splits `/t/{id}{rest}` (the raw, still percent-encoded path). `rest` always starts with `/`.
/// Anything that could climb out of the tool's folder or change host is `Bad`.
pub fn split_tool_path(raw: &str) -> ToolPath {
    let Some(after) = raw.strip_prefix("/t/") else { return ToolPath::NotFound };
    let (id, rest) = match after.find('/') {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, ""),
    };
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return ToolPath::NotFound;
    }
    if rest.is_empty() {
        return ToolPath::NeedsSlash { id: id.to_string() };
    }
    let lower = rest.to_ascii_lowercase();
    if rest.contains('\\') || lower.contains("%2f") || lower.contains("%5c") || rest.contains("//") {
        return ToolPath::Bad;
    }
    // Dot segments, plain or encoded (the URL standard counts %2e as a dot).
    if lower.split('/').map(|seg| seg.replace("%2e", ".")).any(|seg| seg == "." || seg == "..") {
        return ToolPath::Bad;
    }
    ToolPath::Ok { id: id.to_string(), rest: rest.to_string() }
}

/// Only plain http on this PC: 127.0.0.1, localhost or ::1.
fn local_http(u: &reqwest::Url) -> bool {
    // The parser has already normalized the host (lowercase, `127.1` -> `127.0.0.1`, IPv6 in brackets).
    let host_ok = matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    u.scheme() == "http" && host_ok && u.username().is_empty() && u.password().is_none()
}

/// The upstream URL for `rest` (+ query) under the tool's base URL. Built with `Url` setters, never by
/// string concatenation, and checked again afterwards so the path can never change host or port.
pub fn target_url(base: &str, rest: &str, query: Option<&str>) -> Result<reqwest::Url, String> {
    let base = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    if !local_http(&base) {
        return Err(format!("{base} is not a page on this PC"));
    }
    let mut u = base.clone();
    let path = format!("{}{rest}", base.path().trim_end_matches('/'));
    u.set_path(&path);
    u.set_query(query.filter(|q| !q.is_empty()));
    u.set_fragment(None);
    if !local_http(&u) || u.host() != base.host() || u.port_or_known_default() != base.port_or_known_default() {
        return Err("The address left the tool".into());
    }
    Ok(u)
}

fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme() && a.host() == b.host() && a.port_or_known_default() == b.port_or_known_default()
}

/// A tool's redirect, pointed back under `/t/{id}/` when it stays inside the tool.
/// Relative ones (`next`) already resolve against the proxied page and other sites are left alone.
pub fn rewrite_location(loc: &str, base: &reqwest::Url, id: &str) -> String {
    let absolute = loc.starts_with('/') || reqwest::Url::parse(loc).is_ok();
    if !absolute {
        return loc.to_string();
    }
    let Ok(to) = base.join(loc) else { return loc.to_string() };
    if !same_origin(&to, base) {
        return loc.to_string();
    }
    let prefix = base.path().trim_end_matches('/');
    let Some(inner) = to.path().strip_prefix(prefix).filter(|p| p.is_empty() || p.starts_with('/')) else {
        return loc.to_string();
    };
    let mut out = format!("/t/{id}{}", if inner.is_empty() { "/" } else { inner });
    if let Some(q) = to.query() {
        out.push('?');
        out.push_str(q);
    }
    if let Some(f) = to.fragment() {
        out.push('#');
        out.push_str(f);
    }
    out
}

/// Request headers a tool gets: an allowlist only, so the phone's token, Hangar's cookie and
/// proxy `cf-*` headers never reach it. Adds `x-forwarded-prefix: /t/{id}`.
pub fn forward_request_headers(src: &HeaderMap, id: &str) -> HeaderMap {
    const PASS: [&str; 7] = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since", "if-range"];
    let mut out = HeaderMap::new();
    for name in PASS {
        for v in src.get_all(name) {
            out.append(name, v.clone());
        }
    }
    if let Ok(v) = HeaderValue::from_str(&format!("/t/{id}")) {
        out.insert("x-forwarded-prefix", v);
    }
    out
}

/// Response headers the phone gets: an allowlist (no Set-Cookie), with `location` pointed back under `/t/{id}/`.
pub fn copy_response_headers(src: &reqwest::header::HeaderMap, base: &reqwest::Url, id: &str) -> HeaderMap {
    const PASS: [&str; 7] = ["content-type", "etag", "last-modified", "content-disposition", "content-range", "accept-ranges", "content-encoding"];
    let mut out = HeaderMap::new();
    for name in PASS {
        for v in src.get_all(name) {
            out.append(name, v.clone());
        }
    }
    if let Some(loc) = src.get(header::LOCATION).and_then(|v| v.to_str().ok()) {
        if let Ok(v) = HeaderValue::from_str(&rewrite_location(loc, base, id)) {
            out.insert(header::LOCATION, v);
        }
    }
    out
}

pub const BACK_SNIPPET: &str = r#"<style>:root{--hangar-back:44px}#hangar-back{position:fixed;z-index:2147483647;top:calc(env(safe-area-inset-top) + 8px);left:8px;height:30px;padding:0 10px;border-radius:15px;display:flex;align-items:center;background:rgba(22,26,46,.85);color:#f2c66d;font:600 13px/1 system-ui,sans-serif;text-decoration:none}</style><a id="hangar-back" href="/" aria-label="Back to Hangar">&lsaquo; Hangar</a>"#;

/// Puts the back link just before the last `</body>` (any case), or at the end when there is none.
pub fn inject_back(html: &str) -> String {
    // ASCII lowercasing keeps every byte where it was, so the index fits `html` too.
    match html.to_ascii_lowercase().rfind("</body>") {
        Some(i) => format!("{}{BACK_SNIPPET}{}", &html[..i], &html[i..]),
        None => format!("{html}{BACK_SNIPPET}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_tool_path_cases() {
        assert_eq!(split_tool_path("/t/notes/"), ToolPath::Ok { id: "notes".into(), rest: "/".into() });
        assert_eq!(split_tool_path("/t/notes/api/state"), ToolPath::Ok { id: "notes".into(), rest: "/api/state".into() });
        assert_eq!(split_tool_path("/t/notes"), ToolPath::NeedsSlash { id: "notes".into() });
        for bad in ["/t/nt/%2e%2e/x", "/t/nt/a/%2E%2e/x", "/t/nt/a%5cb", "/t/nt/a%2Fb", "/t/nt//evil.com/x", "/t/nt/a\\b"] {
            assert_eq!(split_tool_path(bad), ToolPath::Bad, "{bad}");
        }
        for bad in ["/t/nt/../x", "/t/nt/./x", "/t/nt/a/.%2E", "/t/nt/a/%2e"] {
            assert_eq!(split_tool_path(bad), ToolPath::Bad, "{bad}");
        }
        assert_eq!(split_tool_path("/t/nt/a/"), ToolPath::Ok { id: "nt".into(), rest: "/a/".into() });
        assert_eq!(split_tool_path("/t/nt/a.b/..c"), ToolPath::Ok { id: "nt".into(), rest: "/a.b/..c".into() });
        assert_eq!(split_tool_path("/t/w%20q/"), ToolPath::NotFound);
        assert_eq!(split_tool_path("/t//x"), ToolPath::NotFound);
        assert_eq!(split_tool_path("/t/"), ToolPath::NotFound);
    }

    #[test]
    fn target_url_stays_local() {
        assert_eq!(target_url("http://127.0.0.1:4321/", "/api/state", Some("a=1")).unwrap().as_str(), "http://127.0.0.1:4321/api/state?a=1");
        assert_eq!(target_url("http://127.0.0.1:4321/app/", "/x", None).unwrap().as_str(), "http://127.0.0.1:4321/app/x");
        assert_eq!(target_url("http://127.0.0.1:4321", "/", None).unwrap().as_str(), "http://127.0.0.1:4321/");
        let u = target_url("http://127.0.0.1:4321/", "/@example.com/x", None).unwrap();
        assert_eq!((u.host_str(), u.port()), (Some("127.0.0.1"), Some(4321)));
        assert_eq!(u.path(), "/@example.com/x");
        assert!(target_url("http://localhost:4321/", "/", None).is_ok());
        assert!(target_url("http://[::1]:4321/", "/", None).is_ok());
        for base in ["http://192.168.0.5/", "https://example.com/", "file:///C:/x", "https://127.0.0.1:4321/", "http://user@example.com/", "not a url"] {
            assert!(target_url(base, "/", None).is_err(), "{base}");
        }
    }

    #[test]
    fn rewrite_location_cases() {
        let b = reqwest::Url::parse("http://127.0.0.1:4321/").unwrap();
        assert_eq!(rewrite_location("/inside?a=1", &b, "nt"), "/t/nt/inside?a=1");
        assert_eq!(rewrite_location("http://127.0.0.1:4321/abs", &b, "nt"), "/t/nt/abs");
        assert_eq!(rewrite_location("next", &b, "nt"), "next");
        assert_eq!(rewrite_location("https://example.com/x", &b, "nt"), "https://example.com/x");
        assert_eq!(rewrite_location("//example.com/x", &b, "nt"), "//example.com/x");
        assert_eq!(rewrite_location("http://127.0.0.1:9999/x", &b, "nt"), "http://127.0.0.1:9999/x");
        let sub = reqwest::Url::parse("http://127.0.0.1:4321/app/").unwrap();
        assert_eq!(rewrite_location("/app/x", &sub, "nt"), "/t/nt/x");
        assert_eq!(rewrite_location("/app", &sub, "nt"), "/t/nt/");
    }

    #[test]
    fn inject_back_cases() {
        assert_eq!(inject_back("<html><body>hi</body></html>"), format!("<html><body>hi{BACK_SNIPPET}</body></html>"));
        assert_eq!(inject_back("<p>x</p>"), format!("<p>x</p>{BACK_SNIPPET}"));
        assert!(inject_back("<BODY>a</BODY>").contains(&format!("a{BACK_SNIPPET}</BODY>")));
        assert_eq!(inject_back("<body>a</body><!-- </body> --></body>"), format!("<body>a</body><!-- </body> -->{BACK_SNIPPET}</body>"), "the last one");
    }

    #[test]
    fn header_allowlists() {
        let mut src = HeaderMap::new();
        for (k, v) in [
            ("content-type", "text/plain"),
            ("accept", "*/*"),
            ("range", "bytes=0-9"),
            ("authorization", "Bearer secret"),
            ("cookie", "hangar_tool=abc"),
            ("cf-connecting-ip", "203.0.113.9"),
            ("cf-ray", "x"),
            ("host", "example.com"),
            ("connection", "keep-alive"),
            ("x-forwarded-prefix", "/evil"),
        ] {
            src.append(k, v.parse().unwrap());
        }
        let out = forward_request_headers(&src, "nt");
        assert_eq!(out["content-type"], "text/plain");
        assert_eq!(out["accept"], "*/*");
        assert_eq!(out["range"], "bytes=0-9");
        assert_eq!(out.get_all("x-forwarded-prefix").iter().collect::<Vec<_>>(), vec!["/t/nt"]);
        for k in ["authorization", "cookie", "cf-connecting-ip", "cf-ray", "host", "connection"] {
            assert!(!out.contains_key(k), "{k}");
        }

        let base = reqwest::Url::parse("http://127.0.0.1:4321/").unwrap();
        let mut up = reqwest::header::HeaderMap::new();
        for (k, v) in [
            ("content-type", "text/html"),
            ("etag", "\"1\""),
            ("set-cookie", "s=1"),
            ("connection", "close"),
            ("transfer-encoding", "chunked"),
            ("content-security-policy", "default-src 'self'"),
            ("location", "/inside"),
        ] {
            up.append(k, v.parse().unwrap());
        }
        let out = copy_response_headers(&up, &base, "nt");
        assert_eq!(out["content-type"], "text/html");
        assert_eq!(out["etag"], "\"1\"");
        assert_eq!(out["location"], "/t/nt/inside");
        for k in ["set-cookie", "connection", "transfer-encoding", "content-security-policy"] {
            assert!(!out.contains_key(k), "{k}");
        }
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn tool_session_slides_then_expires() {
        let s = ToolSessions::new();
        let t0 = Instant::now();
        let c = s.mint("dev1", t0);
        assert_eq!(c.len(), 64);
        assert_eq!(s.check(&c, t0 + secs(3600)), Some(("dev1".to_string(), secs(7200))));
        assert_eq!(s.check(&c, t0 + secs(3600 + 7199)), Some(("dev1".to_string(), secs(7200))), "slid from the last use");
        assert!(s.check(&c, t0 + secs(3600 + 7199 + 7201)).is_none(), "idle 2 h");
        assert!(s.check("nope", t0).is_none());
        assert!(s.check("", t0).is_none());
    }

    #[test]
    fn tool_session_hard_cap() {
        let s = ToolSessions::new();
        let t0 = Instant::now();
        let c = s.mint("dev1", t0);
        for h in 1..=24 {
            let left = if h >= 23 { secs((24 - h) * 3600) } else { secs(7200) };
            assert_eq!(s.check(&c, t0 + secs(h * 3600)), Some(("dev1".to_string(), left)), "hour {h}: at most what the hard cap leaves");
        }
        assert!(s.check(&c, t0 + secs(24 * 3600 + 1)).is_none(), "24 h after minting, however busy");
    }

    #[test]
    fn tool_session_cap_and_drop_device() {
        let s = ToolSessions::new();
        let t0 = Instant::now();
        let first = s.mint("x", t0);
        let rest: Vec<String> = (0..MAX_SESSIONS).map(|_| s.mint("y", t0)).collect();
        assert!(s.check(&first, t0).is_none(), "the 65th mint pushed the oldest out");
        assert!(s.check(&rest[0], t0).is_some() && s.check(rest.last().unwrap(), t0).is_some());
        let x = s.mint("x", t0);
        s.drop_device("x");
        assert!(s.check(&x, t0).is_none());
        assert!(s.check(rest.last().unwrap(), t0).is_some(), "only x's cookies went");
        s.clear();
        assert!(s.check(rest.last().unwrap(), t0).is_none());
    }

    #[test]
    fn tool_cookie_flags() {
        assert_eq!(tool_cookie("abc", false, 7200), "hangar_tool=abc; Path=/t/; Max-Age=7200; HttpOnly; SameSite=Strict");
        assert_eq!(tool_cookie("abc", true, 7200), "hangar_tool=abc; Path=/t/; Max-Age=7200; HttpOnly; SameSite=Strict; Secure");
    }

    #[test]
    fn cookie_value_parses() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "a=1; hangar_tool=xyz; b=2".parse().unwrap());
        assert_eq!(cookie_value(&h, TOOL_COOKIE).as_deref(), Some("xyz"));
        assert_eq!(cookie_value(&h, "a").as_deref(), Some("1"));
        assert_eq!(cookie_value(&h, "zzz"), None);
        assert_eq!(cookie_value(&HeaderMap::new(), TOOL_COOKIE), None);
    }

    #[test]
    fn navigation_detection() {
        let hm = |k: &'static str, v: &'static str| {
            let mut h = HeaderMap::new();
            h.insert(k, v.parse().unwrap());
            h
        };
        assert!(is_navigation(&Method::GET, &hm("sec-fetch-mode", "navigate")));
        assert!(!is_navigation(&Method::GET, &hm("sec-fetch-mode", "cors")));
        assert!(is_navigation(&Method::GET, &hm("accept", "text/html,application/xhtml+xml")));
        assert!(!is_navigation(&Method::GET, &HeaderMap::new()));
        assert!(!is_navigation(&Method::POST, &hm("sec-fetch-mode", "navigate")));
        let mut both = hm("sec-fetch-mode", "cors");
        both.insert("accept", "text/html".parse().unwrap());
        assert!(!is_navigation(&Method::GET, &both), "sec-fetch-mode wins over accept");
    }

    #[test]
    fn document_request_detection() {
        let hm = |pairs: &[(&'static str, &'static str)]| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.insert(*k, v.parse().unwrap());
            }
            h
        };
        assert!(is_document_request(&Method::GET, &hm(&[("sec-fetch-dest", "document")])));
        assert!(is_document_request(&Method::POST, &hm(&[("sec-fetch-dest", "document")])), "a form post's result page");
        for dest in ["empty", "iframe", "script", "style"] {
            let h = hm(&[("sec-fetch-dest", dest), ("accept", "text/html")]);
            assert!(!is_document_request(&Method::GET, &h), "{dest}");
        }
        assert!(is_document_request(&Method::GET, &hm(&[("accept", "text/html")])), "no Fetch Metadata: navigation rule");
        assert!(!is_document_request(&Method::GET, &hm(&[("accept", "*/*")])));
        assert!(!is_document_request(&Method::GET, &HeaderMap::new()));
    }
}
