/**
 * Unit tests for PtyManager methods that are not covered elsewhere.
 *
 * The perf tests cover create/destroy cycles and buffer throughput, but
 * these methods are used by every CLI command and WebSocket handler and
 * have ZERO coverage:
 *   resolve(), getByName(), rename(), setStatus(),
 *   write(), list(), getBuffer(), detachAll(), destroyAll()
 *
 * A regression in resolve() or getByName() silently breaks every CLI
 * command since the CLI resolves targets by name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must come before source imports)
// ---------------------------------------------------------------------------

let _lastMockPty = null;
let _lastSpawnArgs = null;

function createMockPty() {
  const listeners = { data: [], exit: [] };
  return {
    onData(cb) { listeners.data.push(cb); },
    onExit(cb) { listeners.exit.push(cb); },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _emit(data) { listeners.data.forEach(cb => cb(data)); },
    _emitExit(code) { listeners.exit.forEach(cb => cb({ exitCode: code })); },
    _listeners: listeners,
  };
}

vi.mock('node-pty', () => ({
  default: {
    spawn(...args) {
      _lastSpawnArgs = args;
      _lastMockPty = createMockPty();
      return _lastMockPty;
    },
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    default: {
      ...real,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn((filePath, ...args) => {
        if (typeof filePath === 'string' && filePath.includes('binaries/abduco-')) {
          return Buffer.from('quiet-test-abduco');
        }
        return real.readFileSync(filePath, ...args);
      }),
    },
  };
});

import { PtyManager, buildTerminalEnv, loginShellArgs } from '../../server/pty-manager.js';
import { execFileSync, execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mgr;

beforeEach(() => {
  _lastSpawnArgs = null;
  execSync.mockImplementation(() => '');
  execFileSync.mockImplementation(() => '');
  mgr = new PtyManager();
});

describe('backend selection', () => {
  it('prefers tmux when both tmux and abduco are available', () => {
    execSync.mockImplementation((command) => {
      if (command.includes('command -v tmux')) return '/usr/bin/tmux\n';
      if (command.includes('command -v abduco')) return '/usr/bin/abduco\n';
      return '';
    });

    const tmuxMgr = new PtyManager();
    tmuxMgr.create({ id: 'bk1', name: 'Backend' });

    expect(tmuxMgr.backend.name).toBe('tmux');
    expect(_lastSpawnArgs[0]).toBe(process.execPath);
    expect(_lastSpawnArgs[1][0]).toMatch(/server\/tmux-control-client\.js$/);
    expect(_lastSpawnArgs[1][1]).toBe('/usr/bin/tmux');
  });
});

describe('session input passthrough', () => {
  it('turns tmux mouse on only while a pane is in alt-screen', () => {
    execSync.mockImplementation((command) => {
      if (command.includes('command -v tmux')) return '/usr/bin/tmux\n';
      if (command.includes('command -v abduco')) return '/usr/bin/abduco\n';
      return '';
    });
    execFileSync.mockClear();

    const tmuxMgr = new PtyManager();
    const terminal = tmuxMgr.create({ id: 'tui1', name: 'TUI' });
    const mockPty = _lastMockPty;

    execFileSync.mockClear();
    mockPty._emit('\x1b[?1049h');
    expect(terminal.inTui).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/tmux', [
      '-S', expect.any(String),
      'set-option', '-t', 'termates-tui1',
      'mouse', 'on',
    ], { stdio: 'pipe' });

    execFileSync.mockClear();
    mockPty._emit('\x1b[?1049l');
    expect(terminal.inTui).toBe(false);
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/tmux', [
      '-S', expect.any(String),
      'set-option', '-t', 'termates-tui1',
      'mouse', 'off',
    ], { stdio: 'pipe' });
  });
});

// ---------------------------------------------------------------------------
// resolve() and getByName()
// ---------------------------------------------------------------------------

describe('resolve()', () => {
  it('resolves by exact terminal ID', () => {
    const t = mgr.create({ id: 'r1', name: 'Alpha' });
    expect(mgr.resolve('r1')).toBe(t);
  });

  it('resolves by exact name (case-insensitive)', () => {
    const t = mgr.create({ id: 'r2', name: 'MyTerminal' });
    expect(mgr.resolve('myterminal')).toBe(t);
  });

  it('resolves by partial name match', () => {
    const t = mgr.create({ id: 'r3', name: 'Production Server' });
    expect(mgr.resolve('production')).toBe(t);
  });

  it('prefers ID match over name match', () => {
    // Create a terminal whose NAME is "r4" and another whose ID is "r4"
    mgr.create({ id: 'r4', name: 'Something' });
    mgr.create({ id: 'other', name: 'r4' });
    const result = mgr.resolve('r4');
    expect(result.id).toBe('r4');
  });

  it('returns null when no terminal matches', () => {
    mgr.create({ id: 'r5', name: 'Alpha' });
    expect(mgr.resolve('nonexistent')).toBeNull();
  });
});

describe('getByName()', () => {
  it('returns terminal with exact name match (case-insensitive)', () => {
    const t = mgr.create({ id: 'g1', name: 'Exact Match' });
    expect(mgr.getByName('exact match')).toBe(t);
  });

  it('prefers exact match over partial match', () => {
    mgr.create({ id: 'g2', name: 'Test' });
    mgr.create({ id: 'g3', name: 'Test Runner' });
    const result = mgr.getByName('Test');
    expect(result.id).toBe('g2');
  });

  it('falls back to partial match when no exact match', () => {
    mgr.create({ id: 'g4', name: 'My Long Terminal Name' });
    const result = mgr.getByName('Long Terminal');
    expect(result).not.toBeNull();
    expect(result.id).toBe('g4');
  });

  it('returns null for empty string', () => {
    mgr.create({ id: 'g5', name: 'Test' });
    expect(mgr.getByName('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(mgr.getByName(null)).toBeNull();
  });

  it('returns null when no terminals exist', () => {
    expect(mgr.getByName('anything')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rename()
// ---------------------------------------------------------------------------

describe('rename()', () => {
  it('renames a terminal and returns true', () => {
    mgr.create({ id: 'rn1', name: 'OldName' });
    expect(mgr.rename('rn1', 'NewName')).toBe(true);
    expect(mgr.get('rn1').name).toBe('NewName');
  });

  it('returns false for non-existent terminal', () => {
    expect(mgr.rename('nonexistent', 'Name')).toBe(false);
  });

  it('renamed terminal is findable by new name', () => {
    mgr.create({ id: 'rn2', name: 'Before' });
    mgr.rename('rn2', 'After');
    expect(mgr.getByName('After')).not.toBeNull();
    expect(mgr.getByName('Before')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setStatus()
// ---------------------------------------------------------------------------

describe('setStatus()', () => {
  it('sets status and returns true', () => {
    mgr.create({ id: 'ss1', name: 'Test' });
    expect(mgr.setStatus('ss1', 'success')).toBe(true);
    expect(mgr.get('ss1').status).toBe('success');
  });

  it('can set all valid statuses', () => {
    mgr.create({ id: 'ss2', name: 'Test' });
    for (const status of ['idle', 'attention', 'success', 'warning', 'error']) {
      mgr.setStatus('ss2', status);
      expect(mgr.get('ss2').status).toBe(status);
    }
  });

  it('default status is idle', () => {
    mgr.create({ id: 'ss3', name: 'Test' });
    expect(mgr.get('ss3').status).toBe('idle');
  });

  it('returns false for non-existent terminal', () => {
    expect(mgr.setStatus('nonexistent', 'error')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// write()
// ---------------------------------------------------------------------------

describe('write()', () => {
  it('writes data to the PTY and returns true', () => {
    mgr.create({ id: 'w1', name: 'Test' });
    const mockPty = _lastMockPty;
    expect(mgr.write('w1', 'echo hello\n')).toBe(true);
    expect(mockPty.write).toHaveBeenCalledWith('echo hello\n');
  });

  it('returns false for non-existent terminal', () => {
    expect(mgr.write('nonexistent', 'data')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resize()
// ---------------------------------------------------------------------------

describe('resize()', () => {
  it('clamps cols and rows to minimum of 1', () => {
    mgr.create({ id: 'rs1', name: 'Test' });
    const mockPty = _lastMockPty;
    mgr.resize('rs1', 0, 0);
    expect(mockPty.resize).toHaveBeenCalledWith(1, 1);
  });

  it('passes through valid cols and rows', () => {
    mgr.create({ id: 'rs2', name: 'Test' });
    const mockPty = _lastMockPty;
    mgr.resize('rs2', 120, 40);
    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('returns false for non-existent terminal', () => {
    expect(mgr.resize('nonexistent', 80, 24)).toBe(false);
  });

  it('returns false if pty.resize throws', () => {
    mgr.create({ id: 'rs3', name: 'Test' });
    _lastMockPty.resize.mockImplementation(() => { throw new Error('resize failed'); });
    expect(mgr.resize('rs3', 80, 24)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reattach()
// ---------------------------------------------------------------------------

describe('reattach()', () => {
  it('returns a terminal when the session exists', () => {
    execSync.mockImplementation((command) => {
      if (command.includes('command -v tmux')) return '/usr/bin/tmux\n';
      if (command.includes('command -v abduco')) return '/usr/bin/abduco\n';
      return '';
    });

    const tmuxMgr = new PtyManager();
    const terminal = tmuxMgr.reattach({ id: 'rt1', name: 'Restored' });
    expect(terminal).not.toBeNull();
    expect(terminal.id).toBe('rt1');
  });

  it('queries tmux for the live TUI state when restoring a session', () => {
    execSync.mockImplementation((command) => {
      if (command.includes('command -v tmux')) return '/usr/bin/tmux\n';
      if (command.includes('command -v abduco')) return '/usr/bin/abduco\n';
      return '';
    });
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === '/usr/bin/tmux' && args.includes('list-panes')) return '1\n';
      return '';
    });

    const tmuxMgr = new PtyManager();
    const terminal = tmuxMgr.reattach({ id: 'rt2', name: 'Restored', inTui: false });

    expect(terminal.inTui).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/tmux', [
      '-S', expect.any(String),
      'set-option', '-t', 'termates-rt2',
      'mouse', 'on',
    ], { stdio: 'pipe' });
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('list()', () => {
  it('returns empty array when no terminals exist', () => {
    expect(mgr.list()).toEqual([]);
  });

  it('returns serialized terminal objects with correct shape', () => {
    mgr.create({ id: 'l1', name: 'Alpha' });

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty('id', 'l1');
    expect(list[0]).toHaveProperty('name', 'Alpha');
    expect(list[0]).toHaveProperty('status', 'idle');
    expect(list[0]).toHaveProperty('tmuxSession');
    expect(list[0]).toHaveProperty('createdAt');
  });

  it('does not leak internal properties (pty, buffer, listeners)', () => {
    mgr.create({ id: 'l2', name: 'Test' });
    const item = mgr.list()[0];
    expect(item).not.toHaveProperty('pty');
    expect(item).not.toHaveProperty('buffer');
    expect(item).not.toHaveProperty('listeners');
    expect(item).not.toHaveProperty('exitCallbacks');
  });

  it('reflects changes made via setStatus/rename', () => {
    mgr.create({ id: 'l3', name: 'Original' });
    mgr.rename('l3', 'Updated');
    mgr.setStatus('l3', 'warning');

    const item = mgr.list().find(t => t.id === 'l3');
    expect(item.name).toBe('Updated');
    expect(item.status).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// getBuffer()
// ---------------------------------------------------------------------------

describe('getBuffer()', () => {
  it('returns empty string when buffer is empty', () => {
    const t = mgr.create({ id: 'b1', name: 'Test' });
    expect(t.getBuffer()).toBe('');
  });

  it('returns the last N lines of output', () => {
    const t = mgr.create({ id: 'b2', name: 'Test' });
    const mockPty = _lastMockPty;

    // Simulate output with newlines
    mockPty._emit('line1\nline2\nline3\nline4\nline5\n');

    const result = t.getBuffer(3);
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toContain('line4');
    expect(lines).toContain('line5');
  });

  it('returns all content when requesting more lines than exist', () => {
    const t = mgr.create({ id: 'b3', name: 'Test' });
    _lastMockPty._emit('short\n');

    const result = t.getBuffer(1000);
    expect(result).toContain('short');
  });

  it('default is 50 lines', () => {
    const t = mgr.create({ id: 'b4', name: 'Test' });
    // Push 60 lines into buffer
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n') + '\n';
    _lastMockPty._emit(lines);

    const result = t.getBuffer();
    const outputLines = result.split('\n').filter(Boolean);
    expect(outputLines.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// detachAll()
// ---------------------------------------------------------------------------

describe('detachAll()', () => {
  it('kills all PTYs and clears the terminals map', () => {
    const ptys = [];
    mgr.create({ id: 'da1', name: 'A' }); ptys.push(_lastMockPty);
    mgr.create({ id: 'da2', name: 'B' }); ptys.push(_lastMockPty);
    mgr.create({ id: 'da3', name: 'C' }); ptys.push(_lastMockPty);

    expect(mgr.size).toBe(3);
    mgr.detachAll();

    expect(mgr.size).toBe(0);
    for (const p of ptys) {
      expect(p.kill).toHaveBeenCalled();
    }
  });

  it('clears listeners on all terminals', () => {
    const t = mgr.create({ id: 'da4', name: 'Test' });
    let callCount = 0;
    t.onData(() => { callCount++; });

    mgr.detachAll();

    // Listener set was cleared, so emitting should not increment
    // (the terminal object still exists in our local var, but listeners are gone)
    expect(t.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// destroyAll()
// ---------------------------------------------------------------------------

describe('destroyAll()', () => {
  it('destroys all terminals (including tmux sessions)', () => {
    mgr.create({ id: 'dal1', name: 'X' });
    mgr.create({ id: 'dal2', name: 'Y' });

    expect(mgr.size).toBe(2);
    mgr.destroyAll();
    expect(mgr.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('get()', () => {
  it('returns the terminal object for a valid ID', () => {
    const t = mgr.create({ id: 'get1', name: 'Test' });
    expect(mgr.get('get1')).toBe(t);
  });

  it('returns null for non-existent ID', () => {
    expect(mgr.get('nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

describe('destroy()', () => {
  it('returns true and removes the terminal', () => {
    mgr.create({ id: 'del1', name: 'Test' });
    expect(mgr.destroy('del1')).toBe(true);
    expect(mgr.get('del1')).toBeNull();
  });

  it('returns false for non-existent terminal', () => {
    expect(mgr.destroy('nonexistent')).toBe(false);
  });

  it('kills the PTY process', () => {
    mgr.create({ id: 'del2', name: 'Test' });
    const mockPty = _lastMockPty;
    mgr.destroy('del2');
    expect(mockPty.kill).toHaveBeenCalled();
  });

  it('clears listeners', () => {
    const t = mgr.create({ id: 'del3', name: 'Test' });
    t.onData(() => {});
    t.onData(() => {});
    expect(t.listeners.size).toBe(2);

    mgr.destroy('del3');
    expect(t.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// create() - terminal object shape
// ---------------------------------------------------------------------------

describe('create() terminal object', () => {
  it('has all expected properties', () => {
    const t = mgr.create({ id: 'co1', name: 'Test' });
    expect(t.id).toBe('co1');
    expect(t.name).toBe('Test');
    expect(t.status).toBe('idle');
    expect(t.buffer).toEqual([]);
    expect(t.maxBufferLines).toBe(2000);
    expect(t.listeners).toBeInstanceOf(Set);
    expect(t.exitCallbacks).toBeInstanceOf(Set);
    expect(typeof t.createdAt).toBe('number');
    expect(typeof t.onData).toBe('function');
    expect(typeof t.onExit).toBe('function');
    expect(typeof t.getBuffer).toBe('function');
  });

  it('auto-increments ID when no id is provided', () => {
    const mgr2 = new PtyManager();
    const t1 = mgr2.create({ name: 'A' });
    const t2 = mgr2.create({ name: 'B' });
    expect(t1.id).toBe('t1');
    expect(t2.id).toBe('t2');
  });

  it('defaults name to "Terminal <id>" when no name given', () => {
    const t = mgr.create({ id: 'co2' });
    expect(t.name).toBe('Terminal co2');
  });

  it('sanitizes inherited terminal env before spawning', () => {
    const originalNoColor = process.env.NO_COLOR;
    const originalTermProgram = process.env.TERM_PROGRAM;
    const originalTmux = process.env.TMUX;
    const originalWeztermPane = process.env.WEZTERM_PANE;

    process.env.NO_COLOR = '1';
    process.env.TERM_PROGRAM = 'tmux';
    process.env.TMUX = '/tmp/outer-tmux';
    process.env.WEZTERM_PANE = '12';

    try {
      mgr.create({ id: 'co4', name: 'Sanitized' });
      const [, , options] = _lastSpawnArgs;

      expect(options.env.NO_COLOR).toBeUndefined();
      expect(options.env.TMUX).toBeUndefined();
      expect(options.env.WEZTERM_PANE).toBeUndefined();
      expect(options.env.TERM_PROGRAM).toBe('Termates');
      expect(options.env.COLORTERM).toBe('truecolor');
      expect(options.env.TERM).toBe('xterm-256color');
      expect(options.env.TERMATES_TERMINAL_ID).toBe('co4');
      expect(options.env.TERMATES_TERMINAL_NAME).toBe('Sanitized');
    } finally {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
      if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = originalTermProgram;
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
      if (originalWeztermPane === undefined) delete process.env.WEZTERM_PANE;
      else process.env.WEZTERM_PANE = originalWeztermPane;
    }
  });
});

// ---------------------------------------------------------------------------
// onData / onExit callbacks
// ---------------------------------------------------------------------------

describe('terminal callbacks', () => {
  it('onData() fires for each PTY output chunk', () => {
    const t = mgr.create({ id: 'cb1', name: 'Test' });
    const mockPty = _lastMockPty;
    const received = [];
    t.onData((data) => received.push(data));

    mockPty._emit('chunk1');
    mockPty._emit('chunk2');

    expect(received).toEqual(['chunk1', 'chunk2']);
  });

  it('onData() returns an unsubscribe function', () => {
    const t = mgr.create({ id: 'cb2', name: 'Test' });
    const mockPty = _lastMockPty;
    let count = 0;
    const unsub = t.onData(() => { count++; });

    mockPty._emit('data');
    expect(count).toBe(1);

    unsub();
    mockPty._emit('data');
    expect(count).toBe(1); // no more calls after unsub
  });

  it('onExit() fires with terminal id and exit code', () => {
    const t = mgr.create({ id: 'cb3', name: 'Test' });
    const mockPty = _lastMockPty;
    let exitId, exitCode;
    t.onExit((id, code) => { exitId = id; exitCode = code; });

    mockPty._emitExit(0);
    expect(exitId).toBe('cb3');
    expect(exitCode).toBe(0);
  });

  it('exit message is broadcast to data listeners', () => {
    const t = mgr.create({ id: 'cb4', name: 'Test' });
    const mockPty = _lastMockPty;
    const received = [];
    t.onData((data) => received.push(data));

    mockPty._emitExit(1);
    expect(received.length).toBe(1);
    expect(received[0]).toContain('Process exited with code 1');
  });
});

// ---------------------------------------------------------------------------
// setNextId()
// ---------------------------------------------------------------------------

describe('setNextId()', () => {
  it('changes the next auto-assigned terminal ID', () => {
    const mgr2 = new PtyManager();
    mgr2.setNextId(100);
    const t = mgr2.create({ name: 'Test' });
    expect(t.id).toBe('t100');
  });
});

describe('buildTerminalEnv()', () => {
  it('drops leaked outer-terminal markers and keeps shell essentials', () => {
    const env = buildTerminalEnv({
      id: 'env1',
      name: 'Test Env',
      baseEnv: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/home',
        NO_COLOR: '1',
        TERM_PROGRAM: 'tmux',
        TMUX: '/tmp/outer',
        KITTY_WINDOW_ID: '99',
      },
    });

    expect(env.PATH.split(':')).toEqual(expect.arrayContaining([
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
      '/Applications/Codex.app/Contents/Resources',
    ]));
    expect(env.HOME).toBe('/tmp/home');
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.KITTY_WINDOW_ID).toBeUndefined();
    expect(env.TERM_PROGRAM).toBe('Termates');
    expect(env.TERMATES_TERMINAL_ID).toBe('env1');
    expect(env.TERMATES_TERMINAL_NAME).toBe('Test Env');
  });

  it('does not duplicate inherited PATH entries when adding developer bin paths', () => {
    const env = buildTerminalEnv({
      id: 'env2',
      name: 'Path Env',
      baseEnv: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/opt/homebrew/bin',
      },
    });

    expect(env.PATH.split(':').filter((entry) => entry === '/opt/homebrew/bin')).toHaveLength(1);
  });
});

describe('loginShellArgs()', () => {
  it('uses login mode for common user shells so profile PATH setup runs', () => {
    expect(loginShellArgs('/bin/zsh')).toEqual(['-l']);
    expect(loginShellArgs('/opt/homebrew/bin/bash')).toEqual(['-l']);
    expect(loginShellArgs('/opt/homebrew/bin/fish')).toEqual(['-l']);
  });

  it('does not pass login flags to unknown shell wrappers', () => {
    expect(loginShellArgs('/usr/local/bin/custom-shell')).toEqual([]);
  });
});
