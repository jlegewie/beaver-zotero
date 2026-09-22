// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    openTable: vi.fn(),
    resolveTableDisplay: vi.fn(),
}));
vi.mock("@beaver/agent-ui/host", () => ({
    getHost: () => ({
        navigation: { openTable: mocks.openTable },
        itemData: { resolveTableDisplay: mocks.resolveTableDisplay },
    }),
}));
vi.mock("../../../react/components/agentRuns/ToolResultView", () => ({
    ToolResultView: () => React.createElement("div", null, "Result body"),
}));

import { TableToolCallView } from "../../../react/components/agentRuns/TableToolCallView";
import { TableArtifactRow } from "../../../react/host/zotero/components/reviewChanges/TableArtifactRow";
import { ArtifactsList } from "../../../react/host/zotero/components/reviewChanges/ArtifactsList";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const record = {
    reference: { kind: "table" as const, key: "u-ABCDEFGH", title: "Study comparison" },
    change: "Created table",
    summary: { rows: 3, columns: 2 },
};
const part = {
    part_kind: "tool-call" as const,
    tool_name: "create_table",
    tool_call_id: "call",
    args: { title: "Study comparison" },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function mount(element: React.ReactElement) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
        root!.render(React.createElement(Provider, { store: createStore() }, element)),
    );
    return container;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.openTable.mockResolvedValue({ ok: true });
    mocks.resolveTableDisplay.mockResolvedValue({
        status: "available",
        title: "Renamed in Zotero",
        rows: 5,
        columns: 2,
    });
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

describe("table write cards", () => {
    it("names the tool in bold, shows the historical title, and opens the table from the header", async () => {
        const el = await mount(
            React.createElement(TableToolCallView, {
                part,
                result: {
                    part_kind: "tool-return",
                    tool_name: "create_table",
                    tool_call_id: "call",
                    content: { ok: true },
                    metadata: { view: { view_type: "table", record } },
                },
                runId: "run",
                responseIndex: 0,
                runStatus: "completed",
            }),
        );
        const label = el.querySelector(".font-medium")!;
        expect(label.textContent).toBe("Create table");
        expect(el.textContent).toContain("Study comparison");
        expect(el.querySelector(".agent-action-view.border-card")).not.toBeNull();
        expect(el.querySelector("#tool-result-call")?.textContent).toBe("Result body");

        const open = el.querySelector<HTMLButtonElement>('button[aria-label="Open table"]')!;
        // A real button outside the header toggle, so it is focusable and
        // keyboard-activable on its own.
        expect(open.closest("button[aria-expanded]")).toBeNull();
        await act(async () => open.click());
        expect(mocks.openTable).toHaveBeenCalledExactlyOnceWith("u-ABCDEFGH");
        // Opening must not toggle the card.
        expect(el.querySelector("#tool-result-call")).not.toBeNull();
    });

    it("still names an untitled table once the call has returned", async () => {
        const el = await mount(
            React.createElement(TableToolCallView, {
                part: { ...part, tool_name: "fill_table", args: {} },
                result: {
                    part_kind: "tool-return",
                    tool_name: "fill_table",
                    tool_call_id: "call",
                    content: { ok: true },
                    metadata: {
                        view: {
                            view_type: "table",
                            record: { ...record, reference: { ...record.reference, title: "" } },
                        },
                    },
                },
                runId: "run",
                responseIndex: 0,
                runStatus: "completed",
            }),
        );
        expect(el.querySelector(".two-line-header")?.textContent).toBe(
            "Extract into tableUntitled table",
        );
    });

    it("shows the requested title while the call is still running and offers nothing to open", async () => {
        const el = await mount(
            React.createElement(TableToolCallView, {
                part,
                result: undefined,
                runId: "run",
                responseIndex: 0,
                runStatus: "in_progress",
            }),
        );
        expect(el.textContent).toContain("Create table");
        expect(el.textContent).toContain("Study comparison");
        expect(el.querySelector('[aria-label="Open table"]')).toBeNull();
        expect(el.querySelector<HTMLButtonElement>("button[aria-expanded]")!.disabled).toBe(true);
    });

    it("surfaces an open failure without a provider", async () => {
        mocks.openTable.mockResolvedValueOnce({ error: "Table file is missing on this device." });
        const el = await mount(
            React.createElement(TableToolCallView, {
                part,
                result: {
                    part_kind: "tool-return",
                    tool_name: "create_table",
                    tool_call_id: "call",
                    content: { ok: true },
                    metadata: { view: { view_type: "table", record } },
                },
                runId: "run",
                responseIndex: 0,
                runStatus: "completed",
            }),
        );
        await act(async () => el.querySelector<HTMLElement>('[aria-label="Open table"]')!.click());
        expect(el.querySelector('[role="status"]')?.textContent).toBe(
            "Table file is missing on this device.",
        );
    });
});

describe("table artifact rows", () => {
    it("lists a written table after the notes with a past-tense label and the current title", async () => {
        const el = await mount(
            React.createElement(ArtifactsList, {
                rows: [],
                tableRows: [
                    { runId: "run", toolcallId: "call", record, created: true },
                    {
                        runId: "run",
                        toolcallId: "call-2",
                        created: false,
                        record: { ...record, reference: { ...record.reference, key: "u-ZZZZZZZZ", title: "Other" } },
                    },
                ],
            }),
        );
        const labels = [...el.querySelectorAll(".font-medium")].map((node) => node.textContent);
        expect(labels).toEqual(["Created Table", "Updated Table"]);
        expect(el.querySelectorAll('button[aria-label="Open table"]')).toHaveLength(2);
        // The row follows the document's current title once it resolves.
        expect(el.textContent).toContain("Renamed in Zotero");
        expect(el.querySelectorAll('[aria-label="Open table"]')).toHaveLength(2);
        expect(el.querySelector("#tool-result-call")).toBeNull();
    });

    it.each([
        { source: "document", display: { status: "available", title: "", rows: 1, columns: 1 } },
        { source: "record", display: { status: "unavailable", reason: "Table item is missing." } },
    ])("falls back to an untitled label when the $source title is empty", async ({ display }) => {
        mocks.resolveTableDisplay.mockResolvedValue(display);
        const el = await mount(
            React.createElement(TableArtifactRow, {
                row: {
                    runId: "run",
                    toolcallId: "call",
                    created: false,
                    record: { ...record, reference: { ...record.reference, title: "" } },
                },
            }),
        );
        expect(el.textContent).toContain("Untitled table");
    });

    it("expands to the step summary and opens through the navigation host", async () => {
        const el = await mount(
            React.createElement(TableArtifactRow, {
                row: { runId: "run", toolcallId: "call", record, created: true },
            }),
        );
        const toggle = el.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        await act(async () => toggle.click());
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(el.textContent).toContain("3 rows · 2 columns");
        expect(el.textContent).toContain("Now 5 rows · 2 columns · Renamed in Zotero");

        await act(async () => el.querySelector<HTMLElement>('[aria-label="Open table"]')!.click());
        expect(mocks.openTable).toHaveBeenCalledExactlyOnceWith("u-ABCDEFGH");
    });
});
