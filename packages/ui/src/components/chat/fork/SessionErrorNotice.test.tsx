import React, { act } from 'react';
import type { TextPart, UserMessage } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { StoreApi } from 'zustand';

import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import type { DirectoryStore } from '@/sync/child-store';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';

import { SessionErrorNotice, VERIFY_AFTER_MS, WAITING_AFTER_MS } from './SessionErrorNotice';

const DIRECTORY = '/fixture';
const SESSION_ID = 'session-1';
const MESSAGE_ID = 'message-1';
const STARTED_AT = 1_000_000;

type OptimisticUserMessage = UserMessage & {
  time: { created: number; completed: 0 };
};

type StatusSnapshot = Awaited<ReturnType<typeof opencodeClient.getSessionStatusForDirectory>>;

interface StoreHolder {
  current?: StoreApi<DirectoryStore>;
}

let restoreGlobals: (() => Promise<void>) | null = null;

afterEach(async () => {
  await restoreGlobals?.();
  restoreGlobals = null;
});

const renderNotice = async (options?: {
  ageMs?: number;
  connected?: boolean;
  statusSnapshot?: StatusSnapshot;
}) => {
  const win = new Window({ url: 'http://localhost' });
  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let fakeNow = STARTED_AT;
  const originalSetTimeout = win.setTimeout.bind(win);
  const originalClearTimeout = win.clearTimeout.bind(win);
  const timers = new Map<ReturnType<typeof win.setTimeout>, { at: number; callback: () => void }>();
  const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
  const setTimeoutSpy = spyOn(win, 'setTimeout').mockImplementation((handler, timeout = 0) => {
    const timerHandle = originalSetTimeout(() => undefined, 2_147_483_647);
    timers.set(timerHandle, { at: fakeNow + timeout, callback: () => handler() });
    return timerHandle;
  });
  const clearTimeoutSpy = spyOn(win, 'clearTimeout').mockImplementation((timerHandle) => {
    if (timerHandle !== undefined) {
      timers.delete(timerHandle);
      originalClearTimeout(timerHandle);
    }
  });

  const originalConfig = useConfigStore.getState();
  const connected = options?.connected ?? true;
  useConfigStore.setState({
    isConnected: connected,
    connectionPhase: connected ? 'connected' : 'reconnecting',
  });
  const statusSpy = spyOn(opencodeClient, 'getSessionStatusForDirectory')
    .mockResolvedValue(options && 'statusSnapshot' in options ? options.statusSnapshot ?? null : {});
  const container = document.createElement('div');
  const root = createRoot(container);
  const storeHolder: StoreHolder = {};

  const CaptureStore = () => {
    storeHolder.current = useDirectoryStore(DIRECTORY);
    return null;
  };
  const sdk = createOpencodeClient({
    baseUrl: 'http://opencode.test',
    fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
  });
  await act(async () => {
    root.render(
      <SyncProvider directory={DIRECTORY} sdk={sdk}>
        <I18nProvider>
          <CaptureStore />
          <SessionErrorNotice sessionId={SESSION_ID} directory={DIRECTORY} />
        </I18nProvider>
      </SyncProvider>,
    );
  });

  const message: OptimisticUserMessage = {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: 'user',
    time: { created: STARTED_AT - (options?.ageMs ?? 0), completed: 0 },
    agent: 'build',
    model: { providerID: 'provider', modelID: 'model', variant: 'high' },
  };
  const part: TextPart = {
    id: 'part-1',
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: 'text',
    text: 'Please continue',
  };
  await act(async () => {
    storeHolder.current?.setState((state) => ({
      message: { ...state.message, [SESSION_ID]: [message] },
      part: { ...state.part, [MESSAGE_ID]: [part] },
      session_status: { ...state.session_status, [SESSION_ID]: { type: 'idle' } },
    }));
    useConfigStore.setState({
      isConnected: connected,
      connectionPhase: connected ? 'connected' : 'reconnecting',
    });
  });
  const directoryStore = storeHolder.current;
  if (!directoryStore) throw new Error('Directory store was not captured');

  const advance = async (milliseconds: number) => {
    const target = fakeNow + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [timerId, timer] = due;
      timers.delete(timerId);
      originalClearTimeout(timerId);
      fakeNow = timer.at;
      await act(async () => {
        timer.callback();
        await Promise.resolve();
      });
    }
    fakeNow = target;
    await act(async () => {
      directoryStore.setState((state) => ({
        session_status: { ...state.session_status, [SESSION_ID]: { type: 'idle' } },
      }));
      await Promise.resolve();
    });
  };
  restoreGlobals = async () => {
    await act(async () => root.unmount());
    statusSpy.mockRestore();
    for (const timerHandle of timers.keys()) originalClearTimeout(timerHandle);
    timers.clear();
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
  return { container, advance, directoryStore };
};

describe('fork SessionErrorNotice', () => {
  test('uses user creation time and waits two seconds before showing a muted notice', async () => {
    const view = await renderNotice();
    expect(view.container.textContent).toBe('');

    await view.advance(WAITING_AFTER_MS - 1);
    expect(view.container.textContent).toBe('');

    await view.advance(1);
    expect(view.container.textContent).toContain('Waiting for OpenCode to start a reply…');
    expect(view.container.textContent).not.toContain('OpenCode did not start a reply');
  });

  test('shows reconnecting regardless of elapsed time', async () => {
    const view = await renderNotice({ ageMs: VERIFY_AFTER_MS + 1, connected: false });
    expect(view.container.textContent).toContain('Reconnecting to OpenCode…');
  });

  test('shows a warning with actions after the server confirms idle', async () => {
    const view = await renderNotice({ ageMs: VERIFY_AFTER_MS, statusSnapshot: {} });
    await view.advance(0);

    expect(view.container.textContent).toContain('No reply yet');
    expect(view.container.textContent).toContain('Send again');
    expect(view.container.textContent).toContain('Check again');
    expect(view.container.textContent).toContain('Status report');
  });

  test('keeps waiting when the authoritative status fetch fails', async () => {
    const view = await renderNotice({ ageMs: VERIFY_AFTER_MS, statusSnapshot: null });
    await view.advance(0);

    expect(view.container.textContent).toContain('Waiting for OpenCode to start a reply…');
    expect(view.container.textContent).not.toContain('No reply yet');
  });

  test('applies a busy status snapshot and hides the notice', async () => {
    const view = await renderNotice({
      ageMs: VERIFY_AFTER_MS,
      statusSnapshot: { [SESSION_ID]: { type: 'busy' } },
    });
    await view.advance(0);

    expect(view.directoryStore.getState().session_status[SESSION_ID]?.type).toBe('busy');
    expect(view.container.textContent).toBe('');
  });
});
