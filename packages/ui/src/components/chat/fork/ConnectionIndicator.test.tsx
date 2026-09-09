import React, { act } from 'react';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';

import {
  CONNECTION_INDICATOR_SHOW_DELAY_MS,
  ConnectionIndicator,
  RECONNECTED_FLASH_MS,
} from './ConnectionIndicator';

const STARTED_AT = 1_000_000;

let restoreGlobals: (() => Promise<void>) | null = null;

afterEach(async () => {
  await restoreGlobals?.();
  restoreGlobals = null;
});

const renderIndicator = async (initial: {
  connectionPhase: 'connecting' | 'connected' | 'reconnecting';
  hasEverConnected: boolean;
}) => {
  const win = new Window({ url: 'http://localhost' });
  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }

  let fakeNow = STARTED_AT;
  const originalSetTimeout = win.setTimeout.bind(win);
  const originalClearTimeout = win.clearTimeout.bind(win);
  const originalSetInterval = win.setInterval.bind(win);
  const originalClearInterval = win.clearInterval.bind(win);
  const timeouts = new Map<ReturnType<typeof win.setTimeout>, { at: number; callback: () => void }>();
  const intervals = new Map<ReturnType<typeof win.setInterval>, { at: number; delay: number; callback: () => void }>();
  const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
  const setTimeoutSpy = spyOn(win, 'setTimeout').mockImplementation((handler, timeout = 0) => {
    const handle = originalSetTimeout(() => undefined, 2_147_483_647);
    timeouts.set(handle, { at: fakeNow + timeout, callback: () => handler() });
    return handle;
  });
  const clearTimeoutSpy = spyOn(win, 'clearTimeout').mockImplementation((handle) => {
    if (handle !== undefined) {
      timeouts.delete(handle);
      originalClearTimeout(handle);
    }
  });
  const setIntervalSpy = spyOn(win, 'setInterval').mockImplementation((handler, timeout = 0) => {
    const handle = originalSetInterval(() => undefined, 2_147_483_647);
    intervals.set(handle, { at: fakeNow + timeout, delay: timeout, callback: () => handler() });
    return handle;
  });
  const clearIntervalSpy = spyOn(win, 'clearInterval').mockImplementation((handle) => {
    if (handle !== undefined) {
      intervals.delete(handle);
      originalClearInterval(handle);
    }
  });

  const originalConfig = useConfigStore.getState();
  useConfigStore.setState({
    connectionPhase: initial.connectionPhase,
    hasEverConnected: initial.hasEverConnected,
    isConnected: initial.connectionPhase === 'connected',
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ConnectionIndicator />
      </I18nProvider>,
    );
  });

  const setConnection = async (
    connectionPhase: 'connecting' | 'connected' | 'reconnecting',
    hasEverConnected = true,
  ) => {
    await act(async () => {
      useConfigStore.setState({
        connectionPhase,
        hasEverConnected,
        isConnected: connectionPhase === 'connected',
      });
    });
  };
  const advance = async (milliseconds: number) => {
    const target = fakeNow + milliseconds;
    while (true) {
      const nextTimeout = [...timeouts.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      const nextInterval = [...intervals.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      const timeoutFirst = nextTimeout
        && (!nextInterval || nextTimeout[1].at <= nextInterval[1].at);
      if (!nextTimeout && !nextInterval) break;

      if (timeoutFirst && nextTimeout) {
        const [handle, timer] = nextTimeout;
        timeouts.delete(handle);
        originalClearTimeout(handle);
        fakeNow = timer.at;
        await act(async () => timer.callback());
        continue;
      }

      if (nextInterval) {
        const [handle, timer] = nextInterval;
        fakeNow = timer.at;
        timer.at += timer.delay;
        intervals.set(handle, timer);
        await act(async () => timer.callback());
      }
    }
    fakeNow = target;
  };

  restoreGlobals = async () => {
    await act(async () => root.unmount());
    for (const handle of timeouts.keys()) originalClearTimeout(handle);
    for (const handle of intervals.keys()) originalClearInterval(handle);
    timeouts.clear();
    intervals.clear();
    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    dateNowSpy.mockRestore();
    useConfigStore.setState(originalConfig, true);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  };

  return {
    advance,
    container,
    intervalCount: () => intervals.size,
    setConnection,
  };
};

describe('ConnectionIndicator', () => {
  test('stays hidden while connected without starting the tick interval', async () => {
    const view = await renderIndicator({ connectionPhase: 'connected', hasEverConnected: true });
    expect(view.container.textContent).toBe('');
    expect(view.intervalCount()).toBe(0);
  });

  test('renders nothing during the initial connection', async () => {
    const view = await renderIndicator({ connectionPhase: 'connecting', hasEverConnected: false });
    await view.advance(CONNECTION_INDICATOR_SHOW_DELAY_MS + 1);
    expect(view.container.textContent).toBe('');
  });

  test('stays hidden for a short reconnect blip and skips the reconnected flash', async () => {
    const view = await renderIndicator({ connectionPhase: 'connected', hasEverConnected: true });
    await view.setConnection('reconnecting');
    await view.advance(CONNECTION_INDICATOR_SHOW_DELAY_MS - 1);
    expect(view.container.textContent).toBe('');

    await view.setConnection('connected');
    await view.advance(RECONNECTED_FLASH_MS);
    expect(view.container.textContent).toBe('');
    expect(view.intervalCount()).toBe(0);
  });

  test('shows elapsed reconnect time and ticks once per second while visible', async () => {
    const view = await renderIndicator({ connectionPhase: 'reconnecting', hasEverConnected: true });
    await view.advance(CONNECTION_INDICATOR_SHOW_DELAY_MS);
    expect(view.container.textContent).toContain('Connection lost · reconnecting… 1s');
    expect(view.intervalCount()).toBe(1);

    await view.advance(11_000);
    expect(view.container.textContent).toContain('Connection lost · reconnecting… 12s');
  });

  test('flashes reconnected after a visible disconnect, then hides', async () => {
    const view = await renderIndicator({ connectionPhase: 'reconnecting', hasEverConnected: true });
    await view.advance(CONNECTION_INDICATOR_SHOW_DELAY_MS);
    await view.setConnection('connected');
    expect(view.container.textContent).toBe('Reconnected');
    expect(view.intervalCount()).toBe(0);

    await view.advance(RECONNECTED_FLASH_MS - 1);
    expect(view.container.textContent).toBe('Reconnected');
    await view.advance(1);
    expect(view.container.textContent).toBe('');
  });
});
