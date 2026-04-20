/**
 * Unit tests for server/ssh-config.js
 *
 * Covers parseSSHConfig(), buildSSHCommand(), buildRemoteTmuxCommand(),
 * and the internal shellEscape() function (tested indirectly).
 *
 * These are critical — regressions here silently break SSH host discovery,
 * SSH connections, and remote tmux persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We need to mock fs to control what parseSSHConfig reads
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    default: {
      ...real,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => ''),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import { parseSSHConfig, buildSSHCommand, buildRemoteTmuxCommand } from '../../server/ssh-config.js';

// ---------------------------------------------------------------------------
// parseSSHConfig()
// ---------------------------------------------------------------------------

describe('parseSSHConfig()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when ~/.ssh/config does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(parseSSHConfig()).toEqual([]);
  });

  it('parses a single Host entry with all fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host myserver',
      '  HostName 192.168.1.100',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_rsa',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual({
      host: 'myserver',
      hostname: '192.168.1.100',
      user: 'deploy',
      port: '2222',
      identityFile: '~/.ssh/id_rsa',
    });
  });

  it('parses multiple Host entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host server1',
      '  HostName 10.0.0.1',
      '  User alice',
      '',
      'Host server2',
      '  HostName 10.0.0.2',
      '  User bob',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(2);
    expect(hosts[0].host).toBe('server1');
    expect(hosts[0].user).toBe('alice');
    expect(hosts[1].host).toBe('server2');
    expect(hosts[1].user).toBe('bob');
  });

  it('skips wildcard-only Host entries (Host *)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host *',
      '  ServerAliveInterval 30',
      '',
      'Host myserver',
      '  HostName 10.0.0.1',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('myserver');
  });

  it('skips Host entries containing ? wildcard', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host dev?',
      '  HostName 10.0.0.1',
      '',
      'Host prod',
      '  HostName 10.0.0.2',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('prod');
  });

  it('handles multiple hosts on one Host line', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host alpha beta',
      '  HostName 10.0.0.1',
      '  User shared',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(2);
    expect(hosts[0].host).toBe('alpha');
    expect(hosts[1].host).toBe('beta');
    expect(hosts[0].hostname).toBe('10.0.0.1');
    expect(hosts[0].user).toBe('shared');
    expect(hosts[1].hostname).toBe('10.0.0.1');
    expect(hosts[1].user).toBe('shared');
  });

  it('filters out * from multi-host lines while keeping named hosts', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host myhost *',
      '  HostName 10.0.0.1',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('myhost');
  });

  it('filters wildcard hosts from mixed Host lines while keeping exact hosts', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host dev? prod',
      '  HostName 10.0.0.2',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('prod');
    expect(hosts[0].hostname).toBe('10.0.0.2');
  });

  it('skips comment lines', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      '# This is a comment',
      'Host myserver',
      '  # Another comment',
      '  HostName 10.0.0.1',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('10.0.0.1');
  });

  it('skips empty lines', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      '',
      'Host myserver',
      '',
      '  HostName 10.0.0.1',
      '',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
  });

  it('returns host with null fields when no details are specified', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('Host barehost\n');

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual({
      host: 'barehost',
      hostname: null,
      user: null,
      port: null,
      identityFile: null,
    });
  });

  it('is case-insensitive for SSH config keywords', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'host myserver',
      '  hostname 10.0.0.1',
      '  user admin',
      '  port 22',
      '  identityfile ~/.ssh/key',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('10.0.0.1');
    expect(hosts[0].user).toBe('admin');
    expect(hosts[0].port).toBe('22');
    expect(hosts[0].identityFile).toBe('~/.ssh/key');
  });

  it('ignores unrecognized SSH config keys', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host myserver',
      '  HostName 10.0.0.1',
      '  ForwardAgent yes',
      '  ProxyCommand ssh -W %h:%p jump',
      '  ServerAliveInterval 30',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    // Only known fields should be present
    expect(hosts[0].hostname).toBe('10.0.0.1');
    expect(hosts[0]).not.toHaveProperty('forwardAgent');
    expect(hosts[0]).not.toHaveProperty('proxyCommand');
  });

  it('returns empty array when readFileSync throws', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Permission denied');
    });

    expect(parseSSHConfig()).toEqual([]);
  });

  it('attributes config lines to the most recently declared Host', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'Host first',
      '  HostName 10.0.0.1',
      'Host second',
      '  HostName 10.0.0.2',
      '  User bob',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts[0].hostname).toBe('10.0.0.1');
    expect(hosts[0].user).toBeNull();
    expect(hosts[1].hostname).toBe('10.0.0.2');
    expect(hosts[1].user).toBe('bob');
  });

  it('ignores config lines that appear before any Host declaration', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue([
      'ServerAliveInterval 30',
      'HostName orphan.example.com',
      '',
      'Host real',
      '  HostName 10.0.0.1',
    ].join('\n'));

    const hosts = parseSSHConfig();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBe('real');
    expect(hosts[0].hostname).toBe('10.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// buildSSHCommand()
// ---------------------------------------------------------------------------

describe('buildSSHCommand()', () => {
  it('returns an array starting with "ssh"', () => {
    const parts = buildSSHCommand('user@host');
    expect(parts[0]).toBe('ssh');
  });

  it('includes ControlMaster=auto for connection multiplexing', () => {
    const parts = buildSSHCommand('user@host');
    const idx = parts.indexOf('ControlMaster=auto');
    // It appears as -o ControlMaster=auto
    expect(parts.some(p => p === 'ControlMaster=auto')).toBe(true);
  });

  it('includes ControlPersist=600 for connection reuse', () => {
    const parts = buildSSHCommand('user@host');
    expect(parts.some(p => p === 'ControlPersist=600')).toBe(true);
  });

  it('includes ServerAliveInterval=30 for keepalive', () => {
    const parts = buildSSHCommand('user@host');
    expect(parts.some(p => p === 'ServerAliveInterval=30')).toBe(true);
  });

  it('includes -t flag for TTY allocation', () => {
    const parts = buildSSHCommand('user@host');
    expect(parts).toContain('-t');
  });

  it('includes the target host', () => {
    const parts = buildSSHCommand('deploy@prod-server');
    expect(parts).toContain('deploy@prod-server');
  });

  it('appends cd + exec shell when remoteCwd is provided', () => {
    const parts = buildSSHCommand('user@host', '/home/user/project');
    const last = parts[parts.length - 1];
    expect(last).toContain('cd');
    expect(last).toContain('/home/user/project');
    expect(last).toContain('$SHELL');
  });

  it('does not append remote command when remoteCwd is omitted', () => {
    const parts = buildSSHCommand('user@host');
    const last = parts[parts.length - 1];
    // Last element should be the target, not a command
    expect(last).toBe('user@host');
  });

  it('shell-escapes the remoteCwd to prevent injection', () => {
    const parts = buildSSHCommand('user@host', "/path with 'quotes");
    const last = parts[parts.length - 1];
    // The path should be escaped — single quotes with internal quote escaping
    expect(last).toContain("'\\''");
  });

  it('includes ControlPath in the SSH socket directory', () => {
    const parts = buildSSHCommand('user@host');
    const controlPath = parts.find(p => p.startsWith('ControlPath='));
    expect(controlPath).toBeDefined();
    expect(controlPath).toContain('.termates/ssh-sockets');
  });
});

// ---------------------------------------------------------------------------
// buildRemoteTmuxCommand()
// ---------------------------------------------------------------------------

describe('buildRemoteTmuxCommand()', () => {
  it('returns an object with sshArgs and remoteCmd', () => {
    const result = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(result).toHaveProperty('sshArgs');
    expect(result).toHaveProperty('remoteCmd');
    expect(Array.isArray(result.sshArgs)).toBe(true);
    expect(typeof result.remoteCmd).toBe('string');
  });

  it('sshArgs starts with "ssh"', () => {
    const { sshArgs } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(sshArgs[0]).toBe('ssh');
  });

  it('sshArgs includes -t for TTY', () => {
    const { sshArgs } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(sshArgs).toContain('-t');
  });

  it('sshArgs includes the target', () => {
    const { sshArgs } = buildRemoteTmuxCommand('deploy@prod', 'termates-t1');
    expect(sshArgs).toContain('deploy@prod');
  });

  it('remoteCmd kills stale session first', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).toContain('tmux kill-session -t termates-t1');
  });

  it('remoteCmd creates a new tmux session with the given name', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'my-session');
    expect(remoteCmd).toContain('tmux new-session -s my-session');
  });

  it('remoteCmd disables mouse so xterm.js handles it', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).toContain('set mouse off');
  });

  it('remoteCmd enables focus-events for full-screen TUIs', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).toContain('set focus-events on');
  });

  it('remoteCmd includes status off config', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).toContain('set status off');
  });

  it('remoteCmd includes escape-time 0 config', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).toContain('set escape-time 0');
  });

  it('remoteCmd includes cd when remoteCwd is provided', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1', '/home/user/project');
    expect(remoteCmd).toContain('cd');
    expect(remoteCmd).toContain('/home/user/project');
  });

  it('remoteCmd expands ~ to $HOME in remoteCwd', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1', '~/myproject');
    expect(remoteCmd).toContain('$HOME/myproject');
    expect(remoteCmd).not.toContain('~/myproject');
  });

  it('remoteCmd quotes remoteCwd paths that contain spaces or quotes', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1', "~/project with \"quotes\" and $vars");
    expect(remoteCmd).toContain('cd "$HOME/project with \\"quotes\\" and \\$vars"');
  });

  it('remoteCmd does not include cd when remoteCwd is omitted', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).not.toMatch(/\bcd\b/);
  });

  it('includes ControlMaster multiplexing in sshArgs', () => {
    const { sshArgs } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(sshArgs.some(p => p === 'ControlMaster=auto')).toBe(true);
  });

  it('includes history-limit in remote tmux config', () => {
    const { remoteCmd } = buildRemoteTmuxCommand('user@host', 'termates-t1');
    expect(remoteCmd).toContain('history-limit 50000');
  });
});
