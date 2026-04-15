#!/usr/bin/env node

import { program } from 'commander';
import net from 'net';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = path.join(os.tmpdir(), 'termates.sock');

function sendCommand(command) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(command));
    });

    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });

    client.on('end', () => {
      try {
        const lines = data.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) {
        reject(new Error('Invalid response from server'));
      }
    });

    client.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new Error('Termates server is not running. Start it with: termates start'));
      } else {
        reject(err);
      }
    });

    client.setTimeout(10000, () => {
      client.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

program
  .name('termates')
  .description('On-device terminal multiplexer with agent linking and browser support')
  .version('1.0.0');

program
  .command('start')
  .description('Start the Termates server and open the UI')
  .option('-p, --port <port>', 'Port number', '7680')
  .action((options) => {
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    const child = spawn('node', [serverPath], {
      env: { ...process.env, PORT: options.port },
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    });
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  });

program
  .command('list')
  .alias('ls')
  .description('List all terminals and links')
  .action(async () => {
    try {
      const result = await sendCommand({ command: 'list' });
      if (!result.ok) { console.error('Error:', result.error); process.exit(1); }
      if (result.terminals.length === 0) {
        console.log('No terminals running.');
        return;
      }
      console.log('\n  Terminals:');
      for (const t of result.terminals) {
        const role = t.role ? ` [${t.role}]` : '';
        const status = t.status !== 'idle' ? ` (${t.status})` : '';
        console.log(`    ${t.id}  ${t.name}${role}${status}`);
      }
      if (result.links?.length > 0) {
        console.log('\n  Links:');
        for (const l of result.links) {
          const from = result.terminals.find(t => t.id === l.from);
          const to = result.terminals.find(t => t.id === l.to);
          console.log(`    ${from?.name || l.from} <-> ${to?.name || l.to}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

program
  .command('new')
  .description('Create a new terminal')
  .option('-n, --name <name>', 'Terminal name')
  .option('-r, --role <role>', 'Role (lead, coder, reviewer, tester, researcher, devops)')
  .option('-d, --cwd <dir>', 'Working directory')
  .option('-s, --shell <shell>', 'Shell to use')
  .action(async (options) => {
    try {
      const result = await sendCommand({
        command: 'create',
        name: options.name,
        role: options.role,
        cwd: options.cwd,
        shell: options.shell,
      });
      if (result.ok) console.log(`Created: ${result.name} (${result.id})`);
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('send <target> <text...>')
  .description('Send text/command to a terminal (by ID or name)')
  .action(async (target, textParts) => {
    try {
      const result = await sendCommand({ command: 'send', target, text: textParts.join(' ') });
      if (!result.ok) { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('read <target>')
  .description('Read recent output from a terminal')
  .option('-l, --lines <n>', 'Number of lines', '50')
  .action(async (target, options) => {
    try {
      const result = await sendCommand({ command: 'read', target, lines: parseInt(options.lines) });
      if (result.ok) process.stdout.write(result.buffer);
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('link <from> <to>')
  .description('Link two terminals (by ID or name)')
  .action(async (from, to) => {
    try {
      const result = await sendCommand({ command: 'link', from, to });
      if (result.ok) console.log(`Linked: ${result.from} <-> ${result.to}`);
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('unlink <from> <to>')
  .description('Unlink two terminals')
  .action(async (from, to) => {
    try {
      const result = await sendCommand({ command: 'unlink', from, to });
      if (!result.ok) { console.error('Error:', result.error); process.exit(1); }
      console.log('Unlinked.');
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('ask <from> <to> <text...>')
  .description('Send a message from one terminal to a linked terminal')
  .action(async (from, to, textParts) => {
    try {
      const result = await sendCommand({ command: 'ask', from, to, text: textParts.join(' ') });
      if (result.ok) console.log('Message sent.');
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('notify <target>')
  .description('Send a notification for a terminal')
  .option('-s, --status <status>', 'Status: idle, attention, success, warning, error', 'attention')
  .option('-t, --text <text>', 'Notification text')
  .action(async (target, options) => {
    try {
      const result = await sendCommand({ command: 'notify', target, status: options.status, text: options.text || '' });
      if (!result.ok) { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('status <target> <status>')
  .description('Set terminal status (idle, attention, success, warning, error)')
  .action(async (target, status) => {
    const valid = ['idle', 'attention', 'success', 'warning', 'error'];
    if (!valid.includes(status)) { console.error(`Invalid status. Use: ${valid.join(', ')}`); process.exit(1); }
    try {
      const result = await sendCommand({ command: 'status', target, status });
      if (!result.ok) { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('rename <target> <name>')
  .description('Rename a terminal')
  .action(async (target, name) => {
    try {
      const result = await sendCommand({ command: 'rename', target, name });
      if (result.ok) console.log(`Renamed to: ${name}`);
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('destroy <target>')
  .alias('kill')
  .description('Destroy a terminal')
  .action(async (target) => {
    try {
      const result = await sendCommand({ command: 'destroy', target });
      if (result.ok) console.log('Terminal destroyed.');
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('ssh <target>')
  .description('Create a persistent SSH terminal (e.g. termates ssh user@host)')
  .option('-n, --name <name>', 'Terminal name')
  .option('-r, --role <role>', 'Agent role')
  .action(async (target, options) => {
    try {
      const result = await sendCommand({ command: 'ssh', target, name: options.name, role: options.role });
      if (result.ok) console.log(`SSH terminal created: ${result.name} (${result.id})`);
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('browser-snapshot <url>')
  .alias('snapshot')
  .description('Get text content from a URL')
  .action(async (url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    try {
      const result = await sendCommand({ command: 'browser-snapshot', url });
      if (result.ok) console.log(result.text);
      else { console.error('Error:', result.error); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program
  .command('ping')
  .description('Check if the server is running')
  .action(async () => {
    try {
      const result = await sendCommand({ command: 'ping' });
      if (result.ok) console.log(`Termates v${result.version} running (uptime: ${Math.round(result.uptime)}s)`);
    } catch (err) { console.error(err.message); process.exit(1); }
  });

program.parse();
