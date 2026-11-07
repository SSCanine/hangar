import clsx from "clsx";
import { useEffect, useState } from "react";
import { api, errText, type SessionProcs } from "../lib/api";
import { useStore } from "../lib/store";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "es"}`;

/** "Close completely": ends a Claude session, the processes it started and its link to
 * claude.ai, then archives the conversation. Lists every process first so you can keep one. */
export function CloseSession() {
  const target = useStore((s) => s.closing);
  const { set, toast, forgetChat } = useStore.getState();
  const [info, setInfo] = useState<SessionProcs | null>(null);
  const [err, setErr] = useState("");
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [archive, setArchive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInfo(null);
    setErr("");
    setKeep(new Set());
    setBusy(false);
    if (!target) return;
    let alive = true;
    api
      .chatsProcs(target.session_id)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        setKeep(new Set(i.procs.filter((p) => p.yours).map((p) => p.pid)));
        // A terminal or VS Code session owns its file; leave it in place unless asked.
        setArchive(i.kind !== "interactive");
      })
      .catch((e) => alive && setErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && set({ closing: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, busy, set]);

  if (!target) return null;
  const close = () => !busy && set({ closing: null });
  const killable = info?.procs.filter((p) => !p.refused) ?? [];
  const killing = killable.filter((p) => !keep.has(p.pid)).length;

  async function go() {
    if (!target || !info) return;
    setBusy(true);
    try {
      const r = await api.chatsClose(target.id, target.session_id, target.cwd, target.name, [...keep], archive);
      if (r.archived || archive) forgetChat(target.id);
      const said = [
        r.ended ? "Session ended" : "Session was already stopped",
        r.killed.length ? `${plural(r.killed.length, "process")} closed` : "",
        r.archived ? "conversation archived" : "",
      ].filter(Boolean);
      toast(`${said.join(", ")}.`, "ok");
      if (r.left.length) toast(`Still running: ${r.left.join(", ")}. Close it from the CPU panel.`, "bad");
      set({ closing: null });
      target.onDone?.();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  const interactive = info?.kind === "interactive";
  return (
    <div className="fixed inset-0 z-[60] bg-night/70 grid place-items-center" onMouseDown={close}>
      <div role="dialog" aria-modal className="w-[620px] max-w-[94vw] rounded-2xl bg-panel border border-line p-6" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-[18px] font-semibold">Close "{target.name || target.id}" completely?</h2>
        {!info && !err && <p className="text-dim mt-3 text-[13.5px]">Looking for everything this session started…</p>}
        {info && (
          <div className="mt-3 space-y-3 text-[13.5px] text-dim">
            <ul className="space-y-1.5 list-disc pl-5">
              <li>
                {info.running
                  ? interactive
                    ? "Ends the Claude session. It runs in VS Code or a terminal, so that window's chat ends too."
                    : "Ends the Claude session."
                  : "The session itself is already stopped."}
              </li>
              <li>Drops its connection to Anthropic, so it disappears from claude.ai and the Claude phone app.</li>
              <li>{killable.length ? `Closes ${plural(killing, "process")} it started (untick any you want to keep):` : "It left no processes running."}</li>
            </ul>
            {info.procs.length > 0 && (
              <div className="max-h-[34vh] overflow-y-auto rounded-lg border border-line divide-y divide-line/60">
                {info.procs.map((p) => (
                  <label key={p.pid} className={clsx("flex items-start gap-2.5 px-3 py-2", p.refused ? "opacity-60" : "cursor-pointer hover:bg-raise/40")}>
                    <input
                      type="checkbox"
                      disabled={!!p.refused || busy}
                      checked={!p.refused && !keep.has(p.pid)}
                      onChange={() =>
                        setKeep((k) => {
                          const n = new Set(k);
                          n.has(p.pid) ? n.delete(p.pid) : n.add(p.pid);
                          return n;
                        })
                      }
                      className="accent-[var(--color-gold)] w-3.5 h-3.5 mt-1"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="text-moon">{p.name}</span>
                        <span className="text-[11.5px] text-faint num">{p.pid}</span>
                        {p.ports.length > 0 && <span className="text-[11.5px] text-gold num">:{p.ports.join(", :")}</span>}
                        {p.yours && <span className="text-[11.5px] text-warn">probably yours</span>}
                        <span className="ml-auto text-[11.5px] text-faint num">{p.mem} MB</span>
                      </span>
                      <span className="block truncate font-mono text-[11.5px] text-faint" title={p.cmd}>
                        {p.refused ?? p.cmd}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={archive} disabled={busy} onChange={(e) => setArchive(e.target.checked)} className="accent-[var(--color-gold)] w-3.5 h-3.5" />
              Move the conversation to the chat archive and take it off the list (nothing is deleted)
            </label>
          </div>
        )}
        {err && <p className="mt-3 text-bad text-[13px] selectable">{err}</p>}
        <div className="flex justify-end gap-2 mt-6">
          <button autoFocus onClick={close} disabled={busy} className="h-9 px-4 rounded-lg text-dim hover:text-moon hover:bg-raise disabled:opacity-40">
            Not now
          </button>
          <button onClick={() => void go()} disabled={!info || busy} className="h-9 px-4 rounded-lg bg-bad text-night font-medium disabled:opacity-40">
            {busy ? "Closing…" : "Close it"}
          </button>
        </div>
      </div>
    </div>
  );
}
