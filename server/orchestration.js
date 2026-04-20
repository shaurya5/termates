import { removeLayoutLeaf } from '../shared/layout-tree.js';

const MAX_WORKSPACE_MESSAGES = 200;

// Central TUI monitor: polls every terminal's tmux pane alt-screen state.
// When a pane enters/leaves alt-screen (claude, codex, vim, less, htop…) we
// broadcast so the client can disable the agent-launch buttons on that pane.
// Detection works regardless of how the TUI started — typed manually, launched
// via button, or restored from a persisted tmux session.
const TUI_POLL_MS = 1500;
let tuiMonitorHandle = null;

export function startTuiMonitor(ptyManager, broadcast) {
  if (tuiMonitorHandle) return;
  if (process.env.TERMATES_DISABLE_TUI_MONITOR === '1') return;
  tuiMonitorHandle = setInterval(async () => {
    for (const t of ptyManager.list()) {
      const onAlt = await ptyManager.paneAlternateOn(t.id);
      if (onAlt === null) continue; // tmux unavailable or pane gone
      const res = ptyManager.setInTui(t.id, onAlt);
      if (res?.changed) {
        broadcast({ type: 'terminal:tui-state', payload: { id: t.id, inTui: res.current } });
      }
    }
  }, TUI_POLL_MS);
}

export function stopTuiMonitor() {
  if (tuiMonitorHandle) {
    clearInterval(tuiMonitorHandle);
    tuiMonitorHandle = null;
  }
}

/**
 * Save current terminal state to the state manager.
 */
export function persistState(stateManager, ptyManager) {
  stateManager.setTerminals(ptyManager.list());
  stateManager.setNextTerminalId(ptyManager.nextId);
  // Sync workspace state with actual terminals
  stateManager.setWorkspaces(stateManager.get().workspaces);
}

/**
 * Add a terminal ID to the active workspace.
 */
export function addTerminalToWorkspace(stateManager, terminalId) {
  const saved = stateManager.get();
  const wsId = saved.activeWorkspaceId || saved.workspaces[0]?.id;
  const ws = saved.workspaces.find(w => w.id === wsId);
  if (ws && !ws.terminalIds.includes(terminalId)) {
    ws.terminalIds.push(terminalId);
    stateManager.setWorkspaces(saved.workspaces);
  }
}

export function addLinkToWorkspace(stateManager, from, to) {
  const saved = stateManager.get();
  const ws = saved.workspaces.find((workspace) =>
    (workspace.terminalIds || []).includes(from) && (workspace.terminalIds || []).includes(to))
    || saved.workspaces.find((workspace) => workspace.id === saved.activeWorkspaceId)
    || saved.workspaces[0];

  if (!ws) return false;
  ws.links = ws.links || [];
  if (ws.links.some((link) => isSameLink(link, { from, to }))) return false;
  ws.links.push({ from, to });
  stateManager.setWorkspaces(saved.workspaces);
  return true;
}

export function removeLinkFromWorkspaces(stateManager, from, to) {
  const saved = stateManager.get();
  let removed = false;

  for (const ws of saved.workspaces) {
    const links = ws.links || [];
    const nextLinks = links.filter((link) => !isSameLink(link, { from, to }));
    if (nextLinks.length !== links.length) {
      ws.links = nextLinks;
      removed = true;
    }
  }

  if (removed) stateManager.setWorkspaces(saved.workspaces);
  return removed;
}

/**
 * Remove a terminal ID from all workspaces (terminal IDs, links, layouts).
 */
export function removeTerminalFromWorkspaces(stateManager, terminalId) {
  const saved = stateManager.get();
  for (const ws of saved.workspaces) {
    ws.terminalIds = ws.terminalIds.filter(id => id !== terminalId);
    ws.links = (ws.links || []).filter(l => l.from !== terminalId && l.to !== terminalId);
    if (ws.layout) {
      ws.layout = removeLayoutLeaf(ws.layout, terminalId);
    }
    // Clear layout entirely if no terminals left
    if (ws.terminalIds.length === 0) ws.layout = null;
  }
  stateManager.setWorkspaces(saved.workspaces);
}

/**
 * Subscribe to a terminal's output and exit events.
 * @param {object} terminal
 * @param {function} broadcast
 * @param {function} cleanupFn - called on terminal exit (receives terminal id)
 */
export function subscribeTerminalOutput(terminal, broadcast, cleanupFn) {
  terminal.onData((data) => {
    broadcast({ type: 'terminal:output', payload: { id: terminal.id, data } });
  });
  // Auto-cleanup when the process exits
  terminal.onExit((id) => {
    setTimeout(() => cleanupFn(id), 500);
  });
}

/**
 * Clean up a dead terminal: remove links, workspace references, destroy pty, broadcast.
 */
export function cleanupDeadTerminal(id, ptyManager, linkManager, stateManager, broadcast) {
  if (!ptyManager.get(id)) return;
  linkManager.removeTerminal(id);
  removeTerminalFromWorkspaces(stateManager, id);
  ptyManager.destroy(id);
  broadcast({ type: 'terminal:destroyed', payload: { id } });
  persistState(stateManager, ptyManager);
}

/**
 * Restore a previous session from saved state: reattach tmux sessions, restore links.
 * @param {object} stateManager
 * @param {object} ptyManager
 * @param {object} linkManager
 * @param {function} subscribeOutputFn - called as subscribeOutputFn(terminal) for each restored terminal
 */
export function restoreSession(stateManager, ptyManager, linkManager, subscribeOutputFn) {
  const loaded = stateManager.load();
  if (!loaded) return;

  const saved = stateManager.get();
  ptyManager.setNextId(saved.nextTerminalId || 1);

  const aliveSessions = ptyManager.listAliveTmuxSessions();
  let restored = 0;

  for (const savedTerm of (saved.terminals || [])) {
    const tmuxName = `termates-${savedTerm.id}`;
    if (aliveSessions.includes(tmuxName)) {
      const terminal = ptyManager.reattach({
        id: savedTerm.id,
        name: savedTerm.name,
        status: savedTerm.status,
        inTui: savedTerm.inTui,
      });
      if (terminal) {
        subscribeOutputFn(terminal);
        restored++;
      }
    }
  }

  // Restore links per workspace
  for (const ws of (saved.workspaces || [])) {
    for (const link of (ws.links || [])) {
      if (ptyManager.get(link.from) && ptyManager.get(link.to)) {
        linkManager.link(link.from, link.to);
      }
    }
  }

  if (restored > 0) {
    console.log(`  [restore] Reattached to ${restored} persistent terminal(s)`);
  }

  // Clean workspace state: remove terminal IDs that weren't restored
  const liveIds = new Set(ptyManager.list().map(t => t.id));
  const workspaces = stateManager.get().workspaces || [];
  for (const ws of workspaces) {
    ws.terminalIds = ws.terminalIds.filter(id => liveIds.has(id));
    ws.links = (ws.links || []).filter(l => liveIds.has(l.from) && liveIds.has(l.to));
    if (ws.terminalIds.length === 0) ws.layout = null;
  }
  stateManager.setWorkspaces(workspaces);
  stateManager.saveNow();
}

export function recordWorkspaceMessage(stateManager, from, to, text) {
  const saved = stateManager.get();
  const ws = saved.workspaces.find((workspace) =>
    (workspace.terminalIds || []).includes(from) && (workspace.terminalIds || []).includes(to));
  if (!ws) return null;

  const messageText = normalizeMessageText(text);
  if (!messageText.trim()) return null;

  const message = {
    id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
    text: messageText,
    timestamp: Date.now(),
  };

  ws.messages = [...(ws.messages || []), message].slice(-MAX_WORKSPACE_MESSAGES);
  stateManager.setWorkspaces(saved.workspaces);

  return { workspaceId: ws.id, message };
}

export function getMessagesForTerminal(stateManager, terminalId, limit = 50) {
  const messages = [];
  for (const ws of (stateManager.get().workspaces || [])) {
    for (const message of (ws.messages || [])) {
      if (message.from === terminalId || message.to === terminalId) {
        messages.push({ ...message, workspaceId: ws.id });
      }
    }
  }

  return messages
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-Math.max(1, limit));
}

function normalizeMessageText(text = '') {
  return text.replace(/\r?\n$/, '');
}

function isSameLink(left, right) {
  return (left.from === right.from && left.to === right.to)
    || (left.from === right.to && left.to === right.from);
}
