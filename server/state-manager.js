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
      version: 1,
      terminals: [],       // [{ id, name, role, status, tmuxSession }]
      links: [],           // [{ from, to }]
      layout: null,        // layout tree (JSON)
      browserTabs: [],     // [{ id, url, title }]
      activeBrowserTab: 0,
      browserOpen: false,
      browserWidth: 0.35,
      nextTerminalId: 1,
      nextBrowserTabId: 1,
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
        this.state = { ...this._default(), ...data };
        return true;
      }
    } catch (e) {
      console.error('Failed to load state:', e.message);
    }
    this.state = this._default();
    return false;
  }

  // Debounced save
  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._doSave(), 300);
  }

  // Immediate save (for shutdown)
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

  get() {
    return this.state;
  }

  // Terminal state
  setTerminals(terminals) {
    this.state.terminals = terminals.map(t => ({
      id: t.id, name: t.name, role: t.role, status: t.status,
      tmuxSession: t.tmuxSession || null,
    }));
    this.save();
  }

  setNextTerminalId(id) {
    this.state.nextTerminalId = id;
    this.save();
  }

  // Links
  setLinks(links) {
    this.state.links = links.map(l => ({ from: l.from, to: l.to }));
    this.save();
  }

  // Layout
  setLayout(layout) {
    this.state.layout = layout;
    this.save();
  }

  // Browser
  setBrowserTabs(tabs) {
    this.state.browserTabs = tabs;
    this.save();
  }

  setBrowserOpen(open) {
    this.state.browserOpen = open;
    this.save();
  }

  setBrowserWidth(width) {
    this.state.browserWidth = width;
    this.save();
  }

  setActiveBrowserTab(index) {
    this.state.activeBrowserTab = index;
    this.save();
  }

  setNextBrowserTabId(id) {
    this.state.nextBrowserTabId = id;
    this.save();
  }
}
