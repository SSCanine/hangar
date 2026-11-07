import clsx from "clsx";
import { FolderKanban, House, MessagesSquare, Plus, Settings, Star, X } from "lucide-react";
import { openMenu } from "./ContextMenu";
import { useStore, toolById } from "../lib/store";
import { themeIcon } from "../lib/icons";
import { listedTools } from "../lib/partof";
import type { View } from "../lib/types";

function same(a: View, b: View) {
  return a.type === b.type && ("id" in a ? a.id : "") === ("id" in b ? b.id : "");
}

function RailButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13.5px] transition-colors text-left",
        active ? "bg-raise text-moon" : "text-dim hover:text-moon hover:bg-raise/50",
      )}
    >
      {children}
    </button>
  );
}

export function Rail() {
  const s = useStore();
  const { registry, status, starting, view, openTools, go, closeTab } = s;
  const themes = registry?.themes ?? [];
  // Tools merged into a hub (part_of) count once, as the hub.
  const listed = listedTools(registry?.tools ?? []);

  return (
    <nav className="w-[248px] shrink-0 border-r border-line bg-panel/40 flex flex-col min-h-0">
      <div className="p-2.5 space-y-0.5">
        <RailButton active={view.type === "home"} onClick={() => go({ type: "home" })}>
          <House size={16} /> Home
        </RailButton>
        <RailButton active={view.type === "projects"} onClick={() => go({ type: "projects" })}>
          <FolderKanban size={16} /> Projects
        </RailButton>
        <RailButton active={view.type === "chats"} onClick={() => go({ type: "chats" })}>
          <MessagesSquare size={16} /> <span className="flex-1">Chats</span>
          {!!s.chatsWaiting && (
            <span title="Sessions waiting on you" className="min-w-5 h-5 px-1.5 rounded-full bg-warn text-night text-[11.5px] font-semibold grid place-items-center num">
              {s.chatsWaiting}
            </span>
          )}
        </RailButton>
      </div>

      {openTools.length > 0 && (
        <div className="px-2.5 pb-2">
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-faint">Open</div>
          <div className="space-y-0.5">
            {openTools.map((id) => {
              const t = toolById(s, id);
              if (!t) return null;
              const theme = themes.find((x) => x.id === t.theme);
              const active = same(view, { type: "tool", id });
              return (
                <div
                  key={id}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: "Switch to it", onClick: () => go({ type: "tool", id }) },
                      { label: s.pinned.includes(id) ? "Unpin from Home" : "Pin to Home", icon: Star, onClick: () => s.togglePin(id) },
                      "-",
                      { label: "Close", icon: X, onClick: () => closeTab(id) },
                      openTools.length > 1 && { label: "Close the others", onClick: () => openTools.filter((o) => o !== id).forEach(closeTab) },
                      openTools.length > 1 && { label: "Close all", onClick: () => openTools.forEach(closeTab) },
                    ])
                  }
                  className={clsx(
                    "group flex items-center h-8 rounded-lg pl-2.5 pr-1 transition-colors",
                    active ? "bg-raise" : "hover:bg-raise/50",
                  )}
                >
                  <button onClick={() => go({ type: "tool", id })} className="flex-1 flex items-center gap-2.5 min-w-0 text-left">
                    <span
                      className={clsx("led", status[id]?.running ? "on" : starting[id] ? "busy" : "")}
                      style={status[id]?.running && theme ? ({ background: theme.color } as React.CSSProperties) : undefined}
                    />
                    <span className={clsx("truncate text-[13.5px]", active ? "text-moon" : "text-dim")}>{t.name}</span>
                  </button>
                  <button
                    aria-label={`Close ${t.name}`}
                    onClick={() => closeTab(id)}
                    className="w-6 h-6 grid place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:text-moon hover:bg-line"
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="px-2.5 pt-3 pb-1.5 mx-2.5 text-[12px] text-faint border-t border-line/70">Themes</div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-3 space-y-0.5">
        {themes.map((th) => {
          const mine = listed.filter((t) => t.theme === th.id || !!t.also_themes?.includes(th.id));
          const live = mine.filter((t) => status[t.id]?.running).length;
          const Icon = themeIcon(th.icon || th.id);
          const active = same(view, { type: "theme", id: th.id });
          return (
            <button
              key={th.id}
              onClick={() => go({ type: "theme", id: th.id })}
              style={{ "--strip": th.color } as React.CSSProperties}
              className={clsx(
                "relative w-full flex items-center gap-2.5 h-9 pl-3 pr-2.5 rounded-lg text-left transition-colors",
                active ? "bg-raise text-moon" : "text-dim hover:text-moon hover:bg-raise/50",
              )}
            >
              <span
                className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
                style={{ background: th.color, opacity: active || live ? 1 : 0.45 }}
              />
              <Icon size={16} style={{ color: th.color }} />
              <span className="flex-1 truncate text-[13.5px]">{th.name}</span>
              <span className="flex gap-[3px]" title={`${live} of ${mine.length} running`}>
                {mine.slice(0, 8).map((t, i) => (
                  <span key={t.id} className={clsx("seg", i < live && "lit")} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="p-2.5 border-t border-line/70">
        <RailButton active={false} onClick={() => s.set({ editing: { tool: null, open: true } })}>
          <Plus size={16} /> Add a tool
        </RailButton>
        <RailButton active={view.type === "settings"} onClick={() => go({ type: "settings" })}>
          <Settings size={16} /> Settings
        </RailButton>
      </div>
    </nav>
  );
}
