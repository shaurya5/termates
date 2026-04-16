// ============================================
// Sidebar
// ============================================

import { S, activeWs } from './state.js';
import { send } from './transport.js';
import { isLinked } from './link-mode.js';
import { setActive, focusTerm, handleLinkClick } from './link-mode.js';
import { switchWorkspace, renameWorkspace } from './workspace.js';
import { destroyTerminalLocally } from './events.js';
import { showEditDialog } from './dialogs.js';

export function updateSidebar() {
  // Workspace tabs
  const wsTabs = document.getElementById('workspace-tabs');
  wsTabs.innerHTML = '';
  for (const ws of S.workspaces) {
    const tab = document.createElement('button');
    tab.className = 'ws-tab' + (ws.id === S.activeWorkspaceId ? ' active' : '');
    if (ws.type === 'remote' || ws.sshTarget) {
      const dot = document.createElement('span'); dot.className = 'ws-remote-dot'; tab.appendChild(dot);
    }
    tab.appendChild(document.createTextNode(ws.name));
    tab.addEventListener('click', () => switchWorkspace(ws.id));
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      // Replace tab with inline input
      const input = document.createElement('input');
      input.className = 'ws-tab-input';
      input.value = ws.name;
      input.style.width = Math.max(60, tab.offsetWidth) + 'px';
      tab.replaceWith(input);
      input.focus(); input.select();
      const commit = () => {
        const name = input.value.trim();
        if (name && name !== ws.name) renameWorkspace(ws.id, name);
        updateSidebar(); // Re-render tabs
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = ws.name; input.blur(); }
        e.stopPropagation();
      });
    });
    wsTabs.appendChild(tab);
  }

  // Terminal list for active workspace
  const ws = activeWs();
  const tl = document.getElementById('terminal-list');
  tl.innerHTML = '';
  if (ws) {
    for (const tid of ws.terminalIds) {
      const t = S.terminals.get(tid);
      if (!t) continue;
      const li = document.createElement('li');
      li.className = 'panel-list-item' + (tid === S.activeTerminalId ? ' active' : '') + (S.linkMode ? ' link-select-mode' : '');
      const dot = document.createElement('span'); dot.className = `terminal-status-dot ${t.status}`;
      const nm = document.createElement('span'); nm.className = 'terminal-name'; nm.textContent = t.name;
      li.appendChild(dot); li.appendChild(nm);
      if (isLinked(tid, ws)) { const ld = document.createElement('span'); ld.className = 'link-indicator'; li.appendChild(ld); }
      if (t.role) { const b = document.createElement('span'); b.className = `terminal-role-badge ${t.role}`; b.textContent = t.role; li.appendChild(b); }
      const eb = document.createElement('button'); eb.className = 'edit-btn';
      eb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      eb.title = 'Configure'; eb.addEventListener('click', (e) => { e.stopPropagation(); showEditDialog(tid); }); li.appendChild(eb);
      const cb = document.createElement('button'); cb.className = 'close-btn';
      cb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      cb.addEventListener('click', (e) => { e.stopPropagation(); destroyTerminalLocally(tid); send('terminal:destroy', { id: tid }); }); li.appendChild(cb);
      li.addEventListener('click', () => { if (S.linkMode) handleLinkClick(tid); else { setActive(tid); focusTerm(tid); } });
      li.addEventListener('dblclick', (e) => { e.preventDefault(); showEditDialog(tid); });
      tl.appendChild(li);
    }
  }
  if (!ws?.terminalIds.length) { const e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No terminals'; tl.appendChild(e); }

  // Link list
  const ll = document.getElementById('link-list');
  ll.innerHTML = '';
  const links = ws?.links || [];
  for (const link of links) {
    const f = S.terminals.get(link.from), t = S.terminals.get(link.to);
    if (!f || !t) continue;
    const li = document.createElement('li'); li.className = 'link-list-item';
    li.innerHTML = `<span>${f.name}</span><span class="link-line"> \u2194 </span><span>${t.name}</span>`;
    const ub = document.createElement('button'); ub.className = 'unlink-btn'; ub.textContent = 'unlink';
    ub.addEventListener('click', () => send('terminal:unlink', { from: link.from, to: link.to }));
    li.appendChild(ub); ll.appendChild(li);
  }
  if (!links.length) { const e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No linked terminals'; ll.appendChild(e); }

  // Message list
  const ml = document.getElementById('message-list');
  ml.innerHTML = '';
  const messages = ws?.messages || [];
  const recentMessages = messages.slice(-8).reverse();
  for (const message of recentMessages) {
    const fromName = S.terminals.get(message.from)?.name || message.from;
    const toName = S.terminals.get(message.to)?.name || message.to;
    const li = document.createElement('li');
    li.className = 'message-list-item';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `${fromName} -> ${toName} · ${formatMessageTime(message.timestamp)}`;

    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = (message.text || '').trimEnd();

    li.appendChild(meta);
    li.appendChild(body);
    ml.appendChild(li);
  }
  if (!recentMessages.length) { const e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No messages yet'; ml.appendChild(e); }

  // Workspace info panel
  const info = document.getElementById('ws-info');
  info.innerHTML = '';
  if (ws) {
    const isRemote = ws.type === 'remote' || !!ws.sshTarget;
    const addRow = (label, value) => {
      if (!value) return;
      const row = document.createElement('div'); row.className = 'ws-info-row';
      row.innerHTML = `<span class="ws-info-label">${label}</span><span class="ws-info-value">${value}</span>`;
      info.appendChild(row);
    };
    addRow('Type', isRemote ? 'Remote (SSH)' : 'Local');
    if (isRemote) addRow('Host', ws.sshTarget);
    if (isRemote && ws.remoteCwd) addRow('Dir', ws.remoteCwd);
    if (!isRemote && ws.cwd) addRow('Dir', ws.cwd);
    addRow('Terminals', String(ws.terminalIds.length));
  }
}

function formatMessageTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}
