// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import SearchMenu, { menuSideWithRoom } from "@beaver/agent-ui/primitives/SearchMenu";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("menuSideWithRoom", () => {
    const viewport = 800;
    const menu = 300;

    it("keeps the preferred side when the menu fits there", () => {
        expect(menuSideWithRoom("above", { top: 500, bottom: 520 }, viewport, menu)).toBe("above");
        expect(menuSideWithRoom("below", { top: 100, bottom: 120 }, viewport, menu)).toBe("below");
    });

    it("opens below a trigger near the top of a short window", () => {
        expect(menuSideWithRoom("above", { top: 120, bottom: 140 }, viewport, menu)).toBe("below");
    });

    it("opens above a trigger near the bottom when below is shorter", () => {
        expect(menuSideWithRoom("below", { top: 700, bottom: 720 }, viewport, menu)).toBe("above");
    });

    it("stays on the preferred side when neither side fits but it has more room", () => {
        expect(menuSideWithRoom("above", { top: 250, bottom: 270 }, 400, menu)).toBe("above");
    });
});

describe("SearchMenu placement", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
    });

    it("keeps a menu opened above its anchor inside the window", () => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root?.render(
                React.createElement(SearchMenu, {
                    menuItems: [{ label: "Add Tag", onClick: vi.fn() }],
                    isOpen: true,
                    onClose: vi.fn(),
                    // An anchor above the top edge: placing the menu above it
                    // would put every row out of reach.
                    position: { x: 20, y: -120 },
                    verticalPosition: "above",
                    useFixedPosition: true,
                    onSearch: vi.fn(),
                    noResultsText: "No results",
                    placeholder: "",
                    searchQuery: "",
                    setSearchQuery: vi.fn(),
                    showSearchInput: false,
                }),
            );
        });
        const menu = container.querySelector<HTMLElement>('[role="menu"]');
        expect(menu).not.toBeNull();
        expect(parseFloat(menu!.style.top)).toBeGreaterThanOrEqual(8);
    });
});
