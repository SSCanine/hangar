//! The tool list: one JSON file (registry/tools.json) that says what every
//! tool is, which theme it belongs to, and how to start, check and open it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StartSpec {
    pub cmd: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// hidden | minimized | console
    #[serde(default = "default_window")]
    pub window: String,
    /// Extra environment. PATH_PREPEND is put in front of PATH.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

fn default_window() -> String {
    "hidden".into()
}

/// A tool that is also a tab inside another app (e.g. a helper page shown as a tab of its main app).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Hosted {
    pub tool: String,
    pub tab: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct View {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub theme: String,
    #[serde(default)]
    pub description: String,
    /// web | app | service
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    #[serde(default)]
    pub embed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<StartSpec>,
    #[serde(default)]
    pub stoppable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<View>,
    #[serde(default)]
    pub gpu: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub env_strip_claude: bool,
    /// JSON file whose "token" value is added to the page address as ?k=TOKEN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Extra themes this tool also shows up in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_themes: Vec<String>,
    /// The app that hosts this tool as a tab; Hangar nests it under that app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosted_in: Option<Hosted>,
    /// Helper services that only exist for this tool; shown nested inside it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<String>,
    /// The hub app this tool has been merged into (a tool id). Theme lists hide the
    /// tool and show it on the hub's row as "Includes: ..."; start, stop and checks still work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_of: Option<String>,
    /// The phone may open this page through Hangar Remote (`/t/<id>/`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub phone_open: bool,
    /// Turn on restarts the tool when its start exe is running but its port stays dead
    /// (e.g. Ollama's tray app after a failed self-update stopped the server).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub restart_stuck: bool,
    /// Keeps fields Hangar doesn't know about when it saves the file.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub icon: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Registry {
    #[serde(default = "one")]
    pub version: u32,
    pub themes: Vec<Theme>,
    pub tools: Vec<Tool>,
}

fn one() -> u32 {
    1
}

#[derive(Serialize)]
pub struct RegistryPayload {
    pub path: String,
    pub registry: Registry,
}

/// The example lists, built into the exe so a copy of Hangar away from its repo still starts.
const TOOLS_EXAMPLE: &str = include_str!("../../registry/tools.example.json");
const ROLES_EXAMPLE: &str = include_str!("../../registry/model-roles.example.json");

/// The Hangar folder, found at run time (not baked in at build time):
/// 1. HANGAR_HOME, when set;
/// 2. the repo the exe sits in (src-tauri\target\release\hangar.exe -> the repo), found by walking up
///    from the exe to a folder that has registry\tools.example.json, so a moved or renamed clone works;
/// 3. otherwise `%APPDATA%\app.hangar.desktop`, with its own registry folder (an exe copied elsewhere).
pub fn hangar_home() -> PathBuf {
    static HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        if let Ok(h) = std::env::var("HANGAR_HOME") {
            if !h.trim().is_empty() {
                return PathBuf::from(h);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            for dir in exe.ancestors().skip(1).take(6) {
                if dir.join("registry").join("tools.example.json").is_file() {
                    return dir.to_path_buf();
                }
            }
        }
        PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into())).join("app.hangar.desktop")
    })
    .clone()
}

/// The folder holding tools.json, model-roles.json and the optional projects.json.
/// HANGAR_REGISTRY (a tools.json path) overrides where tools.json lives; the other files stay here.
pub fn registry_dir() -> PathBuf {
    hangar_home().join("registry")
}

pub fn registry_path() -> PathBuf {
    if let Ok(p) = std::env::var("HANGAR_REGISTRY") {
        return PathBuf::from(p);
    }
    registry_dir().join("tools.json")
}

/// Your own lists are never committed. On first run each starts as a copy of its example
/// (the file next to it, or the copy built into the exe), which you or your Claude then edit.
pub fn ensure_from_example(path: &std::path::Path, example_name: &str) {
    if path.exists() {
        return;
    }
    let example = path.with_file_name(example_name);
    let text = match std::fs::read_to_string(&example) {
        Ok(t) => t,
        Err(_) if example_name == "tools.example.json" => TOOLS_EXAMPLE.to_string(),
        Err(_) if example_name == "model-roles.example.json" => ROLES_EXAMPLE.to_string(),
        Err(_) => return,
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Written aside and renamed into place, so a reader never sees half a file.
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

pub fn load() -> Result<Registry, String> {
    let path = registry_path();
    ensure_from_example(&path, "tools.example.json");
    load_from(&path)
}

pub fn load_from(path: &std::path::Path) -> Result<Registry, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Couldn't read the tool list at {}: {e}", path.display()))?;
    let mut reg: Registry = serde_json::from_str(&text).map_err(|e| format!("The tool list has a JSON error: {e}"))?;
    let root = hangar_home().display().to_string();
    for t in &mut reg.tools {
        expand_tool(t, &root);
    }
    Ok(reg)
}

/// `%NAME%` becomes that environment variable (left as is when it isn't set) and `{hangar}`
/// the Hangar folder, so a shared tool list needs no user names or drive letters.
pub fn expand(s: &str, root: &str) -> String {
    let s = s.replace("{hangar}", root);
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) if j > 0 && after[..j].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '(' || c == ')') => {
                let name = &after[..j];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[j + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn expand_tool(t: &mut Tool, root: &str) {
    if let Some(s) = &mut t.start {
        for a in &mut s.cmd {
            *a = expand(a, root);
        }
        if let Some(c) = &mut s.cwd {
            *c = expand(c, root);
        }
        for v in s.env.values_mut() {
            *v = expand(v, root);
        }
    }
    for f in [&mut t.exe, &mut t.folder, &mut t.token_file] {
        if let Some(v) = f {
            *v = expand(v, root);
        }
    }
}

fn save(reg: &Registry) -> Result<(), String> {
    let path = registry_path();
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Problems with `part_of` links: a tool that is part of itself, of an id that isn't in
/// the list, or of a chain that loops back. Empty when every link is fine.
pub fn part_of_problems(reg: &Registry) -> Vec<String> {
    let by_id: HashMap<&str, &Tool> = reg.tools.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut out = Vec::new();
    for t in &reg.tools {
        let Some(parent) = t.part_of.as_deref() else { continue };
        if parent == t.id {
            out.push(format!("{} is set as part of itself", t.name));
            continue;
        }
        if !by_id.contains_key(parent) {
            out.push(format!("{} is set as part of '{parent}', but no tool has that id", t.name));
            continue;
        }
        let mut seen = vec![t.id.as_str()];
        let mut cur = Some(parent);
        while let Some(id) = cur {
            if seen.contains(&id) {
                out.push(format!("{} is in a part_of loop ({} -> {id})", t.name, seen.join(" -> ")));
                break;
            }
            seen.push(id);
            cur = by_id.get(id).and_then(|x| x.part_of.as_deref());
        }
    }
    out
}

fn check_part_of(reg: &Registry) -> Result<(), String> {
    match part_of_problems(reg).into_iter().next() {
        Some(p) => Err(p),
        None => Ok(()),
    }
}

pub fn find(id: &str) -> Result<Tool, String> {
    load()?
        .tools
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("No tool with id '{id}' in the tool list"))
}

#[tauri::command]
pub fn registry_get() -> Result<RegistryPayload, String> {
    Ok(RegistryPayload {
        path: registry_path().display().to_string(),
        registry: load()?,
    })
}

/// Adds a tool, or replaces the one with the same id (or `previous_id` when renaming).
#[tauri::command]
pub fn registry_upsert(tool: Tool, previous_id: Option<String>) -> Result<(), String> {
    if tool.id.trim().is_empty() || tool.name.trim().is_empty() {
        return Err("A tool needs an id and a name".into());
    }
    let mut reg = load()?;
    let key = previous_id.unwrap_or_else(|| tool.id.clone());
    if key != tool.id && reg.tools.iter().any(|t| t.id == tool.id) {
        return Err(format!("Another tool already uses the id '{}'", tool.id));
    }
    let new_id = tool.id.clone();
    match reg.tools.iter_mut().find(|t| t.id == key) {
        Some(slot) => *slot = tool,
        None => reg.tools.push(tool),
    }
    // A renamed hub keeps the tools merged into it.
    if key != new_id {
        for t in reg.tools.iter_mut().filter(|t| t.part_of.as_deref() == Some(key.as_str())) {
            t.part_of = Some(new_id.clone());
        }
    }
    check_part_of(&reg)?;
    save(&reg)
}

#[tauri::command]
pub fn registry_delete(id: String) -> Result<(), String> {
    let mut reg = load()?;
    let before = reg.tools.len();
    reg.tools.retain(|t| t.id != id);
    if reg.tools.len() == before {
        return Err(format!("No tool with id '{id}'"));
    }
    // Tools merged into the deleted one go back to being listed on their own.
    for t in reg.tools.iter_mut().filter(|t| t.part_of.as_deref() == Some(id.as_str())) {
        t.part_of = None;
    }
    save(&reg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_file_parses_and_ids_are_unique() {
        let reg = load_from(&registry_dir().join("tools.example.json")).expect("registry/tools.example.json must parse");
        let mut ids: Vec<_> = reg.tools.iter().map(|t| t.id.as_str()).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(n, ids.len(), "duplicate tool ids");
        let themes: Vec<_> = reg.themes.iter().map(|t| t.id.as_str()).collect();
        for t in &reg.tools {
            assert!(themes.contains(&t.theme.as_str()), "{} has unknown theme {}", t.id, t.theme);
            assert!(["web", "app", "service"].contains(&t.kind.as_str()), "{} bad kind", t.id);
            if t.kind == "web" {
                assert!(t.url.is_some(), "{} is web but has no url", t.id);
            }
            for th in &t.also_themes {
                assert!(themes.contains(&th.as_str()), "{} also_themes has unknown {}", t.id, th);
            }
            if let Some(h) = &t.hosted_in {
                assert!(ids.contains(&h.tool.as_str()), "{} hosted_in unknown tool {}", t.id, h.tool);
            }
        }
        let mut seen_parts: Vec<&str> = Vec::new();
        for t in &reg.tools {
            for p in &t.parts {
                assert!(ids.contains(&p.as_str()), "{} has unknown part {}", t.id, p);
                assert!(!seen_parts.contains(&p.as_str()), "{} is a part of two tools", p);
                seen_parts.push(p);
            }
        }
        let problems = part_of_problems(&reg);
        assert!(problems.is_empty(), "part_of problems: {problems:?}");
    }

    #[test]
    fn expands_env_vars_and_hangar_root() {
        std::env::set_var("HANGAR_TEST_VAR", "X");
        assert_eq!(expand(r"%HANGAR_TEST_VAR%\a", "R"), r"X\a");
        assert_eq!(expand(r"{hangar}\stt", r"D:\h"), r"D:\h\stt");
        assert_eq!(expand("%NOT_SET_HANGAR_XYZ%/b", "R"), "%NOT_SET_HANGAR_XYZ%/b");
        assert_eq!(expand("100% sure", "R"), "100% sure");
        assert_eq!(expand("%%", "R"), "%%");
    }

    #[test]
    fn finds_its_own_folder_at_run_time() {
        // The test exe lives under src-tauri/target, inside the repo: walking up finds it.
        assert!(hangar_home().join("registry").join("tools.example.json").is_file());
    }

    fn reg_of(links: &[(&str, Option<&str>)]) -> Registry {
        let tools = links
            .iter()
            .map(|(id, parent)| {
                let mut v = json_tool(id);
                if let Some(p) = parent {
                    v["part_of"] = (*p).into();
                }
                serde_json::from_value(v).unwrap()
            })
            .collect();
        Registry { version: 1, themes: vec![], tools }
    }

    fn json_tool(id: &str) -> Value {
        serde_json::json!({ "id": id, "name": id, "theme": "image", "kind": "service" })
    }

    #[test]
    fn part_of_links_are_checked() {
        assert!(part_of_problems(&reg_of(&[("hub", None), ("a", Some("hub")), ("b", Some("hub"))])).is_empty());
        assert!(part_of_problems(&reg_of(&[("hub", None), ("mid", Some("hub")), ("a", Some("mid"))])).is_empty());
        assert_eq!(part_of_problems(&reg_of(&[("a", Some("a"))])).len(), 1, "self");
        assert_eq!(part_of_problems(&reg_of(&[("a", Some("nope"))])).len(), 1, "unknown parent");
        assert_eq!(part_of_problems(&reg_of(&[("a", Some("b")), ("b", Some("a"))])).len(), 2, "two-tool loop");
        let p = part_of_problems(&reg_of(&[("a", Some("b")), ("b", Some("c")), ("c", Some("a")), ("d", Some("a"))]));
        assert_eq!(p.len(), 4, "three-tool loop, plus a tool hanging off it: {p:?}");
    }

    #[test]
    fn part_of_is_optional_and_round_trips() {
        let t: Tool = serde_json::from_value(json_tool("x")).unwrap();
        assert!(t.part_of.is_none());
        assert!(!serde_json::to_string(&t).unwrap().contains("part_of"));
        let mut v = json_tool("x");
        v["part_of"] = "hub".into();
        let t: Tool = serde_json::from_value(v).unwrap();
        assert_eq!(t.part_of.as_deref(), Some("hub"));
        assert!(!t.extra.contains_key("part_of"));
        assert_eq!(serde_json::to_value(&t).unwrap()["part_of"], "hub");
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let json = r#"{"id":"x","name":"X","theme":"ai","kind":"service","port":1,"custom":{"a":1}}"#;
        let t: Tool = serde_json::from_str(json).unwrap();
        let back = serde_json::to_value(&t).unwrap();
        assert_eq!(back["custom"]["a"], 1);
    }

    #[test]
    fn phone_open_defaults_false_and_round_trips() {
        let base = r#"{"id":"a","name":"A","theme":"utility","kind":"web","url":"http://127.0.0.1:1/"}"#;
        let t: Tool = serde_json::from_str(base).unwrap();
        assert!(!t.phone_open);
        assert!(!serde_json::to_string(&t).unwrap().contains("phone_open"));
        let t: Tool = serde_json::from_str(&base.replace("}", r#","phone_open":true}"#)).unwrap();
        assert!(t.phone_open && !t.extra.contains_key("phone_open"));
        assert!(serde_json::to_string(&t).unwrap().contains(r#""phone_open":true"#));
    }

    #[test]
    fn load_from_reads_given_file() {
        let path = std::env::temp_dir().join(format!("hangar-registry-{}.json", std::process::id()));
        let text = r##"{"themes":[{"id":"utility","name":"U","color":"#fff"}],"tools":[{"id":"a","name":"A","theme":"utility","kind":"web","url":"http://127.0.0.1:1/"}]}"##;
        std::fs::write(&path, text).unwrap();
        let reg = load_from(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(reg.tools.len(), 1);
        assert_eq!(reg.tools[0].id, "a");
    }
}
