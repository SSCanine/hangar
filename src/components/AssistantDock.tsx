import clsx from "clsx";
import { Copy, History, Mic, Plus, Send, Settings2, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdComponents } from "../lib/markdown";
import { api, errText, inTauri } from "../lib/api";
import { ensureRunning, openById, requestStart } from "../lib/actions";
import { OLLAMA_HOST, freeGpu, refreshRoles, resolveRole, roleExtra, saveRoles } from "../lib/roles";
import { ENDPOINTS, useStore, toolById } from "../lib/store";
import { STT_URL, STT_TOOL, KOKORO_VOICES } from "../lib/voice";
import { onSpeech, playChime, speak as speakAloud, stop as stopAloud } from "../lib/speech";
import { SpeakButton } from "./InboxPanel";
import type { ChatMessage, Conversation, LoadedModel, ModelRole } from "../lib/types";

const ACTION_RE = /\[\[(open|start):([a-z0-9-]+)\]\]/g;

function systemPrompt(): string {
  const s = useStore.getState();
  const reg = s.registry;
  const lines = (reg?.tools ?? []).map((t) => {
    const theme = reg?.themes.find((x) => x.id === t.theme)?.name ?? t.theme;
    const on = s.status[t.id]?.running ? "running" : "off";
    return `- ${t.id}: ${t.name} (${theme}, ${on})${t.description ? `: ${t.description}` : ""}`;
  });
  return [
    "You are the assistant inside Hangar, a desktop hub that launches and watches the user's local tools.",
    "Be brief, warm and practical. Plain words, short paragraphs.",
    "When a tool would help, offer it by writing [[open:ID]] on its own line; Hangar turns that into a button the user can click. Only use ids from this list, and never claim you opened something yourself.",
    "",
    "Tools in Hangar right now:",
    ...lines,
  ].join("\n");
}

/** The job's own prompt, plus the Hangar tool list when the job should know it. */
function rolePrompt(role: ModelRole | null): string {
  if (!role) return systemPrompt();
  const parts = [role.knows_hangar ? systemPrompt() : "", role.prompt ?? ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : "You are a helpful local assistant. Be clear and practical.";
}

function newConv(endpoint: string, model: string): Conversation {
  return { id: `c${Date.now().toString(36)}`, title: "New chat", endpoint, model, messages: [], updated: Date.now() };
}

function ActionChips({ text }: { text: string }) {
  const ids = useMemo(() => [...new Set([...text.matchAll(ACTION_RE)].map((m) => m[2]))], [text]);
  const s = useStore();
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {ids.map((id) => {
        const t = toolById(s, id);
        if (!t) return null;
        return (
          <button
            key={id}
            onClick={() => openById(id)}
            className="h-7 px-2.5 rounded-lg bg-gold/15 text-gold hover:bg-gold hover:text-night text-[12.5px] font-medium transition-colors"
          >
            Open {t.name}
          </button>
        );
      })}
    </div>
  );
}

function Bubble({ m, id }: { m: ChatMessage; id: string }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-raise px-3.5 py-2.5 whitespace-pre-wrap">{m.content}</div>
      </div>
    );
  }
  const clean = m.content.replace(ACTION_RE, "").trim();
  return (
    <div className="selectable">
      {m.think && !clean && !m.stopped && <p className="text-faint text-[13px] italic">Thinking…</p>}
      {clean && (
        <div className="md text-[14px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{clean}</ReactMarkdown>
        </div>
      )}
      {m.error && <p className="text-bad text-[13px] mt-1">{m.error}</p>}
      {m.stopped && <p className="text-faint text-[13px] mt-1">Stopped</p>}
      <ActionChips text={m.content} />
      {clean && m.at > 0 && (
        <div className="mt-1 -ml-1">
          <SpeakButton id={id} text={clean} size={13} />
        </div>
      )}
    </div>
  );
}

export function AssistantDock() {
  const s = useStore();
  const { endpoint, models, conversations, activeConv, set, upsertConv, deleteConv, ttsProvider, ttsVoice, autoSpeak, toast, roles } = s;
  const ep = ENDPOINTS.find((e) => e.id === endpoint) ?? ENDPOINTS[0];
  const epTool = ep.toolId ? toolById(s, ep.toolId) : undefined;
  const [available, setAvailable] = useState<string[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<{ req: string; conv: Conversation; text: string; think: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => onSpeech((key) => setSpeaking(key !== null)), []);
  const recRef = useRef<MediaRecorder | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(streaming);
  // The ref is the source of truth for the live reply; events can outrun renders.
  const putStream = (next: typeof streaming) => {
    streamRef.current = next;
    setStreaming(next);
  };

  const isOllama = ep.id === "ollama";
  // On Ollama, a job (Quick, Writer...) picks the model; elsewhere it's the raw model list.
  const role = isOllama && roles?.roles.length ? roles.roles.find((r) => r.id === s.role) ?? roles.roles[0] : null;
  const resolved = role ? resolveRole(role, available) : null;
  const missing = resolved?.missing;
  const model = role ? resolved?.model || "" : models[ep.id] || ep.defaultModel || available?.[0] || "";
  const conv = conversations.find((c) => c.id === activeConv) ?? null;
  const epUp = epTool ? !!s.status[epTool.id]?.running : !offline;

  // Load the model list whenever the endpoint changes or comes up.
  useEffect(() => {
    let alive = true;
    setAvailable(null);
    api
      .models(ep.base)
      .then((m) => alive && (setAvailable(m), setOffline(false)))
      .catch(() => alive && (setAvailable([]), setOffline(true)));
    return () => {
      alive = false;
    };
  }, [ep.base, epUp]);

  useEffect(() => {
    if (!roles) void refreshRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What Ollama holds in memory, for the Free GPU button.
  const checkLoaded = () => void api.ollamaLoaded(OLLAMA_HOST).then(setLoaded);
  useEffect(() => {
    if (!isOllama || offline) return setLoaded([]);
    checkLoaded();
    const t = setInterval(checkLoaded, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ep.id, offline]);

  // Stream events from Rust.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    api
      .onChat((e) => {
        const cur = streamRef.current;
        if (!cur || cur.req !== e.id) return;
        if (e.kind === "delta") putStream({ ...cur, text: cur.text + e.text });
        else if (e.kind === "think") putStream({ ...cur, think: cur.think + e.text });
        else {
          const msg: ChatMessage = {
            role: "assistant",
            content: cur.text,
            think: cur.think || undefined,
            error: e.kind === "error" ? e.text : undefined,
            at: Date.now(),
          };
          upsertConv({ ...cur.conv, messages: [...cur.conv.messages, msg], updated: Date.now() });
          putStream(null);
          if (cur.conv.endpoint === "ollama") checkLoaded();
          const st = useStore.getState();
          if (e.kind === "done" && cur.text && st.chime && (document.hidden || !document.hasFocus())) playChime("done");
          if (e.kind === "done" && cur.text && st.autoSpeak) void speak(cur.text);
        }
      })
      .then((fn) => (cancelled ? fn() : (un = fn)));
    return () => {
      cancelled = true;
      un?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conv?.messages.length, streaming?.text, activeConv]);

  async function send(textIn?: string) {
    const text = (textIn ?? draft).trim();
    if (!text || streaming) return;
    if (role && !model) return toast(`No installed model for ${role.name}. Run: ollama pull ${missing}`, "bad");
    if (!model) return toast("Pick a model first", "bad");
    const base = conv ?? newConv(ep.id, model);
    const user: ChatMessage = { role: "user", content: text, at: Date.now() };
    const next: Conversation = {
      ...base,
      endpoint: ep.id,
      model,
      role: role?.id,
      title: base.messages.length ? base.title : text.slice(0, 60),
      messages: [...base.messages, user],
      updated: Date.now(),
    };
    upsertConv(next);
    setDraft("");
    const req = `${next.id}-${Date.now()}`;
    putStream({ req, conv: next, text: "", think: "" });
    const history = next.messages.slice(-30).map((m) => ({ role: m.role, content: m.content }));
    try {
      const extra = role && roles ? roleExtra(role, roles) : undefined;
      await api.chatStart(req, ep.base, model, [{ role: "system", content: rolePrompt(role) }, ...history], extra);
    } catch (e) {
      putStream(null);
      toast(errText(e), "bad");
    }
  }

  function stopStream() {
    if (streaming) void api.chatCancel(streaming.req);
  }

  async function speak(text: string) {
    if (useStore.getState().ttsProvider === "off" || !inTauri) return;
    await speakAloud(`chat:${Date.now()}`, text);
  }

  async function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: mime });
        if (blob.size < 2000) return;
        setTranscribing(true);
        try {
          if (!(await ensureRunning(STT_TOOL, 60_000))) throw new Error("Speech-to-text didn't start. Check its log in the tool list.");
          const b64 = await blobToB64(blob);
          const text = await api.stt(STT_URL, b64, mime.split(";")[0]);
          if (!text) return toast("Didn't catch any words", "info");
          if (useStore.getState().autoSpeak) void send(text);
          else setDraft((d) => (d ? d + " " : "") + text);
        } catch (e) {
          toast(errText(e), "bad");
        } finally {
          setTranscribing(false);
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      toast(`Microphone unavailable: ${errText(e)}`, "bad");
    }
  }

  const shown: ChatMessage[] = streaming
    ? [...streaming.conv.messages, { role: "assistant", content: streaming.text, think: streaming.think, at: 0 }]
    : conv?.messages ?? [];

  return (
    <aside className="shrink-0 border-l border-line bg-panel/50 flex flex-col min-h-0" style={{ width: s.dockWidth }}>
      <div className="px-3.5 pt-3 pb-2.5 border-b border-line space-y-2.5">
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-night/60 border border-line">
          {ENDPOINTS.map((e) => (
            <button
              key={e.id}
              onClick={() => set({ endpoint: e.id })}
              className={clsx("flex-1 h-7 rounded-md text-[12.5px] transition-colors", e.id === ep.id ? "bg-raise text-moon" : "text-dim hover:text-moon")}
            >
              {e.short}
            </button>
          ))}
        </div>
        {role && roles && (
          <div className="flex flex-wrap gap-1">
            {roles.roles.map((r) => (
              <button
                key={r.id}
                title={r.use_for}
                onClick={() => set({ role: r.id })}
                className={clsx(
                  "h-7 px-2.5 rounded-lg text-[12.5px] transition-colors",
                  r.id === role.id ? "bg-gold text-night font-medium" : "bg-night/60 border border-line text-dim hover:text-moon",
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className={clsx("led", !offline && available ? "on" : "")} title={offline ? "Offline" : "Online"} />
          {role ? (
            <div className="flex-1 min-w-0 text-[12.5px] leading-snug">
              <div className="text-dim truncate" title={role.use_for}>
                {role.use_for}
              </div>
              <div className="text-faint truncate num" title={model}>
                {model || "no model installed"}
              </div>
            </div>
          ) : (
            <select
              value={model}
              onChange={(e) => set({ models: { ...models, [ep.id]: e.target.value } })}
              className="flex-1 min-w-0 h-8 px-2 rounded-lg bg-night border border-line text-[13px] focus:outline-none focus:border-gold"
            >
              {model && !(available ?? []).includes(model) && <option value={model}>{model}</option>}
              {(available ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          {role && (
            <button
              title="Model jobs: pick which model does each job"
              onClick={() => (setShowJobs((v) => !v), setShowHistory(false))}
              className={clsx("w-8 h-8 grid place-items-center rounded-lg hover:bg-raise", showJobs ? "text-gold" : "text-dim hover:text-moon")}
            >
              <Settings2 size={16} />
            </button>
          )}
          <button title="New chat" onClick={() => (set({ activeConv: null }), setShowHistory(false), setShowJobs(false))} className="w-8 h-8 grid place-items-center rounded-lg text-dim hover:text-moon hover:bg-raise">
            <Plus size={16} />
          </button>
          <button title="Past chats" onClick={() => (setShowHistory((v) => !v), setShowJobs(false))} className={clsx("w-8 h-8 grid place-items-center rounded-lg hover:bg-raise", showHistory ? "text-gold" : "text-dim hover:text-moon")}>
            <History size={16} />
          </button>
        </div>
        {offline && (
          <div className="flex items-center gap-2 rounded-lg bg-warn/10 border border-warn/25 px-3 py-2 text-[13px]">
            <span className="flex-1">{ep.name} isn't answering at {ep.base}.</span>
            {epTool && (
              <button onClick={() => requestStart(epTool)} className="h-7 px-2.5 rounded-md bg-warn text-night font-medium text-[12.5px]">
                Turn on
              </button>
            )}
          </div>
        )}
        {role && missing && !offline && (
          <div className="rounded-lg bg-warn/10 border border-warn/25 px-3 py-2 text-[13px] space-y-1.5">
            <p>None of the models for {role.name} are installed. Install the first choice:</p>
            <button
              onClick={() => void api.clipboardSet(`ollama pull ${missing}`).then(() => toast("Copied. Paste it in a terminal.", "ok"))}
              className="w-full flex items-center gap-2 rounded-md bg-night px-2 py-1.5 text-left font-mono text-[12px] hover:text-gold"
            >
              <span className="flex-1 truncate">ollama pull {missing}</span>
              <Copy size={12} />
            </button>
          </div>
        )}
        {isOllama && !offline && (
          <div className="flex items-center gap-2 text-[12px] text-faint">
            <span className="flex-1">
              {loaded.length
                ? `In the GPU: ${loaded.map((m) => `${m.name.split("/").pop()} (${(m.vram / 1024).toFixed(1)} GB)`).join(", ")}`
                : "Local models load into the GPU on the first message."}
            </span>
            {loaded.length > 0 && (
              <button onClick={() => void freeGpu(false).then(checkLoaded)} className="h-6 px-2 rounded-md bg-raise text-moon hover:text-gold text-[12px]">
                Free GPU
              </button>
            )}
          </div>
        )}
      </div>

      {showJobs && role && roles ? (
        <JobsPanel installed={available ?? []} />
      ) : showHistory ? (
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 && <p className="p-3 text-dim text-[13px]">No past chats yet.</p>}
          {conversations.map((c) => (
            <div key={c.id} className={clsx("group flex items-center rounded-lg pr-1", c.id === activeConv ? "bg-raise" : "hover:bg-raise/50")}>
              <button
                onClick={() => {
                  set({ activeConv: c.id, endpoint: c.endpoint, ...(c.role ? { role: c.role } : {}) });
                  setShowHistory(false);
                }}
                className="flex-1 min-w-0 text-left px-3 py-2"
              >
                <div className="truncate text-[13.5px]">{c.title}</div>
                <div className="text-[12px] text-faint num">
                  {new Date(c.updated).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}, {c.model}
                </div>
              </button>
              <button title="Delete chat" onClick={() => deleteConv(c.id)} className="w-7 h-7 grid place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:text-bad">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {shown.length === 0 && (
            <div className="pt-6 text-dim text-[13.5px] space-y-3">
              <p className="text-moon text-[15px] font-medium">Ask for anything, or for a tool.</p>
              <p>“Which tool should I use for this?” gets you an answer with a button that opens it.</p>
              <p>Press the mic to talk instead of typing.</p>
            </div>
          )}
          {shown.map((m, i) => (
            <Bubble key={i} m={m} id={`chat:${conv?.id ?? "live"}:${i}`} />
          ))}
        </div>
      )}

      <div className="p-3 border-t border-line">
        <div className="rounded-xl bg-night border border-line focus-within:border-gold/70 transition-colors">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={transcribing ? "Listening back…" : "Message the local model"}
            className="w-full resize-none bg-transparent px-3.5 pt-2.5 text-[14px] placeholder:text-faint focus:outline-none max-h-40"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <button
              title={recording ? "Stop recording" : "Talk"}
              onClick={toggleMic}
              disabled={transcribing}
              className={clsx("w-8 h-8 grid place-items-center rounded-lg transition-colors", recording ? "bg-bad text-night" : "text-dim hover:text-moon hover:bg-raise")}
            >
              <Mic size={16} />
            </button>
            <button
              title={speaking ? "Stop speaking" : autoSpeak ? "Talk mode is on: replies are read aloud" : "Talk mode is off"}
              onClick={() => (speaking ? stopAloud() : set({ autoSpeak: !autoSpeak }))}
              className={clsx("w-8 h-8 grid place-items-center rounded-lg transition-colors", autoSpeak ? "text-gold" : "text-dim hover:text-moon", "hover:bg-raise")}
            >
              {speaking ? <Square size={14} /> : autoSpeak ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            <select
              title="Voice"
              value={ttsVoice.kokoro ?? ""}
              onChange={(e) => set({ ttsProvider: ttsProvider === "off" ? "off" : "kokoro", ttsVoice: { ...ttsVoice, kokoro: e.target.value } })}
              className="h-8 max-w-[150px] px-1.5 rounded-lg bg-transparent text-[12.5px] text-dim hover:text-moon focus:outline-none"
            >
              {KOKORO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <div className="flex-1" />
            {streaming ? (
              <button title="Stop" onClick={stopStream} className="h-8 px-3 rounded-lg bg-raise text-moon text-[13px] flex items-center gap-1.5">
                <Square size={12} /> Stop
              </button>
            ) : (
              <button title="Send" onClick={() => void send()} disabled={!draft.trim()} className="w-8 h-8 grid place-items-center rounded-lg bg-gold text-night disabled:opacity-35">
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

const KEEP_ALIVE = [
  { v: "1m", label: "1 minute" },
  { v: "5m", label: "5 minutes" },
  { v: "15m", label: "15 minutes" },
  { v: "30m", label: "30 minutes" },
  { v: "-1", label: "Until I press Free GPU" },
];

/** Pick which installed model does each job; prompts and backups live in the file. */
function JobsPanel({ installed }: { installed: string[] }) {
  const { roles, toast } = useStore();
  if (!roles) return null;
  const save = (next: typeof roles) => void saveRoles(next).catch((e) => toast(errText(e), "bad"));
  const patchRole = (id: string, p: Partial<ModelRole>) => save({ ...roles, roles: roles.roles.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3 text-[13px]">
      <p className="text-dim">Each job uses the first installed model in its list. Pick a model here and it moves to the top.</p>
      {roles.roles.map((r) => {
        const current = resolveRole(r, installed).model ?? "";
        return (
          <div key={r.id} className="rounded-xl border border-line bg-night/40 p-3 space-y-2">
            <div>
              <div className="text-moon font-medium">{r.name}</div>
              <div className="text-faint text-[12px]">{r.use_for}</div>
            </div>
            <select
              value={current}
              onChange={(e) => patchRole(r.id, { models: [e.target.value, ...r.models.filter((m) => m !== e.target.value)] })}
              className="w-full h-8 px-2 rounded-lg bg-night border border-line text-[12.5px] focus:outline-none focus:border-gold"
            >
              {!current && <option value="">Not installed: {r.models[0]}</option>}
              {installed.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-[12.5px] text-dim">
              <input type="checkbox" checked={!!r.think} onChange={(e) => patchRole(r.id, { think: e.target.checked })} />
              Think before answering (smarter on hard problems, slower)
            </label>
          </div>
        );
      })}
      <div className="rounded-xl border border-line bg-night/40 p-3 space-y-2">
        <label className="flex items-center gap-2">
          <span className="flex-1 text-dim">Unload from the GPU after</span>
          <select
            value={roles.keep_alive}
            onChange={(e) => save({ ...roles, keep_alive: e.target.value })}
            className="h-8 px-2 rounded-lg bg-night border border-line text-[12.5px] focus:outline-none focus:border-gold"
          >
            {KEEP_ALIVE.map((k) => (
              <option key={k.v} value={k.v}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-dim">
          <input type="checkbox" checked={roles.unload_on_gpu_start} onChange={(e) => save({ ...roles, unload_on_gpu_start: e.target.checked })} />
          Free the GPU when Hangar starts a GPU tool (ComfyUI and similar)
        </label>
      </div>
      <div className="flex gap-2">
        <button onClick={() => void api.openRoles()} className="h-8 px-3 rounded-lg bg-raise text-moon hover:text-gold text-[12.5px]">
          Edit prompts and backups (file)
        </button>
        <button onClick={() => void refreshRoles()} className="h-8 px-3 rounded-lg bg-raise text-moon hover:text-gold text-[12.5px]">
          Reload
        </button>
      </div>
    </div>
  );
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
