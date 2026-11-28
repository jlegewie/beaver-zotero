// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { logger } from '@beaver/agent-core/platform/logger';
import { setHost } from '@beaver/agent-ui/host';
import ErrorBoundary from '@beaver/agent-ui/primitives/ErrorBoundary';
import RenderErrorBoundary, { SUPPORT_EMAIL } from '@beaver/agent-ui/chat/RenderErrorBoundary';

const h = React.createElement;

/** Throws while rendering whenever `text` contains the marker. */
function Message({ text }: { text: string }) {
    if (text.includes('BOOM')) throw new Error(`cannot render ${text}`);
    return h('p', { 'data-message': text }, text);
}

function messageBoundary(runId: string, text: string, threadId: string | null = 'thread-1') {
    return h(
        RenderErrorBoundary,
        {
            key: runId,
            scope: 'message',
            summary: "This message couldn't be shown.",
            detail: 'The rest of the chat still works.',
            threadId,
            runId,
            resetKey: text,
        },
        h(Message, { text }),
    );
}

let root: Root;
let container: HTMLDivElement;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    // React reports every caught render error to the console itself.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    setHost({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

const alerts = () => Array.from(container.querySelectorAll('[role="alert"]'));
const buttonNamed = (name: string) =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === name);
const openDetails = () => act(() => buttonNamed('Details')!.click());

describe('message error boundary', () => {
    it('shows a short notice in place of the message that threw, with the ids and error under Details', () => {
        act(() => root.render(h('div', null, messageBoundary('run-1', 'hello'), messageBoundary('run-2', 'BOOM'), messageBoundary('run-3', 'after'))));

        expect(alerts()).toHaveLength(1);
        const notice = alerts()[0];
        expect(notice.textContent).toContain("This message couldn't be shown.");
        // Folded away until asked for.
        expect(notice.textContent).not.toContain('thread-1');
        expect(buttonNamed('Details')!.getAttribute('aria-expanded')).toBe('false');

        openDetails();
        expect(buttonNamed('Details')!.getAttribute('aria-expanded')).toBe('true');
        const terms = Array.from(notice.querySelectorAll('dt')).map((dt) => dt.textContent);
        const values = Array.from(notice.querySelectorAll('dd')).map((dd) => dd.textContent);
        expect(terms).toEqual(['Chat ID', 'Message ID', 'Error']);
        expect(values).toEqual(['thread-1', 'run-2', 'cannot render BOOM']);

        // The siblings still render.
        expect(container.querySelector('[data-message="hello"]')).not.toBeNull();
        expect(container.querySelector('[data-message="after"]')).not.toBeNull();
    });

    it('copies the ids and the error', async () => {
        act(() => root.render(messageBoundary('run-2', 'BOOM')));
        openDetails();
        await act(async () => buttonNamed('Copy details')!.click());
        expect(writeText).toHaveBeenCalledWith('Chat ID: thread-1\nMessage ID: run-2\nError: cannot render BOOM');
        expect(buttonNamed('Copied')).toBeDefined();
    });

    it('leaves out the ids it does not have', () => {
        act(() => root.render(messageBoundary('run-2', 'BOOM', null)));
        openDetails();
        expect(Array.from(alerts()[0].querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual(['Message ID', 'Error']);
    });

    it('names the error type in Details when it is more than a plain Error', () => {
        function Throws(): React.ReactElement {
            throw { name: 'SyntaxError', message: 'An invalid or illegal string was specified' };
        }
        act(() => root.render(h(RenderErrorBoundary, { scope: 'message', summary: 'Failed.' }, h(Throws))));
        openDetails();
        expect(alerts()[0].querySelector('dd')!.textContent).toBe('SyntaxError: An invalid or illegal string was specified');
    });

    it('logs the error once with its ids and component stack, however often it is retried', () => {
        act(() => root.render(messageBoundary('run-2', 'BOOM')));
        act(() => root.render(messageBoundary('run-2', 'BOOM again')));
        act(() => root.render(messageBoundary('run-2', 'BOOM again ')));
        const calls = vi.mocked(logger).mock.calls.filter(([message]) => String(message).startsWith('Render error'));
        // Three distinct messages, each logged once.
        expect(calls).toHaveLength(3);
        expect(calls[0][0]).toBe('Render error in message: cannot render BOOM');
        expect(calls[0][1]).toMatchObject({ threadId: 'thread-1', runId: 'run-2' });
        expect(String(calls[0][1].componentStack)).toContain('Message');
    });

    it('does not log a repeat of the same error from the same message', () => {
        let renders = 0;
        function Streaming({ frame }: { frame: number }) {
            renders = frame;
            throw new Error('cannot render');
        }
        for (const frame of [1, 2, 3]) {
            act(() => root.render(h(
                RenderErrorBoundary,
                { scope: 'message', summary: 'Failed.', threadId: 't', runId: 'r', resetKey: frame },
                h(Streaming, { frame }),
            )));
        }
        expect(renders).toBe(3);
        expect(vi.mocked(logger).mock.calls.filter(([message]) => String(message).startsWith('Render error'))).toHaveLength(1);
    });

    it('logs the same error again when it recurs on another thread', () => {
        const render = (threadId: string) => root.render(h(
            RenderErrorBoundary,
            { scope: 'thread', summary: 'Failed.', threadId, resetKey: threadId },
            h(Message, { text: 'BOOM' }),
        ));
        act(() => render('thread-1'));
        act(() => render('thread-2'));
        const threads = vi.mocked(logger).mock.calls
            .filter(([message]) => String(message).startsWith('Render error'))
            .map(([, details]) => details.threadId);
        expect(threads).toEqual(['thread-1', 'thread-2']);
    });

    it('keeps the notice, Details open, while the failed message updates without a new reset key', () => {
        const render = (text: string) => root.render(h(
            RenderErrorBoundary,
            { scope: 'message', summary: 'Failed.', runId: 'r', resetKey: 'in_progress' },
            h(Message, { text }),
        ));
        act(() => render('BOOM 1'));
        openDetails();
        act(() => render('BOOM 2'));
        expect(buttonNamed('Details')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('renders the message again once its input changes', () => {
        act(() => root.render(messageBoundary('run-2', 'BOOM')));
        expect(alerts()).toHaveLength(1);
        act(() => root.render(messageBoundary('run-2', 'fixed')));
        expect(alerts()).toHaveLength(0);
        expect(container.querySelector('[data-message="fixed"]')).not.toBeNull();
    });

    it('places the notice in the surface the caller gives it, with an action that can recover', () => {
        let broken = true;
        function Flaky() {
            if (broken) throw new Error('flaky');
            return h('p', { 'data-message': 'ok' }, 'ok');
        }
        act(() => root.render(h(
            RenderErrorBoundary,
            {
                scope: 'sidebar',
                summary: 'Failed.',
                layout: 'page',
                wrapFallback: (notice: React.ReactNode) => h('div', { id: 'surface' }, notice),
                actions: (reset: () => void) => h('button', { type: 'button', onClick: () => { broken = false; reset(); } }, 'New chat'),
            },
            h(Flaky),
        )));
        expect(container.querySelector('#surface .beaver-render-error-page')).not.toBeNull();
        expect(buttonNamed('Try again')).toBeUndefined();
        act(() => buttonNamed('New chat')!.click());
        expect(container.querySelector('[data-message="ok"]')).not.toBeNull();
    });

    it('reports through the host form, filled in with the ids and the error', () => {
        const reportRenderError = vi.fn();
        const openExternalUrl = vi.fn();
        setHost({ dialogs: { confirm: () => false, reportRenderError }, navigation: { openExternalUrl } as any });
        act(() => root.render(messageBoundary('run-2', 'BOOM')));
        expect(buttonNamed('Email support')).toBeUndefined();
        act(() => buttonNamed('Report problem')!.click());
        expect(reportRenderError).toHaveBeenCalledWith([
            'This message couldn\'t be shown.',
            'Chat ID: thread-1',
            'Message ID: run-2',
            'Error: cannot render BOOM',
            '',
            'What were you doing when this happened?',
            '',
        ].join('\n'));
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it('offers the support email, filled in, where there is no report form', () => {
        const openExternalUrl = vi.fn();
        setHost({ dialogs: { confirm: () => false, reportRenderError: vi.fn() }, navigation: { openExternalUrl } as any });
        act(() => root.render(h(RenderErrorBoundary, { scope: 'table', summary: 'Table failed.', reportable: false }, h(Message, { text: 'BOOM' }))));
        expect(buttonNamed('Report problem')).toBeUndefined();
        act(() => buttonNamed('Email support')!.click());
        const url = openExternalUrl.mock.calls[0][0] as string;
        expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
        expect(decodeURIComponent(url)).toContain('Error: cannot render BOOM\n\nWhat were you doing when this happened?');
    });

    it('offers no report action when the client has neither', () => {
        act(() => root.render(messageBoundary('run-2', 'BOOM')));
        expect(buttonNamed('Report problem')).toBeUndefined();
        expect(buttonNamed('Email support')).toBeUndefined();
        expect(buttonNamed('Details')).toBeDefined();
    });
});

describe('ErrorBoundary', () => {
    it('clears the error when the thread changes', () => {
        const render = (threadId: string, text: string) => root.render(h(
            ErrorBoundary,
            { resetKey: threadId, fallback: () => h('p', { role: 'alert' }, 'failed') },
            h(Message, { text }),
        ));
        act(() => render('thread-1', 'BOOM'));
        expect(alerts()).toHaveLength(1);
        act(() => render('thread-2', 'other thread'));
        expect(alerts()).toHaveLength(0);
        expect(container.querySelector('[data-message="other thread"]')).not.toBeNull();
    });

    it('keeps the fallback, without looping, when the update that changed a key is the one that threw', () => {
        let renders = 0;
        function Counting({ text }: { text: string }) {
            renders += 1;
            return h(Message, { text });
        }
        const render = (text: string) => root.render(h(
            ErrorBoundary,
            { resetKey: text, fallback: () => h('p', { role: 'alert' }, 'failed') },
            h(Counting, { text }),
        ));
        act(() => render('fine'));
        act(() => render('BOOM'));
        expect(alerts()).toHaveLength(1);
        // React renders a throwing component a bounded number of times, not forever.
        expect(renders).toBeLessThan(6);
    });

    it('renders no element of its own, so a static render is unchanged', () => {
        const tree = h('div', { className: 'markdown' }, h('p', null, 'text'));
        expect(renderToStaticMarkup(h(ErrorBoundary, { fallback: () => 'failed' }, tree))).toBe(renderToStaticMarkup(tree));
    });

    it('turns a thrown non-Error into an Error for the fallback', () => {
        function ThrowsDomLike(): React.ReactElement {
            throw { name: 'SyntaxError', message: 'An invalid or illegal string was specified' };
        }
        act(() => root.render(h(
            ErrorBoundary,
            { fallback: ({ error }) => h('p', { role: 'alert' }, `${error.name}: ${error.message}`) },
            h(ThrowsDomLike),
        )));
        expect(alerts()[0].textContent).toBe('SyntaxError: An invalid or illegal string was specified');
    });
});
