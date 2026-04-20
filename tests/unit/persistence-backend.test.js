import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNoisyAbducoBinary } from '../../server/persistence-backend.js';

const tempFiles = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});

function writeTempBinary(contents) {
  const file = path.join(os.tmpdir(), `termates-abduco-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(file, contents);
  tempFiles.push(file);
  return file;
}

describe('isNoisyAbducoBinary()', () => {
  it('detects debug-built abduco binaries by their protocol trace markers', () => {
    const file = writeTempBinary(Buffer.from([
      'header',
      'client-send:',
      'client-recv:',
      'client-stdin:',
      'read_all(%d)',
      'write_all(%d)',
      'footer',
    ].join('\0')));

    expect(isNoisyAbducoBinary(file)).toBe(true);
  });

  it('ignores normal binaries that do not contain the trace markers', () => {
    const file = writeTempBinary(Buffer.from('plain-binary-without-abduco-debug'));

    expect(isNoisyAbducoBinary(file)).toBe(false);
  });
});
