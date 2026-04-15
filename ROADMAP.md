# Termates Roadmap

## Next Up: Agent-to-Agent Communication

### Problem
Multiple AI agents (Claude Code, Codex, Aider, etc.) running in linked terminals need to collaborate - delegate tasks, share context, and coordinate like a team.

### Design Decision
- **Mixed-agent support** (not tied to any specific agent)
- **Async communication** (fire-and-forget, not blocking)
- **Typically 2-5 agents** per team
- **Human-triggered for MVP**, autonomous later
- **Hybrid approach**: shared files as data layer + PTY injection for notifications

### Architecture: Message Bus with PTY Notification

```
Human sends message via UI
        |
        v
+-------------------+     message file written to
|  Coder terminal   |---> ~/.termates/messages/
|  (Claude Code)    |           |
+-------------------+           v
                      +--------------------+
                      |  Termates Server   |  routes message
                      |  (message bus)     |  based on links
                      +--------------------+
                                |
                      PTY injection + file
                                |
                                v
                      +--------------------+
                      | Reviewer terminal  |  sees message as
                      | (Codex / Claude)   |  natural language input
                      +--------------------+
                                |
                      agent uses `termates reply`
                                |
                                v
                      notification back to Coder
```

### Step-by-Step Flow
1. Human uses UI to compose and send a message to a target terminal
2. Server saves message to `~/.termates/messages/` as JSON
3. Server injects formatted notification into target terminal's PTY
4. The agent (any TUI) sees this as text input and processes it
5. Agent can use `termates reply <name> "response"` to send back
6. Server routes reply, injects into source terminal
7. Frontend shows message badges on terminals with unread messages

### Injection Format (into target PTY)
```
=== TERMATES: Message from "Coder" ===
Review auth.js changes
=== Reply with: termates reply Coder "your response" ===
```

### CLI Commands (for agents, not humans)
```bash
termates msg <target> "message"        # Send to a specific terminal
termates reply <target> "response"     # Reply
termates inbox                         # Check messages (uses TERMATES_TERMINAL_ID env var)
termates broadcast "message"           # Send to all linked terminals
```

### UI Components
- Message composer dialog (replaces current "Send to Linked")
- Message badge/count on terminal items in sidebar
- Message log panel (conversation view between linked terminals)
- CLAUDE.md template generator for agent setup

### Phase 2: Autonomous Agent Communication
- Agents decide when to communicate without human trigger
- CLAUDE.md instructions teach agents about `termates msg/reply`
- Shared context directory for persistent team memory
- Agent presence detection (idle vs busy)

---

## Future Ideas
- Session recording and playback
- Terminal snapshots (save/restore terminal state)
- Plugin system for custom agent integrations
- Mobile remote control (view terminals from phone)
- Collaborative mode (multiple humans viewing same workspace)
