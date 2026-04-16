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
import { reconcileWorkspacesWithTerminals, removeTerminalFromWorkspaceState } from './workspace-state.js';

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
    case 'terminal:message-sent': onMessageSent(msg.payload); break;
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
  S.workspaces = removeTerminalFromWorkspaceState(S.workspaces, id);
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

export function onMessageSent(payload) {
  const targetWorkspace = payload.workspaceId
    ? S.workspaces.find((workspace) => workspace.id === payload.workspaceId)
    : S.workspaces.find((workspace) =>
      (workspace.terminalIds || []).includes(payload.from) && (workspace.terminalIds || []).includes(payload.to));
  if (!targetWorkspace) return;

  targetWorkspace.messages = targetWorkspace.messages || [];
  if (!targetWorkspace.messages.some((message) => message.id && message.id === payload.id)) {
    targetWorkspace.messages.push({
      id: payload.id || `${payload.timestamp}-${payload.from}-${payload.to}`,
      from: payload.from,
      to: payload.to,
      text: payload.text,
      timestamp: payload.timestamp,
    });
    if (targetWorkspace.messages.length > 200) {
      targetWorkspace.messages = targetWorkspace.messages.slice(-200);
    }
  }

  updateSidebar();
  const fromName = S.terminals.get(payload.from)?.name || payload.from;
  const toName = S.terminals.get(payload.to)?.name || payload.to;
  const preview = String(payload.text || '').replace(/\s+/g, ' ').trim();
  showNotif(`${fromName} -> ${toName}: ${preview}`, 'attention');
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
  }

  S.workspaces = reconcileWorkspacesWithTerminals(S.workspaces, terminals || [], S.activeWorkspaceId);

  renderLayout();
  updateSidebar();
  const ws = activeWs();
  if (ws?.terminalIds.length) setActive(ws.terminalIds[0]);
  if (S.browserOpen) toggleBrowser(true);
  renderBrowserTabs();

  // Fit all terminals after layout is rendered — buffer content already sent by server
  setTimeout(() => fitAll(), 500);
}
