// Files for a chat message on the desktop: dropped on the chat, pasted with Ctrl+V (when the
// clipboard holds files or an image rather than text) or Alt+V like Claude Code. They go to
// Claude as their paths on this PC, in the same "Attached files:" block the phone page uses.

import { useEffect, useRef, useState } from "react";
import { api, errText, inTauri } from "./api";
import { useStore } from "./store";

export { attachBlock, baseName, isImage } from "./attachText";

type WebView2 = { postMessageWithAdditionalObjects?: (msg: string, objs: ArrayLike<File>) => void };
const webview = (): WebView2 | undefined => (window as unknown as { chrome?: { webview?: WebView2 } }).chrome?.webview;

/** Real paths of dropped files, by index ("" where WebView2 gave none). Hangar's Rust side reads
 * them off the File objects (attach.rs, install_drop_bridge). */
async function pathsOf(files: File[]): Promise<string[]> {
  const wv = webview();
  if (!inTauri || !wv?.postMessageWithAdditionalObjects) return files.map(() => "");
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let done: (p: string[]) => void = () => {};
  const got = new Promise<string[]>((r) => (done = r));
  const un = await api.onDrop((e) => e.token === token && done(e.paths));
  try {
    wv.postMessageWithAdditionalObjects(JSON.stringify({ hangarDrop: token }), files);
    const paths = await Promise.race([got, new Promise<string[]>((r) => setTimeout(() => r([]), 4000))]);
    return files.map((_, i) => paths[i] ?? "");
  } finally {
    un();
  }
}

function base64Of(f: File): Promise<string> {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(f);
  });
}

/** Paths for dropped files: their own where they have one, else a saved copy. */
export async function droppedPaths(files: File[]): Promise<{ paths: string[]; errors: string[] }> {
  const own = await pathsOf(files);
  const paths: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (own[i]) {
      paths.push(own[i]);
      continue;
    }
    try {
      paths.push(await api.attachSave(files[i].name || "dropped", await base64Of(files[i])));
    } catch (e) {
      errors.push(`${files[i].name}: ${errText(e)}`);
    }
  }
  return { paths, errors };
}

const hasFiles = (e: React.DragEvent | DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

/** Attachments for one message box: drop target props, paste and Alt+V handlers, the list. */
export function useAttachments() {
  const { toast } = useStore();
  const [files, setFiles] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const depth = useRef(0);

  // A file let go anywhere else in Hangar's page would make WebView2 open it in place of Hangar.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  const add = (paths: string[]) => setFiles((xs) => [...xs, ...paths.filter((p) => p && !xs.includes(p))]);
  const remove = (p: string) => setFiles((xs) => xs.filter((x) => x !== p));
  const clear = () => setFiles([]);

  /** Clipboard through Rust: files or an image attach, text goes in at the cursor. */
  async function grab(box: HTMLTextAreaElement | null) {
    setBusy(true);
    try {
      const r = await api.clipboardGrab();
      if (r.files.length) add(r.files);
      else if (r.text) {
        box?.focus();
        // Keeps undo and fires React's onChange like a normal paste.
        if (!document.execCommand("insertText", false, r.text)) toast("Couldn't paste that text.", "bad");
      } else toast("Nothing to paste: the clipboard has no text, image or files.", "bad");
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  return {
    files,
    busy,
    dragging,
    add,
    remove,
    clear,
    /** Text pastes as usual; anything else (an image, files copied in Explorer) attaches. */
    onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
      if (e.clipboardData.getData("text/plain")) return;
      e.preventDefault();
      void grab(e.currentTarget);
    },
    /** Alt+V, as in Claude Code. Returns true when it handled the key. */
    onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void grab(e.currentTarget);
        return true;
      }
      return false;
    },
    dropProps: {
      onDragEnter(e: React.DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      },
      onDragOver(e: React.DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(e: React.DragEvent) {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(e: React.DragEvent) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const list = Array.from(e.dataTransfer.files);
        if (!list.length) return;
        setBusy(true);
        void droppedPaths(list)
          .then(({ paths, errors }) => {
            add(paths);
            if (errors.length) toast(errors.join("\n"), "bad");
          })
          .finally(() => setBusy(false));
      },
    },
  };
}
