// Speech settings. STT_URL is Hangar's own local faster-whisper server (CPU, stt/stt_server.py).
export const STT_URL = "http://127.0.0.1:3621/v1/audio/transcriptions";
/** Registry id of the CPU speech-to-text server the mic uses. */
export const STT_TOOL = "hangar-stt";

export const KOKORO_VOICES = [
  { id: "af_heart", name: "Heart (Kokoro)" },
  { id: "af_bella", name: "Bella (Kokoro)" },
  { id: "am_michael", name: "Michael (Kokoro)" },
  { id: "am_adam", name: "Adam (Kokoro)" },
  { id: "bm_george", name: "George (Kokoro)" },
];

/** Turns a markdown reply into words worth saying out loud. */
export function speakable(md: string, max = 2400): string {
  return md
    .replace(/\[\[(open|start):[a-z0-9-]+\]\]/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Za-z]:\\S+/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_>|~]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
