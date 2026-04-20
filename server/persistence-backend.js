// ============================================
// Persistence backends for terminal sessions.
//
// Termates keeps PTYs alive across server restarts. We prefer tmux because it
// is actively maintained, already required for remote SSH persistence, and
// widely available on the platforms we support.
//
// Abduco remains as a legacy fallback for installs where tmux is unavailable.
// It is still a valid persist/attach backend, but no longer the default path.
//
// Order of preference: tmux > abduco > none.
// ============================================

import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const STATE_DIR = path.join(os.homedir(), '.termates');
const TMUX_CONF = path.join(STATE_DIR, 'tmux.conf');
const TMUX_SOCKET = path.join(STATE_DIR, 'tmux.sock');
const ABDUCO_DIR = path.join(STATE_DIR, 'abduco');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_CONTROL_CLIENT = path.join(__dirname, 'tmux-control-client.js');
const ABDUCO_DEBUG_MARKERS = [
  'client-send:',
  'client-recv:',
  'client-stdin:',
  'read_all(%d)',
  'write_all(%d)',
];

const TMUX_CONF_CONTENT = `
set -g status off
set -g mouse off
set -g focus-events on
set -g escape-time 0
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -g terminal-overrides "xterm-256color:Tc:smcup@:rmcup@"
set -g allow-passthrough on
`.trim();

export { TMUX_CONF_CONTENT };

// ---- Binary resolution ----
//
// Prefer a bundled binary over whatever's on $PATH when a backend ships with
// the app. At build time electron-builder copies `binaries/` into
// `process.resourcesPath`. During dev (no Electron), prefer an installed
// Termates.app resource copy when present, then fall back to the source-tree
// `binaries/` dir.
function bundledBinaryCandidates(name) {
  const arch = process.arch; // 'x64' | 'arm64'
  const platform = process.platform; // 'darwin' | 'linux'
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'binaries', `${name}-${platform}-${arch}`));
  }
  if (platform === 'darwin') {
    candidates.push(path.join('/Applications', 'Termates.app', 'Contents', 'Resources', 'binaries', `${name}-${platform}-${arch}`));
  }
  // Dev/source tree
  candidates.push(path.join(process.cwd(), 'binaries', `${name}-${platform}-${arch}`));
  return candidates.filter((candidate) => {
    try { return fs.existsSync(candidate) && (fs.statSync(candidate).mode & 0o111); }
    catch (e) { return false; }
  });
}

function binaryOnPath(name) {
  try {
    const resolved = execSync(`command -v ${name}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return resolved || null;
  } catch (e) { return null; }
}

function resolveBinary(name, validator = () => true) {
  const candidates = [...bundledBinaryCandidates(name)];
  const pathBinary = binaryOnPath(name);
  if (pathBinary && !candidates.includes(pathBinary)) candidates.push(pathBinary);

  for (const candidate of candidates) {
    if (validator(candidate)) return candidate;
  }
  return null;
}

// ---- Common helpers ----
function mkdirp(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildControlClientEnv(baseEnv) {
  if (!process.versions?.electron) return baseEnv;
  return { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' };
}

export function isNoisyAbducoBinary(binaryPath) {
  try {
    const buf = fs.readFileSync(binaryPath);
    return ABDUCO_DEBUG_MARKERS.every((marker) => buf.includes(Buffer.from(marker)));
  } catch (e) {
    return false;
  }
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

  setSessionTuiMode() {}
  querySessionTuiMode() { return null; }
  captureSessionSnapshot() { return null; }

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
      // Some bundled abduco builds emit protocol trace on stderr. Redirect only
      // stderr away from the PTY so stdout (the real terminal stream) still
      // reaches xterm while the debug noise is suppressed.
      spawnFile: '/bin/sh',
      spawnArgs: ['-lc', `exec ${shellEscape(this.binary)} -a -e '^@' ${shellEscape(sessionName)} 2>/dev/null`],
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
    this._syncConf();
  }

  _writeConf() {
    try {
      mkdirp(STATE_DIR);
      fs.writeFileSync(TMUX_CONF, TMUX_CONF_CONTENT);
    } catch (e) {}
  }

  _syncConf() {
    try {
      execFileSync(this.binary, ['-S', TMUX_SOCKET, 'start-server'], { stdio: 'pipe' });
    } catch (e) {}
    try {
      execFileSync(this.binary, ['-S', TMUX_SOCKET, 'source-file', TMUX_CONF], { stdio: 'pipe' });
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
      spawnFile: process.execPath,
      spawnArgs: [TMUX_CONTROL_CLIENT, this.binary, TMUX_SOCKET, TMUX_CONF, sessionName],
      env: buildControlClientEnv(baseEnv),
    };
  }

  killSession(sessionName) {
    try {
      execSync(`${this.binary} -S "${TMUX_SOCKET}" kill-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) {}
  }

  setSessionTuiMode(sessionName, inTui) {
    if (!sessionName) return;
    try {
      execFileSync(this.binary, [
        '-S', TMUX_SOCKET,
        'set-option', '-t', sessionName,
        'mouse', inTui ? 'on' : 'off',
      ], { stdio: 'pipe' });
    } catch (e) {}
  }

  querySessionTuiMode(sessionName) {
    if (!sessionName) return null;
    try {
      const out = execFileSync(this.binary, [
        '-S', TMUX_SOCKET,
        'list-panes', '-t', sessionName,
        '-F', '#{alternate_on}',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (!out) return null;
      const first = out.split('\n').find(Boolean);
      if (first === '1') return true;
      if (first === '0') return false;
    } catch (e) {}
    return null;
  }

  captureSessionSnapshot(sessionName) {
    if (!sessionName) return null;
    try {
      const paneInfo = execFileSync(this.binary, [
        '-S', TMUX_SOCKET,
        'list-panes', '-t', sessionName,
        '-F', '#{pane_id}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const [paneId, cursorXRaw, cursorYRaw, cursorFlagRaw] = paneInfo.split('\t');
      if (!paneId) return null;

      const captured = execFileSync(this.binary, [
        '-S', TMUX_SOCKET,
        'capture-pane', '-p', '-e', '-N',
        '-t', paneId,
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

      const cursorX = Number.parseInt(cursorXRaw, 10);
      const cursorY = Number.parseInt(cursorYRaw, 10);
      const cursorVisible = cursorFlagRaw !== '0';
      const normalized = captured.replace(/\n/g, '\r\n');
      const moveCursor = Number.isInteger(cursorX) && Number.isInteger(cursorY)
        ? `\x1b[${cursorY + 1};${cursorX + 1}H`
        : '';

      return `\x1b[?25l\x1b[H\x1b[2J${normalized}${moveCursor}${cursorVisible ? '\x1b[?25h' : ''}`;
    } catch (e) {}
    return null;
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
  setSessionTuiMode() {}
  querySessionTuiMode() { return null; }
  captureSessionSnapshot() { return null; }
}

// ============================================
// Factory
// ============================================
export function detectBackend() {
  const tmuxBin = resolveBinary('tmux');
  if (tmuxBin) return new TmuxBackend(tmuxBin);
  const abducoBin = resolveBinary('abduco');
  if (abducoBin) return new AbducoBackend(abducoBin);
  return new NoBackend();
}
