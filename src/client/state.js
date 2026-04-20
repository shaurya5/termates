// ============================================
// State
// ============================================

import { send } from './transport.js';

export const DEFAULT_AGENT_PRESETS = Object.freeze({
  claude: { command: 'claude' },
  codex: { command: 'codex' },
});

export function normalizeAgentPresets(raw = {}) {
  return {
    claude: {
      command: typeof raw?.claude?.command === 'string'
        ? raw.claude.command
        : DEFAULT_AGENT_PRESETS.claude.command,
    },
    codex: {
      command: typeof raw?.codex?.command === 'string'
        ? raw.codex.command
        : DEFAULT_AGENT_PRESETS.codex.command,
    },
  };
}

export const S = {
  ws: null,
  connected: false,
  terminals: new Map(),       // ALL terminals across workspaces
  activeTerminalId: null,
  linkMode: false,
  linkSource: null,
  agentPresets: normalizeAgentPresets(),
  // Workspaces
  workspaces: [],             // [{ id, name, terminalIds, links, layout }]
  activeWorkspaceId: null,
  nextWorkspaceId: 2,
  // Browser
  browserOpen: false,
  browserTabs: [],
  activeBrowserTab: 0,
  browserWidth: 0.35,
  nextBrowserTabId: 1,
};

export function activeWs() { return S.workspaces.find(w => w.id === S.activeWorkspaceId) || null; }
export function nextTermName() { const ws = activeWs(); return `Terminal ${(ws?.terminalIds.length || 0) + 1}`; }
export function wsTerminals(ws) { return (ws?.terminalIds || []).map(id => S.terminals.get(id)).filter(Boolean); }
export function wsLinks(ws) { return ws?.links || []; }

export function persistWorkspaces() {
  send('workspace:update', {
    workspaces: S.workspaces,
    activeWorkspaceId: S.activeWorkspaceId,
    nextWorkspaceId: S.nextWorkspaceId,
  });
}

export function persistSettings() {
  send('settings:update', {
    agentPresets: S.agentPresets,
  });
}
