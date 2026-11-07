// Works out which tool, project or script each running process belongs to,
// and groups them so the process panel shows "My Tool" rather than three
// anonymous python.exe rows.
import type { Theme, Tool } from "./types";

export interface ProcRow {
  pid: number;
  ppid: number | null;
  name: string;
  exe: string;
  cmd: string;
  /** The real argv (first 24, capped); older backends omit it. */
  args?: string[];
  cwd: string;
  /** Share of the whole machine, 0-100 (Task Manager style). */
  cpu: number;
  /** Working set, MB. */
  mem: number;
  ports: number[];
  /** VRAM resident on the card in MB, when the driver reports it. */
  vram: number | null;
  /** GPU engine load for this process, 0-100. */
  gpu_load: number;
  gpu: boolean;
}

export interface ProcSnapshot {
  self_pid: number;
  rows: ProcRow[];
}

export type OwnerKind = "tool" | "project" | "script" | "other";

export interface Owner {
  kind: OwnerKind;
  key: string;
  name: string;
  color?: string;
  tool?: Tool;
  detail?: string;
}

export interface Group {
  owner: Owner;
  procs: ProcRow[];
  cpu: number;
  mem: number;
  vram: number;
  gpu: boolean;
  ports: number[];
  scripts: string[];
}

export interface ProjectRef {
  name: string;
  path: string;
}

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const SCRIPT_RE = /\.(py|pyw|js|mjs|cjs|ts)$/i;
const RUNTIME_RE = /^(python|pythonw|node|bun|deno|uv|uvicorn)(\d[\d.]*)?\.exe$/i;

/** Splits a Windows command line, honoring double quotes. */
export function argv(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2]);
  return out;
}

/** "...\node_modules\@anthropic-ai\claude-code\cli.js" -> "@anthropic-ai/claude-code". */
export function packageOf(path: string): string | null {
  const parts = path.split(/[\\/]/);
  const i = parts.map((p) => p.toLowerCase()).lastIndexOf("node_modules");
  if (i < 0 || !parts[i + 1]) return null;
  return parts[i + 1].startsWith("@") && parts[i + 2] ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
}

/** Friendlier names for well-known programs. */
function friendly(name: string): string {
  if (/^claude\.exe$/i.test(name) || name === "@anthropic-ai/claude-code") return "Claude Code";
  return name;
}

/** The script or module a runtime process is running, e.g. "server.py" or "-m uvicorn". */
export function scriptOf(row: ProcRow): string | null {
  if (!RUNTIME_RE.test(row.name)) return null;
  const args = argv(row.cmd).slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m" && args[i + 1]) return `-m ${args[i + 1]}`;
    if (SCRIPT_RE.test(args[i])) {
      // node_modules scripts say little ("cli.js"): name the package instead.
      const pkg = packageOf(args[i]);
      if (pkg === "npm" && /npx-cli\.js$/i.test(args[i])) {
        const target = args.slice(i + 1).find((a) => !a.startsWith("-"));
        return target ? `npx ${target}` : "npx";
      }
      return pkg ?? args[i].split(/[\\/]/).pop() ?? args[i];
    }
  }
  // npm/vite style: node <path>\vite.js dev, or a bare command after node
  const first = args.find((a) => !a.startsWith("-"));
  return first ? first.split(/[\\/]/).pop() ?? first : null;
}

interface PathOwner {
  path: string;
  owner: Owner;
  /** Holds other registered folders (e.g. D:/Projects/tools): match only an exact working folder. */
  container: boolean;
}

// Shared install folders say nothing about which tool a process belongs to.
const SHARED_ROOT = /^[a-z]:\\(program files( \(x86\))?|windows|programdata)(\\|$)|\\appdata\\|\\(anaconda3|miniconda3|miniforge3|mambaforge|python3\d*)(\\|$)/;
// Pure launch wrappers an app uses to spawn helpers (MCP servers via cmd /c npx ...): look through them.
const WRAPPER_RE = /^(cmd|conhost|npm|npx|uv|uvx)\.exe$/i;
// Interpreters, shells and the desktop: whatever they start is someone's script, not an app's helper.
const NOT_APP_RE = /^(bash|sh|mintty|git-bash|pwsh|powershell|windowsterminal|wt|openconsole|explorer|services|svchost|wininit|py|python\d*(\.\d+)?|pythonw|node|bun|deno|wscript|cscript|timeout)\.exe$/i;

function pathOwners(tools: Tool[], themes: Theme[], projects: ProjectRef[]): PathOwner[] {
  const color = (t: Tool) => themes.find((x) => x.id === t.theme)?.color;
  const out: PathOwner[] = [];
  for (const t of tools) {
    const owner: Owner = { kind: "tool", key: `tool:${t.id}`, name: t.name, color: color(t), tool: t };
    for (const p of [t.start?.cwd, t.folder]) if (p) out.push({ path: norm(p), owner, container: false });
  }
  for (const p of projects) {
    out.push({ path: norm(p.path), owner: { kind: "project", key: `project:${norm(p.path)}`, name: p.name }, container: false });
  }
  // A path needs at least three parts (D:/Projects/x) so whole drives or D:/Projects never match.
  const kept = out.filter((o) => o.path.split("\\").length >= 3 && !SHARED_ROOT.test(o.path));
  const distinct = [...new Set(kept.map((o) => o.path))];
  for (const o of kept) {
    o.container = distinct.filter((d) => d !== o.path && d.startsWith(o.path + "\\")).length >= 2;
  }
  return kept.sort((a, b) => b.path.length - a.path.length);
}

function portOwner(row: ProcRow, tools: Tool[], themes: Theme[]): Owner | null {
  const t = tools.find((x) => x.port && row.ports.includes(x.port));
  if (!t) return null;
  return { kind: "tool", key: `tool:${t.id}`, name: t.name, color: themes.find((x) => x.id === t.theme)?.color, tool: t };
}

function ownerFor(row: ProcRow, tools: Tool[], themes: Theme[], paths: PathOwner[]): Owner | null {
  const color = (t: Tool) => themes.find((x) => x.id === t.theme)?.color;
  const asTool = (t: Tool): Owner => ({ kind: "tool", key: `tool:${t.id}`, name: t.name, color: color(t), tool: t });

  const byPort = portOwner(row, tools, themes);
  if (byPort) return byPort;
  const exe = norm(row.exe);
  const byExe = exe && !SHARED_ROOT.test(exe) && tools.find((t) => t.exe && norm(t.exe) === exe);
  if (byExe) return asTool(byExe);

  const cwd = norm(row.cwd);
  // Whole arguments only: a folder merely mentioned inside one long argument (Hangar's own
  // assistant carries a system prompt full of tool paths) used to file the assistant and
  // its helpers under some other tool. `--path=X` and stray quotes are peeled off.
  const args = (row.args ?? argv(row.cmd)).map((a) => norm(a.replace(/"/g, "").trim().replace(/^--?[\w-]+=/, "")));
  for (const p of paths) {
    const hit = p.container
      ? cwd === p.path
      : (cwd && (cwd === p.path || cwd.startsWith(p.path + "\\"))) ||
        args.some((a) => a === p.path || a.startsWith(p.path + "\\")) ||
        (exe && exe.startsWith(p.path + "\\"));
    if (hit) return p.owner;
  }
  return null;
}

export function groupProcesses(snap: ProcSnapshot, tools: Tool[], themes: Theme[], projects: ProjectRef[]): Group[] {
  // Drop Hangar itself and its WebView2 helpers. Tools Hangar started stay visible.
  const byPid = new Map(snap.rows.map((r) => [r.pid, r]));
  const isHangar = (r: ProcRow) => {
    if (r.pid === snap.self_pid) return true;
    let cur: ProcRow | undefined = r;
    for (let i = 0; i < 8 && cur && /^msedgewebview2\.exe$/i.test(cur.name); i++) {
      if (cur.ppid === snap.self_pid) return true;
      cur = cur.ppid != null ? byPid.get(cur.ppid) : undefined;
    }
    return false;
  };
  /** The nearest ancestor that is a real app (not a shell or runtime), e.g. claude.exe or Code.exe. */
  const launchingApp = (r: ProcRow): ProcRow | null => {
    let cur = r.ppid != null ? byPid.get(r.ppid) : undefined;
    for (let i = 0; i < 10 && cur; i++) {
      if (cur.pid === snap.self_pid || NOT_APP_RE.test(cur.name)) return null;
      if (!WRAPPER_RE.test(cur.name)) return cur;
      cur = cur.ppid != null ? byPid.get(cur.ppid) : undefined;
    }
    return null;
  };
  const rows = snap.rows.filter((r) => !isHangar(r));

  const paths = pathOwners(tools, themes, projects);
  const base = new Map<number, Owner>();
  for (const r of rows) {
    const o = ownerFor(r, tools, themes, paths);
    if (o) base.set(r.pid, o);
  }
  // Precedence: a listening port names a tool outright. Otherwise a helper an
  // unmatched app spawned (Claude Code's MCP servers) belongs to that app, even
  // when its files live in a tool's folder. Then folder/exe matches.
  const owners = new Map<number, Owner>();
  for (const r of rows) {
    const byPort = portOwner(r, tools, themes);
    if (byPort) {
      owners.set(r.pid, byPort);
      continue;
    }
    const app = launchingApp(r);
    if (app && !base.has(app.pid) && RUNTIME_RE.test(r.name)) {
      const name = friendly(app.name);
      owners.set(r.pid, { kind: "other", key: `other:${name.toLowerCase()}`, name });
      continue;
    }
    const o = base.get(r.pid);
    if (o) owners.set(r.pid, o);
  }
  // Children inherit their parent's owner (venv launcher pairs, node workers).
  for (let pass = 0; pass < 4; pass++) {
    for (const r of rows) {
      if (owners.has(r.pid) || r.ppid == null) continue;
      const parent = owners.get(r.ppid);
      if (parent && byPid.has(r.ppid)) owners.set(r.pid, parent);
    }
  }
  for (const r of rows) {
    if (owners.has(r.pid)) continue;
    const script = scriptOf(r);
    if (script && friendly(script) !== script) {
      // Claude Code run as `node cli.js`: one app, never a one-click script.
      const name = friendly(script);
      owners.set(r.pid, { kind: "other", key: `other:${name.toLowerCase()}`, name });
    } else if (script) {
      const folder = r.cwd ? r.cwd.replace(/\\+$/, "").split("\\").slice(-2).join("\\") : "";
      owners.set(r.pid, { kind: "script", key: `script:${norm(r.cwd)}|${script}`, name: script, detail: folder });
    } else {
      const name = friendly(r.name);
      owners.set(r.pid, { kind: "other", key: `other:${name.toLowerCase()}`, name });
    }
  }

  const groups = new Map<string, Group>();
  for (const r of rows) {
    const o = owners.get(r.pid)!;
    let g = groups.get(o.key);
    if (!g) {
      g = { owner: o, procs: [], cpu: 0, mem: 0, vram: 0, gpu: false, ports: [], scripts: [] };
      groups.set(o.key, g);
    }
    g.procs.push(r);
    g.cpu += r.cpu;
    g.mem += r.mem;
    g.vram += r.vram ?? 0;
    g.gpu ||= r.gpu;
    for (const p of r.ports) if (!g.ports.includes(p)) g.ports.push(p);
    const s = scriptOf(r);
    if (s && !g.scripts.includes(s)) g.scripts.push(s);
  }
  return [...groups.values()];
}

/** Groups that belong to no tool or project, merged by program name so 30 browser processes are one row. */
export function mergeOthers(groups: Group[]): Group[] {
  const byName = new Map<string, Group>();
  for (const g of groups.filter((x) => x.owner.kind === "other")) {
    const key = g.owner.name.toLowerCase();
    const cur = byName.get(key);
    if (!cur) byName.set(key, { ...g, owner: { ...g.owner, key: `other:${key}` }, procs: [...g.procs], ports: [...g.ports] });
    else {
      cur.procs.push(...g.procs);
      cur.cpu += g.cpu;
      cur.mem += g.mem;
      cur.vram += g.vram;
      cur.gpu ||= g.gpu;
    }
  }
  return [...byName.values()];
}
