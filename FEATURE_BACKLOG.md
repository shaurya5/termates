# Termates Feature Backlog

This backlog is based on the current codebase shape:

- local-first terminal/workspace orchestration
- linked terminals for collaboration
- tmux-backed persistence
- SSH/remote workspaces
- lightweight browser sidecar
- CLI + WebSocket control surfaces

It is intentionally biased toward features that fit the product already in the repo, not generic “could build anything” ideas.

## Shipped In This Pass

1. Linked-terminal messaging is now wired into the UI with a compose dialog and persisted message history.
2. The CLI now supports `broadcast` and `inbox` for agent-style collaboration workflows.
3. Client layout restore/removal now preserves saved split trees instead of rebuilding balanced layouts unnecessarily.
4. SSH config parsing now handles multi-host entries correctly, and remote working directories are quoted more safely.
5. Link state is now persisted into workspace state so links survive refreshes and restores.

## Highest Priority

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Unread message badges per terminal/workspace | Collaboration becomes much more usable once users can see who needs attention without opening the message log. | `src/client/sidebar.js`, `src/client/events.js`, `server/state-manager.js` |
| P1 | Reply and quick-reply actions in the message log | Users should be able to answer a linked terminal in one click instead of reopening the composer every time. | `public/index.html`, `src/client/dialogs.js`, `src/client/sidebar.js` |
| P1 | Broadcast from the UI to all linked terminals | The CLI supports broadcast now; the main UI should expose the same workflow for multi-agent coordination. | `src/client/dialogs.js`, `server/ws-handler.js` |
| P1 | Persisted shared notes per workspace/team | `LinkManager` already has note primitives; turning them into a visible feature would give teams a durable scratchpad for plans, TODOs, and handoffs. | `server/link-manager.js`, `server/state-manager.js`, `src/client/sidebar.js` |
| P1 | Better link ownership rules across workspaces | Links are conceptually per workspace, but the runtime manager is global. Tightening that model will prevent confusing cross-workspace edge cases. | `server/link-manager.js`, `server/orchestration.js`, `src/client/events.js` |
| P1 | Export/import workspace sessions | Users will want to move setups between machines or share reproducible team layouts. | `server/state-manager.js`, `bin/termates.js`, new export/import UI |

## Collaboration And Agent Workflows

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Terminal inbox filtering by sender/workspace | Message volume grows quickly with 3-5 linked terminals; filtering keeps the collaboration surface usable. | `server/orchestration.js`, `bin/termates.js`, `src/client/sidebar.js` |
| P1 | Human-readable sender/receiver names in CLI inbox | IDs are fine for tests, not for daily use. | `bin/termates.js`, `server/cli-handler.js` |
| P2 | Mention-style prompts (`@reviewer`, `@tester`) | Faster routing for common team roles and easier CLI ergonomics. | `bin/termates.js`, `server/cli-handler.js`, `src/client/dialogs.js` |
| P2 | Agent presence / busy vs idle detection | Termates already tracks terminal status; promoting that into team presence would help delegation and triage. | `server/pty-manager.js`, `src/client/sidebar.js`, `src/client/events.js` |
| P2 | Workflow templates for common agent teams | One-click “coder + reviewer + tester” setups would reduce repetitive manual bootstrapping. | `src/client/dialogs.js`, `src/client/workspace.js`, `bin/termates.js` |
| P2 | Message attachments via browser snapshots or note links | Sharing context is easier when messages can point to captured browser text or shared notes. | `server/index.js`, `server/orchestration.js`, browser UI |
| P3 | Team memory directory + generated agent instructions | The roadmap already points here; this would make long-running multi-agent work repeatable. | `ROADMAP.md`, CLI, server persistence layer |

## Workspace And Terminal UX

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Terminal search/filter in the sidebar | Once a workspace has many terminals, the current flat list becomes slow to scan. | `src/client/sidebar.js`, `public/index.html`, `public/style.css` |
| P1 | Pin/favorite terminals | Users typically have a few “always visible” panes they want to keep prominent. | `server/state-manager.js`, `src/client/sidebar.js` |
| P1 | Restore the exact active terminal per workspace | The app already persists layouts; restoring focus would make restarts feel much less jarring. | `server/state-manager.js`, `src/client/state.js`, `src/client/events.js` |
| P2 | Terminal command snippets/macros | Useful for bootstrapping repos, running standard checks, and starting agents consistently. | CLI + dialog layer + state persistence |
| P2 | Terminal output search within a pane | A common need once terminals become long-lived and persistent. | `src/client/terminal-factory.js`, xterm integration |
| P2 | Pane maximization / temporary fullscreen | Important when using many splits and reviewing large logs or diffs. | `src/client/layout/renderer.js`, shared layout helpers |
| P2 | Duplicate workspace / clone layout | Helpful when branching a workflow without rebuilding the whole setup. | `src/client/workspace.js`, `server/state-manager.js` |
| P3 | Session recording / replay | Already in the roadmap and useful for demos, debugging, and incident review. | server PTY pipeline, state/export layer |

## Remote / SSH Workflows

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | SSH host picker with parsed aliases and metadata | The parser already exists; turning it into a stronger creation flow would remove manual typing friction. | `server/ssh-config.js`, `src/client/workspace.js`, dialogs |
| P1 | Saved remote workspace presets | Users often bounce between the same hosts and directories. | `server/state-manager.js`, workspace UI |
| P2 | Remote reconnect / health indicators | Remote sessions can fail independently of the UI; users need to know what needs reattachment. | `server/pty-manager.js`, `src/client/sidebar.js`, notifications |
| P2 | Remote terminal bootstrap commands | Auto-run repo setup, environment activation, or agent startup after connect. | `server/pty-manager.js`, workspace/terminal creation flow |
| P2 | Per-workspace env vars | Common for remote and multi-repo setups. | `server/state-manager.js`, terminal creation APIs, UI dialogs |

## Browser-Assisted Workflows

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Send browser snapshot text directly to a terminal/message | The browser panel already proxies pages; handing captured context to an agent is a natural next step. | `server/index.js`, `src/client/browser-panel.js`, dialogs |
| P2 | Save browser tabs per workspace more explicitly | Browser tabs are already persisted globally; binding them more tightly to workspaces would feel more intentional. | `server/state-manager.js`, `src/client/browser-panel.js` |
| P2 | Open link in browser sidecar from terminal message log | Useful when agents share URLs during review/debug cycles. | sidebar/message UI, browser panel |
| P3 | Browser history / revisit list inside the sidecar | Helps research-heavy sessions and bug triage. | browser state + UI |

## Reliability And Admin

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Safer server startup diagnostics | Startup bugs should be obvious in-app, not only visible in terminal logs. | `server/index.js`, `electron/main.cjs`, notifications |
| P1 | State repair / reset tooling | Persistent local state is useful until it becomes inconsistent; users need a supported recovery path. | `server/state-manager.js`, CLI |
| P2 | Better conflict handling for multiple UI clients | The app mostly assumes a single active UI; explicit multi-client rules would reduce accidental state stomping. | WebSocket sync, client workspace persistence |
| P2 | Changelog / release notes view in-app | Updates already exist; clearer release visibility would make adoption easier. | `electron/main.cjs`, `src/client/update.js` |
| P3 | Anonymous local diagnostics bundle export | Helpful when debugging user issues without adding telemetry. | CLI + state snapshot/export |

## Suggested Next Implementation Order

1. Unread message badges and quick reply.
2. UI broadcast to all linked terminals.
3. Shared notes UI backed by existing `LinkManager` note primitives.
4. Terminal search/pinning.
5. Browser snapshot handoff to terminals/messages.
