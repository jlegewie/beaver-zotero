// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadHistoryScroll } from '../../../react/hooks/useThreadHistoryScroll';
import type { ThreadHistory } from '../../../react/hooks/useThreadHistory';

let observers: { notify: (visible: boolean) => void; disconnect: ReturnType<typeof vi.fn>; options: IntersectionObserverInit }[];
let root: Root;
let container: HTMLDivElement;
let history: ThreadHistory;
function Harness({ enabled = true }) {
    const { scrollRef, sentinelRef } = useThreadHistoryScroll(history, enabled);
    return React.createElement('div', { ref: scrollRef }, React.createElement('div', { ref: sentinelRef }));
}
function render(enabled = true) {
    act(() => root.render(React.createElement(Harness, { enabled })));
}
function notify(visible = true) {
    act(() => observers.at(-1)!.notify(visible));
}

beforeEach(() => {
    observers = [];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
            observers.push({
                notify: visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
                disconnect: this.disconnect,
                options,
            });
        }
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    history = {
        viewKey: 'all', activeQuery: '', searchQuery: '', loadMore: vi.fn(),
        view: { status: 'ready', hasMore: true, cursor: 'page-2', error: null },
    } as unknown as ThreadHistory;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('continuous thread history', () => {
    it('prefetches inside its own viewport and admits only one request per page', () => {
        render();
        expect(observers[0].options.root).toBe(container.firstElementChild);
        expect(observers[0].options.rootMargin).toBe('0px 0px 160px 0px');
        notify(false);
        expect(history.loadMore).not.toHaveBeenCalled();
        notify();
        notify();
        expect(history.loadMore).toHaveBeenCalledTimes(1);
    });
    it('keeps filling an underfilled viewport after the next page arrives', () => {
        render();
        notify();
        history.view = { ...history.view, status: 'loading' };
        render();
        expect(observers[0].disconnect).toHaveBeenCalled();
        history.view = { ...history.view, status: 'ready', cursor: 'page-3' };
        render();
        notify();
        expect(history.loadMore).toHaveBeenCalledTimes(2);
    });
    it.each(['loading', 'error', 'idle'] as const)('does not page while %s', status => {
        history.view.status = status;
        render();
        expect(observers).toHaveLength(0);
    });
    it('stops at the last page and ignores callbacks queued before cleanup', () => {
        render();
        history.view = { ...history.view, hasMore: false, cursor: null };
        render();
        notify();
        expect(history.loadMore).not.toHaveBeenCalled();
    });
    it('pauses during a debounced search and resets scroll only for a changed view', () => {
        render();
        const scroll = container.firstElementChild as HTMLDivElement;
        scroll.scrollTop = 500;
        history.view = { ...history.view, cursor: 'page-3' };
        render();
        expect(scroll.scrollTop).toBe(500);
        history.searchQuery = 'new';
        render();
        notify();
        expect(history.loadMore).not.toHaveBeenCalled();
        history.activeQuery = 'new';
        history.viewKey = 'search:new';
        render();
        expect(scroll.scrollTop).toBe(0);
    });
    it('pauses a collapsed sidebar and resumes when expanded', () => {
        render(false);
        expect(observers).toHaveLength(0);
        render();
        notify();
        expect(history.loadMore).toHaveBeenCalledTimes(1);
    });
    it('does not page an invisible viewport', () => {
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0);
        render();
        notify();
        expect(history.loadMore).not.toHaveBeenCalled();
    });
});
