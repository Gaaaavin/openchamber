import React, { act } from 'react';
import type { AssistantMessage, TextPart } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { StoreApi } from 'zustand';

import { I18nProvider } from '@/lib/i18n';
import type { DirectoryStore } from '@/sync/child-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';

import { LiveTps } from './LiveTps';

const DIRECTORY = '/fixture';
const SESSION_ID = 'session-1';
const MESSAGE_ID = 'message-1';
const PART_ID = 'part-1';
const STARTED_AT = 1_000_000;

interface StoreHolder {
  current?: StoreApi<DirectoryStore>;
}

let restoreGlobals: (() => Promise<void>) | null = null;

afterEach(async () => {
  await restoreGlobals?.();
  restoreGlobals = null;
});

const assistantMessage: AssistantMessage = {
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: STARTED_AT },
  parentID: 'user-1',
  modelID: 'model',
  providerID: 'provider',
  mode: 'primary',
  agent: 'build',
  path: { cwd: DIRECTORY, root: DIRECTORY },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};

const textPart = (text: string): TextPart => ({
  id: PART_ID,
  sessionID: SESSION_ID,
  messageID: MESSAGE_ID,
  type: 'text',
  text,
});

const renderTps = async (options?: { isWorking?: boolean; initialText?: string }) => {
  const win = new Window({ url: 'http://localhost' });
  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }

  let fakeNow = STARTED_AT;
  const originalSetInterval = win.setInterval.bind(win);
  const originalClearInterval = win.clearInterval.bind(win);
  const intervals = new Map<ReturnType<typeof win.setInterval>, { at: number; delay: number; callback: () => void }>();
  const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
  const setIntervalSpy = spyOn(win, 'setInterval').mockImplementation((handler, timeout = 0) => {
    const intervalHandle = originalSetInterval(() => undefined, 2_147_483_647);
    intervals.set(intervalHandle, { at: fakeNow + timeout, delay: timeout, callback: () => handler() });
    return intervalHandle;
  });
  const clearIntervalSpy = spyOn(win, 'clearInterval').mockImplementation((intervalHandle) => {
    if (intervalHandle !== undefined) {
      intervals.delete(intervalHandle);
      originalClearInterval(intervalHandle);
    }
  });

  const originalSessionUi = useSessionUIStore.getState();
  useSessionUIStore.setState({ currentSessionId: SESSION_ID, currentSessionDirectory: DIRECTORY });
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
  const render = (includeMeter: boolean) => (
    <SyncProvider directory={DIRECTORY} sdk={sdk}>
      <I18nProvider>
        <CaptureStore />
        {includeMeter ? <LiveTps isWorking={options?.isWorking ?? true} /> : null}
      </I18nProvider>
    </SyncProvider>
  );

  await act(async () => root.render(render(false)));
  const directoryStore = storeHolder.current;
  if (!directoryStore) throw new Error('Directory store was not captured');
  if (options && 'initialText' in options) {
    directoryStore.setState((state) => ({
      message: { ...state.message, [SESSION_ID]: [assistantMessage] },
      part: { ...state.part, [MESSAGE_ID]: [textPart(options.initialText ?? '')] },
    }));
  }
  await act(async () => root.render(render(true)));

  const setText = async (text: string) => {
    await act(async () => {
      directoryStore.setState((state) => ({
        message: state.message[SESSION_ID]
          ? state.message
          : { ...state.message, [SESSION_ID]: [assistantMessage] },
        part: { ...state.part, [MESSAGE_ID]: [textPart(text)] },
      }));
    });
  };
  const advance = async (milliseconds: number) => {
    const target = fakeNow + milliseconds;
    while (true) {
      const due = [...intervals.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [timerId, timer] = due;
      fakeNow = timer.at;
      timer.at += timer.delay;
      intervals.set(timerId, timer);
      await act(async () => timer.callback());
    }
    fakeNow = target;
  };

  restoreGlobals = async () => {
    await act(async () => root.unmount());
    for (const intervalHandle of intervals.keys()) originalClearInterval(intervalHandle);
    intervals.clear();
    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
    dateNowSpy.mockRestore();
    useSessionUIStore.setState(originalSessionUi, true);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  };

  return { advance, container, setText };
};

describe('LiveTps', () => {
  test('renders nothing when the assistant is not working', async () => {
    const view = await renderTps({ isWorking: false });
    expect(view.container.textContent).toBe('');
  });

  test('shows a numeric rate after observed assistant text growth', async () => {
    const view = await renderTps();
    await view.setText('');
    await view.advance(500);
    await view.setText('x'.repeat(100));
    await view.advance(500);

    expect(/^TPS(?!—)\d/.test(view.container.textContent ?? '')).toBe(true);
  });

  test('parts already present at mount only establish watermarks', async () => {
    const view = await renderTps({ initialText: 'x'.repeat(100) });
    await view.advance(1_000);
    expect(view.container.textContent).toBe('TPS—');

    await view.setText('x'.repeat(200));
    await view.advance(1_000);
    expect(/^TPS(?!—)\d/.test(view.container.textContent ?? '')).toBe(true);
  });

  test('returns to a dash after two seconds without growth', async () => {
    const view = await renderTps();
    await view.setText('');
    await view.advance(500);
    await view.setText('x'.repeat(100));
    await view.advance(500);
    expect(/^TPS(?!—)\d/.test(view.container.textContent ?? '')).toBe(true);

    await view.advance(2_000);
    expect(view.container.textContent).toBe('TPS—');
  });
});
