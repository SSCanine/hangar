export type ToolKind = "web" | "app" | "service";

export interface StartSpec {
  cmd: string[];
  cwd?: string;
  window: "hidden" | "minimized" | "console";
  env?: Record<string, string>;
}

export interface Tool {
  id: string;
  name: string;
  theme: string;
  description: string;
  kind: ToolKind;
  url?: string;
  port?: number;
  health?: string;
  embed: boolean;
  start?: StartSpec;
  stoppable: boolean;
  exe?: string;
  folder?: string;
  views?: { name: string; path: string }[];
  gpu: boolean;
  env_strip_claude?: boolean;
  token_file?: string;
  notes?: string;
  also_themes?: string[];
  hosted_in?: { tool: string; tab: string };
  parts?: string[];
  /** The hub app this tool was merged into (a tool id): theme lists show it on the hub's row. */
  part_of?: string;
  [extra: string]: unknown;
}

export interface Theme {
  id: string;
  name: string;
  color: string;
  icon: string;
}

export interface Registry {
  version: number;
  themes: Theme[];
  tools: Tool[];
}

export interface ToolStatus {
  id: string;
  running: boolean;
  via: "http" | "tcp" | "process" | "none";
  ms: number;
}

export interface GpuStats {
  name: string;
  util: number;
  mem_used: number;
  mem_total: number;
  temp: number;
  power: number;
}

export interface SysStats {
  cpu: number;
  threads: number;
  mem_used: number;
  mem_total: number;
  commit_used: number;
  commit_total: number;
}

/** The System page's extra readout (Rust overview.rs). */
export interface GpuDetail {
  name: string;
  driver: string;
  util: number | null;
  mem_util: number | null;
  mem_used: number | null;
  mem_total: number | null;
  temp: number | null;
  power: number | null;
  power_limit: number | null;
  fan: number | null;
  clock_gr: number | null;
  clock_mem: number | null;
  clock_gr_max: number | null;
  clock_mem_max: number | null;
  pstate: string;
  encoder: number | null;
  decoder: number | null;
  pcie_gen: number | null;
  pcie_width: number | null;
}

export interface DiskRow {
  mount: string;
  label: string;
  fs: string;
  kind: "SSD" | "HDD" | "";
  total: number;
  free: number;
  removable: boolean;
  read_bps: number;
  write_bps: number;
}

export interface NetRow {
  name: string;
  rx_bps: number;
  tx_bps: number;
  total_rx: number;
  total_tx: number;
}

export interface Overview {
  host: { name: string; os: string; uptime_s: number; cpu: string; cores: number; threads: number };
  cores: number[];
  cpu_mhz: number;
  gpu: GpuDetail | null;
  disks: DiskRow[];
  nets: NetRow[];
}

export interface ProjectItem {
  name: string;
  path?: string;
  url?: string;
  description?: string;
  [k: string]: unknown;
}

export interface ProjectGroup {
  name: string;
  items: ProjectItem[];
}

export type View =
  | { type: "home" }
  | { type: "theme"; id: string }
  | { type: "tool"; id: string }
  | { type: "projects" }
  | { type: "system" }
  | { type: "chats" }
  | { type: "settings" };

/** One line of a Claude Code transcript: what you typed, Claude's reply, or a tool it ran. */
export interface ClaudeMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  at: string;
}

export interface ClaudeConversation {
  session_id: string;
  title: string;
  cwd: string;
  path: string;
  modified: number;
  total: number;
  messages: ClaudeMessage[];
}

/** A background chat Hangar has seen, kept so it can be reopened after `claude agents` forgets it. */
/** A message on its way into a Claude chat. waiting: behind an earlier one; sending: being typed in;
 * queued: in Claude Code's queue (Claude was busy); sent: taken as the next message; failed: not
 * delivered, kept so it can be retried or edited. Dropped once it shows up in the transcript. */
export interface OutItem {
  key: number;
  text: string;
  state: "waiting" | "sending" | "queued" | "sent" | "failed";
  error?: string;
  /** How many identical messages the transcript already had, so an old one doesn't count. */
  seen: number;
}

export interface ClaudeChatRef {
  id: string;
  session_id: string;
  name: string;
  cwd: string;
  updated: number;
}

/** A Claude Code session from `claude agents --json --all`. */
export interface ChatSession {
  id: string;
  session_id: string;
  name: string;
  cwd: string;
  /** background | interactive */
  kind: string;
  /** Live process status: busy | idle | shell ... */
  status: string;
  /** working | done | blocked | failed ... */
  state: string;
  detail: string;
  /** Epoch ms of the last update. */
  updated: number;
  running: boolean;
}

/** Hangar Remote: the phone page Hangar serves on the home network. */
export interface RemoteDevice {
  id: string;
  name: string;
  created: number;
  last_seen: number;
  last_ip: string;
}

export interface RemotePairing {
  code: string;
  url: string;
  /** QR code of `url`, as SVG markup. */
  qr: string;
  /** Epoch ms the code stops working. */
  expires: number;
}

export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** http://<home IP>:<port>, home network first. */
  urls: string[];
  devices: RemoteDevice[];
  error: string;
  pairing: RemotePairing | null;
}

/** Phone access: a hidden `claude remote-control` server Hangar switches on and off. */
export interface PhoneStatus {
  running: boolean;
  pid: number;
  cwd: string;
  /** Epoch ms it was switched on. */
  started: number;
  /** claude.ai/code link to this PC's sessions ("" until it has connected). */
  url: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  think?: string;
  error?: string;
  /** The reply was stopped part way. */
  stopped?: boolean;
  at: number;
}

export interface Conversation {
  id: string;
  title: string;
  endpoint: string;
  model: string;
  /** Model job (Quick, Writer...) when the chat ran on Ollama. */
  role?: string;
  messages: ChatMessage[];
  updated: number;
}

/** A job for local models: which models do it (best first) and how to ask them. */
export interface ModelRole {
  id: string;
  name: string;
  use_for: string;
  models: string[];
  temperature?: number;
  /** Let thinking models reason before answering. Off = faster replies. */
  think?: boolean;
  /** Include the list of Hangar tools in the system prompt. */
  knows_hangar?: boolean;
  prompt?: string;
  /** Overrides the file-wide keep_alive for this job. */
  keep_alive?: string;
}

export interface RolesConfig {
  _help?: string;
  version: number;
  keep_alive: string;
  unload_on_gpu_start: boolean;
  roles: ModelRole[];
}

export interface LoadedModel {
  name: string;
  /** MiB held in VRAM. */
  vram: number;
}
