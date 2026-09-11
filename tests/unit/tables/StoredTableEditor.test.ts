// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    open: vi.fn(),
    edit: vi.fn(),
    revert: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    runtime: {},
}));
vi.mock("../../../src/services/artifacts/tableStore", () => ({
    openTable: mocks.open,
    editTable: mocks.edit,
    revertTable: mocks.revert,
    TABLE_UPDATED_EVENT: "table-updated",
}));
vi.mock("../../../react/runtime/SurfaceWindowContext", () => ({
    useSurfaceWindow: () => globalThis.window,
}));
vi.mock("../../../react/runtime/windowRuntime", () => ({
    getWindowRuntime: () => mocks.runtime,
}));
vi.mock("../../../react/components/tables/TableWindowView", () => ({
    TableSnapshotView: () => null,
}));
vi.mock("../../../react/components/messages/MarkdownRenderer", () => ({
    default: ({ content }: { content: string }) =>
        React.createElement("span", null, content),
}));
import StoredTableEditor from "../../../react/components/tables/StoredTableEditor";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const spec = {
    id: "t",
    key: "TABLE001",
    version: 1,
    columns: [{ id: "a", header: "Answer", type: "text" as const }],
    rows: [
        {
            id: "r",
            cells: {
                a: {
                    value: { kind: "text" as const, text: "Original" },
                    provenance: "extracted" as const,
                },
            },
        },
    ],
};
const snapshot = {
    spec,
    version: 1,
    sha256: "a".repeat(64),
    recovered: [],
    conflict: null,
    history: [{ version: 1, actor: "user" }],
};
const surface = {
    kind: "table" as const,
    id: "showing",
    variant: "extraction" as const,
    ref: { libraryID: 1, key: "TABLE001" },
    table: spec,
};
beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.open.mockResolvedValue(snapshot);
    mocks.edit.mockResolvedValue({ ok: true, saved: true });
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
    (Zotero as any).Beaver = { runtime: { subscribeWindow: mocks.subscribe } };
    (Zotero as any).Notifier = {
        registerObserver: vi.fn(() => "observer"),
        unregisterObserver: vi.fn(),
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
        root.render(React.createElement(StoredTableEditor, { surface })),
    );
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});
async function select(label: string, value: string) {
    const element = container.querySelector<HTMLSelectElement>(
        `[aria-label="${label}"]`,
    )!;
    await act(async () => {
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
async function click(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
        (entry) => entry.textContent === text,
    )!;
    await act(async () => button.click());
}
it("loads by persistent identity and saves a guarded user correction", async () => {
    expect(mocks.open).toHaveBeenCalledWith(surface.ref);
    await select("Row", "r");
    await select("Column", "a");
    await click("Save correction");
    expect(mocks.edit).toHaveBeenCalledWith(
        surface.ref,
        [
            {
                op: "set_cells",
                cells: [
                    {
                        row: "r",
                        column: "a",
                        cell: {
                            provenance: "user",
                            value: { kind: "text", text: "Original" },
                        },
                    },
                ],
            },
        ],
        { actor: "user" },
        { version: 1, sha256: snapshot.sha256 },
    );
});
it("makes not-reported and reset separate explicit actions", async () => {
    await select("Row", "r");
    await select("Column", "a");
    await click("Mark not reported");
    expect(mocks.edit.mock.calls[0][1][0].cells[0].cell).toEqual({
        provenance: "user",
        outcome: "not_reported",
    });
    await click("Reset cell and remove protection");
    expect(mocks.edit.mock.calls[1][1][0].cells[0].cell).toEqual({});
});
it("reports conflicts without silently retrying the mutation", async () => {
    mocks.edit.mockResolvedValue({ ok: false, conflict: true });
    await select("Row", "r");
    await select("Column", "a");
    await click("Save correction");
    expect(container.textContent).toContain("Reload to review current content");
    expect(mocks.edit).toHaveBeenCalledTimes(1);
});
it("subscribes to matching table changes and removes observers on unmount", async () => {
    const receive = mocks.subscribe.mock.calls[0][2];
    await act(async () => receive({ libraryID: 2, key: "OTHER001" }));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    await act(async () => receive(surface.ref));
    expect(mocks.open).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(Zotero.Notifier.unregisterObserver).toHaveBeenCalledWith("observer");
});
it("restores history only through the explicit action", async () => {
    mocks.revert.mockResolvedValue({ ok: true });
    await select("Retained version", "1");
    await click("Restore selected version");
    expect(mocks.revert).toHaveBeenCalledWith(surface.ref, 1, {
        actor: "user",
    });
});

async function inputValue(value: string) {
    const label = Array.from(container.querySelectorAll("label")).find(
        (entry) => entry.textContent?.startsWith("Value "),
    )!;
    const input = label.querySelector("textarea")!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
it("preserves an intentionally blank correction as user-owned", async () => {
    await select("Row", "r");
    await select("Column", "a");
    await inputValue("");
    await click("Save correction");
    expect(mocks.edit.mock.calls[0][1][0].cells[0].cell).toEqual({
        provenance: "user",
    });
});
it("keeps an unsaved draft when a local update arrives and reloads only on request", async () => {
    await select("Row", "r");
    await select("Column", "a");
    await inputValue("Draft correction");
    mocks.open.mockResolvedValue({
        ...snapshot,
        version: 2,
        sha256: "b".repeat(64),
        spec: {
            ...spec,
            rows: [
                {
                    id: "r",
                    cells: {
                        a: {
                            provenance: "user",
                            value: {
                                kind: "text",
                                text: "Concurrent correction",
                            },
                        },
                    },
                },
            ],
        },
    });
    await act(async () => mocks.subscribe.mock.calls[0][2](surface.ref));
    expect(container.textContent).toContain("Your draft is preserved");
    expect(
        Array.from(container.querySelectorAll("textarea")).some(
            (entry) => entry.value === "Draft correction",
        ),
    ).toBe(true);
    await click("Reload current table");
    expect(
        Array.from(container.querySelectorAll("textarea")).some(
            (entry) => entry.value === "Concurrent correction",
        ),
    ).toBe(true);
});

it.each([
    [
        { kind: "link", url: "https://example.org/paper", label: "Paper" },
        "link",
        "https://example.org/paper",
        "https://example.org/revised",
        { kind: "link", url: "https://example.org/revised", label: "Paper" },
    ],
    [
        { kind: "number", value: 12, display: "12 kg" },
        "number",
        "12",
        "13",
        { kind: "number", value: 13 },
    ],
    [
        { kind: "date", value: "2026-09-11", display: "September 11, 2026" },
        "date",
        "2026-09-11",
        "2026-09-12",
        { kind: "date", value: "2026-09-12" },
    ],
    [
        {
            kind: "reference",
            display_name: "Paper",
            subtitle: "Smith",
            venue: "Nature",
            item_type: "journalArticle",
        },
        "reference",
        "Paper",
        "Revised",
        {
            kind: "reference",
            display_name: "Revised",
            subtitle: "Smith",
            venue: "Nature",
            item_type: "journalArticle",
        },
    ],
    [
        {
            kind: "annotation",
            text: "Passage",
            comment: "Context",
            color: "yellow",
            page_label: "3",
        },
        "reference",
        "Passage",
        "Corrected",
        {
            kind: "annotation",
            text: "Corrected",
            comment: "Context",
            color: "yellow",
            page_label: "3",
        },
    ],
])(
    "edits the raw %j payload without losing unrelated metadata",
    async (original, type, raw, edited, expected) => {
        mocks.open.mockResolvedValue({
            ...snapshot,
            spec: {
                ...spec,
                columns: [{ id: "a", header: "Answer", type }],
                rows: [
                    {
                        id: "r",
                        cells: {
                            a: { value: original, provenance: "extracted" },
                        },
                    },
                ],
            },
        });
        await click("Reload current table");
        await select("Row", "r");
        await select("Column", "a");
        expect(container.querySelector("textarea")!.value).toBe(raw);
        const evidenceInput = container.querySelectorAll("textarea")[1];
        await act(async () => {
            Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
            )!.set!.call(evidenceInput, "Corrected evidence");
            evidenceInput.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await click("Save correction");
        expect(mocks.edit.mock.calls[0][1][0].cells[0].cell).toEqual({
            provenance: "user",
            value: original,
            details: { kind: "text", text: "Corrected evidence" },
        });
        await inputValue(edited as string);
        await click("Save correction");
        expect(mocks.edit.mock.calls[1][1][0].cells[0].cell.value).toEqual(
            expected,
        );
    },
);

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
    return Array.from(container.querySelectorAll("label"))
        .find((entry) => entry.textContent?.startsWith(`${label} `))!
        .querySelector("input, textarea")!;
}
async function editField(label: string, value: string) {
    const input = field(label);
    await act(async () => {
        const prototype =
            input.tagName === "INPUT"
                ? HTMLInputElement.prototype
                : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
            input,
            value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

it.each([
    [
        "Save correction",
        ["Title", "Caption", "Column header", "Column question"],
    ],
    [
        "Save title and caption",
        ["Value", "Evidence / reason", "Column header", "Column question"],
    ],
    ["Save column", ["Value", "Evidence / reason", "Title", "Caption"]],
    [
        "Add empty row",
        [
            "Value",
            "Evidence / reason",
            "Title",
            "Caption",
            "Column header",
            "Column question",
        ],
    ],
    [
        "Reset cell and remove protection",
        ["Title", "Caption", "Column header", "Column question"],
    ],
])(
    "preserves unrelated drafts after %s and keeps them protected from notifications",
    async (button, preserved) => {
        const { applyMutations } =
            await import("@beaver/agent-core/layouts/tableMutations");
        let current = snapshot;
        mocks.edit.mockImplementation(async (_ref, mutations) => {
            const result = applyMutations(current.spec, mutations);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("Invalid test mutation");
            current = {
                ...current,
                spec: result.spec as typeof spec,
                version: current.version + 1,
                sha256: "b".repeat(64),
            };
            mocks.open.mockResolvedValue(current);
            // The store publishes before the save resolves.
            mocks.subscribe.mock.calls[0][2](surface.ref);
            return {
                ok: true,
                saved: true,
                version: current.version,
                sha256: current.sha256,
            };
        });
        await select("Row", "r");
        await select("Column", "a");
        for (const label of [
            "Value",
            "Evidence / reason",
            "Title",
            "Caption",
            "Column header",
            "Column question",
        ]) {
            await editField(label, `Draft ${label}`);
        }
        await click(button as string);
        for (const label of preserved)
            expect(field(label).value).toBe(`Draft ${label}`);
        await act(async () => mocks.subscribe.mock.calls[0][2](surface.ref));
        for (const label of preserved)
            expect(field(label).value).toBe(`Draft ${label}`);
        expect(container.textContent).toContain("Your draft is preserved");
        const nextButton =
            button === "Save correction" ||
            button === "Reset cell and remove protection"
                ? "Save title and caption"
                : "Save correction";
        await click(nextButton);
        expect(mocks.edit.mock.calls[1][3]).toEqual({
            version: 2,
            sha256: "b".repeat(64),
        });
    },
);

it("does not rebase unsaved drafts onto a concurrent edit arriving after a save", async () => {
    await select("Row", "r");
    await select("Column", "a");
    await editField("Title", "My draft");
    mocks.edit.mockResolvedValue({
        ok: true,
        saved: true,
        version: 2,
        sha256: "b".repeat(64),
    });
    mocks.open.mockResolvedValue({
        ...snapshot,
        version: 3,
        sha256: "c".repeat(64),
        spec: { ...spec, title: "Concurrent title" },
    });
    await click("Save correction");
    expect(field("Title").value).toBe("My draft");
    expect(container.textContent).toContain("Your draft is preserved");
    await click("Save title and caption");
    expect(mocks.edit.mock.calls[1][3]).toEqual({
        version: 1,
        sha256: snapshot.sha256,
    });
    await click("Reload current table");
    expect(field("Title").value).toBe("Concurrent title");
});
