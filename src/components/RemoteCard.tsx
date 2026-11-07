import clsx from "clsx";
import { Smartphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errText } from "../lib/api";
import { useStore } from "../lib/store";
import type { RemoteStatus } from "../lib/types";

function ago(ms: number): string {
  if (!ms) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Hangar Remote: the phone page (chats, tools, meters) on the home network. */
export function RemoteCard() {
  const { toast, set } = useStore();
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function look() {
    try {
      setSt(await api.remoteStatus());
    } catch {
      setSt(null);
    }
  }
  useEffect(() => {
    void look();
    // Faster while a pairing code is showing, so a new phone appears as soon as it pairs.
    const t = setInterval(() => void look(), st?.pairing ? 2000 : 10000);
    return () => clearInterval(t);
  }, [!!st?.pairing]);

  async function run(p: Promise<RemoteStatus>) {
    setBusy(true);
    try {
      setSt(await p);
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  function revoke(id: string, name: string) {
    set({
      confirm: {
        title: `Unpair ${name}?`,
        body: "It stops working right away. You can pair it again with a new code.",
        action: "Unpair",
        danger: true,
        onYes: () => void run(api.remoteRevoke(id)),
      },
    });
  }

  if (!st) return null;
  const on = st.enabled && st.running;
  const url = st.urls[0] ?? `http://<this PC>:${st.port}`;
  const left = st.pairing ? Math.max(0, Math.round((st.pairing.expires - Date.now()) / 60000)) : 0;

  return (
    <section className="rounded-2xl border border-line bg-panel/50 p-6 mb-5">
      <div className="flex items-start gap-3 mb-3">
        <h2 className="flex items-center gap-2.5 text-[17px] font-semibold flex-1">
          <Smartphone size={18} className={on ? "text-live" : "text-gold"} /> Phone remote
        </h2>
        <button
          role="switch"
          aria-checked={st.enabled}
          disabled={busy}
          onClick={() => void run(api.remoteSet(!st.enabled))}
          className={clsx("mt-0.5 w-9 h-5 rounded-full relative transition-colors shrink-0", st.enabled ? "bg-gold" : "bg-line")}
        >
          <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-night transition-all", st.enabled ? "left-[18px]" : "left-0.5")} />
        </button>
      </div>
      <p className="text-[13.5px] text-dim">
        Your chats, tools and meters on your phone: open and answer Claude sessions, start and stop tools. Works on your home Wi-Fi only. Each phone pairs once with a code and can be unpaired here. Windows may ask to allow Hangar through the firewall the first time.
      </p>
      {st.error && <p className="text-[13px] text-bad mt-2">{st.error}</p>}

      {on && (
        <div className="mt-4 space-y-4">
          <div className="text-[13.5px]">
            <span className="text-dim">At home, open </span>
            <span className="font-mono text-moon select-all">{url}</span>
          </div>

          {st.pairing ? (
            <div className="flex gap-5 items-center rounded-xl bg-night border border-line p-4">
              <div className="w-[150px] h-[150px] rounded-lg overflow-hidden bg-white shrink-0 [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: st.pairing.qr }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-dim">Scan with the iPhone camera, or type this code on the phone:</div>
                <div className="font-mono text-[34px] tracking-[0.25em] text-gold my-1">{st.pairing.code}</div>
                <div className="text-[12.5px] text-faint">
                  Works for {left} more min, on several devices. Safari and a Home Screen icon each pair once.
                </div>
                <button onClick={() => void run(api.remotePairCancel())} className="mt-2 h-7 px-2.5 rounded-md text-dim hover:text-moon hover:bg-raise text-[13px]">
                  Done pairing
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => void run(api.remotePair())} disabled={busy} className="h-8 px-3 rounded-md bg-gold text-night font-medium text-[13.5px] disabled:opacity-40">
              Pair a phone
            </button>
          )}

          {st.devices.length > 0 && (
            <div>
              <div className="text-[12px] uppercase tracking-wider text-faint mb-1.5">Paired</div>
              {st.devices.map((d) => (
                <div key={d.id} className="flex items-center gap-2 h-9 px-2.5 rounded-lg border border-line bg-night mb-1.5 text-[13px]">
                  <Smartphone size={13} className="text-dim" />
                  <span className="flex-1">{d.name}</span>
                  <span className="text-faint">
                    seen {ago(d.last_seen)}
                    {d.last_ip ? ` from ${d.last_ip}` : ""}
                  </span>
                  <button title="Unpair" onClick={() => revoke(d.id, d.name)} className="w-6 h-6 grid place-items-center rounded text-dim hover:text-bad hover:bg-raise">
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
