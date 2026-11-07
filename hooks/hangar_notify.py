"""Claude Code hook: chime + Hangar inbox.

Runs on Stop (a reply or task finished) and Notification (Claude is waiting for you).
1. Plays a soft chime (public/sounds/<style>-done.wav or -waiting.wav), unless muted in Hangar.
2. Appends the event with the full reply to Hangar's inbox
   (%APPDATA%/app.hangar.desktop/inbox.jsonl), where the bell shows it with a play button.

Registered in ~/.claude/settings.json as an async command hook, so it never slows Claude down.
Never raises: any problem is logged next to the inbox and the hook exits 0.
"""
import json
import subprocess
import os
import sys
import time
import uuid

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "app.hangar.desktop")
INBOX = os.path.join(DATA, "inbox.jsonl")
SETTINGS = os.path.join(DATA, "notify.json")
LOG = os.path.join(DATA, "logs", "notify-hook.log")
MAX_INBOX_BYTES = 2_000_000
KEEP_LINES = 400


def log(msg: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def settings() -> dict:
    try:
        with open(SETTINGS, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def tail_lines(path: str, max_bytes: int = 3_000_000) -> list:
    """The last lines of a transcript (they can be tens of MB; the end is what matters)."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            data = fh.read()
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    return lines[1:] if size > max_bytes else lines   # first line may be cut in half


def session_title(lines: list) -> str:
    """The session's AI title, the same one /resume shows ("notes app search")."""
    for line in reversed(lines):
        if '"ai-title"' not in line:
            continue
        try:
            title = json.loads(line).get("aiTitle", "")
        except ValueError:
            continue
        if title:
            return title
    return ""


def looks_like_data(text: str) -> bool:
    """Headless tool calls (claude -p) answer with JSON for a program, not a message for you."""
    t = text.strip()
    if not t or t[0] not in "[{":
        return False
    try:
        json.loads(t)
        return True
    except ValueError:
        return False


JOBS = os.path.join(os.path.expanduser("~"), ".claude", "jobs")


def job_for_notice(text: str):
    """A background job's "<name> finished" / "<name> is waiting" notice comes from a helper
    process with its own session id and no transcript, so Hangar opened an empty conversation
    Map the notice back to the job by name: (session_id, transcript_path, name)."""
    t = (text or "").strip()
    try:
        for d in os.listdir(JOBS):
            try:
                with open(os.path.join(JOBS, d, "state.json"), encoding="utf-8") as fh:
                    s = json.load(fh)
            except (OSError, ValueError):
                continue
            name = (s.get("name") or "").strip()
            if name and s.get("sessionId") and (t == name or t.startswith(name + " ")):
                return s["sessionId"], s.get("linkScanPath") or "", name
    except OSError:
        pass
    return None


def is_temp_dir(cwd: str) -> bool:
    c = cwd.replace("/", "\\").lower()
    base = c.rstrip("\\").rsplit("\\", 1)[-1]
    return "\\temp\\" in c + "\\" or "\\tmp\\" in c + "\\" or base.startswith("tmp")


def last_text_from_transcript(lines: list) -> str:
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "assistant":
            continue
        content = entry.get("message", {}).get("content", [])
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip():
                    return block["text"]
    return ""


def trim_inbox() -> None:
    try:
        if os.path.getsize(INBOX) <= MAX_INBOX_BYTES:
            return
        with open(INBOX, encoding="utf-8") as fh:
            lines = fh.readlines()[-KEEP_LINES:]
        tmp = INBOX + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
        os.replace(tmp, INBOX)
    except OSError as e:
        log(f"trim failed: {e}")


def chime(kind: str, style: str) -> None:
    if style not in ("bell", "marimba", "glass"):
        style = "bell"
    wav = os.path.join(HERE, "public", "sounds", f"{style}-{kind}.wav")
    try:
        import winsound

        winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_NODEFAULT)
    except Exception as e:  # no sound device, file missing: stay silent
        log(f"chime failed: {e}")


def plain(text: str, limit: int = 180) -> str:
    """First words of a reply without markdown, for the notification body."""
    import re

    t = re.sub(r"```[\s\S]*?```", " ", text)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"^[#>*\-\s|]+", "", t, flags=re.MULTILINE)
    t = re.sub(r"[*_|]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"


def toast(item: dict) -> None:
    """A Windows notification: who it is from, the first line, Open conversation / Read aloud."""
    from urllib.parse import quote

    script = os.path.join(HERE, "hooks", "toast.ps1")
    who = item.get("title") or item.get("project") or "Claude"
    where = item.get("project") or "Claude"
    attribution = f"Needs you in {where}" if item["kind"] == "waiting" else f"Done in {where}"
    sid = item.get("session_id", "")
    open_url = f"hangar://session/{quote(sid)}?item={item['id']}&cwd={quote(item.get('cwd', ''))}" if sid else ""
    read_url = f"hangar://read/{item['id']}"
    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
             "-Title", who[:90], "-Body", plain(item["text"]) or " ", "-Attribution", attribution,
             "-OpenUrl", open_url, "-ReadUrl", read_url],
            creationflags=0x08000000,  # no console window
        )
    except OSError as e:
        log(f"toast failed: {e}")


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError as e:
        log(f"payload was not JSON ({e}); first 120 chars: {raw[:120]!r}")
        payload = {}
    if payload.get("stop_hook_active"):
        return
    event = payload.get("hook_event_name") or ("Notification" if payload.get("message") else "Stop")
    kind = "waiting" if event == "Notification" else "done"
    cwd = payload.get("cwd") or os.getcwd()
    if is_temp_dir(cwd):
        return  # a tool running Claude headless from a temp folder, not a session for you
    if kind == "waiting":
        ntype = str(payload.get("notification_type", ""))
        msg = str(payload.get("message", ""))
        if ntype == "idle_prompt" or msg.lower().startswith("claude is waiting for your input"):
            return  # the idle reminder after a reply that already chimed "done"
    session_id = payload.get("session_id", "")
    transcript = payload.get("transcript_path", "")
    job_name = ""
    if not (transcript and os.path.isfile(transcript)):
        notice = payload.get("message") or payload.get("last_assistant_message") or ""
        job = job_for_notice(notice)
        if job:
            # "<job> finished" is fired by every helper watching the job (several at once) and
            # carries no text; the job's own Stop event already added the reply as "done".
            if kind == "waiting" and notice.strip().endswith(" finished"):
                return
            session_id, transcript, job_name = job
    lines = tail_lines(transcript)
    if kind == "done":
        text = payload.get("last_assistant_message") or last_text_from_transcript(lines)
    else:
        text = payload.get("message") or "Claude is waiting for you."
    text = (text or "").strip()
    if not text or (kind == "done" and looks_like_data(text)):
        return
    item = {
        "id": uuid.uuid4().hex[:12],
        "at": time.time(),
        "kind": kind,
        "session_id": session_id,
        "cwd": cwd,
        "project": os.path.basename(cwd.rstrip("\\/")) or cwd,
        "title": session_title(lines) or job_name,
        "text": text[:40000],
    }
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(INBOX, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")
        trim_inbox()
    except OSError as e:
        log(f"inbox write failed: {e}")
    prefs = settings()
    if prefs.get("toast", True):
        toast(item)
    if prefs.get("chime", True) and (kind == "done" or prefs.get("chime_waiting", True)):
        chime(kind, str(prefs.get("style", "bell")))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break Claude Code
        log(f"hook error: {e!r}")
    sys.exit(0)
