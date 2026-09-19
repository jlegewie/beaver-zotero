// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { atom, createStore, Provider } from "jotai";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ validate: vi.fn(), popup: vi.fn() }));
vi.mock("../../../react/atoms/profile", () => ({
    searchableLibraryIdsAtom: atom([1]),
}));
vi.mock("../../../react/hooks/useAttachExternalFiles", () => ({
    useAttachExternalFiles: () => vi.fn(),
}));
vi.mock("../../../react/types/attachments/converters", () => ({
    toValidatedMessageAttachment: mocks.validate,
    externalFileRecordToAttachment: vi.fn(),
}));
vi.mock("../../../react/utils/popupMessageUtils", () => ({
    addPopupMessageAtom: atom(null, (_get, _set, value) => mocks.popup(value)),
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    libraryRefForLibraryID: () => "u",
}));
vi.mock("../../../src/utils/zoteroSerializers", () => ({
    serializeCollection: vi.fn(),
    serializeZoteroLibrary: vi.fn(),
}));
vi.mock("../../../src/utils/zoteroUtils", () => ({
    loadFullItemData: vi.fn(async () => {}),
}));
vi.mock("../../../react/components/ui/menus/AddSourcesMenu", async () => {
    const { createElement, forwardRef } = await import("react");
    return {
        default: forwardRef(function MockSourcesMenu({ target }: any, _ref) {
            return createElement(
                "button",
                {
                    onClick: () =>
                        target.addItem({ libraryID: 1, key: "ABCDEFGH" }),
                },
                "Select table",
            );
        }),
    };
});

import { RequestSourcesMenu } from "../../../react/components/ui/menus/RequestSourcesMenu";
import type { RequestSourcesMenuProps } from "@beaver/agent-ui/host/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("reports failed table picks, releases the pending hold, and permits retry without changing existing edits", async () => {
    mocks.validate.mockRejectedValueOnce(
        new Error("Table unavailable (file_missing)."),
    );
    const added = vi.fn();
    const removed = vi.fn();
    const pending = vi.fn();
    const existing = {
        type: "table" as const,
        reference: {
            kind: "table" as const,
            key: "u-EXISTING",
            title: "Existing table",
        },
    };
    const props: RequestSourcesMenuProps = {
        attachments: [existing],
        filters: null,
        editSessionId: 7,
        onAddAttachments: added,
        onRemoveAttachment: removed,
        onFiltersChange: vi.fn(),
        onPendingChange: pending,
        isMenuOpen: true,
        menuPosition: { x: 0, y: 0 },
        searchQuery: "table",
        querySource: "menu",
        menuRef: { current: null },
        onQueryChange: vi.fn(),
        onOpen: vi.fn(),
        onDismiss: vi.fn(),
        onCommit: vi.fn(),
        onResetQuery: vi.fn(),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () =>
            root.render(
                React.createElement(
                    Provider,
                    { store: createStore() },
                    React.createElement(RequestSourcesMenu, props),
                ),
            ),
        );
        await act(async () => container.querySelector("button")!.click());
        expect(mocks.popup).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "error",
                title: "Unable to add source",
                text: expect.stringContaining(
                    "Table unavailable (file_missing).",
                ),
            }),
        );
        expect(added).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
        expect(props.attachments).toEqual([existing]);
        expect(pending).toHaveBeenLastCalledWith(false);

        const restored = {
            type: "table",
            reference: {
                kind: "table",
                key: "u-ABCDEFGH",
                title: "Restored table",
            },
        };
        mocks.validate.mockResolvedValueOnce(restored);
        await act(async () => container.querySelector("button")!.click());
        expect(added).toHaveBeenCalledExactlyOnceWith([restored], 7);
        expect(pending).toHaveBeenLastCalledWith(false);
    } finally {
        act(() => root.unmount());
        container.remove();
    }
});
