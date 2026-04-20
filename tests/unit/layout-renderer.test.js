import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  updateSidebar: vi.fn(),
  showNotif: vi.fn(),
  showPresetsDialog: vi.fn(),
  showEditDialog: vi.fn(),
  refreshAgentPresetButtons: vi.fn(),
  destroyTerminalLocally: vi.fn(),
  showCreateDialog: vi.fn(),
  setActive: vi.fn(),
  isLinked: vi.fn(() => false),
  handleLinkClick: vi.fn(),
  persistWorkspaces: vi.fn(),
  nextTermName: vi.fn(() => 'Terminal 2'),
  state: {
    S: {
      terminals: new Map(),
      workspaces: [],
      activeWorkspaceId: null,
      _splitDir: null,
      _splitTarget: null,
      linkMode: false,
      agentPresets: {},
    },
    activeWs: () => null,
  },
}));

vi.mock('../../src/client/state.js', () => ({
  ...mocks.state,
  persistWorkspaces: mocks.persistWorkspaces,
  nextTermName: mocks.nextTermName,
}));
vi.mock('../../src/client/transport.js', () => ({ send: mocks.send }));
vi.mock('../../src/client/link-mode.js', () => ({
  setActive: mocks.setActive,
  isLinked: mocks.isLinked,
  handleLinkClick: mocks.handleLinkClick,
}));
vi.mock('../../src/client/dialogs.js', () => ({
  showPresetsDialog: mocks.showPresetsDialog,
  showEditDialog: mocks.showEditDialog,
  refreshAgentPresetButtons: mocks.refreshAgentPresetButtons,
  showCreateDialog: mocks.showCreateDialog,
}));
vi.mock('../../src/client/sidebar.js', () => ({ updateSidebar: mocks.updateSidebar }));
vi.mock('../../src/client/events.js', () => ({ destroyTerminalLocally: mocks.destroyTerminalLocally }));
vi.mock('../../src/client/notifications.js', () => ({ showNotif: mocks.showNotif }));

import { applyTerminalSnapshot, mountWhenSized, normalizeMountedContainer } from '../../src/client/layout/renderer.js';

describe('layout renderer mount lifecycle', () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.state.S.terminals = new Map();

    let nextFrame = 1;
    globalThis.requestAnimationFrame = vi.fn((cb) => {
      globalThis.__rafQueue.push({ id: nextFrame, cb });
      return nextFrame++;
    });
    globalThis.cancelAnimationFrame = vi.fn((id) => {
      globalThis.__rafQueue = globalThis.__rafQueue.filter((entry) => entry.id !== id);
    });
    globalThis.__rafQueue = [];
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it('opens a terminal only once even if mountWhenSized is requested repeatedly before sizing settles', () => {
    const container = {
      clientWidth: 0,
      clientHeight: 0,
      isConnected: true,
      replaceChildren: vi.fn(),
      childElementCount: 0,
      firstElementChild: null,
    };

    const xterm = {
      element: null,
      cols: 120,
      rows: 40,
      open: vi.fn(() => {
        xterm.element = { nodeName: 'DIV' };
        container.childElementCount = 1;
        container.firstElementChild = xterm.element;
      }),
      write: vi.fn((data, cb) => { if (typeof cb === 'function') cb(); }),
      refresh: vi.fn(),
    };

    const terminal = {
      xterm,
      fitAddon: { fit: vi.fn() },
      _pendingWrites: [],
    };

    mocks.state.S.terminals.set('t1', terminal);

    mountWhenSized(terminal, container, 't1');
    mountWhenSized(terminal, container, 't1');

    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(xterm.open).not.toHaveBeenCalled();

    container.clientWidth = 900;
    container.clientHeight = 600;
    globalThis.__rafQueue.shift().cb();

    expect(xterm.open).toHaveBeenCalledTimes(1);
    expect(terminal._opened).toBe(true);
    expect(terminal._opening).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenNthCalledWith(1, 'terminal:resize', { id: 't1', cols: 120, rows: 40 });
    expect(mocks.send).toHaveBeenNthCalledWith(2, 'terminal:refresh', { id: 't1' });
  });

  it('hydrates restored tmux panes from a snapshot before opening live writes', () => {
    const container = {
      clientWidth: 900,
      clientHeight: 600,
      isConnected: true,
      replaceChildren: vi.fn(),
      childElementCount: 0,
      firstElementChild: null,
    };

    const xterm = {
      element: null,
      cols: 120,
      rows: 40,
      open: vi.fn(() => {
        xterm.element = { nodeName: 'DIV' };
        container.childElementCount = 1;
        container.firstElementChild = xterm.element;
      }),
      write: vi.fn((data, cb) => { if (typeof cb === 'function') cb(); }),
      reset: vi.fn(),
      refresh: vi.fn(),
    };

    const terminal = {
      xterm,
      fitAddon: { fit: vi.fn() },
      tmuxSession: 'termates-t2',
      _pendingWrites: ['live-output'],
    };

    mocks.state.S.terminals.set('t2', terminal);

    mountWhenSized(terminal, container, 't2');

    expect(terminal._opened).not.toBe(true);
    expect(mocks.send).toHaveBeenNthCalledWith(1, 'terminal:resize', { id: 't2', cols: 120, rows: 40 });
    expect(mocks.send).toHaveBeenNthCalledWith(2, 'terminal:snapshot', { id: 't2' });

    applyTerminalSnapshot('t2', '\x1b[2JClaude');

    expect(xterm.reset).toHaveBeenCalledTimes(1);
    expect(xterm.write).toHaveBeenNthCalledWith(1, '\x1b[2JClaude', expect.any(Function));
    expect(xterm.write).toHaveBeenNthCalledWith(2, 'live-output');
    expect(terminal._opened).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('keeps only the active xterm root in the cached container', () => {
    const activeRoot = { nodeName: 'DIV' };
    const container = {
      childElementCount: 3,
      firstElementChild: { nodeName: 'STALE' },
      replaceChildren: vi.fn(),
    };

    normalizeMountedContainer({ xterm: { element: activeRoot } }, container);

    expect(container.replaceChildren).toHaveBeenCalledWith(activeRoot);
  });
});
