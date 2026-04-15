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

    let current = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;
      const [, key, value] = match;

      if (key.toLowerCase() === 'host') {
        // Skip wildcard-only entries
        if (value === '*' || value.includes('?')) continue;
        // Could be multiple hosts on one line
        for (const h of value.split(/\s+/)) {
          if (h === '*' || h.includes('?')) continue;
          current = { host: h, hostname: null, user: null, port: null, identityFile: null };
          hosts.push(current);
        }
      } else if (current) {
        switch (key.toLowerCase()) {
          case 'hostname': current.hostname = value; break;
          case 'user': current.user = value; break;
          case 'port': current.port = value; break;
          case 'identityfile': current.identityFile = value; break;
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

  const socketPath = path.join(SSH_SOCKETS_DIR, '%r@%h:%p');

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

  const socketPath = path.join(SSH_SOCKETS_DIR, '%r@%h:%p');

  // Try to attach to existing remote tmux session, or create new one
  const tmuxCmd = remoteCwd
    ? `tmux new-session -A -s ${sessionName} -c ${shellEscape(remoteCwd)}`
    : `tmux new-session -A -s ${sessionName}`;

  return [
    'ssh',
    '-o', `ControlMaster=auto`,
    '-o', `ControlPath=${socketPath}`,
    '-o', `ControlPersist=600`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-t',
    target,
    tmuxCmd,
  ];
}

function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
