import { useCallback, useRef, useState } from 'react';

/** What {@link useOverflowCollapse} hands back to a row of controls. */
export interface OverflowCollapse {
    /** `0` for everything shown in full, up to the `maxLevel` the row asked for. */
    level: number;
    /** Attach to the row's container. Measurement follows the element, not renders. */
    ref: (element: HTMLElement | null) => void;
}

/**
 * How far a row of controls has had to collapse to fit its container.
 *
 * The caller decides what each level drops — typically a label that turns into
 * its icon — and must lay the row out so that its items overflow instead of
 * shrinking (`flex: none` + `white-space: nowrap`), since overflow is what
 * this measures: the level rises while the container's content is wider than
 * the container, and falls back once the container is at least as wide as the
 * content was when that level was needed. Remembering that width is what keeps
 * the result stable: without it, collapsing would make the row fit, which would
 * expand it again, which would overflow again.
 *
 * Measurement is subscribed to the element rather than run after renders. A
 * `ResizeObserver` reports the container changing size — the one event that may
 * let the row expand again — and a `MutationObserver` reports its content
 * changing under a fixed box (an item's name arriving in a label, a button
 * appearing), which may need it to collapse further. Both fire from the
 * browser, outside React's commit, so a level change here is an ordinary
 * update. The one exception is the measurement taken when the element attaches,
 * so a row that is already too narrow is drawn collapsed on its first paint.
 *
 * The state setter is called only when the level actually changes. A setter
 * called with the current value is not always free: while the component holds
 * a lower-priority update it has not rendered yet (a store subscription that
 * fired a moment ago), React cannot take its early exit and schedules a
 * synchronous re-render instead. Combined with a measurement that ran after
 * every render, that once looped until React aborted the tree. The level is
 * mirrored in a ref so the comparison happens before React is involved.
 */
export function useOverflowCollapse(maxLevel: number): OverflowCollapse {
    const [level, setLevel] = useState(0);
    // The level as last decided here, so consecutive observer callbacks build
    // on the decision before React has rendered it.
    const levelRef = useRef(0);
    // Content width at which each level overflowed; index = the level that
    // was showing at the time.
    const neededWidths = useRef<number[]>([]);
    const maxLevelRef = useRef(maxLevel);
    maxLevelRef.current = maxLevel;
    const subscription = useRef<{ element: HTMLElement; disconnect: () => void } | null>(null);

    const ref = useCallback((element: HTMLElement | null) => {
        if (subscription.current?.element === element) return;
        subscription.current?.disconnect();
        subscription.current = null;
        if (!element) return;
        const win = element.ownerDocument.defaultView;
        if (!win) return;

        const measure = (canLower: boolean) => {
            const available = element.clientWidth;
            const needed = element.scrollWidth;
            if (available === 0) return;
            const current = levelRef.current;
            let next = current;
            if (needed > available && current < maxLevelRef.current) {
                neededWidths.current[current] = needed;
                next = current + 1;
            } else if (canLower && current > 0 && available >= (neededWidths.current[current - 1] ?? Infinity)) {
                next = current - 1;
            } else if (current > maxLevelRef.current) {
                next = maxLevelRef.current;
            }
            if (next === current) return;
            levelRef.current = next;
            setLevel(next);
        };

        measure(false);

        const resize = new win.ResizeObserver(() => measure(true));
        resize.observe(element);
        const mutation = new win.MutationObserver(() => measure(false));
        mutation.observe(element, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden'],
        });

        subscription.current = {
            element,
            disconnect: () => {
                resize.disconnect();
                mutation.disconnect();
            },
        };
    }, []);

    return { level, ref };
}
