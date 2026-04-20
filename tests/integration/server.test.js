/**
 * Integration tests for the Termates server.
 *
 * Starts a real server process on port 17680 (separate from the default 7680)
 * and tests HTTP, WebSocket, and Unix socket behaviour.
 *
 * The server hardcodes its Unix socket path to os.tmpdir()/termates.sock.
 * These tests must not run concurrently with cli.test.js or session-restore.test.js
 * because all three share that same socket path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'server', 'index.js');
const SOCKET_PATH = path.join(os.tmpdir(), 'termates.sock');
const TEST_PORT = 17680;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wait until the HTTP server responds on the test port (or timeout).
 */
function waitForServer(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Server on port ${port} did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    }
    attempt();
  });
}

/**
 * Wait until the Unix socket file exists (or timeout).
 */
function waitForSocket(socketPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = net.createConnection(socketPath);
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Unix socket ${socketPath} not ready within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    }
    attempt();
  });
}

/**
 * Open a WebSocket to the test server and return an object with:
 *   send(type, payload)  – send a JSON message
 *   next(filterFn, timeoutMs) – wait for the next matching message
 *   close() – close the socket
 */
function openWs(url = WS_URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messageQueue = [];
    const waiters = [];

    ws.on('open', () => {
      resolve({
        send(type, payload = {}) {
          ws.send(JSON.stringify({ type, payload }));
        },
        next(filter = () => true, timeoutMs = 8000) {
          return new Promise((res, rej) => {
            // Check the existing queue first
            const idx = messageQueue.findIndex(filter);
            if (idx !== -1) {
              res(messageQueue.splice(idx, 1)[0]);
              return;
            }
            const timer = setTimeout(() => {
              const pos = waiters.findIndex(w => w.res === res);
              if (pos !== -1) waiters.splice(pos, 1);
              rej(new Error(`WebSocket: timed out waiting for matching message`));
            }, timeoutMs);
            waiters.push({ filter, res, rej, timer });
          });
        },
        close() { ws.close(); },
        raw: ws,
      });
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const waiterIdx = waiters.findIndex(w => w.filter(msg));
      if (waiterIdx !== -1) {
        const { res, timer } = waiters.splice(waiterIdx, 1)[0];
        clearTimeout(timer);
        res(msg);
      } else {
        messageQueue.push(msg);
      }
    });

    ws.on('error', reject);
  });
}

/**
 * Send a single command over the Unix socket and resolve with the parsed response.
 */
function sendUnixCommand(command, timeoutMs = 8000) {
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
        reject(new Error(`Invalid response: ${data}`));
      }
    });
    client.on('error', reject);
  });
}

async function waitForTerminalOutput(ws, id, matcher = () => true, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let combined = '';

  while (Date.now() < deadline) {
    const msg = await ws.next(
      m => m.type === 'terminal:output' && m.payload.id === id,
      Math.max(1, deadline - Date.now()),
    );
    combined += msg.payload.data;
    if (matcher(combined, msg.payload.data)) return { msg, combined };
  }

  throw new Error(`Timed out waiting for terminal output from ${id}`);
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess;

beforeAll(async () => {
  serverProcess = spawn('node', [SERVER_PATH], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.on('error', (err) => {
    throw new Error(`Failed to spawn server: ${err.message}`);
  });

  await waitForServer(TEST_PORT, 20000);
  await waitForSocket(SOCKET_PATH, 20000);
}, 25000);

afterAll(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise(resolve => serverProcess.on('close', resolve));
  }
});

// ─── HTTP tests ───────────────────────────────────────────────────────────────

describe('HTTP', () => {
  it('GET / returns HTML with status 200', async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct).toMatch(/text\/html/);
  });

  it('GET /api/terminals returns JSON with terminals array', async () => {
    const res = await fetch(`${BASE_URL}/api/terminals`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('terminals');
    expect(Array.isArray(body.terminals)).toBe(true);
  });
});

// ─── WebSocket tests ──────────────────────────────────────────────────────────

describe('WebSocket', () => {
  it('terminal:list returns workspaces array', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:list');
      const msg = await ws.next(m => m.type === 'terminal:list');
      expect(msg.payload).toHaveProperty('workspaces');
      expect(Array.isArray(msg.payload.workspaces)).toBe(true);
      expect(msg.payload.agentPresets).toEqual(expect.objectContaining({
        claude: expect.objectContaining({ command: expect.any(String) }),
        codex: expect.objectContaining({ command: expect.any(String) }),
      }));
    } finally {
      ws.close();
    }
  });

  it('settings:update persists presets and broadcasts settings:updated', async () => {
    const ws = await openWs();
    let originalAgentPresets;
    try {
      ws.send('terminal:list');
      const initial = await ws.next(m => m.type === 'terminal:list');
      originalAgentPresets = initial.payload.agentPresets;

      const nextAgentPresets = {
        claude: { command: 'claude --print {{workspace_name}}' },
        codex: { command: 'codex --model gpt-5-codex' },
      };

      ws.send('settings:update', {
        agentPresets: nextAgentPresets,
      });
      const updated = await ws.next(m => m.type === 'settings:updated');
      expect(updated.payload.agentPresets).toEqual(nextAgentPresets);

      ws.send('terminal:list');
      const listed = await ws.next(m => m.type === 'terminal:list');
      expect(listed.payload.agentPresets).toEqual(nextAgentPresets);
    } finally {
      if (originalAgentPresets) {
        ws.send('settings:update', {
          agentPresets: originalAgentPresets,
        });
        await ws.next(m => m.type === 'settings:updated').catch(() => {});
      }
      ws.close();
    }
  });

  it('terminal:create returns terminal:created with valid id', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'WS Test Terminal' });
      const msg = await ws.next(m => m.type === 'terminal:created');
      expect(msg.payload).toHaveProperty('id');
      expect(typeof msg.payload.id).toBe('string');
      expect(msg.payload.id.length).toBeGreaterThan(0);

      // Cleanup
      ws.send('terminal:destroy', { id: msg.payload.id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === msg.payload.id);
    } finally {
      ws.close();
    }
  });

  it('terminal:input sends without error', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Input Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      // Sending input should not cause an error message back
      ws.send('terminal:input', { id, data: 'echo hello\n' });

      // Small wait – if an error were produced it would arrive quickly
      await new Promise(r => setTimeout(r, 300));

      // Cleanup
      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

  it('terminal:resize sends without error', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Resize Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      ws.send('terminal:resize', { id, cols: 120, rows: 40 });
      await new Promise(r => setTimeout(r, 300));

      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

  it('terminal:destroy returns terminal:destroyed', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Destroy Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      ws.send('terminal:destroy', { id });
      const msg = await ws.next(m => m.type === 'terminal:destroyed');
      expect(msg.payload.id).toBe(id);
    } finally {
      ws.close();
    }
  });

  it('terminal:configure returns terminal:configured', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Configure Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      ws.send('terminal:configure', { id, name: 'Configured Name' });
      const msg = await ws.next(m => m.type === 'terminal:configured' && m.payload.id === id);
      expect(msg.payload.name).toBe('Configured Name');

      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

  it('terminal:link returns terminal:linked', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Link A' });
      const a = await ws.next(m => m.type === 'terminal:created');
      ws.send('terminal:create', { name: 'Link B' });
      const b = await ws.next(m => m.type === 'terminal:created');

      const idA = a.payload.id;
      const idB = b.payload.id;

      ws.send('terminal:link', { from: idA, to: idB });
      const linked = await ws.next(m => m.type === 'terminal:linked');
      expect(linked.payload).toMatchObject({ from: idA, to: idB });

      ws.send('terminal:list');
      const listed = await ws.next(m => m.type === 'terminal:list');
      const activeWorkspace = listed.payload.workspaces.find(
        (workspace) => workspace.id === listed.payload.activeWorkspaceId,
      ) || listed.payload.workspaces[0];
      expect(activeWorkspace.links).toEqual(
        expect.arrayContaining([{ from: idA, to: idB }]),
      );

      // Cleanup
      ws.send('terminal:destroy', { id: idA });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idA);
      ws.send('terminal:destroy', { id: idB });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idB);
    } finally {
      ws.close();
    }
  });

  it('terminal:unlink returns terminal:unlinked', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Unlink A' });
      const a = await ws.next(m => m.type === 'terminal:created');
      ws.send('terminal:create', { name: 'Unlink B' });
      const b = await ws.next(m => m.type === 'terminal:created');

      const idA = a.payload.id;
      const idB = b.payload.id;

      ws.send('terminal:link', { from: idA, to: idB });
      await ws.next(m => m.type === 'terminal:linked');

      ws.send('terminal:unlink', { from: idA, to: idB });
      const unlinked = await ws.next(m => m.type === 'terminal:unlinked');
      expect(unlinked.payload).toMatchObject({ from: idA, to: idB });

      ws.send('terminal:list');
      const listed = await ws.next(m => m.type === 'terminal:list');
      expect(listed.payload.workspaces[0].links.some(link =>
        (link.from === idA && link.to === idB) || (link.from === idB && link.to === idA),
      )).toBe(false);

      ws.send('terminal:destroy', { id: idA });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idA);
      ws.send('terminal:destroy', { id: idB });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idB);
    } finally {
      ws.close();
    }
  });
});

// ─── Extended WebSocket tests ────────────────────────────────────────────────

describe('WebSocket (state verification)', () => {
  it('terminal:status changes status and broadcasts terminal:status-changed', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Status Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      ws.send('terminal:status', { id, status: 'success' });
      const msg = await ws.next(m => m.type === 'terminal:status-changed' && m.payload.id === id);
      expect(msg.payload.status).toBe('success');

      // Verify state persisted: list should show updated status
      ws.send('terminal:list');
      const list = await ws.next(m => m.type === 'terminal:list');
      const term = list.payload.terminals.find(t => t.id === id);
      expect(term.status).toBe('success');

      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

  it('terminal:rename changes name and broadcasts terminal:renamed', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Before Rename' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      ws.send('terminal:rename', { id, name: 'After Rename' });
      const msg = await ws.next(m => m.type === 'terminal:renamed' && m.payload.id === id);
      expect(msg.payload.name).toBe('After Rename');

      // Verify via list
      ws.send('terminal:list');
      const list = await ws.next(m => m.type === 'terminal:list');
      const term = list.payload.terminals.find(t => t.id === id);
      expect(term.name).toBe('After Rename');

      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

  it('terminal:configure updates the name in memory and in the broadcast', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Config Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      ws.send('terminal:configure', { id, name: 'New Name' });
      const msg = await ws.next(m => m.type === 'terminal:configured' && m.payload.id === id);
      expect(msg.payload.name).toBe('New Name');

      // Verify via list
      ws.send('terminal:list');
      const list = await ws.next(m => m.type === 'terminal:list');
      const term = list.payload.terminals.find(t => t.id === id);
      expect(term.name).toBe('New Name');

      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

  it('destroying a linked terminal broadcasts terminal:unlinked events', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Linked A' });
      const a = await ws.next(m => m.type === 'terminal:created');
      ws.send('terminal:create', { name: 'Linked B' });
      const b = await ws.next(m => m.type === 'terminal:created');
      ws.send('terminal:create', { name: 'Linked C' });
      const c = await ws.next(m => m.type === 'terminal:created');

      const idA = a.payload.id;
      const idB = b.payload.id;
      const idC = c.payload.id;

      // Link A-B and A-C
      ws.send('terminal:link', { from: idA, to: idB });
      await ws.next(m => m.type === 'terminal:linked');
      ws.send('terminal:link', { from: idA, to: idC });
      await ws.next(m => m.type === 'terminal:linked');

      // Destroy A — should broadcast unlinked events for both links
      ws.send('terminal:destroy', { id: idA });
      const destroyed = await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idA);
      expect(destroyed.payload.id).toBe(idA);

      // Should get two unlinked events
      const unlinked1 = await ws.next(m => m.type === 'terminal:unlinked');
      const unlinked2 = await ws.next(m => m.type === 'terminal:unlinked');

      // Both should mention idA
      const allPayloads = [unlinked1.payload, unlinked2.payload];
      expect(allPayloads.some(p => p.from === idA || p.to === idA)).toBe(true);

      // Cleanup
      ws.send('terminal:destroy', { id: idB });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idB);
      ws.send('terminal:destroy', { id: idC });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === idC);
    } finally {
      ws.close();
    }
  });

  it('unknown WebSocket message type returns error', async () => {
    const ws = await openWs();
    try {
      ws.send('totally:bogus', {});
      const msg = await ws.next(m => m.type === 'error');
      expect(msg.payload.message).toContain('Unknown type');
    } finally {
      ws.close();
    }
  });

  it('workspace:update persists workspace changes', async () => {
    const ws = await openWs();
    try {
      // First get current state
      ws.send('terminal:list');
      const list1 = await ws.next(m => m.type === 'terminal:list');
      const origWorkspaces = list1.payload.workspaces;

      // Update workspace name
      const updated = origWorkspaces.map(w => ({
        ...w,
        name: w.id === origWorkspaces[0].id ? 'Updated Name' : w.name,
      }));
      ws.send('workspace:update', { workspaces: updated });

      // Small wait for persistence
      await new Promise(r => setTimeout(r, 500));

      // Verify it persisted
      ws.send('terminal:list');
      const list2 = await ws.next(m => m.type === 'terminal:list');
      const ws0 = list2.payload.workspaces.find(w => w.id === origWorkspaces[0].id);
      expect(ws0.name).toBe('Updated Name');

      // Restore original name
      ws.send('workspace:update', { workspaces: origWorkspaces });
    } finally {
      ws.close();
    }
  });

  it('terminal:list does not auto-replay buffered output', async () => {
    const ws = await openWs();
    try {
      ws.send('terminal:create', { name: 'Buffer Test' });
      const created = await ws.next(m => m.type === 'terminal:created');
      const id = created.payload.id;

      // Wait for the initial shell prompt so the command below is typed into a
      // live shell rather than racing the terminal bootstrap.
      await waitForTerminalOutput(ws, id, (combined) => combined.length > 0, 5000);

      // Seed the server-side terminal buffer with output that happened before
      // the second client connects. That exact marker must not be replayed by
      // terminal:list, even though live redraw/prompt output may still arrive.
      const marker = `__buffer_test_${Date.now().toString(36)}__`;
      ws.send('terminal:input', { id, data: `printf '${marker}\\n'\r` });
      await waitForTerminalOutput(ws, id, (combined) => combined.includes(marker), 5000);
      await new Promise(r => setTimeout(r, 300));

      // A fresh connection gets the list but must NOT receive a historical
      // byte dump — the client relies on tmux's attach redraw at the correct
      // pane size to restore the visible screen.
      const ws2 = await openWs();
      try {
        ws2.send('terminal:list');
        await ws2.next(m => m.type === 'terminal:list');

        let replayedMarker = false;
        try {
          await waitForTerminalOutput(ws2, id, (combined) => combined.includes(marker), 500);
          replayedMarker = true;
        } catch (e) { /* expected: timeout */ }
        expect(replayedMarker).toBe(false);
      } finally {
        ws2.close();
      }

      ws.send('terminal:destroy', { id });
      await ws.next(m => m.type === 'terminal:destroyed' && m.payload.id === id);
    } finally {
      ws.close();
    }
  });

});

// ─── HTTP extended tests ─────────────────────────────────────────────────────

describe('HTTP (extended)', () => {
  it('GET /api/terminals returns links array', async () => {
    const res = await fetch(`${BASE_URL}/api/terminals`);
    const body = await res.json();
    expect(body).toHaveProperty('links');
    expect(Array.isArray(body.links)).toBe(true);
  });

  it('GET /api/ssh/hosts returns hosts array', async () => {
    const res = await fetch(`${BASE_URL}/api/ssh/hosts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('hosts');
    expect(Array.isArray(body.hosts)).toBe(true);
  });

  it('GET /api/browse with empty path returns dirs array', async () => {
    const res = await fetch(`${BASE_URL}/api/browse?path=`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('dirs');
    expect(Array.isArray(body.dirs)).toBe(true);
  });

  it('GET /api/browse with ~ expands to home directory', async () => {
    const res = await fetch(`${BASE_URL}/api/browse?path=~`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('current');
    // Should not contain literal ~
    expect(body.current).not.toContain('~');
  });

  it('GET /proxy without url param returns 400', async () => {
    const res = await fetch(`${BASE_URL}/proxy`);
    expect(res.status).toBe(400);
  });

  it('GET /api/browser/snapshot without url param returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/browser/snapshot`);
    expect(res.status).toBe(400);
  });

  it('POST /api/browse-dialog returns JSON response', async () => {
    const res = await fetch(`${BASE_URL}/api/browse-dialog`, { method: 'POST' });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain('Electron desktop app');
    expect(body).toHaveProperty('path');
  });

  it('GET /api/update/status returns status object', async () => {
    const res = await fetch(`${BASE_URL}/api/update/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('currentVersion');
  });
});

// ─── Unix socket tests ────────────────────────────────────────────────────────

describe('Unix socket', () => {
  it('ping returns ok:true with version', async () => {
    const res = await sendUnixCommand({ command: 'ping' });
    expect(res.ok).toBe(true);
    expect(res).toHaveProperty('version');
    expect(typeof res.version).toBe('string');
  });

  it('create returns ok:true with id', async () => {
    const res = await sendUnixCommand({ command: 'create', name: 'Socket Test' });
    expect(res.ok).toBe(true);
    expect(res).toHaveProperty('id');
    expect(typeof res.id).toBe('string');

    // Cleanup
    await sendUnixCommand({ command: 'destroy', target: res.id });
  });

  it('list returns terminals array', async () => {
    const res = await sendUnixCommand({ command: 'list' });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.terminals)).toBe(true);
  });

  it('destroy returns ok:true', async () => {
    const created = await sendUnixCommand({ command: 'create', name: 'Destroy Socket Test' });
    expect(created.ok).toBe(true);

    const destroyed = await sendUnixCommand({ command: 'destroy', target: created.id });
    expect(destroyed.ok).toBe(true);

    // Confirm it is no longer in the list
    const list = await sendUnixCommand({ command: 'list' });
    const found = list.terminals.find(t => t.id === created.id);
    expect(found).toBeUndefined();
  });
});
