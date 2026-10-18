# Pi Station

Pi Station is a pi package providing Web and macOS desktop clients for an independently installed pi CLI. Install with `pi install git:github.com/justinchoi929/pi-station`, reload pi, then use `/station web`, `/station desktop`, `/station status`, or `/station stop`. Agent sessions run in `pi --mode rpc` subprocesses. The executable is resolved from the server's PATH; no sibling pi source checkout or `sync-pi` step is needed.

```text
Browser / Pi Station.app
        | HTTP + SSE
Pi Station server (127.0.0.1:30141)
        | JSONL over stdin/stdout
pi from PATH (--mode rpc)
        | settings, credentials, extensions, sessions
~/.pi/agent
```

## Run

The package's explicit `pi.extensions` entry loads only `extensions/station.ts`. The TypeScript entry supports updates through `/reload` without retaining a native ESM command handler. Loading it registers commands without starting a process, including in RPC/model discovery. Commands lazily start a shared Node worker with a private authenticated local control socket. It survives pi shutdown until `/station stop`. The worker serializes launches, reuses a verified Pi Station server, and shuts down only its owned Web and Electron children. A reused development/standalone server remains running.

Managed pi installs omit development dependencies. The package therefore installs only its small launcher dependencies. `runtime/package.json` and its lockfile contain the separate Web SDK, UI and build dependencies. First launch copies source into a content-addressed runtime under `<agentDir>/pi-station/runtimes/`, runs `npm ci`, and builds there. A completion marker is written only after success; failures can be retried, concurrent builds are locked, and Stop cancels preparation. No development `.next` is touched. Electron is installed separately on first desktop use. Stop the worker before updating the package and reload pi afterward.

Install pi separately and verify `pi --version` in your shell, then install Pi Station's dependencies with `npm install`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload on port 30141. |
| `npm run web` | Start the existing production build; add `-- --no-open` to skip opening a browser. |
| `npm run desktop` | Open the Electron client. It attaches to the server or starts one. |
| `npm run dist` | Package the macOS shell in `dist/`. |

Do not run `next build` during development: it shares `.next` with the dev server. After upgrading pi, restart Pi Station's server so new subprocesses use that installation. No Pi Station rebuild or package synchronization is required for a pi upgrade.

`PI_STATION_PI` optionally selects one executable, for example `/opt/homebrew/bin/pi`. Supply the executable path only, without shell arguments. By default the command is simply `pi`, resolved through PATH. The desktop app imports the login shell's environment when launched from Finder.

`PI_STATION_PORT` selects the desktop server port. Desktop server logs are written to `~/Library/Logs/Pi Station/server.log`.

## Implementation

- `lib/pi-rpc-client.ts`: executable discovery, JSONL framing, request correlation, events, bounded stderr diagnostics, and graceful shutdown with signal escalation. No shell is used for project arguments; npm command shims on Windows are handled by cross-spawn.
- `lib/pi-cli-session.ts`: adapts the CLI's session state and events to the existing HTTP/SSE interface. Each session owns one CLI process; browser disconnection does not stop its run.
- `bin/pi-station-extension.mjs`: an explicitly loaded extension using only pi's public extension API. It supplies tool inspection/selection, context usage, scoped model discovery, reload and tree navigation through a hidden client command. Replies use ordinary RPC notify records and do not become conversation messages.
- `GET /api/pi`: reports the installed executable's version at runtime. The sidebar no longer reports the version of a bundled SDK as the active engine.
- The fixed npm pi packages remain as compatibility helpers for existing session-file readers and settings panels in the isolated runtime. They are development dependencies in the source checkout, never production dependencies of the loaded pi extension. They do not select or run the chat engine.

Pi's own CLI loads its normal extensions, providers, MCP servers and tools. Pi Station no longer injects its former in-process subagent engine into new chat sessions. Install any desired agent tools as pi extensions. Existing subagent transcripts remain readable.

Standard RPC dialogs (`select`, `confirm`, `input`, `editor`), notifications, status lines and text widgets are forwarded. Pi's RPC protocol does not support terminal `custom()` components or widget component factories; those retain pi's native RPC limitations.

The packaged macOS app still contains the desktop shell and points at this Pi Station checkout for its Web server. It does not package a pi installation.
