// ============================================
// Persistence backends for terminal sessions.
//
// Termates keeps PTYs alive across server restarts. We used to use tmux for
// this, but tmux's single-process event loop coalesces redraws under heavy
// parallel output (multiple agents streaming at once), which shows up as the
// "dots", partial renders, and scroll glitches. Tmux is also a full terminal
// multiplexer — we don't use any of that; we only need persist/attach.
//
// Abduco does exactly the persist/attach half and nothing else: no screen
// state tracking, no redraw coalescing, no multiplexing. Bytes pass straight
// through from the inner process to the attached PTY. Each session is its own
// process — no shared event loop to contend on.
//
// Order of preference: abduco > tmux > none.
// ============================================

import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync, execFileSync } from 'child_process';

const STATE_DIR = path.join(os.homedir(), '.termates');
const TMUX_CONF = path.join(STATE_DIR, 'tmux.conf');
const TMUX_SOCKET = path.join(STATE_DIR, 'tmux.sock');
const ABDUCO_DIR = path.join(STATE_DIR, 'abduco');

// See pty-manager.js for the rationale on smcup@/rmcup@.
const TMUX_CONF_CONTENT = `
set -g status off
set -g mouse off
set -g escape-time 0
set -g history-limit 50000
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc:smcup@:rmcup@"
set -g allow-passthrough on
`.trim();

export { TMUX_CONF_CONTENT };

// ---- Binary resolution ----
//
// Prefer a binary bundled with the Electron app over whatever's on $PATH, so
// the app "just works" without requiring the user to `brew install abduco`.
// At build time electron-builder copies `binaries/` into `process.resourcesPath`.
// During dev (no Electron), the source-tree `binaries/` dir is checked.
function bundledBinary(name) {
  const arch = process.arch; // 'x64' | 'arm64'
  const platform = process.platform; // 'darwin' | 'linux'
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'binaries', `${name}-${platform}-${arch}`));
  }
  // Dev/source tree
  candidates.push(path.join(process.cwd(), 'binaries', `${name}-${platform}-${arch}`));
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).mode & 0o111) return p; } catch (e) {}
  }
  return null;
}

function onPath(name) {
  try { execSync(`command -v ${name}`, { stdio: 'pipe' }); return name; }
  catch (e) { return null; }
}

function resolveBinary(name) {
  return bundledBinary(name) || onPath(name);
}

// ---- Common helpers ----
function mkdirp(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

// ============================================
// Abduco backend
// ============================================
class AbducoBackend {
  constructor(binary) {
    this.name = 'abduco';
    this.binary = binary;
    mkdirp(ABDUCO_DIR);
  }

  // Env that makes abduco use our session directory instead of ~/.abduco.
  // Abduco still nests further under <binary-basename>/<user>/ inside this
  // directory, which is why we locate sockets recursively below.
  _env(base) {
    return { ...base, ABDUCO_SOCKET_DIR: ABDUCO_DIR };
  }

  // Locate the Unix-domain socket abduco created for `sessionName`. Returns
  // null if not found. Abduco's on-disk layout is:
  //   $ABDUCO_SOCKET_DIR/<binary-basename>/<user>/<session>@<hostname>
  // so a plain existsSync on ABDUCO_DIR/sessionName misses it. We walk the
  // tree and match either the bare name or `<name>@...` suffix form.
  _findSocket(sessionName, dir = ABDUCO_DIR) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return null; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name === sessionName || e.name.startsWith(`${sessionName}@`)) return full;
      if (e.isDirectory()) {
        const nested = this._findSocket(sessionName, full);
        if (nested) return nested;
      }
    }
    return null;
  }

  _listSockets(dir = ABDUCO_DIR, acc = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return acc; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this._listSockets(full, acc);
      else acc.push(e.name.replace(/@[^@]+$/, ''));
    }
    return acc;
  }

  sessionExists(sessionName) {
    // Fast-path the canonical socket location (and preserve the contract
    // that callers mocking existsSync can rely on). Fall back to the
    // recursive walk for abduco's default nested layout.
    if (fs.existsSync(path.join(ABDUCO_DIR, sessionName))) return true;
    return this._findSocket(sessionName) !== null;
  }

  listSessions() {
    return this._listSockets();
  }

  // Return [spawnFile, spawnArgs, env] that node-pty should use to start a
  // PTY attached to this session.
  //
  // Two-step create pattern (mirrors the tmux backend): we create the
  // session detached (`-n`) with a synchronous execFileSync, so the abduco
  // master daemonizes into its own process group *before* node-pty spawns
  // the attaching client. If the client is later killed (server shutdown,
  // reload), only the attacher dies — the master keeps the session alive
  // for a future attach.
  //
  // The old `-A` (attach-or-create) flow created master and client in the
  // same pty fork tree; on macOS the master died alongside the client when
  // node-pty sent SIGHUP, which defeated the whole point of the backend.
  //
  // `-e ^@` sets the detach escape to NUL (un-typeable), so users can't
  // accidentally disconnect from the session.
  buildSpawn({ sessionName, innerCmd, innerArgs = [], baseEnv, cwd }) {
    const env = this._env(baseEnv);
    if (!this.sessionExists(sessionName)) {
      try {
        // stdio MUST be 'ignore' — the abduco master daemon inherits
        // stdio fds from its parent, so with a pipe execFileSync hangs
        // until the daemon exits (never). 'ignore' closes fds in the
        // child so the sync call returns as soon as the outer fork
        // completes, which is all we need.
        execFileSync(this.binary, ['-n', sessionName, innerCmd, ...innerArgs], {
          env,
          cwd: cwd || undefined,
          stdio: 'ignore',
        });
      } catch (e) { /* fall through — -a will error loudly if truly broken */ }
    }
    return {
      spawnFile: this.binary,
      spawnArgs: ['-a', '-e', '^@', sessionName],
      env,
    };
  }

  // Kill an existing session by taking down the abduco master process. We
  // identify it by opening the socket with lsof — abduco's master holds the
  // socket open. On macOS + Linux, `lsof -t` returns PIDs, one per line.
  killSession(sessionName) {
    const sockPath = this._findSocket(sessionName);
    if (!sockPath) return;
    try {
      const pids = execSync(`lsof -t -- "${sockPath}" 2>/dev/null`, { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch (e) {}
      }
    } catch (e) { /* best-effort */ }
    try { fs.unlinkSync(sockPath); } catch (e) {}
  }
}

// ============================================
// Tmux backend (fallback)
// ============================================
class TmuxBackend {
  constructor(binary) {
    this.name = 'tmux';
    this.binary = binary;
    this._writeConf();
  }

  _writeConf() {
    try {
      mkdirp(STATE_DIR);
      fs.writeFileSync(TMUX_CONF, TMUX_CONF_CONTENT);
    } catch (e) {}
  }

  sessionExists(sessionName) {
    try {
      execSync(`${this.binary} -S "${TMUX_SOCKET}" has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
      return true;
    } catch (e) { return false; }
  }

  listSessions() {
    try {
      const out = execSync(
        `${this.binary} -S "${TMUX_SOCKET}" list-sessions -F "#{session_name}" 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (!out) return [];
      return out.split('\n');
    } catch (e) { return []; }
  }

  buildSpawn({ sessionName, innerCmd, innerArgs = [], baseEnv, cols = 80, rows = 24 }) {
    // Create detached session (synchronously), then attach via PTY. If the
    // session already exists we skip create — that's the reattach path.
    if (!this.sessionExists(sessionName)) {
      try {
        execFileSync(this.binary, [
          '-S', TMUX_SOCKET, '-f', TMUX_CONF,
          'new-session', '-d', '-s', sessionName,
          '-x', String(cols), '-y', String(rows),
          innerCmd, ...innerArgs,
        ], { env: baseEnv, stdio: 'pipe' });
      } catch (e) {
        // Fall back to creating without our config, in case it's bad.
        try {
          execFileSync(this.binary, [
            '-S', TMUX_SOCKET,
            'new-session', '-d', '-s', sessionName,
            innerCmd, ...innerArgs,
          ], { env: baseEnv, stdio: 'pipe' });
        } catch (e2) {}
      }
    }
    return {
      spawnFile: this.binary,
      spawnArgs: ['-S', TMUX_SOCKET, '-f', TMUX_CONF, 'attach-session', '-t', sessionName],
      env: baseEnv,
    };
  }

  killSession(sessionName) {
    try {
      execSync(`${this.binary} -S "${TMUX_SOCKET}" kill-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) {}
  }
}

// ============================================
// None backend — PTY lives only while termates is running.
// ============================================
class NoBackend {
  constructor() { this.name = 'none'; }
  sessionExists() { return false; }
  listSessions() { return []; }
  buildSpawn({ innerCmd, innerArgs = [], baseEnv }) {
    return { spawnFile: innerCmd, spawnArgs: innerArgs, env: baseEnv };
  }
  killSession() {}
}

// ============================================
// Factory
// ============================================
export function detectBackend() {
  const abducoBin = resolveBinary('abduco');
  if (abducoBin) return new AbducoBackend(abducoBin);
  const tmuxBin = resolveBinary('tmux');
  if (tmuxBin) return new TmuxBackend(tmuxBin);
  return new NoBackend();
}
