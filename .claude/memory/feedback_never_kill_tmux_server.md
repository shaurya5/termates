---
name: Never run tmux kill-server
description: CRITICAL - never kill all tmux sessions, only kill termates-prefixed ones. User lost active work sessions.
type: feedback
---

NEVER run `tmux kill-server`. It kills ALL tmux sessions on the machine including the user's active work sessions unrelated to termates.

**Why:** User had active work in a tmux session on a remote machine. Running `tmux kill-server` destroyed it. This could happen to any user.

**How to apply:** When cleaning up termates sessions, ONLY kill sessions with the `termates-` prefix:
```bash
tmux list-sessions -F "#{session_name}" | grep "^termates-" | xargs -I{} tmux kill-session -t {}
```
Never use `tmux kill-server`, `tmux kill-session` without a specific target, or any blanket tmux cleanup.
