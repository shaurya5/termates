/**
 * Integration tests for the Termates CLI (bin/termates.js).
 *
 * Starts a real server on port 17680 and exercises all CLI sub-commands by
 * spawning `node bin/termates.js <cmd>` as child processes.
 *
 * The CLI connects to the server via the hardcoded Unix socket path
 * (os.tmpdir()/termates.sock), so only one server may own that socket while
 * these tests run.  Do not run server.test.js in parallel with this file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFile } from 'child_process';
import net from 'net';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'server', 'index.js');
const CLI_PATH = path.join(ROOT, 'bin', 'termates.js');
const SOCKET_PATH = path.join(os.tmpdir(), 'termates.sock');
const TEST_PORT = 17680;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitForSocket(socketPath, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const s = net.createConnection(socketPath);
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Unix socket not ready after ${timeoutMs}ms`));
        else setTimeout(attempt, 150);
      });
    }
    attempt();
  });
}

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

/**
 * Run a CLI command and return { code, stdout, stderr }.
 * Timeout defaults to 12 s (the CLI itself has a 10 s socket timeout).
 */
function runCli(args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('node', [CLI_PATH, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout) child.stdout.on('data', d => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess;

beforeAll(async () => {
  serverProcess = spawn('node', [SERVER_PATH], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.on('error', err => { throw new Error(`Server spawn failed: ${err.message}`); });

  await waitForPort(TEST_PORT, 25000);
  await waitForSocket(SOCKET_PATH, 25000);
}, 30000);

afterAll(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise(r => serverProcess.on('close', r));
  }
});

// ─── CLI tests ────────────────────────────────────────────────────────────────

describe('CLI commands', () => {
  it('termates ping exits 0 and stdout contains "running"', async () => {
    const { code, stdout } = await runCli(['ping']);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain('running');
  });

  it('termates new -n "CLI Test" exits 0 and stdout contains "Created"', async () => {
    const { code, stdout } = await runCli(['new', '-n', 'CLI Test']);
    expect(code).toBe(0);
    expect(stdout).toContain('Created');
  });

  it('termates ls exits 0 and stdout contains "CLI Test"', async () => {
    const { code, stdout } = await runCli(['ls']);
    expect(code).toBe(0);
    expect(stdout).toContain('CLI Test');
  });

  it('termates send "CLI Test" "echo test_output" exits 0', async () => {
    const { code } = await runCli(['send', 'CLI Test', 'echo test_output']);
    expect(code).toBe(0);
  });

  it('termates read "CLI Test" exits 0', async () => {
    // Give the shell a moment to process the echoed command
    await new Promise(r => setTimeout(r, 500));
    const { code } = await runCli(['read', 'CLI Test']);
    expect(code).toBe(0);
  });

  it('termates rename "CLI Test" "Renamed" exits 0', async () => {
    const { code, stdout } = await runCli(['rename', 'CLI Test', 'Renamed']);
    expect(code).toBe(0);
    // The CLI prints "Renamed to: Renamed"
    expect(stdout.toLowerCase()).toContain('renamed');
  });

  it('termates ls shows "Renamed" after rename', async () => {
    const { code, stdout } = await runCli(['ls']);
    expect(code).toBe(0);
    expect(stdout).toContain('Renamed');
  });

  it('termates destroy "Renamed" exits 0', async () => {
    const { code, stdout } = await runCli(['destroy', 'Renamed']);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain('destroyed');
  });

  it('termates ls no longer shows "Renamed" or "CLI Test" after destroy', async () => {
    const { code, stdout } = await runCli(['ls']);
    expect(code).toBe(0);
    // The terminal we created and renamed must be gone.
    // Other pre-existing terminals (from parallel test suites) may be present,
    // so we check for absence of our specific names rather than an empty list.
    expect(stdout).not.toContain('CLI Test');
    expect(stdout).not.toContain('Renamed');
  });
});
