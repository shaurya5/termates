// ============================================
// Server Event Handlers
// ============================================

import { S, activeWs, persistWorkspaces } from './state.js';
import { createXterm } from './terminal-factory.js';
import { send } from './transport.js';
import { updateSidebar } from './sidebar.js';
import { renderLayout, fitAll, addTerminalToLayout, updatePanelStatus, updateLinked } from './layout/renderer.js';
import { setActive } from './link-mode.js';
import { toggleBrowser, renderBrowserTabs } from './browser-panel.js';
import { showNotif } from './notifications.js';
import { buildBalancedLayout } from '../../shared/layout-tree.js';

export function handleMsg(msg) {
  switch (msg.type) {
    case 'terminal:created': onCreated(msg.payload); break;
    case 'terminal:output': onOutput(msg.payload); break;
    case 'terminal:destroyed': onDestroyed(msg.payload); break;
    case 'terminal:configured': onConfigured(msg.payload); break;
    case 'terminal:renamed': onConfigured(msg.payload); break;
    case 'terminal:linked': onLinked(msg.payload); break;
    case 'terminal:unlinked': onUnlinked(msg.payload); break;
    case 'terminal:status-changed': onStatusChanged(msg.payload); break;
    case 'terminal:notification': onNotif(msg.payload); break;
    case 'terminal:list': onList(msg.payload); break;
  }
}

export function onCreated({ id, name, role, status }) {
  if (S.terminals.has(id)) return;
  const { xterm, fitAddon } = createXterm(id);
  S.terminals.set(id, { id, name, role, status: status || 'idle', xterm, fitAddon });
  // Add to active workspace
  const ws = activeWs();
  if (ws && !ws.terminalIds.includes(id)) {
    ws.terminalIds.push(id);
    addTerminalToLayout(id, ws);
    persistWorkspaces();
  }
  updateSidebar();
  setActive(id);
}

export function onOutput({ id, data }) { S.terminals.get(id)?.xterm.write(data); }

export function destroyTerminalLocally(id) {
  const t = S.terminals.get(id);
  if (t) {
    try { t.xterm.dispose(); } catch (e) { /* WebGL context may already be lost */ }
    S.terminals.delete(id);
  }
  for (const ws of S.workspaces) {
    ws.terminalIds = ws.terminalIds.filter(tid => tid !== id);
    ws.links = ws.links.filter(l => l.from !== id && l.to !== id);
    ws.layout = buildBalancedLayout(ws.terminalIds);
  }
  persistWorkspaces();
  renderLayout();
  updateSidebar();
  if (S.activeTerminalId === id) {
    const ws = activeWs();
    setActive(ws?.terminalIds[0] || null);
  }
}

export function onDestroyed({ id }) {
  destroyTerminalLocally(id);
}

export function onConfigured({ id, name, role }) {
  const t = S.terminals.get(id);
  if (t) {
    if (name !== undefined) t.name = name;
    if (role !== undefined) t.role = role;
    updateSidebar();
    renderLayout();
  }
}

export function onLinked({ from, to }) {
  const ws = activeWs();
  if (ws && !ws.links.some(l => (l.from === from && l.to === to) || (l.from === to && l.to === from))) {
    ws.links.push({ from, to });
    persistWorkspaces();
  }
  updateSidebar(); updateLinked();
}

export function onUnlinked({ from, to }) {
  const ws = activeWs();
  if (ws) {
    ws.links = ws.links.filter(l => !((l.from === from && l.to === to) || (l.from === to && l.to === from)));
    persistWorkspaces();
  }
  updateSidebar(); updateLinked();
}

export function onStatusChanged({ id, status }) {
  const t = S.terminals.get(id);
  if (t) { t.status = status; updateSidebar(); updatePanelStatus(id); }
}

export function onNotif({ id, status, text }) {
  const t = S.terminals.get(id);
  if (t) { t.status = status; updateSidebar(); updatePanelStatus(id); showNotif(`${t.name}: ${text || status}`, status); }
}

export function onList({ terminals, workspaces, activeWorkspaceId, nextWorkspaceId, browserTabs, activeBrowserTab, browserOpen, browserWidth }) {
  if (browserTabs?.length) { S.browserTabs = browserTabs; S.activeBrowserTab = activeBrowserTab || 0; }
  if (browserOpen) S.browserOpen = true;
  if (browserWidth) S.browserWidth = browserWidth;

  // Restore workspaces
  if (workspaces?.length) {
    S.workspaces = workspaces;
    S.activeWorkspaceId = activeWorkspaceId || workspaces[0].id;
    S.nextWorkspaceId = nextWorkspaceId || 2;
  } else {
    S.workspaces = [{ id: 'w1', name: 'Workspace 1', terminalIds: [], links: [], layout: null }];
    S.activeWorkspaceId = 'w1';
  }

  // Restore terminals
  if (terminals?.length && S.terminals.size === 0) {
    for (const t of terminals) {
      const { xterm, fitAddon } = createXterm(t.id);
      S.terminals.set(t.id, { id: t.id, name: t.name, role: t.role, status: t.status || 'idle', xterm, fitAddon });
    }
    // Prune workspace terminalIds to only existing terminals, rebuild layouts
    const existingIds = new Set(terminals.map(t => t.id));
    for (const ws of S.workspaces) {
      ws.terminalIds = ws.terminalIds.filter(id => existingIds.has(id));
      ws.links = ws.links.filter(l => existingIds.has(l.from) && existingIds.has(l.to));
      // Always rebuild balanced layout from current terminal list
      ws.layout = buildBalancedLayout(ws.terminalIds);
    }
    // Check for orphaned terminals
    const assigned = new Set(S.workspaces.flatMap(w => w.terminalIds));
    const orphans = terminals.filter(t => !assigned.has(t.id));
    if (orphans.length) {
      const ws = activeWs();
      for (const t of orphans) ws.terminalIds.push(t.id);
      ws.layout = buildBalancedLayout(ws.terminalIds);
    }
  }

  renderLayout();
  updateSidebar();
  const ws = activeWs();
  if (ws?.terminalIds.length) setActive(ws.terminalIds[0]);
  if (S.browserOpen) toggleBrowser(true);
  renderBrowserTabs();

  // Fit all terminals after layout is rendered — buffer content already sent by server
  setTimeout(() => fitAll(), 500);
}
