import clsx from "clsx";
import { Cpu, Gauge, HardDrive, ListTree, MemoryStick, MonitorCog, Network, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errText } from "../lib/api";
import { openTool } from "../lib/actions";
import { groupProcesses, mergeOthers, type Group, type ProcSnapshot, type ProjectRef } from "../lib/procmatch";
import { freeGpu } from "../lib/roles";
import { useStore } from "../lib/store";
import { WINDOW_MS, io, machine, pushIo } from "../lib/sysHistory";
import type { Overview } from "../lib/types";
import { MachineColumns, usePageVisible } from "./SystemDashboard";

// One hue for every chart: each chart is a single series, so color carries no identity.
export const LINE = "#3987e5";

export const gb = (mb: number, digits = 1) => (mb / 1024).toFixed(digits);
export const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function fmtSize(bytes: number) {
  const g = bytes / 1e9;
  return g >= 1000 ? `${(g / 1000).toFixed(g >= 10000 ? 1 : 2)} TB` : `${g >= 100 ? Math.round(g) : g.toFixed(1)} GB`;
}

export function fmtRate(bps: number) {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} MB/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Amber past `warn`, red past `bad` (fractions of full). Omit both for meters where high is good. */
interface Tone {
  warn?: number;
  bad?: number;
}

export function toneColor(frac: number, t: Tone) {
  if (t.bad !== undefined && frac > t.bad) return "var(--color-bad)";
  if (t.warn !== undefined && frac > t.warn) return "var(--color-warn)";
  return "var(--color-live)";
}

export function Card({ title, icon, right, children, className }: { title: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-panel/50 p-4 min-w-0", className)}>
      <header className="flex items-center gap-2 mb-3">
        {icon && <span className="text-faint">{icon}</span>}
        <h2 className="text-[13.5px] font-medium flex-1">{title}</h2>
        {right && <div className="text-[12px] text-faint num">{right}</div>}
      </header>
      {children}
    </section>
  );
}

const SEGS = 24;

/** Big number on the left, a segment ladder on the right. */
function LadderMeter({ label, value, unit, sub, frac, tone, onClick, title }: { label: string; value: string; unit: string; sub: string; frac: number | null; tone: Tone; onClick?: () => void; title?: string }) {
  const lit = frac === null ? 0 : Math.round(clamp(frac, 0, 1) * SEGS);
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      title={title ?? (onClick ? "Click to see what's using it" : undefined)}
      role="meter"
      aria-label={label}
      aria-valuenow={frac === null ? undefined : Math.round(frac * 100)}
      className={clsx("flex gap-3 h-[132px] rounded-xl border border-line bg-panel/50 p-3.5 text-left min-w-0", onClick && "hover:border-faint/60 transition-colors")}
    >
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-baseline gap-1">
          <b className={clsx("text-[34px] leading-none font-semibold num tracking-tight", frac === null && "text-faint")}>{value}</b>
          <span className="text-[13px] text-dim">{unit}</span>
        </div>
        <span className="mt-auto text-[12px] text-dim truncate num">{sub}</span>
        <span className="text-[13px] font-medium truncate">{label}</span>
      </div>
      <div className="ladder" aria-hidden>
        {Array.from({ length: SEGS }, (_, i) => {
          const f = (i + 1) / SEGS;
          const on = i < lit;
          const cls = !on ? "" : tone.bad !== undefined && f > tone.bad ? "on b" : tone.warn !== undefined && f > tone.warn ? "on w" : "on";
          return <i key={i} className={cls} />;
        })}
      </div>
    </Tag>
  );
}

export interface Pt {
  t: number;
  v: number | null;
}

/**
 * A single-series area chart over the last WINDOW_MS. Hover is shared across
 * every chart on the page, so one crosshair reads all of them at the same moment.
 */
export function Spark({ points, max, now, hoverT, onHover, height = 72, format, windowMs = WINDOW_MS }: { points: Pt[]; max: number; now: number; hoverT: number | null; onHover: (t: number | null) => void; height?: number; format: (v: number) => string; windowMs?: number }) {
  const x = (t: number) => 1000 * (1 - (now - t) / windowMs);
  const y = (v: number) => 100 - (clamp(v, 0, max) / max) * 100;
  // Break the line where a sample is missing.
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of points) {
    if (p.v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) runs.push(cur);
  const line = runs.map((r) => r.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join("")).join("");
  const area = runs.map((r) => `M${x(r[0].t).toFixed(1)},100${r.map((p) => `L${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join("")}L${x(r[r.length - 1].t).toFixed(1)},100Z`).join("");

  let hit: Pt | null = null;
  if (hoverT !== null) {
    for (const p of points) if (p.v !== null && (!hit || Math.abs(p.t - hoverT) < Math.abs(hit.t - hoverT))) hit = p;
    if (hit && Math.abs(hit.t - hoverT) > 15000) hit = null;
  }

  return (
    <div
      className="relative cursor-crosshair"
      style={{ height }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onHover(now - (1 - (e.clientX - r.left) / r.width) * windowMs);
      }}
      onMouseLeave={() => onHover(null)}
    >
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible">
        {[0, 50, 100].map((g) => (
          <line key={g} x1="0" x2="1000" y1={g} y2={g} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity={g === 100 ? 1 : 0.5} />
        ))}
        <path d={area} fill={LINE} opacity="0.16" />
        <path d={line} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {hit && (
        <>
          <div className="absolute top-0 bottom-0 w-px bg-dim/60 pointer-events-none" style={{ left: `${x(hit.t) / 10}%` }} />
          <div
            className="absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full pointer-events-none"
            style={{ left: `${x(hit.t) / 10}%`, top: `${y(hit.v!)}%`, background: LINE, boxShadow: "0 0 0 2px var(--color-panel)" }}
          />
          <div
            className={clsx("absolute -top-1 -translate-y-full px-2 py-1 rounded-md bg-raise border border-line text-[11.5px] num whitespace-nowrap pointer-events-none", x(hit.t) > 700 ? "-translate-x-full" : "")}
            style={{ left: `${x(hit.t) / 10}%` }}
          >
            <b className="font-semibold">{format(hit.v!)}</b> <span className="text-faint">{clock(hit.t)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function History({ title, points, max, now, hoverT, onHover, format }: { title: string; points: Pt[]; max: number; now: number; hoverT: number | null; onHover: (t: number | null) => void; format: (v: number) => string }) {
  const last = [...points].reverse().find((p) => p.v !== null);
  return (
    <div className="rounded-xl border border-line bg-panel/50 p-3.5 min-w-0">
      <div className="flex items-baseline gap-2 mb-2.5">
        <span className="text-[13px] font-medium flex-1">{title}</span>
        <span className="text-[13px] num">{last ? format(last.v!) : "-"}</span>
      </div>
      <Spark points={points} max={max} now={now} hoverT={hoverT} onHover={onHover} format={format} />
      <div className="flex justify-between mt-1.5 text-[11px] text-faint">
        <span>10 min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** Per-thread load. SMT siblings sit next to each other (0-1 = core 0), so threads pair up under one core label. */
function CoreGrid({ cores }: { cores: number[] }) {
  const pairs: number[][] = [];
  for (let i = 0; i < cores.length; i += 2) pairs.push(cores.slice(i, i + 2));
  return (
    <div className="grid gap-x-1.5 gap-y-1" style={{ gridTemplateColumns: `repeat(${Math.max(pairs.length, 1)}, minmax(0, 1fr))` }}>
      {pairs.map((pair, ci) => (
        <div key={ci} className="flex flex-col items-center gap-1">
          <div className="flex gap-[3px] h-[84px] w-full justify-center">
            {pair.map((v, ti) => (
              <div key={ti} className="relative flex-1 max-w-[10px] rounded-[3px] bg-line/60 overflow-hidden" title={`Thread ${ci * 2 + ti}: ${Math.round(v)}%`}>
                <div className="absolute bottom-0 inset-x-0 rounded-[3px] transition-[height] duration-700" style={{ height: `${clamp(v)}%`, background: toneColor(v / 100, { warn: 0.6, bad: 0.85 }) }} />
              </div>
            ))}
          </div>
          <span className="text-[10.5px] text-faint num">{ci}</span>
        </div>
      ))}
    </div>
  );
}

export function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-line/50 last:border-0 text-[12.5px]">
      <span className="text-dim truncate min-w-0" title={k}>{k}</span>
      <span className="num text-right whitespace-nowrap">{v}</span>
    </div>
  );
}

/** Thin magnitude bars, one hue, scaled to the whole machine. */
export function BarList({ rows, empty }: { rows: { key: string; name: string; color?: string; value: string; frac: number }[]; empty: string }) {
  if (!rows.length) return <p className="text-[12.5px] text-faint">{empty}</p>;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="min-w-0">
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: r.color ?? "var(--color-line)" }} />
            <span className="flex-1 truncate">{r.name}</span>
            <span className="num text-dim">{r.value}</span>
          </div>
          <div className="h-1 mt-1 rounded-full bg-line/50 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${clamp(r.frac * 100, 1.5)}%`, background: LINE }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionButton({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title} className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[13px] text-dim hover:text-moon hover:border-faint/60 transition-colors">
      {children}
    </button>
  );
}

export function SystemView() {
  const sys = useStore((s) => s.sys);
  const gpu = useStore((s) => s.gpu);
  const registry = useStore((s) => s.registry);
  const status = useStore((s) => s.status);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [snap, setSnap] = useState<ProcSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const tick = () =>
      api
        .overview()
        .then((o) => {
          if (!alive) return;
          setOv(o);
          setErr(null);
          pushIo(o);
        })
        .catch((e) => alive && setErr(errText(e)));
    const procs = () => api.procs().then((s) => alive && setSnap(s)).catch(() => {});
    tick();
    procs();
    api
      .projects()
      .then((raw) => {
        const groups = (raw as { groups?: { items: { name: string; path?: string }[] }[] }).groups ?? [];
        if (alive) setProjects(groups.flatMap((g) => g.items.filter((i) => i.path).map((i) => ({ name: i.name, path: i.path! }))));
      })
      .catch(() => {});
    const t1 = setInterval(tick, 3000);
    const t2 = setInterval(procs, 4000);
    return () => {
      alive = false;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [visible]);

  const groups = useMemo<Group[]>(() => {
    if (!snap || !registry) return [];
    const all = groupProcesses(snap, registry.tools, registry.themes, projects);
    return [...all.filter((g) => g.owner.kind !== "other"), ...mergeOthers(all)];
  }, [snap, registry, projects]);

  const now = Date.now();
  const g = ov?.gpu;
  const memTotal = sys?.mem_total ?? 0;
  const vramTotal = gpu?.mem_total ?? g?.mem_total ?? 0;

  const top = (key: "cpu" | "mem" | "vram", value: (x: Group) => string, frac: (x: Group) => number) =>
    groups
      .filter((x) => x[key] > (key === "cpu" ? 0.05 : 0))
      .sort((a, b) => b[key] - a[key])
      .slice(0, 6)
      .map((x) => ({ key: x.owner.key, name: x.owner.name, color: x.owner.color, value: value(x), frac: frac(x) }));

  const running = registry ? registry.tools.filter((t) => status[t.id]?.running) : [];
  const themeColor = (id: string) => registry?.themes.find((th) => th.id === id)?.color;

  const disks = ov?.disks ?? [];
  const diskTotal = disks.reduce((n, d) => n + d.total, 0);
  const diskFree = disks.reduce((n, d) => n + d.free, 0);
  const ioMax = (a: "rx" | "tx" | "read" | "write", floor: number) => Math.max(floor, ...io.map((p) => p[a])) * 1.15;

  const busiest = ov?.cores.length ? ov.cores.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0) : -1;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto px-8 pt-8 pb-16">
        <header className="flex flex-wrap items-end gap-4 mb-6">
          <div className="flex-1 min-w-[280px]">
            <h1 className="text-[34px] leading-none font-semibold tracking-[-0.025em]" style={{ fontVariationSettings: '"wdth" 88' }}>
              System
            </h1>
            <p className="text-dim mt-2.5 text-[13px] num selectable">
              {ov ? (
                <>
                  {ov.host.name} · {ov.host.os} · up {fmtUptime(ov.host.uptime_s)} · {ov.host.cpu.replace(/\s+\d+-Core Processor$/i, "")}, {ov.host.cores} cores / {ov.host.threads} threads
                </>
              ) : err ? (
                <span className="text-bad">{err}</span>
              ) : (
                "Reading the machine…"
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton onClick={() => set({ procPanel: "cpu" })} title="What's running, grouped by tool and project, with Stop">
              <ListTree size={15} /> Processes
            </ActionButton>
            <ActionButton onClick={() => void freeGpu()} title="Unload every local Ollama model from VRAM">
              <Zap size={15} /> Free GPU
            </ActionButton>
            <ActionButton onClick={() => api.openSystemApp("taskmgr").catch((e) => toast(errText(e), "bad"))}>
              <MonitorCog size={15} /> Task Manager
            </ActionButton>
            <ActionButton onClick={() => api.openSystemApp("resmon").catch((e) => toast(errText(e), "bad"))}>
              <Gauge size={15} /> Resource Monitor
            </ActionButton>
          </div>
        </header>

        <MachineColumns ov={ov} sys={sys} gpu={gpu} groups={groups} snap={snap} visible={visible} />

        {/* Now: ladder meters */}
        <div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-8 gap-2.5 mb-6">
          <LadderMeter
            label="CPU"
            value={sys ? String(Math.round(sys.cpu)) : "-"}
            unit="%"
            sub={ov ? `${(ov.cpu_mhz / 1000).toFixed(2)} GHz avg` : ""}
            frac={sys ? sys.cpu / 100 : null}
            tone={{ warn: 0.6, bad: 0.85 }}
            onClick={() => set({ procPanel: "cpu" })}
          />
          <LadderMeter
            label="RAM"
            value={sys ? gb(sys.mem_used) : "-"}
            unit="GB"
            sub={sys ? `of ${gb(sys.mem_total, 0)} GB` : ""}
            frac={sys && memTotal ? sys.mem_used / memTotal : null}
            tone={{ warn: 0.75, bad: 0.9 }}
            onClick={() => set({ procPanel: "ram" })}
          />
          <LadderMeter
            label="Commit"
            value={sys && sys.commit_total ? String(Math.round((sys.commit_used / sys.commit_total) * 100)) : "-"}
            unit="%"
            sub={sys ? `${gb(sys.commit_used, 0)} of ${gb(sys.commit_total, 0)} GB` : ""}
            frac={sys && sys.commit_total ? sys.commit_used / sys.commit_total : null}
            tone={{ warn: 0.85, bad: 0.92 }}
            title="Commit charge: memory programs have reserved, RAM plus pagefile. Near 100% new allocations fail."
          />
          <LadderMeter
            label="GPU load"
            value={gpu ? String(gpu.util) : "-"}
            unit="%"
            sub={g ? `${g.pstate} · ${g.clock_gr ?? "-"} MHz` : ""}
            frac={gpu ? gpu.util / 100 : null}
            tone={{}}
            onClick={() => set({ procPanel: "gpu" })}
          />
          <LadderMeter
            label="VRAM"
            value={gpu ? gb(gpu.mem_used) : "-"}
            unit="GB"
            sub={gpu ? `of ${gb(gpu.mem_total, 0)} GB` : ""}
            frac={gpu && gpu.mem_total ? gpu.mem_used / gpu.mem_total : null}
            tone={{ warn: 0.85, bad: 0.95 }}
            onClick={() => set({ procPanel: "gpu" })}
          />
          <LadderMeter label="GPU temp" value={gpu ? String(gpu.temp) : "-"} unit="°C" sub="of 90 °C" frac={gpu ? gpu.temp / 90 : null} tone={{ warn: 0.83, bad: 0.94 }} />
          <LadderMeter
            label="GPU power"
            value={gpu ? String(Math.round(gpu.power)) : "-"}
            unit="W"
            sub={g?.power_limit ? `of ${Math.round(g.power_limit)} W` : ""}
            frac={gpu && g?.power_limit ? gpu.power / g.power_limit : null}
            tone={{}}
          />
          <LadderMeter label="GPU fan" value={g?.fan != null ? String(Math.round(g.fan)) : "-"} unit="%" sub={g?.fan === 0 ? "fans stopped" : ""} frac={g?.fan != null ? g.fan / 100 : null} tone={{}} />
        </div>

        {/* Last 10 minutes: small multiples, one series each */}
        <h2 className="text-[13px] text-faint mb-2 px-1">Last 10 minutes</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5 mb-6">
          <History title="CPU" points={machine.map((p) => ({ t: p.t, v: p.cpu }))} max={100} now={now} hoverT={hoverT} onHover={setHoverT} format={(v) => `${Math.round(v)}%`} />
          <History
            title="RAM"
            points={machine.map((p) => ({ t: p.t, v: p.ram }))}
            max={100}
            now={now}
            hoverT={hoverT}
            onHover={setHoverT}
            format={(v) => (memTotal ? `${gb((v / 100) * memTotal)} GB` : `${Math.round(v)}%`)}
          />
          <History title="GPU load" points={machine.map((p) => ({ t: p.t, v: p.gpu }))} max={100} now={now} hoverT={hoverT} onHover={setHoverT} format={(v) => `${Math.round(v)}%`} />
          <History
            title="VRAM"
            points={machine.map((p) => ({ t: p.t, v: p.vram }))}
            max={100}
            now={now}
            hoverT={hoverT}
            onHover={setHoverT}
            format={(v) => (vramTotal ? `${gb((v / 100) * vramTotal)} GB` : `${Math.round(v)}%`)}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[3fr_2fr] gap-2.5 mb-2.5">
          <Card
            title="CPU threads"
            icon={<Cpu size={15} />}
            right={ov && busiest >= 0 ? `busiest: thread ${busiest} at ${Math.round(ov.cores[busiest])}% · ${(ov.cpu_mhz / 1000).toFixed(2)} GHz avg` : null}
          >
            {ov ? <CoreGrid cores={ov.cores} /> : <p className="text-[12.5px] text-faint">Reading…</p>}
            <p className="text-[11.5px] text-faint mt-2">Each column is one physical core with its two threads.</p>
          </Card>

          <Card title={g?.name ?? gpu?.name ?? "GPU"} icon={<Gauge size={15} />} right={g ? `driver ${g.driver}` : null} className="@container">
            {g ? (
              <div className="grid grid-cols-1 @[460px]:grid-cols-2 gap-x-6">
                <div>
                  <Stat k="GPU clock" v={`${g.clock_gr ?? "-"} / ${g.clock_gr_max ?? "-"} MHz`} />
                  <Stat k="Memory clock" v={`${g.clock_mem ?? "-"} MHz`} />
                  <Stat k="Memory bus" v={g.mem_util != null ? `${g.mem_util}%` : "-"} />
                  <Stat k="P-state" v={g.pstate || "-"} />
                </div>
                <div>
                  <Stat k="Power" v={`${g.power != null ? Math.round(g.power) : "-"} / ${g.power_limit != null ? Math.round(g.power_limit) : "-"} W`} />
                  <Stat k="Encode / decode" v={`${g.encoder ?? "-"}% / ${g.decoder ?? "-"}%`} />
                  <Stat k="PCIe link" v={g.pcie_gen != null ? `Gen ${g.pcie_gen} x${g.pcie_width}` : "-"} />
                  <Stat k="Fan" v={g.fan != null ? `${g.fan}%` : "-"} />
                </div>
              </div>
            ) : (
              <p className="text-[12.5px] text-faint">{ov ? "nvidia-smi gave no reading." : "Reading…"}</p>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 mb-2.5">
          <Card title="Using the CPU" icon={<Cpu size={15} />} right={<button className="hover:text-moon" onClick={() => set({ procPanel: "cpu" })}>Manage</button>}>
            <BarList rows={top("cpu", (x) => `${x.cpu >= 10 ? Math.round(x.cpu) : x.cpu.toFixed(1)}%`, (x) => x.cpu / 100)} empty={snap ? "Nothing busy." : "Reading…"} />
          </Card>
          <Card title="Using RAM" icon={<MemoryStick size={15} />} right={<button className="hover:text-moon" onClick={() => set({ procPanel: "ram" })}>Manage</button>}>
            <BarList rows={top("mem", (x) => `${gb(x.mem)} GB`, (x) => (memTotal ? x.mem / memTotal : 0))} empty={snap ? "Nothing yet." : "Reading…"} />
          </Card>
          <Card title="Using VRAM" icon={<Gauge size={15} />} right={<button className="hover:text-moon" onClick={() => set({ procPanel: "gpu" })}>Manage</button>}>
            <BarList rows={top("vram", (x) => `${gb(x.vram)} GB`, (x) => (vramTotal ? x.vram / vramTotal : 0))} empty={snap ? "Nothing is holding VRAM." : "Reading…"} />
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 mb-2.5">
          <Card title="Drives" icon={<HardDrive size={15} />} right={disks.length ? `${fmtSize(diskFree)} free of ${fmtSize(diskTotal)}` : null}>
            <div className="grid grid-cols-2 gap-2.5 mb-3">
              <div>
                <div className="flex justify-between text-[11.5px] text-faint mb-1">
                  <span>Read, all drives</span>
                  <span className="num text-dim">{io.length ? fmtRate(io[io.length - 1].read) : "-"}</span>
                </div>
                <Spark points={io.map((p) => ({ t: p.t, v: p.read }))} max={ioMax("read", 5e6)} now={now} hoverT={hoverT} onHover={setHoverT} height={44} format={fmtRate} />
              </div>
              <div>
                <div className="flex justify-between text-[11.5px] text-faint mb-1">
                  <span>Write, all drives</span>
                  <span className="num text-dim">{io.length ? fmtRate(io[io.length - 1].write) : "-"}</span>
                </div>
                <Spark points={io.map((p) => ({ t: p.t, v: p.write }))} max={ioMax("write", 5e6)} now={now} hoverT={hoverT} onHover={setHoverT} height={44} format={fmtRate} />
              </div>
            </div>
            <div className="space-y-2.5">
              {disks.map((d) => {
                const used = d.total ? 1 - d.free / d.total : 0;
                return (
                  <div key={d.mount} className="min-w-0">
                    <div className="flex items-baseline gap-2 text-[12.5px]">
                      <button className="font-semibold num w-8 text-left hover:text-gold" title={`Open ${d.mount}`} onClick={() => api.openFolder(d.mount).catch((e) => toast(errText(e), "bad"))}>
                        {d.mount.replace(/\\$/, "")}
                      </button>
                      <span className="flex-1 truncate text-dim">
                        {d.label || "Local disk"}
                        {d.kind && <span className="ml-1.5 text-[10.5px] px-1.5 py-px rounded bg-raise text-faint">{d.kind}</span>}
                        {d.removable && <span className="ml-1.5 text-[10.5px] text-faint">removable</span>}
                      </span>
                      <span className="num text-dim">{fmtSize(d.free)} free of {fmtSize(d.total)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex-1 h-1.5 rounded-full bg-line/50 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${clamp(used * 100)}%`, background: used > 0.9 ? "var(--color-bad)" : used > 0.8 ? "var(--color-warn)" : "var(--color-dim)" }} />
                      </div>
                      <span className="w-[170px] text-right text-[11px] text-faint num truncate" title="Read · write right now">
                        {d.read_bps + d.write_bps > 1024 ? `R ${fmtRate(d.read_bps)} · W ${fmtRate(d.write_bps)}` : "idle"}
                      </span>
                    </div>
                  </div>
                );
              })}
              {!disks.length && <p className="text-[12.5px] text-faint">{ov ? "No drives reported." : "Reading…"}</p>}
            </div>
          </Card>

          <div className="flex flex-col gap-2.5 min-w-0">
            <Card title="Network" icon={<Network size={15} />}>
              <div className="grid grid-cols-2 gap-2.5 mb-3">
                <div>
                  <div className="flex justify-between text-[11.5px] text-faint mb-1">
                    <span>Download</span>
                    <span className="num text-dim">{io.length ? fmtRate(io[io.length - 1].rx) : "-"}</span>
                  </div>
                  <Spark points={io.map((p) => ({ t: p.t, v: p.rx }))} max={ioMax("rx", 1e6)} now={now} hoverT={hoverT} onHover={setHoverT} height={44} format={fmtRate} />
                </div>
                <div>
                  <div className="flex justify-between text-[11.5px] text-faint mb-1">
                    <span>Upload</span>
                    <span className="num text-dim">{io.length ? fmtRate(io[io.length - 1].tx) : "-"}</span>
                  </div>
                  <Spark points={io.map((p) => ({ t: p.t, v: p.tx }))} max={ioMax("tx", 1e6)} now={now} hoverT={hoverT} onHover={setHoverT} height={44} format={fmtRate} />
                </div>
              </div>
              {(ov?.nets ?? []).slice(0, 4).map((n) => (
                <Stat key={n.name} k={n.name} v={`↓ ${fmtRate(n.rx_bps)}  ↑ ${fmtRate(n.tx_bps)}`} />
              ))}
            </Card>

            <Card title="Hangar tools running" icon={<Zap size={15} />} right={registry ? `${running.length} of ${registry.tools.length}` : null}>
              <div className="flex flex-wrap gap-1.5">
                {running.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => openTool(t)}
                    title={t.description}
                    className="flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-lg bg-raise/60 hover:bg-raise text-[12.5px] transition-colors"
                  >
                    <span className="led on" style={{ background: themeColor(t.theme) }} />
                    {t.name}
                    {t.gpu && <span className="text-[10px] px-1 rounded bg-night text-gold">GPU</span>}
                  </button>
                ))}
                {registry && !running.length && <p className="text-[12.5px] text-faint">No tools are running.</p>}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
