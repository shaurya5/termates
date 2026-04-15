import pty from 'node-pty';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { buildRemoteTmuxCommand } from './ssh-config.js';

const TMUX_PREFIX = 'termates-';
const STATE_DIR = path.join(os.homedir(), '.termates');
const TMUX_CONF = path.join(STATE_DIR, 'tmux.conf');

// Transparent tmux config: no status bar, no mouse capture, no escape delay
// Mouse is OFF so xterm.js handles selection and scroll natively.
export const TMUX_CONF_CONTENT = `
set -g status off
set -g mouse off
set -g escape-time 0
set -g history-limit 50000
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g allow-passthrough on
`.trim();

export class PtyManager {
  constructor() {
    this.terminals = new Map();
    this.nextId = 1;
    this.tmuxAvailable = this._checkTmux();
    if (this.tmuxAvailable) {
      this._writeTmuxConf();
      console.log('  [tmux] Persistent terminals enabled');
    } else {
      console.log('  [tmux] Not found - terminals will not persist across restarts');
    }
  }

  _checkTmux() {
    try {
      execSync('tmux -V', { stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  }

  _writeTmuxConf() {
    try {
      if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(TMUX_CONF, TMUX_CONF_CONTENT);
    } catch (e) { /* ignore */ }
  }

  get size() {
    return this.terminals.size;
  }

  setNextId(n) {
    this.nextId = n;
  }

  _tmuxName(id) {
    return `${TMUX_PREFIX}${id}`;
  }

  _tmuxSessionExists(sessionName) {
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  }

  // List all termates-* tmux sessions that are still alive
  listAliveTmuxSessions() {
    if (!this.tmuxAvailable) return [];
    try {
      const out = execSync(
        'tmux list-sessions -F "#{session_name}" 2>/dev/null',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (!out) return [];
      return out.split('\n').filter(s => s.startsWith(TMUX_PREFIX));
    } catch (e) {
      return [];
    }
  }

  // Extract the terminal id from a tmux session name
  tmuxSessionToId(sessionName) {
    return sessionName.replace(TMUX_PREFIX, '');
  }

  // ---- Create new terminal (tmux-backed if available) ----
  create({ id, name, shell, cwd, role, cols, rows, sshTarget }) {
    const termId = id || `t${this.nextId++}`;
    const tmuxSession = this.tmuxAvailable ? this._tmuxName(termId) : null;

    const termCols = cols || 80;
    const termRows = rows || 24;
    const workDir = cwd || process.env.HOME || process.cwd();

    const env = { ...process.env };
    env.TERMATES_TERMINAL_ID = termId;
    env.TERMATES_TERMINAL_NAME = name || `Terminal ${termId}`;
    env.TERMATES_SOCKET = path.join(os.tmpdir(), 'termates.sock');
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    if (role) env.TERMATES_ROLE = role;

    let spawnFile, spawnArgs;

    if (this.tmuxAvailable) {
      if (this._tmuxSessionExists(tmuxSession)) {
        try { execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { stdio: 'pipe' }); } catch (e) {}
      }

      // Create detached session (synchronous — session exists immediately after)
      // then attach via PTY. Pass env with TERM so colors work inside tmux.
      const createCmd = ['tmux', '-f', TMUX_CONF, 'new-session', '-d', '-s', tmuxSession,
        '-x', String(termCols), '-y', String(termRows)];
      if (sshTarget) createCmd.push('ssh', sshTarget);
      try {
        execSync(createCmd.join(' '), { cwd: workDir, env, stdio: 'pipe' });
      } catch (e) {
        execSync(`tmux new-session -d -s "${tmuxSession}"`, { cwd: workDir, env, stdio: 'pipe' });
      }

      spawnFile = 'tmux';
      spawnArgs = ['-f', TMUX_CONF, 'attach-session', '-t', tmuxSession];
    } else {
      const defaultShell = shell || process.env.SHELL || '/bin/zsh';
      spawnFile = defaultShell;
      spawnArgs = [];
    }

    const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: termCols,
      rows: termRows,
      cwd: workDir,
      env,
    });

    const terminal = this._makeTerminal(termId, name, role, ptyProcess, tmuxSession);
    this.terminals.set(termId, terminal);
    return terminal;
  }

  // ---- Reattach to existing tmux session ----
  reattach({ id, name, role, status, cols, rows }) {
    if (!this.tmuxAvailable) return null;
    const tmuxSession = this._tmuxName(id);
    if (!this._tmuxSessionExists(tmuxSession)) return null;

    // Apply our config to the existing session
    try {
      execSync(`tmux -f "${TMUX_CONF}" set -t "${tmuxSession}" status off 2>/dev/null`, { stdio: 'pipe' });
      execSync(`tmux set -t "${tmuxSession}" mouse on 2>/dev/null`, { stdio: 'pipe' });
      execSync(`tmux set -t "${tmuxSession}" escape-time 0 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) { /* best effort */ }

    const env = { ...process.env };
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';

    const ptyProcess = pty.spawn('tmux', ['-f', TMUX_CONF, 'attach-session', '-t', tmuxSession], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: process.env.HOME,
      env,
    });

    const terminal = this._makeTerminal(id, name, role, ptyProcess, tmuxSession);
    terminal.status = status || 'idle';
    this.terminals.set(id, terminal);
    return terminal;
  }

  // ---- Create SSH terminal (convenience wrapper) ----
  createSsh({ id, name, role, cols, rows, target }) {
    return this.create({
      id,
      name: name || `SSH: ${target}`,
      role: role || null,
      cols, rows,
      sshTarget: target,
    });
  }

  // ---- Create remote terminal (local tmux → SSH → remote tmux) ----
  createRemote({ id, name, role, cols, rows, sshTarget, remoteCwd, remoteSessionName }) {
    const termId = id || `t${this.nextId++}`;
    const tmuxSession = this.tmuxAvailable ? this._tmuxName(termId) : null;
    const termCols = cols || 80;
    const termRows = rows || 24;

    const env = { ...process.env };
    env.TERMATES_TERMINAL_ID = termId;
    env.TERMATES_TERMINAL_NAME = name || `Remote: ${sshTarget}`;
    env.TERMATES_SOCKET = path.join(os.tmpdir(), 'termates.sock');
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    if (role) env.TERMATES_ROLE = role;

    const { sshArgs, remoteCmd } = buildRemoteTmuxCommand(sshTarget, remoteSessionName || `termates-${termId}`, remoteCwd);
    const sshFullArgs = [...sshArgs.slice(1), remoteCmd];

    let spawnFile, spawnArgs;
    if (this.tmuxAvailable) {
      if (this._tmuxSessionExists(tmuxSession)) {
        try { execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { stdio: 'pipe' }); } catch (e) {}
      }

      // Same pattern as local: detached create + attach.
      // Use execFileSync (not execSync) to pass args as array — no shell, no quoting issues.
      const createArgs = ['-f', TMUX_CONF, 'new-session', '-d', '-s', tmuxSession,
        '-x', String(termCols), '-y', String(termRows),
        sshArgs[0], ...sshFullArgs];
      try {
        execFileSync('tmux', createArgs, { env, stdio: 'pipe' });
      } catch (e) {
        // Fallback: try without config
        execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, sshArgs[0], ...sshFullArgs], { env, stdio: 'pipe' });
      }

      spawnFile = 'tmux';
      spawnArgs = ['-f', TMUX_CONF, 'attach-session', '-t', tmuxSession];
    } else {
      spawnFile = sshArgs[0];
      spawnArgs = sshFullArgs;
    }

    const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: termCols,
      rows: termRows,
      cwd: process.env.HOME,
      env,
    });

    const terminal = this._makeTerminal(termId, name || `Remote: ${sshTarget}`, role, ptyProcess, tmuxSession);
    terminal.remote = true;
    terminal.sshTarget = sshTarget;
    this.terminals.set(termId, terminal);
    return terminal;
  }

  // ---- Internal: build terminal object ----
  _makeTerminal(id, name, role, ptyProcess, tmuxSession) {
    const terminal = {
      id,
      name: name || `Terminal ${id}`,
      role: role || null,
      status: 'idle',
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

  setRole(id, role) {
    const t = this.terminals.get(id);
    if (t) { t.role = role || null; return true; }
    return false;
  }

  // Destroy terminal AND its tmux session
  destroy(id) {
    const t = this.terminals.get(id);
    if (!t) return false;
    try { t.pty.kill(); } catch (e) { /* already dead */ }
    // Also kill the tmux session
    if (t.tmuxSession && this.tmuxAvailable) {
      try { execSync(`tmux kill-session -t "${t.tmuxSession}" 2>/dev/null`, { stdio: 'pipe' }); }
      catch (e) { /* ok */ }
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
      role: t.role,
      status: t.status,
      tmuxSession: t.tmuxSession,
      createdAt: t.createdAt,
    }));
  }
}
