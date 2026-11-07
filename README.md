# Hangar

One front door for all the local tools on your Windows PC: AI servers, image and video apps, scripts, little web UIs. Hangar starts and stops them, shows which are running, opens their pages in tabs, and keeps an eye on your CPU, RAM and GPU. It also has a home for your Claude Code sessions, a local-model assistant, and a phone page for your home Wi-Fi.

Everything runs on your own PC. Hangar has no account and no cloud service, and it sends nothing anywhere except to the local tools you add.

## What's in it

- **Tool launcher.** Your tools grouped by theme, each with a live status light, Start, Stop, Open, its log, and its folder. Web tools open inside Hangar as tabs.
- **Ctrl K search** across tools, projects and actions.
- **System page.** CPU per thread, RAM, GPU load, VRAM, temperature, power, drives and network, with 10-minute charts.
- **Process panel.** Click a meter in the title bar to see what is using it, grouped by your tools instead of a wall of `python.exe`. Windows system processes can't be killed from it.
- **Assistant dock (Ctrl J).** Chat with local models through Ollama, LM Studio or koboldcpp. Model "jobs" (Quick, Writer, Coder, Deep think) pick the right installed model. It knows your tool list and can hand you a button to open one. It has a mic (local Whisper on the CPU) and read-aloud (Kokoro).
- **Chats panel.** Every Claude Code session on the PC, background jobs included. Read them as a conversation, reply, attach files, or open a live terminal.
- **Bell and notifications.** A chime and a Windows notification when Claude finishes or needs you, with "Open conversation" and "Read aloud" buttons.
- **Phone remote.** A phone page for your chats, tools and meters. It is home Wi-Fi only, each phone pairs once with a code, and it is off until you switch it on.
- **Claude usage meter** in the title bar, read from Claude Code's own status line.

## Requirements

- Windows 10 or 11 (Hangar uses Windows APIs throughout).
- [Node.js](https://nodejs.org) 20 or newer.
- [Rust](https://rustup.rs) stable with the MSVC toolchain, plus the "Desktop development with C++" workload from the Visual Studio Build Tools.
- WebView2 (already installed on Windows 11).
- Optional: Python 3.10+ for the speech-to-text server and the notification hook, [Ollama](https://ollama.com) for the assistant, and [Claude Code](https://claude.com/claude-code) for the Chats panel and notifications.

## Quick start

```powershell
git clone https://github.com/SSCanine/hangar.git
cd hangar
npm install
npm run tauri build -- --no-bundle
.\src-tauri\target\release\hangar.exe
```

On first run Hangar copies `registry/tools.example.json` to `registry/tools.json`. Edit that file, or use **Add a tool** in the app, to list your own tools.

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
| `start.cmd` | Program and arguments, one per item. `start.window` is `hidden` (logged), `minimized` or `console` |
| `exe` | For desktop apps: the program to start, and how Hangar finds its window |
| `stoppable` | Show Stop. Stop ends whatever listens on the tool's port |
| `gpu` | Marks GPU tools. Starting one can free Ollama's VRAM first |
| `phone_open` | The phone remote may open this tool's page |
| `notes` | Shown on the tool's row |

Paths can use `%VARIABLE%` (for example `%USERPROFILE%`, `%LOCALAPPDATA%`) and `{hangar}` for the Hangar folder, so a list can be shared without anyone's user name in it. Saving a tool from the app writes the resolved paths back to your own file.

The Projects page reads the optional `registry/projects.json` (see `projects.example.json`).

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

Then run `powershell -ExecutionPolicy Bypass -File hooks\register.ps1` once, so Windows notifications show as "Hangar" and their buttons open it.

**Claude usage meter.** Set Claude Code's status line to `node C:\path\to\hangar\tools\claude-usage-statusline.mjs` (with `"refreshInterval": 60`). It only reads the usage numbers Claude Code passes to every status line and never touches your credentials.

**Phone remote.** Settings > Phone remote > switch it on, then Pair a phone. If your network is set to Public, run `scripts\allow-remote-firewall.ps1` as administrator once (it opens port 3622 to your local network only).

## Settings by environment variable

| Variable | What it does | Default |
|---|---|---|
| `HANGAR_REGISTRY` | Path to a different `tools.json` | `registry/tools.json` |
| `HANGAR_ROLES` | Path to a different model jobs file | `registry/model-roles.json` |
| `HANGAR_TTS_URL` | Kokoro-compatible speech server | `http://127.0.0.1:8880` |
| `HANGAR_HIDE_CWD` | Hide Claude sessions whose folder contains this text (helper processes) | not set |

## Ports

| Port | What |
|---|---|
| 3620 | UI dev server (`npm run tauri dev` only) |
| 3621 | Speech-to-text server (`stt/stt_server.py`) |
| 3622 | Phone remote (off until switched on) |

## Privacy

- Hangar keeps its data in `%APPDATA%\app.hangar.desktop`: settings, the inbox of Claude replies, logs, phone pairing (token hashes only) and files attached from the phone.
- The phone remote only answers your home network and loopback, and every request needs a paired phone's token.
- Nothing is sent to any server you didn't add yourself.

## License

MIT. See [LICENSE](LICENSE).
