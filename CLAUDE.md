# CLAUDE.md: setting up and working on Hangar

Hangar is a Tauri 2 desktop app (Rust backend in `src-tauri/`, React 19 + Tailwind 4 frontend in `src/`) that launches and watches the user's local tools. It runs on Windows only.

## When the user asks you to set up Hangar

Work through these in order. Ask before installing software or editing anything outside this folder, and say what you're about to change.

1. **Check the prerequisites:** `node --version` (22.18+), `cargo --version` (stable, MSVC target), `python --version` (3.10+, optional), and for the Chats panel `claude agents --help` (Claude Code installed with its native installer, so `claude.exe` is on PATH; an npm install won't work). The Rust build also needs the Visual Studio Build Tools "Desktop development with C++" workload. If something is missing, tell the user what to install and where to get it (nodejs.org, rustup.rs, python.org); don't install silently.
2. **Install and build:** `npm install`, then `npm run tauri build -- --no-bundle`. The first Rust build takes several minutes. The app is `src-tauri\target\release\hangar.exe`.
3. **Build the user's tool list** in `registry/tools.json`. It is copied from `registry/tools.example.json` on first run; you can also create it yourself from the example.
   - Ask the user which tools they use. Also look for common ones: Ollama (`%LOCALAPPDATA%\Programs\Ollama`), LM Studio, ComfyUI, Stable Diffusion WebUI / Forge, Open WebUI, koboldcpp, and any local web apps they run. `netstat -ano -p tcp | findstr LISTENING` shows what is already serving.
   - For each tool, fill in `id`, `name`, `theme`, `kind`, `url`/`port`/`health`, and a `start` command that you have checked actually works. The field reference is in README.md.
   - Prefer `%USERPROFILE%`, `%LOCALAPPDATA%` and `{hangar}` in paths over hard-coded user folders.
   - Every `theme` must exist in `themes`. Theme `icon` values: `ai`, `image`, `video`, `voice`, `music`, `code`, `utility`, `art`, `games`, `content`, `school`, `money`, `sparkles`.
   - Remove the example entries the user doesn't have. Keep the ids `ollama`, `lmstudio`, `koboldcpp`, `kokoro` and `hangar-stt` for those tools: the assistant and voice features look them up by id.
   - Model jobs live in `registry/model-roles.json` (copied from the example). The defaults suit about 24 GB of VRAM; on a smaller GPU, put smaller installed models first.
4. **Optional extras.** Offer each one; do it only when the user says yes.
   - *Speech-to-text for the assistant's mic:* `pip install faster-whisper fastapi uvicorn python-multipart`. The `hangar-stt` tool starts it on demand.
   - *Chimes, the bell and Windows notifications:* back up `%USERPROFILE%\.claude\settings.json`, then add the `Stop` and `Notification` hooks shown in README.md (use the full path of `pythonw.exe` if it isn't on PATH), and run `powershell -ExecutionPolicy Bypass -File hooks\register.ps1` once.
   - *Claude usage meter:* set the status line to `node <hangar>\tools\claude-usage-statusline.mjs` with `"refreshInterval": 60`. If the user already has a status line, ask before replacing it.
   - *Read-aloud voices:* Kokoro-FastAPI on port 8880 (`docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`), or set `HANGAR_TTS_URL`.
   - *Projects page:* write `registry/projects.json` (shape in `projects.example.json`) with the user's project folders.
5. **Start Hangar** and check that the tools show the right status. Fix any tool whose status or start command is wrong.

## Rules for this repo

- `registry/tools.json`, `registry/projects.json` and `registry/model-roles.json` are the user's own and are gitignored (the `*.example.json` files are the committed defaults). Never commit them, and never put a real user name, home folder path, address or private hostname in a committed file. Use `%VARIABLE%` and `{hangar}` in examples.
- The phone remote is home-network only by design. Don't add internet tunnels or relays to it.
- Chats Hangar starts use Claude Code's normal permission prompts unless the user picks another mode in Settings > Claude chats. Never change that default or turn on `bypassPermissions` for the user without asking them.
- Deleting user files goes to the Recycle Bin (the `trash` crate), never a permanent delete.

## Working on the code

| Where | What |
|---|---|
| `src-tauri/src/registry.rs` | Loads the tool list, expands `%VAR%` and `{hangar}` |
| `src-tauri/src/tools.rs` | Status checks, start, stop, focus, logs |
| `src-tauri/src/monitor.rs`, `overview.rs`, `system.rs` | Process list, system page, GPU (nvidia-smi) |
| `src-tauri/src/assistant.rs`, `roles.rs` | Local-model chat (OpenAI-compatible), model jobs, TTS/STT proxies |
| `src-tauri/src/chats.rs`, `sessions.rs`, `pty.rs`, `closeout.rs`, `attach.rs` | Claude Code sessions: list, read, send, terminal, close, attachments |
| `src-tauri/src/remote.rs`, `toolproxy.rs`, `remote/index.html` | Phone remote server and page |
| `src/` | The React UI; `src/lib/api.ts` wraps every Rust command and mocks them in a plain browser |
| `hooks/` | The Claude Code notification hook and its Windows toast helper |

Checks before you call a change done:

```powershell
npx tsc --noEmit
npm test
cd src-tauri; cargo test --lib
```

`cargo test` tests marked `#[ignore]` start real Claude sessions or servers; run them only on purpose.
