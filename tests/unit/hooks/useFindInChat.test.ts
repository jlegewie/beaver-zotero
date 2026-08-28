// @vitest-environment jsdom

/**
 * How a find session tracks the hits the thread is showing.
 *
 * The session does not predict what the thread renders — it reads the marks the
 * renderers emitted and watches the container for more arriving or leaving.
 * That is what keeps the count honest when a collapsed section is opened
 * mid-search, or when a run finishes and is highlighted for the first time,
 * without the hook having to know which piece of state gated either.
 */
import React, { act } from 'react';
import { Provider } from 'jotai';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return {
        userScrolledAtom: atom(false),
        windowUserScrolledAtom: atom(false),
        isAtBottomAtom: atom(true),
        windowIsAtBottomAtom: atom(true),
    };
});

vi.mock('../../../react/atoms/threads', async () => {
    const { atom } = await import('jotai');
    const rememberedPosition = () => {
        const base = atom<number | undefined>(undefined);
        return atom(
            (get) => get(base),
            (_get, set, scrollTop: number | null) => set(base, scrollTop === null ? undefined : scrollTop),
        );
    };
    return {
        currentThreadIdAtom: atom<string | null>('thread-1'),
        currentThreadScrollPositionAtom: rememberedPosition(),
        windowScrollPositionAtom: rememberedPosition(),
    };
});

import { store } from '../../../react/store';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { currentThreadIdAtom } from '../../../react/atoms/threads';
import { FIND_CURRENT_CLASS, FIND_HIT_ATTR } from '@beaver/agent-ui/chat/findContext';
import { useFindInChat } from '../../../react/hooks/useFindInChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useFindInChat>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hook: Hook | null = null;
let thread: HTMLDivElement;

function Harness({ container }: { container: HTMLElement | null }) {
    hook = useFindInChat({ container, isWindow: false });
    return null;
}

/** A rendered find hit, as the chat renderers emit it. */
function hit(text: string): HTMLElement {
    const mark = document.createElement('mark');
    mark.setAttribute(FIND_HIT_ATTR, '');
    mark.textContent = text;
    return mark;
}

/**
 * Render the session against `container`.
 *
 * Through a Provider on the app's store: the hook reads its atoms with
 * `useAtomValue`, which would otherwise resolve to Jotai's default store and
 * see none of the state this file sets up.
 */
function mount(container: HTMLElement | null) {
    act(() => {
        root!.render(
            React.createElement(Provider, { store }, React.createElement(Harness, { container })),
        );
    });
}

/**
 * Let the observer deliver its records. They arrive as a microtask, so the
 * state it triggers settles a tick after the DOM was changed.
 */
async function settle() {
    await act(async () => {
        await Promise.resolve();
    });
}

/** Open the bar on `query` and let the debounce elapse. */
async function search(query: string) {
    act(() => {
        hook!.open();
        hook!.setQuery(query);
    });
    await act(async () => {
        vi.advanceTimersByTime(500);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    // The session closes itself in a thread with no runs, so it needs one.
    store.set(threadRunsAtom, [{ id: 'run-1', user_prompt: {} } as unknown as AgentRun]);
    store.set(currentThreadIdAtom, 'thread-1');

    thread = document.createElement('div');
    document.body.appendChild(thread);
    // jsdom lays nothing out, and a container reporting no height is treated as
    // one nobody is looking at.
    Object.defineProperty(thread, 'clientHeight', { value: 500, configurable: true });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mount(thread);
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    host?.remove();
    thread?.remove();
    root = null;
    host = null;
    hook = null;
    vi.useRealTimers();
});

describe('a find session counts what the thread is showing', () => {
    it('counts the hits already rendered when the search starts', async () => {
        thread.append(hit('alpha'), hit('alpha'));

        await search('alpha');

        expect(hook!.matchCount).toBe(2);
        expect(hook!.currentIndex).toBe(0);
        expect(thread.querySelectorAll(`.${FIND_CURRENT_CLASS}`).length).toBe(1);
    });

    it('picks up hits that appear later, without being told what revealed them', async () => {
        thread.append(hit('alpha'));
        await search('alpha');
        expect(hook!.matchCount).toBe(1);

        // A collapsed section opened, a finished run highlighted for the first
        // time: the session is told none of that, only that the thread changed.
        const revealed = document.createElement('div');
        revealed.append(hit('alpha'), hit('alpha'));
        thread.appendChild(revealed);
        await settle();

        expect(hook!.matchCount).toBe(3);
    });

    it('drops hits that leave the thread', async () => {
        const collapsible = document.createElement('div');
        collapsible.append(hit('alpha'));
        thread.append(hit('alpha'), collapsible);
        await search('alpha');
        expect(hook!.matchCount).toBe(2);

        collapsible.remove();
        await settle();

        expect(hook!.matchCount).toBe(1);
    });

    it('does not re-read the thread for changes that hold no hits', async () => {
        thread.append(hit('alpha'));
        await search('alpha');

        // Re-reading the thread means querying it, so the query is what is
        // counted here. Asserting on the resulting count instead would pass
        // either way: a re-read of an unchanged result set produces the numbers
        // it already had.
        const reads = vi.spyOn(thread, 'querySelectorAll');

        // A tooltip mounting under the pointer, a status line ticking over.
        const noise = document.createElement('div');
        noise.textContent = 'no hit here';
        thread.appendChild(noise);
        await settle();

        expect(reads).not.toHaveBeenCalled();
        expect(hook!.matchCount).toBe(1);

        // The same mutation carrying a hit is read, so the filter cannot be
        // passing by never running at all.
        thread.appendChild(hit('alpha'));
        await settle();

        expect(reads).toHaveBeenCalled();
        expect(hook!.matchCount).toBe(2);
        reads.mockRestore();
    });

    it('re-reads the thread when the container is replaced', async () => {
        thread.append(hit('alpha'), hit('alpha'));
        await search('alpha');
        expect(hook!.matchCount).toBe(2);

        // A thread load unmounts the container and mounts another one.
        const replacement = document.createElement('div');
        document.body.appendChild(replacement);
        Object.defineProperty(replacement, 'clientHeight', { value: 500, configurable: true });
        replacement.append(hit('alpha'));
        mount(replacement);
        await settle();

        expect(hook!.matchCount).toBe(1);
        replacement.remove();
    });

    it('leaves no highlight behind when the session closes', async () => {
        thread.append(hit('alpha'));
        await search('alpha');
        expect(thread.querySelectorAll(`.${FIND_CURRENT_CLASS}`).length).toBe(1);

        act(() => {
            hook!.close();
        });

        expect(hook!.matchCount).toBe(0);
        expect(thread.querySelectorAll(`.${FIND_CURRENT_CLASS}`).length).toBe(0);
    });
});
