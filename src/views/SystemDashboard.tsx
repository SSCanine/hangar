// The machine overview at the top of the System page. Numbers come from the data the page already polls.
import clsx from "clsx";
import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import type { Group, ProcSnapshot } from "../lib/procmatch";
import { useStore } from "../lib/store";
import { machine } from "../lib/sysHistory";
import type { GpuStats, Overview, SysStats } from "../lib/types";
import { Spark, clamp, fmtRate, fmtSize, gb, toneColor, type Pt } from "./SystemView";

/** How far back the small charts reach. */
export const DASH_MS = 5 * 60 * 1000;

const NA = "--";
const pct = (v: number | null | undefined) => (v === null || v === undefined ? NA : String(Math.round(v)));

export function usePageVisible() {
  const [v, setV] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setV(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

/** One tick per thread/core, colored by load. */
export function MiniCores({ cores }: { cores: number[] }) {
  if (!cores.length) return <div className="h-6 text-[11px] text-faint">per-core {NA}</div>;
  return (
    <div className="flex items-end gap-[2px] h-6" aria-label="Per-core load">
      {cores.map((v, i) => (
        <div key={i} className="relative flex-1 min-w-[2px] h-full rounded-[2px] bg-line/60 overflow-hidden" title={`Core ${i}: ${Math.round(v)}%`}>
          <div className="absolute bottom-0 inset-x-0 transition-[height] duration-700" style={{ height: `${clamp(v)}%`, background: toneColor(v / 100, { warn: 0.6, bad: 0.85 }) }} />
        </div>
      ))}
    </div>
  );
}

export function Bar({ frac, warn = 0.8, bad = 0.9 }: { frac: number | null; warn?: number; bad?: number }) {
  return (
    <div className="h-1.5 rounded-full bg-line/50 overflow-hidden">
      {frac !== null && <div className="h-full rounded-full" style={{ width: `${clamp(frac * 100)}%`, background: toneColor(frac, { warn, bad }) }} />}
    </div>
  );
}

export function Tile({ label, value, unit, sub, children }: { label: string; value: string; unit?: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line/70 bg-night/30 p-3 min-w-0">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[12px] text-dim flex-1 truncate">{label}</span>
        <b className={clsx("text-[20px] leading-none font-semibold num", value === NA && "text-faint")}>{value}</b>
        {unit && value !== NA && <span className="text-[11.5px] text-dim">{unit}</span>}
      </div>
      {sub && <div className="text-[11.5px] text-faint num mt-1 truncate">{sub}</div>}
      {children && <div className="mt-2 space-y-1.5">{children}</div>}
    </div>
  );
}

interface ProcLine {
  key: string;
  name: string;
  cpu: number | null;
  mem: string;
}

function Procs({ rows, empty }: { rows: ProcLine[]; empty: string }) {
  if (!rows.length) return <p className="text-[12px] text-faint">{empty}</p>;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[1fr_auto_auto] gap-3 items-baseline text-[12px]">
          <span className="truncate" title={r.name}>{r.name}</span>
          <span className="num text-dim w-12 text-right">{r.cpu === null ? NA : `${r.cpu >= 10 ? Math.round(r.cpu) : r.cpu.toFixed(1)}%`}</span>
          <span className="num text-faint w-16 text-right">{r.mem}</span>
        </div>
      ))}
    </div>
  );
}

export function Column({ icon, title, sub, state, busy, children, className }: { icon: React.ReactNode; title: string; sub?: React.ReactNode; state?: { text: string; tone: "ok" | "warn" | "bad" }; busy: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("@container rounded-xl border border-line bg-panel/50 p-4 min-w-0", className)}>
      <header className="flex items-center gap-2">
        <span className="text-faint">{icon}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <span className="text-[12px] text-faint num truncate flex-1 min-w-0">{sub}</span>
        {state && (
          <span
            className={clsx(
              "text-[11px] px-2 py-0.5 rounded-full border",
              state.tone === "ok" && "border-line text-dim",
              state.tone === "warn" && "border-warn/50 text-warn",
              state.tone === "bad" && "border-bad/50 text-bad",
            )}
          >
            {state.text}
          </span>
        )}
      </header>
      <p className="text-[12.5px] mt-1.5 mb-3 truncate">
        <span className="text-faint">Busy with </span>
        {busy}
      </p>
      {children}
    </section>
  );
}

export function SparkRow({ points, now, hoverT, onHover }: { points: Pt[]; now: number; hoverT: number | null; onHover: (t: number | null) => void }) {
  return <Spark points={points} max={100} now={now} hoverT={hoverT} onHover={onHover} height={40} format={(v) => `${Math.round(v)}%`} windowMs={DASH_MS} />;
}

const since = (now: number) => (p: { t: number }) => p.t >= now - DASH_MS;

export function MachineColumns({ ov, sys, gpu, groups, snap }: { ov: Overview | null; sys: SysStats | null; gpu: GpuStats | null; groups: Group[]; snap: ProcSnapshot | null; visible?: boolean }) {
  const registry = useStore((s) => s.registry);
  const status = useStore((s) => s.status);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const now = Date.now();

  // ---------- PC ----------
  const pcHist = machine.filter(since(now));
  const rx = ov ? ov.nets.reduce((n, x) => n + x.rx_bps, 0) : null;
  const tx = ov ? ov.nets.reduce((n, x) => n + x.tx_bps, 0) : null;
  const dFree = ov ? ov.disks.reduce((n, d) => n + d.free, 0) : 0;
  const dTotal = ov ? ov.disks.reduce((n, d) => n + d.total, 0) : 0;
  const gpuTools = registry ? registry.tools.filter((t) => t.gpu && status[t.id]?.running).map((t) => t.name) : [];
  const vramHolders = groups.filter((g) => g.vram >= 512).sort((a, b) => b.vram - a.vram).map((g) => `${g.owner.name} (${gb(g.vram)} GB)`);
  const pcBusy = [...new Set([...gpuTools, ...vramHolders])].slice(0, 4);
  const pcProcs: ProcLine[] = [...groups]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 6)
    .map((g) => ({ key: g.owner.key, name: g.owner.name, cpu: g.cpu, mem: `${gb(g.mem)} GB` }));

  return (
    <div className="grid grid-cols-1 gap-2.5 mb-6">
      <Column
        icon={<Monitor size={16} />}
        title="PC"
        sub={ov ? `${ov.host.name} · ${ov.host.threads} threads` : ""}
        state={{ text: "this machine", tone: "ok" }}
        busy={pcBusy.length ? pcBusy.join(", ") : <span className="text-dim">nothing heavy on the GPU</span>}
      >
        <div className="grid grid-cols-1 @[400px]:grid-cols-2 gap-2">
          <Tile label="CPU" value={pct(sys?.cpu)} unit="%" sub={ov ? `${(ov.cpu_mhz / 1000).toFixed(2)} GHz avg` : NA}>
            <SparkRow points={pcHist.map((p) => ({ t: p.t, v: p.cpu }))} now={now} hoverT={hoverT} onHover={setHoverT} />
            <MiniCores cores={ov?.cores ?? []} />
          </Tile>
          <Tile label="GPU" value={pct(gpu?.util)} unit="%" sub={gpu ? `VRAM ${gb(gpu.mem_used)} / ${gb(gpu.mem_total, 0)} GB · ${gpu.temp} °C` : NA}>
            <SparkRow points={pcHist.map((p) => ({ t: p.t, v: p.gpu }))} now={now} hoverT={hoverT} onHover={setHoverT} />
            <Bar frac={gpu && gpu.mem_total ? gpu.mem_used / gpu.mem_total : null} warn={0.85} bad={0.95} />
          </Tile>
          <Tile label="RAM" value={sys ? gb(sys.mem_used) : NA} unit={sys ? `/ ${gb(sys.mem_total, 0)} GB` : undefined} sub={sys && sys.commit_total ? `commit ${gb(sys.commit_used, 0)} of ${gb(sys.commit_total, 0)} GB` : NA}>
            <Bar frac={sys && sys.mem_total ? sys.mem_used / sys.mem_total : null} warn={0.75} />
          </Tile>
          <Tile label="Network" value={rx === null ? NA : fmtRate(rx)} sub={tx === null ? NA : `down · up ${fmtRate(tx)}`} />
          <Tile label="Disks" value={dTotal ? fmtSize(dFree) : NA} unit="free" sub={dTotal ? `of ${fmtSize(dTotal)} across ${ov!.disks.length} drives` : NA}>
            <Bar frac={dTotal ? 1 - dFree / dTotal : null} />
          </Tile>
          <Tile label="Top processes" value="">
            <Procs rows={pcProcs} empty={snap ? "Nothing busy." : "Reading..."} />
          </Tile>
        </div>
      </Column>

    </div>
  );
}
