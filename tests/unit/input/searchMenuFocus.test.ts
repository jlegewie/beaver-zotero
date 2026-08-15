// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import SearchMenu, {
    SearchMenuItem,
} from "@beaver/agent-ui/primitives/SearchMenu";

const menuItems: SearchMenuItem[] = [
    {
        label: "Libraries",
        onClick: vi.fn(),
    },
];

describe("SearchMenu focus", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    it("keeps focus in the external search editor when a menu row is clicked", () => {
        const editor = document.createElement("input");
        document.body.appendChild(editor);
        editor.focus();

        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root?.render(
                React.createElement(SearchMenu, {
                    menuItems,
                    isOpen: true,
                    onClose: vi.fn(),
                    position: { x: 0, y: 0 },
                    verticalPosition: "below",
                    onSearch: vi.fn(),
                    noResultsText: "No results",
                    placeholder: "",
                    searchQuery: "",
                    setSearchQuery: vi.fn(),
                    showSearchInput: false,
                }),
            );
        });

        const row = container.querySelector<HTMLElement>('[role="menuitem"]');
        expect(row).not.toBeNull();

        const mouseDown = new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
        });
        act(() => {
            row?.dispatchEvent(mouseDown);
            row?.click();
        });

        expect(mouseDown.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(editor);
        expect(menuItems[0].onClick).toHaveBeenCalledOnce();

        editor.remove();
    });
});
