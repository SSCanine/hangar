// Read-aloud player: one voice at a time, long text in sentence chunks so speech starts in a
// second or two, the next chunk prepared while the current one plays, stoppable any time.
import { api, errText, inTauri } from "./api";
import { ensureRunning } from "./actions";
import { useStore } from "./store";
import { speakable } from "./voice";

type Listener = (playingKey: string | null, loading: boolean) => void;

const listeners = new Set<Listener>();
let playingKey: string | null = null;
let loading = false;
let run = 0;
let audio: HTMLAudioElement | null = null;

function emit() {
  for (const l of listeners) l(playingKey, loading);
}

export function onSpeech(l: Listener): () => void {
  listeners.add(l);
  l(playingKey, loading);
  return () => listeners.delete(l);
}

/** Splits text into chunks of whole sentences, about `size` characters each. */
export function chunks(text: string, size = 320): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > size) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((c) => /[A-Za-z0-9]/.test(c));
}

async function synth(text: string): Promise<Blob> {
  const s = useStore.getState();
  const voice = s.ttsVoice.kokoro ?? "";
  try {
    return await api.tts(text, voice, s.ttsSpeed);
  } catch (e) {
    // Kokoro is a light CPU server: start it once (when it's in the tool list) and try again.
    if (await ensureRunning("kokoro", 45_000)) return api.tts(text, voice, s.ttsSpeed);
    throw e;
  }
}

function playBlob(blob: Blob, my: number): Promise<void> {
  return new Promise((resolve) => {
    if (my !== run) return resolve();
    const url = URL.createObjectURL(blob);
    audio = new Audio(url);
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

/** Reads `text` aloud. Pressing play on the same key again stops it. */
export async function speak(key: string, markdown: string): Promise<void> {
  if (!inTauri) return;
  if (playingKey === key) return stop();
  stop();
  const my = ++run;
  const parts = chunks(speakable(markdown, 100_000));
  if (!parts.length) return;
  playingKey = key;
  loading = true;
  emit();
  try {
    let next: Promise<Blob> | null = synth(parts[0]);
    for (let i = 0; i < parts.length && my === run; i++) {
      const blob: Blob = await next!;
      next = i + 1 < parts.length ? synth(parts[i + 1]) : null;   // prepare the next chunk meanwhile
      if (my !== run) break;
      loading = false;
      emit();
      await playBlob(blob, my);
    }
  } catch (e) {
    if (my === run) useStore.getState().toast(`Couldn't read it aloud: ${errText(e)}`, "bad");
  } finally {
    if (my === run) {
      playingKey = null;
      loading = false;
      emit();
    }
  }
}

export function stop() {
  run++;
  audio?.pause();
  audio = null;
  if (playingKey !== null || loading) {
    playingKey = null;
    loading = false;
    emit();
  }
}

/** Plays one of the chime files (public/sounds/<style>-<kind>.wav). */
export function playChime(kind: "done" | "waiting", style?: string) {
  const s = style ?? useStore.getState().chimeStyle;
  const a = new Audio(`/sounds/${s}-${kind}.wav`);
  a.volume = 0.9;
  void a.play().catch(() => {});
}
