import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { inTauri } from "../lib/api";

// Reads %APPDATA%\app.hangar.desktop\claude-usage.json (written by tools/claude-usage-statusline.mjs
// from Claude Code's status line). Read-only: no credentials, no usage API.

interface UsageWindow {
  pct: number;
  resets_at?: number | null;
}
interface ClaudeUsage {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  updated_at?: number | null;
  age_secs: number;
}

const POLL_MS = 30_000;
const STALE_SECS = 30 * 60;

/** Browser preview: ?usage=87,5 (weekly, 5-hour; "-" = unknown), ?usage=stale, ?usage=none. */
function mockUsage(): ClaudeUsage | null {
  const q = new URLSearchParams(location.search).get("usage") ?? "87,5";
  if (q === "none") return null;
  const now = Date.now() / 1000;
  const [wk, fh] = (q === "stale" ? "87,5" : q).split(",");
  const win = (v: string | undefined, hours: number) => (v && v !== "-" ? { pct: Number(v), resets_at: Math.floor(now + hours * 3600) } : null);
  const age = q === "stale" ? 3 * 3600 : 120;
  return { seven_day: win(wk, 60), five_hour: win(fh, 3), updated_at: Math.floor(now - age), age_secs: age };
}

const fetchUsage = (): Promise<ClaudeUsage | null> => (inTauri ? invoke<ClaudeUsage | null>("claude_usage") : Promise.resolve(mockUsage()));

/** A window whose reset time has passed is unknown until the next status line update. */
function live(w: UsageWindow | null | undefined, now: number) {
  if (!w || typeof w.pct !== "number") return null;
  if (w.resets_at && w.resets_at <= now) return null;
  return w;
}

function resetText(epoch: number | null | undefined, withDay: boolean) {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return ` (resets ${withDay || !sameDay ? d.toLocaleDateString("en-US", { weekday: "short" }) + " " : ""}${time})`;
}

function agoText(secs: number) {
  if (secs < 60) return "just now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const pctText = (w: UsageWindow | null) => (w ? `${Math.round(w.pct)}%` : "--");

/** Title-bar Claude usage: weekly bar plus "wk 87% · 5h 5%". Below 1536 px only the % text shows. */
export function ClaudeMeter() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      fetchUsage()
        .then((u) => {
          if (!alive) return;
          // Keep the last values when the file vanishes; it is shown dimmed as stale.
          setUsage((prev) => u ?? (prev ? { ...prev, age_secs: Number.MAX_SAFE_INTEGER } : null));
          setLoaded(true);
          setTick((n) => n + 1);
        })
        .catch(() => alive && setLoaded(true));
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const now = Date.now() / 1000;
  const week = live(usage?.seven_day, now);
  const five = live(usage?.five_hour, now);
  const stale = !usage || usage.age_secs > STALE_SECS;
  const wp = week ? Math.max(0, Math.min(100, week.pct)) : 0;
  const tone = stale ? "var(--color-faint)" : wp >= 90 ? "var(--color-bad)" : wp >= 70 ? "var(--color-warn)" : "var(--color-live)";
  const textRed = !stale && ((week?.pct ?? 0) >= 90 || (five?.pct ?? 0) >= 90);
  const textAmber = !stale && !textRed && (week?.pct ?? 0) >= 70;

  const lines = [
    `Weekly: ${pctText(week)}${week ? resetText(week.resets_at, true) : ""}`,
    `5-hour: ${pctText(five)}${five ? resetText(five.resets_at, false) : ""}`,
    usage && usage.age_secs < Number.MAX_SAFE_INTEGER ? `updated ${agoText(usage.age_secs)}` : "",
  ].filter(Boolean);
  const title = !loaded
    ? "Claude usage: reading"
    : stale
      ? `No live Claude session updating usage${usage ? `\nLast seen: ${lines.join(" / ")}` : ""}`
      : lines.join(" / ");

  return (
    <div
      className={clsx("flex items-center gap-2 h-7 text-[12px] num shrink-0 transition-opacity", stale && "opacity-50", textRed ? "text-bad" : textAmber ? "text-warn" : "text-dim")}
      title={title}
    >
      <span className="text-faint hidden min-[1536px]:inline">Claude</span>
      <div className="h-1.5 w-12 rounded-full bg-raise overflow-hidden hidden min-[1536px]:block">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${wp}%`, background: tone }} />
      </div>
      <span className="hidden min-[1536px]:inline-block w-[104px] whitespace-nowrap">
        wk {pctText(week)} <span className="text-faint">·</span> 5h {pctText(five)}
      </span>
      <span className="inline-block min-[1536px]:hidden w-[76px] text-right whitespace-nowrap">
        {pctText(week)} <span className="text-faint">·</span> {pctText(five)}
      </span>
    </div>
  );
}
