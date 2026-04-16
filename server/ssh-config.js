import fs from 'fs';
import path from 'path';
import os from 'os';

const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
const SSH_SOCKETS_DIR = path.join(os.homedir(), '.termates', 'ssh-sockets');

// Parse ~/.ssh/config and extract Host entries
export function parseSSHConfig() {
  const hosts = [];
  try {
    if (!fs.existsSync(SSH_CONFIG_PATH)) return hosts;
    const content = fs.readFileSync(SSH_CONFIG_PATH, 'utf-8');
    const lines = content.split('\n');

    let currentHosts = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;
      const [, key, value] = match;

      if (key.toLowerCase() === 'host') {
        // Skip wildcard-only entries
        if (value === '*') continue;
        // Could be multiple hosts on one line
        currentHosts = [];
        for (const h of value.split(/\s+/)) {
          if (h === '*' || h.includes('?')) continue;
          const host = { host: h, hostname: null, user: null, port: null, identityFile: null };
          currentHosts.push(host);
          hosts.push(host);
        }
      } else if (currentHosts.length > 0) {
        for (const current of currentHosts) {
          switch (key.toLowerCase()) {
            case 'hostname': current.hostname = value; break;
            case 'user': current.user = value; break;
            case 'port': current.port = value; break;
            case 'identityfile': current.identityFile = value; break;
          }
        }
      }
    }
  } catch (e) { /* silent */ }
  return hosts;
}

// Build the SSH command with ControlMaster multiplexing
export function buildSSHCommand(target, remoteCwd) {
  // Ensure socket directory exists
  try {
    if (!fs.existsSync(SSH_SOCKETS_DIR)) fs.mkdirSync(SSH_SOCKETS_DIR, { recursive: true });
  } catch (e) { /* ok */ }

  // Use target as socket name instead of SSH %r@%h:%p tokens
  // because tmux treats % as format specifiers and corrupts the path
  const safeTarget = target.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const socketPath = path.join(SSH_SOCKETS_DIR, safeTarget);

  // Build remote command: attach or create tmux session
  const parts = [
    'ssh',
    '-o', `ControlMaster=auto`,
    '-o', `ControlPath=${socketPath}`,
    '-o', `ControlPersist=600`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-t',  // force TTY allocation
    target,
  ];

  if (remoteCwd) {
    // cd to directory, then exec shell
    parts.push(`cd ${shellEscape(remoteCwd)} && exec $SHELL -l`);
  }

  return parts;
}

// Build SSH + remote tmux command for persistent remote sessions
export function buildRemoteTmuxCommand(target, sessionName, remoteCwd) {
  try {
    if (!fs.existsSync(SSH_SOCKETS_DIR)) fs.mkdirSync(SSH_SOCKETS_DIR, { recursive: true });
  } catch (e) { /* ok */ }

  // Use target as socket name instead of SSH %r@%h:%p tokens
  // because tmux treats % as format specifiers and corrupts the path
  const safeTarget = target.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const socketPath = path.join(SSH_SOCKETS_DIR, safeTarget);

  let remoteCmd;
  // Kill stale session, cd, create tmux with mouse/scroll config inline
  const kill = `tmux kill-session -t ${sessionName} 2>/dev/null;`;
  const tmuxOpts = `\\; set mouse off \\; set status off \\; set escape-time 0 \\; set history-limit 50000`;
  if (remoteCwd) {
    const expandedCwd = shellEscapeRemoteCwd(remoteCwd);
    remoteCmd = `${kill} cd ${expandedCwd} && tmux new-session -s ${sessionName} ${tmuxOpts}`;
  } else {
    remoteCmd = `${kill} tmux new-session -s ${sessionName} ${tmuxOpts}`;
  }

  return {
    sshArgs: [
      'ssh',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${socketPath}`,
      '-o', 'ControlPersist=600',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-t',
      target,
    ],
    remoteCmd,
  };
}

function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function shellEscapeRemoteCwd(remoteCwd) {
  if (remoteCwd === '~') return '"$HOME"';
  if (remoteCwd.startsWith('~/')) {
    return `"${`$HOME${escapeForDoubleQuotes(remoteCwd.slice(1))}`}"`;
  }
  return shellEscape(remoteCwd);
}

function escapeForDoubleQuotes(s) {
  return s.replace(/["\\`$]/g, '\\$&');
}
