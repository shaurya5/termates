/**
 * Integration tests for Termates session persistence & restore.
 *
 * These tests verify the full persistence cycle:
 *   1. Start server (port 17681), create a terminal.
 *   2. Kill the server with SIGTERM — tmux session must survive.
 *   3. Restart the server on the same port — the terminal should be restored.
 *   4. Send a command to the restored terminal and verify output flows.
 *
 * ⚠  The Unix socket path (os.tmpdir()/termates.sock) is hardcoded in the
 *    server; it cannot be overridden via env.  Do NOT run this file in parallel
 *    with server.test.js or cli.test.js.
 *
 * ⚠  The state file (~/.termates/state.json) is also hardcoded.  This file is
 *    backed up before every test run and restored afterwards so that normal
 *    Termates usage is not affected.
 *
 * Tests that require tmux are skipped automatically when tmux is not found.
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

// ─── tmux availability ────────────────────────────────────────────────────────

let tmuxAvailable = false;
try {
  execSync('tmux -V', { stdio: 'pipe' });
  tmuxAvailable = true;
} catch { /* not available */ }

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
 * Return true when the named tmux session exists.
 */
function tmuxSessionExists(sessionName) {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/**
 * Kill a tmux session (best-effort, ignores errors).
 */
function tmuxKillSession(sessionName) {
  try { execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' }); }
  catch { /* already gone */ }
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

describe('Session persistence (requires tmux)', () => {
  it.skipIf(!tmuxAvailable)('creates a tmux session when a terminal is created', async () => {
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
      expect(tmuxSessionExists(expectedSession)).toBe(true);
    } finally {
      if (terminalId) tmuxKillSession(`termates-${terminalId}`);
      await stopServer(server);
    }
  }, 40000);

  it.skipIf(!tmuxAvailable)('tmux session survives server SIGTERM', async () => {
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

      // The tmux session should still be alive
      expect(tmuxSessionExists(`termates-${terminalId}`)).toBe(true);
    } finally {
      if (terminalId) tmuxKillSession(`termates-${terminalId}`);
      if (server) await stopServer(server);
    }
  }, 40000);

  it.skipIf(!tmuxAvailable)('server restores terminal on restart', async () => {
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

      // Verify the tmux session is still alive before we restart
      expect(tmuxSessionExists(`termates-${terminalId}`)).toBe(true);

      // ── Phase 2: restart the server ────────────────────────────────────────
      server2 = await startServer();

      // List terminals — the restored one should appear
      const list = await sendUnixCommand({ command: 'list' });
      expect(list.ok).toBe(true);
      const restored = list.terminals.find(t => t.id === terminalId);
      expect(restored).toBeDefined();
      expect(restored.name).toBe('RestoreTest');
    } finally {
      if (terminalId) tmuxKillSession(`termates-${terminalId}`);
      if (server1) await stopServer(server1);
      if (server2) await stopServer(server2);
    }
  }, 60000);

  it.skipIf(!tmuxAvailable)('can send a command to a restored terminal and receive output', async () => {
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
      if (terminalId) tmuxKillSession(`termates-${terminalId}`);
      if (server1) await stopServer(server1);
      if (server2) await stopServer(server2);
    }
  }, 60000);
});

describe('Session persistence (no tmux fallback)', () => {
  it.skipIf(tmuxAvailable)('creates a terminal without tmux (PTY-only mode)', async () => {
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
