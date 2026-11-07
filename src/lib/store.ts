import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ClaudeChatRef, Conversation, GpuStats, OutItem, Registry, RolesConfig, SysStats, Tool, ToolStatus, View } from "./types";
import type { InboxItem } from "./api";
import type { Brief } from "./brief";

export interface Endpoint {
  id: string;
  name: string;
  /** Label on the dock's switch. */
  short: string;
  /** OpenAI-compatible base URL (ending in /v1). */
  base: string;
  /** Registry tool that serves this endpoint, for the "Turn on" button. */
  toolId?: string;
  defaultModel: string;
}

export const ENDPOINTS: Endpoint[] = [
  { id: "ollama", name: "Ollama", short: "Ollama", base: "http://127.0.0.1:11434/v1", toolId: "ollama", defaultModel: "" },
  { id: "lmstudio", name: "LM Studio", short: "LM Studio", base: "http://127.0.0.1:1234/v1", toolId: "lmstudio", defaultModel: "" },
  { id: "kobold", name: "koboldcpp", short: "koboldcpp", base: "http://127.0.0.1:5001/v1", toolId: "koboldcpp", defaultModel: "" },
];

export interface CloseTarget {
  id: string;
  session_id: string;
  name: string;
  cwd: string;
  /** Called after it closed, e.g. to refresh a list. */
  onDone?: () => void;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "ok" | "bad";
}

interface Persisted {
  view: View;
  openTools: string[];
  toolPath: Record<string, string>;
  pinned: string[];
  recent: string[];
  dockOpen: boolean;
  dockWidth: number;
  /** Left sidebar (projects, open tools) shown. */
  railOpen: boolean;
  endpoint: string;
  models: Record<string, string>;
  /** Selected model job for Ollama chats. */
  role: string;
  ttsProvider: "kokoro" | "off";
  ttsVoice: Record<string, string>;
  autoSpeak: boolean;
  ttsSpeed: number;
  chime: boolean;
  chimeWaiting: boolean;
  popups: boolean;
  chimeStyle: "bell" | "marimba" | "glass";
  autoReadInbox: boolean;
  /** Bell cards show the full reply or Claude's short brief of it. */
  inboxView: "full" | "brief";
  /** What the play button, auto-read and the notification's Read aloud say for Claude Code replies. */
  readAloud: "full" | "brief";
  inboxSeenAt: number;
  conversations: Conversation[];
  activeConv: string | null;
  /** Claude Code chats seen in the Chats panel, newest first, so past ones stay reachable. */
  claudeChats: ClaudeChatRef[];
}

interface Live {
  registry: Registry | null;
  registryPath: string;
  registryError: string | null;
  /** Claude sessions waiting on you, for the Chats badge. */
  chatsWaiting: number;
  /** A chat to open in the Chats view (from a hangar://chat link or an embedded tool). */
  chatFocus: { id: string; session_id?: string; name?: string; cwd?: string } | null;
  /** Messages typed into Claude chats that are on their way in, per chat id. Kept here, not in
   * the chat view, so switching chats or pages never loses one. */
  outbox: Record<string, OutItem[]>;
  roles: RolesConfig | null;
  rolesPath: string;
  tokens: Record<string, string>;
  status: Record<string, ToolStatus>;
  starting: Record<string, number>;
  gpu: GpuStats | null;
  sys: SysStats | null;
  paletteOpen: boolean;
  procPanel: "cpu" | "ram" | "gpu" | null;
  inbox: InboxItem[];
  /** Short briefs of inbox replies by item id (lib/brief.ts). */
  briefs: Record<string, Brief>;
  inboxOpen: boolean;
  conversation: { sessionId: string; cwd?: string; title?: string } | null;
  editing: { tool: Tool | null; open: boolean };
  confirm: { title: string; body: string; action: string; onYes: () => void; danger?: boolean } | null;
  /** A Claude session to close completely (components/CloseSession.tsx). */
  closing: CloseTarget | null;
  toasts: Toast[];
}

interface Actions {
  set: (p: Partial<Persisted & Live>) => void;
  go: (v: View) => void;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  touchRecent: (id: string) => void;
  togglePin: (id: string) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  upsertConv: (c: Conversation) => void;
  deleteConv: (id: string) => void;
  /** Adds or refreshes chats; only writes when something changed. */
  rememberChats: (refs: ClaudeChatRef[]) => void;
  /** A chat that continued as a new session: replace the old entry. */
  moveChat: (oldId: string, ref: ClaudeChatRef) => void;
  /** Takes a chat off the list. Its transcript stays on disk. */
  forgetChat: (id: string) => void;
}

export type State = Persisted & Live & Actions;

let toastSeq = 0;

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      view: { type: "home" },
      openTools: [],
      toolPath: {},
      pinned: [],
      recent: [],
      dockOpen: false,
      dockWidth: 420,
      railOpen: true,
      endpoint: "ollama",
      models: {},
      role: "quick",
      ttsProvider: "kokoro",
      ttsVoice: { kokoro: "af_heart" },
      autoSpeak: false,
      ttsSpeed: 1,
      chime: true,
      chimeWaiting: true,
      popups: true,
      chimeStyle: "bell",
      autoReadInbox: false,
      inboxView: "full",
      readAloud: "full",
      inboxSeenAt: 0,
      conversations: [],
      claudeChats: [],
      activeConv: null,

      registry: null,
      registryPath: "",
      registryError: null,
      chatsWaiting: 0,
      chatFocus: null,
      outbox: {},
      roles: null,
      rolesPath: "",
      tokens: {},
      status: {},
      starting: {},
      gpu: null,
      sys: null,
      paletteOpen: false,
      procPanel: null,
      inbox: [],
      briefs: {},
      inboxOpen: false,
      conversation: null,
      editing: { tool: null, open: false },
      confirm: null,
      closing: null,
      toasts: [],

      set: (p) => set(p as Partial<State>),
      go: (view) => set({ view }),
      openTab: (id) => {
        const { openTools } = get();
        set({ openTools: openTools.includes(id) ? openTools : [...openTools, id], view: { type: "tool", id } });
        get().touchRecent(id);
      },
      closeTab: (id) => {
        const { openTools, view } = get();
        const idx = openTools.indexOf(id);
        const next = openTools.filter((t) => t !== id);
        let nextView = view;
        if (view.type === "tool" && view.id === id) {
          const neighbor = next[Math.min(idx, next.length - 1)];
          nextView = neighbor ? { type: "tool", id: neighbor } : { type: "home" };
        }
        set({ openTools: next, view: nextView });
      },
      touchRecent: (id) => set({ recent: [id, ...get().recent.filter((r) => r !== id)].slice(0, 12) }),
      togglePin: (id) => {
        const { pinned } = get();
        set({ pinned: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id] });
      },
      toast: (text, tone = "info") => {
        const id = ++toastSeq;
        set({ toasts: [...get().toasts, { id, text, tone }] });
        setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), tone === "bad" ? 7000 : 3500);
      },
      upsertConv: (c) => {
        const rest = get().conversations.filter((x) => x.id !== c.id);
        set({ conversations: [c, ...rest].slice(0, 40), activeConv: c.id });
      },
      deleteConv: (id) => {
        const { conversations, activeConv } = get();
        set({ conversations: conversations.filter((c) => c.id !== id), activeConv: activeConv === id ? null : activeConv });
      },
      rememberChats: (refs) => {
        const cur = get().claudeChats;
        const byId = new Map(cur.map((r) => [r.id, r]));
        let changed = false;
        for (const r of refs) {
          const old = byId.get(r.id);
          const next = { ...r, name: r.name || old?.name || "", session_id: r.session_id || old?.session_id || "" };
          if (!old || old.name !== next.name || old.session_id !== next.session_id || old.cwd !== next.cwd || old.updated !== next.updated) {
            byId.set(r.id, next);
            changed = true;
          }
        }
        if (changed) set({ claudeChats: [...byId.values()].sort((a, b) => b.updated - a.updated).slice(0, 300) });
      },
      moveChat: (oldId, ref) => set({ claudeChats: [ref, ...get().claudeChats.filter((r) => r.id !== oldId && r.id !== ref.id)] }),
      forgetChat: (id) => set({ claudeChats: get().claudeChats.filter((r) => r.id !== id) }),
    }),
    {
      name: "hangar",
      version: 1,
      partialize: (s): Persisted => ({
        view: s.view,
        openTools: s.openTools,
        toolPath: s.toolPath,
        pinned: s.pinned,
        recent: s.recent,
        dockOpen: s.dockOpen,
        dockWidth: s.dockWidth,
        railOpen: s.railOpen,
        endpoint: s.endpoint,
        models: s.models,
        role: s.role,
        ttsProvider: s.ttsProvider,
        ttsVoice: s.ttsVoice,
        autoSpeak: s.autoSpeak,
        ttsSpeed: s.ttsSpeed,
        chime: s.chime,
        chimeWaiting: s.chimeWaiting,
        popups: s.popups,
        chimeStyle: s.chimeStyle,
        autoReadInbox: s.autoReadInbox,
        inboxView: s.inboxView,
        readAloud: s.readAloud,
        inboxSeenAt: s.inboxSeenAt,
        conversations: s.conversations,
        activeConv: s.activeConv,
        claudeChats: s.claudeChats,
      }),
    },
  ),
);

export const toolById = (s: State, id: string): Tool | undefined => s.registry?.tools.find((t) => t.id === id);
