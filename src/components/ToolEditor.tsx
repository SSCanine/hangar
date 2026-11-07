import { useEffect, useState } from "react";
import { api, errText } from "../lib/api";
import { refreshRegistry, refreshStatus } from "../lib/actions";
import { useStore } from "../lib/store";
import type { Tool, ToolKind } from "../lib/types";

const blank = (theme: string): Tool => ({
  id: "",
  name: "",
  theme,
  description: "",
  kind: "web",
  embed: true,
  stoppable: true,
  gpu: false,
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const field = "w-full h-9 px-3 rounded-lg bg-night border border-line placeholder:text-faint focus:outline-none focus:border-gold";
const label = "block text-[12.5px] text-dim mb-1.5";

export function ToolEditor() {
  const editing = useStore((s) => s.editing);
  const registry = useStore((s) => s.registry);
  const view = useStore((s) => s.view);
  const { set, toast } = useStore.getState();
  const [t, setT] = useState<Tool>(blank("ai"));
  const [cmdText, setCmdText] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const isNew = !editing.tool;

  useEffect(() => {
    if (!editing.open) return;
    const start = editing.tool ?? blank(view.type === "theme" ? view.id : registry?.themes[0]?.id ?? "ai");
    setT(structuredClone(start));
    setCmdText((start.start?.cmd ?? []).join("\n"));
    setIdTouched(!!editing.tool);
  }, [editing, registry, view]);

  if (!editing.open) return null;
  const close = () => set({ editing: { tool: null, open: false } });
  const up = (p: Partial<Tool>) => setT((x) => ({ ...x, ...p }));

  async function save() {
    const cmd = cmdText.split("\n").map((l) => l.trim()).filter(Boolean);
    const out: Tool = { ...t, id: t.id || slug(t.name) };
    if (cmd.length) out.start = { ...t.start, cmd, cwd: t.start?.cwd || undefined, window: t.start?.window ?? "hidden" };
    else delete out.start;
    for (const k of ["url", "health", "exe", "folder", "notes"] as const) if (!out[k]) delete out[k];
    if (!out.port) delete out.port;
    setBusy(true);
    try {
      await api.upsertTool(out, editing.tool?.id);
      await refreshRegistry();
      void refreshStatus();
      toast(isNew ? `Added ${out.name}` : `Saved ${out.name}`, "ok");
      close();
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing.tool) return;
    const victim = editing.tool;
    set({
      confirm: {
        title: `Remove ${victim.name} from Hangar?`,
        body: "This only takes it off the tool list. Its files and the app itself stay untouched.",
        action: "Remove from list",
        onYes: async () => {
          try {
            await api.deleteTool(victim.id);
            const s = useStore.getState();
            s.closeTab(victim.id);
            set({ pinned: s.pinned.filter((p) => p !== victim.id) });
            await refreshRegistry();
            toast(`Removed ${victim.name} from the list`, "ok");
            close();
          } catch (e) {
            toast(errText(e), "bad");
          }
        },
      },
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-night/70 flex justify-end" onMouseDown={close}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="w-[520px] max-w-full h-full bg-panel border-l border-line flex flex-col"
      >
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-[20px] font-semibold">{isNew ? "Add a tool" : `Edit ${editing.tool!.name}`}</h2>
          <p className="text-dim text-[13px] mt-1">Saved to the tool list file, so every change is plain JSON you can read.</p>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Name</label>
              <input className={field} value={t.name} required onChange={(e) => up({ name: e.target.value, ...(idTouched ? {} : { id: slug(e.target.value) }) })} />
            </div>
            <div>
              <label className={label}>Id</label>
              <input className={field} value={t.id} required onChange={(e) => (setIdTouched(true), up({ id: slug(e.target.value) }))} />
            </div>
          </div>
          <div>
            <label className={label}>What it does</label>
            <input className={field} value={t.description} onChange={(e) => up({ description: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Theme</label>
              <select className={field} value={t.theme} onChange={(e) => up({ theme: e.target.value })}>
                {registry?.themes.map((th) => (
                  <option key={th.id} value={th.id}>
                    {th.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Kind</label>
              <select className={field} value={t.kind} onChange={(e) => up({ kind: e.target.value as ToolKind })}>
                <option value="web">Web page</option>
                <option value="app">Desktop app</option>
                <option value="service">Background service</option>
              </select>
            </div>
          </div>
          {t.kind !== "app" && (
            <div className="grid grid-cols-[1fr_110px] gap-3">
              <div>
                <label className={label}>Address</label>
                <input className={field} placeholder="http://127.0.0.1:8080/" value={t.url ?? ""} onChange={(e) => up({ url: e.target.value })} />
              </div>
              <div>
                <label className={label}>Port</label>
                <input className={field} inputMode="numeric" value={t.port ?? ""} onChange={(e) => up({ port: Number(e.target.value) || undefined })} />
              </div>
            </div>
          )}
          {t.kind !== "app" && (
            <div>
              <label className={label}>Health check path (blank checks the port)</label>
              <input className={field} placeholder="/health" value={t.health ?? ""} onChange={(e) => up({ health: e.target.value })} />
            </div>
          )}
          {t.kind === "app" && (
            <div>
              <label className={label}>Program (.exe)</label>
              <input className={field} value={t.exe ?? ""} onChange={(e) => up({ exe: e.target.value })} />
            </div>
          )}
          <div>
            <label className={label}>Start command, one argument per line</label>
            <textarea
              className={field + " h-24 py-2 font-[inherit] resize-y"}
              placeholder={"python.exe\nserver.py\n--no-browser"}
              value={cmdText}
              onChange={(e) => setCmdText(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-[1fr_150px] gap-3">
            <div>
              <label className={label}>Start in folder</label>
              <input className={field} value={t.start?.cwd ?? ""} onChange={(e) => up({ start: { ...t.start, cmd: t.start?.cmd ?? [], window: t.start?.window ?? "hidden", cwd: e.target.value } })} />
            </div>
            <div>
              <label className={label}>Window</label>
              <select
                className={field}
                value={t.start?.window ?? "hidden"}
                onChange={(e) => up({ start: { ...t.start, cmd: t.start?.cmd ?? [], cwd: t.start?.cwd, window: e.target.value as "hidden" } })}
              >
                <option value="hidden">Hidden (logged)</option>
                <option value="minimized">Minimized</option>
                <option value="console">Own console</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label}>Project folder</label>
            <input className={field} value={t.folder ?? ""} onChange={(e) => up({ folder: e.target.value })} />
          </div>
          <div className="space-y-2.5 pt-1">
            {t.kind === "web" && (
              <label className="flex items-center gap-2.5">
                <input type="checkbox" checked={t.embed} onChange={(e) => up({ embed: e.target.checked })} className="accent-[var(--color-gold)] w-4 h-4" />
                Open inside Hangar (uncheck if the page refuses to be embedded)
              </label>
            )}
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={t.stoppable} onChange={(e) => up({ stoppable: e.target.checked })} className="accent-[var(--color-gold)] w-4 h-4" />
              Safe to stop from Hangar
            </label>
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={t.gpu} onChange={(e) => up({ gpu: e.target.checked })} className="accent-[var(--color-gold)] w-4 h-4" />
              Loads the GPU (Hangar asks before starting it)
            </label>
          </div>
          <div>
            <label className={label}>Notes</label>
            <input className={field} value={t.notes ?? ""} onChange={(e) => up({ notes: e.target.value })} />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-line flex items-center gap-2">
          {!isNew && (
            <button type="button" onClick={remove} className="h-9 px-3 rounded-lg text-bad/90 hover:bg-bad/10">
              Remove from list
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={close} className="h-9 px-4 rounded-lg text-dim hover:text-moon hover:bg-raise">
            Cancel
          </button>
          <button disabled={busy} className="h-9 px-4 rounded-lg bg-gold text-night font-medium disabled:opacity-60">
            {isNew ? "Add tool" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
