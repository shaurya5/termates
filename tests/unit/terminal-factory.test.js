import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { S: { terminals: new Map() } };
  const terminals = [];

  class FakeElement {
    constructor() {
      this._listeners = new Map();
    }

    addEventListener(type, listener, options) {
      const capture = options === true || !!options?.capture;
      this._listeners.set(`${type}:${capture}`, listener);
    }

    removeEventListener(type, listener, options) {
      const capture = options === true || !!options?.capture;
      const key = `${type}:${capture}`;
      if (this._listeners.get(key) === listener) this._listeners.delete(key);
    }

    dispatchWheel(ev) {
      const listener = this._listeners.get('wheel:true');
      if (listener) listener(ev);
    }
  }

  return {
    state,
    send: vi.fn(),
    terminals,
    FakeElement,
  };
});

vi.mock('../../src/client/state.js', () => mocks.state);
vi.mock('../../src/client/transport.js', () => ({ send: mocks.send }));
vi.mock('xterm', () => ({
  Terminal: class FakeTerminal {
    constructor(options) {
      this.options = options;
      this.rows = 24;
      this.cols = 80;
      this.buffer = { active: { baseY: 0 } };
      this.element = null;
      this.write = vi.fn();
      this.refresh = vi.fn();
      this.clear = vi.fn();
      this.dispose = vi.fn();
      mocks.terminals.push(this);
    }

    loadAddon() {}
    onScroll() {}
    onData(handler) { this._dataHandler = handler; }
    attachCustomKeyEventHandler(handler) { this._keyHandler = handler; }

    open() {
      this.element = new mocks.FakeElement();
    }
  },
}));
vi.mock('xterm-addon-fit', () => ({
  FitAddon: class FakeFitAddon {
    fit() {}
  },
}));
vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: class FakeWebLinksAddon {},
}));

import { createXterm, xtermFontFamily } from '../../src/client/terminal-factory.js';

describe('terminal factory wheel guard', () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.state.S.terminals = new Map();
    mocks.terminals.length = 0;
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'MacIntel', userAgent: 'Mac' },
      configurable: true,
    });
  });

  function createWheelEvent() {
    return {
      deltaY: 120,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
  }

  it('blocks synthetic wheel-to-history fallback when a shell pane has no scrollback', () => {
    mocks.state.S.terminals.set('t1', { inTui: false });

    const { xterm } = createXterm('t1');
    xterm.open({});

    const ev = createWheelEvent();
    xterm.element.dispatchWheel(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(ev.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('allows normal viewport scrolling once local scrollback exists', () => {
    mocks.state.S.terminals.set('t2', { inTui: false });

    const { xterm } = createXterm('t2');
    xterm.buffer.active.baseY = 8;
    xterm.open({});

    const ev = createWheelEvent();
    xterm.element.dispatchWheel(ev);

    expect(ev.defaultPrevented).toBe(false);
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(ev.stopPropagation).not.toHaveBeenCalled();
  });

  it('keeps wheel passthrough enabled for TUI panes even without local scrollback', () => {
    mocks.state.S.terminals.set('t3', { inTui: true });

    const { xterm } = createXterm('t3');
    xterm.open({});

    const ev = createWheelEvent();
    xterm.element.dispatchWheel(ev);

    expect(ev.defaultPrevented).toBe(false);
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(ev.stopPropagation).not.toHaveBeenCalled();
  });

  it('filters DA escape sequences before forwarding terminal input to the server', () => {
    const { xterm } = createXterm('t4');

    xterm._dataHandler('ls\x1b[c -la\n');

    expect(mocks.send).toHaveBeenCalledWith('terminal:input', {
      id: 't4',
      data: 'ls -la\n',
    });
  });

  it('drops pure DA responses instead of forwarding empty input', () => {
    const { xterm } = createXterm('t5');

    xterm._dataHandler('\x1b[?1;2c');

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('maps macOS Option and Command keybindings to shell control sequences', () => {
    const { xterm } = createXterm('t6');

    expect(xterm._keyHandler({
      type: 'keydown',
      altKey: true,
      metaKey: false,
      key: 'ArrowLeft',
    })).toBe(false);
    expect(mocks.send).toHaveBeenLastCalledWith('terminal:input', {
      id: 't6',
      data: '\x1bb',
    });

    expect(xterm._keyHandler({
      type: 'keydown',
      altKey: false,
      metaKey: true,
      key: 'ArrowRight',
    })).toBe(false);
    expect(mocks.send).toHaveBeenLastCalledWith('terminal:input', {
      id: 't6',
      data: '\x05',
    });
  });

  it('handles Cmd+K locally without sending data through tmux', () => {
    const { xterm } = createXterm('t7');

    expect(xterm._keyHandler({
      type: 'keydown',
      altKey: false,
      metaKey: true,
      key: 'k',
    })).toBe(false);

    expect(xterm.clear).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('uses a local system font stack for xterm and keeps custom glyph rendering enabled', () => {
    const { xterm } = createXterm('t8');

    expect(xterm.options.fontFamily).toBe(xtermFontFamily);
    expect(xterm.options.fontFamily).toContain("'SF Mono'");
    expect(xterm.options.fontFamily).toContain("'Menlo'");
    expect(xterm.options.fontFamily).not.toContain('JetBrains Mono');
    expect(xterm.options.customGlyphs).toBe(true);
  });
});
