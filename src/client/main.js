import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

// ============================================
// State
// ============================================
const S = {
  ws: null,
  connected: false,
  terminals: new Map(),
  links: [],
  activeTerminalId: null,
  linkMode: false,
  linkSource: null,
  layout: null,
  // Browser (right-side panel)
  browserOpen: false,
  browserTabs: [],     // [{ id, url, title }]
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
    case 'terminal:renamed': onRenamed(msg.payload); break;
    case 'terminal:configured': onConfigured(msg.payload); break;
    case 'terminal:linked': onLinked(msg.payload); break;
    case 'terminal:unlinked': onUnlinked(msg.payload); break;
    case 'terminal:status-changed': onStatusChanged(msg.payload); break;
    case 'terminal:notification': onNotif(msg.payload); break;
    case 'terminal:message-sent': onMsgSent(msg.payload); break;
    case 'terminal:list': onList(msg.payload); break;
  }
}

// ============================================
// Terminal Events
// ============================================
function createXterm(id) {
  const xterm = new Terminal({
    fontFamily: "'SF Mono','Menlo','Monaco','Cascadia Code','Consolas',monospace",
    fontSize: 13, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar',
    theme: xtermTheme, allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
  xterm.onData((data) => {
    // Filter DA queries AND responses that cause garbled output with tmux.
    // tmux queries xterm.js (\x1b[c), xterm.js responds (\x1b[?1;2c),
    // and that response leaks into zsh as keyboard input.
    // Matches: \x1b[c, \x1b[>c, \x1b[?1;2c, \x1b[>0;276;0c, etc.
    const filtered = data.replace(/\x1b\[[\?>]?[\d;]*c/g, '');
    if (filtered) send('terminal:input', { id, data: filtered });
  });
  return { xterm, fitAddon };
}

function onCreated({ id, name, role, status }) {
  if (S.terminals.has(id)) return;
  const { xterm, fitAddon } = createXterm(id);
  const td = { id, name, role, status: status || 'idle', xterm, fitAddon };
  S.terminals.set(id, td);
  addTerminalToLayout(id);
  updateSidebar();
  setActive(id);
}

function onOutput({ id, data }) { S.terminals.get(id)?.xterm.write(data); }

function onDestroyed({ id }) {
  const t = S.terminals.get(id);
  if (!t) return;
  t.xterm.dispose();
  S.terminals.delete(id);
  removeFromLayout(id);
  updateSidebar();
  if (S.activeTerminalId === id) {
    const first = S.terminals.keys().next().value;
    setActive(first || null);
  }
}

function onConfigured({ id, name, role }) {
  const t = S.terminals.get(id);
  if (t) {
    if (name !== undefined) t.name = name;
    if (role !== undefined) t.role = role;
    updateSidebar();
    // Re-render the layout to update panel headers with new name/role
    renderLayout();
  }
}

function onRenamed({ id, name }) {
  const t = S.terminals.get(id);
  if (t) { t.name = name; updateSidebar(); updatePanelHeader(id); }
}

function onLinked({ from, to }) {
  if (!S.links.some(l => (l.from === from && l.to === to) || (l.from === to && l.to === from)))
    S.links.push({ from, to });
  updateSidebar(); updateLinked();
}

function onUnlinked({ from, to }) {
  S.links = S.links.filter(l => !((l.from === from && l.to === to) || (l.from === to && l.to === from)));
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

function onMsgSent({ from, to }) {
  const f = S.terminals.get(from), t = S.terminals.get(to);
  if (f && t) showNotif(`${f.name} -> ${t.name}`, 'attention');
}

function onList({ terminals, links, layout, browserTabs, activeBrowserTab, browserOpen, browserWidth }) {
  // Restore browser state
  if (browserTabs?.length) { S.browserTabs = browserTabs; S.activeBrowserTab = activeBrowserTab || 0; }
  if (browserOpen) S.browserOpen = true;
  if (browserWidth) S.browserWidth = browserWidth;

  // Restore terminals
  if (terminals?.length && S.terminals.size === 0) {
    S.links = links || [];
    const termIds = new Set(terminals.map(t => t.id));
    for (const t of terminals) {
      const { xterm, fitAddon } = createXterm(t.id);
      S.terminals.set(t.id, { id: t.id, name: t.name, role: t.role, status: t.status || 'idle', xterm, fitAddon });
    }
    // Restore layout: prune any leaves referencing dead terminals, then validate
    if (layout) {
      S.layout = pruneLayout(layout, termIds);
    }
    // If layout is empty/null after pruning, or wasn't saved, auto-build from terminal list
    if (!S.layout) {
      S.layout = null;
      for (const t of terminals) addTerminalToLayout(t.id);
    } else {
      // Check if any terminals are missing from the layout and add them
      const layoutIds = collectLayoutIds(S.layout);
      for (const t of terminals) {
        if (!layoutIds.has(t.id)) addTerminalToLayout(t.id);
      }
    }
    renderLayout();
    updateSidebar();
    if (terminals.length) setActive(terminals[0].id);

    // Force tmux to redraw all terminals by cycling a resize.
    // On page reload, existing tmux sessions have content but the new xterm
    // instances are empty. A resize forces tmux to repaint the screen.
    setTimeout(() => {
      for (const [id, t] of S.terminals) {
        try {
          const cols = t.xterm.cols, rows = t.xterm.rows;
          send('terminal:resize', { id, cols: Math.max(1, cols - 1), rows });
          setTimeout(() => send('terminal:resize', { id, cols, rows }), 100);
        } catch (e) {}
      }
    }, 300);
  }
  // Restore browser panel
  if (S.browserOpen) toggleBrowser(true);
  renderBrowserTabs();
}

// Remove layout leaves whose panelId is not in the valid set
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

// Collect all terminal IDs referenced in the layout tree
function collectLayoutIds(node) {
  const ids = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.type === 'leaf') ids.add(n.panelId);
    if (n.type === 'split') { walk(n.children[0]); walk(n.children[1]); }
  })(node);
  return ids;
}

// ============================================
// Layout System (terminals only)
// ============================================
function addTerminalToLayout(id) {
  const leaf = { type: 'leaf', panelId: id };
  if (!S.layout) { S.layout = leaf; }
  else {
    const target = S.activeTerminalId || findLeaf(S.layout);
    const dir = S._splitDir || 'horizontal';
    S._splitDir = null;
    if (target) splitLeaf(target, dir, leaf);
    else S.layout = leaf;
  }
  renderLayout();
  persistLayout();
}

function findLeaf(n) {
  if (!n) return null;
  if (n.type === 'leaf') return n.panelId;
  return findLeaf(n.children[0]) || findLeaf(n.children[1]);
}

function splitLeaf(panelId, direction, newLeaf) {
  function go(n) {
    if (n.type === 'leaf' && n.panelId === panelId)
      return { type: 'split', direction, ratio: 0.5, children: [{ ...n }, newLeaf] };
    if (n.type === 'split')
      return { ...n, children: [go(n.children[0]), go(n.children[1])] };
    return n;
  }
  S.layout = go(S.layout);
}

function removeFromLayout(id) {
  function go(n) {
    if (!n) return null;
    if (n.type === 'leaf') return n.panelId === id ? null : n;
    if (n.type === 'split') {
      const l = go(n.children[0]), r = go(n.children[1]);
      if (!l && !r) return null;
      if (!l) return r;
      if (!r) return l;
      return { ...n, children: [l, r] };
    }
    return n;
  }
  S.layout = go(S.layout);
  renderLayout();
  persistLayout();
}

function persistLayout() {
  send('layout:update', { layout: S.layout });
}

function renderLayout() {
  const root = document.getElementById('layout-root');
  root.innerHTML = '';
  if (!S.layout) { root.appendChild(createWelcome()); return; }
  root.appendChild(renderNode(S.layout));
  requestAnimationFrame(() => {
    for (const [id, t] of S.terminals) {
      const c = document.querySelector(`[data-tid="${id}"] .terminal-container`);
      if (c && !c.querySelector('.xterm')) {
        t.xterm.open(c);
        t.fitAddon.fit();
        send('terminal:resize', { id, cols: t.xterm.cols, rows: t.xterm.rows });
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
  let start = 0, startR = 0, size = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    start = node.direction === 'horizontal' ? e.clientX : e.clientY;
    startR = node.ratio;
    size = node.direction === 'horizontal' ? handle.parentElement.offsetWidth : handle.parentElement.offsetHeight;
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
      fitAll(); persistLayout();
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
  const panel = document.createElement('div');
  panel.className = 'terminal-panel';
  panel.dataset.tid = id;
  if (t.status !== 'idle') panel.classList.add(`status-${t.status}`);
  if (isLinked(id)) panel.classList.add('linked');

  const hdr = document.createElement('div'); hdr.className = 'panel-header';
  const dot = document.createElement('span'); dot.className = `panel-dot terminal-status-dot ${t.status}`;
  const nm = document.createElement('span'); nm.className = 'panel-name'; nm.textContent = t.name;
  hdr.appendChild(dot); hdr.appendChild(nm);
  if (t.role) { const b = document.createElement('span'); b.className = `panel-role terminal-role-badge ${t.role}`; b.textContent = t.role; hdr.appendChild(b); }

  const acts = document.createElement('div'); acts.className = 'panel-actions';
  const mkBtn = (lbl, fn, cls) => { const b = document.createElement('button'); b.className = 'panel-action-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
  acts.appendChild(mkBtn('\u2699', () => showEditDialog(id)));  // gear icon
  acts.appendChild(mkBtn('Split H', () => send('terminal:create', { name: `Terminal ${S.terminals.size + 1}` })));
  acts.appendChild(mkBtn('Split V', () => { S._splitDir = 'vertical'; send('terminal:create', { name: `Terminal ${S.terminals.size + 1}` }); }));
  acts.appendChild(mkBtn('x', () => send('terminal:destroy', { id }), 'close'));
  hdr.appendChild(acts);

  const container = document.createElement('div'); container.className = 'terminal-container';
  panel.appendChild(hdr); panel.appendChild(container);
  panel.addEventListener('mousedown', () => {
    setActive(id);
    if (S.linkMode) handleLinkClick(id);
  });
  return panel;
}

function updatePanelHeader(id) {
  const t = S.terminals.get(id);
  const el = document.querySelector(`[data-tid="${id}"] .panel-name`);
  if (t && el) el.textContent = t.name;
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
  for (const [id] of S.terminals) {
    const p = document.querySelector(`[data-tid="${id}"]`);
    if (p) { p.classList.toggle('linked', isLinked(id)); }
  }
}

function isLinked(id) { return S.links.some(l => l.from === id || l.to === id); }
function getLinked(id) { const r = []; for (const l of S.links) { if (l.from === id) r.push(l.to); else if (l.to === id) r.push(l.from); } return r; }

// ============================================
// Browser Panel (right side, tabbed)
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
  renderBrowserTabs();
  navigateBrowserTab();
  persistBrowser();
}

function closeBrowserTab(index) {
  S.browserTabs.splice(index, 1);
  if (S.browserTabs.length === 0) { toggleBrowser(false); return; }
  if (S.activeBrowserTab >= S.browserTabs.length) S.activeBrowserTab = S.browserTabs.length - 1;
  renderBrowserTabs();
  navigateBrowserTab();
  persistBrowser();
}

function selectBrowserTab(index) {
  S.activeBrowserTab = index;
  renderBrowserTabs();
  navigateBrowserTab();
  persistBrowser();
}

function renderBrowserTabs() {
  const container = document.getElementById('browser-tabs');
  container.innerHTML = '';
  S.browserTabs.forEach((tab, i) => {
    const el = document.createElement('button');
    el.className = 'browser-tab' + (i === S.activeBrowserTab ? ' active' : '');
    const label = document.createElement('span');
    try { label.textContent = tab.url ? new URL(tab.url).hostname : tab.title; }
    catch (e) { label.textContent = tab.title; }
    el.appendChild(label);
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeBrowserTab(i); });
    el.appendChild(close);
    el.addEventListener('click', () => selectBrowserTab(i));
    container.appendChild(el);
  });
  // Update URL bar
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
    const empty = document.createElement('div');
    empty.className = 'browser-empty';
    empty.textContent = 'Enter a URL to browse';
    content.appendChild(empty);
  }
}

function persistBrowser() {
  send('browser:update', {
    tabs: S.browserTabs, activeTab: S.activeBrowserTab,
    open: S.browserOpen, width: S.browserWidth,
  });
}

function setupBrowserResize() {
  const handle = document.getElementById('browser-resize-handle');
  const panel = document.getElementById('browser-panel');
  const workspace = document.getElementById('workspace');
  let startX = 0, startW = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    startX = e.clientX;
    startW = panel.offsetWidth;
    const move = (e) => {
      const delta = startX - e.clientX;
      const newW = Math.max(300, Math.min(workspace.offsetWidth * 0.6, startW + delta));
      panel.style.width = newW + 'px';
      fitAll();
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      S.browserWidth = panel.offsetWidth / workspace.offsetWidth;
      persistBrowser(); fitAll();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
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
      On-device terminal multiplexer with persistent sessions, agent linking, and browser support.
      Terminals backed by tmux survive restarts.
    </p>
    <div class="welcome-shortcuts">
      <kbd>Ctrl+Shift+T</kbd> <span>New Terminal</span>
      <kbd>Ctrl+Shift+B</kbd> <span>Toggle Browser</span>
      <kbd>Ctrl+Shift+H</kbd> <span>Split Horizontal</span>
      <kbd>Ctrl+Shift+V</kbd> <span>Split Vertical</span>
      <kbd>Ctrl+Shift+L</kbd> <span>Link Mode</span>
      <kbd>Ctrl+Shift+S</kbd> <span>Send to Linked</span>
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
  // Terminal list
  const tl = document.getElementById('terminal-list');
  tl.innerHTML = '';
  for (const [id, t] of S.terminals) {
    const li = document.createElement('li');
    li.className = 'panel-list-item' + (id === S.activeTerminalId ? ' active' : '') + (S.linkMode ? ' link-select-mode' : '');
    const dot = document.createElement('span'); dot.className = `terminal-status-dot ${t.status}`;
    const nm = document.createElement('span'); nm.className = 'terminal-name'; nm.textContent = t.name;
    li.appendChild(dot); li.appendChild(nm);
    if (isLinked(id)) { const ld = document.createElement('span'); ld.className = 'link-indicator'; li.appendChild(ld); }
    if (t.role) { const b = document.createElement('span'); b.className = `terminal-role-badge ${t.role}`; b.textContent = t.role; li.appendChild(b); }
    const cb = document.createElement('button'); cb.className = 'close-btn';
    cb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    cb.addEventListener('click', (e) => { e.stopPropagation(); send('terminal:destroy', { id }); });
    li.appendChild(cb);
    li.addEventListener('click', () => { if (S.linkMode) handleLinkClick(id); else { setActive(id); focusTerm(id); } });
    li.addEventListener('dblclick', (e) => { e.preventDefault(); showEditDialog(id); });
    tl.appendChild(li);
  }
  if (S.terminals.size === 0) { const e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No terminals yet'; tl.appendChild(e); }

  // Link list
  const ll = document.getElementById('link-list');
  ll.innerHTML = '';
  for (const link of S.links) {
    const f = S.terminals.get(link.from), t = S.terminals.get(link.to);
    if (!f || !t) continue;
    const li = document.createElement('li'); li.className = 'link-list-item';
    li.innerHTML = `<span>${f.name}</span><span class="link-line"> ↔ </span><span>${t.name}</span>`;
    const ub = document.createElement('button'); ub.className = 'unlink-btn'; ub.textContent = 'unlink';
    ub.addEventListener('click', () => send('terminal:unlink', { from: link.from, to: link.to }));
    li.appendChild(ub);
    ll.appendChild(li);
  }
  if (S.links.length === 0) { const e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No linked terminals'; ll.appendChild(e); }
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
    showNotif(`Linked "${S.terminals.get(S.linkSource)?.name}" ↔ "${S.terminals.get(id)?.name}"`, 'success');
    exitLinkMode();
  }
}

function showNotif(text, type = 'attention') {
  const c = document.getElementById('notifications');
  const el = document.createElement('div'); el.className = `notification ${type}`; el.textContent = text;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3000);
}

function updateConn() {
  const dot = document.getElementById('status-dot'), txt = document.getElementById('status-text');
  dot.classList.toggle('connected', S.connected);
  txt.textContent = S.connected ? 'Connected' : 'Disconnected';
}

function fitAll() {
  for (const [id, t] of S.terminals) {
    try { t.fitAddon.fit(); send('terminal:resize', { id, cols: t.xterm.cols, rows: t.xterm.rows }); } catch (e) {}
  }
}

// ============================================
// Dialogs
// ============================================
function showCreateDialog() {
  const d = document.getElementById('create-dialog');
  document.getElementById('create-name').value = `Terminal ${S.terminals.size + 1}`;
  document.getElementById('create-role').value = '';
  document.getElementById('create-cwd').value = '';
  d.showModal();
  document.getElementById('create-name').focus();
  document.getElementById('create-name').select();
}

function showEditDialog(id) {
  const t = S.terminals.get(id);
  if (!t) return;
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-name').value = t.name;
  document.getElementById('edit-role').value = t.role || '';
  document.getElementById('edit-status').value = t.status || 'idle';
  const d = document.getElementById('edit-dialog');
  d.showModal();
  document.getElementById('edit-name').focus();
  document.getElementById('edit-name').select();
}

function openSendDialog() {
  if (!S.activeTerminalId) { showNotif('No active terminal', 'warning'); return; }
  const linked = getLinked(S.activeTerminalId);
  if (!linked.length) { showNotif('No linked terminals', 'warning'); return; }
  const d = document.getElementById('send-dialog'), sel = document.getElementById('send-target'), ta = document.getElementById('send-text');
  sel.innerHTML = '';
  for (const id of linked) { const t = S.terminals.get(id); if (t) { const o = document.createElement('option'); o.value = id; o.textContent = t.name; sel.appendChild(o); } }
  ta.value = '';
  d.showModal(); ta.focus();
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
        case 'H': e.preventDefault(); if (S.activeTerminalId) send('terminal:create', { name: `Terminal ${S.terminals.size + 1}` }); break;
        case 'V': e.preventDefault(); if (S.activeTerminalId) { S._splitDir = 'vertical'; send('terminal:create', { name: `Terminal ${S.terminals.size + 1}` }); } break;
        case 'L': e.preventDefault(); S.linkMode ? exitLinkMode() : enterLinkMode(); break;
        case 'S': e.preventDefault(); openSendDialog(); break;
        case 'W': e.preventDefault(); if (S.activeTerminalId) send('terminal:destroy', { id: S.activeTerminalId }); break;
      }
    }
    if (e.key === 'Escape' && S.linkMode) exitLinkMode();
    if (e.ctrlKey && e.shiftKey && (e.key === '[' || e.key === '{')) { e.preventDefault(); navTerminals(-1); }
    if (e.ctrlKey && e.shiftKey && (e.key === ']' || e.key === '}')) { e.preventDefault(); navTerminals(1); }
  });
}

function navTerminals(dir) {
  const ids = [...S.terminals.keys()];
  if (!ids.length) return;
  let idx = ids.indexOf(S.activeTerminalId) + dir;
  if (idx < 0) idx = ids.length - 1;
  if (idx >= ids.length) idx = 0;
  setActive(ids[idx]); focusTerm(ids[idx]);
}

// ============================================
// Setup UI
// ============================================
function setupUI() {
  document.getElementById('btn-new-terminal').addEventListener('click', showCreateDialog);
  document.getElementById('btn-toggle-browser').addEventListener('click', () => toggleBrowser());
  document.getElementById('btn-link-mode').addEventListener('click', () => S.linkMode ? exitLinkMode() : enterLinkMode());
  document.getElementById('btn-cancel-link').addEventListener('click', exitLinkMode);
  document.getElementById('btn-split-h').addEventListener('click', () => {
    if (S.activeTerminalId) send('terminal:create', { name: `Terminal ${S.terminals.size + 1}` });
    else showCreateDialog();
  });
  document.getElementById('btn-split-v').addEventListener('click', () => {
    if (S.activeTerminalId) { S._splitDir = 'vertical'; send('terminal:create', { name: `Terminal ${S.terminals.size + 1}` }); }
    else showCreateDialog();
  });
  document.getElementById('btn-send-linked').addEventListener('click', openSendDialog);

  // Create dialog
  document.getElementById('create-confirm').addEventListener('click', () => {
    const name = document.getElementById('create-name').value.trim() || `Terminal ${S.terminals.size + 1}`;
    const role = document.getElementById('create-role').value || undefined;
    const cwd = document.getElementById('create-cwd').value.trim() || undefined;
    send('terminal:create', { name, role, cwd });
    document.getElementById('create-dialog').close();
  });
  document.getElementById('create-cancel').addEventListener('click', () => document.getElementById('create-dialog').close());
  document.getElementById('create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('create-confirm').click(); });

  // Send dialog
  document.getElementById('send-confirm').addEventListener('click', () => {
    const target = document.getElementById('send-target').value, text = document.getElementById('send-text').value;
    if (target && text) { send('terminal:send-to-linked', { from: S.activeTerminalId, to: target, text: text + '\n' }); showNotif('Sent', 'success'); }
    document.getElementById('send-dialog').close();
  });
  document.getElementById('send-cancel').addEventListener('click', () => document.getElementById('send-dialog').close());
  document.getElementById('send-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) document.getElementById('send-confirm').click(); });

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

  // Browser panel
  document.getElementById('btn-add-browser-tab').addEventListener('click', () => addBrowserTab());
  document.getElementById('btn-close-browser').addEventListener('click', () => toggleBrowser(false));
  document.getElementById('browser-url').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      let url = e.target.value.trim();
      if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) { url = 'https://' + url; e.target.value = url; }
      const tab = S.browserTabs[S.activeBrowserTab];
      if (tab) { tab.url = url; try { tab.title = new URL(url).hostname; } catch (er) {} }
      navigateBrowserTab();
      renderBrowserTabs();
      persistBrowser();
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
// Init
// ============================================
setupUI();
setupKeys();
renderLayout();
connectWs();
