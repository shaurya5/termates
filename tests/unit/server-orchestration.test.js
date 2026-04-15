/**
 * Unit tests for the server orchestration logic in server/index.js.
 *
 * These functions sit between the managers and coordinate state changes.
 * When they break, the *combination* of state across managers gets
 * inconsistent — terminals exist but don't appear in workspaces, layouts
 * have ghost panel IDs, links survive terminal deletion, etc.
 *
 * Since these functions are not exported from index.js, we re-implement
 * them here identically (same pattern as layout-pruning.test.js for the
 * client code). The test verifies the ALGORITHM, not the import path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LinkManager } from '../../server/link-manager.js';

// ---------------------------------------------------------------------------
// Re-implement the server orchestration functions exactly as in index.js
// ---------------------------------------------------------------------------

/**
 * Remove a layout leaf by terminal ID (from server/index.js:67-79).
 * When a split loses one child, it collapses to the remaining child.
 */
function removeLayoutLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'leaf') return node.panelId === id ? null : node;
  if (node.type === 'split') {
    const l = removeLayoutLeaf(node.children[0], id);
    const r = removeLayoutLeaf(node.children[1], id);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...node, children: [l, r] };
  }
  return node;
}

/**
 * Remove a terminal from all workspaces (from server/index.js:53-65).
 */
function removeTerminalFromWorkspaces(workspaces, terminalId) {
  for (const ws of workspaces) {
    ws.terminalIds = ws.terminalIds.filter(id => id !== terminalId);
    ws.links = (ws.links || []).filter(l => l.from !== terminalId && l.to !== terminalId);
    if (ws.layout) {
      ws.layout = removeLayoutLeaf(ws.layout, terminalId);
    }
    if (ws.terminalIds.length === 0) ws.layout = null;
  }
  return workspaces;
}

/**
 * Add a terminal to the active workspace (from server/index.js:43-51).
 */
function addTerminalToWorkspace(workspaces, activeWorkspaceId, terminalId) {
  const wsId = activeWorkspaceId || workspaces[0]?.id;
  const ws = workspaces.find(w => w.id === wsId);
  if (ws && !ws.terminalIds.includes(terminalId)) {
    ws.terminalIds.push(terminalId);
  }
  return workspaces;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function leaf(id) { return { type: 'leaf', panelId: id }; }
function split(left, right, dir = 'horizontal', ratio = 0.5) {
  return { type: 'split', direction: dir, ratio, children: [left, right] };
}

function makeWorkspace(overrides = {}) {
  return {
    id: 'w1',
    name: 'Workspace 1',
    terminalIds: [],
    links: [],
    layout: null,
    type: 'local',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// removeLayoutLeaf (server-side version)
// ---------------------------------------------------------------------------

describe('removeLayoutLeaf() [server-side]', () => {
  it('returns null for null layout', () => {
    expect(removeLayoutLeaf(null, 't1')).toBeNull();
  });

  it('returns null when removing the only leaf', () => {
    expect(removeLayoutLeaf(leaf('t1'), 't1')).toBeNull();
  });

  it('returns the leaf unchanged when removing a different ID', () => {
    expect(removeLayoutLeaf(leaf('t1'), 't99')).toEqual(leaf('t1'));
  });

  it('collapses split to surviving child when left is removed', () => {
    const layout = split(leaf('t1'), leaf('t2'));
    expect(removeLayoutLeaf(layout, 't1')).toEqual(leaf('t2'));
  });

  it('collapses split to surviving child when right is removed', () => {
    const layout = split(leaf('t1'), leaf('t2'));
    expect(removeLayoutLeaf(layout, 't2')).toEqual(leaf('t1'));
  });

  it('handles nested removal with collapse', () => {
    //   root(split)
    //   /          \
    // inner(split)  t3
    //  /     \
    // t1      t2 <- remove
    const inner = split(leaf('t1'), leaf('t2'));
    const root = split(inner, leaf('t3'));
    const result = removeLayoutLeaf(root, 't2');

    // inner collapses to t1, root becomes split(t1, t3)
    expect(result.type).toBe('split');
    expect(result.children[0]).toEqual(leaf('t1'));
    expect(result.children[1]).toEqual(leaf('t3'));
  });

  it('returns null when all leaves in a nested tree are removed sequentially', () => {
    let layout = split(leaf('t1'), leaf('t2'));
    layout = removeLayoutLeaf(layout, 't1');
    layout = removeLayoutLeaf(layout, 't2');
    expect(layout).toBeNull();
  });

  it('preserves direction and ratio on surviving split', () => {
    const inner = split(leaf('t1'), leaf('t2'), 'vertical', 0.3);
    const root = split(inner, leaf('t3'), 'horizontal', 0.7);
    const result = removeLayoutLeaf(root, 't2');
    // root survives with its original ratio
    expect(result.direction).toBe('horizontal');
    expect(result.ratio).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// removeTerminalFromWorkspaces()
// ---------------------------------------------------------------------------

describe('removeTerminalFromWorkspaces()', () => {
  it('removes terminal ID from workspace terminalIds', () => {
    const ws = [makeWorkspace({ terminalIds: ['t1', 't2', 't3'] })];
    removeTerminalFromWorkspaces(ws, 't2');
    expect(ws[0].terminalIds).toEqual(['t1', 't3']);
  });

  it('removes terminal from ALL workspaces, not just the active one', () => {
    const ws = [
      makeWorkspace({ id: 'w1', terminalIds: ['t1', 't2'] }),
      makeWorkspace({ id: 'w2', terminalIds: ['t2', 't3'] }),
    ];
    removeTerminalFromWorkspaces(ws, 't2');
    expect(ws[0].terminalIds).toEqual(['t1']);
    expect(ws[1].terminalIds).toEqual(['t3']);
  });

  it('removes links involving the terminal', () => {
    const ws = [makeWorkspace({
      terminalIds: ['t1', 't2', 't3'],
      links: [
        { from: 't1', to: 't2' },
        { from: 't2', to: 't3' },
        { from: 't1', to: 't3' },
      ],
    })];
    removeTerminalFromWorkspaces(ws, 't2');
    // Only the t1-t3 link should survive
    expect(ws[0].links).toHaveLength(1);
    expect(ws[0].links[0]).toEqual({ from: 't1', to: 't3' });
  });

  it('removes terminal from layout tree', () => {
    const ws = [makeWorkspace({
      terminalIds: ['t1', 't2'],
      layout: split(leaf('t1'), leaf('t2')),
    })];
    removeTerminalFromWorkspaces(ws, 't2');
    expect(ws[0].layout).toEqual(leaf('t1'));
  });

  it('sets layout to null when workspace has no terminals left', () => {
    const ws = [makeWorkspace({
      terminalIds: ['t1'],
      layout: leaf('t1'),
    })];
    removeTerminalFromWorkspaces(ws, 't1');
    expect(ws[0].terminalIds).toEqual([]);
    expect(ws[0].layout).toBeNull();
  });

  it('handles workspace with null layout gracefully', () => {
    const ws = [makeWorkspace({ terminalIds: ['t1'], layout: null })];
    removeTerminalFromWorkspaces(ws, 't1');
    expect(ws[0].layout).toBeNull();
  });

  it('handles workspace with empty links array', () => {
    const ws = [makeWorkspace({ terminalIds: ['t1'], links: [] })];
    removeTerminalFromWorkspaces(ws, 't1');
    expect(ws[0].links).toEqual([]);
  });

  it('handles workspace with undefined links', () => {
    const ws = [makeWorkspace({ terminalIds: ['t1'] })];
    delete ws[0].links;
    // Should not throw
    removeTerminalFromWorkspaces(ws, 't1');
    expect(ws[0].terminalIds).toEqual([]);
  });

  it('is a no-op when terminal is not in any workspace', () => {
    const ws = [makeWorkspace({ terminalIds: ['t1', 't2'] })];
    removeTerminalFromWorkspaces(ws, 't99');
    expect(ws[0].terminalIds).toEqual(['t1', 't2']);
  });
});

// ---------------------------------------------------------------------------
// addTerminalToWorkspace()
// ---------------------------------------------------------------------------

describe('addTerminalToWorkspace()', () => {
  it('adds terminal ID to active workspace', () => {
    const ws = [makeWorkspace({ id: 'w1', terminalIds: ['t1'] })];
    addTerminalToWorkspace(ws, 'w1', 't2');
    expect(ws[0].terminalIds).toEqual(['t1', 't2']);
  });

  it('does not add duplicate terminal IDs', () => {
    const ws = [makeWorkspace({ id: 'w1', terminalIds: ['t1'] })];
    addTerminalToWorkspace(ws, 'w1', 't1');
    expect(ws[0].terminalIds).toEqual(['t1']);
  });

  it('falls back to first workspace when activeWorkspaceId is null', () => {
    const ws = [
      makeWorkspace({ id: 'w1', terminalIds: [] }),
      makeWorkspace({ id: 'w2', terminalIds: [] }),
    ];
    addTerminalToWorkspace(ws, null, 't1');
    expect(ws[0].terminalIds).toEqual(['t1']);
    expect(ws[1].terminalIds).toEqual([]);
  });

  it('adds to correct workspace when multiple exist', () => {
    const ws = [
      makeWorkspace({ id: 'w1', terminalIds: [] }),
      makeWorkspace({ id: 'w2', terminalIds: [] }),
    ];
    addTerminalToWorkspace(ws, 'w2', 't1');
    expect(ws[0].terminalIds).toEqual([]);
    expect(ws[1].terminalIds).toEqual(['t1']);
  });

  it('is a no-op when workspace not found', () => {
    const ws = [makeWorkspace({ id: 'w1', terminalIds: [] })];
    addTerminalToWorkspace(ws, 'w999', 't1');
    expect(ws[0].terminalIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cleanupDeadTerminal integration scenario
// ---------------------------------------------------------------------------

describe('cleanup dead terminal scenario', () => {
  it('full cleanup: link removal + workspace removal + layout collapse', () => {
    // Simulate what cleanupDeadTerminal() does when a terminal dies:
    // 1. linkManager.removeTerminal(id)
    // 2. removeTerminalFromWorkspaces(id)
    // 3. ptyManager.destroy(id) [we skip this, tested elsewhere]

    const linkManager = new LinkManager();
    linkManager.link('t1', 't2');
    linkManager.link('t2', 't3');
    linkManager.link('t1', 't3');

    const workspaces = [makeWorkspace({
      terminalIds: ['t1', 't2', 't3'],
      links: [
        { from: 't1', to: 't2' },
        { from: 't2', to: 't3' },
        { from: 't1', to: 't3' },
      ],
      layout: split(split(leaf('t1'), leaf('t2')), leaf('t3')),
    })];

    // Terminal t2 dies
    linkManager.removeTerminal('t2');
    removeTerminalFromWorkspaces(workspaces, 't2');

    // LinkManager should have removed t1-t2 and t2-t3, keeping t1-t3
    expect(linkManager.areLinked('t1', 't2')).toBe(false);
    expect(linkManager.areLinked('t2', 't3')).toBe(false);
    expect(linkManager.areLinked('t1', 't3')).toBe(true);

    // Workspace should reflect removal
    expect(workspaces[0].terminalIds).toEqual(['t1', 't3']);
    expect(workspaces[0].links).toHaveLength(1);
    expect(workspaces[0].links[0]).toEqual({ from: 't1', to: 't3' });

    // Layout should collapse: split(split(t1,t2),t3) → split(t1,t3)
    expect(workspaces[0].layout.type).toBe('split');
    expect(workspaces[0].layout.children[0]).toEqual(leaf('t1'));
    expect(workspaces[0].layout.children[1]).toEqual(leaf('t3'));
  });

  it('cleaning up the last terminal in a workspace nullifies layout', () => {
    const linkManager = new LinkManager();
    const workspaces = [makeWorkspace({
      terminalIds: ['t1'],
      layout: leaf('t1'),
    })];

    linkManager.removeTerminal('t1');
    removeTerminalFromWorkspaces(workspaces, 't1');

    expect(workspaces[0].terminalIds).toEqual([]);
    expect(workspaces[0].layout).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// terminal:destroy should clean up links in workspace state
// ---------------------------------------------------------------------------

describe('terminal:destroy link cleanup scenario', () => {
  it('destroying a linked terminal removes link from both managers', () => {
    // This tests the exact sequence from handleWsMessage terminal:destroy:
    //   1. getLinksFor(id) - get links to broadcast
    //   2. ptyManager.destroy(id)
    //   3. linkManager.removeTerminal(id)
    //   4. removeTerminalFromWorkspaces(id)

    const linkManager = new LinkManager();
    linkManager.link('t1', 't2');
    linkManager.link('t1', 't3');

    // Step 1: Get links for broadcast
    const removedLinks = linkManager.getLinksFor('t1');
    expect(removedLinks).toHaveLength(2);

    // Step 2: destroy (tested in pty-manager tests)

    // Step 3: Clean up in LinkManager
    linkManager.removeTerminal('t1');

    // Step 4: Clean up in workspaces
    const workspaces = [makeWorkspace({
      terminalIds: ['t1', 't2', 't3'],
      links: [{ from: 't1', to: 't2' }, { from: 't1', to: 't3' }],
    })];
    removeTerminalFromWorkspaces(workspaces, 't1');

    // Verify complete cleanup
    expect(linkManager.areLinked('t1', 't2')).toBe(false);
    expect(linkManager.areLinked('t1', 't3')).toBe(false);
    expect(linkManager.getLinkedTerminals('t1')).toEqual([]);
    expect(workspaces[0].terminalIds).toEqual(['t2', 't3']);
    expect(workspaces[0].links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DA filter in terminal:input handler
// ---------------------------------------------------------------------------

describe('terminal:input DA filtering (server-side)', () => {
  // The server applies: payload.data.replace(/\x1b\[[\?>]?[\d;]*c/g, '')
  const DA_REGEX = /\x1b\[[\?>]?[\d;]*c/g;
  const filter = (data) => data.replace(DA_REGEX, '');

  it('strips DA query from otherwise normal input', () => {
    expect(filter('ls\x1b[c -la\n')).toBe('ls -la\n');
  });

  it('passes through normal text unchanged', () => {
    expect(filter('echo hello\n')).toBe('echo hello\n');
  });

  it('empty string after stripping results in no write', () => {
    const clean = filter('\x1b[c');
    expect(clean).toBe('');
    // The server checks: if (clean) ptyManager.write(...)
    // So an empty string means no write happens
    expect(!clean).toBe(true);
  });
});
