import clsx from "clsx";
import { Copy, ExternalLink, FileText, FolderOpen, Pencil, Play, Power, Star, Zap } from "lucide-react";
import { openMenu } from "./ContextMenu";
import { copyText } from "../lib/clipboard";
import { useState } from "react";
import { api, errText } from "../lib/api";
import { openInBrowser, openTool, primaryVerb, requestStart, stopTool } from "../lib/actions";
import { hubOf, includedIn, toolMap } from "../lib/partof";
import { useStore } from "../lib/store";
import type { Tool } from "../lib/types";

function IconBtn({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        "w-7 h-7 grid place-items-center rounded-md text-faint transition-colors",
        danger ? "hover:text-bad hover:bg-bad/10" : "hover:text-moon hover:bg-line",
      )}
    >
      {children}
    </button>
  );
}

export function ToolRow({
  tool,
  showTheme,
  depth = 0,
  tag,
  children,
}: {
  tool: Tool;
  showTheme?: boolean;
  /** Nesting level: 1 = a tab inside an app, 2 = a helper part of that tab. */
  depth?: number;
  /** Small label after the name, e.g. "Settings tab". */
  tag?: string;
  children?: React.ReactNode;
}) {
  const st = useStore((s) => s.status[tool.id]);
  const busy = useStore((s) => !!s.starting[tool.id]);
  const pinned = useStore((s) => s.pinned.includes(tool.id));
  const theme = useStore((s) => s.registry?.themes.find((t) => t.id === tool.theme));
  const allTools = useStore((s) => s.registry?.tools);
  // Hub apps list the tools merged into them; a merged tool shown elsewhere (Home) names its hub.
  const includes = allTools ? includedIn(tool, allTools) : [];
  const hub = allTools ? hubOf(tool, toolMap(allTools)) : undefined;
  const label = tag ?? (hub ? `inside ${hub.name}` : undefined);
  const { togglePin, set, toast } = useStore.getState();
  const [log, setLog] = useState<string | null>(null);
  const running = !!st?.running;
  const verb = primaryVerb(tool, running);
  const serviceUp = tool.kind === "service" && running;
  const canStop = running && !!tool.port;
  const showLog = async () => setLog(log === null ? await api.log(tool.id).catch(errText) : null);

  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      !(serviceUp || busy) && { label: verb, icon: Play, onClick: () => (tool.kind === "service" ? requestStart(tool) : openTool(tool)) },
      tool.kind === "web" && tool.embed && { label: "Open in browser", icon: ExternalLink, onClick: () => openInBrowser(tool) },
      canStop && { label: tool.stoppable ? "Stop" : "Stop (asks first)", icon: Power, danger: true, onClick: () => stopTool(tool) },
      "-",
      { label: pinned ? "Unpin from Home" : "Pin to Home", icon: Star, onClick: () => togglePin(tool.id) },
      tool.folder && { label: "Open folder", icon: FolderOpen, onClick: () => void api.openFolder(tool.folder!).catch((er) => toast(errText(er), "bad")) },
      tool.start?.window === "hidden" && { label: log === null ? "Show log" : "Hide log", icon: FileText, onClick: () => void showLog() },
      (tool.url || tool.port || tool.folder) && {
        label: "Copy",
        icon: Copy,
        items: [
          tool.url && { label: "Address", hint: tool.url.replace(/^https?:\/\//, ""), onClick: () => copyText(tool.url!, "Address copied") },
          tool.port && { label: "Port", hint: `:${tool.port}`, onClick: () => copyText(String(tool.port), "Port copied") },
          tool.folder && { label: "Folder path", onClick: () => copyText(tool.folder!, "Folder copied") },
          { label: "Tool id", hint: tool.id, onClick: () => copyText(tool.id, "Tool id copied") },
        ],
      },
      "-",
      { label: "Edit", icon: Pencil, onClick: () => set({ editing: { tool, open: true } }) },
    ]);

  return (
    <div className={clsx(depth === 0 && "border-b border-line/60 last:border-b-0")}>
      <div
        className={clsx("group relative flex items-center gap-4 pr-4 hover:bg-raise/40 transition-colors cursor-default", depth ? "py-2" : "py-3")}
        style={{ paddingLeft: 16 + depth * 30 }}
        onDoubleClick={() => openTool(tool)}
        onContextMenu={menu}
      >
        {depth > 0 && (
          <span className="absolute top-0 bottom-0 border-l border-line" style={{ left: 19 + (depth - 1) * 30 }} aria-hidden />
        )}
        <span
          className={clsx("led", running ? "on" : busy ? "busy" : "")}
          title={running ? "Running" : busy ? "Starting" : "Not running"}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2.5">
            <span className={clsx("font-medium truncate", depth ? "text-[14px]" : "text-[14.5px]")}>{tool.name}</span>
            {label && <span className="text-[12px] text-faint shrink-0">{label}</span>}
            {showTheme && theme && (
              <span className="text-[12px] truncate" style={{ color: theme.color }}>
                {theme.name}
              </span>
            )}
          </div>
          {tool.description && <div className="text-[13px] text-dim truncate">{tool.description}</div>}
          {includes.length > 0 && (
            <div className="text-[12px] text-faint truncate">
              Includes:{" "}
              {includes.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ", "}
                  <button
                    title={`Open ${c.name} on its own`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openTool(c);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="hover:text-moon hover:underline"
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-[12px] text-faint num shrink-0">
          {tool.gpu && (
            <span className="flex items-center gap-1 text-warn/90" title="Loads the GPU when it starts">
              <Zap size={12} /> GPU
            </span>
          )}
          <span title="Port" className="w-12 text-right">{tool.port ? `:${tool.port}` : ""}</span>
        </div>

        <div className="flex items-center justify-end gap-0.5 w-[180px] shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconBtn label={pinned ? "Unpin from Home" : "Pin to Home"} onClick={() => togglePin(tool.id)}>
            <Star size={14} className={pinned ? "fill-gold text-gold" : ""} />
          </IconBtn>
          {tool.folder && (
            <IconBtn label="Open folder" onClick={() => api.openFolder(tool.folder!).catch((e) => toast(errText(e), "bad"))}>
              <FolderOpen size={14} />
            </IconBtn>
          )}
          {tool.kind === "web" && tool.embed && (
            <IconBtn label="Open in browser" onClick={() => openInBrowser(tool)}>
              <ExternalLink size={14} />
            </IconBtn>
          )}
          {tool.start?.window === "hidden" && (
            <IconBtn label="Show log" onClick={() => void showLog()}>
              <FileText size={14} />
            </IconBtn>
          )}
          <IconBtn label="Edit" onClick={() => set({ editing: { tool, open: true } })}>
            <Pencil size={14} />
          </IconBtn>
        </div>

        <button
          onClick={() => stopTool(tool)}
          title={tool.stoppable ? `Stop ${tool.name}` : `Stop ${tool.name} (asks first: marked not safe to stop)`}
          className={clsx(
            "h-8 w-[70px] rounded-lg text-[13px] flex items-center justify-center gap-1.5 border border-line text-dim transition-colors shrink-0",
            "hover:bg-bad hover:text-night hover:border-bad",
            !canStop && "invisible",
          )}
        >
          <Power size={13} /> Stop
        </button>
        <button
          disabled={serviceUp || busy}
          onClick={() => (tool.kind === "service" ? requestStart(tool) : openTool(tool))}
          className={clsx(
            "h-8 min-w-[92px] px-3.5 rounded-lg text-[13px] font-medium transition-colors shrink-0",
            serviceUp
              ? "text-live/90 bg-live/10 cursor-default"
              : busy
                ? "text-warn bg-warn/10 cursor-wait"
                : "bg-raise text-moon hover:bg-gold hover:text-night",
          )}
        >
          {busy ? "Starting" : verb}
        </button>
      </div>
      {children}
      {log !== null && (
        <pre className="selectable mx-4 mb-3 max-h-64 overflow-auto rounded-lg bg-night border border-line p-3 text-[12px] text-dim whitespace-pre-wrap">
          {log || "(log is empty)"}
        </pre>
      )}
    </div>
  );
}
