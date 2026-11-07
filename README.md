# Hangar

One front door for all the local tools on your Windows PC: AI servers, image and video apps, scripts, little web UIs. Hangar starts and stops them, shows which are running, opens their pages in tabs, and keeps an eye on your CPU, RAM and GPU. It also has a home for your Claude Code sessions, a local-model assistant, and a phone page for your home Wi-Fi.

Hangar has no account and no server of its own. What leaves your PC is listed under [Privacy](#privacy).

## What's in it

- **Tool launcher.** Your tools grouped by theme, each with a live status light, Start, Stop, Open, its log and its folder. Web tools open inside Hangar as tabs.
- **Ctrl K search** across tools, projects and actions.
- **System page.** CPU per thread, RAM, drives and network, plus GPU load, VRAM, temperature and power on NVIDIA cards (it reads `nvidia-smi`; AMD and Intel GPUs show no GPU numbers).
- **Process panel.** Click a meter in the title bar to see what is using it, grouped by your tools instead of a wall of `python.exe`. Windows system processes can't be killed from it.
- **Assistant dock (Ctrl J).** Chat with local models through Ollama, LM Studio or koboldcpp. Model "jobs" (Quick, Writer, Coder, Deep think) pick the right installed model. It knows your tool list and can hand you a button to open one. It has a mic (local Whisper on the CPU) and read-aloud (Kokoro).
- **Chats panel.** Every Claude Code session on the PC, background jobs included. Read them as a conversation, reply, attach files, open a live terminal, or start a new one.
- **Bell and notifications.** A chime and a Windows notification when Claude finishes or needs you, with "Open conversation" and "Read aloud" buttons.
- **Phone remote.** A phone page for your chats, tools and meters, served by Hangar on your home Wi-Fi only. Each phone pairs once with a code. Off until you switch it on.
- **Claude usage meter** in the title bar, read from Claude Code's own status line (Pro and Max plans report usage).

## Requirements

- Windows 10 or 11 (Hangar uses Windows APIs throughout).
- [Node.js](https://nodejs.org) **22.18 or newer** (`npm test` runs the TypeScript tests directly).
- [Rust](https://rustup.rs) stable with the MSVC toolchain, plus the "Desktop development with C++" workload from the Visual Studio Build Tools.
- WebView2 (already installed on Windows 11).
- Optional:
  - [Claude Code](https://claude.com/claude-code), **installed with its native installer** so `claude.exe` is on PATH (an npm install's `claude.cmd` can't be started by Hangar). The Chats panel needs a version with background sessions: check that `claude agents --help` works.
  - Python 3.10+ for the speech-to-text server and the notification hook.
  - [Ollama](https://ollama.com), LM Studio or koboldcpp for the assistant.
  - Windows Terminal (for "open in terminal") and VS Code (for "Show in VS Code").

## Quick start

```powershell
git clone https://github.com/SSCanine/hangar.git
cd hangar
npm install
npm run tauri build -- --no-bundle
.\src-tauri\target\release\hangar.exe
```

On first run Hangar copies `registry/tools.example.json` to `registry/tools.json` (and `model-roles.example.json` to `model-roles.json`). Edit `tools.json`, or use **Add a tool** in the app, to list your own tools.

Run the exe where it was built. Hangar finds its folder by walking up from the exe, so moving or renaming the whole clone is fine. An exe copied somewhere else on its own keeps its lists in `%APPDATA%\app.hangar.desktop\registry` instead.

For development, `npm run tauri dev` runs it with hot reload (the UI dev server uses port 3620).

**Using Claude Code?** Open this folder in Claude Code and say "set up Hangar for me". [CLAUDE.md](CLAUDE.md) walks it through the whole setup, including finding your tools.

## Your tool list

`registry/tools.json` is yours and is never committed. Each tool looks like this:

```json
{
  "id": "comfyui",
  "name": "ComfyUI",
  "theme": "image",
  "description": "Node-based image generation.",
  "kind": "web",
  "url": "http://127.0.0.1:8188/",
  "port": 8188,
  "embed": true,
  "gpu": true,
  "start": { "cmd": ["python", "main.py"], "cwd": "%USERPROFILE%\\ComfyUI", "window": "hidden" },
  "stoppable": true,
  "folder": "%USERPROFILE%\\ComfyUI"
}
```

| Field | Meaning |
|---|---|
| `kind` | `web` (has a page), `app` (a desktop program), or `service` (a background server) |
| `url`, `port`, `health` | Where it answers. Status uses `url` + `health` when given, else a TCP check on `port` |
| `embed` | Open the page inside Hangar instead of the browser |
| `start.cmd` | Program and arguments, one per item. `start.window` is `hidden` (output goes to the tool's log), `minimized` or `console` |
| `start.env` | Extra environment variables. `PATH_PREPEND` is put in front of `PATH` |
| `exe` | For desktop apps: the program to start, and how Hangar finds its window |
| `folder` | The tool's folder, for "Open folder" and for grouping its processes |
| `stoppable` | Show Stop. Stop ends whatever listens on the tool's port |
| `gpu` | A GPU tool. Hangar asks before starting it, and can free Ollama's VRAM first (`unload_on_gpu_start` in the model jobs file) |
| `restart_stuck` | Turn on restarts the app when its program runs but its port stays dead |
| `phone_open` | The phone remote may open this tool's page. `"phone": false` hides a tool from the phone entirely |
| `also_themes` | Extra themes the tool also shows up in |
| `part_of` | Merge a helper into another tool's row (a tool id) |
| `hosted_in` | `{ "tool": "<id>", "tab": "<name>" }` when the tool is a tab inside another app |
| `parts` | Helper tool ids shown nested inside this one |
| `token_file` | A JSON file whose `token` value is added to the page address as `?k=TOKEN` |
| `env_strip_claude` | Start the tool without Claude Code's environment variables |
| `notes` | Shown on the tool's row |

Paths can use `%VARIABLE%` (for example `%USERPROFILE%`, `%LOCALAPPDATA%`) and `{hangar}` for the Hangar folder, so a list can be shared without anyone's user name in it. Saving a tool from the app writes the resolved paths back to your own file.

**Tool ids Hangar knows about:** `ollama`, `lmstudio` and `koboldcpp` are where the assistant dock talks to (it uses the tool's `url` plus `/v1`, or the default port when the tool isn't listed); `kokoro` is the read-aloud voice; `hangar-stt` is the mic's speech-to-text. Keep those ids if you want those features to start the tools for you.

The Projects page reads the optional `registry/projects.json` (see `projects.example.json`).

## Model jobs

`registry/model-roles.json` maps jobs (Quick, Writer, Coder, Deep think) to Ollama models, best first; the first one you have installed is used. The defaults suit a GPU with about 24 GB of VRAM. On a smaller card, put smaller models first (for example `qwen3:8b` and `qwen2.5-coder:7b`), or pick a model per job in the dock (gear icon).

## Claude chats and permissions

Chats that Hangar starts (from the Chats page or the phone) use Claude Code's normal permission prompts by default; answer them in the chat's Terminal tab. **Settings > Claude chats** can switch new chats to "Allow edits" or "Never ask" (`bypassPermissions`). "Never ask" lets Claude change files and run commands without asking, and anyone with a paired phone can start such a chat, so only use it if you understand that.

"Done" on a chat stops it and moves its transcript to `%USERPROFILE%\.claude\chat-archive` (nothing is deleted). Claude Code's own `--resume` list no longer shows archived chats.

## Optional setup

**Chimes, notifications and the bell.** Add Hangar's hook to `%USERPROFILE%\.claude\settings.json` for the `Stop` and `Notification` events:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "pythonw.exe", "args": ["C:\\path\\to\\hangar\\hooks\\hangar_notify.py"], "timeout": 15, "async": true }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "pythonw.exe", "args": ["C:\\path\\to\\hangar\\hooks\\hangar_notify.py"], "timeout": 15, "async": true }] }]
  }
}
```

Use the full path of `pythonw.exe` if it isn't on PATH. Then run `powershell -ExecutionPolicy Bypass -File hooks\register.ps1` once, so Windows notifications show as "Hangar" and their buttons open it.

**Speech-to-text for the mic.** `pip install faster-whisper fastapi uvicorn python-multipart`. The `hangar-stt` tool starts `stt/stt_server.py` on first mic use; if `python` on your PATH is the Microsoft Store stub, put your real `python.exe` path in its `start.cmd`. `HANGAR_STT_MODEL` picks the Whisper model (default `small`), which is downloaded from Hugging Face the first time.

**Read-aloud voices.** Run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) on port 8880, for example `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`, or set `HANGAR_TTS_URL` to another Kokoro-compatible server.

**Claude usage meter.** Set Claude Code's status line to `node C:\path\to\hangar\tools\claude-usage-statusline.mjs` (with `"refreshInterval": 60`). It only reads the usage numbers Claude Code passes to every status line and never touches your credentials. Usage numbers appear on Pro and Max plans.

**Phone remote (home Wi-Fi).** Settings > Phone remote > switch it on, then Pair a phone. If your network is set to Public, run `scripts\allow-remote-firewall.ps1` as administrator once (it opens port 3622 to your local network only).

**Claude phone app access (through Anthropic).** Separately, the Chats page has a "Phone access" switch that runs Claude Code's own `claude remote-control` in a folder you pick, so the Claude phone app and claude.ai/code can start and drive sessions on this PC. That connection goes through Anthropic and your Claude account, not your home network. It is off until you switch it on, and it stops when Hangar closes.

**Embedded tools talking to Hangar.** A tool page embedded in Hangar can ask it to open a Claude chat with `window.parent.postMessage({ type: "hangar:open-chat", id, session_id, name, cwd }, "*")`, or to show the close dialog with `type: "hangar:close-chat"`. Hangar only listens to pages served from a registered embedded tool's address.

## Settings by environment variable

| Variable | What it does | Default |
|---|---|---|
| `HANGAR_HOME` | The Hangar folder (holds `registry\`) | found from the exe's location |
| `HANGAR_REGISTRY` | Path to a different `tools.json` (the other lists stay in the Hangar folder) | `registry/tools.json` |
| `HANGAR_ROLES` | Path to a different model jobs file | `registry/model-roles.json` |
| `HANGAR_TTS_URL` | Kokoro-compatible speech server | `http://127.0.0.1:8880` |
| `HANGAR_STT_MODEL` | Whisper model for the mic | `small` |
| `HANGAR_HIDE_CWD` | Hide Claude sessions whose folder contains this text (helper processes) | not set |

## Ports

| Port | What |
|---|---|
| 3620 | UI dev server (`npm run tauri dev` only) |
| 3621 | Speech-to-text server (`stt/stt_server.py`) |
| 3622 | Phone remote (off until switched on) |

## Privacy

What stays on your PC:
- Hangar's data in `%APPDATA%\app.hangar.desktop`: settings, the inbox of Claude replies, logs, phone pairing (token hashes only) and files attached from the phone.
- The phone remote only answers your home network and this PC, and every request needs a paired phone's token.
- The assistant talks only to the local model servers in your tool list.

What leaves it:
- Claude Code chats talk to Anthropic, as Claude Code always does. "Phone access" (Claude phone app) goes through Anthropic too, and only while switched on.
- The speech-to-text server downloads its Whisper model from Hugging Face on first use.

On your PC, Hangar also registers the `hangar://` link type for your user (HKCU) on each start, so notification buttons can open it. `hooks\register.ps1` adds the notification app id the same way.

## License

MIT. See [LICENSE](LICENSE).
