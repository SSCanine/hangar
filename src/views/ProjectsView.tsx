import { Code2, Copy, ExternalLink, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openMenu } from "../components/ContextMenu";
import { copyText } from "../lib/clipboard";
import { useEffect, useState } from "react";
import { api, errText, inTauri } from "../lib/api";
import { useStore } from "../lib/store";
import type { ProjectGroup } from "../lib/types";

// projects.json has had a few shapes over time; accept the common ones.
function normalize(raw: unknown): ProjectGroup[] {
  const obj = raw as Record<string, unknown>;
  const groups = (Array.isArray(raw) ? raw : (obj?.groups as unknown[])) ?? [];
  return groups
    .map((g) => {
      const gg = g as Record<string, unknown>;
      return {
        name: String(gg.name ?? gg.title ?? gg.group ?? "Projects"),
        items: ((gg.items ?? gg.projects ?? []) as Record<string, unknown>[]).map((it) => ({
          ...it,
          name: String(it.name ?? it.title ?? "Untitled"),
          path: (it.path ?? it.folder) as string | undefined,
          url: it.url as string | undefined,
          description: (it.description ?? it.desc ?? it.purpose) as string | undefined,
        })),
      };
    })
    .filter((g) => g.items.length);
}

export function ProjectsView() {
  const toast = useStore((s) => s.toast);
  const [groups, setGroups] = useState<ProjectGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.projects().then((raw) => setGroups(normalize(raw))).catch((e) => setError(errText(e)));
  }, []);

  const needle = q.trim().toLowerCase();
  const shown = (groups ?? [])
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !needle || `${i.name} ${i.description ?? ""} ${i.path ?? ""}`.toLowerCase().includes(needle)),
    }))
    .filter((g) => g.items.length);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-10 pt-10 pb-16">
        <header className="flex items-end gap-6 mb-8">
          <div className="flex-1">
            <h1 className="text-[34px] leading-none font-semibold tracking-[-0.02em]" style={{ fontVariationSettings: '"wdth" 90' }}>
              Projects
            </h1>
            <p className="text-dim mt-2">Your project folders, from registry/projects.json.</p>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter projects"
            className="h-9 w-64 px-3 rounded-lg bg-panel border border-line placeholder:text-faint focus:outline-none focus:border-gold"
          />
        </header>
        {error && <p className="text-bad">{error}</p>}
        {groups === null && !error && <p className="text-dim">Reading the project index…</p>}
        {groups !== null && groups.length === 0 && (
          <p className="text-dim">No projects yet. Add them to registry/projects.json (see projects.example.json), or ask your Claude to do it.</p>
        )}
        {shown.map((g) => (
          <section key={g.name} className="mb-8">
            <h2 className="text-[13px] text-faint mb-2 px-1">{g.name}</h2>
            <div className="rounded-xl border border-line bg-panel/50">
              {g.items.map((it) => (
                <div
                  key={it.name + (it.path ?? "")}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      it.url && { label: "Open", icon: ExternalLink, onClick: () => void api.openUrl(it.url!) },
                      it.path && { label: "Open folder", icon: FolderOpen, onClick: () => void api.openFolder(it.path!).catch((er) => toast(errText(er), "bad")) },
                      it.path && inTauri && { label: "Open in VS Code", icon: Code2, onClick: () => void invoke("vscode_open", { cwd: it.path }).catch((er) => toast(errText(er), "bad")) },
                      "-",
                      it.path && { label: "Copy folder path", icon: Copy, onClick: () => copyText(it.path!, "Folder copied") },
                      it.url && { label: "Copy address", icon: Copy, onClick: () => copyText(it.url!, "Address copied") },
                      { label: "Copy name", icon: Copy, onClick: () => copyText(it.name, "Name copied") },
                    ])
                  }
                  className="flex items-center gap-4 px-4 py-2.5 border-b border-line/60 last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[14px] truncate">{it.name}</div>
                    {it.description && <div className="text-[13px] text-dim truncate">{it.description}</div>}
                  </div>
                  {it.path && (
                    <button
                      onClick={() => api.openFolder(it.path!).catch((e) => toast(errText(e), "bad"))}
                      title={it.path}
                      className="h-7 px-2.5 rounded-md text-[12.5px] text-dim hover:text-moon hover:bg-line flex items-center gap-1.5"
                    >
                      <FolderOpen size={13} /> Folder
                    </button>
                  )}
                  {it.url && (
                    <button
                      onClick={() => api.openUrl(it.url!)}
                      title={it.url}
                      className="h-7 px-2.5 rounded-md text-[12.5px] text-dim hover:text-moon hover:bg-line flex items-center gap-1.5"
                    >
                      <ExternalLink size={13} /> Open
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
