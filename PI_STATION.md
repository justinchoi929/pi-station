# Pi Station

Pi Station is a Web and macOS desktop client for an independently installed pi CLI. Agent sessions run in `pi --mode rpc` subprocesses. The executable is resolved from the server's PATH; no sibling pi source checkout or `sync-pi` step is needed.

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
- The fixed npm pi packages currently remain as compatibility helpers for existing session-file readers and settings panels. They are registry dependencies, never `file:../pi/...` links, and do not select or run the chat engine. Removing those remaining file/config adapters is separate from the execution migration.

Pi's own CLI loads its normal extensions, providers, MCP servers and tools. Pi Station no longer injects its former in-process subagent engine into new chat sessions. Install any desired agent tools as pi extensions. Existing subagent transcripts remain readable.

Standard RPC dialogs (`select`, `confirm`, `input`, `editor`), notifications, status lines and text widgets are forwarded. Pi's RPC protocol does not support terminal `custom()` components or widget component factories; those retain pi's native RPC limitations.

The packaged macOS app still contains the desktop shell and points at this Pi Station checkout for its Web server. It does not package a pi installation.
