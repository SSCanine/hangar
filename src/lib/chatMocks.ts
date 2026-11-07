// Sample chats for previewing the Chats view in a plain browser (Vite dev, no Tauri).
import type { InboxItem } from "./api";
import type { ChatSession, ClaudeConversation } from "./types";

export function mockChats(): ChatSession[] {
  const now = Date.now();
  return [
    {
      id: "a1b2c3d4", session_id: "a1b2c3d4-0000-4000-8000-000000000001", name: "notes app search", cwd: "D:\\Projects\\notes-app",
      kind: "background", status: "busy", state: "working", detail: "Adding the search box", updated: now - 60_000, running: true,
    },
    {
      id: "e5f6a7b8", session_id: "e5f6a7b8-0000-4000-8000-000000000002", name: "dashboard charts", cwd: "D:\\Projects\\dashboard",
      kind: "background", status: "", state: "done", detail: "Shipped the new charts", updated: now - 3 * 3_600_000, running: false,
    },
    {
      id: "c9d0e1f2", session_id: "c9d0e1f2-0000-4000-8000-000000000003", name: "VS Code session", cwd: "D:\\Projects",
      kind: "interactive", status: "idle", state: "", detail: "", updated: now - 600_000, running: true,
    },
  ];
}

export function mockConversation(sessionId: string): ClaudeConversation {
  return {
    session_id: sessionId, title: "", cwd: "D:\\Projects\\notes-app", path: "", modified: 0, total: 6,
    messages: [
      { role: "user", text: "Can the notes list get a search box?", at: "" },
      { role: "assistant", text: "Yes. Let me look at how the list is built first.", at: "" },
      { role: "tool", text: "Read: D:\\Projects\\notes-app\\src\\NotesList.tsx", at: "" },
      { role: "tool", text: "Grep: filterNotes", at: "" },
      { role: "tool", text: "Bash: npm test", at: "" },
      { role: "assistant", text: "Done. The list now has a search box:\n\n- type to filter by title or text\n- Esc clears it\n- the tests pass", at: "" },
    ],
  };
}

/** Sample bell messages for previewing the inbox in a plain browser. */
export function mockInbox(): InboxItem[] {
  const now = Date.now() / 1000;
  return [
    {
      id: "m1", at: now - 7200, kind: "done", session_id: "a1b2c3d4-0000-4000-8000-000000000001", cwd: "D:\\Projects\\notes-app", project: "notes-app",
      title: "notes app search",
      text: "The search box is in and merged.\n\n**What changed**\n- The list filters as you type\n- Esc clears the search\n\nI ran the tests and they pass.\n\nresult: Notes now has search; restart the app to get it.",
    },
    {
      id: "m2", at: now - 600, kind: "waiting", session_id: "e5f6a7b8-0000-4000-8000-000000000002", cwd: "D:\\Projects\\dashboard", project: "dashboard",
      title: "dashboard charts", text: "Claude needs your permission to use Bash",
    },
    {
      id: "m3", at: now - 60, kind: "done", session_id: "c9d0e1f2-0000-4000-8000-000000000003", cwd: "D:\\Projects", project: "Projects",
      title: "old build cleanup",
      text: "Nothing has been deleted yet; I need one yes from you first.\n\n**1. Old builds**\n- 14 build folders are older than a month, 4.1 GB in all.\n- They would go to the Recycle Bin.\n\n**2. Logs**\nThe log folder is 300 MB; I left it alone.\n\nReply yes to move the old builds to the Recycle Bin.",
    },
  ];
}
