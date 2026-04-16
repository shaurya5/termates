/**
 * Integration tests for Termates session persistence & restore.
 *
 * These tests verify the full persistence cycle:
 *   1. Start server (port 17681), create a terminal.
 *   2. Kill the server with SIGTERM — the backend session must survive.
 *   3. Restart the server on the same port — the terminal should be restored.
 *   4. Send a command to the restored terminal and verify output flows.
 *
 * Persistence backend is selected by the server: abduco > tmux > none.
 * The tmux backend uses a private socket at ~/.termates/tmux.sock (not the
 * default socket), so the helpers below mirror that.
 *
 * ⚠  The Unix socket path (os.tmpdir()/termates.sock) is hardcoded in the
 *    server; it cannot be overridden via env.  Do NOT run this file in parallel
 *    with server.test.js or cli.test.js.
 *
 * ⚠  The state file (~/.termates/state.json) is also hardcoded.  This file is
 *    backed up before every test run and restored afterwards so that normal
 *    Termates usage is not affected.
 *
 * Persistence tests are skipped when neither abduco nor tmux is available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, execFileSync } from 'child_process';
import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'server', 'index.js');
const SOCKET_PATH = path.join(os.tmpdir(), 'termates.sock');
const STATE_DIR = path.join(os.homedir(), '.termates');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TEST_PORT = 17681;

// ─── Backend detection ────────────────────────────────────────────────────────
// Mirrors server/persistence-backend.js: abduco > tmux > none. On Linux CI
// abduco is not bundled, so tmux (installed via apt) is the active backend.

const HOME_STATE_DIR = path.join(os.homedir(), '.termates');
const PRIVATE_TMUX_SOCKET = path.join(HOME_STATE_DIR, 'tmux.sock');
const ABDUCO_DIR = path.join(HOME_STATE_DIR, 'abduco');

function hasBin(name) {
  try { execSync(`command -v ${name}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function bundledAbduco() {
  const p = path.join(ROOT, 'binaries', `abduco-${process.platform}-${process.arch}`);
  try { return fs.existsSync(p) && (fs.statSync(p).mode & 0o111) ? p : null; }
  catch { return null; }
}

const abducoAvailable = !!bundledAbduco() || hasBin('abduco');
const tmuxAvailable = hasBin('tmux');
const persistenceAvailable = abducoAvailable || tmuxAvailable;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitForPort(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const s = net.createConnection({ port, host: '127.0.0.1' });
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        else setTimeout(attempt, 150);
      });
    }
    attempt();
  });
}

function waitForSocket(socketPath, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const s = net.createConnection(socketPath);
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Socket not ready after ${timeoutMs}ms`));
        else setTimeout(attempt, 150);
      });
    }
    attempt();
  });
}

function waitForSocketGone(socketPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const s = net.createConnection(socketPath);
      s.on('connect', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('Socket still up after timeout'));
        else setTimeout(attempt, 150);
      });
      s.on('error', () => resolve()); // connection refused → server is down
    }
    attempt();
  });
}

/**
 * Start the server and wait until it is fully ready.
 * Returns the child process.
 */
async function startServer() {
  const proc = spawn('node', [SERVER_PATH], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('error', err => { throw new Error(`Server spawn failed: ${err.message}`); });

  await waitForPort(TEST_PORT, 25000);
  await waitForSocket(SOCKET_PATH, 25000);
  return proc;
}

/**
 * Gracefully stop a server and wait for the Unix socket to disappear.
 */
async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  await new Promise(r => proc.on('close', r));
  // Give the OS a moment to release the socket file
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Send a command over the Unix socket and resolve with the parsed response.
 */
function sendUnixCommand(command, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    let data = '';
    client.setTimeout(timeoutMs, () => {
      client.destroy();
      reject(new Error('Unix socket command timed out'));
    });
    client.on('connect', () => { client.write(JSON.stringify(command) + '\n'); });
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => {
      try {
        const lines = data.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) {
        reject(new Error(`Bad response: ${data}`));
      }
    });
    client.on('error', reject);
  });
}

/**
 * Return true when a backend session with the given name exists. Checks
 * abduco (socket file under ~/.termates/abduco/) then tmux on the private
 * socket the server uses (~/.termates/tmux.sock).
 */
function abducoSocketFound(sessionName, dir = ABDUCO_DIR) {
  // abduco stores sockets at either `<dir>/<session>` (custom ABDUCO_SOCKET_DIR
  // layouts) or `<dir>/<binary>/<user>/<session>@<host>` (its default nesting
  // on macOS). Walk recursively and match either form.
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.name === sessionName || e.name.startsWith(`${sessionName}@`)) return true;
    if (e.isDirectory() && abducoSocketFound(sessionName, full)) return true;
  }
  return false;
}

function backendSessionExists(sessionName) {
  if (abducoSocketFound(sessionName)) return true;
  if (tmuxAvailable) {
    try {
      execSync(
        `tmux -S "${PRIVATE_TMUX_SOCKET}" has-session -t "${sessionName}" 2>/dev/null`,
        { stdio: 'pipe' },
      );
      return true;
    } catch { /* fallthrough */ }
  }
  return false;
}

/**
 * Kill a backend session by name (best-effort, ignores errors). Tries the
 * abduco socket file first, then tmux on the private socket.
 */
function findAbducoSocketPath(sessionName, dir = ABDUCO_DIR) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.name === sessionName || e.name.startsWith(`${sessionName}@`)) return full;
    if (e.isDirectory()) {
      const nested = findAbducoSocketPath(sessionName, full);
      if (nested) return nested;
    }
  }
  return null;
}

function backendKillSession(sessionName) {
  const abducoSock = findAbducoSocketPath(sessionName);
  if (abducoSock) {
    try {
      const pids = execSync(`lsof -t -- "${abducoSock}" 2>/dev/null`, { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    try { fs.unlinkSync(abducoSock); } catch { /* ignore */ }
  }
  if (tmuxAvailable) {
    try {
      execSync(
        `tmux -S "${PRIVATE_TMUX_SOCKET}" kill-session -t "${sessionName}" 2>/dev/null`,
        { stdio: 'pipe' },
      );
    } catch { /* already gone */ }
  }
}

// ─── State file backup / restore ──────────────────────────────────────────────

let stateBackup = null;

beforeAll(() => {
  // Back up any existing state file so tests don't corrupt real Termates data.
  try {
    if (fs.existsSync(STATE_FILE)) {
      stateBackup = fs.readFileSync(STATE_FILE, 'utf-8');
    }
  } catch { /* ignore */ }
});

afterAll(() => {
  // Restore original state file.
  try {
    if (stateBackup !== null) {
      fs.writeFileSync(STATE_FILE, stateBackup);
    } else if (fs.existsSync(STATE_FILE)) {
      // There was no state before; remove what we wrote.
      fs.unlinkSync(STATE_FILE);
    }
  } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Session persistence (requires abduco or tmux)', () => {
  it.skipIf(!persistenceAvailable)('creates a backend session when a terminal is created', async () => {
    // Clear any stale state so we start fresh.
    try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch { /* ok */ }

    let server;
    let terminalId;
    const tmuxSessionName = /^termates-/.test('termates-') ? null : null; // computed after create

    try {
      server = await startServer();

      const created = await sendUnixCommand({ command: 'create', name: 'PersistTest' });
      expect(created.ok).toBe(true);
      terminalId = created.id;

      const expectedSession = `termates-${terminalId}`;
      expect(backendSessionExists(expectedSession)).toBe(true);
    } finally {
      if (terminalId) backendKillSession(`termates-${terminalId}`);
      await stopServer(server);
    }
  }, 40000);

  it.skipIf(!persistenceAvailable)('backend session survives server SIGTERM', async () => {
    try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch { /* ok */ }

    let server;
    let terminalId;

    try {
      server = await startServer();

      const created = await sendUnixCommand({ command: 'create', name: 'SurviveTest' });
      expect(created.ok).toBe(true);
      terminalId = created.id;

      // Kill the server
      await stopServer(server);
      server = null;

      // The backend session should still be alive
      expect(backendSessionExists(`termates-${terminalId}`)).toBe(true);
    } finally {
      if (terminalId) backendKillSession(`termates-${terminalId}`);
      if (server) await stopServer(server);
    }
  }, 40000);

  it.skipIf(!persistenceAvailable)('server restores terminal on restart', async () => {
    try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch { /* ok */ }

    let server1;
    let server2;
    let terminalId;

    try {
      // ── Phase 1: start, create terminal, then kill server ──────────────────
      server1 = await startServer();

      const created = await sendUnixCommand({ command: 'create', name: 'RestoreTest' });
      expect(created.ok).toBe(true);
      terminalId = created.id;

      await stopServer(server1);
      server1 = null;

      // Verify the backend session is still alive before we restart
      expect(backendSessionExists(`termates-${terminalId}`)).toBe(true);

      // ── Phase 2: restart the server ────────────────────────────────────────
      server2 = await startServer();

      // List terminals — the restored one should appear
      const list = await sendUnixCommand({ command: 'list' });
      expect(list.ok).toBe(true);
      const restored = list.terminals.find(t => t.id === terminalId);
      expect(restored).toBeDefined();
      expect(restored.name).toBe('RestoreTest');
    } finally {
      if (terminalId) backendKillSession(`termates-${terminalId}`);
      if (server1) await stopServer(server1);
      if (server2) await stopServer(server2);
    }
  }, 60000);

  it.skipIf(!persistenceAvailable)('can send a command to a restored terminal and receive output', async () => {
    try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch { /* ok */ }

    let server1;
    let server2;
    let terminalId;

    try {
      // ── Phase 1: start, create terminal ────────────────────────────────────
      server1 = await startServer();

      const created = await sendUnixCommand({ command: 'create', name: 'OutputTest' });
      expect(created.ok).toBe(true);
      terminalId = created.id;

      // Kill the server
      await stopServer(server1);
      server1 = null;

      // ── Phase 2: restart ───────────────────────────────────────────────────
      server2 = await startServer();

      // Confirm restore
      const list = await sendUnixCommand({ command: 'list' });
      const restored = list.terminals.find(t => t.id === terminalId);
      expect(restored).toBeDefined();

      // Send a command
      const sendRes = await sendUnixCommand({
        command: 'send',
        target: terminalId,
        text: 'echo termates_restore_ok',
      });
      expect(sendRes.ok).toBe(true);

      // Give the shell time to execute
      await new Promise(r => setTimeout(r, 1500));

      // Read back the output
      const readRes = await sendUnixCommand({
        command: 'read',
        target: terminalId,
        lines: 30,
      });
      expect(readRes.ok).toBe(true);
      // The buffer is raw terminal output; the echo output should be present.
      expect(readRes.buffer).toContain('termates_restore_ok');
    } finally {
      if (terminalId) backendKillSession(`termates-${terminalId}`);
      if (server1) await stopServer(server1);
      if (server2) await stopServer(server2);
    }
  }, 60000);
});

describe('Session persistence (no backend fallback)', () => {
  it.skipIf(persistenceAvailable)('creates a terminal without abduco/tmux (PTY-only mode)', async () => {
    try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch { /* ok */ }

    let server;
    try {
      server = await startServer();
      const created = await sendUnixCommand({ command: 'create', name: 'FallbackTest' });
      expect(created.ok).toBe(true);
      expect(typeof created.id).toBe('string');
    } finally {
      await stopServer(server);
    }
  }, 40000);
});
