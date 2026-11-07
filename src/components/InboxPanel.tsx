import clsx from "clsx";
import { Copy, FileText, FolderOpen, Loader2, MessagesSquare, Play, Power, Settings, Square, Trash2 } from "lucide-react";
import { openMenu } from "./ContextMenu";
import { copyText } from "../lib/clipboard";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdComponents } from "../lib/markdown";
import { api, errText, type InboxItem } from "../lib/api";
import { getBrief, readInbox } from "../lib/brief";
import { onSpeech, speak } from "../lib/speech";
import { useStore } from "../lib/store";

function ago(at: number): string {
  const s = Date.now() / 1000 - at;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Play / stop / loading button for one message. `play` replaces reading `text` (it may need to fetch first). */
export function SpeakButton({ id, text, size = 14, play }: { id: string; text: string; size?: number; play?: () => Promise<void> }) {
  const [state, setState] = useState<{ key: string | null; loading: boolean }>({ key: null, loading: false });
  const [preparing, setPreparing] = useState(false);
  useEffect(() => onSpeech((key, loading) => setState({ key, loading })), []);
  const mine = state.key === id;
  const spinning = (mine && state.loading) || (preparing && !mine);
  return (
    <button
      title={mine ? "Stop reading" : "Read it aloud"}
      aria-label={mine ? "Stop reading" : "Read it aloud"}
      onClick={(e) => {
        e.stopPropagation();
        if (!play) return void speak(id, text);
        setPreparing(true);
        void play().finally(() => setPreparing(false));
      }}
      className={clsx("w-7 h-7 grid place-items-center rounded-md transition-colors", mine ? "bg-gold text-night" : "text-dim hover:text-moon hover:bg-line")}
    >
      {spinning ? <Loader2 size={size} className="animate-spin" /> : mine ? <Square size={size - 2} /> : <Play size={size} />}
    </button>
  );
}

/** Full / Brief switch. */
function ViewSwitch({ value, onChange, small }: { value: "full" | "brief"; onChange: (v: "full" | "brief") => void; small?: boolean }) {
  return (
    <span className={clsx("inline-flex rounded-md bg-night/60 border border-line p-0.5 shrink-0", small ? "text-[11px]" : "text-[12px]")}>
      {(["brief", "full"] as const).map((v) => (
        <button
          key={v}
          onClick={(e) => {
            e.stopPropagation();
            onChange(v);
          }}
          title={v === "brief" ? "A few sentences on what you need to know" : "The whole reply"}
          className={clsx("rounded px-1.5 leading-[18px] transition-colors", value === v ? "bg-raise text-moon" : "text-faint hover:text-moon")}
        >
          {v === "brief" ? "Brief" : "Full"}
        </button>
      ))}
    </span>
  );
}

/** A reply's brief; asks for it once the card scrolls into view. */
function BriefText({ item }: { item: InboxItem }) {
  const brief = useStore((s) => s.briefs[item.id]);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (brief || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void getBrief(item);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [item, brief]);
  if (!brief)
    return (
      <p ref={ref} className="text-[13px] text-faint mt-1 flex items-center gap-1.5">
        <Loader2 size={12} className="animate-spin" /> Making a brief...
      </p>
    );
  return (
    <p ref={ref} className="text-[13.5px] text-moon/90 mt-1 leading-relaxed selectable">
      {brief.t}
      {brief.fb && (
        <span className="ml-1.5 text-[11.5px] text-faint" title="No local model answered, so this is cut from the reply itself. It is redone next time.">
          (quick cut)
        </span>
      )}
    </p>
  );
}

export function InboxPanel() {
  const open = useStore((s) => s.inboxOpen);
  const items = useStore((s) => s.inbox);
  const seenAt = useStore((s) => s.inboxSeenAt);
  const view = useStore((s) => s.inboxView);
  const { set, toast } = useStore.getState();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Cards flipped away from the panel's Brief / Full setting.
  const [flipped, setFlipped] = useState<Record<string, "full" | "brief">>({});

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ inboxOpen: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, set]);

  if (!open) return null;
  const list = [...items].reverse();
  const unread = list.filter((i) => i.at > seenAt).length;

  function markRead() {
    const newest = items.length ? items[items.length - 1].at : Date.now() / 1000;
    set({ inboxSeenAt: newest });
  }

  function clearAll() {
    set({
      confirm: {
        title: "Clear all messages?",
        body: `The ${items.length} saved messages go to the Recycle Bin as one file (inbox.jsonl). New replies keep arriving.`,
        action: "Clear messages",
        danger: true,
        onYes: async () => {
          try {
            await api.inboxClear();
            set({ inbox: [] });
            toast("Messages cleared", "ok");
          } catch (e) {
            toast(errText(e), "bad");
          }
        },
      },
    });
  }

  return (
    <div className="fixed inset-0 z-40" onMouseDown={() => set({ inboxOpen: false })}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-12 right-28 w-[560px] max-w-[calc(100vw-24px)] max-h-[76vh] flex flex-col rounded-2xl border border-line bg-panel shadow-[0_24px_80px_-20px_rgba(0,0,0,.75)] overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-line shrink-0">
          <span className="font-medium flex-1">
            Messages from Claude
            {unread > 0 && <span className="ml-2 text-[12px] text-gold num">{unread} new</span>}
          </span>
          <span className="text-[12px] text-faint">Show</span>
          <ViewSwitch
            value={view}
            onChange={(v) => {
              set({ inboxView: v });
              setFlipped({});
            }}
          />
          <button onClick={markRead} className="h-7 px-2.5 rounded-md text-[12.5px] text-dim hover:text-moon hover:bg-raise">
            Mark all read
          </button>
          <button title="Clear all" onClick={clearAll} className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-bad hover:bg-bad/10">
            <Trash2 size={14} />
          </button>
          <button
            title="Chime and voice settings"
            onClick={() => set({ inboxOpen: false, view: { type: "settings" } })}
            className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-moon hover:bg-raise"
          >
            <Settings size={14} />
          </button>
        </div>
        <div className="overflow-y-auto">
          {list.length === 0 && (
            <p className="px-5 py-8 text-dim text-[13.5px] text-center">
              Nothing yet. When a Claude Code session finishes a reply or needs you, it shows up here with a chime.
            </p>
          )}
          {list.map((m: InboxItem) => {
            const isNew = m.at > seenAt;
            const isOpen = expanded === m.id;
            const cardView = flipped[m.id] ?? view;
            return (
              <div key={m.id} className={clsx("border-b border-line/60 last:border-b-0", isNew && "bg-gold/[0.04]")}>
                <div
                  onClick={() => {
                    // A brief opens into the whole reply; a full card folds open and shut.
                    if (cardView === "brief") {
                      setFlipped((f) => ({ ...f, [m.id]: "full" }));
                      setExpanded(m.id);
                    } else setExpanded(isOpen ? null : m.id);
                  }}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: "Read aloud", icon: Play, onClick: () => void readInbox(m) },
                      m.session_id && { label: "Open the conversation", icon: MessagesSquare, onClick: () => set({ inboxOpen: false, conversation: { sessionId: m.session_id, cwd: m.cwd, title: m.title } }) },
                      m.session_id && { label: "Open in Chats", icon: MessagesSquare, onClick: () => set({ inboxOpen: false, view: { type: "chats" }, chatFocus: { id: m.session_id.slice(0, 8), session_id: m.session_id, name: m.title, cwd: m.cwd } }) },
                      "-",
                      { label: "Copy reply", icon: Copy, onClick: () => copyText(m.text, "Copied") },
                      m.cwd && { label: "Show folder", icon: FolderOpen, onClick: () => void api.openFolder(m.cwd).catch((er) => toast(errText(er), "bad")) },
                      m.session_id && {
                        label: "Show conversation file",
                        icon: FileText,
                        onClick: () => void api.sessionPath(m.session_id, m.cwd).then((p) => (p ? api.revealPath(p) : toast("Couldn't find this conversation's file.", "bad"))).catch((er) => toast(errText(er), "bad")),
                      },
                      "-",
                      m.session_id && {
                        label: "Close session completely…",
                        icon: Power,
                        danger: true,
                        onClick: () => set({ inboxOpen: false, closing: { id: "", session_id: m.session_id, name: m.title || m.project || "", cwd: m.cwd } }),
                      },
                    ])
                  }
                  className="flex items-start gap-3 px-4 py-3 cursor-default hover:bg-raise/40">
                  <span className={clsx("mt-1.5 w-2 h-2 rounded-full shrink-0", isNew ? "bg-gold" : "bg-transparent")} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 text-[12.5px]">
                      <span className="font-medium text-moon truncate max-w-[260px]" title={m.cwd}>{m.title || m.project || "Claude"}</span>
                      <span className={m.kind === "waiting" ? "text-warn" : "text-live/90"}>{m.kind === "waiting" ? "Waiting for you" : "Done"}</span>
                      <span className="text-faint ml-auto shrink-0">{ago(m.at)}</span>
                      {m.kind === "done" && <ViewSwitch small value={cardView} onChange={(v) => setFlipped((f) => ({ ...f, [m.id]: v }))} />}
                    </div>
                    {cardView === "brief" && m.kind === "done" ? (
                      <BriefText item={m} />
                    ) : isOpen ? (
                      <div className="md text-[13.5px] leading-relaxed mt-1.5 selectable">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-[13px] text-dim mt-0.5 line-clamp-3 whitespace-pre-line">{m.text.slice(0, 600)}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <SpeakButton id={`inbox:${m.id}`} text={m.text} play={() => readInbox(m)} />
                    {m.session_id && (
                      <button
                        title="Open the conversation"
                        onClick={(e) => {
                          e.stopPropagation();
                          set({ inboxOpen: false, conversation: { sessionId: m.session_id, cwd: m.cwd, title: m.title } });
                        }}
                        className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-moon hover:bg-line"
                      >
                        <MessagesSquare size={13} />
                      </button>
                    )}
                    <button
                      title="Copy"
                      onClick={(e) => {
                        e.stopPropagation();
                        api.clipboardSet(m.text).then(() => toast("Copied", "ok"), (er) => toast(errText(er), "bad"));
                      }}
                      className="w-7 h-7 grid place-items-center rounded-md text-faint hover:text-moon hover:bg-line"
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
