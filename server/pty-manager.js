import pty from 'node-pty';
import os from 'os';
import path from 'path';
import { buildRemoteTmuxCommand } from './ssh-config.js';
import { detectBackend, TMUX_CONF_CONTENT as _TMUX_CONF_CONTENT } from './persistence-backend.js';

// Re-export for backwards-compat with tests that import it.
export const TMUX_CONF_CONTENT = _TMUX_CONF_CONTENT;

const TMUX_PREFIX = 'termates-';
const STATE_DIR = path.join(os.homedir(), '.termates');
const TERMATES_SOCKET = path.join(os.tmpdir(), 'termates.sock');
const STRIP_ENV_KEYS = new Set([
  'NO_COLOR',
  'TMUX',
  'TMUX_PANE',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERMINAL_EMULATOR',
  'WT_SESSION',
]);
const STRIP_ENV_PREFIXES = [
  'KITTY_',
  'VSCODE_',
  'WEZTERM_',
  'ZELLIJ_',
];

function buildTerminalPath(basePath = '') {
  const home = os.homedir();
  const candidates = [
    basePath,
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.superset', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/Applications/Codex.app/Contents/Resources',
  ];

  const seen = new Set();
  return candidates
    .flatMap((entry) => String(entry || '').split(':'))
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(':');
}

export function loginShellArgs(shellPath) {
  const shellName = path.basename(shellPath || '').toLowerCase();
  return new Set(['bash', 'zsh', 'fish', 'ksh', 'tcsh', 'csh']).has(shellName) ? ['-l'] : [];
}

export function buildTerminalEnv({ id, name, baseEnv = process.env }) {
  const env = { ...baseEnv };

  for (const key of Object.keys(env)) {
    if (STRIP_ENV_KEYS.has(key) || STRIP_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }

  env.TERMATES_TERMINAL_ID = id;
  env.TERMATES_TERMINAL_NAME = name || `Terminal ${id}`;
  env.TERMATES_SOCKET = TERMATES_SOCKET;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Termates';
  env.PATH = buildTerminalPath(env.PATH);

  return env;
}

export class PtyManager {
  constructor() {
    this.terminals = new Map();
    this.nextId = 1;
    this.backend = detectBackend();
    // tmuxAvailable is kept as a boolean for tests/legacy callers that only
    // ask "is persistence working?". It's true for any real backend, false for
    // the no-op NoBackend.
    this.tmuxAvailable = this.backend.name !== 'none';
    const label = this.backend.name;
    if (label === 'tmux') console.log('  [tmux] Persistent terminals enabled');
    else if (label === 'abduco') console.log('  [abduco] Persistent terminals enabled (legacy fallback)');
    else console.log('  [persistence] No tmux/abduco found — terminals will not survive restart');
  }

  get size() {
    return this.terminals.size;
  }

  setNextId(n) {
    this.nextId = n;
  }

  _sessionName(id) {
    return `${TMUX_PREFIX}${id}`;
  }

  // Back-compat alias — older callers use _tmuxName.
  _tmuxName(id) { return this._sessionName(id); }

  _tmuxSessionExists(sessionName) {
    return this.backend.sessionExists(sessionName);
  }

  // List all termates-* sessions alive in the active backend.
  listAliveTmuxSessions() {
    return this.backend.listSessions().filter((s) => s.startsWith(TMUX_PREFIX));
  }

  tmuxSessionToId(sessionName) {
    return sessionName.replace(TMUX_PREFIX, '');
  }

  // ---- Create a fresh terminal, persisted through the active backend ----
  create({ id, name, shell, cwd, cols, rows, sshTarget }) {
    const termId = id || `t${this.nextId++}`;
    const sessionName = this.tmuxAvailable ? this._sessionName(termId) : null;

    const termCols = cols || 80;
    const termRows = rows || 24;
    const workDir = cwd || process.env.HOME || process.cwd();

    const env = buildTerminalEnv({
      id: termId,
      name: name || `Terminal ${termId}`,
    });

    // Recreate from scratch — if a stale session with this id exists (e.g.
    // crashed earlier run), kill it first so we don't attach to junk.
    if (sessionName && this.backend.sessionExists(sessionName)) {
      this.backend.killSession(sessionName);
    }

    let spawnFile, spawnArgs, spawnEnv;
    if (sessionName) {
      const innerCmd = sshTarget ? 'ssh' : (shell || process.env.SHELL || '/bin/zsh');
      const innerArgs = sshTarget ? [sshTarget] : loginShellArgs(innerCmd);
      ({ spawnFile, spawnArgs, env: spawnEnv } = this.backend.buildSpawn({
        sessionName, innerCmd, innerArgs,
        baseEnv: env, cols: termCols, rows: termRows, cwd: workDir,
      }));
    } else {
      spawnFile = shell || process.env.SHELL || '/bin/zsh';
      spawnArgs = loginShellArgs(spawnFile);
      spawnEnv = env;
    }

    const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: termCols,
      rows: termRows,
      cwd: workDir,
      env: spawnEnv,
    });

    const terminal = this._makeTerminal(termId, name, ptyProcess, sessionName);
    if (sessionName) this.backend.setSessionTuiMode(sessionName, false);
    this.terminals.set(termId, terminal);
    return terminal;
  }

  // ---- Reattach to a pre-existing session left behind by a prior run ----
  reattach({ id, name, status, inTui, cols, rows }) {
    if (!this.tmuxAvailable) return null;
    const sessionName = this._sessionName(id);
    if (!this.backend.sessionExists(sessionName)) return null;

    const env = buildTerminalEnv({
      id,
      name: name || `Terminal ${id}`,
    });

    // Session is already known to exist (checked above), so buildSpawn skips
    // its create step and returns the attach command only — no new shell.
    const shell = process.env.SHELL || '/bin/zsh';
    const { spawnFile, spawnArgs, env: spawnEnv } = this.backend.buildSpawn({
      sessionName, innerCmd: shell, innerArgs: [],
      baseEnv: env, cols: cols || 80, rows: rows || 24, cwd: process.env.HOME,
    });

    const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: process.env.HOME,
      env: spawnEnv,
    });

    const terminal = this._makeTerminal(id, name, ptyProcess, sessionName);
    terminal.status = status || 'idle';
    const liveInTui = this.backend.querySessionTuiMode(sessionName);
    terminal.inTui = liveInTui === null ? !!inTui : liveInTui;
    this.backend.setSessionTuiMode(sessionName, terminal.inTui);
    this.terminals.set(id, terminal);
    return terminal;
  }

  // ---- Create SSH terminal (convenience wrapper) ----
  createSsh({ id, name, cols, rows, target }) {
    return this.create({
      id,
      name: name || `SSH: ${target}`,
      cols, rows,
      sshTarget: target,
    });
  }

  // ---- Create remote terminal (persisted locally via the active backend,
  //      then ssh into the remote host and run remote tmux there) ----
  createRemote({ id, name, cols, rows, sshTarget, remoteCwd, remoteSessionName }) {
    const termId = id || `t${this.nextId++}`;
    const sessionName = this.tmuxAvailable ? this._sessionName(termId) : null;
    const termCols = cols || 80;
    const termRows = rows || 24;

    const env = buildTerminalEnv({
      id: termId,
      name: name || `Remote: ${sshTarget}`,
    });

    const { sshArgs, remoteCmd } = buildRemoteTmuxCommand(sshTarget, remoteSessionName || `termates-${termId}`, remoteCwd);
    const sshFullArgs = [...sshArgs.slice(1), remoteCmd];

    if (sessionName && this.backend.sessionExists(sessionName)) {
      this.backend.killSession(sessionName);
    }

    let spawnFile, spawnArgs, spawnEnv;
    if (sessionName) {
      ({ spawnFile, spawnArgs, env: spawnEnv } = this.backend.buildSpawn({
        sessionName,
        innerCmd: sshArgs[0],
        innerArgs: sshFullArgs,
        baseEnv: env, cols: termCols, rows: termRows,
      }));
    } else {
      spawnFile = sshArgs[0];
      spawnArgs = sshFullArgs;
      spawnEnv = env;
    }

    const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: termCols,
      rows: termRows,
      cwd: process.env.HOME,
      env: spawnEnv,
    });

    const terminal = this._makeTerminal(termId, name || `Remote: ${sshTarget}`, ptyProcess, sessionName);
    terminal.remote = true;
    terminal.sshTarget = sshTarget;
    this.terminals.set(termId, terminal);
    return terminal;
  }

  // ---- Internal: build terminal object ----
  _makeTerminal(id, name, ptyProcess, tmuxSession) {
    const terminal = {
      id,
      name: name || `Terminal ${id}`,
      status: 'idle',
      inTui: false,
      tmuxSession: tmuxSession || null,
      pty: ptyProcess,
      buffer: [],
      maxBufferLines: 2000,
      listeners: new Set(),
      createdAt: Date.now(),

      exitCallbacks: new Set(),

      onData(callback) {
        terminal.listeners.add(callback);
        return () => terminal.listeners.delete(callback);
      },

      onExit(callback) {
        terminal.exitCallbacks.add(callback);
      },

      getBuffer(lines = 50) {
        const all = terminal.buffer.join('');
        const allLines = all.split('\n');
        return allLines.slice(-lines).join('\n');
      },
    };

    ptyProcess.onData((data) => {
      terminal.buffer.push(data);
      if (terminal.buffer.length > terminal.maxBufferLines) {
        terminal.buffer = terminal.buffer.slice(-Math.floor(terminal.maxBufferLines * 0.75));
      }
      // Track alt-screen state by observing the raw escape sequences. smcup
      // variants enter (true), rmcup variants exit (false). This replaces the
      // old tmux display-message query and works with any backend. We scan
      // last-match-wins so if a chunk contains enter-then-exit we end up in
      // the right state.
      let lastIdx = -1, lastOn = null;
      for (const m of data.matchAll(/\x1b\[\?(?:1049|1047|47)([hl])/g)) {
        if (m.index > lastIdx) { lastIdx = m.index; lastOn = m[1] === 'h'; }
      }
      if (lastOn !== null && terminal.inTui !== lastOn) {
        terminal.inTui = lastOn;
        this.backend.setSessionTuiMode(terminal.tmuxSession, lastOn);
      }
      for (const cb of terminal.listeners) {
        try { cb(data); } catch (e) { /* ignore */ }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      for (const cb of terminal.listeners) {
        try { cb(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`); } catch (e) {}
      }
      // Notify exit callbacks (server uses this for auto-cleanup)
      for (const cb of terminal.exitCallbacks) {
        try { cb(terminal.id, exitCode); } catch (e) {}
      }
    });

    return terminal;
  }

  // ---- Standard operations ----

  get(id) { return this.terminals.get(id) || null; }

  getByName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    for (const t of this.terminals.values()) {
      if (t.name.toLowerCase() === lower) return t;
    }
    for (const t of this.terminals.values()) {
      if (t.name.toLowerCase().includes(lower)) return t;
    }
    return null;
  }

  resolve(idOrName) {
    return this.get(idOrName) || this.getByName(idOrName);
  }

  write(id, data) {
    const t = this.terminals.get(id);
    if (t) { t.pty.write(data); return true; }
    return false;
  }

  resize(id, cols, rows) {
    const t = this.terminals.get(id);
    if (t) {
      try { t.pty.resize(Math.max(1, cols), Math.max(1, rows)); return true; }
      catch (e) { return false; }
    }
    return false;
  }

  // Force the inner program to redraw after a new WebSocket client attaches
  // to an existing session. Without this the pane sits blank (the attached
  // shell/TUI isn't emitting fresh bytes) until the user types something.
  //
  // We combine two signals because no single one covers all cases:
  //   1. SIGWINCH via a 1-row size nudge — TUIs (Claude Code, vim, less)
  //      handle it as "repaint at new size". We separate the two resizes
  //      with a small delay because the kernel can coalesce back-to-back
  //      TIOCSWINSZ calls into a single SIGWINCH, and if the final size
  //      matches what the process already knows, it sees no change and
  //      doesn't redraw.
  //   2. Ctrl+L (0x0c, form feed) — readline (bash/zsh) handles this as
  //      "redraw the current line" so an idle shell prompt re-emits. Most
  //      full-screen TUIs bind it to "clear + repaint".
  refresh(id) {
    const t = this.terminals.get(id);
    if (!t) return false;
    try {
      const c = Math.max(1, t.pty.cols || 80);
      const r = Math.max(1, t.pty.rows || 24);
      t.pty.resize(c, Math.max(1, r - 1));
      setTimeout(() => {
        try {
          t.pty.resize(c, r);
          t.pty.write('\x0c');
        } catch (e) {}
      }, 30);
      return true;
    } catch (e) { return false; }
  }

  setStatus(id, status) {
    const t = this.terminals.get(id);
    if (t) { t.status = status; return true; }
    return false;
  }

  rename(id, newName) {
    const t = this.terminals.get(id);
    if (t) { t.name = newName; return true; }
    return false;
  }

  setInTui(id, value) {
    const t = this.terminals.get(id);
    if (!t) return null;
    const prev = t.inTui;
    t.inTui = !!value;
    if (prev !== t.inTui) this.backend.setSessionTuiMode(t.tmuxSession, t.inTui);
    return { prev, current: t.inTui, changed: prev !== t.inTui };
  }

  // Returns true if the inner program is currently on the alt screen
  // (i.e. a full-screen TUI like claude/codex/vim is running), false otherwise.
  // Resolves to null if the terminal is gone.
  //
  // We track this in _makeTerminal by watching the PTY output for smcup/rmcup
  // sequences. That works with any backend (abduco, tmux, none) because it
  // doesn't depend on the multiplexer's own state tracking — we observe the
  // same escape sequences the multiplexer would.
  paneAlternateOn(id) {
    const t = this.terminals.get(id);
    if (!t) return Promise.resolve(null);
    const live = this.backend.querySessionTuiMode(t.tmuxSession);
    if (live !== null) return Promise.resolve(live);
    return Promise.resolve(!!t.inTui);
  }

  snapshot(id) {
    const t = this.terminals.get(id);
    if (!t?.tmuxSession) return null;
    return this.backend.captureSessionSnapshot(t.tmuxSession);
  }

  // Destroy terminal AND its persisted session (abduco/tmux).
  destroy(id) {
    const t = this.terminals.get(id);
    if (!t) return false;
    try { t.pty.kill(); } catch (e) { /* already dead */ }
    if (t.tmuxSession && this.tmuxAvailable) {
      this.backend.killSession(t.tmuxSession);
    }
    t.listeners.clear();
    this.terminals.delete(id);
    return true;
  }

  // Detach all PTY connections but KEEP tmux sessions alive (for clean shutdown)
  detachAll() {
    for (const t of this.terminals.values()) {
      try { t.pty.kill(); } catch (e) { /* ok */ }
      t.listeners.clear();
    }
    this.terminals.clear();
  }

  // Hard destroy everything including tmux sessions
  destroyAll() {
    for (const id of [...this.terminals.keys()]) {
      this.destroy(id);
    }
  }

  list() {
    return Array.from(this.terminals.values()).map(t => ({
      id: t.id,
      name: t.name,
      status: t.status,
      inTui: t.inTui,
      tmuxSession: t.tmuxSession,
      createdAt: t.createdAt,
    }));
  }
}
