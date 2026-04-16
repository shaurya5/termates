// ============================================
// Layout Rendering
// ============================================

import { S, activeWs, persistWorkspaces, nextTermName } from '../state.js';
import { send } from '../transport.js';
import { setActive, isLinked, handleLinkClick } from '../link-mode.js';
import { showAgentPresetsDialog, showEditDialog, refreshAgentPresetButtons } from '../dialogs.js';
import { updateSidebar } from '../sidebar.js';
import { splitInTree, buildBalancedLayout } from '../../../shared/layout-tree.js';
import { destroyTerminalLocally } from '../events.js';
import { showCreateDialog } from '../dialogs.js';
import { showNotif } from '../notifications.js';

// Reuse the same <div.terminal-container> (and the xterm DOM inside it) across
// every renderLayout call. The layout tree is rebuilt from scratch on each
// render; without this cache, every create/destroy/split re-opened xterm into a
// fresh node, which re-initialised the WebGL atlas and lost rendering state.
const containerCache = new Map(); // tid -> HTMLElement

export function forgetContainer(id) {
  containerCache.delete(id);
}

function getOrCreateContainer(id) {
  let c = containerCache.get(id);
  if (!c) {
    c = document.createElement('div');
    c.className = 'terminal-container';
    containerCache.set(id, c);
  }
  return c;
}

// Open xterm once the container has real pixel dimensions, then: fit, restore
// scrollback (shell only — never for a TUI), flush queued writes, and finally
// flip `_opened` so new writes bypass the queue. Order matters: if we set
// `_opened` earlier, live bytes arriving via onOutput would race the queue
// flush and desync the cursor.
function mountWhenSized(t, c, tid, attempt = 0) {
  const hasSize = c.clientWidth > 0 && c.clientHeight > 0;
  if (!hasSize && attempt < 30) {
    // ~500ms total retry budget; still opens after that, but we attach a
    // ResizeObserver below so a later layout fires a fit when the container
    // finally gets real dimensions (e.g. workspace switched in).
    requestAnimationFrame(() => mountWhenSized(t, c, tid, attempt + 1));
    return;
  }
  t.xterm.open(c);
  try {
    t.fitAddon.fit();
    send('terminal:resize', { id: tid, cols: t.xterm.cols, rows: t.xterm.rows });
  } catch (e) {}
  // No scrollback restore. Writing a serialized snapshot into a fresh xterm
  // while the live PTY stream is still going was producing overlap/cursor
  // desync in both shell and TUI panes — saved bytes and live bytes would
  // land on conflicting rows. If we want scrollback across reloads back as a
  // feature, it needs a different design (e.g. server-side byte log replayed
  // at the right size with the live stream paused). Reload now shows only
  // current-screen state from the SIGWINCH + Ctrl+L nudge; for deeper
  // history, Claude Code has its own in-UI scrolling (Ctrl+O to expand).
  // Drain the queue exactly once. onOutput is still gated on `_opened` so new
  // bytes keep landing in _pendingWrites while we drain.
  const queue = t._pendingWrites;
  t._pendingWrites = null;
  if (queue?.length) {
    for (const chunk of queue) {
      try { t.xterm.write(chunk); } catch (e) {}
    }
  }
  // Any bytes that arrived while we were draining went into a freshly-
  // allocated queue. Move them across now.
  const lateQueue = t._pendingWrites;
  t._pendingWrites = null;
  if (lateQueue?.length) {
    for (const chunk of lateQueue) {
      try { t.xterm.write(chunk); } catch (e) {}
    }
  }
  // Now live writes can go straight through.
  t._opened = true;
  try { t.xterm.refresh(0, t.xterm.rows - 1); } catch (e) {}

  // Watch this specific container for size changes — catches the case where
  // we opened with zero/wrong dimensions (workspace hidden, parent not yet
  // laid out) and the real size lands later. A size change here triggers a
  // fit, which propagates to the server via fitAll's resize-on-change.
  try {
    const ro = new ResizeObserver(() => {
      try { fitAll(); } catch (e) {}
    });
    ro.observe(c);
    t._resizeObserver = ro;
  } catch (e) {}

  // Ask the server to nudge the PTY so the inner TUI/shell re-emits its
  // current screen if it wasn't otherwise going to write.
  send('terminal:refresh', { id: tid });
}

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
  // Defer the xterm mount for each terminal until its container actually has
  // non-zero dimensions. In Electron the first paint frame sometimes lands
  // with clientWidth = 0, which makes fit() no-op and leaves xterm stuck at
  // the default 80×24 — that's why "manually resize the window" was the
  // only workaround (it triggers a second fit with real dimensions).
  for (const tid of ws.terminalIds) {
    const t = S.terminals.get(tid);
    if (!t || t._opened) continue;
    const c = containerCache.get(tid);
    if (!c) continue;
    mountWhenSized(t, c, tid);
  }
  fitAll();
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
      // Deliberately NOT calling fitAll() during drag — reflowing xterm on
      // every mousemove while new bytes stream in corrupts the scrollback.
      // The content briefly renders at the old cell grid; mouseup fits once.
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

  const launchers = document.createElement('div');
  launchers.className = 'panel-launchers';
  launchers.appendChild(createAgentLaunchButton('claude', 'Claude', id));
  launchers.appendChild(createAgentLaunchButton('codex', 'Codex', id));
  hdr.appendChild(launchers);

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

  const container = getOrCreateContainer(id);
  panel.appendChild(hdr); panel.appendChild(container);
  panel.addEventListener('mousedown', () => {
    setActive(id);
    if (S.linkMode) handleLinkClick(id);
  });
  return panel;
}

function createAgentLaunchButton(agent, label, terminalId) {
  const button = document.createElement('button');
  button.className = `panel-action-btn agent-launch-btn agent-${agent}`;
  button.dataset.agent = agent;
  button.dataset.label = label;
  button.textContent = label;

  const preset = S.agentPresets?.[agent];
  button.classList.toggle('is-empty', !preset?.command?.trim());
  button.title = !preset?.command?.trim() ? `Configure ${label} preset` : `Launch ${label}`;

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    launchAgentPreset(agent, label, terminalId);
  });

  return button;
}

function launchAgentPreset(agent, label, terminalId) {
  const terminal = S.terminals.get(terminalId);
  const command = S.agentPresets?.[agent]?.command || '';
  if (!command.trim()) {
    showAgentPresetsDialog();
    return;
  }

  // Pane is running a full-screen TUI (claude/codex/vim/…) — sending a command
  // now would inject keystrokes into it. Server's TUI monitor keeps this flag
  // fresh whether or not the TUI was launched via this button.
  if (terminal?.inTui) {
    showNotif(`Exit the running program before launching ${label}`, 'warning');
    setTimeout(() => terminal?.xterm.focus(), 0);
    return;
  }

  const workspace = activeWs();
  const expanded = command.replace(/\{\{\s*(terminal_name|terminal_id|workspace_name|role|agent)\s*\}\}/g, (_, key) => {
    switch (key) {
      case 'terminal_name': return terminal?.name || '';
      case 'terminal_id': return terminalId;
      case 'workspace_name': return workspace?.name || '';
      case 'role': return terminal?.role || '';
      case 'agent': return agent;
      default: return '';
    }
  });

  if (!expanded.trim()) {
    showAgentPresetsDialog();
    return;
  }

  // Optimistically mark the pane as in-TUI so a second click in the same
  // frame doesn't double-fire while the server's TUI poll is catching up.
  // The server poll reconciles this within ~1.5s regardless.
  if (terminal) terminal.inTui = true;
  refreshAgentPresetButtons();

  setActive(terminalId);
  send('terminal:input', {
    id: terminalId,
    data: expanded.endsWith('\n') ? expanded : `${expanded}\n`,
  });
  setTimeout(() => terminal?.xterm.focus(), 0);
  updateSidebar();
  showNotif(`${label} launched in ${terminal?.name || terminalId}`, 'success');
}

let _fitAllScheduled = false;
function _runFitAll() {
  _fitAllScheduled = false;
  const ws = activeWs();
  if (!ws) return;
  for (const tid of ws.terminalIds) {
    const t = S.terminals.get(tid);
    if (!t) continue;
    try {
      const beforeCols = t.xterm.cols;
      const beforeRows = t.xterm.rows;
      t.fitAddon.fit();
      // Only notify the server when geometry actually changed. Sending a
      // redundant resize makes tmux re-emit a screen redraw, which during
      // streaming output produces visible scroll jumps that snap back.
      if (t.xterm.cols !== beforeCols || t.xterm.rows !== beforeRows) {
        send('terminal:resize', { id: tid, cols: t.xterm.cols, rows: t.xterm.rows });
      }
    } catch (e) {}
  }
}

// Coalesce rapid fitAll calls (ResizeObserver + window resize + split/browser
// drag + renderLayout can all fire in the same frame). Calling xterm.resize()
// in a tight loop reflows the scrollback while writes are still arriving,
// which corrupts the buffer — paragraphs get broken and rows get dropped.
export function fitAll() {
  if (_fitAllScheduled) return;
  _fitAllScheduled = true;
  requestAnimationFrame(_runFitAll);
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
