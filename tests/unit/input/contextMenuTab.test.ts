// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextMenu from "@beaver/agent-ui/primitives/ContextMenu";
import type { MenuItem } from "@beaver/agent-ui/primitives/ContextMenu";

const OPTIONS: MenuItem[] = [
    { label: "Ask permission", onClick: vi.fn(), role: "menuitemradio" },
    { label: "Full access", onClick: vi.fn(), role: "menuitemradio" },
];

function pressTab(
    target: EventTarget,
    modifiers: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
) {
    const event = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
        shiftKey: modifiers.shiftKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
        altKey: modifiers.altKey ?? false,
        metaKey: modifiers.metaKey ?? false,
    });
    act(() => {
        target.dispatchEvent(event);
    });
    return event;
}

describe("ContextMenu tab order", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    function mount(footer?: React.ReactNode) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root?.render(
                React.createElement(ContextMenu, {
                    isOpen: true,
                    onClose: vi.fn(),
                    position: { x: 0, y: 0 },
                    menuItems: OPTIONS,
                    footer,
                }),
            );
        });
        return [...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    }

    it("tabs through every option before the footer", () => {
        const items = mount(
            React.createElement(
                "button",
                { type: "button" },
                "Settings → Permissions",
            ),
        );
        expect(items).toHaveLength(2);
        expect(document.activeElement).toBe(items[0]);

        const toFullAccess = pressTab(items[0]);
        expect(toFullAccess.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(items[1]);
        expect(items[1].getAttribute("aria-label")).toBe("Full access");

        // Last option: leave Tab to the browser so it lands on the footer.
        const toFooter = pressTab(items[1]);
        expect(toFooter.defaultPrevented).toBe(false);
        expect(items[1].tabIndex).toBe(0);
        expect(items[0].tabIndex).toBe(-1);
    });

    it("shift-tabs back through the options", () => {
        const items = mount(
            React.createElement(
                "button",
                { type: "button" },
                "Settings → Permissions",
            ),
        );
        pressTab(items[0]);
        expect(document.activeElement).toBe(items[1]);

        const back = pressTab(items[1], { shiftKey: true });
        expect(back.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(items[0]);
    });

    it("lets Tab leave a menu that has no footer", () => {
        const items = mount();
        const event = pressTab(items[0]);
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(items[0]);
    });

    it("leaves Ctrl/Alt/Meta+Tab to the host", () => {
        const items = mount(
            React.createElement(
                "button",
                { type: "button" },
                "Settings → Permissions",
            ),
        );
        for (const modifiers of [
            { ctrlKey: true },
            { altKey: true },
            { metaKey: true },
            { ctrlKey: true, shiftKey: true },
        ]) {
            const event = pressTab(items[0], modifiers);
            expect(event.defaultPrevented).toBe(false);
            expect(document.activeElement).toBe(items[0]);
        }
    });
});
