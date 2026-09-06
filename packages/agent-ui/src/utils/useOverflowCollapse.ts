import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useIsomorphicLayoutEffect } from './useIsomorphicLayoutEffect';

/**
 * How far a row of controls has had to collapse to fit its container.
 *
 * Returns a level from `0` (everything shown in full) up to `maxLevel`. The
 * caller decides what each level drops — typically a label that turns into
 * its icon — and must lay the row out so that its items overflow instead of
 * shrinking (`flex: none` + `white-space: nowrap`), since overflow is what
 * this measures: the level rises while the container's content is wider than
 * the container, and falls back once the container is at least as wide as the
 * content was when that level was needed.
 *
 * Remembering the width each level was needed at is what keeps the result
 * stable: without it, collapsing would make the row fit, which would expand it
 * again, which would overflow again. The row is re-measured after every render
 * (its content changes without its box changing) and whenever the container
 * resizes. The container may mount later than the component, or be swapped,
 * so the resize observer follows whatever element the ref currently holds.
 */
export function useOverflowCollapse(ref: RefObject<HTMLElement | null>, maxLevel: number): number {
    const [level, setLevel] = useState(0);
    // Content width at which each level overflowed; index = the level that
    // was showing at the time.
    const neededWidths = useRef<number[]>([]);
    const maxLevelRef = useRef(maxLevel);
    maxLevelRef.current = maxLevel;
    const observed = useRef<{ element: HTMLElement; observer: ResizeObserver } | null>(null);

    const measure = (element: HTMLElement) => {
        const available = element.clientWidth;
        const needed = element.scrollWidth;
        if (available === 0) return;
        setLevel((current) => {
            if (needed > available && current < maxLevelRef.current) {
                neededWidths.current[current] = needed;
                return current + 1;
            }
            if (current > 0 && available >= (neededWidths.current[current - 1] ?? Infinity)) {
                return current - 1;
            }
            if (current > maxLevelRef.current) return maxLevelRef.current;
            return current;
        });
    };

    useIsomorphicLayoutEffect(() => {
        const element = ref.current;
        if (element) measure(element);
        if (observed.current?.element === element) return;
        observed.current?.observer.disconnect();
        observed.current = null;
        if (!element) return;
        const ResizeObserverCtor = element.ownerDocument.defaultView?.ResizeObserver;
        if (!ResizeObserverCtor) return;
        const observer = new ResizeObserverCtor(() => measure(element));
        observer.observe(element);
        observed.current = { element, observer };
    });

    useIsomorphicLayoutEffect(() => () => {
        observed.current?.observer.disconnect();
        observed.current = null;
    }, []);

    return level;
}
