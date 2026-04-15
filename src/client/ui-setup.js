// ============================================
// UI Setup — wires all button click handlers
// ============================================

import { S, activeWs, nextTermName } from './state.js';
import { send } from './transport.js';
import { showCreateDialog } from './dialogs.js';
import { toggleBrowser, addBrowserTab, navigateBrowserTab, renderBrowserTabs, persistBrowser, setupBrowserResize } from './browser-panel.js';
import { enterLinkMode, exitLinkMode } from './link-mode.js';
import { showWorkspaceDialog, deleteWorkspace } from './workspace.js';
import { fitAll } from './layout/renderer.js';
import { showNotif } from './notifications.js';

export function setupUI() {
  document.addEventListener('contextmenu', (e) => e.preventDefault(), true);

  document.getElementById('btn-new-terminal').addEventListener('click', showCreateDialog);
  document.getElementById('btn-toggle-browser').addEventListener('click', () => toggleBrowser());
  document.getElementById('btn-link-mode').addEventListener('click', () => S.linkMode ? exitLinkMode() : enterLinkMode());
  document.getElementById('btn-cancel-link').addEventListener('click', exitLinkMode);
  document.getElementById('btn-new-workspace').addEventListener('click', () => showWorkspaceDialog());
  document.getElementById('btn-delete-workspace').addEventListener('click', () => {
    if (S.workspaces.length > 1 && confirm(`Delete "${activeWs()?.name}"? All terminals in it will be closed.`))
      deleteWorkspace(S.activeWorkspaceId);
  });

  document.getElementById('btn-split-h').addEventListener('click', () => {
    if (S.activeTerminalId) { S._splitDir = 'horizontal'; S._splitTarget = S.activeTerminalId; send('terminal:create', { name: nextTermName() }); }
    else showCreateDialog();
  });
  document.getElementById('btn-split-v').addEventListener('click', () => {
    if (S.activeTerminalId) { S._splitDir = 'vertical'; S._splitTarget = S.activeTerminalId; send('terminal:create', { name: nextTermName() }); }
    else showCreateDialog();
  });

  // Browser panel
  document.getElementById('btn-add-browser-tab').addEventListener('click', () => addBrowserTab());
  document.getElementById('btn-close-browser').addEventListener('click', () => toggleBrowser(false));
  document.getElementById('browser-url').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      let url = e.target.value.trim(); if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) { url = 'https://' + url; e.target.value = url; }
      const tab = S.browserTabs[S.activeBrowserTab];
      if (tab) { tab.url = url; try { tab.title = new URL(url).hostname; } catch (er) {} }
      navigateBrowserTab(); renderBrowserTabs(); persistBrowser();
    }
  });
  document.getElementById('browser-back').addEventListener('click', () => { try { document.querySelector('#browser-content iframe')?.contentWindow.history.back(); } catch (e) {} });
  document.getElementById('browser-fwd').addEventListener('click', () => { try { document.querySelector('#browser-content iframe')?.contentWindow.history.forward(); } catch (e) {} });
  document.getElementById('browser-refresh').addEventListener('click', () => navigateBrowserTab());

  setupBrowserResize();
  window.addEventListener('resize', fitAll);
  // Force redraw when app regains focus (fixes WebGL artifacts from background suspension)
  window.addEventListener('focus', () => {
    for (const [, t] of S.terminals) {
      try { t.xterm.refresh(0, t.xterm.rows - 1); } catch (e) {}
    }
  });
  new ResizeObserver(fitAll).observe(document.getElementById('layout-root'));
}
