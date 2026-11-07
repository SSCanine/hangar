// Short "what you need to know" versions of Claude Code replies for the bell: the local model
// (Ollama, the Quick job's model) boils a reply down to a few spoken sentences, cached per inbox
// item in AppData/cache/inbox-briefs.json (the phone page reads the same file). With no local
// model running, a brief is cut from the reply itself.
import { invoke } from "@tauri-apps/api/core";
import { inTauri, type InboxItem } from "./api";
import { speak } from "./speech";
import { ENDPOINTS, useStore } from "./store";
import { resolveRole } from "./roles";
import { speakable } from "./voice";

export interface Brief {
  t: string;
  /** Cut from the reply itself because no model answered; not cached, so it is redone later. */
  fb?: boolean;
}

const BASE = ENDPOINTS.find((e) => e.id === "ollama")?.base ?? "http://127.0.0.1:11434/v1";
const NS = "inbox-briefs";
/** Replies this short (spoken length) already are the brief. */
const SHORT = 160;
const PARALLEL = 2;

const PROMPT =
  "You boil a Claude Code reply down to a very short brief for the user, who often hears it read aloud. " +
  "Write one to three short sentences, at most 50 words: the outcome or answer first, then anything they have to do, " +
  "approve or decide, said plainly (\"You need to approve the merge.\"). If nothing is needed from them, don't say so. " +
  "Talk to them as you. Plain spoken English only: no markdown, lists, file paths, links, code, ids or version numbers. " +
  "If the reply ends with a question for them, end with that question. Answer with the brief only.";

let loaded: Promise<void> | null = null;
const inflight = new Map<string, Promise<Brief>>();
const queue: (() => void)[] = [];
let running = 0;

function put(id: string, b: Brief) {
  const s = useStore.getState();
  s.set({ briefs: { ...s.briefs, [id]: b } });
}

/** Loads the saved briefs into the store once. */
function load(): Promise<void> {
  loaded ??= (inTauri ? invoke<Record<string, string>>("cache_get", { ns: NS }) : Promise.resolve({}))
    .then((saved) => {
      const s = useStore.getState();
      const briefs: Record<string, Brief> = {};
      for (const [id, t] of Object.entries(saved ?? {})) if (typeof t === "string") briefs[id] = { t };
      s.set({ briefs: { ...briefs, ...s.briefs } });
    })
    .catch(() => {});
  return loaded;
}

/** The first sentences of `plain` that fit in `max` characters. */
function sentences(plain: string, max: number): string {
  if (plain.length <= max) return plain;
  let out = "";
  for (const s of plain.match(/[^.!?]+[.!?]+/g) ?? [plain]) {
    if (out && (out + s).length > max) break;
    out += s;
  }
  return (out || plain.slice(0, max)).trim();
}

/** Without a model: the reply's own "result:" line, else its opening and closing prose paragraphs. */
export function fallbackBrief(text: string): string {
  const result = text.match(/^\s*\**result\**:\**\s*(.+)$/im)?.[1];
  if (result) return sentences(speakable(result, 4000), SHORT);
  // Lists, headings, tables and bold-only label lines read badly once flattened.
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^\s*([-*+]\s|\d+[.)]\s|#|\||>)/m.test(p) && !/^\*\*[^*]+\*\*:?$/.test(p));
  if (!prose.length) return sentences(speakable(text, 4000), SHORT);
  const first = sentences(speakable(prose[0], 4000), SHORT);
  const last = prose.length > 1 ? sentences(speakable(prose[prose.length - 1], 4000), 160) : "";
  return last ? `${first} ${last}` : first;
}

/** Very long replies: the start plus the end, where the outcome usually sits. */
function clip(text: string, max = 14000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, 4000)}\n\n[...middle cut...]\n\n${text.slice(-(max - 4000))}`;
}

function tidy(t: string): string {
  return t
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function slot<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < PARALLEL) go();
    else queue.push(go);
  });
}

async function make(item: InboxItem): Promise<Brief> {
  if (item.kind === "waiting" || speakable(item.text, 100_000).length <= SHORT) return { t: speakable(item.text, 4000) };
  const messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: `Session: ${item.title || item.project || "Claude Code"}\n\nReply:\n${clip(item.text)}` },
  ];
  try {
    const roles = useStore.getState().roles;
    const quick = roles?.roles.find((r) => r.id === "quick") ?? roles?.roles[0];
    const model = quick ? resolveRole(quick, null).model : null;
    if (!model) throw new Error("no model");
    const t = tidy(await slot(() => invoke<string>("llm_complete", { base: BASE, model, messages })));
    if (!t) throw new Error("empty brief");
    void invoke("cache_merge", { ns: NS, entries: { [item.id]: t } }).catch(() => {});
    return { t };
  } catch {
    return { t: fallbackBrief(item.text), fb: true };
  }
}

/** The brief for one reply: saved, being made, or made now. A fallback brief is retried. */
export async function getBrief(item: InboxItem): Promise<Brief> {
  await load();
  const have = useStore.getState().briefs[item.id];
  if (have && !have.fb) return have;
  let p = inflight.get(item.id);
  if (!p) {
    p = make(item)
      .then((b) => {
        put(item.id, b);
        return b;
      })
      .finally(() => inflight.delete(item.id));
    inflight.set(item.id, p);
  }
  return p;
}

/** Reads a Claude Code reply aloud: the full text or its brief, per Settings > Read aloud. */
export async function readInbox(item: InboxItem): Promise<void> {
  const key = `inbox:${item.id}`;
  if (useStore.getState().readAloud !== "brief") return speak(key, item.text);
  const b = await getBrief(item);
  return speak(key, b.t);
}
