// ============================================
// Layout Rendering
// ============================================

import { S, activeWs, persistWorkspaces, nextTermName } from '../state.js';
import { send } from '../transport.js';
import { setActive, isLinked, handleLinkClick } from '../link-mode.js';
import { showEditDialog } from '../dialogs.js';
import { updateSidebar } from '../sidebar.js';
import { splitInTree, buildBalancedLayout } from '../../../shared/layout-tree.js';
import { destroyTerminalLocally } from '../events.js';
import { showCreateDialog } from '../dialogs.js';

// ============================================
// Layout Rendering
// ============================================
export function addTerminalToLayout(id, ws) {
  ws = ws || activeWs();
  if (!ws) return;
  const manualDir = S._splitDir;
  const target = S._splitTarget;
  S._splitDir = null;
  S._splitTarget = null;

  if (manualDir && ws.layout && target && ws.terminalIds.includes(target)) {
    // User clicked Split H/V on a specific terminal — split THAT terminal
    ws.layout = splitInTree(ws.layout, target, manualDir, { type: 'leaf', panelId: id });
  } else {
    // Auto-add: rebuild balanced grid
    ws.layout = buildBalancedLayout(ws.terminalIds);
  }
  renderLayout();
  persistWorkspaces();
}

export function renderLayout() {
  const root = document.getElementById('layout-root');
  root.innerHTML = '';
  const ws = activeWs();
  // No workspace, no layout, or no terminals → welcome screen
  if (!ws || !ws.terminalIds.length) {
    if (ws) ws.layout = null;  // clear stale layout
    root.appendChild(createWelcome());
    return;
  }
  if (!ws.layout) { root.appendChild(createWelcome()); return; }
  root.appendChild(renderNode(ws.layout));
  requestAnimationFrame(() => {
    for (const tid of ws.terminalIds) {
      const t = S.terminals.get(tid);
      if (!t) continue;
      const c = document.querySelector(`[data-tid="${tid}"] .terminal-container`);
      if (c && !c.querySelector('.xterm')) {
        t.xterm.open(c);
        // Activate WebGL renderer after DOM attachment
        try { if (t.xterm._webglAddon) t.xterm.loadAddon(t.xterm._webglAddon); } catch (e) { /* WebGL unavailable, canvas fallback */ }
        t.fitAddon.fit();
        send('terminal:resize', { id: tid, cols: t.xterm.cols, rows: t.xterm.rows });
      }
    }
    fitAll();
  });
}

export function renderNode(n) {
  if (n.type === 'leaf') return createTermPanel(n.panelId);
  if (n.type === 'split') {
    const c = document.createElement('div');
    c.className = `split-container ${n.direction}`;
    const p1 = document.createElement('div'); p1.className = 'split-pane';
    const p2 = document.createElement('div'); p2.className = 'split-pane';
    if (n.direction === 'horizontal') {
      p1.style.width = `calc(${n.ratio * 100}% - 2px)`; p1.style.height = '100%';
      p2.style.width = `calc(${(1 - n.ratio) * 100}% - 2px)`; p2.style.height = '100%';
    } else {
      p1.style.height = `calc(${n.ratio * 100}% - 2px)`; p1.style.width = '100%';
      p2.style.height = `calc(${(1 - n.ratio) * 100}% - 2px)`; p2.style.width = '100%';
    }
    p1.appendChild(renderNode(n.children[0]));
    p2.appendChild(renderNode(n.children[1]));
    const h = document.createElement('div');
    h.className = `resize-handle ${n.direction}`;
    setupResize(h, n, p1, p2);
    c.appendChild(p1); c.appendChild(h); c.appendChild(p2);
    return c;
  }
  return document.createElement('div');
}

export function setupResize(handle, node, p1, p2) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const start = node.direction === 'horizontal' ? e.clientX : e.clientY;
    const startR = node.ratio;
    const size = node.direction === 'horizontal' ? handle.parentElement.offsetWidth : handle.parentElement.offsetHeight;
    const move = (e) => {
      const cur = node.direction === 'horizontal' ? e.clientX : e.clientY;
      node.ratio = Math.max(0.1, Math.min(0.9, startR + (cur - start) / size));
      if (node.direction === 'horizontal') {
        p1.style.width = `calc(${node.ratio * 100}% - 2px)`;
        p2.style.width = `calc(${(1 - node.ratio) * 100}% - 2px)`;
      } else {
        p1.style.height = `calc(${node.ratio * 100}% - 2px)`;
        p2.style.height = `calc(${(1 - node.ratio) * 100}% - 2px)`;
      }
      fitAll();
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      fitAll(); persistWorkspaces();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  });
}

// ============================================
// Terminal Panel
// ============================================
export function createTermPanel(id) {
  const t = S.terminals.get(id);
  if (!t) return document.createElement('div');
  const ws = activeWs();
  const panel = document.createElement('div');
  panel.className = 'terminal-panel';
  panel.dataset.tid = id;
  if (t.status !== 'idle') panel.classList.add(`status-${t.status}`);
  if (ws && isLinked(id, ws)) panel.classList.add('linked');

  const hdr = document.createElement('div'); hdr.className = 'panel-header';
  const dot = document.createElement('span'); dot.className = `panel-dot terminal-status-dot ${t.status}`;
  const nm = document.createElement('span'); nm.className = 'panel-name'; nm.textContent = t.name;
  hdr.appendChild(dot); hdr.appendChild(nm);
  if (t.role) { const b = document.createElement('span'); b.className = `panel-role terminal-role-badge ${t.role}`; b.textContent = t.role; hdr.appendChild(b); }

  const acts = document.createElement('div'); acts.className = 'panel-actions';
  const mkSvgBtn = (svg, fn, cls, title) => {
    const b = document.createElement('button'); b.className = 'panel-action-btn' + (cls ? ' ' + cls : '');
    b.innerHTML = svg; if (title) b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b;
  };
  const mkBtn = (lbl, fn) => { const b = document.createElement('button'); b.className = 'panel-action-btn'; b.textContent = lbl; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
  acts.appendChild(mkSvgBtn('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', () => showEditDialog(id), '', 'Configure'));
  acts.appendChild(mkBtn('Split H', () => { S._splitDir = 'horizontal'; S._splitTarget = id; send('terminal:create', { name: nextTermName() }); }));
  acts.appendChild(mkBtn('Split V', () => { S._splitDir = 'vertical'; S._splitTarget = id; send('terminal:create', { name: nextTermName() }); }));
  acts.appendChild(mkSvgBtn('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>', () => { destroyTerminalLocally(id); send('terminal:destroy', { id }); }, 'close', 'Close'));
  hdr.appendChild(acts);

  const container = document.createElement('div'); container.className = 'terminal-container';
  panel.appendChild(hdr); panel.appendChild(container);
  panel.addEventListener('mousedown', () => {
    setActive(id);
    if (S.linkMode) handleLinkClick(id);
  });
  return panel;
}

export function fitAll() {
  const ws = activeWs();
  if (!ws) return;
  for (const tid of ws.terminalIds) {
    const t = S.terminals.get(tid);
    if (!t) continue;
    try { t.fitAddon.fit(); send('terminal:resize', { id: tid, cols: t.xterm.cols, rows: t.xterm.rows }); } catch (e) {}
  }
}

export function updatePanelStatus(id) {
  const t = S.terminals.get(id);
  const p = document.querySelector(`[data-tid="${id}"]`);
  if (!t || !p) return;
  p.classList.remove('status-attention', 'status-success', 'status-warning', 'status-error');
  if (t.status !== 'idle') p.classList.add(`status-${t.status}`);
  const dot = p.querySelector('.panel-dot');
  if (dot) dot.className = `panel-dot terminal-status-dot ${t.status}`;
}

export function updateLinked() {
  const ws = activeWs();
  if (!ws) return;
  for (const tid of ws.terminalIds) {
    const p = document.querySelector(`[data-tid="${tid}"]`);
    if (p) p.classList.toggle('linked', isLinked(tid, ws));
  }
}

export function createWelcome() {
  const el = document.createElement('div');
  el.className = 'welcome-screen';
  el.innerHTML = `
    <div class="welcome-icon">&#x2B21;</div>
    <div class="welcome-title">Termates</div>
    <p style="color: var(--text-secondary); max-width: 420px; text-align: center; line-height: 1.5;">
      On-device terminal multiplexer with persistent sessions and workspaces.
      Terminals backed by tmux survive restarts.
    </p>
    <div class="welcome-shortcuts">
      <kbd>Ctrl+Shift+T</kbd> <span>New Terminal</span>
      <kbd>Ctrl+Shift+B</kbd> <span>Toggle Browser</span>
      <kbd>Ctrl+Shift+H</kbd> <span>Split Horizontal</span>
      <kbd>Ctrl+Shift+V</kbd> <span>Split Vertical</span>
      <kbd>Ctrl+Shift+N</kbd> <span>New Workspace</span>
    </div>`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary'; btn.style.marginTop = '12px';
  btn.textContent = 'Create First Terminal';
  btn.addEventListener('click', () => showCreateDialog());
  el.appendChild(btn);
  return el;
}
