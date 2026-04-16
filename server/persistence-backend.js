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
  _env(base) {
    return { ...base, ABDUCO_SOCKET_DIR: ABDUCO_DIR };
  }

  sessionExists(sessionName) {
    try { return fs.existsSync(path.join(ABDUCO_DIR, sessionName)); }
    catch (e) { return false; }
  }

  listSessions() {
    try {
      return fs.readdirSync(ABDUCO_DIR).filter((n) => !n.startsWith('.'));
    } catch (e) { return []; }
  }

  // Return [spawnFile, spawnArgs, env] that node-pty should use to start a
  // PTY for this session. Uses -A so the command creates the session on
  // first call and just attaches thereafter. -e sets the detach escape to
  // NUL (^@) which cannot be typed, so users can't accidentally detach.
  buildSpawn({ sessionName, innerCmd, innerArgs = [], baseEnv }) {
    const args = ['-A', '-e', '^@', sessionName, innerCmd, ...innerArgs];
    return {
      spawnFile: this.binary,
      spawnArgs: args,
      env: this._env(baseEnv),
    };
  }

  // Kill an existing session by taking down the abduco master process. We
  // identify it by opening the socket with lsof — abduco's master holds the
  // socket open. On macOS + Linux, `lsof -t` returns PIDs, one per line.
  killSession(sessionName) {
    const sockPath = path.join(ABDUCO_DIR, sessionName);
    if (!fs.existsSync(sockPath)) return;
    try {
      const pids = execSync(`lsof -t -- ${sockPath} 2>/dev/null`, { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch (e) {}
      }
    } catch (e) { /* best-effort */ }
    // Socket file may linger; remove it so listSessions stays accurate.
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
