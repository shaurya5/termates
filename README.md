# Termates

Desktop terminal multiplexer for local and remote multi-agent workflows.

Termates combines an Electron desktop shell, a local PTY/orchestration server, and a small CLI so you can manage multiple named terminals, keep them organized in workspaces, link related agent panes, and script the running app without leaving the desktop UI. State stays on your machine in `~/.termates`.

![Termates workspace](./redesign-terminal.png)

## What It Does

- Runs multiple local terminals in one desktop app.
- Saves workspace membership, split layouts, browser tabs, links, and terminal metadata.
- Reattaches to tmux-backed sessions on restart when `tmux` is available.
- Supports remote SSH workspaces and persistent SSH terminals.
- Tracks links and status across related terminals so multi-agent setups stay legible.
- Includes a built-in browser panel for docs, dashboards, and quick web snapshots.
- Exposes a local CLI that talks to the running app over a Unix socket.
- Keeps everything on-device with no telemetry.

## Requirements

- macOS or Linux
- Node.js 18 or newer
- npm
- `tmux` recommended for persistence
- `ssh` for remote workflows
- `tmux` on the remote host for remote workspaces

Windows is not currently a target platform. The app uses a Unix socket for the local CLI and only ships macOS/Linux desktop targets in the build config.

## Quick Start

```bash
npm install
npm start
```

That will:

1. Bundle the browser client with esbuild.
2. Launch the Electron shell.
3. Start the local Express/WebSocket/PTY server on `127.0.0.1:7680`.

For development with sourcemaps:

```bash
npm run dev
```

## Typical Workflow

1. Create a workspace.
2. Add one or more terminals.
3. Split the active terminal horizontally or vertically.
4. Link related terminals so the workspace reflects how your agents are grouped.
5. Use terminal roles and status changes to track what needs attention.
6. Open the browser panel when you need docs or a dashboard beside the terminals.

Remote workspaces can be created from the UI by choosing `Remote (SSH)` and providing an SSH target plus an optional remote working directory. New terminals in that workspace inherit the remote target automatically.

## Keyboard Shortcuts

- `Ctrl+Shift+T`: new terminal
- `Ctrl+Shift+N`: new workspace
- `Ctrl+Shift+H`: split horizontal
- `Ctrl+Shift+V`: split vertical
- `Ctrl+Shift+B`: toggle browser
- `Ctrl+Shift+L`: toggle link mode
- `Ctrl+Shift+W`: close active terminal
- `Ctrl+Shift+[` / `Ctrl+Shift+]`: move between terminals

## CLI

The desktop app exposes a local CLI through [`bin/termates.js`](./bin/termates.js). Run the app first, then use commands like:

```bash
node ./bin/termates.js ping
node ./bin/termates.js list
node ./bin/termates.js new --name "Lead"
node ./bin/termates.js new --name "Coder" --cwd ~/projects/termates
node ./bin/termates.js link t1 t2
node ./bin/termates.js send t2 "npm test"
node ./bin/termates.js notify t2 --status attention --text "Needs review"
node ./bin/termates.js ssh user@host --name "Prod"
node ./bin/termates.js browser-snapshot https://example.com
```

Available command groups include:

- app lifecycle: `start`, `ping`
- terminal management: `new`, `list`, `read`, `send`, `rename`, `status`, `destroy`
- linking and coordination: `link`, `unlink`, `notify`
- remote access: `ssh`
- web snapshotting: `browser-snapshot`

## Persistence

Termates stores local state under `~/.termates/`.

- `state.json`: saved workspaces, layouts, terminal metadata, links, and browser state
- `tmux.conf`: tmux settings used for persistent terminal sessions
- `ssh-sockets/`: SSH control sockets for connection reuse

If `tmux` is installed, terminals are backed by named `termates-*` sessions and reattached when the app comes back up. Without `tmux`, the app still works, but terminals do not survive restarts.

## Architecture

```text
Electron window
  -> local Express server + WebSocket server
  -> PTY manager (node-pty)
  -> optional tmux session layer for persistence
  -> workspace/link/state orchestration
  -> local CLI socket for scripting
```

Main code areas:

- [`electron/`](./electron): Electron bootstrap and desktop integration
- [`server/`](./server): PTY management, state, SSH helpers, REST endpoints, WebSocket handling, CLI socket
- [`src/client/`](./src/client): xterm.js UI, workspace/layout rendering, dialogs, sidebar, browser panel
- [`shared/`](./shared): shared layout helpers
- [`public/`](./public): HTML, CSS, logo, bundled frontend output
- [`tests/`](./tests): unit, integration, and performance coverage

## Scripts

```bash
npm run build
npm run build:dev
npm run start
npm run dev
npm run dist
npm run dist:mac
npm run dist:linux
npm test
npm run test:unit
npm run test:integration
npm run test:perf
```

## Project Docs

- [ROADMAP.md](./ROADMAP.md)
- [FEATURE_BACKLOG.md](./FEATURE_BACKLOG.md)
- [CHANGELOG.md](./CHANGELOG.md)

## License

MIT
