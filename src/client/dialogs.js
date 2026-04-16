// ============================================
// Dialogs
// ============================================

import { S, activeWs, nextTermName } from './state.js';
import { send } from './transport.js';
import { createWorkspace, showWorkspaceDialog } from './workspace.js';
import { destroyTerminalLocally } from './events.js';
import { showNotif } from './notifications.js';
import { getLinked } from './link-mode.js';

export function showCreateDialog() {
  const d = document.getElementById('create-dialog');
  const ws = activeWs();
  const isRemote = ws?.type === 'remote' || !!ws?.sshTarget;
  document.getElementById('create-name').value = nextTermName();
  document.getElementById('create-role').value = '';
  // Pre-fill working directory from workspace
  const cwdInput = document.getElementById('create-cwd');
  cwdInput.value = (isRemote ? ws?.remoteCwd : ws?.cwd) || '';
  // Hide browse button for remote workspaces
  document.getElementById('create-cwd-browse').classList.toggle('hidden', isRemote);
  d.showModal(); document.getElementById('create-name').focus(); document.getElementById('create-name').select();
}

export function showEditDialog(id) {
  const t = S.terminals.get(id);
  if (!t) return;
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-name').value = t.name;
  document.getElementById('edit-role').value = t.role || '';
  document.getElementById('edit-status').value = t.status || 'idle';
  document.getElementById('edit-dialog').showModal();
  document.getElementById('edit-name').focus(); document.getElementById('edit-name').select();
}

export function showSendDialog() {
  const ws = activeWs();
  if (!ws) return;

  const sources = ws.terminalIds.filter((terminalId) => getLinked(terminalId, ws).length > 0);
  if (sources.length === 0) {
    showNotif('Link terminals before sending messages', 'warning');
    return;
  }

  const sourceSelect = document.getElementById('send-source');
  sourceSelect.innerHTML = '';
  for (const id of sources) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = S.terminals.get(id)?.name || id;
    sourceSelect.appendChild(option);
  }

  const preferredSource = sources.includes(S.activeTerminalId) ? S.activeTerminalId : sources[0];
  sourceSelect.value = preferredSource;
  refreshSendTargets(preferredSource);

  document.getElementById('send-text').value = '';
  document.getElementById('send-with-enter').checked = true;
  document.getElementById('send-dialog').showModal();
  document.getElementById('send-text').focus();
}

export function setupDialogEvents() {
  // Send-to-linked dialog
  document.getElementById('send-source').addEventListener('change', (e) => refreshSendTargets(e.target.value));
  document.getElementById('send-confirm').addEventListener('click', () => {
    const from = document.getElementById('send-source').value;
    const to = document.getElementById('send-target').value;
    const textInput = document.getElementById('send-text');
    const rawText = textInput.value;
    if (!to) {
      showNotif('Select a linked target terminal', 'warning');
      return;
    }
    if (!rawText.trim()) {
      showNotif('Message cannot be empty', 'warning');
      return;
    }

    const payloadText = document.getElementById('send-with-enter').checked && !rawText.endsWith('\n')
      ? `${rawText}\n`
      : rawText;

    send('terminal:send-to-linked', { from, to, text: payloadText });
    document.getElementById('send-dialog').close();
  });
  document.getElementById('send-cancel').addEventListener('click', () => document.getElementById('send-dialog').close());
  document.getElementById('send-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('send-confirm').click();
    }
  });

  // Create dialog
  document.getElementById('create-confirm').addEventListener('click', () => {
    const name = document.getElementById('create-name').value.trim() || nextTermName();
    const role = document.getElementById('create-role').value || undefined;
    const cwd = document.getElementById('create-cwd').value.trim() || undefined;
    send('terminal:create', { name, role, cwd });
    document.getElementById('create-dialog').close();
  });
  document.getElementById('create-cancel').addEventListener('click', () => document.getElementById('create-dialog').close());
  document.getElementById('create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); document.getElementById('create-confirm').click(); } });

  // Edit terminal dialog
  document.getElementById('edit-confirm').addEventListener('click', () => {
    const id = document.getElementById('edit-id').value;
    const name = document.getElementById('edit-name').value.trim();
    const role = document.getElementById('edit-role').value;
    const status = document.getElementById('edit-status').value;
    if (id && name) {
      send('terminal:configure', { id, name, role: role || null });
      if (status) send('terminal:status', { id, status });
    }
    document.getElementById('edit-dialog').close();
  });
  document.getElementById('edit-cancel').addEventListener('click', () => document.getElementById('edit-dialog').close());
  document.getElementById('edit-delete').addEventListener('click', () => {
    const id = document.getElementById('edit-id').value;
    if (id) { destroyTerminalLocally(id); send('terminal:destroy', { id }); }
    document.getElementById('edit-dialog').close();
  });
  document.getElementById('edit-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('edit-confirm').click(); });

  // Workspace dialog
  document.querySelectorAll('input[name="ws-type"]').forEach(r => {
    r.addEventListener('change', () => {
      const isRemote = r.value === 'remote' && r.checked;
      document.getElementById('ws-ssh-fields').classList.toggle('hidden', !isRemote);
      document.getElementById('ws-local-fields').classList.toggle('hidden', isRemote);
    });
  });
  document.getElementById('ws-confirm').addEventListener('click', () => {
    const name = document.getElementById('ws-name').value.trim();
    const type = document.querySelector('input[name="ws-type"]:checked').value;
    const cwd = document.getElementById('ws-cwd').value.trim();
    const sshTarget = document.getElementById('ws-ssh-target').value.trim();
    const remoteCwd = document.getElementById('ws-remote-cwd').value.trim();
    if (type === 'remote' && !sshTarget) { showNotif('SSH target required for remote workspace', 'warning'); return; }
    createWorkspace(name, type, cwd || null, sshTarget || null, remoteCwd || null);
    document.getElementById('ws-dialog').close();
  });
  document.getElementById('ws-cancel').addEventListener('click', () => document.getElementById('ws-dialog').close());
  document.getElementById('ws-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); document.getElementById('ws-confirm').click(); } });

  // Browse buttons for directory selection
  document.getElementById('create-cwd-browse').addEventListener('click', () => browseFolder('create-cwd'));
  document.getElementById('ws-cwd-browse').addEventListener('click', () => browseFolder('ws-cwd'));
}

export async function browseFolder(inputId) {
  try {
    const res = await fetch('/api/browse-dialog', { method: 'POST' });
    const { path, error } = await res.json();
    if (path) {
      document.getElementById(inputId).value = path;
      return;
    }
    showNotif(error || 'Directory browsing is only available in the desktop app', 'warning');
  } catch (e) {
    showNotif('Directory browsing is only available in the desktop app', 'warning');
  }
}

function refreshSendTargets(sourceId) {
  const ws = activeWs();
  const targetSelect = document.getElementById('send-target');
  targetSelect.innerHTML = '';

  for (const id of getLinked(sourceId, ws)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = S.terminals.get(id)?.name || id;
    targetSelect.appendChild(option);
  }
}
