import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { DictationLiveTranscript } from './DictationLiveTranscript';

test('hides empty text, shows committed text literally, and follows updates', async () => {
    const win = new Window({ url: 'http://localhost' });
    const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(
        Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = async (text: string) => {
        await act(async () => root.render(<DictationLiveTranscript text={text} />));
    };

    try {
        await render('');
        expect(container.childElementCount).toBe(0);

        await render('First segment.');
        const transcript = container.querySelector('div');
        if (!transcript) throw new Error('Expected a live transcript');
        expect(transcript.textContent).toBe('First segment.');
        expect(transcript.getAttribute('aria-live')).toBe('polite');
        expect(transcript.classList.contains('text-foreground')).toBe(true);
        expect(transcript.classList.contains('max-h-[3lh]')).toBe(true);
        expect(transcript.classList.contains('overflow-y-auto')).toBe(true);

        // happy-dom has no layout; supply the growing content height.
        Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 120 });
        await render('First segment.\nSecond <segment>.');
        expect(transcript.textContent).toBe('First segment.\nSecond <segment>.');
        expect(transcript.childElementCount).toBe(0);
        expect(transcript.scrollTop).toBe(120);

        transcript.scrollTop = 0;
        await render('First segment.\nSecond <segment>.');
        expect(transcript.scrollTop).toBe(0);

        Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 240 });
        await render('First segment.\nSecond <segment>.\nThird segment.');
        expect(transcript.scrollTop).toBe(240);

        await render('');
        expect(container.childElementCount).toBe(0);
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
});
