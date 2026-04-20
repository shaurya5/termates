import { describe, it, expect } from 'vitest';
import { TMUX_CONF_CONTENT } from '../../server/pty-manager.js';

// ---------------------------------------------------------------------------
// Tests for the tmux configuration string exported by pty-manager.js.
// These settings are critical for the transparent-tmux experience:
//   - no status bar so it's invisible to the user
//   - shell panes keep mouse off by default
//   - focus events are forwarded to TUIs
//   - no escape delay so Vim / readline feel snappy
//   - tmux advertises its real terminal type to pane processes
//   - outer-terminal scrollback stays native instead of dropping into tmux
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

    it('keeps mouse off by default so shell panes behave like a normal terminal', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g mouse off');
    });

    it('enables focus events for full-screen TUIs', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g focus-events on');
    });

    it('removes escape delay with "set -g escape-time 0"', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g escape-time 0');
    });

    it('sets a large scrollback buffer with "set -g history-limit 50000"', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g history-limit 50000');
    });

    it('uses tmux-256color inside tmux panes', () => {
      expect(TMUX_CONF_CONTENT).toContain('set -g default-terminal "tmux-256color"');
    });

    it('preserves the outer terminal scrollback by disabling tmux alternate-screen switching', () => {
      expect(TMUX_CONF_CONTENT).toContain('smcup@');
      expect(TMUX_CONF_CONTENT).toContain('rmcup@');
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
