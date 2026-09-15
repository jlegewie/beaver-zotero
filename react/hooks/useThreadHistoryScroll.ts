import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ThreadHistory } from './useThreadHistory';

/** Keeps both history surfaces paging against their own scroll viewport. */
export function useThreadHistoryScroll(history: ThreadHistory, enabled = true) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const { viewKey, activeQuery, searchQuery, view, loadMore } = history;

    // A new search or scope starts at the top; appending a page never moves it.
    useLayoutEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [viewKey, activeQuery]);

    useEffect(() => {
        const root = scrollRef.current;
        const sentinel = sentinelRef.current;
        const win = root?.ownerDocument.defaultView;
        if (!enabled || !root || !sentinel || !win || searchQuery !== activeQuery
            || view.status !== 'ready' || view.error || !view.hasMore || !view.cursor) return;

        let requested = false;
        let disposed = false;
        const observer = new win.IntersectionObserver(entries => {
            if (disposed || requested || root.clientHeight === 0) return;
            if (entries.some(entry => entry.isIntersecting)) {
                requested = true;
                loadMore();
            }
        }, { root, rootMargin: '0px 0px 160px 0px' });
        observer.observe(sentinel);
        return () => {
            disposed = true;
            observer.disconnect();
        };
        // Re-observe after each page, including pages that still leave the
        // viewport underfilled. One observer may request only one page.
    }, [enabled, viewKey, activeQuery, searchQuery, view.status, view.error, view.hasMore, view.cursor, loadMore]);

    return { scrollRef, sentinelRef };
}
