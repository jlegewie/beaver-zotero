import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks an element's border-box width.
 *
 * For layout that has to answer to the sidebar the user drags rather than to
 * the viewport. Returns `null` until the element is mounted and measured, so a
 * caller decides for itself what to show while the width is unknown.
 *
 * Both the first measurement and every later one read the border box, so a
 * caller's threshold means one thing whether or not the element ever picks up
 * padding or a border.
 *
 * The observer is constructed from the element's own document: Beaver renders
 * into the main window's item pane, its context pane and a separate Beaver
 * window, and the bare `window` global is none of them.
 */
export function useElementWidth<T extends HTMLElement>(): [
    (element: T | null) => void,
    number | null,
] {
    const [width, setWidth] = useState<number | null>(null);
    const observerRef = useRef<ResizeObserver | null>(null);

    const measuredRef = useCallback((element: T | null) => {
        observerRef.current?.disconnect();
        observerRef.current = null;

        if (!element) {
            setWidth(null);
            return;
        }

        setWidth(element.getBoundingClientRect().width);

        const ResizeObserverCtor = element.ownerDocument.defaultView?.ResizeObserver;
        if (!ResizeObserverCtor) return;
        const observer = new ResizeObserverCtor((entries) => {
            // `contentRect` is the content box; read the element instead so the
            // value matches the one taken above. Inside the callback the layout
            // is already up to date, so this forces no extra reflow.
            if (entries.length > 0) setWidth(element.getBoundingClientRect().width);
        });
        observer.observe(element);
        observerRef.current = observer;
    }, []);

    // The ref callback disconnects on its own when the element goes away, but
    // not when the whole tree is torn down without one final `null` call.
    useEffect(() => () => {
        observerRef.current?.disconnect();
        observerRef.current = null;
    }, []);

    return [measuredRef, width];
}

export default useElementWidth;
