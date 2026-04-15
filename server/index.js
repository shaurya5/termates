import { execSync } from 'child_process';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import fs from 'fs';
import os from 'os';
import { PtyManager } from './pty-manager.js';
import { LinkManager } from './link-manager.js';
import { StateManager } from './state-manager.js';
import { parseSSHConfig, buildRemoteTmuxCommand } from './ssh-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '7680', 10);
const SOCKET_PATH = path.join(os.tmpdir(), 'termates.sock');

// --- Express App ---
const app = express();
const httpServer = createServer(app);

app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(ROOT, 'node_modules', 'xterm-addon-fit')));
app.use('/vendor/xterm-addon-web-links', express.static(path.join(ROOT, 'node_modules', 'xterm-addon-web-links')));
app.use(express.json());

// --- Managers ---
const ptyManager = new PtyManager();
const linkManager = new LinkManager();
const stateManager = new StateManager();

// --- State persistence helpers ---
function persistState() {
  stateManager.setTerminals(ptyManager.list());
  stateManager.setNextTerminalId(ptyManager.nextId);
  // Sync workspace state with actual terminals
  stateManager.setWorkspaces(stateManager.get().workspaces);
}

function addTerminalToWorkspace(terminalId) {
  const saved = stateManager.get();
  const wsId = saved.activeWorkspaceId || saved.workspaces[0]?.id;
  const ws = saved.workspaces.find(w => w.id === wsId);
  if (ws && !ws.terminalIds.includes(terminalId)) {
    ws.terminalIds.push(terminalId);
    stateManager.setWorkspaces(saved.workspaces);
  }
}

function removeTerminalFromWorkspaces(terminalId) {
  const saved = stateManager.get();
  for (const ws of saved.workspaces) {
    ws.terminalIds = ws.terminalIds.filter(id => id !== terminalId);
    ws.links = (ws.links || []).filter(l => l.from !== terminalId && l.to !== terminalId);
    if (ws.layout) {
      ws.layout = removeLayoutLeaf(ws.layout, terminalId);
    }
  }
  stateManager.setWorkspaces(saved.workspaces);
}

function removeLayoutLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'leaf') return node.panelId === id ? null : node;
  if (node.type === 'split') {
    const l = removeLayoutLeaf(node.children[0], id);
    const r = removeLayoutLeaf(node.children[1], id);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...node, children: [l, r] };
  }
  return node;
}

function subscribeTerminalOutput(terminal) {
  terminal.onData((data) => {
    broadcast({ type: 'terminal:output', payload: { id: terminal.id, data } });
  });
  // Auto-cleanup when the process exits
  terminal.onExit((id) => {
    setTimeout(() => cleanupDeadTerminal(id), 500);
  });
}

function cleanupDeadTerminal(id) {
  if (!ptyManager.get(id)) return;
  linkManager.removeTerminal(id);
  removeTerminalFromWorkspaces(id);
  ptyManager.destroy(id);
  broadcast({ type: 'terminal:destroyed', payload: { id } });
  persistState();
}

// Periodically check for dead tmux sessions and clean up ghost terminals.
// This catches cases where onExit doesn't fire (e.g. tmux killed externally).
setInterval(() => {
  if (!ptyManager.tmuxAvailable) return;
  const alive = new Set(ptyManager.listAliveTmuxSessions());
  for (const t of ptyManager.list()) {
    if (t.tmuxSession && !alive.has(t.tmuxSession)) {
      cleanupDeadTerminal(t.id);
    }
  }
}, 3000);

// --- Restore previous session ---
function restoreSession() {
  const loaded = stateManager.load();
  if (!loaded) return;

  const saved = stateManager.get();
  ptyManager.setNextId(saved.nextTerminalId || 1);

  const aliveSessions = ptyManager.listAliveTmuxSessions();
  let restored = 0;

  for (const savedTerm of (saved.terminals || [])) {
    const tmuxName = `termates-${savedTerm.id}`;
    if (aliveSessions.includes(tmuxName)) {
      const terminal = ptyManager.reattach({
        id: savedTerm.id,
        name: savedTerm.name,
        role: savedTerm.role,
        status: savedTerm.status,
      });
      if (terminal) {
        subscribeTerminalOutput(terminal);
        restored++;
      }
    }
  }

  // Restore links per workspace
  for (const ws of (saved.workspaces || [])) {
    for (const link of (ws.links || [])) {
      if (ptyManager.get(link.from) && ptyManager.get(link.to)) {
        linkManager.link(link.from, link.to);
      }
    }
  }

  if (restored > 0) {
    console.log(`  [restore] Reattached to ${restored} persistent terminal(s)`);
  }
}

// --- WebSocket Server ---
const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      handleWsMessage(ws, JSON.parse(raw.toString()));
    } catch (e) {
      sendTo(ws, { type: 'error', payload: { message: 'Invalid JSON' } });
    }
  });
});

function handleWsMessage(ws, msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'terminal:create': {
      const { name, shell, cwd, role, sshTarget, remoteCwd } = payload || {};
      let terminal;
      // Check if active workspace is remote
      const wsState = stateManager.get();
      const activeWsState = wsState.workspaces.find(w => w.id === wsState.activeWorkspaceId);
      if (activeWsState?.sshTarget) {
        // Auto-create as remote terminal using workspace's SSH target
        terminal = ptyManager.createRemote({
          name: name || `Terminal ${ptyManager.size + 1}`,
          role, sshTarget: activeWsState.sshTarget,
          remoteCwd: remoteCwd || activeWsState.remoteCwd,
        });
      } else if (sshTarget) {
        terminal = ptyManager.createRemote({ name, role, sshTarget, remoteCwd });
      } else {
        // Inherit working directory from workspace if not explicitly set
        const effectiveCwd = cwd || activeWsState?.cwd || undefined;
        terminal = ptyManager.create({ name: name || `Terminal ${ptyManager.size + 1}`, shell, cwd: effectiveCwd, role });
      }
      subscribeTerminalOutput(terminal);
      addTerminalToWorkspace(terminal.id);
      broadcast({
        type: 'terminal:created',
        payload: { id: terminal.id, name: terminal.name, role: terminal.role, status: terminal.status },
      });
      persistState();
      break;
    }

    case 'terminal:input': {
      // Strip DA query/response escape sequences that xterm.js sends.
      // These leak into the shell via tmux and cause garbled output.
      const clean = payload.data.replace(/\x1b\[[\?>]?[\d;]*c/g, '');
      if (clean) ptyManager.write(payload.id, clean);
      break;
    }

    case 'terminal:resize': {
      ptyManager.resize(payload.id, payload.cols, payload.rows);
      break;
    }

    case 'terminal:rename': {
      if (ptyManager.rename(payload.id, payload.name)) {
        broadcast({ type: 'terminal:renamed', payload: { id: payload.id, name: payload.name } });
        persistState();
      }
      break;
    }

    case 'terminal:configure': {
      const { id, name, role } = payload;
      if (name !== undefined) ptyManager.rename(id, name);
      if (role !== undefined) ptyManager.setRole(id, role);
      broadcast({ type: 'terminal:configured', payload: { id, name, role } });
      persistState();
      break;
    }

    case 'terminal:destroy': {
      const { id } = payload;
      const removedLinks = linkManager.getLinksFor(id);
      ptyManager.destroy(id);
      linkManager.removeTerminal(id);
      removeTerminalFromWorkspaces(id);
      broadcast({ type: 'terminal:destroyed', payload: { id } });
      for (const link of removedLinks) {
        broadcast({ type: 'terminal:unlinked', payload: { from: link.from, to: link.to } });
      }
      persistState();
      break;
    }

    case 'terminal:link': {
      const { from, to } = payload;
      if (linkManager.link(from, to)) {
        broadcast({ type: 'terminal:linked', payload: { from, to } });
        persistState();
      }
      break;
    }

    case 'terminal:unlink': {
      const { from, to } = payload;
      if (linkManager.unlink(from, to)) {
        broadcast({ type: 'terminal:unlinked', payload: { from, to } });
        persistState();
      }
      break;
    }

    case 'terminal:send-to-linked': {
      const { from, to, text } = payload;
      if (linkManager.areLinked(from, to)) {
        ptyManager.write(to, text);
        broadcast({ type: 'terminal:message-sent', payload: { from, to, text, timestamp: Date.now() } });
      }
      break;
    }

    case 'terminal:status': {
      if (ptyManager.setStatus(payload.id, payload.status)) {
        broadcast({ type: 'terminal:status-changed', payload: { id: payload.id, status: payload.status } });
        persistState();
      }
      break;
    }

    case 'terminal:list': {
      const saved = stateManager.get();
      const termList = ptyManager.list();
      sendTo(ws, {
        type: 'terminal:list',
        payload: {
          terminals: termList,
          workspaces: saved.workspaces || [],
          activeWorkspaceId: saved.activeWorkspaceId || 'w1',
          nextWorkspaceId: saved.nextWorkspaceId || 2,
          browserTabs: saved.browserTabs || [],
          activeBrowserTab: saved.activeBrowserTab || 0,
          browserOpen: saved.browserOpen || false,
          browserWidth: saved.browserWidth || 0.35,
        },
      });
      // Send buffered content for each terminal so restored xterms aren't blank
      for (const t of termList) {
        const term = ptyManager.get(t.id);
        if (term && term.buffer.length > 0) {
          sendTo(ws, { type: 'terminal:output', payload: { id: t.id, data: term.buffer.join('') } });
        }
      }
      break;
    }

    // --- Workspace sync ---
    case 'workspace:update': {
      stateManager.setWorkspaces(payload.workspaces);
      if (payload.activeWorkspaceId !== undefined) stateManager.setActiveWorkspaceId(payload.activeWorkspaceId);
      if (payload.nextWorkspaceId !== undefined) stateManager.setNextWorkspaceId(payload.nextWorkspaceId);
      break;
    }

    case 'browser:update': {
      if (payload.tabs !== undefined) stateManager.setBrowserTabs(payload.tabs);
      if (payload.activeTab !== undefined) stateManager.setActiveBrowserTab(payload.activeTab);
      if (payload.open !== undefined) stateManager.setBrowserOpen(payload.open);
      if (payload.width !== undefined) stateManager.setBrowserWidth(payload.width);
      break;
    }

    default:
      sendTo(ws, { type: 'error', payload: { message: `Unknown type: ${type}` } });
  }
}

// --- Browser Proxy ---
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL parameter required' });
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    const skipHeaders = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'content-encoding', 'transfer-encoding']);
    for (const [key, value] of response.headers) {
      if (!skipHeaders.has(key.toLowerCase())) res.set(key, value);
    }
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (contentType.includes('text/html')) {
      let html = buffer.toString('utf-8');
      const baseUrl = new URL(url);
      const baseHref = `<base href="${baseUrl.origin}${baseUrl.pathname.replace(/\/[^/]*$/, '/')}">`;
      html = html.replace(/<head([^>]*)>/i, `<head$1>${baseHref}`);
      res.type('text/html').send(html);
    } else {
      res.send(buffer);
    }
  } catch (err) {
    res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
});

app.get('/api/browser/snapshot', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL parameter required' });
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Termates/1.0)' } });
    const html = await response.text();
    const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    res.json({ url, text: text.substring(0, 20000), length: text.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/terminals', (req, res) => {
  res.json({ terminals: ptyManager.list(), links: linkManager.listAll() });
});

// SSH hosts from ~/.ssh/config
app.get('/api/ssh/hosts', (req, res) => {
  res.json({ hosts: parseSSHConfig() });
});

// Directory listing for browse dialog
app.get('/api/browse', (req, res) => {
  let query = (req.query.path || '').trim();
  const home = os.homedir();

  // Expand ~
  if (query.startsWith('~')) query = query.replace(/^~/, home);

  // If empty, list home directory
  if (!query) {
    return listDir(home, '', res);
  }
  // Bare word (no / prefix) — search home + common subdirectories
  if (!query.startsWith('/')) {
    const filter = query.toLowerCase();
    const searchDirs = [home];
    // Add common project directories
    for (const sub of ['projects', 'Developer', 'Documents', 'Desktop', 'repos', 'code', 'workspace', 'src', 'work']) {
      const p = path.join(home, sub);
      try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) searchDirs.push(p); } catch (e) {}
    }
    const allResults = [];
    const seen = new Set();
    for (const dir of searchDirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue;
          if (e.name.toLowerCase().includes(filter)) {
            const full = path.join(dir, e.name);
            if (!seen.has(full)) { seen.add(full); allResults.push({ name: e.name, path: full }); }
          }
        }
      } catch (e) {}
    }
    allResults.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ current: home, dirs: allResults.slice(0, 25) });
  }

  // Absolute path: if it's a valid directory, list its children
  try {
    if (fs.existsSync(query) && fs.statSync(query).isDirectory()) {
      return listDir(query, '', res);
    }
  } catch (e) {}

  // Partial path: /Users/shauryag/proj → search /Users/shauryag for "proj"
  const parentDir = path.dirname(query);
  const filter = path.basename(query).toLowerCase();
  return listDir(parentDir, filter, res);
});

function listDir(dir, filter, res) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let dirs = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith('.')) return false;
        if (filter) return e.name.toLowerCase().includes(filter);
        return true;
      })
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ current: dir, dirs: dirs.slice(0, 25) });
  } catch (e) {
    res.json({ current: dir, dirs: [], error: e.message });
  }
}

// --- Update API (reads state from Electron's global, or checks GitHub directly) ---
app.get('/api/update/status', async (req, res) => {
  if (global.termatesUpdate) {
    const u = global.termatesUpdate;
    res.json({ status: u.status, currentVersion: u.currentVersion, latestVersion: u.latestVersion, releaseNotes: u.releaseNotes, releaseUrl: u.releaseUrl || null, progress: u.progress, error: u.error });
  } else {
    // Server-only mode (no Electron) — check GitHub directly
    try {
      const ghRes = await fetch('https://api.github.com/repos/shaurya5/termates/releases/latest', { headers: { 'User-Agent': 'Termates' } });
      if (!ghRes.ok) { res.json({ status: 'idle', currentVersion: '1.0.0' }); return; }
      const data = await ghRes.json();
      const pkg = await import('../package.json', { with: { type: 'json' } });
      const current = pkg.default.version;
      const latest = data.tag_name?.replace(/^v/, '');
      res.json({ status: latest !== current ? 'available' : 'idle', currentVersion: current, latestVersion: latest, releaseUrl: data.html_url, releaseNotes: data.body });
    } catch (e) { res.json({ status: 'idle', currentVersion: '1.0.0' }); }
  }
});

app.post('/api/update/download', (req, res) => {
  if (global.termatesUpdate?.download) { global.termatesUpdate.download(); res.json({ ok: true }); }
  else res.json({ ok: false, error: 'Not available in this mode' });
});

app.post('/api/update/install', (req, res) => {
  if (global.termatesUpdate?.install) { global.termatesUpdate.install(); res.json({ ok: true }); }
  else res.json({ ok: false, error: 'Not available in this mode' });
});

// --- Unix Domain Socket for CLI ---
function cleanupSocket() {
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (e) { /* ignore */ }
}
cleanupSocket();

const unixServer = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        try { handleCliCommand(socket, JSON.parse(line)); } catch (e) { socket.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n'); }
      }
    }
    if (buf.trim()) {
      try { const m = JSON.parse(buf); buf = ''; handleCliCommand(socket, m); } catch (e) { /* wait */ }
    }
  });
  socket.on('error', () => {});
});

function handleCliCommand(socket, msg) {
  const respond = (data) => { try { socket.write(JSON.stringify(data) + '\n'); socket.end(); } catch (e) {} };
  try {
    switch (msg.command) {
      case 'ping':
        respond({ ok: true, version: '1.0.0', uptime: process.uptime(), persistent: ptyManager.tmuxAvailable });
        break;

      case 'list':
        respond({ ok: true, terminals: ptyManager.list(), links: linkManager.listAll(), notes: linkManager.listNotes() });
        break;

      case 'create': {
        const terminal = ptyManager.create({ name: msg.name, shell: msg.shell, cwd: msg.cwd, role: msg.role });
        subscribeTerminalOutput(terminal);
        addTerminalToWorkspace(terminal.id);
        broadcast({ type: 'terminal:created', payload: { id: terminal.id, name: terminal.name, role: terminal.role, status: terminal.status } });
        persistState();
        respond({ ok: true, id: terminal.id, name: terminal.name });
        break;
      }

      case 'ssh': {
        const terminal = ptyManager.createSsh({ name: msg.name, role: msg.role, target: msg.target });
        subscribeTerminalOutput(terminal);
        addTerminalToWorkspace(terminal.id);
        broadcast({ type: 'terminal:created', payload: { id: terminal.id, name: terminal.name, role: terminal.role, status: terminal.status } });
        persistState();
        respond({ ok: true, id: terminal.id, name: terminal.name });
        break;
      }

      case 'send': {
        const t = ptyManager.resolve(msg.target || msg.id || msg.name);
        if (t) { ptyManager.write(t.id, msg.text + '\n'); respond({ ok: true, id: t.id }); }
        else respond({ ok: false, error: `Terminal not found: ${msg.target || msg.id || msg.name}` });
        break;
      }

      case 'read': {
        const t = ptyManager.resolve(msg.target || msg.id || msg.name);
        if (t) respond({ ok: true, id: t.id, buffer: t.getBuffer(msg.lines || 50) });
        else respond({ ok: false, error: `Terminal not found: ${msg.target || msg.id || msg.name}` });
        break;
      }

      case 'link': {
        const from = ptyManager.resolve(msg.from), to = ptyManager.resolve(msg.to);
        if (!from) { respond({ ok: false, error: `Terminal not found: ${msg.from}` }); break; }
        if (!to) { respond({ ok: false, error: `Terminal not found: ${msg.to}` }); break; }
        linkManager.link(from.id, to.id);
        broadcast({ type: 'terminal:linked', payload: { from: from.id, to: to.id } });
        persistState();
        respond({ ok: true, from: from.id, to: to.id });
        break;
      }

      case 'unlink': {
        const from = ptyManager.resolve(msg.from), to = ptyManager.resolve(msg.to);
        if (from && to) { linkManager.unlink(from.id, to.id); broadcast({ type: 'terminal:unlinked', payload: { from: from.id, to: to.id } }); persistState(); }
        respond({ ok: true });
        break;
      }

      case 'ask': {
        const from = ptyManager.resolve(msg.from), to = ptyManager.resolve(msg.to);
        if (!from || !to) { respond({ ok: false, error: 'Terminal(s) not found' }); break; }
        if (!linkManager.areLinked(from.id, to.id)) { respond({ ok: false, error: 'Terminals not linked' }); break; }
        ptyManager.write(to.id, msg.text + '\n');
        broadcast({ type: 'terminal:message-sent', payload: { from: from.id, to: to.id, text: msg.text, timestamp: Date.now() } });
        respond({ ok: true });
        break;
      }

      case 'notify': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t) { ptyManager.setStatus(t.id, msg.status || 'attention'); broadcast({ type: 'terminal:notification', payload: { id: t.id, status: msg.status || 'attention', text: msg.text || '' } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found' });
        break;
      }

      case 'status': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t) { ptyManager.setStatus(t.id, msg.status); broadcast({ type: 'terminal:status-changed', payload: { id: t.id, status: msg.status } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found' });
        break;
      }

      case 'destroy': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t) { linkManager.removeTerminal(t.id); removeTerminalFromWorkspaces(t.id); ptyManager.destroy(t.id); broadcast({ type: 'terminal:destroyed', payload: { id: t.id } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found' });
        break;
      }

      case 'rename': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t && msg.name) { ptyManager.rename(t.id, msg.name); broadcast({ type: 'terminal:renamed', payload: { id: t.id, name: msg.name } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found or name missing' });
        break;
      }

      case 'browser-snapshot': {
        fetch(msg.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Termates/1.0)' } })
          .then(r => r.text())
          .then(html => { const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); respond({ ok: true, url: msg.url, text: text.substring(0, 20000) }); })
          .catch(err => respond({ ok: false, error: err.message }));
        return;
      }

      default:
        respond({ ok: false, error: `Unknown command: ${msg.command}` });
    }
  } catch (err) {
    console.error(`CLI error (${msg.command}):`, err);
    respond({ ok: false, error: err.message || 'Internal error' });
  }
}

unixServer.listen(SOCKET_PATH, () => {
  try { fs.chmodSync(SOCKET_PATH, 0o666); } catch (e) {}
});

// --- Restore session and start ---
restoreSession();

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Another instance may be running.`);
    // Try to kill the existing process and retry once
    try {
      execSync(`lsof -ti :${PORT} | xargs kill 2>/dev/null`, { stdio: 'pipe' });
      console.log('  Killed existing process, retrying...');
      setTimeout(() => httpServer.listen(PORT, '127.0.0.1'), 1500);
      return;
    } catch (e) {
      console.error(`  Could not free port. Run: lsof -ti :${PORT} | xargs kill`);
      process.exit(1);
    }
  }
  throw err;
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║           T E R M A T E S            ║');
  console.log('  ║   On-Device Terminal Multiplexer     ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  ➜  App:      http://localhost:${PORT}`);
  console.log(`  ➜  Socket:   ${SOCKET_PATH}`);
  console.log(`  ➜  State:    ~/.termates/state.json`);
  console.log(`  ➜  Persist:  ${ptyManager.tmuxAvailable ? 'tmux (terminals survive restarts)' : 'none (install tmux for persistence)'}`);
  console.log('');
  console.log('  All data stays on this device. No telemetry.');
  console.log('');
});

// --- Shutdown: save state, detach PTYs, keep tmux alive ---
function shutdown() {
  persistState();
  stateManager.saveNow();
  cleanupSocket();
  ptyManager.detachAll(); // Detach PTYs but keep tmux sessions
  unixServer.close();
  httpServer.close();
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); shutdown(); process.exit(1); });
