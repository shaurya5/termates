import { execSync } from 'child_process';
import express from 'express';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { PtyManager } from './pty-manager.js';
import { LinkManager } from './link-manager.js';
import { StateManager } from './state-manager.js';
import { parseSSHConfig } from './ssh-config.js';
import {
  persistState, addTerminalToWorkspace, removeTerminalFromWorkspaces,
  subscribeTerminalOutput, cleanupDeadTerminal, restoreSession,
} from './orchestration.js';
import { setupWebSocket } from './ws-handler.js';
import { setupCliSocket } from './cli-handler.js';

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

// --- Broadcast / sendTo helpers ---
let wss; // assigned after setupWebSocket

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

// --- Bound orchestration helpers (close over managers for convenience) ---
const doPersist = () => persistState(stateManager, ptyManager);
const doAddToWorkspace = (terminalId) => addTerminalToWorkspace(stateManager, terminalId);
const doRemoveFromWorkspaces = (terminalId) => removeTerminalFromWorkspaces(stateManager, terminalId);
const doCleanup = (id) => cleanupDeadTerminal(id, ptyManager, linkManager, stateManager, broadcast);
const doSubscribe = (terminal) => subscribeTerminalOutput(terminal, broadcast, doCleanup);

// --- Shared context for handlers ---
const ctx = {
  ptyManager,
  linkManager,
  stateManager,
  broadcast,
  sendTo,
  persistState: doPersist,
  addTerminalToWorkspace: doAddToWorkspace,
  removeTerminalFromWorkspaces: doRemoveFromWorkspaces,
  subscribeTerminalOutput: doSubscribe,
};

// --- WebSocket Server ---
wss = setupWebSocket(httpServer, ctx);

// --- Tmux health check ---
setInterval(() => {
  if (!ptyManager.tmuxAvailable) return;
  const alive = new Set(ptyManager.listAliveTmuxSessions());
  for (const t of ptyManager.list()) {
    if (t.tmuxSession && !alive.has(t.tmuxSession)) {
      doCleanup(t.id);
    }
  }
}, 3000);

// --- REST routes ---
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

app.post('/api/browse-dialog', async (req, res) => {
  if (global.termatesDialog?.browseFolder) {
    const selected = await global.termatesDialog.browseFolder();
    res.json({ path: selected });
  } else {
    res.json({ path: null, error: 'Native dialog not available in server mode' });
  }
});

app.get('/api/ssh/hosts', (req, res) => {
  res.json({ hosts: parseSSHConfig() });
});

app.get('/api/browse', (req, res) => {
  let query = (req.query.path || '').trim();
  const home = os.homedir();
  if (query.startsWith('~')) query = query.replace(/^~/, home);
  if (!query) {
    return listDir(home, '', res);
  }
  if (!query.startsWith('/')) {
    const filter = query.toLowerCase();
    const searchDirs = [home];
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
  try {
    if (fs.existsSync(query) && fs.statSync(query).isDirectory()) {
      return listDir(query, '', res);
    }
  } catch (e) {}
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

app.get('/api/update/status', async (req, res) => {
  if (global.termatesUpdate) {
    const u = global.termatesUpdate;
    res.json({ status: u.status, currentVersion: u.currentVersion, latestVersion: u.latestVersion, releaseNotes: u.releaseNotes, releaseUrl: u.releaseUrl || null, progress: u.progress, error: u.error });
  } else {
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

// --- CLI Socket ---
const unixServer = setupCliSocket(SOCKET_PATH, ctx);

// --- Restore session and start ---
restoreSession(stateManager, ptyManager, linkManager, doSubscribe);

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Another instance may be running.`);
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

// --- Shutdown: save state, detach PTYs (keep tmux alive), clean up socket ---
function shutdown() {
  doPersist();
  stateManager.saveNow();
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (e) {}
  ptyManager.detachAll(); // Detach PTYs but keep tmux sessions alive
  unixServer.close();
  httpServer.close();
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); shutdown(); process.exit(1); });

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
  doPersist();
  stateManager.saveNow();
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (e) { /* ignore */ }
  ptyManager.detachAll();
  unixServer.close();
  httpServer.close();
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); shutdown(); process.exit(1); });
