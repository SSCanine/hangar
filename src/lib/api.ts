// Thin wrappers over the Rust commands. Outside Tauri (plain browser on the
// Vite dev server) a mock answers instead, so the UI can be previewed safely.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import type { ChatSession, ClaudeConversation, PhoneStatus, RemoteStatus, GpuStats, LoadedModel, Overview, Registry, RolesConfig, SysStats, Tool, ToolStatus } from "./types";
import type { ProcSnapshot } from "./procmatch";
import { mockChats, mockConversation, mockInbox } from "./chatMocks";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** `hangar://pty` events: output, output from before this window joined, the phone joining or leaving ("on"/"off"), the end. */
export type PtyKind = "data" | "replay" | "phone" | "exit";

export interface SentResult {
  /** Differs from the id you sent to when the chat had to continue as a new session. */
  id: string;
  session_id: string;
  /** Claude was busy, so the message waits in its queue until the current step ends. */
  queued: boolean;
}

export interface RegistryPayload {
  path: string;
  registry: Registry;
}

export interface ChatEvent {
  id: string;
  kind: "delta" | "think" | "done" | "error";
  text: string;
}

const mock = {
  running: new Set<string>(),
  async registry(): Promise<RegistryPayload> {
    const res = await fetch("/registry/tools.json").catch(() => null);
    const registry = res && res.ok ? await res.json() : { version: 1, themes: [], tools: [] };
    return { path: "registry/tools.json (preview)", registry };
  },
};

export const api = {
  registry: (): Promise<RegistryPayload> => (inTauri ? invoke("registry_get") : mock.registry()),
  upsertTool: (tool: Tool, previousId?: string): Promise<void> =>
    inTauri ? invoke("registry_upsert", { tool, previousId: previousId ?? null }) : Promise.resolve(),
  deleteTool: (id: string): Promise<void> => (inTauri ? invoke("registry_delete", { id }) : Promise.resolve()),

  statusAll: async (): Promise<ToolStatus[]> => {
    if (inTauri) return invoke("status_all");
    const { registry } = await mock.registry();
    return registry.tools.map((t, i) => ({
      id: t.id,
      running: mock.running.has(t.id) || i % 3 === 0,
      via: "tcp" as const,
      ms: 3,
    }));
  },
  start: (id: string): Promise<void> => {
    if (inTauri) return invoke("tool_start", { id });
    mock.running.add(id);
    return Promise.resolve();
  },
  stop: (id: string, confirmed = false): Promise<number> => {
    if (inTauri) return invoke("tool_stop", { id, confirmed });
    mock.running.delete(id);
    return Promise.resolve(1);
  },
  focus: (id: string): Promise<"focused" | "started"> =>
    inTauri ? invoke("tool_focus", { id }) : Promise.resolve("focused"),
  token: (id: string): Promise<string | null> => (inTauri ? invoke("tool_token", { id }) : Promise.resolve(null)),
  log: (id: string): Promise<string> => (inTauri ? invoke("tool_log", { id }) : Promise.resolve("(preview: no log)")),

  gpu: (): Promise<GpuStats> =>
    inTauri
      ? invoke("gpu_stats")
      : Promise.resolve({ name: "NVIDIA GeForce RTX 4070", util: 7, mem_used: 3120, mem_total: 12282, temp: 44, power: 41 }),
  sys: (): Promise<SysStats> =>
    inTauri
      ? invoke("sys_stats")
      : Promise.resolve({ cpu: 14, threads: 16, mem_used: 14800, mem_total: 32700, commit_used: 21200, commit_total: 52000 }),
  overview: (): Promise<Overview> => (inTauri ? invoke("system_overview") : Promise.resolve(mockOverview())),
  openSystemApp: (app: "taskmgr" | "resmon" | "storage"): Promise<void> => (inTauri ? invoke("open_system_app", { app }) : Promise.resolve()),
  procs: (): Promise<ProcSnapshot> => (inTauri ? invoke("proc_list") : Promise.resolve(mockProcs())),
  killProcs: (pids: number[]): Promise<number> => (inTauri ? invoke("proc_kill", { pids }) : Promise.resolve(pids.length)),
  projects: (): Promise<unknown> => (inTauri ? invoke("projects_get") : Promise.resolve({ groups: [] })),
  pathExists: (paths: string[]): Promise<boolean[]> =>
    inTauri ? invoke("path_exists", { paths }) : Promise.resolve(paths.map(() => true)),
  openFolder: (path: string): Promise<void> => (inTauri ? invoke("open_folder", { path }) : Promise.resolve()),
  /** Shows a file (selected) or a folder in Explorer. */
  revealPath: (path: string): Promise<void> => (inTauri ? invoke("open_folder", { path }) : Promise.reject(new Error("Not in Hangar"))),
  homeDir: (): Promise<string> => (inTauri ? invoke("home_dir") : Promise.resolve("C:\\Users\\you")),
  openFile: (path: string): Promise<void> => (inTauri ? invoke("open_file", { path }) : Promise.resolve()),
  clipboardSet: (text: string): Promise<void> => (inTauri ? invoke("clipboard_set", { text }) : navigator.clipboard.writeText(text)),
  openUrl: (url: string): Promise<void> => (inTauri ? tauriOpenUrl(url) : (window.open(url, "_blank"), Promise.resolve())),

  models: (base: string): Promise<string[]> =>
    inTauri ? invoke("llm_models", { base }) : Promise.resolve(["preview-model"]),
  chatStart: (
    id: string,
    base: string,
    model: string,
    messages: { role: string; content: string }[],
    extra?: Record<string, unknown>,
  ): Promise<void> => (inTauri ? invoke("chat_start", { id, base, model, messages, extra: extra ?? null }) : Promise.resolve()),
  chatCancel: (id: string): Promise<void> => (inTauri ? invoke("chat_cancel", { id }) : Promise.resolve()),
  chatsList: (all: boolean): Promise<ChatSession[]> => (inTauri ? invoke("chats_list", { all }) : Promise.resolve(mockChats())),
  /** Types `text` into a background session (live or finished) as your next message. */
  /** What's on the Windows clipboard for a chat message: copied files (their paths), an image (saved as PNG), else text. */
  clipboardGrab: (): Promise<{ files: string[]; text: string | null }> => (inTauri ? invoke("clipboard_grab") : Promise.resolve({ files: [], text: null })),
  /** Saves a dropped file that has no path on disk (base64 bytes); returns where it went. */
  attachSave: (name: string, data: string): Promise<string> => invoke("attach_save", { name, data }),
  onDrop: (cb: (e: { token: string; paths: string[] }) => void): Promise<UnlistenFn> =>
    inTauri ? listen<{ token: string; paths: string[] }>("hangar://drop", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  chatsSend: (id: string, sessionId: string, cwd: string, name: string, text: string): Promise<SentResult> =>
    inTauri ? invoke("chats_send", { id, sessionId, cwd, name, text }) : Promise.resolve({ id, session_id: sessionId, queued: false }),
  /** A Claude Code transcript as you / Claude messages, with tool calls as short lines. */
  sessionRead: (sessionId: string, cwd: string): Promise<ClaudeConversation> =>
    inTauri ? invoke("session_read", { sessionId, cwd, limit: 400, tools: true }) : Promise.resolve(mockConversation(sessionId)),
  /** [size, modified ms] of a transcript, or null before it exists. Cheap enough to poll. */
  sessionStamp: (sessionId: string, cwd: string): Promise<[number, number] | null> =>
    inTauri ? invoke("session_stamp", { sessionId, cwd }) : Promise.resolve([1, 1]),
  chatsStop: (id: string): Promise<void> => invoke("chats_stop", { id }),
  chatsNew: (cwd: string, name: string, prompt: string): Promise<string> => invoke("chats_new", { cwd, name, prompt }),
  chatsOpenExternal: (id: string, title: string): Promise<void> => invoke("chats_open_external", { id, title }),
  /** Stops the chat if needed and moves its files to ~/.claude/chat-archive. Returns that folder ("" if nothing was on disk). */
  /** What closing a session would end: whether it runs, and every process it started. */
  chatsProcs: (sessionId: string): Promise<SessionProcs> =>
    inTauri ? invoke("chats_procs", { sessionId }) : Promise.resolve({ running: true, kind: "background", worker: 1, procs: [{ pid: 4242, name: "node.exe", cmd: "node server.js", ports: [3999], mem: 120, via: "env", refused: null, yours: false }] }),
  /** Ends the session, kills its processes except `keep`, and (with `archive`) archives its conversation. */
  chatsClose: (id: string, sessionId: string, cwd: string, name: string, keep: number[], archive: boolean): Promise<Closed> =>
    inTauri ? invoke("chats_close", { id, sessionId, cwd, name, keep, archive }) : Promise.resolve({ ended: true, killed: [], left: [], archived: "" }),
  /** The conversation's transcript file ("" when not found). */
  sessionPath: (sessionId: string, cwd: string): Promise<string> => (inTauri ? invoke("session_path", { sessionId, cwd }) : Promise.resolve("")),
  chatsDone: (id: string, sessionId: string, cwd: string, name: string): Promise<string> =>
    inTauri ? invoke("chats_done", { id, sessionId, cwd, name }) : Promise.resolve(""),
  phoneStatus: (): Promise<PhoneStatus> =>
    inTauri ? invoke("phone_status") : Promise.resolve({ running: false, pid: 0, cwd: "", started: 0, url: "" }),
  phoneStart: (cwd: string): Promise<PhoneStatus> => invoke("phone_start", { cwd }),
  phoneStop: (): Promise<PhoneStatus> => invoke("phone_stop"),
  remoteStatus: (): Promise<RemoteStatus> =>
    inTauri
      ? invoke("remote_status")
      : Promise.resolve({ enabled: false, running: false, port: 3622, urls: ["http://192.168.0.20:3622"], devices: [], error: "", pairing: null }),
  remoteSet: (enabled: boolean): Promise<RemoteStatus> => invoke("remote_set", { enabled }),
  remotePair: (): Promise<RemoteStatus> => invoke("remote_pair"),
  remotePairCancel: (): Promise<RemoteStatus> => invoke("remote_pair_cancel"),
  remoteRevoke: (id: string): Promise<RemoteStatus> => invoke("remote_revoke", { id }),
  ptyOpen: (key: string, program: string, args: string[], cwd: string, cols: number, rows: number): Promise<boolean> =>
    inTauri ? invoke("pty_open", { key, program, args, cwd, cols, rows }) : Promise.resolve(false),
  ptyWrite: (key: string, data: string): Promise<void> => (inTauri ? invoke("pty_write", { key, data }) : Promise.resolve()),
  ptyResize: (key: string, cols: number, rows: number): Promise<void> =>
    inTauri ? invoke("pty_resize", { key, cols, rows }) : Promise.resolve(),
  ptyClose: (key: string): Promise<void> => (inTauri ? invoke("pty_close", { key }) : Promise.resolve()),
  onPty: (cb: (e: { key: string; kind: PtyKind; data: string }) => void): Promise<UnlistenFn> =>
    inTauri ? listen<{ key: string; kind: PtyKind; data: string }>("hangar://pty", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  onChat: (cb: (e: ChatEvent) => void): Promise<UnlistenFn> =>
    inTauri ? listen<ChatEvent>("hangar://chat", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  tts: async (text: string, voice: string, speed = 1): Promise<Blob> => {
    const buf = await invoke<ArrayBuffer>("tts", { text, voice, speed });
    return new Blob([buf], { type: "audio/wav" });
  },
  roles: (): Promise<{ path: string; config: RolesConfig }> =>
    inTauri
      ? invoke("roles_get")
      : fetch("/registry/model-roles.json").then(async (r) => ({ path: "registry/model-roles.json (preview)", config: (await r.json()) as RolesConfig })),
  saveRoles: (config: RolesConfig): Promise<void> => (inTauri ? invoke("roles_save", { config }) : Promise.resolve()),
  openRoles: (): Promise<void> => (inTauri ? invoke("roles_open") : Promise.resolve()),
  ollamaLoaded: (host: string): Promise<LoadedModel[]> => (inTauri ? invoke("ollama_loaded", { host }) : Promise.resolve([])),
  ollamaUnload: (host: string): Promise<LoadedModel[]> => (inTauri ? invoke("ollama_unload", { host }) : Promise.resolve([])),
  ttsVoices: (): Promise<string[]> => (inTauri ? invoke("tts_voices") : Promise.resolve(["af_heart", "am_michael"])),
  hookStatus: (): Promise<{ installed: boolean; events: string[]; settings?: string }> =>
    inTauri ? invoke("hook_status") : Promise.resolve({ installed: true, events: ["Stop", "Notification"] }),
  inboxRead: (knownSig: string | null): Promise<{ sig: string; items: InboxItem[] | null }> =>
    inTauri ? invoke("inbox_read", { knownSig }) : Promise.resolve({ sig: "x", items: knownSig === "x" ? null : mockInbox() }),
  inboxClear: (): Promise<void> => (inTauri ? invoke("inbox_clear") : Promise.resolve()),
  notifySettings: (settings: Record<string, unknown>): Promise<void> =>
    inTauri ? invoke("notify_settings_set", { settings }) : Promise.resolve(),
  stt: (endpoint: string, audioB64: string, mime: string): Promise<string> =>
    invoke("stt", { endpoint, audioB64, mime }),
};

export interface InboxItem {
  id: string;
  at: number;
  kind: "done" | "waiting";
  session_id: string;
  cwd: string;
  project: string;
  title?: string;
  text: string;
}

export interface SessionProc {
  pid: number;
  name: string;
  cmd: string;
  ports: number[];
  mem: number;
  /** "child" runs under the session; "env" was started by it and outlived its parent. */
  via: "child" | "env";
  refused: string | null;
  /** A desktop app you likely use yourself: starts unticked. */
  yours: boolean;
}

export interface SessionProcs {
  running: boolean;
  kind: string;
  worker: number | null;
  procs: SessionProc[];
}

export interface Closed {
  ended: boolean;
  killed: string[];
  left: string[];
  archived: string;
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

function mockProcs(): ProcSnapshot {
  const row = (pid: number, name: string, cmd: string, cwd: string, cpu: number, mem: number, ports: number[] = [], vram = 0, ppid: number | null = 1) => ({
    pid, ppid, name, exe: "", cmd, cwd, cpu, mem, ports, vram, gpu_load: vram ? 20 : 0, gpu: vram > 0,
  });
  return {
    self_pid: 999999,
    rows: [
      row(4100, "python.exe", "python.exe main.py --listen", "D:/AI/ComfyUI", 6.2, 2310, [8188], 5200),
      row(4101, "python.exe", "python.exe app.py", "D:/Projects/notes-app", 0.4, 410, [5000]),
      row(4102, "node.exe", "node server.mjs", "D:/Projects/dashboard", 0.1, 120, [8000]),
      row(4103, "python.exe", "python.exe scratch_test.py", "D:/Projects/_scratch", 12.5, 260),
      row(5000, "chrome.exe", "chrome.exe", "", 3.1, 1800, [], 300),
      row(5001, "chrome.exe", "chrome.exe --type=renderer", "", 1.2, 900),
      row(5002, "obs64.exe", "obs64.exe", "", 9.4, 900, [], 600),
    ],
  };
}

function mockOverview(): Overview {
  const wave = (i: number) => Math.max(0, Math.min(100, 12 + 30 * Math.abs(Math.sin(Date.now() / 4000 + i)) + Math.random() * 8));
  const disk = (mount: string, label: string, kind: "SSD" | "HDD", tb: number, freeTb: number) => ({
    mount, label, fs: "NTFS", kind, total: tb * 1e12, free: freeTb * 1e12, removable: false,
    read_bps: Math.random() * 40e6, write_bps: Math.random() * 12e6,
  });
  return {
    host: { name: "DESKTOP-PREVIEW", os: "Windows 11", uptime_s: 3 * 86400 + 4 * 3600 + 120, cpu: "Preview CPU (8 cores)", cores: 8, threads: 16 },
    cores: Array.from({ length: 16 }, (_, i) => wave(i)),
    cpu_mhz: 3400 + Math.round(Math.random() * 900),
    gpu: {
      name: "NVIDIA GeForce RTX 4070", driver: "560.00", util: 8, mem_util: 1, mem_used: 5725, mem_total: 12282, temp: 43,
      power: 37, power_limit: 200, fan: 0, clock_gr: 360, clock_mem: 10501, clock_gr_max: 2760, clock_mem_max: 10501,
      pstate: "P0", encoder: 0, decoder: 2, pcie_gen: 4, pcie_width: 16,
    },
    disks: [disk("C:\\", "Windows", "SSD", 1, 0.41), disk("D:\\", "Data", "SSD", 2, 0.9)],
    nets: [{ name: "Ethernet", rx_bps: Math.random() * 3e6, tx_bps: Math.random() * 6e5, total_rx: 9e11, total_tx: 2e11 }],
  };
}
