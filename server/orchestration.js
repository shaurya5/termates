import { removeLayoutLeaf } from '../shared/layout-tree.js';

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
        role: savedTerm.role,
        status: savedTerm.status,
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
