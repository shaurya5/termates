import fs from 'fs';
import path from 'path';
import os from 'os';

const STATE_DIR = path.join(os.homedir(), '.termates');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export class StateManager {
  constructor() {
    this.state = this._default();
    this._saveTimer = null;
    this._ensureDir();
  }

  _default() {
    return {
      version: 2,
      workspaces: [
        this._normalizeWorkspace({ id: 'w1', name: 'Workspace 1' }),
      ],
      activeWorkspaceId: 'w1',
      nextWorkspaceId: 2,
      terminals: [],
      nextTerminalId: 1,
      browserTabs: [],
      activeBrowserTab: 0,
      browserOpen: false,
      browserWidth: 0.35,
      nextBrowserTabId: 1,
    };
  }

  _normalizeWorkspace(workspace = {}) {
    return {
      id: workspace.id,
      name: workspace.name,
      terminalIds: workspace.terminalIds || [],
      links: workspace.links || [],
      layout: workspace.layout || null,
      type: workspace.type || (workspace.sshTarget ? 'remote' : 'local'),
      cwd: workspace.cwd || null,
      sshTarget: workspace.sshTarget || null,
      remoteCwd: workspace.remoteCwd || null,
      messages: workspace.messages || [],
    };
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch (e) { /* ignore */ }
  }

  load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        // Migrate v1 state to v2 (workspaces)
        if (!data.workspaces) {
          const migrated = this._default();
          migrated.terminals = data.terminals || [];
          migrated.nextTerminalId = data.nextTerminalId || 1;
          migrated.browserTabs = data.browserTabs || [];
          migrated.activeBrowserTab = data.activeBrowserTab || 0;
          migrated.browserOpen = data.browserOpen || false;
          migrated.browserWidth = data.browserWidth || 0.35;
          migrated.nextBrowserTabId = data.nextBrowserTabId || 1;
          // Put all existing terminals into workspace 1
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

  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._doSave(), 300);
  }

  saveNow() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._doSave();
  }

  _doSave() {
    try {
      this._ensureDir();
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('Failed to save state:', e.message);
    }
  }

  get() { return this.state; }

  // --- Terminals ---
  setTerminals(terminals) {
    this.state.terminals = terminals.map(t => ({
      id: t.id, name: t.name, role: t.role, status: t.status,
      tmuxSession: t.tmuxSession || null,
    }));
    this.save();
  }

  setNextTerminalId(id) { this.state.nextTerminalId = id; this.save(); }

  // --- Workspaces ---
  setWorkspaces(workspaces) { this.state.workspaces = workspaces; this.save(); }
  setActiveWorkspaceId(id) { this.state.activeWorkspaceId = id; this.save(); }
  setNextWorkspaceId(id) { this.state.nextWorkspaceId = id; this.save(); }

  getWorkspace(id) {
    return this.state.workspaces.find(w => w.id === id) || null;
  }

  updateWorkspace(id, updates) {
    const ws = this.state.workspaces.find(w => w.id === id);
    if (ws) { Object.assign(ws, updates); this.save(); }
  }

  // --- Browser ---
  setBrowserTabs(tabs) { this.state.browserTabs = tabs; this.save(); }
  setBrowserOpen(open) { this.state.browserOpen = open; this.save(); }
  setBrowserWidth(width) { this.state.browserWidth = width; this.save(); }
  setActiveBrowserTab(index) { this.state.activeBrowserTab = index; this.save(); }
  setNextBrowserTabId(id) { this.state.nextBrowserTabId = id; this.save(); }
}
