# Termates Roadmap

## Next Up: Multi-Agent Workspace Orchestration

### Problem

Users want to run several coding agents side by side, usually 2-5 at a time:

- one or more coding terminals
- a review or verification terminal
- a research/docs terminal
- sometimes a remote or ops terminal

The hard part is not opening terminals. The hard part is making those terminals repeatable, visible, and easy to manage across local repos and remote hosts.

### Product Direction

- provider-agnostic: Claude Code, Codex, Aider, and similar tools should all fit
- desktop-first: local Electron app with local state and no cloud dependency
- human-controlled first: explicit launch and coordination before automation
- artifact-driven coordination: files, git state, browser snapshots, and terminal status matter more than chat logs
- workspace-first: the setup should be reproducible at the workspace level, not terminal by terminal

### MVP Direction

1. Workspace templates for common agent teams.
2. Per-terminal launch profiles with shell, cwd, env, and startup commands.
3. Git worktree-per-agent setup for coding/review/test terminals.
4. Agent status and attention surfaces in the sidebar.
5. Browser snapshot handoff into a terminal or workspace scratch file.

### High-Level Architecture

```text
Workspace preset
  -> terminal creation + presets
  -> PTY/tmux persistence layer
  -> workspace state + layout restore
  -> agent status and attention UI
```

### Phase 2

- reusable runbooks and prompt snippets by preset
- shared team memory directory for repo instructions and handoff files
- checkpoint/summarize actions for long-running agent terminals
- remote workspace presets with bootstrap commands
- provider/model labeling per terminal

### Future Ideas

- session recording and replay
- plugin system for custom agent integrations
- lightweight automation hooks for recurring local workflows
- collaborative read-only workspace sharing
