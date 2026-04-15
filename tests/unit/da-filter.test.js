import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// The DA (Device Attributes) escape sequence filter regex used by both
// server and client to strip terminal identification sequences that would
// otherwise leak between linked terminals or confuse shell prompts.
//
// Regex: /\x1b\[[\?>]?[\d;]*c/g
//
// Matches:
//   \x1b[    ESC [
//   [?>]?    optional ? or > (DA1 / DA2 / VT response prefixes)
//   [\d;]*   optional decimal digits and semicolons (parameters)
//   c        terminating 'c' byte
// ---------------------------------------------------------------------------

const DA_REGEX = /\x1b\[[\?>]?[\d;]*c/g;

function strip(input) {
  return input.replace(DA_REGEX, '');
}

describe('DA escape sequence filter regex', () => {

  // -------------------------------------------------------------------------
  // Sequences that SHOULD be stripped
  // -------------------------------------------------------------------------

  describe('strips DA sequences', () => {
    it('strips \\x1b[c (bare DA1 query, no parameters)', () => {
      expect(strip('\x1b[c')).toBe('');
    });

    it('strips \\x1b[>c (DA2 query with > prefix)', () => {
      expect(strip('\x1b[>c')).toBe('');
    });

    it('strips \\x1b[?1;2c (DA1 response with ? prefix and params)', () => {
      expect(strip('\x1b[?1;2c')).toBe('');
    });

    it('strips \\x1b[>0;276;0c (DA2 response with > prefix and multiple params)', () => {
      expect(strip('\x1b[>0;276;0c')).toBe('');
    });

    it('strips \\x1b[?62;1;2;4c (extended DA response with many params)', () => {
      expect(strip('\x1b[?62;1;2;4c')).toBe('');
    });

    it('strips \\x1b[0c (DA1 with single zero parameter)', () => {
      expect(strip('\x1b[0c')).toBe('');
    });

    it('strips multiple DA sequences in a single string', () => {
      const input = '\x1b[>c hello \x1b[?1;2c world \x1b[0c';
      expect(strip(input)).toBe(' hello  world ');
    });

    it('strips DA sequence embedded inside other text', () => {
      const input = 'before\x1b[>0;276;0cafter';
      expect(strip(input)).toBe('beforeafter');
    });
  });

  // -------------------------------------------------------------------------
  // Sequences that should NOT be stripped
  // -------------------------------------------------------------------------

  describe('does NOT strip non-DA sequences', () => {
    it('does not strip \\x1b[32m (color code — "m" terminator, not "c")', () => {
      expect(strip('\x1b[32m')).toBe('\x1b[32m');
    });

    it('does not strip \\x1b[0m (SGR reset)', () => {
      expect(strip('\x1b[0m')).toBe('\x1b[0m');
    });

    it('does not strip \\x1b[H (cursor home — no digits, "H" terminator)', () => {
      expect(strip('\x1b[H')).toBe('\x1b[H');
    });

    it('does not strip regular text "hello world"', () => {
      expect(strip('hello world')).toBe('hello world');
    });

    it('leaves empty string unchanged', () => {
      expect(strip('')).toBe('');
    });

    it('preserves a colored string intact: \\x1b[32mgreen\\x1b[0m', () => {
      const input = '\x1b[32mgreen\x1b[0m';
      expect(strip(input)).toBe('\x1b[32mgreen\x1b[0m');
    });

    it('preserves \\x1b[1;32m (bold green — semicolon param with "m" terminator)', () => {
      expect(strip('\x1b[1;32m')).toBe('\x1b[1;32m');
    });

    it('preserves \\x1b[2J (clear screen — digits with "J" terminator)', () => {
      expect(strip('\x1b[2J')).toBe('\x1b[2J');
    });

    it('preserves \\x1b[?25h (show cursor — ? prefix with "h" terminator)', () => {
      expect(strip('\x1b[?25h')).toBe('\x1b[?25h');
    });
  });

  // -------------------------------------------------------------------------
  // Mixed content: DA + valid sequences together
  // -------------------------------------------------------------------------

  describe('mixed content', () => {
    it('strips only DA sequences and leaves ANSI colour codes intact', () => {
      const input = '\x1b[32mgreen\x1b[0m\x1b[>0;276;0c text \x1b[?1;2c more';
      const result = strip(input);
      expect(result).toBe('\x1b[32mgreen\x1b[0m text  more');
    });

    it('strips DA sequences between cursor movement codes without corrupting them', () => {
      const input = '\x1b[1;1H\x1b[0c\x1b[2J';
      const result = strip(input);
      expect(result).toBe('\x1b[1;1H\x1b[2J');
    });

    it('handles a string that contains only non-DA escape sequences untouched', () => {
      const input = '\x1b[31mred\x1b[0m \x1b[1mbold\x1b[0m';
      expect(strip(input)).toBe(input);
    });
  });
});
