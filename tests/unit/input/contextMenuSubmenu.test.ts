// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextMenu from "@beaver/agent-ui/primitives/ContextMenu";
import type { MenuItem } from "@beaver/agent-ui/primitives/ContextMenu";

function press(target: EventTarget, key: string, modifiers: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    act(() => {
        target.dispatchEvent(event);
    });
    return event;
}

describe("ContextMenu submenus", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    function mount(menuItems: MenuItem[], onClose = vi.fn()) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root?.render(
                React.createElement(ContextMenu, {
                    isOpen: true,
                    onClose,
                    position: { x: 0, y: 0 },
                    menuItems,
                }),
            );
        });
        return onClose;
    }

    const items = () => [...container!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const byLabel = (label: string) => items().find(item => item.getAttribute("aria-label") === label);

    function exportMenu() {
        const word = vi.fn();
        const pdf = vi.fn();
        const parentClick = vi.fn();
        const menuItems: MenuItem[] = [
            { label: "Copy", onClick: vi.fn() },
            {
                label: "Export",
                onClick: parentClick,
                submenu: [
                    { label: "Word…", onClick: word },
                    { label: "PDF…", onClick: pdf },
                ],
            },
        ];
        return { menuItems, word, pdf, parentClick };
    }

    it("opens the submenu on click without closing the menu or running the parent's action", () => {
        const { menuItems, parentClick } = exportMenu();
        const onClose = mount(menuItems);
        expect(byLabel("Word…")).toBeUndefined();

        act(() => byLabel("Export")!.click());

        expect(byLabel("Word…")).toBeDefined();
        expect(byLabel("Export")!.getAttribute("aria-expanded")).toBe("true");
        expect(parentClick).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("runs a submenu item and closes the whole menu", () => {
        const { menuItems, pdf } = exportMenu();
        const onClose = mount(menuItems);
        act(() => byLabel("Export")!.click());

        act(() => byLabel("PDF…")!.click());

        expect(pdf).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("is reachable by keyboard: ArrowRight enters, Enter chooses", () => {
        const { menuItems, word } = exportMenu();
        const onClose = mount(menuItems);
        press(document.activeElement!, "ArrowDown");
        expect(document.activeElement).toBe(byLabel("Export"));

        press(document.activeElement!, "ArrowRight");
        expect(document.activeElement).toBe(byLabel("Word…"));

        press(document.activeElement!, "Enter");
        expect(word).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape closes only the submenu and returns focus to its parent", () => {
        const { menuItems } = exportMenu();
        const onClose = mount(menuItems);
        press(document.activeElement!, "ArrowDown");
        press(document.activeElement!, "Enter");
        expect(document.activeElement).toBe(byLabel("Word…"));

        press(document.activeElement!, "Escape");

        expect(byLabel("Word…")).toBeUndefined();
        expect(onClose).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(byLabel("Export"));
    });

    it("keeps Tab in the submenu but leaves modified Tab to host shortcuts", () => {
        const { menuItems } = exportMenu();
        mount(menuItems);
        press(document.activeElement!, "ArrowDown");
        press(document.activeElement!, "ArrowRight");
        const word = byLabel("Word…")!;
        expect(document.activeElement).toBe(word);

        expect(press(word, "Tab").defaultPrevented).toBe(true);
        expect(press(word, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
        expect(press(word, "Tab", { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(press(word, "Tab", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
        expect(press(word, "Tab", { altKey: true }).defaultPrevented).toBe(false);
        expect(press(word, "Tab", { metaKey: true }).defaultPrevented).toBe(false);
        expect(byLabel("Word…")).toBeDefined();
    });

    it("shows a shortcut hint after the label and announces it in ARIA key syntax", () => {
        mount([
            { label: "Find in chat", shortcut: "⌘F", ariaKeyShortcuts: "Meta+F", onClick: vi.fn() },
            { label: "Find elsewhere", shortcut: "Ctrl+F", ariaKeyShortcuts: "Control+F", onClick: vi.fn() },
            { label: "Hint only", shortcut: "⌘K", onClick: vi.fn() },
        ]);
        const mac = byLabel("Find in chat")!;
        expect(mac.textContent).toBe("Find in chat⌘F");
        expect(mac.getAttribute("aria-keyshortcuts")).toBe("Meta+F");
        expect(byLabel("Find elsewhere")!.getAttribute("aria-keyshortcuts")).toBe("Control+F");
        // A display glyph is never used as the ARIA value.
        expect(byLabel("Hint only")!.hasAttribute("aria-keyshortcuts")).toBe(false);
    });

    it("does not open the submenu of a disabled item", () => {
        const { menuItems } = exportMenu();
        menuItems[1].disabled = true;
        mount(menuItems);

        act(() => byLabel("Export")!.click());

        expect(byLabel("Word…")).toBeUndefined();
    });
});
