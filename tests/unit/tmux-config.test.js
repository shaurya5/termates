import { describe, it, expect } from 'vitest';
import { TMUX_CONF_CONTENT } from '../../server/pty-manager.js';

// ---------------------------------------------------------------------------
// Tests for the tmux configuration string exported by pty-manager.js.
// These settings are critical for the transparent-tmux experience:
//   - no status bar so it's invisible to the user
//   - mouse passthrough for click/scroll
//   - no escape delay so Vim / readline feel snappy
//   - right-click unbinds so context menus don't appear inside tmux
//   - large scrollback buffer
// ---------------------------------------------------------------------------

describe('TMUX_CONF_CONTENT', () => {
  it('is a non-empty string', () => {
    expect(typeof TMUX_CONF_CONTENT).toBe('string');
    expect(TMUX_CONF_CONTENT.length).toBeGreaterThan(0);
  });

  describe('required settings', () => {
    it('disables the status bar with "set -g status off"', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g status off');
    });

    it('enables mouse support with "set -g mouse on"', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g mouse on');
    });

    it('removes escape delay with "set -g escape-time 0"', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g escape-time 0');
    });

    it('unbinds right-click on pane with "unbind -n MouseDown3Pane"', () => {
      expect(TMUX_CONF_CONTENT).toContain('unbind -n MouseDown3Pane');
    });

    it('unbinds right-click on status bar with "unbind -n MouseDown3Status"', () => {
      expect(TMUX_CONF_CONTENT).toContain('unbind -n MouseDown3Status');
    });

    it('sets a large scrollback buffer with "set -g history-limit 50000"', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g history-limit 50000');
    });
  });

  describe('setting values are correct', () => {
    it('status is "off" (not "on")', () => {
      // Make sure we didn't accidentally write "set -g status on"
      const lines = TMUX_CONF_CONTENT.split('\n');
      const statusLine = lines.find(l => /^set -g status\b/.test(l.trim()));
      expect(statusLine).toBeDefined();
      expect(statusLine.trim()).toBe('set -g status off');
    });

    it('escape-time is 0 (not a positive value that would add latency)', () => {
      const lines = TMUX_CONF_CONTENT.split('\n');
      const escapeLine = lines.find(l => /set -g escape-time/.test(l));
      expect(escapeLine).toBeDefined();
      // Extract the numeric value
      const match = escapeLine.match(/set -g escape-time\s+(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBe(0);
    });

    it('history-limit is at least 50000', () => {
      const match = TMUX_CONF_CONTENT.match(/set -g history-limit\s+(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBeGreaterThanOrEqual(50000);
    });
  });
});
