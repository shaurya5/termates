import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  fs: {
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ mode: 0o755 })),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('')),
  },
}));

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
  execFileSync: mocks.execFileSync,
}));

vi.mock('fs', () => ({
  default: mocks.fs,
}));

const { detectBackend, TMUX_CONF_CONTENT } = await import('../../server/persistence-backend.js');

describe('tmux persistence backend', () => {
  let originalVersions;

  beforeEach(() => {
    vi.clearAllMocks();
    originalVersions = process.versions;
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
    mocks.execSync.mockImplementation((command) => {
      if (command.includes('command -v tmux')) return '/usr/bin/tmux\n';
      throw new Error(`unexpected execSync: ${command}`);
    });
    mocks.execFileSync.mockImplementation(() => '');
  });

  afterEach(() => {
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
  });

  it('detects tmux first and synchronizes the private tmux config on startup', () => {
    const backend = detectBackend();

    expect(backend.name).toBe('tmux');
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.termates\/tmux\.conf$/),
      TMUX_CONF_CONTENT,
    );
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/tmux',
      ['-S', expect.stringMatching(/\.termates\/tmux\.sock$/), 'start-server'],
      { stdio: 'pipe' },
    );
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/tmux',
      ['-S', expect.stringMatching(/\.termates\/tmux\.sock$/), 'source-file', expect.stringMatching(/\.termates\/tmux\.conf$/)],
      { stdio: 'pipe' },
    );
  });

  it('creates detached sessions with the private config and always attaches through the same config', () => {
    mocks.execSync.mockImplementation((command) => {
      if (command.includes('command -v tmux')) return '/usr/bin/tmux\n';
      if (command.includes('has-session')) throw new Error('missing session');
      throw new Error(`unexpected execSync: ${command}`);
    });

    const backend = detectBackend();
    mocks.execFileSync.mockClear();

    const env = { TERM: 'xterm-256color', FOO: 'bar' };
    const spawn = backend.buildSpawn({
      sessionName: 'termates-t99',
      innerCmd: '/bin/zsh',
      innerArgs: ['-l'],
      baseEnv: env,
      cols: 132,
      rows: 44,
    });

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      [
        '-S', expect.stringMatching(/\.termates\/tmux\.sock$/), '-f', expect.stringMatching(/\.termates\/tmux\.conf$/),
        'new-session', '-d', '-s', 'termates-t99',
        '-x', '132', '-y', '44',
        '/bin/zsh', '-l',
      ],
      { env, stdio: 'pipe' },
    );
    expect(spawn).toEqual({
      spawnFile: process.execPath,
      spawnArgs: [
        expect.stringMatching(/server\/tmux-control-client\.js$/),
        '/usr/bin/tmux',
        expect.stringMatching(/\.termates\/tmux\.sock$/),
        expect.stringMatching(/\.termates\/tmux\.conf$/),
        'termates-t99',
      ],
      env,
    });
  });

  it('parses live alternate-screen state from tmux panes', () => {
    const backend = detectBackend();
    mocks.execFileSync.mockClear();

    mocks.execFileSync.mockImplementationOnce(() => '1\n0\n');
    expect(backend.querySessionTuiMode('termates-a')).toBe(true);

    mocks.execFileSync.mockImplementationOnce(() => '0\n');
    expect(backend.querySessionTuiMode('termates-b')).toBe(false);

    mocks.execFileSync.mockImplementationOnce(() => 'maybe\n');
    expect(backend.querySessionTuiMode('termates-c')).toBeNull();
  });

  it('captures the current tmux screen with cursor restoration for deterministic client hydrate', () => {
    const backend = detectBackend();
    mocks.execFileSync.mockClear();

    mocks.execFileSync
      .mockImplementationOnce(() => '%188\t2\t6\t1\n')
      .mockImplementationOnce(() => '\u001b[1mClaude\u001b[0m\n\u001b[32mready\u001b[39m');

    expect(backend.captureSessionSnapshot('termates-snap')).toBe(
      '\x1b[?25l\x1b[H\x1b[2J\u001b[1mClaude\u001b[0m\r\n\u001b[32mready\u001b[39m\x1b[7;3H\x1b[?25h',
    );
  });

  it('runs the tmux control client in node mode when the server is inside Electron', () => {
    Object.defineProperty(process, 'versions', {
      value: { ...originalVersions, electron: '41.2.0' },
      configurable: true,
    });

    const backend = detectBackend();
    const env = { TERM: 'xterm-256color', FOO: 'bar' };
    const spawn = backend.buildSpawn({
      sessionName: 'termates-electron',
      innerCmd: '/bin/zsh',
      innerArgs: ['-l'],
      baseEnv: env,
    });

    expect(spawn.env).toEqual({
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});
