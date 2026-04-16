/**
 * Unit tests for PtyManager methods that are not covered elsewhere.
 *
 * The perf tests cover create/destroy cycles and buffer throughput, but
 * these methods are used by every CLI command and WebSocket handler and
 * have ZERO coverage:
 *   resolve(), getByName(), rename(), setRole(), setStatus(),
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
    spawn(..._args) {
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
    },
  };
});

import { PtyManager } from '../../server/pty-manager.js';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mgr;

beforeEach(() => {
  mgr = new PtyManager();
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
// setRole()
// ---------------------------------------------------------------------------

describe('setRole()', () => {
  it('sets a role and returns true', () => {
    mgr.create({ id: 'sr1', name: 'Test' });
    expect(mgr.setRole('sr1', 'coder')).toBe(true);
    expect(mgr.get('sr1').role).toBe('coder');
  });

  it('clears role when set to empty string', () => {
    mgr.create({ id: 'sr2', name: 'Test', role: 'reviewer' });
    mgr.setRole('sr2', '');
    expect(mgr.get('sr2').role).toBeNull();
  });

  it('clears role when set to null', () => {
    mgr.create({ id: 'sr3', name: 'Test', role: 'coder' });
    mgr.setRole('sr3', null);
    expect(mgr.get('sr3').role).toBeNull();
  });

  it('returns false for non-existent terminal', () => {
    expect(mgr.setRole('nonexistent', 'coder')).toBe(false);
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
  it('reapplies transparent tmux config with mouse off', () => {
    vi.mocked(execSync).mockClear();

    const terminal = mgr.reattach({ id: 'rt1', name: 'Restored' });

    expect(terminal).not.toBeNull();
    expect(vi.mocked(execSync).mock.calls.some(([cmd]) => cmd.includes('mouse off'))).toBe(true);
    expect(vi.mocked(execSync).mock.calls.some(([cmd]) => cmd.includes('mouse on'))).toBe(false);
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
    mgr.create({ id: 'l1', name: 'Alpha', role: 'coder' });

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty('id', 'l1');
    expect(list[0]).toHaveProperty('name', 'Alpha');
    expect(list[0]).toHaveProperty('role', 'coder');
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

  it('reflects changes made via setStatus/rename/setRole', () => {
    mgr.create({ id: 'l3', name: 'Original' });
    mgr.rename('l3', 'Updated');
    mgr.setRole('l3', 'reviewer');
    mgr.setStatus('l3', 'warning');

    const item = mgr.list().find(t => t.id === 'l3');
    expect(item.name).toBe('Updated');
    expect(item.role).toBe('reviewer');
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
    const t = mgr.create({ id: 'co1', name: 'Test', role: 'coder' });
    expect(t.id).toBe('co1');
    expect(t.name).toBe('Test');
    expect(t.role).toBe('coder');
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

  it('defaults role to null when not provided', () => {
    const t = mgr.create({ id: 'co3', name: 'Test' });
    expect(t.role).toBeNull();
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
