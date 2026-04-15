// ============================================
// Workspace Management
// ============================================

import { S, activeWs, persistWorkspaces } from './state.js';
import { send } from './transport.js';
import { updateSidebar } from './sidebar.js';
import { renderLayout, fitAll } from './layout/renderer.js';
import { showNotif } from './notifications.js';
import { destroyTerminalLocally } from './events.js';
import { setActive } from './link-mode.js';

export function switchWorkspace(wsId) {
  if (S.activeWorkspaceId === wsId) return;
  S.activeWorkspaceId = wsId;
  S.activeTerminalId = null;
  renderLayout();
  updateSidebar();
  const ws = activeWs();
  if (ws?.terminalIds.length) setActive(ws.terminalIds[0]);
  persistWorkspaces();
  // Fit terminals after switch
  setTimeout(fitAll, 100);
}

export function createWorkspace(name, type, cwd, sshTarget, remoteCwd) {
  const id = `w${S.nextWorkspaceId++}`;
  S.workspaces.push({
    id, name: name || `Workspace ${S.workspaces.length + 1}`,
    terminalIds: [], links: [], layout: null,
    type: type || 'local', cwd: cwd || null,
    sshTarget: sshTarget || null, remoteCwd: remoteCwd || null,
  });
  switchWorkspace(id);
  persistWorkspaces();
}

export function showWorkspaceDialog() {
  const d = document.getElementById('ws-dialog');
  document.getElementById('ws-name').value = '';
  document.querySelector('input[name="ws-type"][value="local"]').checked = true;
  document.getElementById('ws-local-fields').classList.remove('hidden');
  document.getElementById('ws-ssh-fields').classList.add('hidden');
  document.getElementById('ws-cwd').value = '';
  document.getElementById('ws-ssh-target').value = '';
  document.getElementById('ws-remote-cwd').value = '';
  // Load SSH hosts
  loadSSHHosts();
  d.showModal();
  document.getElementById('ws-name').focus();
}

export async function loadSSHHosts() {
  try {
    const res = await fetch('/api/ssh/hosts');
    const { hosts } = await res.json();
    const dl = document.getElementById('ssh-hosts-list');
    dl.innerHTML = '';
    for (const h of hosts) {
      const opt = document.createElement('option');
      opt.value = h.user ? `${h.user}@${h.host}` : h.host;
      dl.appendChild(opt);
    }
  } catch (e) { /* silent */ }
}

export function renameWorkspace(wsId, name) {
  const ws = S.workspaces.find(w => w.id === wsId);
  if (ws) { ws.name = name; updateSidebar(); persistWorkspaces(); }
}

export function deleteWorkspace(wsId) {
  if (S.workspaces.length <= 1) { showNotif('Cannot delete the last workspace', 'warning'); return; }
  const ws = S.workspaces.find(w => w.id === wsId);
  if (!ws) return;
  // Destroy all terminals in this workspace
  for (const tid of [...ws.terminalIds]) {
    destroyTerminalLocally(tid); send('terminal:destroy', { id: tid });
  }
  S.workspaces = S.workspaces.filter(w => w.id !== wsId);
  if (S.activeWorkspaceId === wsId) {
    switchWorkspace(S.workspaces[0].id);
  }
  persistWorkspaces();
  updateSidebar();
}
