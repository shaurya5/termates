export function decodeTmuxOutputValue(valueBytes) {
  const source = Buffer.isBuffer(valueBytes) ? valueBytes : Buffer.from(valueBytes || []);
  const bytes = [];

  for (let i = 0; i < source.length; i += 1) {
    const byte = source[i];
    if (
      byte === 0x5c
      && i + 3 < source.length
      && source[i + 1] >= 0x30 && source[i + 1] <= 0x37
      && source[i + 2] >= 0x30 && source[i + 2] <= 0x37
      && source[i + 3] >= 0x30 && source[i + 3] <= 0x37
    ) {
      bytes.push(parseInt(String.fromCharCode(source[i + 1], source[i + 2], source[i + 3]), 8));
      i += 3;
      continue;
    }
    bytes.push(byte);
  }

  return Buffer.from(bytes);
}

export function createByteLineDecoder(onLine) {
  let buffer = Buffer.alloc(0);

  function emitAvailableLines() {
    while (true) {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex === -1) break;
      let line = buffer.subarray(0, newlineIndex);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      onLine(Buffer.from(line));
      buffer = buffer.subarray(newlineIndex + 1);
    }
  }

  return {
    push(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      if (!next.length) return;
      buffer = buffer.length ? Buffer.concat([buffer, next]) : Buffer.from(next);
      emitAvailableLines();
    },
    end(chunk) {
      if (chunk?.length) this.push(chunk);
      if (!buffer.length) return;
      let line = buffer;
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      onLine(Buffer.from(line));
      buffer = Buffer.alloc(0);
    },
  };
}
