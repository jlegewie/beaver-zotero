// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextMenu from "@beaver/agent-ui/primitives/ContextMenu";

describe("ContextMenu placement", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.restoreAllMocks();
    });

    /**
     * Opens a menu at `x` inside a surface whose right edge is `right`. Every
     * other element (the menu, its items, a submenu) measures 0–160 px.
     */
    function open(x: number, bounded: boolean, right = 1000): HTMLElement {
        container = document.createElement("div");
        if (bounded) container.setAttribute("data-menu-bounds", "");
        document.body.appendChild(container);
        vi.spyOn(window, "innerWidth", "get").mockReturnValue(1800);
        vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect",
        ).mockImplementation(function (this: HTMLElement) {
            const box =
                this === container
                    ? { left: 0, right }
                    : { left: 0, right: 160 };
            return {
                ...box,
                top: 0,
                bottom: 100,
                width: box.right - box.left,
                height: 100,
                x: box.left,
                y: 0,
                toJSON() {},
            } as DOMRect;
        });
        root = createRoot(container);
        act(() => {
            root?.render(
                React.createElement(ContextMenu, {
                    isOpen: true,
                    onClose: vi.fn(),
                    position: { x, y: 0 },
                    menuItems: [
                        { label: "Remove from table", onClick: vi.fn() },
                        {
                            label: "Change type",
                            onClick: vi.fn(),
                            submenu: [{ label: "Text", onClick: vi.fn() }],
                        },
                    ],
                }),
            );
        });
        return container.querySelector<HTMLElement>('[role="menu"]')!;
    }

    it("stays inside the surface that marks its bounds, not just the window", () => {
        // 950 + 160 passes the surface's 1000 px edge: pulled back to end 8 px inside it.
        expect(open(950, true).style.left).toBe("832px");
    });

    it("keeps to the window elsewhere", () => {
        expect(open(950, false).style.left).toBe("950px");
    });

    it("keeps a submenu inside the surface too", () => {
        open(0, true, 300);
        const parent = Array.from(
            container!.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ).find((item) => item.getAttribute("aria-label") === "Change type")!;
        act(() => parent.click());
        const submenu =
            container!.querySelectorAll<HTMLElement>('[role="menu"]')[1];
        // Beside the item (164 + 160) passes the 292 px limit, and there is no
        // room on its left: held against the surface's edge.
        expect(submenu.style.left).toBe("132px");
    });
});
