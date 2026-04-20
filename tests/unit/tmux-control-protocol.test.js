import { describe, expect, it } from 'vitest';
import { createByteLineDecoder, decodeTmuxOutputValue } from '../../server/tmux-control-protocol.js';

describe('tmux control protocol helpers', () => {
  it('preserves raw non-ascii bytes across chunk boundaries without utf8 coercion', () => {
    const lines = [];
    const decoder = createByteLineDecoder((line) => lines.push(line));
    const bytes = Buffer.from('%output %1 \u2500\n', 'utf8');

    decoder.push(bytes.subarray(0, 11));
    decoder.push(bytes.subarray(11, 12));
    decoder.push(bytes.subarray(12));

    expect(lines).toEqual([Buffer.from('%output %1 \u2500', 'utf8')]);
  });

  it('does not corrupt an incomplete utf8 glyph that ends a tmux output line', () => {
    const lines = [];
    const decoder = createByteLineDecoder((line) => lines.push(line));

    decoder.push(Buffer.from([0x25, 0x6f, 0x75, 0x74, 0x70, 0x75, 0x74, 0x20, 0x25, 0x31, 0x20, 0xe2, 0x96, 0x0a]));

    expect(lines).toEqual([Buffer.from([0x25, 0x6f, 0x75, 0x74, 0x70, 0x75, 0x74, 0x20, 0x25, 0x31, 0x20, 0xe2, 0x96])]);
  });

  it('flushes a trailing unterminated line on end', () => {
    const lines = [];
    const decoder = createByteLineDecoder((line) => lines.push(line));

    decoder.push(Buffer.from('%session-changed $1'));
    decoder.end();

    expect(lines).toEqual([Buffer.from('%session-changed $1')]);
  });

  it('decodes octal escapes while preserving raw unicode bytes in tmux output', () => {
    const value = Buffer.from('\\033[31m\u2500\\033[0m', 'utf8');
    const decoded = decodeTmuxOutputValue(value);

    expect(decoded).toEqual(Buffer.from('\u001b[31m\u2500\u001b[0m', 'utf8'));
  });
});
