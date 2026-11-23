import { act } from "react";
import { vi } from "vitest";

/**
 * Hovers `el` until its hover-layer peek opens (past the open delay), and
 * returns the open peek under `root`, or null.
 */
export function hoverPeek(el: Element, root: ParentNode): HTMLElement | null {
    vi.useFakeTimers();
    try {
        act(() => {
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
    } finally {
        vi.useRealTimers();
    }
    return root.querySelector<HTMLElement>(".bt-hover-peek");
}
