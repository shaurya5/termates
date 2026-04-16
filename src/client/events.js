// ============================================
// Server Event Handlers
// ============================================

import { S, activeWs, persistWorkspaces, normalizeAgentPresets } from './state.js';
import { createXterm } from './terminal-factory.js';
import { send } from './transport.js';
import { updateSidebar } from './sidebar.js';
import { renderLayout, fitAll, addTerminalToLayout, updatePanelStatus, updateLinked, forgetContainer } from './layout/renderer.js';
import { setActive } from './link-mode.js';
import { toggleBrowser, renderBrowserTabs } from './browser-panel.js';
import { showNotif } from './notifications.js';
import { reconcileWorkspacesWithTerminals, removeTerminalFromWorkspaceState } from './workspace-state.js';
import { refreshAgentPresetButtons } from './dialogs.js';

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
    case 'terminal:tui-state': onTuiState(msg.payload); break;
    case 'terminal:notification': onNotif(msg.payload); break;
    case 'settings:updated': onSettingsUpdated(msg.payload); break;
    case 'terminal:list': onList(msg.payload); break;
  }
}

export function onCreated({ id, name, role, status, inTui }) {
  if (S.terminals.has(id)) return;
  const { xterm, fitAddon } = createXterm(id);
  const terminal = { id, name, role, status: status || 'idle', inTui: !!inTui, xterm, fitAddon };
  S.terminals.set(id, terminal);
  // Add to active workspace
  const ws = activeWs();
  if (ws && !ws.terminalIds.includes(id)) {
    ws.terminalIds.push(id);
    addTerminalToLayout(id, ws);
    persistWorkspaces();
  }
  updateSidebar();
  setActive(id);
  refreshAgentPresetButtons();
}

export function onOutput({ id, data }) {
  const terminal = S.terminals.get(id);
  if (!terminal) return;
  // Gate on `_opened` (set by mountWhenSized only AFTER it has finished fit +
  // restore + queue-flush), NOT on xterm.element. Checking .element would let
  // live bytes jump ahead of still-queued writes during the brief window
  // between xterm.open() and the queue flush — the writes would then hit
  // xterm in the wrong order and the cursor would drift.
  if (!terminal._opened) {
    (terminal._pendingWrites ||= []).push(data);
    return;
  }
  terminal.xterm.write(data);
}

export function destroyTerminalLocally(id) {
  const t = S.terminals.get(id);
  if (t) {
    try { t._resizeObserver?.disconnect(); } catch (e) {}
    try { t.xterm.dispose(); } catch (e) { /* WebGL context may already be lost */ }
    S.terminals.delete(id);
  }
  forgetContainer(id);
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
  if (!t) return;
  if (name !== undefined) t.name = name;
  if (role !== undefined) t.role = role;
  // Surgical DOM update — rebuilding the whole layout on a rename was tearing
  // down every xterm in every pane, which is what produced the global flicker.
  const panel = document.querySelector(`[data-tid="${id}"]`);
  if (panel) {
    const nm = panel.querySelector('.panel-name');
    if (nm && name !== undefined) nm.textContent = t.name;
    if (role !== undefined) {
      const oldBadge = panel.querySelector('.panel-role');
      if (oldBadge) oldBadge.remove();
      if (t.role) {
        const hdr = panel.querySelector('.panel-header');
        const launchers = panel.querySelector('.panel-launchers');
        const badge = document.createElement('span');
        badge.className = `panel-role terminal-role-badge ${t.role}`;
        badge.textContent = t.role;
        if (hdr && launchers) hdr.insertBefore(badge, launchers);
      }
    }
  }
  updateSidebar();
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

export function onTuiState({ id, inTui }) {
  const t = S.terminals.get(id);
  if (!t) return;
  t.inTui = !!inTui;
  refreshAgentPresetButtons();
}

export function onNotif({ id, status, text }) {
  const t = S.terminals.get(id);
  if (t) { t.status = status; updateSidebar(); updatePanelStatus(id); showNotif(`${t.name}: ${text || status}`, status); }
}

export function onSettingsUpdated({ agentPresets }) {
  S.agentPresets = normalizeAgentPresets(agentPresets);
  refreshAgentPresetButtons();
}

export function onList({ terminals, workspaces, activeWorkspaceId, nextWorkspaceId, browserTabs, activeBrowserTab, browserOpen, browserWidth, agentPresets }) {
  if (browserTabs?.length) { S.browserTabs = browserTabs; S.activeBrowserTab = activeBrowserTab || 0; }
  if (browserOpen) S.browserOpen = true;
  if (browserWidth) S.browserWidth = browserWidth;
  S.agentPresets = normalizeAgentPresets(agentPresets);

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
      const terminal = {
        id: t.id, name: t.name, role: t.role,
        status: t.status || 'idle',
        inTui: !!t.inTui,
        xterm, fitAddon,
      };
      S.terminals.set(t.id, terminal);
    }
  }

  S.workspaces = reconcileWorkspacesWithTerminals(S.workspaces, terminals || [], S.activeWorkspaceId);

  renderLayout();
  updateSidebar();
  refreshAgentPresetButtons();
  const ws = activeWs();
  if (ws?.terminalIds.length) setActive(ws.terminalIds[0]);
  if (S.browserOpen) toggleBrowser(true);
  renderBrowserTabs();

  // renderLayout's rAF opens + fits + resizes + flushes pending writes per terminal.
  // No arbitrary timer — the old 500ms delay was masking a mount/resize race.
}
