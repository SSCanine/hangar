import clsx from "clsx";
import { Archive, Code2, Copy, ExternalLink, FileText, FolderOpen, Image as ImageIcon, MessageSquare, Paperclip, Plus, Power, RefreshCw, Search, Send, Smartphone, Square, SquareTerminal, Trash2, Unplug, Wrench, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdComponents } from "../lib/markdown";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, errText, inTauri, type SentResult } from "../lib/api";
import { useStore } from "../lib/store";
import { copyText } from "../lib/clipboard";
import { openMenu, type MenuEntry } from "../components/ContextMenu";
import type { ChatSession, ClaudeChatRef, ClaudeMessage, OutItem, PhoneStatus } from "../lib/types";
import { countSaid, stripPasted } from "../lib/pasted";
import { attachBlock, baseName, isImage, useAttachments } from "../lib/attach";

/** Terminals kept alive while you switch; the oldest detaches past this. */
const MAX_LIVE = 6;

// One listener for all terminals: output is routed to whichever pane owns the key.
type Sink = { data: (b: Uint8Array) => void; replay: (b: Uint8Array) => void; phone: (on: boolean) => void; exit: () => void };
const sinks = new Map<string, Sink>();
let listening = false;
function ensureListener() {
  if (listening || !inTauri) return;
  listening = true;
  void api.onPty((e) => {
    const s = sinks.get(e.key);
    if (!s) return;
    const bytes = () => Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
    if (e.kind === "exit") s.exit();
    else if (e.kind === "phone") s.phone(e.data === "on");
    else if (e.kind === "replay") s.replay(bytes());
    else s.data(bytes());
  });
}

const needsYou = (c: ChatSession) => c.running && (c.state === "blocked" || c.status === "waiting");

/** A chat only Hangar remembers: Claude Code has dropped it from `claude agents`. */
const ARCHIVED = "archived";

function light(c: ChatSession): string {
  if (!c.running) return "bg-faint/40";
  if (needsYou(c)) return "bg-warn";
  if (c.status === "busy" || c.status === "shell") return "bg-live animate-pulse";
  return "bg-live";
}

function ago(ms: number): string {
  if (!ms) return "";
  const m = Math.max(0, (Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** How a session opens as a terminal inside Hangar. Background jobs Claude Code still
 * knows reopen with attach (same session); older ones resume as a copy. */
function launch(c: ChatSession): { args: string[]; note?: string } {
  if (c.kind === "background" && c.state !== ARCHIVED) return { args: ["attach", c.id] };
  if (!c.running && c.session_id) return { args: ["--resume", c.session_id, "--permission-mode", "bypassPermissions"] };
  return { args: [], note: "This session runs in its own terminal or VS Code window, so Hangar can't attach to it. Switch to that window, or stop it there." };
}

const fromRef = (r: ClaudeChatRef): ChatSession => ({
  id: r.id, session_id: r.session_id, name: r.name, cwd: r.cwd, kind: "background",
  status: "", state: ARCHIVED, detail: "", updated: r.updated, running: false,
});

function TermPane({ c, visible, onExit }: { c: ChatSession; visible: boolean; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [ended, setEnded] = useState(false);
  const [phone, setPhone] = useState(false);
  const [gen, setGen] = useState(0);

  // Takes the size back from the phone (it sets it while it's watching).
  function fitHere() {
    if (!fit.current || !term.current) return;
    fit.current.fit();
    void api.ptyResize(c.id, term.current.cols, term.current.rows);
  }

  useEffect(() => {
    if (!host.current) return;
    ensureListener();
    setEnded(false);
    setPhone(false);
    const t = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: "#161a2e", foreground: "#ede9f7", cursor: "#f2c66d", selectionBackground: "#3a4170" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    f.fit();
    term.current = t;
    fit.current = f;
    const key = c.id;
    // While a replay (the phone's console, joined late) is being drawn, xterm's answers to any
    // terminal questions in it are not typed into Claude.
    let replaying = 0;
    sinks.set(key, {
      data: (b) => t.write(b),
      replay: (b) => {
        replaying++;
        t.write(b, () => void replaying--);
      },
      phone: setPhone,
      exit: () => setEnded(true),
    });
    const sub = t.onData((d) => {
      if (replaying === 0) void api.ptyWrite(key, d).catch(() => {});
    });
    const { args } = launch(c);
    void api.ptyOpen(key, "claude", args, c.cwd, t.cols, t.rows).catch((e) => t.write(`\r\n${errText(e)}\r\n`));
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return;
      f.fit();
      void api.ptyResize(key, t.cols, t.rows);
    });
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      sub.dispose();
      sinks.delete(key);
      void api.ptyClose(key);
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, gen]);

  useEffect(() => {
    if (visible && fit.current && term.current) {
      fit.current.fit();
      void api.ptyResize(c.id, term.current.cols, term.current.rows);
      term.current.focus();
    }
  }, [visible, c.id]);

  return (
    <div className={clsx("absolute inset-0 flex flex-col", !visible && "invisible pointer-events-none")}>
      {phone && !ended && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-line text-[12.5px] text-dim">
          <Smartphone size={13} className="shrink-0 text-gold" />
          <span className="flex-1">Also open on your phone. The phone sets the size while it's open.</span>
          <button onClick={fitHere} className="h-6 px-2 rounded-md bg-raise text-moon hover:text-gold">Fit here</button>
        </div>
      )}
      <div ref={host} className="flex-1 min-h-0 px-3 py-2" />
      {ended && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-line text-[13px] text-dim">
          <span className="flex-1">Detached. The session keeps running on its own.</span>
          <button onClick={() => setGen((g) => g + 1)} className="h-7 px-2.5 rounded-md bg-raise text-moon hover:text-gold">
            Attach again
          </button>
          <button onClick={onExit} className="h-7 px-2.5 rounded-md text-dim hover:text-moon">
            Close
          </button>
        </div>
      )}
    </div>
  );
}

type Block = { kind: "msg"; m: ClaudeMessage } | { kind: "tools"; lines: string[] };

/** Runs of tool calls fold into one "N steps" line so the replies stay readable. */
function blocks(msgs: ClaudeMessage[]): Block[] {
  const out: Block[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (m.role === "tool") {
      if (last?.kind === "tools") last.lines.push(m.text);
      else out.push({ kind: "tools", lines: [m.text] });
    } else out.push({ kind: "msg", m });
  }
  return out;
}

function Steps({ lines }: { lines: string[] }) {
  return (
    <details className="group text-[12.5px] text-faint">
      <summary className="cursor-pointer list-none flex items-center gap-1.5 hover:text-dim">
        <Wrench size={12} className="shrink-0" />
        <span className="truncate font-mono">{lines.length === 1 ? lines[0] : `${lines.length} steps · ${lines[lines.length - 1]}`}</span>
      </summary>
      {lines.length > 1 && (
        <ul className="mt-1 ml-5 space-y-0.5 font-mono">
          {lines.map((l, i) => (
            <li key={i} className="truncate">{l}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Bubble({ m, note }: { m: ClaudeMessage; note?: string }) {
  if (m.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-raise px-3.5 py-2.5 whitespace-pre-wrap">{stripPasted(m.text)}</div>
        {note && <span className="mt-1 text-[11.5px] text-faint">{note}</span>}
      </div>
    );
  }
  return (
    <div className="selectable md text-[14px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text}</ReactMarkdown>
    </div>
  );
}

const PASTE = (t: string) => `\x1b[200~${t}\x1b[201~`;

/** Files waiting to go with the next message, each removable. */
function AttachBar({ files, busy, onRemove }: { files: string[]; busy: boolean; onRemove: (p: string) => void }) {
  if (!files.length && !busy) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {files.map((p) => (
        <span key={p} title={p} className="flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-lg bg-raise text-[12.5px] max-w-[260px]">
          {isImage(p) ? <ImageIcon size={13} className="shrink-0 text-gold" /> : <FileText size={13} className="shrink-0 text-dim" />}
          <span className="truncate">{baseName(p)}</span>
          <button title="Remove" onClick={() => onRemove(p)} className="w-5 h-5 grid place-items-center rounded text-faint hover:text-bad">
            <X size={12} />
          </button>
        </span>
      ))}
      {busy && <span className="h-7 px-2 flex items-center text-[12.5px] text-dim">Adding…</span>}
    </div>
  );
}

/** Shown over a chat while files are dragged onto it. */
function DropHint() {
  return (
    <div className="absolute inset-2 z-20 rounded-2xl border-2 border-dashed border-gold bg-night/80 grid place-items-center pointer-events-none">
      <div className="flex items-center gap-2 text-gold text-[15px] font-medium">
        <Paperclip size={18} /> Drop to attach to your message
      </div>
    </div>
  );
}

// ---- Outbox: messages typed into a chat go in one at a time, in order, like typing ahead in
// the terminal. Claude Code queues any that arrive while Claude is busy.

let outSeq = 0;
const draining = new Set<string>();
const outOf = (id: string): OutItem[] => useStore.getState().outbox[id] ?? [];
function setOut(id: string, f: (items: OutItem[]) => OutItem[]) {
  useStore.setState((s) => {
    const next = f(s.outbox[id] ?? []);
    const outbox = { ...s.outbox };
    if (next.length) outbox[id] = next;
    else delete outbox[id];
    return { outbox };
  });
}
const patch = (id: string, key: number, p: Partial<OutItem>) => setOut(id, (xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

/** Sends a chat's waiting messages in order. Stops at a failure so nothing jumps the line. */
async function drain(c: ChatSession, termOpen: (id: string) => boolean, onMoved: (r: SentResult) => void) {
  if (draining.has(c.id)) return;
  draining.add(c.id);
  try {
    for (;;) {
      const next = outOf(c.id).find((x) => x.state === "waiting");
      if (!next) return;
      patch(c.id, next.key, { state: "sending", error: undefined });
      try {
        if (termOpen(c.id)) {
          // The Terminal tab already holds this session: type into it instead of taking it over.
          await api.ptyWrite(c.id, PASTE(next.text));
          await new Promise((r) => setTimeout(r, 400));
          await api.ptyWrite(c.id, "\r");
          patch(c.id, next.key, { state: "sent" });
          continue;
        }
        const r = await api.chatsSend(c.id, c.session_id, c.cwd, c.name, next.text);
        patch(c.id, next.key, { state: r.queued ? "queued" : "sent" });
        if (r.id !== c.id) {
          // The chat continued as a new session: carry the rest of its outbox over.
          const rest = outOf(c.id);
          setOut(c.id, () => []);
          setOut(r.id, (xs) => [...xs, ...rest]);
          onMoved(r);
          draining.delete(c.id);
          return void drain({ ...c, id: r.id, session_id: r.session_id }, termOpen, onMoved);
        }
      } catch (e) {
        patch(c.id, next.key, { state: "failed", error: errText(e) });
        return;
      }
    }
  } finally {
    draining.delete(c.id);
  }
}

const OUT_NOTE: Record<OutItem["state"], string> = {
  waiting: "Waiting for the message before it",
  sending: "Sending…",
  queued: "Queued: Claude reads it after its current step",
  sent: "Sent",
  failed: "Not sent",
};

/** The chat view of a session: its transcript as bubbles (live while it runs) and a box to reply. */
function ChatPane({ c, termOpen, onMoved, onTerminal }: { c: ChatSession; termOpen: (id: string) => boolean; onMoved: (r: SentResult) => void; onTerminal: () => void }) {
  const [msgs, setMsgs] = useState<ClaudeMessage[] | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState("");
  const att = useAttachments();
  const pending = useStore((s) => s.outbox[c.id]) ?? [];
  const stamp = useRef("");
  const end = useRef<HTMLDivElement>(null);

  // Mirror: re-read the transcript whenever it changes on disk, wherever the message was typed.
  useEffect(() => {
    stamp.current = "";
    setMsgs(null);
    setErr("");
    if (!c.session_id) return;
    let alive = true;
    async function tick() {
      try {
        const s = await api.sessionStamp(c.session_id, c.cwd);
        const key = s ? `${s[0]}:${s[1]}` : "none";
        if (key === stamp.current) return;
        stamp.current = key;
        if (!s) return void (alive && setMsgs([]));
        const conv = await api.sessionRead(c.session_id, c.cwd);
        if (alive) (setMsgs(conv.messages), setErr(""));
      } catch (e) {
        if (alive) setErr(errText(e));
      }
    }
    void tick();
    const t = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.session_id, c.cwd]);

  // A message leaves the outbox once the transcript has it (one more copy than when it was typed).
  // Pasted messages come back wrapped in <pasted_content> tags (lib/pasted.ts).
  const youSaid = (text: string) => countSaid(msgs ?? [], text);
  useEffect(() => {
    if (!msgs) return;
    setOut(c.id, (xs) => xs.filter((x) => x.state === "failed" || youSaid(x.text) <= x.seen));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, c.id]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs?.length, pending.length]);

  const readOnly = c.kind === "interactive";
  // Only an open dialog (status "waiting") needs the terminal. state "blocked" just means the
  // last reply asked you something, and the box below is how you answer it.
  const blocked = c.running && c.status === "waiting";
  const lastIsYou = pending.some((p) => p.state !== "failed") || msgs?.[msgs.length - 1]?.role === "user";
  const working = (c.running && c.status === "busy") || (lastIsYou && c.running);

  function send() {
    const text = attachBlock(draft, att.files);
    if (!text || readOnly || att.busy) return;
    setDraft("");
    att.clear();
    setOut(c.id, (xs) => [...xs, { key: ++outSeq, text, state: "waiting", seen: youSaid(text) }]);
    void drain(c, termOpen, onMoved);
  }

  function retry(key: number) {
    // Everything that was held back behind the failed message goes again, in order.
    setOut(c.id, (xs) => xs.map((x) => (x.key === key || x.state === "failed" ? { ...x, state: "waiting", error: undefined } : x)));
    void drain(c, termOpen, onMoved);
  }

  function edit(key: number) {
    const item = pending.find((x) => x.key === key);
    if (!item) return;
    setOut(c.id, (xs) => xs.filter((x) => x.key !== key));
    setDraft((d) => (d ? `${item.text}\n${d}` : item.text));
  }

  // Messages left waiting when Hangar or the view restarted pick up again here.
  useEffect(() => {
    if (pending.some((x) => x.state === "waiting")) void drain(c, termOpen, onMoved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  const canDrop = !readOnly && !blocked;
  return (
    <div className="absolute inset-0 flex flex-col" {...(canDrop ? att.dropProps : {})}>
      {canDrop && att.dragging && <DropHint />}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-5 space-y-4">
          {msgs === null && !err && <p className="text-dim text-[13.5px]">Loading the conversation…</p>}
          {err && <p className="text-dim text-[13.5px]">{err}</p>}
          {msgs?.length === 0 && pending.length === 0 && <p className="text-dim text-[13.5px]">No messages yet.</p>}
          {blocks(msgs ?? []).map((b, i) => (b.kind === "tools" ? <Steps key={i} lines={b.lines} /> : <Bubble key={i} m={b.m} />))}
          {pending.map((p) => (
            <div key={p.key} className={clsx(p.state === "failed" && "opacity-90")}>
              <Bubble m={{ role: "user", text: p.text, at: "" }} note={OUT_NOTE[p.state]} />
              {p.state === "failed" && (
                <div className="flex flex-col items-end gap-1.5 mt-1">
                  <span className="text-[12px] text-bad max-w-[85%] text-right">{p.error}</span>
                  <div className="flex gap-1.5 text-[12px]">
                    <button onClick={() => retry(p.key)} className="h-7 px-2.5 rounded-md bg-gold text-night font-medium">Retry</button>
                    <button onClick={() => edit(p.key)} className="h-7 px-2.5 rounded-md bg-raise text-moon hover:text-gold">Edit</button>
                    <button onClick={() => setOut(c.id, (xs) => xs.filter((x) => x.key !== p.key))} className="h-7 px-2.5 rounded-md text-dim hover:text-bad">Discard</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {working && !blocked && (
            <p className="flex items-center gap-2 text-[13px] text-dim">
              <span className="w-2 h-2 rounded-full bg-live animate-pulse" /> Claude is working…
            </p>
          )}
          <div ref={end} />
        </div>
      </div>
      <div className="border-t border-line px-6 py-3">
        <div className="max-w-3xl mx-auto">
          {readOnly ? (
            <p className="text-[13px] text-dim">This chat runs in VS Code or a terminal. Hangar shows it live; reply in that window.</p>
          ) : blocked ? (
            <div className="flex items-center gap-3 text-[13px]">
              <span className="flex-1 text-warn">Claude is asking you something. Answer it in the terminal.</span>
              <button onClick={onTerminal} className="h-8 px-3 rounded-lg bg-gold text-night font-medium">Open terminal</button>
            </div>
          ) : (
            <>
              <AttachBar files={att.files} busy={att.busy} onRemove={att.remove} />
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={att.onPaste}
                  onKeyDown={(e) => {
                    if (att.onKey(e)) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={Math.min(8, Math.max(1, draft.split("\n").length))}
                  placeholder={c.running ? "Message Claude (drop or paste files to attach)" : "Message Claude to pick this chat back up"}
                  className="flex-1 px-3 py-2 rounded-xl bg-night border border-line focus:outline-none focus:border-gold resize-none text-[14px]"
                />
                <button
                  title="Send (Enter)"
                  onClick={() => void send()}
                  disabled={(!draft.trim() && !att.files.length) || att.busy}
                  className="w-10 h-10 grid place-items-center rounded-xl bg-gold text-night disabled:opacity-40"
                >
                  <Send size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NewChat({ onDone }: { onDone: (id: string) => void }) {
  const { toast } = useStore();
  const [cwd, setCwd] = useState("");
  useEffect(() => void api.homeDir().then((h) => setCwd((c) => c || h)), []);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const att = useAttachments();
  async function start() {
    const text = attachBlock(prompt, att.files);
    if (!text || busy || att.busy) return;
    setBusy(true);
    try {
      const auto = (prompt.trim() || baseName(att.files[0] ?? "")).split("\n")[0].slice(0, 48).trim();
      onDone(await api.chatsNew(cwd, name.trim() || auto, text));
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="absolute inset-0 overflow-y-auto" {...att.dropProps}>
      {att.dragging && <DropHint />}
      <div className="max-w-2xl mx-auto px-6 pt-14 pb-8 space-y-4 text-[13.5px]">
        <h2 className="text-[22px] font-semibold">New chat</h2>
        <p className="text-dim">
          A real Claude Code session with all your tools and memory. It keeps running if you close Hangar, and VS Code can open it too (<span className="font-mono">claude agents</span>).
        </p>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if (att.onKey(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          rows={5}
          placeholder="What should Claude do? Drop or paste files to attach."
          className="w-full px-3.5 py-3 rounded-xl bg-night border border-line focus:outline-none focus:border-gold resize-none text-[14.5px]"
        />
        <AttachBar files={att.files} busy={att.busy} onRemove={att.remove} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 h-9 pl-2.5 pr-1 rounded-lg bg-night border border-line min-w-0 flex-1">
            <span className="text-faint shrink-0">Folder</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} className="flex-1 min-w-0 bg-transparent font-mono text-[12.5px] focus:outline-none" />
            <button
              title="Pick a folder"
              onClick={() => void pickFolder({ directory: true, defaultPath: cwd }).then((d) => typeof d === "string" && setCwd(d))}
              className="w-7 h-7 grid place-items-center rounded-md text-dim hover:text-moon hover:bg-raise"
            >
              <FolderOpen size={14} />
            </button>
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="w-44 h-9 px-2.5 rounded-lg bg-night border border-line focus:outline-none focus:border-gold" />
          <button onClick={() => void start()} disabled={busy || att.busy || (!prompt.trim() && !att.files.length)} className="h-9 px-4 rounded-lg bg-gold text-night font-medium disabled:opacity-40">
            {busy ? "Starting…" : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Phone access: one switch for a hidden `claude remote-control` server, so the Claude phone
 * app and claude.ai/code can start and drive sessions in one folder on this PC. */
function PhoneAccess() {
  const { toast, set } = useStore();
  const [st, setSt] = useState<PhoneStatus | null>(null);
  const [openBox, setOpenBox] = useState(false);
  const [cwd, setCwd] = useState("");
  useEffect(() => void api.homeDir().then((h) => setCwd((c) => c || h)), []);
  const [busy, setBusy] = useState(false);

  async function look() {
    try {
      setSt(await api.phoneStatus());
    } catch {
      setSt(null);
    }
  }
  useEffect(() => {
    void look();
    const t = setInterval(() => void look(), 10000);
    return () => clearInterval(t);
  }, []);

  async function turnOn() {
    setBusy(true);
    try {
      const s = await api.phoneStart(cwd.trim());
      setSt(s);
      toast(s.url ? "Phone access is on. In the Claude app, open Code and pick Hangar." : "Phone access is starting. The link shows up once it connects.", "ok");
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  function turnOff() {
    set({
      confirm: {
        title: "Turn phone access off?",
        body: "Sessions started from your phone or claude.ai stop with it. Their conversations are kept.",
        action: "Turn it off",
        danger: true,
        onYes: () =>
          void api
            .phoneStop()
            .then((s) => (setSt(s), toast("Phone access is off.", "ok")))
            .catch((e) => toast(errText(e), "bad")),
      },
    });
  }

  const on = !!st?.running;
  return (
    <div className="rounded-lg bg-night border border-line text-[13px]">
      <button onClick={() => setOpenBox((o) => !o)} className="w-full h-9 px-2.5 flex items-center gap-2 text-left">
        <Smartphone size={14} className={on ? "text-live" : "text-faint"} />
        <span className="flex-1">Phone access</span>
        <span className={clsx("flex items-center gap-1.5 text-[12px]", on ? "text-live" : "text-faint")}>
          <span className={clsx("w-1.5 h-1.5 rounded-full", on ? "bg-live" : "bg-faint/40")} />
          {busy ? "Starting…" : on ? "On" : "Off"}
        </span>
      </button>
      {openBox && (
        <div className="px-2.5 pb-2.5 space-y-2 text-dim">
          {on && st ? (
            <>
              <p>
                On in <span className="font-mono text-[12px] text-moon">{st.cwd}</span> since{" "}
                {new Date(st.started).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. In the Claude app, open Code and pick{" "}
                <span className="text-moon">Hangar</span>.
              </p>
              <div className="flex gap-2">
                {st.url && (
                  <button onClick={() => void api.openUrl(st.url)} className="h-7 px-2.5 rounded-md bg-raise text-moon hover:text-gold flex items-center gap-1.5">
                    <ExternalLink size={12} /> Open on the web
                  </button>
                )}
                <button onClick={turnOff} className="h-7 px-2.5 rounded-md text-dim hover:text-bad hover:bg-raise">
                  Turn off
                </button>
              </div>
            </>
          ) : (
            <>
              <p>Lets the Claude phone app and claude.ai/code start and drive Claude in this folder, from your account. It goes off when Hangar closes.</p>
              <div className="flex items-center gap-1 h-8 pl-2 pr-1 rounded-md border border-line">
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} className="flex-1 min-w-0 bg-transparent font-mono text-[12px] text-moon focus:outline-none" />
                <button
                  title="Pick a folder"
                  onClick={() => void pickFolder({ directory: true, defaultPath: cwd }).then((d) => typeof d === "string" && setCwd(d))}
                  className="w-6 h-6 grid place-items-center rounded text-dim hover:text-moon hover:bg-raise"
                >
                  <FolderOpen size={13} />
                </button>
              </div>
              <button onClick={() => void turnOn()} disabled={busy || !cwd.trim()} className="w-full h-8 rounded-md bg-gold text-night font-medium disabled:opacity-40">
                {busy ? "Connecting…" : "Turn on"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ c, active, open, onClick, menu }: { c: ChatSession; active: boolean; open: boolean; onClick: () => void; menu: () => MenuEntry[] }) {
  return (
    <button onClick={onClick} onContextMenu={(e) => openMenu(e, menu())} className={clsx("w-full text-left px-5 py-2 flex gap-2.5", active ? "bg-raise" : "hover:bg-raise/50")}>
      <span className={clsx("mt-1.5 w-2 h-2 rounded-full shrink-0", light(c))} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13.5px] text-moon">{c.name || c.id}</span>
          {open && <span className="text-[10.5px] text-gold">open</span>}
          <span className="ml-auto text-[11.5px] text-faint num shrink-0">{ago(c.updated)}</span>
        </span>
        <span className="block truncate text-[12px] text-dim">{c.detail || (c.kind === "interactive" ? "Terminal / VS Code session" : c.cwd)}</span>
      </span>
    </button>
  );
}

export function ChatsView() {
  const { toast, set, conversations, claudeChats, rememberChats, moveChat, forgetChat, deleteConv } = useStore();
  const [list, setList] = useState<ChatSession[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [q, setQ] = useState("");
  // Chat or Terminal, per session (Chat unless you picked Terminal).
  const [mode, setMode] = useState<Record<string, "chat" | "term">>({});
  // Opened terminals, most recent last.
  const [live, setLive] = useState<string[]>([]);
  // The outbox sends after this view may have moved on, so it asks for the current list.
  const liveRef = useRef(live);
  liveRef.current = live;

  // Opened from elsewhere (an embedded tool's "Open chat", a hangar://chat link): remember it, then show it.
  const chatFocus = useStore((s) => s.chatFocus);
  useEffect(() => {
    if (!chatFocus) return;
    const f = chatFocus;
    set({ chatFocus: null });
    if (f.session_id) rememberChats([{ id: f.id, session_id: f.session_id, name: f.name ?? "", cwd: f.cwd ?? "", updated: Date.now() }]);
    void refresh().then(() => select(f.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatFocus]);

  async function refresh() {
    try {
      const l = await api.chatsList(true);
      setList(l);
      set({ chatsWaiting: l.filter(needsYou).length });
      rememberChats(l.filter((c) => c.kind === "background" && c.session_id).map((c) => ({ id: c.id, session_id: c.session_id, name: c.name, cwd: c.cwd, updated: c.updated })));
    } catch (e) {
      toast(errText(e), "bad");
      setList([]);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Everything Claude Code lists, plus older chats only Hangar still remembers.
  const all = useMemo(() => {
    const l = list ?? [];
    const known = new Set(l.map((c) => c.session_id).filter(Boolean));
    return [...l, ...claudeChats.filter((r) => r.session_id && !known.has(r.session_id)).map(fromRef)];
  }, [list, claudeChats]);
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);

  const groups = useMemo(() => {
    const running = all.filter((c) => c.running);
    const needle = q.trim().toLowerCase();
    const past = all
      .filter((c) => !c.running && c.kind === "background")
      .filter((c) => !needle || `${c.name} ${c.cwd} ${c.detail}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updated - a.updated);
    return [
      { title: "Needs you", items: running.filter(needsYou) },
      { title: "Working", items: running.filter((c) => !needsYou(c) && c.status === "busy") },
      { title: "Idle", items: running.filter((c) => !needsYou(c) && c.status !== "busy") },
      { title: "Past chats", items: past, search: true },
    ];
  }, [all, q]);

  function openTerm(id: string) {
    setLive((prev) => [...prev.filter((x) => x !== id), id].slice(-MAX_LIVE));
  }

  function select(id: string) {
    setNewOpen(false);
    setSel(id);
    if (mode[id] === "term") openTerm(id);
  }

  function showMode(id: string, m: "chat" | "term") {
    setMode((prev) => ({ ...prev, [id]: m }));
    const c = byId.get(id);
    if (m === "term" && c && launch(c).args.length) openTerm(id);
  }

  function detach(id: string) {
    setLive((prev) => prev.filter((x) => x !== id));
  }

  function moved(oldId: string, r: SentResult) {
    const old = byId.get(oldId);
    moveChat(oldId, { id: r.id, session_id: r.session_id, name: old?.name ?? "", cwd: old?.cwd ?? "", updated: Date.now() });
    detach(oldId);
    setSel(r.id);
    void refresh();
  }

  const cur = sel ? byId.get(sel) : undefined;
  const curMode = cur ? (mode[cur.id] ?? "chat") : "chat";
  const curNote = cur && curMode === "term" ? launch(cur).note : undefined;

  function stop(c: ChatSession) {
    set({
      confirm: {
        title: `Stop "${c.name || c.id}"?`,
        body: "The session ends, but its conversation is kept. It stays under Past chats, and messaging it starts it again.",
        action: "Stop it",
        danger: true,
        onYes: () =>
          void api
            .chatsStop(c.id)
            .then(() => (detach(c.id), toast("Stopped. The conversation is kept.", "ok"), refresh()))
            .catch((e) => toast(errText(e), "bad")),
      },
    });
  }

  function done(c: ChatSession) {
    set({
      confirm: {
        title: `Done with "${c.name || c.id}"?`,
        body: `${c.running ? "Hangar stops it, then moves" : "Hangar moves"} its conversation into the chat archive (.claude\\chat-archive in your user folder) and takes it off this list. Nothing is deleted.`,
        action: "Archive it",
        onYes: () =>
          void api
            .chatsDone(c.id, c.session_id, c.cwd, c.name)
            .then((dest) => {
              detach(c.id);
              forgetChat(c.id);
              setSel(null);
              toast(dest ? "Archived. Nothing was deleted." : "Taken off the list (its files were already gone).", "ok");
              return refresh();
            })
            .catch((e) => toast(errText(e), "bad")),
      },
    });
  }

  /** Ends the session, everything it started and its claude.ai link, then archives it. */
  function closeFully(c: ChatSession) {
    set({
      closing: {
        id: c.id,
        session_id: c.session_id,
        name: c.name,
        cwd: c.cwd,
        onDone: () => {
          detach(c.id);
          if (sel === c.id) setSel(null);
          void refresh();
        },
      },
    });
  }

  const canClose = (c: ChatSession) => !!c.session_id && (c.kind === "background" || c.running);

  function chatMenu(c: ChatSession): MenuEntry[] {
    const bg = c.kind === "background";
    const fail = (e: unknown) => toast(errText(e), "bad");
    return [
      { label: "Open as chat", icon: MessageSquare, onClick: () => (select(c.id), showMode(c.id, "chat")) },
      launch(c).args.length > 0 && { label: "Open terminal", icon: SquareTerminal, onClick: () => (select(c.id), showMode(c.id, "term")) },
      bg && c.running && { label: "Open in Windows Terminal", icon: ExternalLink, onClick: () => void api.chatsOpenExternal(c.id, c.name).catch(fail) },
      live.includes(c.id) && { label: "Detach terminal", icon: Unplug, onClick: () => detach(c.id) },
      "-",
      {
        label: "Copy",
        icon: Copy,
        items: [
          { label: "Name", onClick: () => copyText(c.name || c.id, "Name copied") },
          c.session_id && { label: "Session id", hint: c.session_id.slice(0, 8), onClick: () => copyText(c.session_id, "Session id copied") },
          c.session_id && { label: "Resume command", onClick: () => copyText(`claude --resume ${c.session_id}`, "Resume command copied") },
          c.cwd && { label: "Folder path", onClick: () => copyText(c.cwd, "Folder copied") },
        ],
      },
      c.cwd && { label: "Show folder", icon: FolderOpen, onClick: () => void api.openFolder(c.cwd).catch(fail) },
      c.session_id && {
        label: "Show conversation file",
        icon: FileText,
        onClick: () =>
          void api
            .sessionPath(c.session_id, c.cwd)
            .then((p) => (p ? api.revealPath(p) : toast("Couldn't find this conversation's file.", "bad")))
            .catch(fail),
      },
      c.cwd && inTauri && { label: "Open folder in VS Code", icon: Code2, onClick: () => void invoke("vscode_open", { cwd: c.cwd }).catch(fail) },
      "-",
      bg && c.running && { label: "Stop (keep the conversation)", icon: Square, onClick: () => stop(c) },
      bg && { label: "Done: archive it", icon: Archive, onClick: () => done(c) },
      canClose(c) && { label: "Close completely…", icon: Power, danger: true, onClick: () => closeFully(c) },
    ];
  }

  return (
    <div className="h-full flex min-h-0">
      <div className="w-[340px] shrink-0 border-r border-line flex flex-col min-h-0">
        <header className="px-5 pt-8 pb-3 space-y-3">
          <div className="flex items-end gap-2">
            <h1 className="flex-1 text-[30px] leading-none font-semibold tracking-[-0.02em]" style={{ fontVariationSettings: '"wdth" 90' }}>
              Chats
            </h1>
            <button title="Look again" onClick={() => void refresh()} className="w-8 h-8 grid place-items-center rounded-lg text-dim hover:text-moon hover:bg-raise">
              <RefreshCw size={15} />
            </button>
          </div>
          <button
            onClick={() => (setNewOpen(true), setSel(null))}
            className={clsx("w-full h-9 rounded-lg flex items-center justify-center gap-2 font-medium text-[13.5px]", newOpen ? "bg-gold text-night" : "bg-raise text-moon hover:text-gold")}
          >
            <Plus size={15} /> New chat
          </button>
          <PhoneAccess />
          <p className="text-dim text-[13px] num">{list ? `${all.filter((c) => c.running).length} running · ${groups[3].items.length} past` : "Looking for chats…"}</p>
        </header>
        <div className="flex-1 overflow-y-auto pb-3">
          {groups.map((g) =>
            g.items.length || g.search ? (
              <section key={g.title} className="mb-2">
                <div className="px-5 py-1.5 text-[12px] text-faint sticky top-0 bg-night/95 backdrop-blur z-10">{g.title}</div>
                {g.search && (
                  <label className="mx-5 mb-1.5 flex items-center gap-2 h-8 px-2.5 rounded-lg bg-night border border-line text-[13px]">
                    <Search size={13} className="text-faint shrink-0" />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a past chat" className="flex-1 min-w-0 bg-transparent focus:outline-none" />
                  </label>
                )}
                {g.items.map((c) => (
                  <Row key={c.id} c={c} active={sel === c.id} open={live.includes(c.id)} onClick={() => select(c.id)} menu={() => chatMenu(c)} />
                ))}
                {g.search && !g.items.length && <p className="px-5 py-1 text-[12.5px] text-faint">{q ? "No match." : "Finished chats show up here."}</p>}
              </section>
            ) : null,
          )}
          {conversations.length > 0 && (
            <section className="mt-3">
              <div className="px-5 py-1.5 text-[12px] text-faint">Assistant chats</div>
              {conversations.slice(0, 8).map((cv) => (
                <button
                  key={cv.id}
                  onClick={() => set({ dockOpen: true, activeConv: cv.id, endpoint: cv.endpoint })}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: "Open in the assistant", icon: MessageSquare, onClick: () => set({ dockOpen: true, activeConv: cv.id, endpoint: cv.endpoint }) },
                      { label: "Copy title", icon: Copy, onClick: () => copyText(cv.title, "Title copied") },
                      "-",
                      {
                        label: "Delete chat",
                        icon: Trash2,
                        danger: true,
                        onClick: () =>
                          set({ confirm: { title: `Delete "${cv.title}"?`, body: "Takes this assistant chat out of Hangar. It only lived inside Hangar, so it can't be brought back.", action: "Delete it", danger: true, onYes: () => deleteConv(cv.id) } }),
                      },
                    ])
                  }
                  className="w-full text-left px-5 py-1.5 hover:bg-raise/50"
                >
                  <span className="block truncate text-[13px]">{cv.title}</span>
                  <span className="block truncate text-[11.5px] text-faint">{cv.model}</span>
                </button>
              ))}
            </section>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {cur && !newOpen && (
          <div className="flex items-center gap-2 px-4 h-11 border-b border-line shrink-0">
            <span className={clsx("w-2 h-2 rounded-full", light(cur))} />
            <span className="font-medium truncate">{cur.name || cur.id}</span>
            <span className="text-[12px] text-faint font-mono truncate">{cur.cwd}</span>
            <span className="flex-1" />
            <div className="flex rounded-lg bg-night border border-line p-0.5 text-[12.5px]">
              {(["chat", "term"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => showMode(cur.id, m)}
                  className={clsx("h-6 px-2 rounded-md flex items-center gap-1.5", curMode === m ? "bg-raise text-moon" : "text-dim hover:text-moon")}
                >
                  {m === "chat" ? <MessageSquare size={12} /> : <SquareTerminal size={12} />}
                  {m === "chat" ? "Chat" : "Terminal"}
                </button>
              ))}
            </div>
            {live.includes(cur.id) && (
              <button title="Detach the terminal (the session keeps running)" onClick={() => detach(cur.id)} className="h-7 px-2 rounded-md text-dim hover:text-moon hover:bg-raise flex items-center gap-1.5 text-[12.5px]">
                <Unplug size={13} /> Detach
              </button>
            )}
            {cur.kind === "background" && cur.running && (
              <button title="Open in Windows Terminal" onClick={() => void api.chatsOpenExternal(cur.id, cur.name).catch((e) => toast(errText(e), "bad"))} className="h-7 px-2 rounded-md text-dim hover:text-moon hover:bg-raise flex items-center gap-1.5 text-[12.5px]">
                <ExternalLink size={13} /> Window
              </button>
            )}
            {cur.kind === "background" && cur.running && (
              <button title="Stop the session (conversation kept)" onClick={() => stop(cur)} className="h-7 px-2 rounded-md text-dim hover:text-bad hover:bg-raise flex items-center gap-1.5 text-[12.5px]">
                <Square size={12} /> Stop
              </button>
            )}
            {cur.kind === "background" && (
              <button
                title="Finished with it: archive the conversation and take it off the list (nothing is deleted)"
                onClick={() => done(cur)}
                className="h-7 px-2 rounded-md text-dim hover:text-moon hover:bg-raise flex items-center gap-1.5 text-[12.5px]"
              >
                <Archive size={13} /> Done
              </button>
            )}
            {canClose(cur) && (
              <button
                title="Close completely: end the session, every process it started and its claude.ai link, then archive it"
                onClick={() => closeFully(cur)}
                className="h-7 px-2 rounded-md text-dim hover:text-bad hover:bg-raise flex items-center gap-1.5 text-[12.5px]"
              >
                <Power size={13} /> Close
              </button>
            )}
          </div>
        )}
        <div className="relative flex-1 min-h-0">
          {live.map((id) => {
            const c = byId.get(id);
            return c ? <TermPane key={id} c={c} visible={!newOpen && sel === id && (mode[id] ?? "chat") === "term"} onExit={() => detach(id)} /> : null;
          })}
          {newOpen && <NewChat onDone={(id) => void refresh().then(() => select(id))} />}
          {!newOpen && cur && curMode === "chat" && (
            <ChatPane key={cur.id} c={cur} termOpen={(id) => liveRef.current.includes(id)} onMoved={(r) => moved(cur.id, r)} onTerminal={() => showMode(cur.id, "term")} />
          )}
          {!newOpen && cur && curNote && <p className="p-6 text-dim text-[13.5px] max-w-lg">{curNote}</p>}
          {!newOpen && !cur && (
            <div className="p-8 text-dim text-[13.5px] max-w-lg space-y-2">
              <p className="text-moon text-[16px] font-medium">Pick a chat on the left, or start a new one.</p>
              <p>Every chat is a real Claude Code session. Hangar shows it as a conversation and keeps it in sync with VS Code and the terminal. Past chats stay in the list: open one to read it, type to pick it back up.</p>
              <p>Closing Hangar never stops a chat. Use Stop for that; the conversation is kept. Done archives a chat you're finished with. Close ends it completely, with everything it started.</p>
              <p>Right-click any chat for more.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
