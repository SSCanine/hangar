import clsx from "clsx";
import { Code2, Copy, RefreshCw, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdComponents } from "../lib/markdown";
import { invoke } from "@tauri-apps/api/core";
import { api, errText } from "../lib/api";
import { useStore } from "../lib/store";
import { SpeakButton } from "./InboxPanel";

interface Message {
  role: "user" | "assistant";
  text: string;
  at: string;
}

interface Conversation {
  session_id: string;
  title: string;
  cwd: string;
  path: string;
  modified: number;
  total: number;
  messages: Message[];
}

function ago(secs: number): string {
  const s = Date.now() / 1000 - secs;
  if (s < 90) return "active just now";
  if (s < 3600) return `last active ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `last active ${Math.round(s / 3600)} h ago`;
  return `last active ${new Date(secs * 1000).toLocaleDateString()}`;
}

function time(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConversationModal() {
  const target = useStore((s) => s.conversation);
  const { set, toast } = useStore.getState();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  async function load() {
    if (!target) return;
    setError(null);
    try {
      const c = await invoke<Conversation>("session_read", { sessionId: target.sessionId, cwd: target.cwd ?? "", limit: 400 });
      setConv(c);
    } catch (e) {
      setError(errText(e));
    }
  }

  useEffect(() => {
    setConv(null);
    if (target) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conv]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ conversation: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, set]);

  if (!target) return null;
  const close = () => set({ conversation: null });
  const title = conv?.title || target.title || "Claude conversation";
  const cwd = conv?.cwd || target.cwd || "";
  const resumeCmd = `cd /d "${cwd}" && claude --resume ${target.sessionId}`;

  return (
    <div className="fixed inset-0 z-50 bg-night/75 backdrop-blur-[2px] grid place-items-center p-6" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[980px] max-w-full h-[88vh] flex flex-col rounded-2xl border border-line bg-panel shadow-[0_30px_100px_-20px_rgba(0,0,0,.8)] overflow-hidden"
      >
        <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-line">
          <div className="flex-1 min-w-0">
            <h2 className="text-[22px] font-semibold leading-tight truncate">{title}</h2>
            <p className="text-[12.5px] text-faint mt-1 truncate selectable">
              {cwd}
              {conv && <span className="ml-2">{ago(conv.modified)}, {conv.total} messages</span>}
            </p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              <button
                onClick={() =>
                  invoke("session_resume", { sessionId: target.sessionId, cwd, title })
                    .then(() => toast("Opening the conversation in a terminal", "ok"))
                    .catch((e) => toast(errText(e), "bad"))
                }
                title="New Windows Terminal tab with claude --resume. If it is still open in VS Code, use Show VS Code instead."
                className="h-8 px-3 rounded-lg bg-gold text-night font-medium text-[13px] flex items-center gap-1.5"
              >
                <TerminalSquare size={14} /> Resume in terminal
              </button>
              <button
                onClick={() => invoke("vscode_open", { cwd }).catch((e) => toast(errText(e), "bad"))}
                className="h-8 px-3 rounded-lg bg-raise hover:bg-line text-[13px] flex items-center gap-1.5"
              >
                <Code2 size={14} /> Show VS Code
              </button>
              <button
                onClick={() => api.clipboardSet(resumeCmd).then(() => toast("Resume command copied", "ok"), (e) => toast(errText(e), "bad"))}
                className="h-8 px-3 rounded-lg bg-raise hover:bg-line text-[13px] flex items-center gap-1.5"
              >
                <Copy size={13} /> Copy resume command
              </button>
            </div>
          </div>
          <button title="Read again" onClick={() => void load()} className="w-8 h-8 grid place-items-center rounded-lg text-dim hover:text-moon hover:bg-raise">
            <RefreshCw size={15} />
          </button>
          <button title="Close (Esc)" onClick={close} className="w-8 h-8 grid place-items-center rounded-lg text-dim hover:text-moon hover:bg-raise">
            <X size={17} />
          </button>
        </header>

        <div ref={listRef} className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-5 space-y-4">
          {error && <p className="text-bad">{error}</p>}
          {!conv && !error && <p className="text-dim">Reading the conversation…</p>}
          {conv && conv.total > conv.messages.length && (
            <p className="text-[12px] text-faint text-center">Showing the last {conv.messages.length} of {conv.total} messages.</p>
          )}
          {conv?.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[78%]">
                  <div className="selectable rounded-2xl rounded-br-md bg-raise px-4 py-2.5 whitespace-pre-wrap text-[14px] [overflow-wrap:anywhere]">{m.text}</div>
                  <div className="text-[11px] text-faint text-right mt-1">{time(m.at)}</div>
                </div>
              </div>
            ) : (
              <div key={i} className={clsx("flex gap-2", i === conv.messages.length - 1 && "rounded-xl bg-gold/[0.04] -mx-3 px-3 py-2")}>
                <div className="flex-1 min-w-0">
                  <div className="md selectable text-[14px] leading-relaxed [overflow-wrap:anywhere]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text}</ReactMarkdown>
                  </div>
                  <div className="text-[11px] text-faint mt-1">{time(m.at)}</div>
                </div>
                <div className="shrink-0 pt-0.5">
                  <SpeakButton id={`conv:${target.sessionId}:${i}`} text={m.text} />
                </div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
