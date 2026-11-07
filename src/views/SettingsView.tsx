import clsx from "clsx";
import { Bell, CheckCircle2, MessagesSquare, Play, Volume2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errText, type ChatMode } from "../lib/api";
import { ensureRunning } from "../lib/actions";
import { RemoteCard } from "../components/RemoteCard";
import { playChime, speak } from "../lib/speech";
import { useStore } from "../lib/store";
import { KOKORO_VOICES } from "../lib/voice";

const STYLES = [
  { id: "bell", name: "Bell", hint: "soft glass bell" },
  { id: "marimba", name: "Marimba", hint: "short wooden notes" },
  { id: "glass", name: "Glass", hint: "high and very quiet" },
] as const;

const READ_MODES = [
  { id: "full", name: "Full reply", hint: "every word Claude wrote" },
  { id: "brief", name: "Brief", hint: "a few sentences: what happened and what you need to do" },
] as const;

const CHAT_MODES: { id: ChatMode; name: string; hint: string }[] = [
  { id: "default", name: "Ask me", hint: "Claude asks before edits and commands; answer in the chat's Terminal (recommended)" },
  { id: "acceptEdits", name: "Allow edits", hint: "file edits go ahead; commands still ask" },
  { id: "bypassPermissions", name: "Never ask", hint: "everything runs without asking (risky)" },
];

// Kokoro voice ids start with accent + gender: af = American woman, bm = British man, ...
const GROUPS: Record<string, string> = { af: "American, female", am: "American, male", bf: "British, female", bm: "British, male" };

function voiceLabel(id: string): string {
  const name = id.split("_")[1] ?? id;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <button
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={clsx("mt-0.5 w-9 h-5 rounded-full relative transition-colors shrink-0", on ? "bg-gold" : "bg-line")}
      >
        <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-night transition-all", on ? "left-[18px]" : "left-0.5")} />
      </button>
      <span>
        <span className="block text-[14px]">{label}</span>
        {hint && <span className="block text-[12.5px] text-dim">{hint}</span>}
      </span>
    </label>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel/50 p-6 mb-5">
      <h2 className="flex items-center gap-2.5 text-[17px] font-semibold mb-3">
        {icon} {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsView() {
  const s = useStore();
  const { set } = s;
  const [voices, setVoices] = useState<string[]>([]);
  const [hook, setHook] = useState<{ installed: boolean; events: string[]; settings?: string } | null>(null);

  useEffect(() => {
    api.hookStatus().then(setHook).catch(() => setHook(null));
    api.ttsVoices().then(async (v) => {
      if (v.length) return setVoices(v);
      // Kokoro is off: it is a light CPU server, so start it to list the voices.
      if (await ensureRunning("kokoro", 45_000)) setVoices(await api.ttsVoices());
    });
  }, []);

  // The hook reads these from notify.json.
  useEffect(() => {
    void api.notifySettings({ chime: s.chime, chime_waiting: s.chimeWaiting, style: s.chimeStyle, toast: s.popups });
  }, [s.chime, s.chimeWaiting, s.chimeStyle, s.popups]);

  const [mode, setMode] = useState<ChatMode | null>(null);
  useEffect(() => void api.chatModeGet().then(setMode).catch(() => setMode("default")), []);
  const pickMode = (m: ChatMode) => api.chatModeSet(m).then(setMode).catch((e) => s.toast(errText(e), "bad"));

  const english = voices.filter((v) => GROUPS[v.slice(0, 2)]);
  const list = english.length ? english : KOKORO_VOICES.map((v) => v.id);
  const current = s.ttsVoice.kokoro ?? "af_heart";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-10 pt-10 pb-16">
        <h1 className="text-[34px] leading-none font-semibold tracking-[-0.02em] mb-2" style={{ fontVariationSettings: '"wdth" 90' }}>
          Settings
        </h1>
        <p className="text-dim mb-8">Your phone, Claude chats, chimes and the voice that reads replies to you. Changes save right away.</p>

        <RemoteCard />

        <Card icon={<MessagesSquare size={18} className="text-gold" />} title="Claude chats">
          <p className="text-[13px] text-dim mb-3">
            How chats that Hangar starts (from the Chats page or the phone) handle Claude's permission prompts. Chats you start yourself in a terminal or VS Code are not affected.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {CHAT_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => void pickMode(m.id)}
                className={clsx(
                  "rounded-xl border px-3 py-2.5 text-left transition-colors",
                  mode === m.id ? (m.id === "bypassPermissions" ? "border-bad bg-bad/10" : "border-gold bg-gold/10") : "border-line hover:border-faint",
                )}
              >
                <div className="text-[14px] font-medium">{m.name}</div>
                <div className="text-[12px] text-dim">{m.hint}</div>
              </button>
            ))}
          </div>
          {mode === "bypassPermissions" && (
            <p className="text-[12.5px] text-bad mt-2">
              Claude can edit and delete files and run any command in that folder without asking, and so can anyone with a paired phone. Only use this in folders you can afford to lose.
            </p>
          )}
        </Card>

        <Card icon={<Bell size={18} className="text-gold" />} title="Chimes">
          <Toggle on={s.chime} onChange={(v) => set({ chime: v })} label="Chime when Claude finishes" hint="Every Claude Code session (VS Code and background jobs) and Hangar's assistant." />
          <Toggle
            on={s.popups}
            onChange={(v) => set({ popups: v })}
            label="Show a Windows notification"
            hint="Says which conversation it came from. Click it, or Open conversation, to jump into that chat in Hangar."
          />
          <Toggle on={s.chimeWaiting} onChange={(v) => set({ chimeWaiting: v })} label="Chime when Claude is waiting for you" hint="A permission prompt or a question. A different, lower chime." />
          <div className="mt-4">
            <div className="text-[13px] text-dim mb-2">Chime style</div>
            <div className="grid grid-cols-3 gap-2">
              {STYLES.map((st) => (
                <button
                  key={st.id}
                  onClick={() => {
                    set({ chimeStyle: st.id });
                    playChime("done", st.id);
                  }}
                  className={clsx(
                    "rounded-xl border px-3 py-2.5 text-left transition-colors",
                    s.chimeStyle === st.id ? "border-gold bg-gold/10" : "border-line hover:border-faint",
                  )}
                >
                  <div className="text-[14px] font-medium">{st.name}</div>
                  <div className="text-[12px] text-dim">{st.hint}</div>
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={() => playChime("done")} className="h-8 px-3 rounded-lg bg-raise hover:bg-line text-[13px] flex items-center gap-1.5">
                <Play size={13} /> Test "done"
              </button>
              <button onClick={() => playChime("waiting")} className="h-8 px-3 rounded-lg bg-raise hover:bg-line text-[13px] flex items-center gap-1.5">
                <Play size={13} /> Test "waiting"
              </button>
            </div>
          </div>
        </Card>

        <Card icon={<Volume2 size={18} className="text-gold" />} title="Voice">
          <p className="text-[13px] text-dim mb-3">
            Kokoro reads replies aloud: a small open-source voice that runs on the CPU, so it never touches the GPU.
          </p>
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <label className="block">
              <span className="text-[13px] text-dim">Voice</span>
              <select
                value={current}
                onChange={(e) => set({ ttsProvider: "kokoro", ttsVoice: { ...s.ttsVoice, kokoro: e.target.value } })}
                className="mt-1 w-full h-9 px-2 rounded-lg bg-night border border-line focus:outline-none focus:border-gold"
              >
                {Object.entries(GROUPS).map(([prefix, label]) => {
                  const group = list.filter((v) => v.startsWith(prefix));
                  return group.length ? (
                    <optgroup key={prefix} label={label}>
                      {group.map((v) => (
                        <option key={v} value={v}>
                          {voiceLabel(v)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </label>
            <button
              onClick={() => {
                set({ ttsProvider: "kokoro" });
                void speak("settings:preview", "Hi. This is how I'll read your replies. Claude finished the job, and everything checked out.");
              }}
              className="h-9 px-4 rounded-lg bg-gold text-night font-medium text-[13px] flex items-center gap-1.5"
            >
              <Play size={13} /> Preview
            </button>
          </div>
          <label className="block mt-4">
            <span className="text-[13px] text-dim">Speed: {s.ttsSpeed.toFixed(2)}x</span>
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.05}
              value={s.ttsSpeed}
              onChange={(e) => set({ ttsSpeed: Number(e.target.value) })}
              className="w-full accent-[var(--color-gold)]"
            />
          </label>
          <div className="mt-4">
            <div className="text-[13px] text-dim mb-2">Read aloud for Claude Code replies</div>
            <div className="grid grid-cols-2 gap-2">
              {READ_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => set({ readAloud: m.id })}
                  className={clsx(
                    "rounded-xl border px-3 py-2.5 text-left transition-colors",
                    s.readAloud === m.id ? "border-gold bg-gold/10" : "border-line hover:border-faint",
                  )}
                >
                  <div className="text-[14px] font-medium">{m.name}</div>
                  <div className="text-[12px] text-dim">{m.hint}</div>
                </button>
              ))}
            </div>
            <p className="text-[12px] text-faint mt-1.5">
              Used by the play button under the bell, auto-read and the notification's Read aloud. Briefs come from your local model (the Quick job in Ollama); with none running, Hangar cuts a short version from the reply itself.
            </p>
          </div>
          <div className="mt-2">
            <Toggle
              on={s.autoReadInbox}
              onChange={(v) => set({ autoReadInbox: v })}
              label="Read new Claude Code replies aloud automatically"
              hint="Off: press play on a message when you want it. With several sessions running this can get busy."
            />
            <Toggle on={s.autoSpeak} onChange={(v) => set({ autoSpeak: v })} label="Read Hangar assistant replies aloud automatically" />
          </div>
        </Card>

        <Card icon={hook?.installed ? <CheckCircle2 size={18} className="text-live" /> : <XCircle size={18} className="text-bad" />} title="Claude Code hook">
          {hook?.installed ? (
            <p className="text-[13.5px] text-dim">
              Installed in your Claude Code settings on {hook.events.join(" and ")}. Each finished reply or wait plays a chime and lands under the bell, even when Hangar is closed.
            </p>
          ) : (
            <p className="text-[13.5px] text-dim">
              Not installed. Ask Claude to add Hangar's notification hook (hooks/hangar_notify.py) to the Stop and Notification events in ~/.claude/settings.json.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
