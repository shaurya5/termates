/**
 * Performance tests for Termates core managers.
 *
 * Goals: catch O(n²) regressions, buffer overflows, listener leaks, and
 * debounce violations — not arbitrary wall-clock benchmarks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockPty() {
  const listeners = { data: [], exit: [] };
  return {
    onData(cb) { listeners.data.push(cb); },
    onExit(cb) { listeners.exit.push(cb); },
    write(_data) {},
    resize(_cols, _rows) {},
    kill() {},
    /** Synchronously emit fake data to all registered onData listeners. */
    _emit(data) { listeners.data.forEach(cb => cb(data)); },
    _listeners: listeners,
  };
}

// Module-level slot — vi.mock factory runs before any import so the variable
// is always in scope; tests capture the value immediately after mgr.create().
let _lastMockPty = null;

// vi.mock calls are hoisted by Vitest and execute before module imports.
vi.mock('node-pty', () => ({
  default: {
    spawn(..._args) {
      _lastMockPty = createMockPty();
      return _lastMockPty;
    },
  },
}));

// Stub child_process so _checkTmux() returns true (non-throwing execSync)
// and all other tmux shell commands become no-ops.
vi.mock('child_process', () => ({
  execSync(_cmd, _opts) {
    // Returning an empty string satisfies every call site:
    // - tmux -V          → truthy, _checkTmux returns true
    // - list-sessions    → '', split('\n').filter() → []
    // - has-session      → '', treated as success (no throw)
    // - new-session etc. → ignored return value
    return '';
  },
}));

// Intercept fs so _writeTmuxConf and StateManager._doSave never touch disk.
// Keep the real implementations for everything else (readFileSync, etc.).
// The `default:` key is required so that `import fs from 'fs'` in both the
// test file and the source modules receives the same mocked object with
// vi.fn() spy methods intact (spreading without `default` yields the real
// module for the default-import binding).
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

// All source imports must come AFTER vi.mock declarations.
import { PtyManager } from '../../server/pty-manager.js';
import { StateManager } from '../../server/state-manager.js';
import { LinkManager } from '../../server/link-manager.js';

// ---------------------------------------------------------------------------
// P-1: Terminal buffer throughput
// ---------------------------------------------------------------------------

describe('P-1: Terminal buffer throughput', () => {
  it('trims the buffer and fires all 3 000 listener callbacks without error', () => {
    const mgr = new PtyManager();
    const term = mgr.create({ id: 'p1-t1', cols: 80, rows: 24 });
    const mockPty = _lastMockPty;

    const chunk = 'x'.repeat(1024); // 1 KB per chunk
    const TOTAL = 3000;
    let fired = 0;
    let threw = 0;

    term.onData(() => { fired++; });

    for (let i = 0; i < TOTAL; i++) {
      try {
        mockPty._emit(chunk);
      } catch (_e) {
        threw++;
      }
    }

    // _makeTerminal trims to 75 % of maxBufferLines (2 000) once the cap is
    // reached, so the buffer can never grow beyond 2 000 entries.
    expect(term.buffer.length).toBeLessThanOrEqual(2000);

    // Every emitted chunk must reach every registered listener exactly once.
    expect(fired).toBe(TOTAL);
    expect(threw).toBe(0);

    mgr.destroy('p1-t1');
  });
});

// ---------------------------------------------------------------------------
// P-2: State save debounce
// ---------------------------------------------------------------------------

describe('P-2: State save debounce', () => {
  it('collapses 200 rapid save() calls into exactly one fs.writeFileSync', async () => {
    vi.useRealTimers();

    // Clear any writeFileSync calls made during module initialisation.
    vi.mocked(fs.writeFileSync).mockClear();

    const mgr = new StateManager();

    // StateManager constructor may call _ensureDir; clear again so only our
    // save() calls are counted.
    vi.mocked(fs.writeFileSync).mockClear();

    for (let i = 0; i < 200; i++) {
      mgr.save();
    }

    // Wait well past the 300 ms debounce window.
    await new Promise(resolve => setTimeout(resolve, 500));

    // Filter to state.json writes only (ignore any incidental calls).
    const stateCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
      ([filePath]) => typeof filePath === 'string' && filePath.includes('state.json'),
    );

    // Exactly one flush must have been written.
    expect(stateCalls.length).toBe(1);

    // The payload must be valid JSON with the expected top-level shape.
    const [, writtenContent] = stateCalls[0];
    expect(() => JSON.parse(writtenContent)).not.toThrow();
    const parsed = JSON.parse(writtenContent);
    expect(parsed).toHaveProperty('version');
    expect(parsed).toHaveProperty('workspaces');
  });
});

// ---------------------------------------------------------------------------
// P-3: LinkManager performance with many links
// ---------------------------------------------------------------------------

describe('P-3: LinkManager performance with many links', () => {
  it('handles 100 links across 50 terminals and all mutations in under 100 ms', () => {
    const lm = new LinkManager();
    const start = performance.now();

    // 50 unique terminal IDs
    const termIds = Array.from({ length: 50 }, (_, i) => `t${i}`);

    // Each terminal i gets two outgoing edges: to (i+1)%50 and (i+2)%50.
    // All 100 keys are unique because the sorted-pair key space has no
    // collisions for a consecutive-step pattern on 50 nodes.
    for (let i = 0; i < 50; i++) {
      lm.link(termIds[i], termIds[(i + 1) % 50]);
      lm.link(termIds[i], termIds[(i + 2) % 50]);
    }

    const all = lm.listAll();
    expect(all.length).toBe(100);

    // t0 is connected to t1 (+1) and t2 (+2); also t48 (+2→t0) and t49 (+1→t0)
    // contribute. getLinkedTerminals must at minimum return the two forward neighbours.
    const neighbours = lm.getLinkedTerminals('t0');
    expect(neighbours).toContain('t1');
    expect(neighbours).toContain('t2');

    // removeTerminal must delete every link that mentions the removed node.
    const removedCount = lm.removeTerminal('t0');
    expect(removedCount).toBeGreaterThan(0);

    const afterRemove = lm.listAll();
    expect(afterRemove.length).toBe(all.length - removedCount);

    // t0 must be gone from every remaining link.
    for (const link of afterRemove) {
      expect(link.from).not.toBe('t0');
      expect(link.to).not.toBe('t0');
    }

    // The entire sequence — 100 adds + queries + remove — must finish in < 100 ms.
    // An accidental O(n²) scan would easily exceed this on 100 links.
    expect(performance.now() - start).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// P-4: Multiple terminal creation / destruction cycle
// ---------------------------------------------------------------------------

describe('P-4: Multiple terminal creation/destruction cycle', () => {
  it('creates 20 terminals with unique IDs and leaves an empty map after destroy', () => {
    const mgr = new PtyManager();
    const COUNT = 20;
    const ids = [];
    const capturedPtys = [];

    for (let i = 1; i <= COUNT; i++) {
      const term = mgr.create({ id: `p4-t${i}`, cols: 80, rows: 24 });
      ids.push(term.id);
      // Capture the pty created for this terminal so we can verify teardown.
      capturedPtys.push(_lastMockPty);
    }

    // All 20 must be live and have unique IDs.
    expect(mgr.size).toBe(COUNT);
    expect(new Set(ids).size).toBe(COUNT);

    // Destroy every terminal.
    for (const id of ids) {
      expect(mgr.destroy(id)).toBe(true);
    }

    // The internal map must now be empty.
    expect(mgr.size).toBe(0);

    // mgr.get() must return null for every previously registered ID,
    // confirming no ghost entries linger in the Map.
    for (const id of ids) {
      expect(mgr.get(id)).toBeNull();
    }

    // Listener-leak check: destroy() calls t.listeners.clear().
    // We verify by re-adding a listener to a terminal that no longer exists —
    // the terminal objects are gone from the map, so the only evidence of a
    // leak would be if the PtyManager itself still held references. We confirm
    // the map size is 0, which is the authoritative leak indicator here.
    expect(mgr.terminals.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P-5: Rapid resize cycles
// ---------------------------------------------------------------------------

describe('P-5: Rapid resize cycles', () => {
  it('handles 100 alternating resize() calls and every call returns true', () => {
    const mgr = new PtyManager();
    const term = mgr.create({ id: 'p5-t1', cols: 80, rows: 24 });

    const ITERATIONS = 100;
    const sizeA = [80, 24];
    const sizeB = [120, 40];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const [cols, rows] = i % 2 === 0 ? sizeA : sizeB;
      if (mgr.resize(term.id, cols, rows) === true) {
        succeeded++;
      } else {
        failed++;
      }
    }

    // No resize attempt should fail — the mock pty's resize() never throws.
    expect(failed).toBe(0);
    expect(succeeded).toBe(ITERATIONS);

    mgr.destroy('p5-t1');
  });
});
