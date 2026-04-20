# Termates Feature Backlog

This backlog is based on the current codebase shape:

- Electron desktop shell
- local-first PTY and workspace orchestration
- linked terminals and terminal status
- tmux-backed persistence
- SSH and remote workspaces
- browser sidecar
- CLI and WebSocket control surfaces

The focus here is practical multi-agent development: Claude Code, Codex, Aider, and similar tools running in dedicated terminals with repeatable setup and clear coordination.

## Shipped Recently

1. Desktop-only Electron startup and native-only folder browsing.
2. Server startup stabilization and broader unit/integration coverage.
3. Layout restore and terminal removal now preserve saved split trees instead of rebuilding layouts unnecessarily.
4. SSH config parsing now handles multi-host entries correctly, and remote working directories are quoted more safely.
5. Workspace link state now persists across refreshes and restores.

## Highest Priority

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Workspace templates for common agent teams | Most users will reuse the same 2-5 terminal setup and startup commands across projects. | `src/client/workspace.js`, dialogs, `server/state-manager.js`, CLI |
| P1 | Per-terminal launch profiles | Agent terminals need repeatable shell, cwd, env vars, and startup commands. | `server/pty-manager.js`, `server/state-manager.js`, create-terminal UI, CLI |
| P1 | Git worktree per agent | Separate worktrees are one of the highest-leverage workflows for multiple coding agents. | workspace creation flow, CLI, `server/state-manager.js` |
| P1 | Agent attention queue | Users need one place to see which terminal is idle, failed, waiting, or asking for review. | `src/client/sidebar.js`, `src/client/events.js`, `server/pty-manager.js` |
| P1 | Better link ownership across workspaces | Links should model agent relationships inside one workspace, not leak globally in confusing ways. | `server/link-manager.js`, `server/orchestration.js`, client workspace sync |
| P1 | Export/import workspace presets | Teams will want to reuse proven multi-agent setups across repos and machines. | `server/state-manager.js`, CLI, workspace UI |

## Agent Workflows

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Terminal presets | Spinning up a terminal with the right cwd, env, startup command, and provider command should not require retyping setup every time. | terminal creation dialogs, CLI, persisted profiles |
| P1 | Browser snapshot handoff into a terminal | Research and docs are already in-app; pushing captured context into the active agent terminal is a natural next step. | `server/index.js`, `src/client/browser-panel.js`, terminal actions |
| P1 | One-click review/test loops | “Open a review terminal”, “run tests”, and “prepare diff review” are common, repeated workflows. | UI actions, CLI helpers, terminal bootstrap layer |
| P2 | Shared team memory directory + generated agent instructions | Long-running teams need a durable place for repo context, conventions, and task state. | `ROADMAP.md`, persistence layer, CLI |
| P2 | Provider/model badges per terminal | Users running Codex and Claude side by side need to know which agent is in which pane at a glance. | `server/state-manager.js`, sidebar, configure-terminal dialog |
| P2 | Agent checkpoint / summarize actions | A quick checkpoint is more useful than raw scrollback when several agents run in parallel. | CLI, terminal actions, possible file export |
| P2 | Prompt routing by terminal alias | Commands like “send to review” or “focus tests” are faster than remembering terminal IDs. | CLI, sidebar, terminal metadata |
| P3 | Policy-aware runbooks | Teams often want repo-specific “before merge” or “before review” checklists tied to presets or workflows. | preset storage, CLI, workspace metadata |

## Workspace And Terminal UX

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | Terminal search/filter in the sidebar | Larger agent teams become hard to scan with a flat list. | `src/client/sidebar.js`, `public/index.html`, `public/style.css` |
| P1 | Pin/favorite terminals | A few high-value terminals usually need to stay prominent. | `server/state-manager.js`, `src/client/sidebar.js` |
| P1 | Restore the exact active terminal per workspace | Restarting the app should return users to the same agent and pane they were using. | `server/state-manager.js`, `src/client/state.js`, `src/client/events.js` |
| P2 | Pane maximization / temporary fullscreen | Reviewing diffs, logs, or long agent output needs more room than dense split layouts allow. | `src/client/layout/renderer.js`, shared layout helpers |
| P2 | Duplicate workspace / clone layout | Users often want to fork an agent team setup for another branch or experiment. | `src/client/workspace.js`, `server/state-manager.js` |
| P2 | Terminal output search within a pane | Persistent agent sessions produce long output; search becomes mandatory quickly. | xterm integration, terminal factory |
| P3 | Session recording / replay | Useful for debugging agent behavior and sharing repeatable demos. | PTY pipeline, export layer |

## Remote And SSH

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | SSH host picker with aliases and metadata | Remote agent work should not depend on manual host typing every time. | `server/ssh-config.js`, workspace dialog |
| P1 | Saved remote workspace presets | Teams often reuse the same host + directory + terminal preset mix. | `server/state-manager.js`, workspace UI |
| P2 | Remote reconnect and health indicators | Remote agents fail independently of the desktop UI; users need fast visibility. | `server/pty-manager.js`, sidebar, notifications |
| P2 | Remote bootstrap commands | SSH workspaces should be able to auto-open a repo, activate envs, and start the right agent flow. | terminal creation path, remote workspace settings |
| P2 | Per-workspace env vars and secrets references | Multi-agent repos usually need shared environment setup without manual copy/paste. | state manager, creation APIs, dialogs |

## Reliability And Admin

| Priority | Feature | Why Users Care | Likely Touchpoints |
| --- | --- | --- | --- |
| P1 | State repair / reset tooling | Local-first apps need a supported recovery path when saved state gets inconsistent. | `server/state-manager.js`, CLI |
| P1 | Safer startup diagnostics in-app | Startup failures should be visible in the desktop UI, not only in terminal logs. | `electron/main.cjs`, `server/index.js`, notifications |
| P2 | Better conflict handling for multiple windows/clients | Even if desktop-first, users may open more than one window and expect deterministic behavior. | WebSocket sync, client state |
| P2 | Release notes view in-app | Users need to understand what changed without leaving the app. | updater UI, `electron/main.cjs`, `src/client/update.js` |
| P3 | Local diagnostics bundle export | Helpful for debugging without adding telemetry. | CLI, state snapshot/export |

## Suggested Next Implementation Order

1. Workspace templates for agent teams.
2. Per-terminal launch profiles.
3. Git worktree-per-agent setup.
4. Agent attention queue in the sidebar.
5. Browser snapshot handoff into a terminal.
