// ============================================
// Link Mode
// ============================================

import { S } from './state.js';
import { send } from './transport.js';
import { updateSidebar } from './sidebar.js';
import { showNotif } from './notifications.js';

export function setActive(id) {
  S.activeTerminalId = id;
  document.querySelectorAll('.terminal-panel').forEach(p => p.classList.remove('focused'));
  if (id) {
    document.querySelector(`[data-tid="${id}"]`)?.classList.add('focused');
    document.getElementById('active-terminal-name').textContent = S.terminals.get(id)?.name || '';
  } else {
    document.getElementById('active-terminal-name').textContent = '';
  }
  updateSidebar();
}

export function focusTerm(id) { S.terminals.get(id)?.xterm.focus(); }

export function enterLinkMode() { S.linkMode = true; S.linkSource = null; document.getElementById('link-mode-overlay').classList.remove('hidden'); document.getElementById('btn-link-mode').classList.add('active'); updateSidebar(); }
export function exitLinkMode() { S.linkMode = false; S.linkSource = null; document.getElementById('link-mode-overlay').classList.add('hidden'); document.getElementById('btn-link-mode').classList.remove('active'); updateSidebar(); }

export function handleLinkClick(id) {
  if (!S.linkSource) { S.linkSource = id; showNotif(`Selected "${S.terminals.get(id)?.name}". Click another.`, 'attention'); }
  else if (S.linkSource !== id) {
    send('terminal:link', { from: S.linkSource, to: id });
    showNotif(`Linked "${S.terminals.get(S.linkSource)?.name}" \u2194 "${S.terminals.get(id)?.name}"`, 'success');
    exitLinkMode();
  }
}

export function isLinked(id, ws) { return (ws?.links || []).some(l => l.from === id || l.to === id); }
export function getLinked(id, ws) { const r = []; for (const l of (ws?.links || [])) { if (l.from === id) r.push(l.to); else if (l.to === id) r.push(l.from); } return r; }
