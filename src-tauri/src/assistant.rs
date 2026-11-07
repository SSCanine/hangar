//! Assistant: streams chat from any OpenAI-compatible endpoint (Ollama, koboldcpp,
//! LM Studio, a local proxy) and proxies text-to-speech / speech-to-text.

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, State};

#[derive(Default)]
pub struct Streams(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

#[derive(Serialize, Clone)]
struct ChatEvent {
    id: String,
    /// delta | think | done | error
    kind: &'static str,
    text: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

fn client(total: Option<Duration>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).no_proxy();
    if let Some(t) = total {
        b = b.timeout(t);
    }
    b.build().map_err(|e| e.to_string())
}

/// A refused request in words: the status plus the start of the server's reply.
fn explain(status: u16, body: &str) -> String {
    format!("The model server answered {status}: {}", body.chars().take(200).collect::<String>())
}

/// The Kokoro-compatible text-to-speech server (HANGAR_TTS_URL, default Kokoro-FastAPI's port).
fn tts_base() -> String {
    std::env::var("HANGAR_TTS_URL").unwrap_or_else(|_| "http://127.0.0.1:8880".into()).trim_end_matches('/').to_string()
}

fn trim_base(base: &str) -> &str {
    base.trim_end_matches('/')
}

#[tauri::command]
pub async fn llm_models(base: String) -> Result<Vec<String>, String> {
    let url = format!("{}/models", trim_base(&base));
    let c = client(Some(Duration::from_secs(4)))?;
    let resp = c.get(&url).send().await.map_err(|_| "offline".to_string())?;
    // A refusal (wrong key, server error) is not an empty model list: say what it was.
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(explain(status, &body));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default())
}

/// Pulls content and reasoning text out of one SSE `data:` payload.
fn parse_chunk(data: &str) -> (Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return (None, None) };
    let d = &v["choices"][0]["delta"];
    let text = d["content"].as_str().filter(|s| !s.is_empty()).map(String::from);
    let think = d["reasoning_content"]
        .as_str()
        .or_else(|| d["reasoning"].as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    (text, think)
}

async fn run_stream(
    app: &tauri::AppHandle,
    id: &str,
    base: &str,
    model: &str,
    messages: &[Msg],
    extra: Option<Value>,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", trim_base(base));
    let mut body = json!({ "model": model, "messages": messages, "stream": true });
    // Per-job settings (temperature, keep_alive, reasoning_effort) ride along as extra body fields.
    if let (Some(Value::Object(extra)), Some(obj)) = (extra, body.as_object_mut()) {
        obj.extend(extra);
    }
    let resp = client(None)?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {base}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(explain(status, &text));
    }
    let emit = |kind: &'static str, text: String| {
        let _ = app.emit("hangar://chat", ChatEvent { id: id.to_string(), kind, text });
    };
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(());
            }
            let (text, think) = parse_chunk(data);
            if let Some(t) = think {
                emit("think", t);
            }
            if let Some(t) = text {
                emit("delta", t);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn chat_start(
    app: tauri::AppHandle,
    streams: State<'_, Streams>,
    id: String,
    base: String,
    model: String,
    messages: Vec<Msg>,
    extra: Option<Value>,
) {
    let app2 = app.clone();
    let id2 = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = run_stream(&app2, &id2, &base, &model, &messages, extra).await;
        let ev = match result {
            Ok(()) => ChatEvent { id: id2.clone(), kind: "done", text: String::new() },
            Err(e) => ChatEvent { id: id2.clone(), kind: "error", text: e },
        };
        let _ = app2.emit("hangar://chat", ev);
    });
    streams.0.lock().unwrap().insert(id, handle);
}

#[tauri::command]
pub fn chat_cancel(app: tauri::AppHandle, streams: State<'_, Streams>, id: String) {
    if let Some(h) = streams.0.lock().unwrap().remove(&id) {
        h.abort();
        let _ = app.emit("hangar://chat", ChatEvent { id, kind: "done", text: String::new() });
    }
}

/// Kokoro's voice list (empty when the server is off).
#[tauri::command]
pub async fn tts_voices() -> Vec<String> {
    let Ok(c) = client(Some(Duration::from_secs(3))) else { return vec![] };
    let Ok(resp) = c.get(format!("{}/v1/audio/voices", tts_base())).send().await else { return vec![] };
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    v["voices"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Whether ~/.claude/settings.json runs Hangar's notification hook (and on which events).
#[tauri::command]
pub fn hook_status() -> Value {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let path = std::path::Path::new(&home).join(".claude").join("settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else { return json!({"installed": false, "events": []}) };
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let mut events = vec![];
    if let Some(hooks) = v["hooks"].as_object() {
        for (ev, arr) in hooks {
            let s = arr.to_string();
            if s.contains("hangar_notify.py") {
                events.push(ev.clone());
            }
        }
    }
    json!({"installed": !events.is_empty(), "events": events, "settings": path.display().to_string()})
}

/// One whole answer (no streaming), for background jobs like the inbox briefs.
#[tauri::command]
pub async fn llm_complete(base: String, model: String, messages: Vec<Msg>) -> Result<String, String> {
    let url = format!("{}/chat/completions", trim_base(&base));
    let resp = client(Some(Duration::from_secs(180)))?
        .post(&url)
        .json(&json!({ "model": model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {base}: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{status}: {}", v.to_string().chars().take(300).collect::<String>()));
    }
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

/// Text to speech through a Kokoro-compatible server (OpenAI speech API). Returns WAV bytes.
#[tauri::command]
pub async fn tts(text: String, voice: String, speed: Option<f32>) -> Result<tauri::ipc::Response, String> {
    let c = client(Some(Duration::from_secs(120)))?;
    let resp = c
        .post(format!("{}/v1/audio/speech", tts_base()))
        .json(&json!({ "model": "kokoro", "input": text, "voice": voice, "response_format": "wav",
                       "speed": speed.unwrap_or(1.0).clamp(0.5, 2.0) }))
        .send()
        .await
        .map_err(|_| "The voice server isn't answering".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Voice server error {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// Speech to text. `audio_b64` is the recorded clip; returns the transcript.
#[tauri::command]
pub async fn stt(endpoint: String, audio_b64: String, mime: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .map_err(|e| e.to_string())?;
    let ext = if mime.contains("ogg") { "ogg" } else if mime.contains("wav") { "wav" } else { "webm" };
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("clip.{ext}"))
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part).text("model", "whisper-1");
    let resp = client(Some(Duration::from_secs(120)))?
        .post(&endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "The speech-to-text server isn't answering".to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Speech-to-text error {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    Ok(v["text"].as_str().or(v["transcript"].as_str()).map(String::from).unwrap_or(text).trim().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_openai_and_reasoning_chunks() {
        let (t, r) = super::parse_chunk(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#);
        assert_eq!((t.as_deref(), r), (Some("Hi"), None));
        let (t, r) = super::parse_chunk(r#"{"choices":[{"delta":{"reasoning_content":"hmm"}}]}"#);
        assert_eq!((t, r.as_deref()), (None, Some("hmm")));
        let (t, r) = super::parse_chunk("not json");
        assert!(t.is_none() && r.is_none());
    }
}
