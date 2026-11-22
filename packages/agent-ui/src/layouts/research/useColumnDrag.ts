import type React from "react";
import { useEffect, useRef, useState } from "react";

import type { ColumnDrop } from "./cellModel";

/** How far the mouse moves before a press on a header becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
/** The band at the grid's left and right edges that scrolls it while dragging. */
const EDGE_PX = 48;
/** The fastest sideways scroll, in pixels a frame, at the very edge. */
const EDGE_SPEED_PX = 18;

const HEADER_SELECTOR = "th[data-column-drag]";

/**
 * Reordering question columns by dragging their headers. A press on a header
 * becomes a drag once the mouse moves: a faint copy of the header follows
 * the mouse along the header row, a line in the grid marks where the column
 * would land, and a release over the grid moves it there.
 * Released elsewhere, or with Escape, the column stays.
 * Near the grid's left or right edge the grid scrolls sideways.
 *
 * Mouse events rather than HTML drag and drop, which would carry the drag to
 * the surface's own drop targets (items dropped onto the table).
 *
 * `rootRef` is the grid, whose parent scrolls; its headers that may be
 * dragged carry `data-column-drag` and `data-column-id`, and the header row
 * takes the press handler. The line (`indicatorRef`) and the header's copy
 * (`ghostRef`, empty elements the grid renders) are drawn imperatively, so a
 * drag re-renders the grid only when it starts and ends.
 */
export function useColumnDrag({
    rootRef,
    indicatorRef,
    ghostRef,
    onMove,
}: {
    rootRef: React.RefObject<HTMLElement>;
    indicatorRef: React.RefObject<HTMLElement>;
    ghostRef: React.RefObject<HTMLElement>;
    /** Absent, no header can be dragged. */
    onMove?: (columnId: string, drop: ColumnDrop) => void;
}): {
    /** The column being dragged, once the press has become a drag. */
    dragging: string | null;
    /** The header row's press handler; undefined while dragging is off. */
    onHeadMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
} {
    const [dragging, setDragging] = useState<string | null>(null);
    const onMoveRef = useRef(onMove);
    onMoveRef.current = onMove;
    // Ends the drag in progress (on unmount, or when dragging is turned off).
    const stopRef = useRef<(() => void) | null>(null);
    useEffect(() => () => stopRef.current?.(), []);
    useEffect(() => {
        if (!onMove) stopRef.current?.();
    }, [!onMove]);

    if (!onMove) return { dragging: null };

    const onHeadMouseDown = (event: React.MouseEvent<HTMLElement>) => {
        const root = rootRef.current;
        const target = event.target as Element | null;
        const header = target?.closest?.(HEADER_SELECTOR) as HTMLElement | null;
        const columnId = header?.dataset.columnId;
        // The header's menu button keeps its own clicks.
        if (event.button !== 0 || !root || !header || !columnId || stopRef.current || target?.closest("button, [role='menu'], .rt-column-menu")) return;
        // No text selection starts from the header.
        event.preventDefault();
        const doc = root.ownerDocument;
        const win = doc.defaultView;
        const scroller = root.parentElement;
        const start = { x: event.clientX, y: event.clientY };
        let started = false;
        let lastX = start.x;
        let lastY = start.y;
        let drop: ColumnDrop | null = null;
        let frame: number | null = null;
        // Where in the header the press was, which the copy keeps under the mouse.
        const grab = event.clientX - header.getBoundingClientRect().left;

        // Where the questions start in view: past a pinned Paper column,
        // which they scroll under, else the grid's own left edge.
        const questionsLeft = (view: DOMRect) => {
            const paper = scroller?.hasAttribute("data-pinned") ? root.querySelector<HTMLElement>(".rt-th-paper") : null;
            return paper ? paper.getBoundingClientRect().right : view.left;
        };

        const headers = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(HEADER_SELECTOR) as ArrayLike<HTMLElement>);

        // The header's copy, in the header row under the mouse.
        const moveGhost = () => {
            const ghost = ghostRef.current;
            if (!ghost) return;
            const origin = root.getBoundingClientRect();
            ghost.style.left = `${lastX - grab - origin.left}px`;
            ghost.style.top = `${header.getBoundingClientRect().top - origin.top}px`;
        };

        // The gap the mouse is nearest, as a drop; null outside the grid and
        // where the column would not move (either side of itself).
        const place = () => {
            moveGhost();
            const indicator = indicatorRef.current;
            const view = (scroller ?? root).getBoundingClientRect();
            if (lastX < view.left || lastX > view.right || lastY < view.top || lastY > view.bottom) {
                drop = null;
                if (indicator) indicator.style.display = "none";
                return;
            }
            const all = headers();
            const ids = all.map((header) => header.dataset.columnId ?? "");
            const rects = all.map((header) => header.getBoundingClientRect());
            const gap = rects.filter((rect) => rect.left + rect.width / 2 < lastX).length;
            const from = ids.indexOf(columnId);
            drop = from === -1 || gap === from || gap === from + 1 ? null : gap < ids.length ? { before: ids[gap] } : { after: ids[ids.length - 1] };
            if (!indicator) return;
            if (!drop) {
                indicator.style.display = "none";
                return;
            }
            // Never drawn over the pinned Paper column, under which the
            // gap's own edge may have scrolled.
            const edge = Math.max(questionsLeft(view), gap < rects.length ? rects[gap].left : rects[rects.length - 1].right);
            indicator.style.left = `${edge - root.getBoundingClientRect().left}px`;
            indicator.style.display = "block";
        };

        // Sideways scrolling while the mouse rests near the grid's edge.
        const scrollStep = () => {
            frame = null;
            if (!scroller || !win) return;
            const view = scroller.getBoundingClientRect();
            const left = questionsLeft(view);
            const right = view.left + scroller.clientWidth;
            const step =
                lastX < left + EDGE_PX
                    ? -Math.ceil(EDGE_SPEED_PX * Math.min(1, (left + EDGE_PX - lastX) / EDGE_PX))
                    : lastX > right - EDGE_PX
                      ? Math.ceil(EDGE_SPEED_PX * Math.min(1, (lastX - (right - EDGE_PX)) / EDGE_PX))
                      : 0;
            if (!step) return;
            const before = scroller.scrollLeft;
            scroller.scrollLeft += step;
            if (scroller.scrollLeft === before) return;
            place();
            frame = win.requestAnimationFrame(scrollStep);
        };

        const onMouseMove = (move: MouseEvent) => {
            lastX = move.clientX;
            lastY = move.clientY;
            if (!started) {
                if (Math.abs(move.clientX - start.x) < DRAG_THRESHOLD_PX && Math.abs(move.clientY - start.y) < DRAG_THRESHOLD_PX) return;
                started = true;
                setDragging(columnId);
                const ghost = ghostRef.current;
                if (ghost) {
                    // The header's name, badges and question; not its menu button.
                    ghost.replaceChildren(
                        ...Array.from(header.children as ArrayLike<Element>)
                            .filter((child) => !child.classList.contains("rt-column-menu"))
                            .map((child) => child.cloneNode(true)),
                    );
                    const size = header.getBoundingClientRect();
                    ghost.style.width = `${size.width}px`;
                    ghost.style.height = `${size.height}px`;
                    ghost.style.display = "block";
                }
            }
            move.preventDefault();
            place();
            if (frame == null && win) frame = win.requestAnimationFrame(scrollStep);
        };

        const stop = () => {
            doc.removeEventListener("mousemove", onMouseMove, true);
            doc.removeEventListener("mouseup", onMouseUp, true);
            doc.removeEventListener("keydown", onKeyDown, true);
            if (frame != null) win?.cancelAnimationFrame(frame);
            frame = null;
            if (indicatorRef.current) indicatorRef.current.style.display = "none";
            if (ghostRef.current) {
                ghostRef.current.style.display = "none";
                ghostRef.current.replaceChildren();
            }
            stopRef.current = null;
            if (started) setDragging(null);
        };

        const onMouseUp = (up: MouseEvent) => {
            lastX = up.clientX;
            lastY = up.clientY;
            const wasDrag = started;
            if (wasDrag) place();
            const landed = drop;
            stop();
            if (!wasDrag) return;
            // The release ends a drag, not a click on whatever is under it:
            // the click it fires, if any, comes before the next task.
            const swallow = (click: Event) => {
                click.stopPropagation();
                doc.removeEventListener("click", swallow, true);
            };
            doc.addEventListener("click", swallow, true);
            win?.setTimeout(() => doc.removeEventListener("click", swallow, true), 0);
            if (landed) onMoveRef.current?.(columnId, landed);
        };

        const onKeyDown = (key: KeyboardEvent) => {
            if (key.key !== "Escape") return;
            if (started) {
                key.preventDefault();
                key.stopPropagation();
            }
            stop();
        };

        doc.addEventListener("mousemove", onMouseMove, true);
        doc.addEventListener("mouseup", onMouseUp, true);
        doc.addEventListener("keydown", onKeyDown, true);
        stopRef.current = stop;
    };

    return { dragging, onHeadMouseDown };
}
