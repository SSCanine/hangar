// What happens when you open, start or stop a tool. Shared by rows, the
// command palette and the assistant's action chips.
import { api, errText } from "./api";
import { useStore, toolById } from "./store";
import { freeGpu } from "./roles";
import type { Tool } from "./types";

const st = () => useStore.getState();

export async function refreshRegistry() {
  try {
    const { path, registry } = await api.registry();
    st().set({ registry, registryPath: path, registryError: null });
    const tokens: Record<string, string> = {};
    for (const t of registry.tools.filter((x) => x.token_file)) {
      const tok = await api.token(t.id).catch(() => null);
      if (tok) tokens[t.id] = tok;
    }
    st().set({ tokens });
  } catch (e) {
    st().set({ registryError: errText(e) });
  }
}

// A running tool must fail its health check for this long before it counts as down.
// One slow answer (a tool busy rendering) used to unmount its embedded page and wipe
// everything typed into it.
const DOWN_AFTER_MS = 12_000;
const firstMiss: Record<string, number> = {};

export async function refreshStatus() {
  try {
    const list = await api.statusAll();
    const prev = st().status;
    const now = Date.now();
    const status = Object.fromEntries(
      list.map((s) => {
        if (s.running || !prev[s.id]?.running) {
          delete firstMiss[s.id];
          return [s.id, s];
        }
        firstMiss[s.id] ??= now;
        return [s.id, now - firstMiss[s.id] < DOWN_AFTER_MS ? { ...s, running: true } : s];
      }),
    );
    const starting = { ...st().starting };
    for (const id of Object.keys(starting)) {
      if (status[id]?.running || Date.now() - starting[id] > 120_000) delete starting[id];
    }
    st().set({ status, starting });
  } catch {
    /* registry error is shown elsewhere */
  }
}

export const isRunning = (id: string) => !!st().status[id]?.running;

function gpuLine(): string {
  const g = st().gpu;
  if (!g) return "";
  return ` The GPU is using ${(g.mem_used / 1024).toFixed(1)} of ${(g.mem_total / 1024).toFixed(0)} GB right now.`;
}

/** Runs `go` straight away, or after a yes when starting this tool loads the GPU. */
function withGpuCheck(tool: Tool, go: () => void) {
  if (!tool.gpu || isRunning(tool.id)) return go();
  st().set({
    confirm: {
      title: `Start ${tool.name}?`,
      body: `${tool.name} loads the GPU when it starts.${gpuLine()}`,
      action: "Start it",
      onYes: go,
    },
  });
}

export async function startTool(tool: Tool): Promise<boolean> {
  if (isRunning(tool.id)) return true;
  if (!tool.start && !tool.exe) {
    st().toast(`${tool.name} has no start command. Start it yourself, or add one with Edit.`, "bad");
    return false;
  }
  try {
    st().set({ starting: { ...st().starting, [tool.id]: Date.now() } });
    // A local chat model can hold most of the VRAM; give it back before a GPU tool loads.
    if (tool.gpu && tool.id !== "ollama" && st().roles?.unload_on_gpu_start) await freeGpu(true);
    await api.start(tool.id);
    void refreshStatus();
    return true;
  } catch (e) {
    const starting = { ...st().starting };
    delete starting[tool.id];
    st().set({ starting });
    st().toast(errText(e), "bad");
    return false;
  }
}

export function requestStart(tool: Tool) {
  withGpuCheck(tool, () => void startTool(tool));
}

export function stopTool(tool: Tool) {
  if (tool.stoppable) return void doStop(tool, false);
  st().set({
    confirm: {
      title: `Stop ${tool.name}?`,
      body: `${tool.name} is marked as not safe to stop.${tool.notes ? ` ${tool.notes}` : ""}`,
      action: "Stop it",
      onYes: () => void doStop(tool, true),
    },
  });
}

async function doStop(tool: Tool, confirmed: boolean) {
  try {
    const n = await api.stop(tool.id, confirmed);
    // Stopped on purpose: show it as down now instead of waiting out DOWN_AFTER_MS.
    const cur = st().status[tool.id];
    if (cur) st().set({ status: { ...st().status, [tool.id]: { ...cur, running: false } } });
    st().toast(n ? `Stopped ${tool.name}` : `${tool.name} wasn't running`, "ok");
  } catch (e) {
    st().toast(errText(e), "bad");
  }
  setTimeout(refreshStatus, 600);
}

export function toolUrl(tool: Tool, path?: string): string {
  const base = tool.url ?? (tool.port ? `http://127.0.0.1:${tool.port}/` : "");
  let out = base;
  if (path) out = path.startsWith("#") ? base.replace(/#.*$/, "") + path : new URL(path, base).toString();
  const token = st().tokens[tool.id];
  if (token) {
    const u = new URL(out);
    u.searchParams.set("k", token);
    out = u.toString();
  }
  return out;
}

/** Starts a tool if needed and waits until it answers. */
export async function ensureRunning(id: string, ms = 90_000): Promise<boolean> {
  const t = toolById(st(), id);
  if (!t) return false;
  if (isRunning(id)) return true;
  if (!(await startTool(t))) return false;
  return waitUntilUp(id, ms);
}

async function waitUntilUp(id: string, ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await refreshStatus();
    if (isRunning(id)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** The main "open" verb: embed, focus a desktop app, or open in the browser. */
export function openTool(tool: Tool) {
  const s = st();
  s.touchRecent(tool.id);
  if (tool.kind === "app" && tool.exe) {
    withGpuCheck(tool, async () => {
      try {
        const how = await api.focus(tool.id);
        if (how === "started") s.toast(`Starting ${tool.name}`, "info");
      } catch (e) {
        s.toast(errText(e), "bad");
      }
    });
    return;
  }
  if (tool.kind === "web" && tool.embed) {
    withGpuCheck(tool, () => {
      st().openTab(tool.id);
      if (!isRunning(tool.id) && (tool.start || tool.exe)) void startTool(tool);
    });
    return;
  }
  if (tool.kind === "web") {
    withGpuCheck(tool, async () => {
      if (!isRunning(tool.id)) {
        const ok = await startTool(tool);
        if (!ok) return;
        s.toast(`Starting ${tool.name}, it opens in your browser when ready`, "info");
        if (!(await waitUntilUp(tool.id))) return s.toast(`${tool.name} didn't come up. Check its log.`, "bad");
      }
      void api.openUrl(toolUrl(tool, st().toolPath[tool.id]));
    });
    return;
  }
  // Background service: opening means starting it.
  requestStart(tool);
}

export function openInBrowser(tool: Tool) {
  void api.openUrl(toolUrl(tool, st().toolPath[tool.id]));
}

export function openById(id: string): boolean {
  const t = toolById(st(), id);
  if (!t) return false;
  openTool(t);
  return true;
}

export function primaryVerb(tool: Tool, running: boolean): string {
  if (tool.kind === "app") return running ? "Show" : "Launch";
  if (tool.kind === "service") return running ? "Running" : "Start";
  if (!tool.embed) return "Open in browser";
  return "Open";
}
