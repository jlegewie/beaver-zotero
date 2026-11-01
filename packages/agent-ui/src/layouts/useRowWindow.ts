import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Row } from "@beaver/agent-core/layouts/table";

/**
 * The slice of rows a windowed grid puts in the DOM, and the space the rows
 * above and below it take, which the grid fills with one spacer row each so
 * the scrollbar measures the whole table.
 */
export interface RowWindow {
    start: number;
    /** Exclusive. */
    end: number;
    padTop: number;
    padBottom: number;
}

/** Rows rendered before anything has been measured. */
const INITIAL_ROWS = 24;
/** Height assumed for a row nobody has measured yet, before the first measure. */
const FALLBACK_ROW_PX = 60;
/** Extra content kept rendered beyond each edge of the viewport. */
const MIN_OVERSCAN_PX = 600;
/**
 * Window edges snap to this many rows. One: rows are memoised, so a shift
 * renders only the rows entering the window, and a frame that mounts one row
 * is cheaper than every fourth frame mounting four.
 */
const STEP = 1;

export interface UseRowWindowOptions {
    enabled: boolean;
    /** Rows in display order. */
    rows: Row[];
    /** The grid root; its closest `.bt-scroll` ancestor is the viewport. */
    rootRef: React.RefObject<HTMLElement | null>;
    /** The `<tbody>` whose direct `<tr>`s are measured. */
    bodyRef: React.RefObject<HTMLTableSectionElement | null>;
    /**
     * What row heights depend on besides the rows (density, visible columns).
     * A change forgets every measured height, so rows not on screen are not
     * counted at the old layout's height.
     */
    layoutKey?: string;
}

function fullWindow(rows: Row[]): RowWindow {
    return { start: 0, end: rows.length, padTop: 0, padBottom: 0 };
}

function sameWindow(a: RowWindow, b: RowWindow): boolean {
    return (
        a.start === b.start &&
        a.end === b.end &&
        Math.abs(a.padTop - b.padTop) < 0.5 &&
        Math.abs(a.padBottom - b.padBottom) < 0.5
    );
}

/**
 * Row windowing for a long table: only the rows near the viewport are in the
 * DOM, so a thousand tall rows open as fast as forty.
 *
 * Rows are nearly uniform (the density fixes their height), but nothing here
 * assumes it: every rendered row is measured after the commit and
 * remembered by row id, and a row not yet
 * measured counts as the height of the first one that was. The window is
 * recomputed from those heights on scroll, on resize (after measuring the
 * rows on screen again, since a narrower viewport rewraps them without a
 * render), and after every render, so filters, sorts and a changed spec all
 * settle before paint.
 *
 * The scroll handler commits synchronously (`flushSync`): a scroll that
 * reached a spacer before React rendered the rows behind it would paint a
 * blank band. That also keeps it independent of `requestAnimationFrame`, which
 * Gecko suspends in an occluded window.
 *
 * Disabled, or with no `.bt-scroll` ancestor to measure against, every row is
 * rendered.
 */
export function useRowWindow({
    enabled,
    rows,
    rootRef,
    bodyRef,
    layoutKey = '',
}: UseRowWindowOptions): RowWindow {
    const [win, setWin] = useState<RowWindow>(() =>
        enabled
            ? {
                  start: 0,
                  end: Math.min(rows.length, INITIAL_ROWS),
                  padTop: 0,
                  padBottom:
                      Math.max(0, rows.length - INITIAL_ROWS) * FALLBACK_ROW_PX,
              }
            : fullWindow(rows),
    );
    const winRef = useRef(win);
    winRef.current = win;
    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    const heights = useRef(new Map<string, number>());
    const estimate = useRef(0);
    const measuredFor = useRef(layoutKey);
    if (measuredFor.current !== layoutKey) {
        measuredFor.current = layoutKey;
        heights.current = new Map();
        estimate.current = 0;
    }
    const scrollerRef = useRef<HTMLElement | null>(null);

    const compute = (): RowWindow => {
        const list = rowsRef.current;
        const scroller = scrollerRef.current;
        const body = bodyRef.current;
        if (!enabled || !scroller || !body) return fullWindow(list);

        const est = estimate.current || FALLBACK_ROW_PX;
        const offsets = new Array<number>(list.length + 1);
        offsets[0] = 0;
        for (let i = 0; i < list.length; i++) {
            offsets[i + 1] = offsets[i] + (heights.current.get(list[i].id) ?? est);
        }
        const total = offsets[list.length];

        const viewport = scroller.clientHeight || 800;
        const overscan = Math.max(MIN_OVERSCAN_PX, viewport);
        // Where the body starts inside the scrolled content: below the sticky
        // header and whatever the surface puts above the table.
        const bodyTop =
            body.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop;
        const from = scroller.scrollTop - bodyTop - overscan;
        const to = scroller.scrollTop - bodyTop + viewport + overscan;

        let start = 0;
        while (start < list.length && offsets[start + 1] <= from) start++;
        let end = start;
        while (end < list.length && offsets[end] < to) end++;
        start = Math.max(0, Math.floor(start / STEP) * STEP);
        end = Math.min(list.length, Math.ceil(end / STEP) * STEP);
        return {
            start,
            end,
            padTop: offsets[start],
            padBottom: total - offsets[end],
        };
    };

    /** Remembers the height of every row now in the DOM. */
    const measure = () => {
        const body = bodyRef.current;
        if (!body) return;
        for (const tr of Array.from(body.children) as HTMLElement[]) {
            const rowId = tr.getAttribute("data-row-id");
            const h = tr.offsetHeight;
            if (!rowId || h <= 0) continue;
            heights.current.set(rowId, h);
            if (!estimate.current) estimate.current = h;
        }
    };

    const update = (sync: boolean) => {
        const next = compute();
        if (sameWindow(next, winRef.current)) return;
        winRef.current = next;
        if (sync) flushSync(() => setWin(next));
        else setWin(next);
    };

    // Viewport subscriptions. Re-attached only when windowing is switched.
    useLayoutEffect(() => {
        const root = rootRef.current;
        const scroller = enabled
            ? (root?.closest(".bt-scroll") as HTMLElement | null)
            : null;
        scrollerRef.current = scroller;
        if (!scroller) {
            update(false);
            return;
        }
        const onScroll = () => update(true);
        // A resize can rewrap the rows on screen without a render, so their
        // heights are read again before the window is recomputed from them.
        const onResize = () => {
            measure();
            update(false);
        };
        scroller.addEventListener("scroll", onScroll, { passive: true });
        const view = scroller.ownerDocument.defaultView;
        view?.addEventListener("resize", onResize);
        const Observer = (
            view as { ResizeObserver?: typeof ResizeObserver } | null
        )?.ResizeObserver;
        const observer = Observer ? new Observer(onResize) : null;
        observer?.observe(scroller);
        return () => {
            scroller.removeEventListener("scroll", onScroll);
            view?.removeEventListener("resize", onResize);
            observer?.disconnect();
            scrollerRef.current = null;
        };
        // `measure` and `update` read everything through refs, so only the
        // switch matters.
    }, [enabled]);

    // After every commit: measure what is on screen, then settle the window.
    // A changed height or a different window re-renders before paint; an
    // unchanged one stops here, so this cannot loop.
    useLayoutEffect(() => {
        if (!enabled || !scrollerRef.current) return;
        measure();
        update(false);
    });

    return enabled ? win : fullWindow(rows);
}
