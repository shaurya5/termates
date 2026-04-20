#!/usr/bin/env node

import { spawn } from 'child_process';
import process from 'process';
import { createByteLineDecoder, decodeTmuxOutputValue } from './tmux-control-protocol.js';

const [tmuxBin, socketPath, confPath, sessionName] = process.argv.slice(2);

if (!tmuxBin || !socketPath || !confPath || !sessionName) {
  process.stderr.write('usage: tmux-control-client.js <tmux-bin> <socket> <conf> <session>\n');
  process.exit(64);
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

const tmux = spawn(tmuxBin, ['-C', '-S', socketPath, '-f', confPath, 'attach-session', '-t', sessionName], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let currentCommand = null;
let currentCommandLines = [];
let activePaneId = null;
let queuedInput = [];
let waitingForCommandBlock = false;
const debugEnabled = process.env.TERMATES_DEBUG_TMUX_CONTROL === '1';

function debug(...args) {
  if (!debugEnabled) return;
  process.stderr.write(`[tmux-control] ${args.join(' ')}\n`);
}

function sendTmuxCommand(command) {
  debug('send', JSON.stringify(command));
  if (!tmux.killed) tmux.stdin.write(`${command}\n`);
}

function syncClientSize() {
  const cols = Math.max(1, process.stdout.columns || 80);
  const rows = Math.max(1, process.stdout.rows || 24);
  sendTmuxCommand(`refresh-client -C ${cols}x${rows}`);
}

function queueCommand(type, command) {
  currentCommand = type;
  currentCommandLines = [];
  waitingForCommandBlock = true;
  sendTmuxCommand(command);
}

function flushQueuedInput() {
  if (!activePaneId || !queuedInput.length) return;
  for (const chunk of queuedInput) sendInputChunk(chunk);
  queuedInput = [];
}

function sendInputChunk(chunk) {
  if (!activePaneId || !chunk?.length) return;
  const hexBytes = [];
  for (const byte of chunk.values()) hexBytes.push(byte.toString(16).padStart(2, '0'));
  if (!hexBytes.length) return;
  sendTmuxCommand(`send-keys -H -t ${activePaneId} ${hexBytes.join(' ')}`);
}

function handleCommandResult() {
  if (currentCommand === 'pane-id') {
    const nextPane = currentCommandLines.find(Boolean)?.trim();
    if (nextPane) {
      activePaneId = nextPane;
      syncClientSize();
      queueCommand('capture-pane', `capture-pane -p -e -S - -t ${activePaneId}`);
      flushQueuedInput();
      return;
    }
  }

  if (currentCommand === 'capture-pane' && currentCommandLines.length) {
    const text = currentCommandLines.join('\r\n');
    debug('capture-bytes', String(Buffer.byteLength(text)));
    if (text) process.stdout.write(text);
  }

  currentCommand = null;
  currentCommandLines = [];
  flushQueuedInput();
}

function handleControlLine(lineBytes) {
  const line = lineBytes.toString('utf8');
  debug('recv', JSON.stringify(line));
  if (line.startsWith('%begin ')) {
    waitingForCommandBlock = false;
    currentCommandLines = [];
    return;
  }

  if (line.startsWith('%end ') || line.startsWith('%error ')) {
    handleCommandResult();
    return;
  }

  if (lineBytes.subarray(0, 8).equals(Buffer.from('%output '))) {
    const paneIdEnd = lineBytes.indexOf(0x20, 8);
    const paneId = (paneIdEnd === -1 ? lineBytes.subarray(8) : lineBytes.subarray(8, paneIdEnd)).toString('utf8');
    if (activePaneId && paneId !== activePaneId) return;
    const valueBytes = paneIdEnd === -1 ? Buffer.alloc(0) : lineBytes.subarray(paneIdEnd + 1);
    process.stdout.write(decodeTmuxOutputValue(valueBytes));
    return;
  }

  if (line.startsWith('%session-changed ')) {
    if (!activePaneId && !currentCommand) {
      queueCommand('pane-id', `display-message -p -t ${sessionName} '#{pane_id}'`);
    }
    return;
  }

  if (line.startsWith('%exit')) {
    process.exit(0);
  }

  if (currentCommand) {
    currentCommandLines.push(line);
    return;
  }

  if (line.startsWith('%')) {
    return;
  }
}

const stdoutLines = createByteLineDecoder(handleControlLine);

tmux.stdout.on('data', (chunk) => {
  stdoutLines.push(chunk);
});

tmux.stdout.on('end', () => {
  stdoutLines.end();
});

tmux.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  if (!text.trim()) return;
  process.stderr.write(text);
});

tmux.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

process.stdin.on('data', (chunk) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (!activePaneId || waitingForCommandBlock || currentCommand === 'pane-id') {
    queuedInput.push(buffer);
    return;
  }
  sendInputChunk(buffer);
});

process.stdout.on('resize', () => {
  if (activePaneId) syncClientSize();
});
