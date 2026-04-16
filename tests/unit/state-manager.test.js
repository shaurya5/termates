import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Redirect STATE_DIR / STATE_FILE to a temp directory so tests never touch
// the real ~/.termates directory.  We do this by patching the module via
// vi.mock so the constants are replaced before StateManager is instantiated.
// ---------------------------------------------------------------------------

let tmpDir;
let StateManager;

// We re-import freshly each test to get a clean instance, but we set up the
// module mock once per file.

describe('StateManager', () => {
  beforeEach(async () => {
    // Create a fresh temp directory for every test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termates-test-'));

    // Inline a patched version of StateManager that uses our tmpDir
    // (avoids touching the real home directory)
    const mod = await import('../../server/state-manager.js');
    const OrigClass = mod.StateManager;

    // Subclass to override the hardcoded paths
    StateManager = class TestStateManager extends OrigClass {
      constructor() {
        super();
        // Replace state immediately after super() ran with default state
        // (super already called _ensureDir & possibly load – that's fine)
      }

      get _stateDir() { return tmpDir; }
      get _stateFile() { return path.join(tmpDir, 'state.json'); }

      // Override internal helpers to use our temp paths
      _ensureDir() {
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      }

      _doSave() {
        this._ensureDir();
        fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(this.state, null, 2));
      }

      load() {
        const file = path.join(tmpDir, 'state.json');
        try {
          if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf-8');
            const data = JSON.parse(raw);
            if (!data.workspaces) {
              const migrated = this._default();
              migrated.terminals = data.terminals || [];
              migrated.nextTerminalId = data.nextTerminalId || 1;
              migrated.browserTabs = data.browserTabs || [];
              migrated.activeBrowserTab = data.activeBrowserTab || 0;
              migrated.browserOpen = data.browserOpen || false;
              migrated.browserWidth = data.browserWidth || 0.35;
              migrated.nextBrowserTabId = data.nextBrowserTabId || 1;
              migrated.workspaces[0].terminalIds = (data.terminals || []).map(t => t.id);
              migrated.workspaces[0].links = data.links || [];
              migrated.workspaces[0].layout = data.layout || null;
              migrated.workspaces = migrated.workspaces.map(ws => this._normalizeWorkspace(ws));
              this.state = migrated;
            } else {
              const nextState = { ...this._default(), ...data };
              nextState.workspaces = (data.workspaces || nextState.workspaces).map(ws => this._normalizeWorkspace(ws));
              this.state = nextState;
            }
            return true;
          }
        } catch (e) {
          console.error('Failed to load state:', e.message);
        }
        this.state = this._default();
        return false;
      }
    };
  });

  afterEach(() => {
    // Remove temp directory after each test
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Default state
  // -------------------------------------------------------------------------

  describe('default state', () => {
    it('has version 2', () => {
      const sm = new StateManager();
      expect(sm.get().version).toBe(2);
    });

    it('has exactly one workspace', () => {
      const sm = new StateManager();
      expect(sm.get().workspaces).toHaveLength(1);
    });

    it('default workspace id is w1', () => {
      const sm = new StateManager();
      expect(sm.get().workspaces[0].id).toBe('w1');
    });

    it('activeWorkspaceId defaults to w1', () => {
      const sm = new StateManager();
      expect(sm.get().activeWorkspaceId).toBe('w1');
    });
  });

  // -------------------------------------------------------------------------
  // save / load round-trip
  // -------------------------------------------------------------------------

  describe('save / load round-trip', () => {
    it('preserves terminals after saveNow() and fresh load()', () => {
      const sm = new StateManager();
      sm.setTerminals([{ id: 't1', name: 'Alpha', role: 'agent', status: 'busy', tmuxSession: 'termates-t1' }]);
      sm.saveNow();

      const sm2 = new StateManager();
      sm2.load();
      const terminals = sm2.get().terminals;
      expect(terminals).toHaveLength(1);
      expect(terminals[0].id).toBe('t1');
      expect(terminals[0].name).toBe('Alpha');
      expect(terminals[0].role).toBe('agent');
    });

    it('preserves workspaces after saveNow() and fresh load()', () => {
      const sm = new StateManager();
      sm.setWorkspaces([
        { id: 'w1', name: 'Main', terminalIds: ['t1'], links: [], layout: null },
        { id: 'w2', name: 'Dev',  terminalIds: ['t2'], links: [], layout: null },
      ]);
      sm.saveNow();

      const sm2 = new StateManager();
      sm2.load();
      expect(sm2.get().workspaces).toHaveLength(2);
      expect(sm2.get().workspaces[1].name).toBe('Dev');
    });

    it('preserves links inside workspace after saveNow() and fresh load()', () => {
      const sm = new StateManager();
      const ws = sm.get().workspaces[0];
      ws.links = [{ from: 't1', to: 't2' }];
      sm.setWorkspaces(sm.get().workspaces);
      sm.saveNow();

      const sm2 = new StateManager();
      sm2.load();
      expect(sm2.get().workspaces[0].links).toHaveLength(1);
      expect(sm2.get().workspaces[0].links[0].from).toBe('t1');
    });

    it('preserves workspace messages after saveNow() and fresh load()', () => {
      const sm = new StateManager();
      const ws = sm.get().workspaces[0];
      ws.messages = [{ id: 'm1', from: 't1', to: 't2', text: 'hello', timestamp: 123 }];
      sm.setWorkspaces(sm.get().workspaces);
      sm.saveNow();

      const sm2 = new StateManager();
      sm2.load();
      expect(sm2.get().workspaces[0].messages).toEqual([
        { id: 'm1', from: 't1', to: 't2', text: 'hello', timestamp: 123 },
      ]);
    });

    it('load() returns true when a state file exists', () => {
      const sm = new StateManager();
      sm.saveNow();

      const sm2 = new StateManager();
      expect(sm2.load()).toBe(true);
    });

    it('load() returns false when no state file exists', () => {
      const sm = new StateManager();
      expect(sm.load()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // v1 → v2 migration
  // -------------------------------------------------------------------------

  describe('v1 → v2 migration', () => {
    it('migrates v1 state: terminals go into workspace 1', () => {
      // Write a v1 payload manually (no `workspaces` key)
      const v1 = {
        version: 1,
        terminals: [
          { id: 't1', name: 'Old', role: null, status: 'idle' },
          { id: 't2', name: 'Older', role: null, status: 'idle' },
        ],
        nextTerminalId: 3,
        links: [{ from: 't1', to: 't2' }],
        layout: null,
      };
      fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(v1));

      const sm = new StateManager();
      sm.load();
      const state = sm.get();

      // v2 fields must be present
      expect(state.version).toBe(2);
      expect(state.workspaces).toBeDefined();

      // All terminals end up in workspace 1
      expect(state.workspaces[0].terminalIds).toContain('t1');
      expect(state.workspaces[0].terminalIds).toContain('t2');
    });

    it('migrates v1 state: links transferred to workspace 1', () => {
      const v1 = {
        terminals: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }],
        links: [{ from: 't1', to: 't2', createdAt: 1000 }],
        nextTerminalId: 3,
      };
      fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(v1));

      const sm = new StateManager();
      sm.load();
      expect(sm.get().workspaces[0].links).toHaveLength(1);
      expect(sm.get().workspaces[0].links[0].from).toBe('t1');
    });

    it('migrates v1 state: layout transferred to workspace 1', () => {
      const v1Layout = { type: 'leaf', panelId: 't1' };
      const v1 = {
        terminals: [{ id: 't1', name: 'A' }],
        links: [],
        layout: v1Layout,
        nextTerminalId: 2,
      };
      fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(v1));

      const sm = new StateManager();
      sm.load();
      expect(sm.get().workspaces[0].layout).toEqual(v1Layout);
    });

    it('migrated state has correct nextTerminalId', () => {
      const v1 = { terminals: [{ id: 't1', name: 'A' }], links: [], nextTerminalId: 5 };
      fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(v1));

      const sm = new StateManager();
      sm.load();
      expect(sm.get().nextTerminalId).toBe(5);
    });
  });

  describe('workspace normalization', () => {
    it('adds missing workspace defaults when loading an older v2 state', () => {
      fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({
        version: 2,
        workspaces: [{ id: 'w1', name: 'Main', terminalIds: ['t1'] }],
        activeWorkspaceId: 'w1',
      }));

      const sm = new StateManager();
      sm.load();
      expect(sm.get().workspaces[0].cwd).toBeNull();
      expect(sm.get().workspaces[0].messages).toEqual([]);
      expect(sm.get().workspaces[0].links).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Setters persist after saveNow + reload
  // -------------------------------------------------------------------------

  describe('setters persist across save/load', () => {
    it('setTerminals() values survive saveNow() + load()', () => {
      const sm = new StateManager();
      sm.setTerminals([{ id: 't9', name: 'Nine', role: 'watcher', status: 'idle', tmuxSession: null }]);
      sm.saveNow();

      const sm2 = new StateManager();
      sm2.load();
      expect(sm2.get().terminals[0].id).toBe('t9');
      expect(sm2.get().terminals[0].role).toBe('watcher');
    });

    it('setWorkspaces() values survive saveNow() + load()', () => {
      const sm = new StateManager();
      sm.setWorkspaces([{ id: 'w99', name: 'Special', terminalIds: [], links: [], layout: null }]);
      sm.saveNow();

      const sm2 = new StateManager();
      sm2.load();
      expect(sm2.get().workspaces[0].id).toBe('w99');
    });

    it('setTerminals() strips unknown fields (only stores id, name, role, status, tmuxSession)', () => {
      const sm = new StateManager();
      sm.setTerminals([{ id: 't1', name: 'T', role: null, status: 'idle', tmuxSession: null, secretField: 'should-not-be-here' }]);
      const saved = sm.get().terminals[0];
      expect(saved).not.toHaveProperty('secretField');
      expect(saved).toHaveProperty('id');
      expect(saved).toHaveProperty('name');
    });
  });

  // -------------------------------------------------------------------------
  // Debounced save
  // -------------------------------------------------------------------------

  describe('debounced save()', () => {
    it('rapid save() calls result in only one fs.writeFileSync call', async () => {
      // Use fake timers so we can advance time deterministically and avoid
      // interference from debounce timers started by previous tests.
      vi.useFakeTimers();

      const spy = vi.spyOn(fs, 'writeFileSync');
      const sm = new StateManager();
      spy.mockClear(); // discard any writes made during construction

      // Call save() many times in quick succession
      for (let i = 0; i < 20; i++) {
        sm.save();
      }

      // Advance past the 300 ms debounce window
      await vi.advanceTimersByTimeAsync(400);

      const stateCalls = spy.mock.calls.filter(
        ([filePath]) => typeof filePath === 'string' && filePath.endsWith('state.json')
      );
      expect(stateCalls.length).toBe(1);

      vi.useRealTimers();
    });

    it('saveNow() bypasses the debounce and writes immediately', () => {
      const sm = new StateManager();
      const spy = vi.spyOn(fs, 'writeFileSync');

      sm.saveNow();

      const stateCalls = spy.mock.calls.filter(
        ([filePath]) => typeof filePath === 'string' && filePath.endsWith('state.json')
      );
      expect(stateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // getWorkspace / updateWorkspace helpers
  // -------------------------------------------------------------------------

  describe('getWorkspace / updateWorkspace', () => {
    it('getWorkspace returns the correct workspace by id', () => {
      const sm = new StateManager();
      const ws = sm.getWorkspace('w1');
      expect(ws).not.toBeNull();
      expect(ws.id).toBe('w1');
    });

    it('getWorkspace returns null for unknown id', () => {
      const sm = new StateManager();
      expect(sm.getWorkspace('does-not-exist')).toBeNull();
    });

    it('updateWorkspace mutates the workspace in-place', () => {
      const sm = new StateManager();
      sm.updateWorkspace('w1', { name: 'Renamed' });
      expect(sm.get().workspaces[0].name).toBe('Renamed');
    });
  });
});
