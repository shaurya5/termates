// ============================================
// Terminal Factory
// ============================================

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { S } from './state.js';
import { send } from './transport.js';

export const xtermFontFamily = "'SF Mono','Menlo','Monaco','Cascadia Mono','Cascadia Code','Consolas','Liberation Mono',monospace";

export const xtermTheme = {
  background: '#09090b', foreground: '#fafafa', cursor: '#2dd4bf', cursorAccent: '#09090b',
  selectionBackground: 'rgba(45, 212, 191, 0.25)',
  black: '#3f3f46', red: '#f87171', green: '#4ade80', yellow: '#facc15',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#fafafa',
  brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

function installWheelGuard(xterm, id) {
  let wheelTarget = null;

  const onWheel = (ev) => {
    if (!ev || ev.defaultPrevented || !Number.isFinite(ev.deltaY) || ev.deltaY === 0) return;
    const terminal = S.terminals.get(id);
    const inTui = !!terminal?.inTui;
    const hasScrollback = Number(xterm?.buffer?.active?.baseY || 0) > 0;

    // xterm turns wheel into Up/Down keypresses when there is no local
    // scrollback. That's useful for true full-screen TUIs, but in normal shell
    // panes it makes the wheel walk readline history instead of doing nothing.
    if (!inTui && !hasScrollback) {
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopImmediatePropagation?.(); } catch (e) {}
      try { ev.stopPropagation?.(); } catch (e) {}
    }
  };

  const attach = () => {
    const el = xterm.element;
    if (!el || el === wheelTarget) return;
    if (wheelTarget) {
      try { wheelTarget.removeEventListener('wheel', onWheel, true); } catch (e) {}
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    wheelTarget = el;
  };

  const detach = () => {
    if (!wheelTarget) return;
    try { wheelTarget.removeEventListener('wheel', onWheel, true); } catch (e) {}
    wheelTarget = null;
  };

  const originalOpen = xterm.open.bind(xterm);
  xterm.open = (...args) => {
    const result = originalOpen(...args);
    attach();
    return result;
  };

  const originalDispose = xterm.dispose?.bind(xterm);
  if (originalDispose) {
    xterm.dispose = (...args) => {
      detach();
      return originalDispose(...args);
    };
  }
}

export function createXterm(id) {
  const nav = globalThis.navigator;
  const isMac = !!(nav?.platform?.includes('Mac') || nav?.userAgent?.includes('Mac'));
  const xterm = new Terminal({
    // Prefer local system monospace fonts here. Web fonts can look nicer in
    // static UI, but xterm's renderer is far less reliable with glyph fallback,
    // which shows up immediately in Claude/Codex block and box drawing.
    fontFamily: xtermFontFamily,
    fontSize: 13, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar',
    scrollback: 10000,
    theme: xtermTheme, allowProposedApi: true, customGlyphs: true,
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
  });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
  installWheelGuard(xterm, id);

  // Force a repaint on scroll. Without this, xterm intermittently leaves
  // some rows unpainted when scrolling through deep scrollback (rows are in
  // the buffer — you can select-drag to see them — but aren't drawn).
  // Coalesce to one refresh per frame so we don't pile up work on programmatic
  // scrolls during heavy streaming output.
  let _scrollRefreshPending = false;
  xterm.onScroll(() => {
    if (_scrollRefreshPending) return;
    _scrollRefreshPending = true;
    requestAnimationFrame(() => {
      _scrollRefreshPending = false;
      try { xterm.refresh(0, xterm.rows - 1); } catch (e) {}
    });
  });

  // Mac keybindings — handle everything explicitly to avoid tmux conflicts
  if (isMac) {
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      // --- Option (Alt) combos ---
      // Option+Left: move cursor back one word
      if (ev.altKey && !ev.metaKey && ev.key === 'ArrowLeft') {
        send('terminal:input', { id, data: '\x1bb' });
        return false;
      }
      // Option+Right: move cursor forward one word
      if (ev.altKey && !ev.metaKey && ev.key === 'ArrowRight') {
        send('terminal:input', { id, data: '\x1bf' });
        return false;
      }
      // Option+Backspace: delete word backward
      if (ev.altKey && !ev.metaKey && ev.key === 'Backspace') {
        send('terminal:input', { id, data: '\x17' });
        return false;
      }
      // Option+Delete: delete word forward
      if (ev.altKey && !ev.metaKey && ev.key === 'Delete') {
        send('terminal:input', { id, data: '\x1bd' });
        return false;
      }
      // --- Cmd combos ---
      // Cmd+Left: go to beginning of line
      if (ev.metaKey && !ev.altKey && ev.key === 'ArrowLeft') {
        send('terminal:input', { id, data: '\x01' });
        return false;
      }
      // Cmd+Right: go to end of line
      if (ev.metaKey && !ev.altKey && ev.key === 'ArrowRight') {
        send('terminal:input', { id, data: '\x05' });
        return false;
      }
      // Cmd+Backspace: kill entire line
      if (ev.metaKey && !ev.altKey && ev.key === 'Backspace') {
        send('terminal:input', { id, data: '\x15' });
        return false;
      }
      // Cmd+K: clear terminal
      if (ev.metaKey && ev.key === 'k') {
        xterm.clear();
        return false;
      }
      return true;
    });
  }

  xterm.onData((data) => {
    const filtered = data.replace(/\x1b\[[\?>]?[\d;]*c/g, '');
    if (filtered) send('terminal:input', { id, data: filtered });
  });
  return { xterm, fitAddon };
}
