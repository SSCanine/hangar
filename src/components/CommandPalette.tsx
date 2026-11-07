import { Command } from "cmdk";
import { Activity, Bot, FolderKanban, FolderOpen, House, MessageSquarePlus, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errText } from "../lib/api";
import { openTool, refreshRegistry } from "../lib/actions";
import { themeIcon } from "../lib/icons";
import { hubOf, toolMap } from "../lib/partof";
import { useStore } from "../lib/store";

interface ProjectHit {
  name: string;
  path?: string;
  url?: string;
  group: string;
}

/** Strict ranking: name prefix > word start > substring > keyword hit. No scattered-letter matches. */
function score(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const name = value.toLowerCase();
  if (name.startsWith(q)) return 1;
  if (name.split(/[\s/()\-,]+/).some((w) => w.startsWith(q))) return 0.9;
  if (name.includes(q)) return 0.75;
  const words = q.split(/\s+/);
  const hay = (name + " " + (keywords ?? []).join(" ")).toLowerCase();
  if (words.every((w) => hay.includes(w))) return 0.4;
  return 0;
}

const itemCls =
  "flex items-center gap-3 h-10 px-3 rounded-lg text-[14px] text-dim cursor-default data-[selected=true]:bg-raise data-[selected=true]:text-moon";

export function CommandPalette() {
  const s = useStore();
  const { paletteOpen, registry, status, set, go, toast } = s;
  const [projects, setProjects] = useState<ProjectHit[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (paletteOpen) setQ("");
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen || projects.length) return;
    api
      .projects()
      .then((raw) => {
        const groups = ((raw as { groups?: { name: string; items: Record<string, string>[] }[] }).groups ?? []);
        setProjects(groups.flatMap((g) => g.items.map((i) => ({ name: i.name, path: i.path, url: i.url, group: g.name }))));
      })
      .catch(() => {});
  }, [paletteOpen, projects.length]);

  if (!paletteOpen) return null;
  const close = () => set({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const themeOf = (id: string) => registry?.themes.find((t) => t.id === id);
  function rank<T>(items: T[], name: (x: T) => string, keys: (x: T) => string[], limit = 60): T[] {
    if (!q.trim()) return items.slice(0, limit);
    return items
      .map((x, i) => ({ x, i, s: score(name(x), q, keys(x)) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, limit)
      .map((r) => r.x);
  }
  const byId = toolMap(registry?.tools ?? []);
  const tools = rank(registry?.tools ?? [], (t) => t.name, (t) => [t.id, themeOf(t.theme)?.name ?? "", t.description]);
  const themes = rank(registry?.themes ?? [], (t) => t.name, () => ["theme"]);
  const projs = rank(projects, (p) => p.name, (p) => [p.group, "project"], q.trim() ? 30 : 0);
  const show = (label: string) => score(label, q) > 0 || !q.trim();

  return (
    <div className="fixed inset-0 z-50 bg-night/70 backdrop-blur-[2px] flex justify-center pt-[12vh]" onMouseDown={close}>
      <Command
        label="Find a tool, project or action"
        loop
        shouldFilter={false}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="w-[640px] max-w-[92vw] h-fit max-h-[64vh] flex flex-col rounded-2xl border border-line bg-panel shadow-[0_24px_80px_-20px_rgba(0,0,0,.7)] overflow-hidden"
      >
        <Command.Input
          autoFocus
          value={q}
          onValueChange={(v) => {
            setQ(v);
            document.querySelector("[cmdk-list]")?.scrollTo({ top: 0 });
          }}
          placeholder="Find a tool, project or action"
          className="h-14 shrink-0 px-5 bg-transparent text-[16px] border-b border-line placeholder:text-faint focus:outline-none"
        />
        <Command.List className="overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-dim text-center">Nothing matches that.</Command.Empty>

          <Command.Group heading="Tools" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-faint">
            {tools.map((t) => {
              const th = themeOf(t.theme);
              // A tool merged into a hub app still turns up here, but points to (and opens) the hub.
              const hub = hubOf(t, byId);
              return (
                <Command.Item
                  key={t.id}
                  value={t.name}
                  keywords={[t.id, th?.name ?? "", t.description]}
                  onSelect={run(() => openTool(hub ?? t))}
                  className={itemCls}
                >
                  <span className={status[(hub ?? t).id]?.running ? "led on" : "led"} />
                  <span className="text-moon">{t.name}</span>
                  <span className="flex-1 truncate text-[12.5px] text-faint">{hub ? `Inside ${hub.name}` : t.description}</span>
                  {th && (
                    <span className="text-[12px] shrink-0" style={{ color: th.color }}>
                      {th.name}
                    </span>
                  )}
                </Command.Item>
              );
            })}
          </Command.Group>

          <Command.Group heading="Themes" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-faint">
            {themes.map((th) => {
              const Icon = themeIcon(th.icon || th.id);
              return (
                <Command.Item key={th.id} value={`${th.name} (theme)`} onSelect={run(() => go({ type: "theme", id: th.id }))} className={itemCls}>
                  <Icon size={16} style={{ color: th.color }} />
                  <span className="text-moon">{th.name}</span>
                </Command.Item>
              );
            })}
          </Command.Group>

          <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-faint">
            {[
              { label: "Go home", Icon: House, act: () => go({ type: "home" }) },
              { label: "Show or hide the assistant", Icon: Bot, act: () => set({ dockOpen: !useStore.getState().dockOpen }) },
              { label: "New chat", Icon: MessageSquarePlus, act: () => set({ dockOpen: true, activeConv: null }) },
              { label: "Add a tool", Icon: Plus, act: () => set({ editing: { tool: null, open: true } }) },
              { label: "Reload the tool list", Icon: RefreshCw, act: () => refreshRegistry().then(() => toast("Tool list reloaded", "ok")) },
              { label: "All projects", Icon: FolderKanban, act: () => go({ type: "projects" }) },
              { label: "System (CPU, GPU, RAM, drives, network)", Icon: Activity, act: () => go({ type: "system" }) },
            ]
              .filter((a) => show(a.label))
              .map(({ label, Icon, act }) => (
                <Command.Item key={label} value={`${label} (action)`} onSelect={run(act)} className={itemCls}>
                  <Icon size={16} /> {label}
                </Command.Item>
              ))}
          </Command.Group>

          <Command.Group heading="Projects" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-faint">
            {projs.map((p) => (
              <Command.Item
                key={p.group + p.name + (p.path ?? "")}
                value={`${p.name} (project, ${p.group})`}
                onSelect={run(() => {
                  if (p.url) void api.openUrl(p.url);
                  else if (p.path) api.openFolder(p.path).catch((e) => toast(errText(e), "bad"));
                })}
                className={itemCls}
              >
                <FolderOpen size={16} />
                <span className="text-moon">{p.name}</span>
                <span className="flex-1 truncate text-[12.5px] text-faint">{p.group}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
