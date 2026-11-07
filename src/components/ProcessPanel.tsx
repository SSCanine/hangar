import clsx from "clsx";
import { ChevronRight, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errText } from "../lib/api";
import { groupProcesses, mergeOthers, scriptOf, type Group, type ProcRow, type ProcSnapshot, type ProjectRef } from "../lib/procmatch";
import { useStore } from "../lib/store";

export type Metric = "cpu" | "ram" | "gpu";

const NEVER_KILL = /^(system|registry|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|explorer|fontdrvhost|msmpeng|memcompression)(\.exe)?$/i;

function refusal(g: Group): string | null {
  const names = g.procs.map((p) => p.name);
  if (names.some((n) => NEVER_KILL.test(n))) return "Part of Windows, so Hangar won't kill it.";
  return null;
}

const fmtMem = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const fmtCpu = (c: number) => (c >= 10 ? `${Math.round(c)}%` : c >= 0.1 ? `${c.toFixed(1)}%` : "0%");

function weight(g: { cpu: number; mem: number; vram: number; gpu?: boolean }, m: Metric) {
  return m === "cpu" ? g.cpu : m === "ram" ? g.mem : g.vram + (g.gpu ? 0.5 : 0);
}

function Cells({ cpu, mem, vram, metric, showVram }: { cpu: number; mem: number; vram: number; metric: Metric; showVram: boolean }) {
  const cell = (m: Metric) => clsx("w-[62px] text-right num", metric === m ? "text-moon" : "text-faint");
  return (
    <>
      <span className={cell("cpu")}>{fmtCpu(cpu)}</span>
      <span className={cell("ram")}>{fmtMem(mem)}</span>
      <span className={cell("gpu")}>{showVram ? (vram ? fmtMem(vram) : "") : "n/a"}</span>
    </>
  );
}

function ProcLine({ p, metric, showVram, onKill }: { p: ProcRow; metric: Metric; showVram: boolean; onKill: () => void }) {
  const script = scriptOf(p);
  return (
    <div className="flex items-center gap-2 h-7 pl-9 pr-3 text-[12px] text-dim hover:bg-raise/40">
      <span className="w-[54px] text-faint num">{p.pid}</span>
      <span className="flex-1 min-w-0 truncate selectable" title={p.cmd || p.exe}>
        {p.name}
        {script && <span className="text-faint"> {script}</span>}
        {p.ports.length > 0 && <span className="text-faint"> :{p.ports.join(", :")}</span>}
      </span>
      <Cells cpu={p.cpu} mem={p.mem} vram={p.vram ?? 0} metric={metric} showVram={showVram} />
      <button title={`End process ${p.pid}`} onClick={onKill} className="w-6 h-6 grid place-items-center rounded text-faint hover:text-bad hover:bg-bad/10">
        <X size={12} />
      </button>
    </div>
  );
}

export function ProcessPanel() {
  const metric = useStore((s) => s.procPanel);
  const registry = useStore((s) => s.registry);
  const { set, toast } = useStore.getState();
  const [snap, setSnap] = useState<ProcSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!metric) return;
    let alive = true;
    const tick = () =>
      api
        .procs()
        .then((s) => alive && (setSnap(s), setErr(null)))
        .catch((e) => alive && setErr(errText(e)));
    tick();
    const t = setInterval(tick, 2000);
    if (!projects.length) {
      api
        .projects()
        .then((raw) => {
          const groups = (raw as { groups?: { items: { name: string; path?: string }[] }[] }).groups ?? [];
          setProjects(groups.flatMap((g) => g.items.filter((i) => i.path).map((i) => ({ name: i.name, path: i.path! }))));
        })
        .catch(() => {});
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ procPanel: null });
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [metric, projects.length, set]);

  const groups = useMemo(
    () => (snap && registry ? groupProcesses(snap, registry.tools, registry.themes, projects) : []),
    [snap, registry, projects],
  );

  if (!metric) return null;
  const showVram = !!snap?.rows.some((r) => r.vram !== null);
  const usesGpu = (g: Group) => g.vram > 0 || g.gpu;
  const mine = groups
    .filter((g) => g.owner.kind !== "other" && (metric !== "gpu" || usesGpu(g)))
    .sort((a, b) => weight(b, metric) - weight(a, metric));

  const others = mergeOthers(groups)
    .filter((g) => (metric === "gpu" ? g.vram > 0 || g.gpu : true))
    .sort((a, b) => weight(b, metric) - weight(a, metric))
    .slice(0, 8);

  async function kill(key: string, label: string, pids: number[]) {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const n = await api.killProcs(pids);
      toast(n ? `Stopped ${label}${n > 1 ? ` (${n} processes)` : ""}` : `${label} had already exited`, "ok");
      setSnap(await api.procs());
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  function stopGroup(g: Group) {
    const why = refusal(g);
    if (why) return toast(why, "bad");
    const label = g.owner.name;
    const pids = g.procs.map((p) => p.pid);
    const unsafeTool = g.owner.kind === "tool" && g.owner.tool && !g.owner.tool.stoppable;
    if (unsafeTool || g.owner.kind === "other") {
      set({
        confirm: {
          title: `Stop ${label}?`,
          body: unsafeTool
            ? `${label} is marked as not safe to stop. ${g.owner.tool?.notes ?? ""}`.trim()
            : `This ends ${pids.length === 1 ? "the process" : `all ${pids.length} processes`} named ${label}. Unsaved work in it is lost.`,
          action: "Stop it",
          onYes: () => void kill(g.owner.key, label, pids),
        },
      });
      return;
    }
    void kill(g.owner.key, label, pids);
  }

  function killOne(p: ProcRow) {
    if (NEVER_KILL.test(p.name)) return toast(`Hangar won't kill ${p.name}`, "bad");
    void kill(`pid:${p.pid}`, `${p.name} (${p.pid})`, [p.pid]);
  }

  const row = (g: Group, sub: string) => {
    const k = g.owner.key;
    const why = refusal(g);
    return (
      <div key={k}>
        <div className="group flex items-center gap-2 h-10 pl-3 pr-3 hover:bg-raise/40">
          <button onClick={() => setOpen((o) => ({ ...o, [k]: !o[k] }))} className="flex-1 min-w-0 flex items-center gap-2 text-left h-full">
            <ChevronRight size={13} className={clsx("text-faint shrink-0 transition-transform", open[k] && "rotate-90")} />
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.owner.color ?? (g.owner.kind === "other" ? "var(--color-line)" : "var(--color-dim)") }} />
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] leading-tight">{g.owner.name}</span>
              <span className="block truncate text-[11.5px] text-faint leading-tight">{sub}</span>
            </span>
          </button>
          <Cells cpu={g.cpu} mem={g.mem} vram={g.vram} metric={metric} showVram={showVram} />
          <button
            disabled={busy[k]}
            title={why ?? `Stop ${g.owner.name}`}
            onClick={() => stopGroup(g)}
            className={clsx(
              "w-[64px] h-7 rounded-md text-[12px] flex items-center justify-center gap-1 transition-colors",
              why ? "text-faint/50 cursor-not-allowed" : "text-dim hover:bg-bad hover:text-night",
            )}
          >
            <Square size={10} /> {busy[k] ? "…" : "Stop"}
          </button>
        </div>
        {open[k] && g.procs.map((p) => <ProcLine key={p.pid} p={p} metric={metric} showVram={showVram} onKill={() => killOne(p)} />)}
      </div>
    );
  };

  const subFor = (g: Group) => {
    const bits: string[] = [];
    bits.push(g.procs.length === 1 ? "1 process" : `${g.procs.length} processes`);
    if (g.owner.kind === "project") bits.push("project");
    if (g.owner.kind === "script" && g.owner.detail) bits.push(g.owner.detail);
    if (g.ports.length) bits.push(g.ports.map((p) => `:${p}`).join(" "));
    if (g.owner.kind !== "script" && g.scripts.length) bits.push(g.scripts.slice(0, 2).join(", "));
    return bits.join(", ");
  };

  const tabs: { id: Metric; label: string }[] = [
    { id: "cpu", label: "CPU" },
    { id: "ram", label: "RAM" },
    { id: "gpu", label: "GPU" },
  ];

  return (
    <div className="fixed inset-0 z-40" onMouseDown={() => set({ procPanel: null })}>
      <div
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-12 right-36 w-[640px] max-w-[calc(100vw-24px)] max-h-[74vh] flex flex-col rounded-2xl border border-line bg-panel shadow-[0_24px_80px_-20px_rgba(0,0,0,.75)] overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line shrink-0">
          <span className="font-medium">Processes</span>
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-night/60 border border-line">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => set({ procPanel: t.id })}
                className={clsx("h-6 px-2.5 rounded-md text-[12.5px]", metric === t.id ? "bg-raise text-moon" : "text-dim hover:text-moon")}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <div className="flex gap-2 text-[11.5px] text-faint pr-[74px]">
            <span className="w-[62px] text-right">CPU</span>
            <span className="w-[62px] text-right">RAM</span>
            <span className="w-[62px] text-right">VRAM</span>
          </div>
        </div>

        <div className="overflow-y-auto">
          {err && <p className="px-4 py-3 text-bad text-[13px]">{err}</p>}
          {!snap && !err && <p className="px-4 py-6 text-dim text-[13px]">Reading processes…</p>}
          {snap && (
            <>
              <div className="px-4 pt-3 pb-1 text-[12px] text-faint">Your tools and scripts</div>
              {mine.length === 0 && (
                <p className="px-4 pb-2 text-[13px] text-dim">
                  {metric === "gpu" ? "None of your tools or scripts are using the GPU right now." : "None of your tools or scripts are running."}
                </p>
              )}
              {mine.map((g) => row(g, subFor(g)))}
              <div className="px-4 pt-4 pb-1 text-[12px] text-faint border-t border-line/60 mt-2">
                {metric === "gpu" ? "Other apps using the GPU" : "Other heavy apps"}
              </div>
              {others.map((g) => row(g, g.procs.length === 1 ? "1 process" : `${g.procs.length} processes`))}
            </>
          )}
        </div>
        <div className="px-4 py-2 border-t border-line text-[11.5px] text-faint shrink-0">
          Refreshes every 2 s. Stop ends the whole process tree; Windows processes are never killed.
        </div>
      </div>
    </div>
  );
}
