import clsx from "clsx";
import { useEffect } from "react";
import { useStore } from "../lib/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={clsx(
            "px-4 py-2.5 rounded-xl text-[13.5px] border shadow-[0_12px_40px_-12px_rgba(0,0,0,.6)] max-w-[560px]",
            t.tone === "bad" && "bg-[#3a2030] border-bad/40 text-moon",
            t.tone === "ok" && "bg-[#1d3330] border-live/30 text-moon",
            t.tone === "info" && "bg-raise border-line text-moon",
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ confirm: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, set]);
  if (!confirm) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-night/70 grid place-items-center" onMouseDown={() => set({ confirm: null })}>
      <div role="dialog" aria-modal className="w-[520px] max-w-[92vw] rounded-2xl bg-panel border border-line p-6" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-[18px] font-semibold">{confirm.title}</h2>
        <p className="text-dim mt-2 whitespace-pre-line max-h-[50vh] overflow-y-auto selectable">{confirm.body}</p>
        <div className="flex justify-end gap-2 mt-6">
          <button autoFocus={!!confirm.danger} onClick={() => set({ confirm: null })} className="h-9 px-4 rounded-lg text-dim hover:text-moon hover:bg-raise">
            Not now
          </button>
          <button
            autoFocus={!confirm.danger}
            onClick={() => {
              const fn = confirm.onYes;
              set({ confirm: null });
              fn();
            }}
            className={confirm.danger ? "h-9 px-4 rounded-lg bg-bad text-night font-medium" : "h-9 px-4 rounded-lg bg-gold text-night font-medium"}
          >
            {confirm.action}
          </button>
        </div>
      </div>
    </div>
  );
}
