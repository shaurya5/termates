// ============================================
// Terminal Factory
// ============================================

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';
import { send } from './transport.js';

export const xtermTheme = {
  background: '#09090b', foreground: '#fafafa', cursor: '#2dd4bf', cursorAccent: '#09090b',
  selectionBackground: 'rgba(45, 212, 191, 0.25)',
  black: '#3f3f46', red: '#f87171', green: '#4ade80', yellow: '#facc15',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#fafafa',
  brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

export function createXterm(id) {
  const isMac = navigator.platform?.includes('Mac') || navigator.userAgent?.includes('Mac');
  const xterm = new Terminal({
    fontFamily: "'JetBrains Mono','SF Mono','Menlo','Cascadia Code','Consolas',monospace",
    fontSize: 13, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar',
    scrollback: 10000,
    theme: xtermTheme, allowProposedApi: true,
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
  });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
  xterm._webglAddon = new WebglAddon();
  xterm._webglAddon.onContextLoss(() => { xterm._webglAddon.dispose(); });

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
