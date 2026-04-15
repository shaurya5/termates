import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';

// ============================================
// State
// ============================================
const S = {
  ws: null,
  connected: false,
  terminals: new Map(),       // ALL terminals across workspaces
  activeTerminalId: null,
  linkMode: false,
  linkSource: null,
  // Workspaces
  workspaces: [],             // [{ id, name, terminalIds, links, layout }]
  activeWorkspaceId: null,
  nextWorkspaceId: 2,
  // Browser
  browserOpen: false,
  browserTabs: [],
  activeBrowserTab: 0,
  browserWidth: 0.35,
  nextBrowserTabId: 1,
};

const xtermTheme = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff', cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88, 166, 255, 0.3)',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#56d4dd', white: '#e6edf3',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#76e3ea', brightWhite: '#f0f6fc',
};

// ============================================
// Workspace Helpers
// ============================================
function activeWs() { return S.workspaces.find(w => w.id === S.activeWorkspaceId) || null; }
function nextTermName() { const ws = activeWs(); return `Terminal ${(ws?.terminalIds.length || 0) + 1}`; }
function wsTerminals(ws) { return (ws?.terminalIds || []).map(id => S.terminals.get(id)).filter(Boolean); }
function wsLinks(ws) { return ws?.links || []; }

function persistWorkspaces() {
  send('workspace:update', {
    workspaces: S.workspaces,
    activeWorkspaceId: S.activeWorkspaceId,
    nextWorkspaceId: S.nextWorkspaceId,
  });
}

// ============================================
// WebSocket
// ============================================
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);
  S.ws.onopen = () => { S.connected = true; updateConn(); S.ws.send(JSON.stringify({ type: 'terminal:list' })); };
  S.ws.onmessage = (e) => { try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  S.ws.onclose = () => { S.connected = false; updateConn(); setTimeout(connectWs, 2000); };
  S.ws.onerror = () => { S.connected = false; updateConn(); };
}

function send(type, payload) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify({ type, payload }));
}

// ============================================
// Message Handler
// ============================================
function handleMsg(msg) {
  switch (msg.type) {
    case 'terminal:created': onCreated(msg.payload); break;
    case 'terminal:output': onOutput(msg.payload); break;
    case 'terminal:destroyed': onDestroyed(msg.payload); break;
    case 'terminal:configured': onConfigured(msg.payload); break;
    case 'terminal:renamed': onConfigured(msg.payload); break;
    case 'terminal:linked': onLinked(msg.payload); break;
    case 'terminal:unlinked': onUnlinked(msg.payload); break;
    case 'terminal:status-changed': onStatusChanged(msg.payload); break;
    case 'terminal:notification': onNotif(msg.payload); break;
    case 'terminal:list': onList(msg.payload); break;
  }
}

// ============================================
// Terminal Events
// ============================================
function createXterm(id) {
  const isMac = navigator.platform?.includes('Mac') || navigator.userAgent?.includes('Mac');
  const xterm = new Terminal({
    fontFamily: "'SF Mono','Menlo','Monaco','Cascadia Code','Consolas',monospace",
    fontSize: 13, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar',
    theme: xtermTheme, allowProposedApi: true,
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
  });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
  xterm._webglAddon = new WebglAddon();
  xterm._webglAddon.onContextLoss(() => { xterm._webglAddon.dispose(); });

  // Mac keybindings — handle everything explicitly to avoid tmux conflicts
  if (isMac) {
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      // --- Option (Alt) combos ---
      // Option+Left: move cursor back one word
      if (ev.altKey && !ev.metaKey && ev.key === 'ArrowLeft') {
        send('terminal:input', { id, data: '\x1bb' });
        return false;
      }
      // Option+Right: move cursor forward one word
      if (ev.altKey && !ev.metaKey && ev.key === 'ArrowRight') {
        send('terminal:input', { id, data: '\x1bf' });
        return false;
      }
      // Option+Backspace: delete word backward
      if (ev.altKey && !ev.metaKey && ev.key === 'Backspace') {
        send('terminal:input', { id, data: '\x17' });
        return false;
      }
      // Option+Delete: delete word forward
      if (ev.altKey && !ev.metaKey && ev.key === 'Delete') {
        send('terminal:input', { id, data: '\x1bd' });
        return false;
      }
      // --- Cmd combos ---
      // Cmd+Left: go to beginning of line
      if (ev.metaKey && !ev.altKey && ev.key === 'ArrowLeft') {
        send('terminal:input', { id, data: '\x01' });
        return false;
      }
      // Cmd+Right: go to end of line
      if (ev.metaKey && !ev.altKey && ev.key === 'ArrowRight') {
        send('terminal:input', { id, data: '\x05' });
        return false;
      }
      // Cmd+Backspace: kill entire line
      if (ev.metaKey && !ev.altKey && ev.key === 'Backspace') {
        send('terminal:input', { id, data: '\x15' });
        return false;
      }
      // Cmd+K: clear terminal
      if (ev.metaKey && ev.key === 'k') {
        xterm.clear();
        return false;
      }
      return true;
    });
  }

  xterm.onData((data) => {
    const filtered = data.replace(/\x1b\[[\?>]?[\d;]*c/g, '');
    if (filtered) send('terminal:input', { id, data: filtered });
  });
  return { xterm, fitAddon };
}

function onCreated({ id, name, role, status }) {
  if (S.terminals.has(id)) return;
  const { xterm, fitAddon } = createXterm(id);
  S.terminals.set(id, { id, name, role, status: status || 'idle', xterm, fitAddon });
  // Add to active workspace
  const ws = activeWs();
  if (ws && !ws.terminalIds.includes(id)) {
    ws.terminalIds.push(id);
    addTerminalToLayout(id, ws);
    persistWorkspaces();
  }
  updateSidebar();
  setActive(id);
}

function onOutput({ id, data }) { S.terminals.get(id)?.xterm.write(data); }

function onDestroyed({ id }) {
  const t = S.terminals.get(id);
  if (!t) return;
  t.xterm.dispose();
  S.terminals.delete(id);
  // Remove from all workspaces
  for (const ws of S.workspaces) {
    ws.terminalIds = ws.terminalIds.filter(tid => tid !== id);
    ws.links = ws.links.filter(l => l.from !== id && l.to !== id);
    ws.layout = removeFromLayoutTree(ws.layout, id);
  }
  persistWorkspaces();
  if (S.activeWorkspaceId) renderLayout();
  updateSidebar();
  if (S.activeTerminalId === id) {
    const ws = activeWs();
    const first = ws?.terminalIds[0];
    setActive(first || null);
  }
}

function onConfigured({ id, name, role }) {
  const t = S.terminals.get(id);
  if (t) {
    if (name !== undefined) t.name = name;
    if (role !== undefined) t.role = role;
    updateSidebar();
    renderLayout();
  }
}

function onLinked({ from, to }) {
  const ws = activeWs();
  if (ws && !ws.links.some(l => (l.from === from && l.to === to) || (l.from === to && l.to === from))) {
    ws.links.push({ from, to });
    persistWorkspaces();
  }
  updateSidebar(); updateLinked();
}

function onUnlinked({ from, to }) {
  const ws = activeWs();
  if (ws) {
    ws.links = ws.links.filter(l => !((l.from === from && l.to === to) || (l.from === to && l.to === from)));
    persistWorkspaces();
  }
  updateSidebar(); updateLinked();
}

function onStatusChanged({ id, status }) {
  const t = S.terminals.get(id);
  if (t) { t.status = status; updateSidebar(); updatePanelStatus(id); }
}

function onNotif({ id, status, text }) {
  const t = S.terminals.get(id);
  if (t) { t.status = status; updateSidebar(); updatePanelStatus(id); showNotif(`${t.name}: ${text || status}`, status); }
}

function onList({ terminals, workspaces, activeWorkspaceId, nextWorkspaceId, browserTabs, activeBrowserTab, browserOpen, browserWidth }) {
  if (browserTabs?.length) { S.browserTabs = browserTabs; S.activeBrowserTab = activeBrowserTab || 0; }
  if (browserOpen) S.browserOpen = true;
  if (browserWidth) S.browserWidth = browserWidth;

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
      S.terminals.set(t.id, { id: t.id, name: t.name, role: t.role, status: t.status || 'idle', xterm, fitAddon });
    }
    // Prune workspace layouts and terminalIds to only existing terminals
    const existingIds = new Set(terminals.map(t => t.id));
    for (const ws of S.workspaces) {
      ws.terminalIds = ws.terminalIds.filter(id => existingIds.has(id));
      ws.layout = pruneLayout(ws.layout, new Set(ws.terminalIds));
      ws.links = ws.links.filter(l => existingIds.has(l.from) && existingIds.has(l.to));
      // If layout is empty but terminals exist, auto-build
      if (!ws.layout && ws.terminalIds.length) {
        ws.layout = null;
        for (const tid of ws.terminalIds) ws.layout = addToLayoutTree(ws.layout, tid, 'horizontal');
      } else if (ws.layout && ws.terminalIds.length) {
        // Layout exists but may be incomplete — add any terminals missing from the tree
        const inLayout = collectLayoutIds(ws.layout);
        for (const tid of ws.terminalIds) {
          if (!inLayout.has(tid)) {
            ws.layout = addToLayoutTree(ws.layout, tid, 'horizontal');
          }
        }
      }
    }
    // Check for orphaned terminals
    const assigned = new Set(S.workspaces.flatMap(w => w.terminalIds));
    const orphans = terminals.filter(t => !assigned.has(t.id));
    if (orphans.length) {
      const ws = activeWs();
      for (const t of orphans) {
        ws.terminalIds.push(t.id);
        ws.layout = addToLayoutTree(ws.layout, t.id, 'horizontal');
      }
    }
  }

  renderLayout();
  updateSidebar();
  const ws = activeWs();
  if (ws?.terminalIds.length) setActive(ws.terminalIds[0]);
  if (S.browserOpen) toggleBrowser(true);
  renderBrowserTabs();

  // Force tmux to redraw by cycling resize multiple times.
  // tmux caches the terminal size — a single resize may not trigger a full redraw.
  const forceRedraw = (delay) => {
    setTimeout(() => {
      for (const [id, t] of S.terminals) {
        try {
          t.fitAddon.fit();
          const cols = t.xterm.cols, rows = t.xterm.rows;
          send('terminal:resize', { id, cols: Math.max(1, cols - 1), rows: Math.max(1, rows - 1) });
          setTimeout(() => {
            send('terminal:resize', { id, cols, rows });
          }, 150);
        } catch (e) {}
      }
    }, delay);
  };
  forceRedraw(300);
  forceRedraw(800);
}

// ============================================
// Layout Tree (pure functions, no side effects on S)
// ============================================
function addToLayoutTree(layout, id, direction) {
  const leaf = { type: 'leaf', panelId: id };
  if (!layout) return leaf;
  // Find rightmost/bottommost leaf and split it
  const targetId = findLeaf(layout);
  if (!targetId) return leaf;
  return splitInTree(layout, targetId, direction, leaf);
}

function splitInTree(tree, targetId, direction, newLeaf) {
  if (tree.type === 'leaf' && tree.panelId === targetId)
    return { type: 'split', direction, ratio: 0.5, children: [{ ...tree }, newLeaf] };
  if (tree.type === 'split')
    return { ...tree, children: [splitInTree(tree.children[0], targetId, direction, newLeaf), tree.children[1]] };
  return tree;
}

function removeFromLayoutTree(layout, id) {
  if (!layout) return null;
  if (layout.type === 'leaf') return layout.panelId === id ? null : layout;
  if (layout.type === 'split') {
    const l = removeFromLayoutTree(layout.children[0], id);
    const r = removeFromLayoutTree(layout.children[1], id);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...layout, children: [l, r] };
  }
  return layout;
}

function findLeaf(n) {
  if (!n) return null;
  if (n.type === 'leaf') return n.panelId;
  return findLeaf(n.children[0]) || findLeaf(n.children[1]);
}

function pruneLayout(node, validIds) {
  if (!node) return null;
  if (node.type === 'leaf') return validIds.has(node.panelId) ? node : null;
  if (node.type === 'split') {
    const l = pruneLayout(node.children[0], validIds);
    const r = pruneLayout(node.children[1], validIds);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...node, children: [l, r] };
  }
  return null;
}

function collectLayoutIds(node) {
  const ids = new Set();
  (function walk(n) { if (!n) return; if (n.type === 'leaf') ids.add(n.panelId); if (n.type === 'split') { walk(n.children[0]); walk(n.children[1]); } })(node);
  return ids;
}

// ============================================
// Layout Rendering
// ============================================
function addTerminalToLayout(id, ws) {
  ws = ws || activeWs();
  if (!ws) return;
  const dir = S._splitDir || 'horizontal';
  S._splitDir = null;
  const target = S.activeTerminalId && ws.terminalIds.includes(S.activeTerminalId) ? S.activeTerminalId : findLeaf(ws.layout);
  if (!ws.layout) {
    ws.layout = { type: 'leaf', panelId: id };
  } else if (target) {
    ws.layout = splitInTree(ws.layout, target, dir, { type: 'leaf', panelId: id });
  }
  renderLayout();
  persistWorkspaces();
}

function renderLayout() {
  const root = document.getElementById('layout-root');
  root.innerHTML = '';
  const ws = activeWs();
  if (!ws || !ws.layout) { root.appendChild(createWelcome()); return; }
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

function renderNode(n) {
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

function setupResize(handle, node, p1, p2) {
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
function createTermPanel(id) {
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
  acts.appendChild(mkBtn('Split H', () => send('terminal:create', { name: nextTermName() })));
  acts.appendChild(mkBtn('Split V', () => { S._splitDir = 'vertical'; send('terminal:create', { name: nextTermName() }); }));
  acts.appendChild(mkSvgBtn('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>', () => send('terminal:destroy', { id }), 'close', 'Close'));
  hdr.appendChild(acts);

  const container = document.createElement('div'); container.className = 'terminal-container';
  panel.appendChild(hdr); panel.appendChild(container);
  panel.addEventListener('mousedown', () => {
    setActive(id);
    if (S.linkMode) handleLinkClick(id);
  });
  return panel;
}

function updatePanelStatus(id) {
  const t = S.terminals.get(id);
  const p = document.querySelector(`[data-tid="${id}"]`);
  if (!t || !p) return;
  p.classList.remove('status-attention', 'status-success', 'status-warning', 'status-error');
  if (t.status !== 'idle') p.classList.add(`status-${t.status}`);
  const dot = p.querySelector('.panel-dot');
  if (dot) dot.className = `panel-dot terminal-status-dot ${t.status}`;
}

function updateLinked() {
  const ws = activeWs();
  if (!ws) return;
  for (const tid of ws.terminalIds) {
    const p = document.querySelector(`[data-tid="${tid}"]`);
    if (p) p.classList.toggle('linked', isLinked(tid, ws));
  }
}

function isLinked(id, ws) { return (ws?.links || []).some(l => l.from === id || l.to === id); }
function getLinked(id, ws) { const r = []; for (const l of (ws?.links || [])) { if (l.from === id) r.push(l.to); else if (l.to === id) r.push(l.from); } return r; }

// ============================================
// Workspace Management
// ============================================
function switchWorkspace(wsId) {
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

function createWorkspace(name, type, cwd, sshTarget, remoteCwd) {
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

function showWorkspaceDialog() {
  const d = document.getElementById('ws-dialog');
  document.getElementById('ws-name').value = '';
  document.querySelector('input[name="ws-type"][value="local"]').checked = true;
  document.getElementById('ws-ssh-fields').classList.add('hidden');
  document.getElementById('ws-ssh-target').value = '';
  document.getElementById('ws-remote-cwd').value = '';
  // Load SSH hosts
  loadSSHHosts();
  d.showModal();
  document.getElementById('ws-name').focus();
}

async function loadSSHHosts() {
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

function renameWorkspace(wsId, name) {
  const ws = S.workspaces.find(w => w.id === wsId);
  if (ws) { ws.name = name; updateSidebar(); persistWorkspaces(); }
}

function deleteWorkspace(wsId) {
  if (S.workspaces.length <= 1) { showNotif('Cannot delete the last workspace', 'warning'); return; }
  const ws = S.workspaces.find(w => w.id === wsId);
  if (!ws) return;
  // Destroy all terminals in this workspace
  for (const tid of [...ws.terminalIds]) {
    send('terminal:destroy', { id: tid });
  }
  S.workspaces = S.workspaces.filter(w => w.id !== wsId);
  if (S.activeWorkspaceId === wsId) {
    switchWorkspace(S.workspaces[0].id);
  }
  persistWorkspaces();
  updateSidebar();
}

// ============================================
// Browser Panel
// ============================================
function toggleBrowser(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !S.browserOpen;
  S.browserOpen = open;
  document.getElementById('browser-panel').classList.toggle('hidden', !open);
  document.getElementById('browser-resize-handle').classList.toggle('hidden', !open);
  document.getElementById('btn-toggle-browser').classList.toggle('active', open);
  if (open && S.browserTabs.length === 0) addBrowserTab();
  if (open) renderBrowserTabs();
  fitAll();
  send('browser:update', { open });
}

function addBrowserTab(url = '', title = 'New Tab') {
  const id = S.nextBrowserTabId++;
  S.browserTabs.push({ id, url, title });
  S.activeBrowserTab = S.browserTabs.length - 1;
  renderBrowserTabs(); navigateBrowserTab(); persistBrowser();
}

function closeBrowserTab(index) {
  S.browserTabs.splice(index, 1);
  if (S.browserTabs.length === 0) { toggleBrowser(false); return; }
  if (S.activeBrowserTab >= S.browserTabs.length) S.activeBrowserTab = S.browserTabs.length - 1;
  renderBrowserTabs(); navigateBrowserTab(); persistBrowser();
}

function selectBrowserTab(index) {
  S.activeBrowserTab = index;
  renderBrowserTabs(); navigateBrowserTab(); persistBrowser();
}

function renderBrowserTabs() {
  const container = document.getElementById('browser-tabs');
  container.innerHTML = '';
  S.browserTabs.forEach((tab, i) => {
    const el = document.createElement('button');
    el.className = 'browser-tab' + (i === S.activeBrowserTab ? ' active' : '');
    const label = document.createElement('span');
    try { label.textContent = tab.url ? new URL(tab.url).hostname : tab.title; } catch (e) { label.textContent = tab.title; }
    el.appendChild(label);
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '\u00d7';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeBrowserTab(i); });
    el.appendChild(close);
    el.addEventListener('click', () => selectBrowserTab(i));
    container.appendChild(el);
  });
  const tab = S.browserTabs[S.activeBrowserTab];
  const urlBar = document.getElementById('browser-url');
  if (tab && urlBar) urlBar.value = tab.url || '';
}

function navigateBrowserTab() {
  const tab = S.browserTabs[S.activeBrowserTab];
  const content = document.getElementById('browser-content');
  if (!tab || !content) return;
  content.innerHTML = '';
  if (tab.url) {
    const iframe = document.createElement('iframe');
    iframe.src = `/proxy?url=${encodeURIComponent(tab.url)}`;
    iframe.sandbox = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
    content.appendChild(iframe);
  } else {
    const empty = document.createElement('div'); empty.className = 'browser-empty'; empty.textContent = 'Enter a URL to browse';
    content.appendChild(empty);
  }
}

function persistBrowser() {
  send('browser:update', { tabs: S.browserTabs, activeTab: S.activeBrowserTab, open: S.browserOpen, width: S.browserWidth });
}

function setupBrowserResize() {
  const handle = document.getElementById('browser-resize-handle');
  const panel = document.getElementById('browser-panel');
  const workspace = document.getElementById('workspace');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault(); handle.classList.add('dragging');
    const startX = e.clientX, startW = panel.offsetWidth;
    const move = (e) => { panel.style.width = Math.max(300, Math.min(workspace.offsetWidth * 0.6, startW + (startX - e.clientX))) + 'px'; fitAll(); };
    const up = () => { handle.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; S.browserWidth = panel.offsetWidth / workspace.offsetWidth; persistBrowser(); fitAll(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  });
}

// ============================================
// Welcome Screen
// ============================================
function createWelcome() {
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

// ============================================
// Sidebar
// ============================================
function updateSidebar() {
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
      cb.addEventListener('click', (e) => { e.stopPropagation(); send('terminal:destroy', { id: tid }); }); li.appendChild(cb);
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
}

// ============================================
// Focus / Link / Notifications
// ============================================
function setActive(id) {
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

function focusTerm(id) { S.terminals.get(id)?.xterm.focus(); }

function enterLinkMode() { S.linkMode = true; S.linkSource = null; document.getElementById('link-mode-overlay').classList.remove('hidden'); document.getElementById('btn-link-mode').classList.add('active'); updateSidebar(); }
function exitLinkMode() { S.linkMode = false; S.linkSource = null; document.getElementById('link-mode-overlay').classList.add('hidden'); document.getElementById('btn-link-mode').classList.remove('active'); updateSidebar(); }

function handleLinkClick(id) {
  if (!S.linkSource) { S.linkSource = id; showNotif(`Selected "${S.terminals.get(id)?.name}". Click another.`, 'attention'); }
  else if (S.linkSource !== id) {
    send('terminal:link', { from: S.linkSource, to: id });
    showNotif(`Linked "${S.terminals.get(S.linkSource)?.name}" \u2194 "${S.terminals.get(id)?.name}"`, 'success');
    exitLinkMode();
  }
}

function showNotif(text, type = 'attention') {
  const c = document.getElementById('notifications');
  const el = document.createElement('div'); el.className = `notification ${type}`; el.textContent = text;
  c.appendChild(el); setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3000);
}

function updateConn() {
  const dot = document.getElementById('status-dot'), txt = document.getElementById('status-text');
  dot.classList.toggle('connected', S.connected); txt.textContent = S.connected ? 'Connected' : 'Disconnected';
}

function fitAll() {
  const ws = activeWs();
  if (!ws) return;
  for (const tid of ws.terminalIds) {
    const t = S.terminals.get(tid);
    if (!t) continue;
    try { t.fitAddon.fit(); send('terminal:resize', { id: tid, cols: t.xterm.cols, rows: t.xterm.rows }); } catch (e) {}
  }
}

// ============================================
// Dialogs
// ============================================
function showCreateDialog() {
  const d = document.getElementById('create-dialog');
  document.getElementById('create-name').value = nextTermName();
  document.getElementById('create-role').value = '';
  document.getElementById('create-cwd').value = '';
  d.showModal(); document.getElementById('create-name').focus(); document.getElementById('create-name').select();
}

function showEditDialog(id) {
  const t = S.terminals.get(id);
  if (!t) return;
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-name').value = t.name;
  document.getElementById('edit-role').value = t.role || '';
  document.getElementById('edit-status').value = t.status || 'idle';
  document.getElementById('edit-dialog').showModal();
  document.getElementById('edit-name').focus(); document.getElementById('edit-name').select();
}

// ============================================
// Keyboard Shortcuts
// ============================================
function setupKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey) {
      switch (e.key) {
        case 'T': e.preventDefault(); showCreateDialog(); break;
        case 'B': e.preventDefault(); toggleBrowser(); break;
        case 'H': e.preventDefault(); if (S.activeTerminalId) send('terminal:create', { name: nextTermName() }); break;
        case 'V': e.preventDefault(); if (S.activeTerminalId) { S._splitDir = 'vertical'; send('terminal:create', { name: nextTermName() }); } break;
        case 'L': e.preventDefault(); S.linkMode ? exitLinkMode() : enterLinkMode(); break;
        case 'W': e.preventDefault(); if (S.activeTerminalId) send('terminal:destroy', { id: S.activeTerminalId }); break;
        case 'N': e.preventDefault(); showWorkspaceDialog(); break;
      }
    }
    if (e.key === 'Escape' && S.linkMode) exitLinkMode();
    if (e.ctrlKey && e.shiftKey && (e.key === '[' || e.key === '{')) { e.preventDefault(); navTerminals(-1); }
    if (e.ctrlKey && e.shiftKey && (e.key === ']' || e.key === '}')) { e.preventDefault(); navTerminals(1); }
  });
}

function navTerminals(dir) {
  const ws = activeWs();
  if (!ws?.terminalIds.length) return;
  const ids = ws.terminalIds;
  let idx = ids.indexOf(S.activeTerminalId) + dir;
  if (idx < 0) idx = ids.length - 1;
  if (idx >= ids.length) idx = 0;
  setActive(ids[idx]); focusTerm(ids[idx]);
}

// ============================================
// Setup UI
// ============================================
function setupUI() {
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
    if (S.activeTerminalId) send('terminal:create', { name: nextTermName() });
    else showCreateDialog();
  });
  document.getElementById('btn-split-v').addEventListener('click', () => {
    if (S.activeTerminalId) { S._splitDir = 'vertical'; send('terminal:create', { name: nextTermName() }); }
    else showCreateDialog();
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
  document.getElementById('create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('create-confirm').click(); });

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
    if (id) send('terminal:destroy', { id });
    document.getElementById('edit-dialog').close();
  });
  document.getElementById('edit-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('edit-confirm').click(); });

  // Workspace dialog
  document.querySelectorAll('input[name="ws-type"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('ws-ssh-fields').classList.toggle('hidden', r.value !== 'remote' || !r.checked);
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
  document.getElementById('ws-cwd-browse').addEventListener('click', () => {
    const picker = document.getElementById('ws-cwd-picker');
    picker.classList.toggle('hidden');
    if (!picker.classList.contains('hidden')) {
      loadDirectory(picker, document.getElementById('ws-cwd').value || '', (p) => {
        document.getElementById('ws-cwd').value = p;
        picker.classList.add('hidden');
      });
    }
  });
  document.getElementById('ws-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('ws-confirm').click(); });

  // Directory browse button
  document.getElementById('create-cwd-browse').addEventListener('click', () => {
    const picker = document.getElementById('create-cwd-picker');
    picker.classList.toggle('hidden');
    if (!picker.classList.contains('hidden')) {
      const current = document.getElementById('create-cwd').value || '';
      loadDirectory(picker, current || '', (path) => {
        document.getElementById('create-cwd').value = path;
        picker.classList.add('hidden');
      });
    }
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
  new ResizeObserver(fitAll).observe(document.getElementById('layout-root'));
}

// ============================================
// Directory Browser
// ============================================
async function loadDirectory(picker, dirPath, onSelect) {
  try {
    const res = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`);
    const { current, parent, dirs, error } = await res.json();
    picker.innerHTML = '';
    // Current path display
    const pathEl = document.createElement('div');
    pathEl.className = 'dir-picker-path';
    pathEl.textContent = current;
    picker.appendChild(pathEl);
    // Select current directory button
    const selectBtn = document.createElement('div');
    selectBtn.className = 'dir-picker-item';
    selectBtn.style.fontWeight = '600';
    selectBtn.style.color = 'var(--accent)';
    selectBtn.textContent = 'Select this directory';
    selectBtn.addEventListener('click', () => onSelect(current));
    picker.appendChild(selectBtn);
    // Parent directory
    if (parent && parent !== current) {
      const parentEl = document.createElement('div');
      parentEl.className = 'dir-picker-item parent';
      parentEl.textContent = '.. (parent)';
      parentEl.addEventListener('click', () => loadDirectory(picker, parent, onSelect));
      picker.appendChild(parentEl);
    }
    // Child directories
    for (const d of dirs) {
      const el = document.createElement('div');
      el.className = 'dir-picker-item';
      el.textContent = d.name;
      el.addEventListener('click', () => loadDirectory(picker, d.path, onSelect));
      picker.appendChild(el);
    }
    if (error) {
      const errEl = document.createElement('div');
      errEl.className = 'dir-picker-item';
      errEl.style.color = 'var(--error)';
      errEl.textContent = error;
      picker.appendChild(errEl);
    }
  } catch (e) { picker.innerHTML = '<div class="dir-picker-item" style="color:var(--error)">Failed to load</div>'; }
}

// ============================================
// Auto-Update
// ============================================
async function checkForUpdate() {
  try {
    const res = await fetch('/api/update/status');
    const u = await res.json();
    const banner = document.getElementById('update-banner');
    const msg = document.getElementById('update-message');
    const btn = document.getElementById('update-action');
    const ver = document.getElementById('version-info');

    if (u.currentVersion) ver.textContent = `v${u.currentVersion}`;

    if (u.status === 'available') {
      banner.classList.remove('hidden', 'downloading', 'ready');
      msg.textContent = `v${u.latestVersion} available`;
      btn.textContent = 'Update';
      btn.className = 'update-btn';
      btn.onclick = async () => {
        if (u.releaseUrl) {
          // In server-only mode, open the release page
          window.open(u.releaseUrl, '_blank');
        } else {
          // In Electron mode, trigger download
          await fetch('/api/update/download', { method: 'POST' });
          btn.textContent = 'Downloading...';
          btn.disabled = true;
        }
      };
    } else if (u.status === 'downloading') {
      banner.classList.remove('hidden', 'ready');
      banner.classList.add('downloading');
      msg.textContent = `Downloading... ${u.progress || 0}%`;
      btn.textContent = `${u.progress || 0}%`;
      btn.disabled = true;
    } else if (u.status === 'downloaded') {
      banner.classList.remove('hidden', 'downloading');
      banner.classList.add('ready');
      msg.textContent = 'Update ready';
      btn.textContent = 'Restart';
      btn.className = 'update-btn installing';
      btn.disabled = false;
      btn.onclick = () => fetch('/api/update/install', { method: 'POST' });
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) { /* silent */ }
}

// Check on load and every 5 minutes
setTimeout(checkForUpdate, 3000);
setInterval(checkForUpdate, 5 * 60 * 1000);

// ============================================
// Init
// ============================================
setupUI();
setupKeys();
renderLayout();
connectWs();
