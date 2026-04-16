// ============================================
// Keyboard Shortcuts
// ============================================

import { S, activeWs, nextTermName } from './state.js';
import { send } from './transport.js';
import { showCreateDialog, showSendDialog } from './dialogs.js';
import { enterLinkMode, exitLinkMode, setActive, focusTerm } from './link-mode.js';
import { destroyTerminalLocally } from './events.js';
import { toggleBrowser } from './browser-panel.js';
import { showWorkspaceDialog } from './workspace.js';

export function setupKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey) {
      switch (e.key) {
        case 'T': e.preventDefault(); showCreateDialog(); break;
        case 'B': e.preventDefault(); toggleBrowser(); break;
        case 'H': e.preventDefault(); if (S.activeTerminalId) { S._splitDir = 'horizontal'; S._splitTarget = S.activeTerminalId; send('terminal:create', { name: nextTermName() }); } break;
        case 'V': e.preventDefault(); if (S.activeTerminalId) { S._splitDir = 'vertical'; S._splitTarget = S.activeTerminalId; send('terminal:create', { name: nextTermName() }); } break;
        case 'L': e.preventDefault(); S.linkMode ? exitLinkMode() : enterLinkMode(); break;
        case 'M': e.preventDefault(); showSendDialog(); break;
        case 'W': e.preventDefault(); if (S.activeTerminalId) { const _id = S.activeTerminalId; destroyTerminalLocally(_id); send('terminal:destroy', { id: _id }); } break;
        case 'N': e.preventDefault(); showWorkspaceDialog(); break;
      }
    }
    if (e.key === 'Escape' && S.linkMode) exitLinkMode();
    if (e.ctrlKey && e.shiftKey && (e.key === '[' || e.key === '{')) { e.preventDefault(); navTerminals(-1); }
    if (e.ctrlKey && e.shiftKey && (e.key === ']' || e.key === '}')) { e.preventDefault(); navTerminals(1); }
  });
}

export function navTerminals(dir) {
  const ws = activeWs();
  if (!ws?.terminalIds.length) return;
  const ids = ws.terminalIds;
  let idx = ids.indexOf(S.activeTerminalId) + dir;
  if (idx < 0) idx = ids.length - 1;
  if (idx >= ids.length) idx = 0;
  setActive(ids[idx]); focusTerm(ids[idx]);
}
