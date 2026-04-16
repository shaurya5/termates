import { describe, expect, it } from 'vitest';
import {
  reconcileWorkspacesWithTerminals,
  removeTerminalFromWorkspaceState,
} from '../../src/client/workspace-state.js';

function leaf(id) {
  return { type: 'leaf', panelId: id };
}

function split(left, right, direction = 'horizontal', ratio = 0.5) {
  return { type: 'split', direction, ratio, children: [left, right] };
}

function workspace(overrides = {}) {
  return {
    id: 'w1',
    name: 'Workspace 1',
    terminalIds: [],
    links: [],
    layout: null,
    ...overrides,
  };
}

describe('removeTerminalFromWorkspaceState()', () => {
  it('collapses the existing layout instead of rebuilding a new balanced tree', () => {
    const workspaces = [workspace({
      terminalIds: ['t1', 't2', 't3'],
      links: [{ from: 't1', to: 't2' }, { from: 't1', to: 't3' }],
      layout: split(split(leaf('t1'), leaf('t2'), 'vertical', 0.3), leaf('t3'), 'horizontal', 0.7),
    })];

    const next = removeTerminalFromWorkspaceState(workspaces, 't2');

    expect(next[0].terminalIds).toEqual(['t1', 't3']);
    expect(next[0].links).toEqual([{ from: 't1', to: 't3' }]);
    expect(next[0].layout).toEqual(split(leaf('t1'), leaf('t3'), 'horizontal', 0.7));
  });

  it('clears the layout when the workspace becomes empty', () => {
    const next = removeTerminalFromWorkspaceState([
      workspace({ terminalIds: ['t1'], layout: leaf('t1') }),
    ], 't1');

    expect(next[0].terminalIds).toEqual([]);
    expect(next[0].layout).toBeNull();
  });
});

describe('reconcileWorkspacesWithTerminals()', () => {
  it('preserves a saved layout on restore when all panels still exist', () => {
    const savedLayout = split(leaf('t1'), leaf('t2'), 'vertical', 0.38);
    const next = reconcileWorkspacesWithTerminals([
      workspace({
        terminalIds: ['t1', 't2'],
        layout: savedLayout,
      }),
    ], [{ id: 't1' }, { id: 't2' }], 'w1');

    expect(next[0].layout).toEqual(savedLayout);
  });

  it('prunes missing terminals from saved layouts instead of discarding the whole tree', () => {
    const next = reconcileWorkspacesWithTerminals([
      workspace({
        terminalIds: ['t1', 't2', 't3'],
        links: [{ from: 't1', to: 't2' }, { from: 't2', to: 't3' }],
        layout: split(split(leaf('t1'), leaf('t2'), 'vertical', 0.25), leaf('t3'), 'horizontal', 0.6),
      }),
    ], [{ id: 't1' }, { id: 't3' }], 'w1');

    expect(next[0].terminalIds).toEqual(['t1', 't3']);
    expect(next[0].links).toEqual([]);
    expect(next[0].layout).toEqual(split(leaf('t1'), leaf('t3'), 'horizontal', 0.6));
  });

  it('assigns orphaned terminals to the active workspace', () => {
    const next = reconcileWorkspacesWithTerminals([
      workspace({ id: 'w1', terminalIds: ['t1'], layout: leaf('t1') }),
      workspace({ id: 'w2', terminalIds: [], layout: null }),
    ], [{ id: 't1' }, { id: 't2' }], 'w2');

    expect(next[1].terminalIds).toEqual(['t2']);
    expect(next[1].layout).toEqual(leaf('t2'));
  });
});
