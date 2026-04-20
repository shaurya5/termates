import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTuiMonitor, stopTuiMonitor } from '../../server/orchestration.js';

describe('startTuiMonitor()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.TERMATES_DISABLE_TUI_MONITOR;
  });

  afterEach(() => {
    stopTuiMonitor();
    vi.useRealTimers();
    delete process.env.TERMATES_DISABLE_TUI_MONITOR;
  });

  it('polls pane state, skips missing panes, and only broadcasts actual changes', async () => {
    const ptyManager = {
      list: vi.fn(() => [{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
      paneAlternateOn: vi.fn(async (id) => {
        if (id === 't1') return true;
        if (id === 't2') return false;
        return null;
      }),
      setInTui: vi.fn((id, value) => {
        if (id === 't1') return { changed: true, current: value };
        if (id === 't2') return { changed: false, current: value };
        return null;
      }),
    };
    const broadcast = vi.fn();

    startTuiMonitor(ptyManager, broadcast);
    await vi.advanceTimersByTimeAsync(1500);

    expect(ptyManager.list).toHaveBeenCalledTimes(1);
    expect(ptyManager.paneAlternateOn).toHaveBeenCalledTimes(3);
    expect(ptyManager.setInTui).toHaveBeenCalledTimes(2);
    expect(ptyManager.setInTui).toHaveBeenCalledWith('t1', true);
    expect(ptyManager.setInTui).toHaveBeenCalledWith('t2', false);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'terminal:tui-state',
      payload: { id: 't1', inTui: true },
    });
  });

  it('does not start when the TUI monitor is disabled by env', async () => {
    process.env.TERMATES_DISABLE_TUI_MONITOR = '1';

    const ptyManager = {
      list: vi.fn(() => [{ id: 't1' }]),
      paneAlternateOn: vi.fn(),
      setInTui: vi.fn(),
    };
    const broadcast = vi.fn();

    startTuiMonitor(ptyManager, broadcast);
    await vi.advanceTimersByTimeAsync(3000);

    expect(ptyManager.list).not.toHaveBeenCalled();
    expect(ptyManager.paneAlternateOn).not.toHaveBeenCalled();
    expect(ptyManager.setInTui).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('is idempotent and does not create duplicate polling loops', async () => {
    const ptyManager = {
      list: vi.fn(() => [{ id: 't1' }]),
      paneAlternateOn: vi.fn(async () => false),
      setInTui: vi.fn(() => ({ changed: false, current: false })),
    };

    startTuiMonitor(ptyManager, vi.fn());
    startTuiMonitor(ptyManager, vi.fn());
    await vi.advanceTimersByTimeAsync(1500);

    expect(ptyManager.list).toHaveBeenCalledTimes(1);
    expect(ptyManager.paneAlternateOn).toHaveBeenCalledTimes(1);
    expect(ptyManager.setInTui).toHaveBeenCalledTimes(1);
  });
});
