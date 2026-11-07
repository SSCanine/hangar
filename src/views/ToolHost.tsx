import clsx from "clsx";
import { ExternalLink, FolderOpen, Power, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errText } from "../lib/api";
import { openInBrowser, requestStart, stopTool, toolUrl } from "../lib/actions";
import { useStore, toolById } from "../lib/store";
import type { Tool } from "../lib/types";

/** One embedded tool. Stays mounted while hidden so its page keeps its state. */
function Frame({ tool, visible }: { tool: Tool; visible: boolean }) {
  const running = useStore((s) => !!s.status[tool.id]?.running);
  const busy = useStore((s) => !!s.starting[tool.id]);
  const path = useStore((s) => s.toolPath[tool.id]);
  const theme = useStore((s) => s.registry?.themes.find((t) => t.id === tool.theme));
  const { set, toast } = useStore.getState();
  const [reloadKey, setReloadKey] = useState(0);
  const [log, setLog] = useState<string | null>(null);
  const wasRunning = useRef(running);

  // When the server comes up (or comes back), load the page fresh.
  useEffect(() => {
    if (running && !wasRunning.current) setReloadKey((k) => k + 1);
    wasRunning.current = running;
  }, [running]);

  const src = toolUrl(tool, path);

  return (
    <div className={clsx("absolute inset-0 flex flex-col", !visible && "invisible pointer-events-none")}>
      <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-b border-line bg-panel/40">
        <span className={clsx("led", running ? "on" : busy ? "busy" : "")} />
        <span className="font-medium">{tool.name}</span>
        {theme && (
          <span className="text-[12px]" style={{ color: theme.color }}>
            {theme.name}
          </span>
        )}
        {tool.views && tool.views.length > 0 && (
          <div className="flex items-center gap-0.5 ml-3 p-0.5 rounded-lg bg-night/60 border border-line">
            {tool.views.map((v, i) => {
              const active = (path ?? tool.views![0].path) === v.path || (!path && i === 0);
              return (
                <button
                  key={v.path}
                  onClick={() => {
                    set({ toolPath: { ...useStore.getState().toolPath, [tool.id]: v.path } });
                    setReloadKey((k) => k + 1);
                  }}
                  className={clsx(
                    "h-6 px-2.5 rounded-md text-[12.5px] transition-colors",
                    active ? "bg-raise text-moon" : "text-dim hover:text-moon",
                  )}
                >
                  {v.name}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex-1" />
        <button title="Reload" onClick={() => setReloadKey((k) => k + 1)} className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-moon hover:bg-line">
          <RotateCw size={14} />
        </button>
        {tool.folder && (
          <button title="Open folder" onClick={() => api.openFolder(tool.folder!).catch((e) => toast(errText(e), "bad"))} className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-moon hover:bg-line">
            <FolderOpen size={14} />
          </button>
        )}
        <button title="Open in browser" onClick={() => openInBrowser(tool)} className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-moon hover:bg-line">
          <ExternalLink size={14} />
        </button>
        {running && !!tool.port && (
          <button title="Stop" onClick={() => stopTool(tool)} className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-bad hover:bg-bad/10">
            <Power size={14} />
          </button>
        )}
      </div>

      <div className="relative flex-1 min-h-0 bg-night">
        {running ? (
          <iframe
            key={reloadKey}
            src={src}
            title={tool.name}
            className="absolute inset-0 w-full h-full border-0 bg-white/0"
            allow="clipboard-read; clipboard-write; autoplay; fullscreen; microphone"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center max-w-md">
              {busy ? (
                <>
                  <div className="led busy mx-auto mb-4 !w-3 !h-3" />
                  <p className="text-[17px] font-medium">Starting {tool.name}</p>
                  <p className="text-dim mt-1.5">It shows up here as soon as it answers on port {tool.port}.</p>
                </>
              ) : (
                <>
                  <p className="text-[17px] font-medium">{tool.name} isn't running</p>
                  <p className="text-dim mt-1.5">
                    {tool.start ? "Start it and it opens here." : "Hangar has no start command for it. Start it yourself, or add one with Edit."}
                  </p>
                  <div className="flex justify-center gap-2 mt-5">
                    {(tool.start || tool.exe) && (
                      <button onClick={() => requestStart(tool)} className="h-9 px-4 rounded-lg bg-gold text-night font-medium">
                        Start {tool.name}
                      </button>
                    )}
                    {tool.start?.window === "hidden" && (
                      <button
                        onClick={async () => setLog(await api.log(tool.id).catch(errText))}
                        className="h-9 px-4 rounded-lg bg-raise text-moon"
                      >
                        Show log
                      </button>
                    )}
                  </div>
                </>
              )}
              {log !== null && (
                <pre className="selectable text-left mt-5 max-h-72 overflow-auto rounded-lg bg-panel border border-line p-3 text-[12px] text-dim whitespace-pre-wrap">
                  {log || "(log is empty)"}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ToolHost() {
  const s = useStore();
  const activeId = s.view.type === "tool" ? s.view.id : null;
  return (
    <div className={clsx("absolute inset-0", !activeId && "invisible pointer-events-none")}>
      {s.openTools.map((id) => {
        const t = toolById(s, id);
        return t ? <Frame key={id} tool={t} visible={id === activeId} /> : null;
      })}
    </div>
  );
}
