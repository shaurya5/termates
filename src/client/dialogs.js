// ============================================
// Dialogs
// ============================================

import {
  S,
  activeWs,
  nextTermName,
  DEFAULT_AGENT_PRESETS,
  normalizeAgentPresets,
  persistAgentPresets,
} from './state.js';
import { send } from './transport.js';
import { createWorkspace, showWorkspaceDialog } from './workspace.js';
import { destroyTerminalLocally } from './events.js';
import { showNotif } from './notifications.js';

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

export function showAgentPresetsDialog() {
  const presets = normalizeAgentPresets(S.agentPresets);
  document.getElementById('agent-claude-command').value = presets.claude.command;
  document.getElementById('agent-codex-command').value = presets.codex.command;
  document.getElementById('agent-presets-dialog').showModal();
  document.getElementById('agent-claude-command').focus();
}

export function setupDialogEvents() {
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

  // Agent presets dialog
  document.getElementById('agent-presets-save').addEventListener('click', () => {
    S.agentPresets = normalizeAgentPresets({
      claude: { command: document.getElementById('agent-claude-command').value },
      codex: { command: document.getElementById('agent-codex-command').value },
    });
    persistAgentPresets();
    refreshAgentPresetButtons();
    document.getElementById('agent-presets-dialog').close();
    showNotif('Agent presets saved', 'success');
  });
  document.getElementById('agent-presets-cancel').addEventListener('click', () => document.getElementById('agent-presets-dialog').close());
  document.getElementById('agent-presets-reset').addEventListener('click', () => {
    document.getElementById('agent-claude-command').value = DEFAULT_AGENT_PRESETS.claude.command;
    document.getElementById('agent-codex-command').value = DEFAULT_AGENT_PRESETS.codex.command;
  });

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

export function refreshAgentPresetButtons() {
  for (const button of document.querySelectorAll('.agent-launch-btn')) {
    const preset = S.agentPresets?.[button.dataset.agent];
    const hasCommand = !!preset?.command?.trim();
    const label = button.dataset.label || button.textContent.trim();
    const terminalId = button.closest('[data-tid]')?.dataset.tid;
    const inTui = terminalId ? !!S.terminals.get(terminalId)?.inTui : false;
    button.classList.toggle('is-empty', !hasCommand);
    button.disabled = inTui;
    button.title = !hasCommand
      ? `Configure ${label} preset`
      : inTui
        ? `Exit the running program before launching ${label}`
        : `Launch ${label}`;
  }
}
