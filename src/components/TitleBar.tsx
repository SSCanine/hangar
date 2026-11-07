import { getCurrentWindow } from "@tauri-apps/api/window";
import { Activity, Bell, Bot, Minus, PanelLeftClose, PanelLeftOpen, Search, Square, X } from "lucide-react";
import clsx from "clsx";
import { inTauri } from "../lib/api";
import { useStore } from "../lib/store";
import { ClaudeMeter } from "./ClaudeMeter";

const gb = (mb: number, digits = 1) => (mb / 1024).toFixed(digits);

/** One title-bar meter: label, fill bar, value. The bar turns amber then red as it fills. */
function Meter({ label, pct, value, title, valueWidth, onClick, active }: { label: string; pct: number; value: React.ReactNode; title: string; valueWidth: string; onClick: () => void; active: boolean }) {
  const p = Math.max(0, Math.min(100, pct));
  const tone = p > 85 ? "var(--color-bad)" : p > 60 ? "var(--color-warn)" : "var(--color-live)";
  return (
    <button
      onClick={onClick}
      className={clsx("flex items-center gap-2 h-7 px-2 -mx-2 rounded-lg text-[12px] text-dim num transition-colors", active ? "bg-raise" : "hover:bg-raise/60")}
      title={`${title}
Click to see what's using it`}
    >
      <span className="text-faint">{label}</span>
      <div className="h-1.5 w-12 rounded-full bg-raise overflow-hidden hidden min-[1536px]:block">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${p}%`, background: tone }} />
      </div>
      <span className="text-right" style={{ width: valueWidth }}>
        {value}
      </span>
    </button>
  );
}

function SystemMeters() {
  const gpu = useStore((s) => s.gpu);
  const sys = useStore((s) => s.sys);
  const panel = useStore((s) => s.procPanel);
  const set = useStore((s) => s.set);
  const toggle = (m: "cpu" | "ram" | "gpu") => () => set({ procPanel: panel === m ? null : m });
  return (
    <div className="flex items-center gap-5">
      {sys && (
        <Meter
          label="CPU"
          onClick={toggle("cpu")}
          active={panel === "cpu"}
          pct={sys.cpu}
          value={`${Math.round(sys.cpu)}%`}
          valueWidth="30px"
          title={`CPU load ${sys.cpu.toFixed(1)}% across ${sys.threads} threads`}
        />
      )}
      {sys && sys.mem_total > 0 && (
        <Meter
          label="RAM"
          onClick={toggle("ram")}
          active={panel === "ram"}
          pct={(sys.mem_used / sys.mem_total) * 100}
          value={`${gb(sys.mem_used)}/${gb(sys.mem_total, 0)} GB`}
          valueWidth="74px"
          title={`RAM ${gb(sys.mem_used)} of ${gb(sys.mem_total)} GB in use\nCommit ${gb(sys.commit_used)} of ${gb(sys.commit_total)} GB (RAM + pagefile)`}
        />
      )}
      {gpu && (
        <Meter
          label="GPU"
          onClick={toggle("gpu")}
          active={panel === "gpu"}
          pct={(gpu.mem_used / gpu.mem_total) * 100}
          value={
            <>
              {gb(gpu.mem_used)}/{gb(gpu.mem_total, 0)} GB <span className="text-faint ml-1">{gpu.util}%</span>
            </>
          }
          valueWidth="104px"
          title={`${gpu.name}\nVRAM ${gpu.mem_used} / ${gpu.mem_total} MB\nLoad ${gpu.util}%  ${gpu.temp}°C  ${gpu.power.toFixed(0)} W`}
        />
      )}
    </div>
  );
}

function SystemButton() {
  const onPage = useStore((s) => s.view.type === "system");
  const go = useStore((s) => s.go);
  return (
    <button
      onClick={() => go({ type: "system" })}
      title="System: every meter, graph and drive in one place"
      className={clsx("flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[13px] border transition-colors", onPage ? "bg-raise text-moon border-faint/60" : "border-line text-dim hover:text-moon")}
    >
      <Activity size={15} /> System
    </button>
  );
}

function InboxBell() {
  const unread = useStore((s) => s.inbox.filter((m) => m.at > s.inboxSeenAt).length);
  const waiting = useStore((s) => s.inbox.some((m) => m.at > s.inboxSeenAt && m.kind === "waiting"));
  const open = useStore((s) => s.inboxOpen);
  const set = useStore((s) => s.set);
  return (
    <button
      onClick={() => set({ inboxOpen: !open })}
      title={unread ? `${unread} new message${unread === 1 ? "" : "s"} from Claude` : "Messages from Claude"}
      className={clsx("relative w-8 h-7 grid place-items-center rounded-lg transition-colors", open ? "bg-raise text-moon" : "text-dim hover:text-moon hover:bg-raise/60")}
    >
      <Bell size={16} className={clsx(unread > 0 && "text-gold")} />
      {unread > 0 && (
        <span className={clsx("absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full text-[10.5px] font-semibold grid place-items-center num", waiting ? "bg-warn text-night" : "bg-gold text-night")}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

export function TitleBar() {
  const set = useStore((s) => s.set);
  const dockOpen = useStore((s) => s.dockOpen);
  const railOpen = useStore((s) => s.railOpen);
  const win = inTauri ? getCurrentWindow() : null;

  return (
    <header
      data-tauri-drag-region
      className="h-11 flex items-center gap-4 pl-4 border-b border-line bg-panel/60 shrink-0"
    >
      <div data-tauri-drag-region className="flex items-center gap-2.5 w-[216px] shrink-0">
        <img src="/hangar-mark.png" alt="" className="w-5 h-5 pointer-events-none" />
        <span data-tauri-drag-region className="font-semibold tracking-tight text-[15px]">Hangar</span>
        <button
          onClick={() => set({ railOpen: !railOpen })}
          title={railOpen ? "Hide the side panel (Ctrl B)" : "Show the side panel (Ctrl B)"}
          className="w-7 h-7 grid place-items-center rounded-lg text-dim hover:text-moon hover:bg-raise transition-colors"
        >
          {railOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>

      <button
        onClick={() => set({ paletteOpen: true })}
        className="flex items-center gap-2 h-7 w-[min(400px,28vw)] min-w-0 px-3 rounded-lg bg-night/70 border border-line text-faint hover:text-dim hover:border-faint/60 transition-colors"
      >
        <Search size={14} />
        <span className="flex-1 text-left text-[13px] truncate whitespace-nowrap">Find a tool, project or action</span>
        <kbd className="text-[11px] text-faint">Ctrl K</kbd>
      </button>

      <div data-tauri-drag-region className="flex-1 h-full" />
      <ClaudeMeter />
      <SystemMeters />
      <SystemButton />

      <InboxBell />

      <button
        onClick={() => set({ dockOpen: !dockOpen })}
        title="Assistant (Ctrl J)"
        className={clsx(
          "flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[13px] border transition-colors",
          dockOpen ? "bg-gold text-night border-gold" : "border-line text-dim hover:text-moon",
        )}
      >
        <Bot size={15} /> Assistant
      </button>

      <div className="flex h-full shrink-0">
        <button aria-label="Minimize" onClick={() => win?.minimize()} className="w-11 grid place-items-center text-dim hover:bg-raise">
          <Minus size={15} />
        </button>
        <button aria-label="Maximize" onClick={() => win?.toggleMaximize()} className="w-11 grid place-items-center text-dim hover:bg-raise">
          <Square size={12} />
        </button>
        <button aria-label="Close" onClick={() => win?.close()} className="w-11 grid place-items-center text-dim hover:bg-[#c42b3c] hover:text-white">
          <X size={16} />
        </button>
      </div>
    </header>
  );
}
