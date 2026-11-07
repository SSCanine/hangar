import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { Rail } from "./components/Rail";
import { CommandPalette } from "./components/CommandPalette";
import { ProcessPanel } from "./components/ProcessPanel";
import { AssistantDock } from "./components/AssistantDock";
import { ToolEditor } from "./components/ToolEditor";
import { ConfirmDialog, Toasts } from "./components/Overlays";
import { ContextMenu } from "./components/ContextMenu";
import { CloseSession } from "./components/CloseSession";
import { HomeView } from "./views/HomeView";
import { ThemeView } from "./views/ThemeView";
import { ProjectsView } from "./views/ProjectsView";
import { SettingsView } from "./views/SettingsView";
import { SystemView } from "./views/SystemView";
import { ChatsView } from "./views/ChatsView";
import { InboxPanel } from "./components/InboxPanel";
import { ConversationModal } from "./components/ConversationModal";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "./lib/api";
import { getBrief, readInbox } from "./lib/brief";
import { ToolHost } from "./views/ToolHost";
import { api } from "./lib/api";
import { refreshRegistry, refreshStatus } from "./lib/actions";
import { useStore } from "./lib/store";
import { pushMachine } from "./lib/sysHistory";

function usePolling() {
  const starting = useStore((s) => Object.keys(s.starting).length > 0);
  useEffect(() => {
    void refreshRegistry().then(refreshStatus);
  }, []);
  useEffect(() => {
    const t = setInterval(refreshStatus, starting ? 1500 : 5000);
    return () => clearInterval(t);
  }, [starting]);
  useEffect(() => {
    const tick = () => {
      api.gpu().then((gpu) => useStore.getState().set({ gpu })).catch(() => {});
      api
        .sys()
        .then((sys) => {
          const s = useStore.getState();
          s.set({ sys });
          pushMachine(sys, s.gpu);
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);
}

/** Messages from Claude Code sessions (hooks/hangar_notify.py writes them). */
function useInbox() {
  useEffect(() => {
    let sig: string | null = null;
    let lastAt = 0;
    let first = true;
    const tick = async () => {
      const res = await api.inboxRead(sig).catch(() => null);
      if (!res) return;
      sig = res.sig;
      if (!res.items) return;
      const s = useStore.getState();
      s.set({ inbox: res.items });
      const newest = res.items.length ? res.items[res.items.length - 1] : null;
      if (!first && (s.inboxView === "brief" || s.readAloud === "brief")) {
        // Brief in use: make it while the chime plays, so the bell and the voice have it ready.
        for (const m of res.items) if (m.at > lastAt && m.kind === "done") void getBrief(m);
      }
      if (newest && !first && newest.at > lastAt && s.autoReadInbox && newest.kind === "done") {
        void readInbox(newest);
      }
      lastAt = newest?.at ?? lastAt;
      first = false;
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);
  // Keep the hook's chime settings file in step with the store, from the start.
  const chime = useStore((s) => s.chime);
  const chimeWaiting = useStore((s) => s.chimeWaiting);
  const style = useStore((s) => s.chimeStyle);
  const popups = useStore((s) => s.popups);
  useEffect(() => {
    void api.notifySettings({ chime, chime_waiting: chimeWaiting, style, toast: popups }).catch(() => {});
  }, [chime, chimeWaiting, style, popups]);
}

/** Embedded tools ask Hangar to open a Claude chat, or to show the "Close completely" dialog for
 * one. Only pages served from a registered embedded tool's address are listened to; closing still
 * waits for your click in Hangar's own dialog. */
function useToolMessages() {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: unknown; session_id?: unknown; name?: unknown; cwd?: unknown } | null;
      if (!d || (d.type !== "hangar:open-chat" && d.type !== "hangar:close-chat") || typeof d.id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(d.id)) return;
      const s = useStore.getState();
      const embedded = (s.registry?.tools ?? []).filter((t) => t.embed && t.url).map((t) => {
        try {
          return new URL(t.url!).origin;
        } catch {
          return "";
        }
      });
      if (!embedded.includes(e.origin)) return;
      const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : undefined);
      if (d.type === "hangar:close-chat") {
        const sid = str(d.session_id) ?? "";
        if (!/^[0-9a-f-]{8,64}$/i.test(sid)) return;
        return s.set({ closing: { id: d.id, session_id: sid, name: str(d.name) ?? "", cwd: str(d.cwd) ?? "" } });
      }
      s.set({ chatFocus: { id: d.id, session_id: str(d.session_id), name: str(d.name), cwd: str(d.cwd) }, view: { type: "chats" } });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
}

/** hangar:// links from Windows notifications: open a conversation or read a message aloud. */
function useLinks() {
  useEffect(() => {
    if (!inTauri) return;
    const handle = async (raw: string | null) => {
      if (!raw) return;
      await invoke("take_pending_url").catch(() => null); // consumed
      let u: URL;
      try {
        u = new URL(raw.replace(/^hangar:\/\//, "http://hangar/"));
      } catch {
        return;
      }
      const [kind, id] = u.pathname.split("/").filter(Boolean);
      const s = useStore.getState();
      if (kind === "chat" && id) {
        const q = u.searchParams;
        s.set({ chatFocus: { id: decodeURIComponent(id), session_id: q.get("session") ?? undefined, cwd: q.get("cwd") ?? undefined, name: q.get("name") ?? undefined }, view: { type: "chats" } });
      } else if (kind === "session" && id) {
        const itemId = u.searchParams.get("item");
        const item = s.inbox.find((m) => m.id === itemId);
        s.set({ inboxOpen: false, conversation: { sessionId: decodeURIComponent(id), cwd: u.searchParams.get("cwd") ?? item?.cwd, title: item?.title } });
        if (item && item.at > s.inboxSeenAt) s.set({ inboxSeenAt: item.at });
      } else if (kind === "read" && id) {
        // The inbox may still be loading right after a cold start.
        for (let i = 0; i < 20; i++) {
          const item = useStore.getState().inbox.find((m) => m.id === id);
          if (item) return void readInbox(item);
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };
    void invoke<string | null>("take_pending_url").then(handle);
    const un = listen<string>("hangar://open-url", (e) => void handle(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.set({ paletteOpen: !s.paletteOpen });
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.set({ dockOpen: !s.dockOpen });
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        s.set({ railOpen: !s.railOpen });
      } else if (mod && e.key.toLowerCase() === "w" && s.view.type === "tool") {
        e.preventDefault();
        s.closeTab(s.view.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  usePolling();
  useShortcuts();
  useInbox();
  useLinks();
  useToolMessages();
  const view = useStore((s) => s.view);
  const dockOpen = useStore((s) => s.dockOpen);
  const railOpen = useStore((s) => s.railOpen);
  const registry = useStore((s) => s.registry);
  const registryError = useStore((s) => s.registryError);
  const registryPath = useStore((s) => s.registryPath);

  return (
    <div className="h-full flex flex-col">
      <TitleBar />
      <div className="flex-1 flex min-h-0">
        {railOpen && <Rail />}
        <main className="relative flex-1 min-w-0">
          {registryError && (
            <div className="m-6 rounded-xl border border-bad/40 bg-bad/10 p-4">
              <p className="font-medium">The tool list didn't load.</p>
              <p className="text-dim mt-1 selectable">{registryError}</p>
              <p className="text-dim mt-1">Fix the file, then press Ctrl K and choose “Reload the tool list”.</p>
            </div>
          )}
          {registry && view.type === "home" && <HomeView />}
          {registry && view.type === "theme" && <ThemeView id={view.id} />}
          {view.type === "projects" && <ProjectsView />}
          {view.type === "settings" && <SettingsView />}
          {view.type === "system" && <SystemView />}
          {view.type === "chats" && <ChatsView />}
          <ToolHost />
          {registry && view.type === "tool" && !registry.tools.some((t) => t.id === view.id) && (
            <div className="p-10 text-dim">That tool isn't in the tool list ({registryPath}).</div>
          )}
        </main>
        {dockOpen && <AssistantDock />}
      </div>
      <CommandPalette />
      <ProcessPanel />
      <InboxPanel />
      <ConversationModal />
      <ToolEditor />
      <CloseSession />
      <ConfirmDialog />
      <ContextMenu />
      <Toasts />
    </div>
  );
}
