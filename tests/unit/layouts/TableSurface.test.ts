// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableSpec } from "@beaver/agent-core/layouts/table";
import { setHost } from "@beaver/agent-ui/host";
import { TableSurface } from "@beaver/agent-ui/layouts/chrome/TableSurface";
import { SearchResultsTable } from "@beaver/agent-ui/layouts/surfaces/SearchResultsTable";
import { ExtractionTable } from "@beaver/agent-ui/layouts/surfaces/ExtractionTable";

const spec: TableSpec = {
    id: "t",
    title: "Working from home",
    caption: "OpenAlex · 3 results",
    anchor_column_id: "ref",
    columns: [
        { id: "ref", header: "Item", type: "reference" },
        { id: "year", header: "Year", type: "number" },
        {
            id: "type",
            header: "Type",
            type: "select",
            options: [{ label: "Article", color: "blue" }, { label: "Book" }],
        },
        { id: "notes", header: "Notes", type: "text" },
    ],
    rows: [
        {
            id: "r1",
            cells: {
                ref: { value: { kind: "reference", display_name: "Alpha" } },
                year: { value: { kind: "number", value: 2020 } },
                type: { value: { kind: "select", label: "Article" } },
                notes: { value: { kind: "text", text: "First" } },
            },
        },
        {
            id: "r2",
            cells: {
                ref: { value: { kind: "reference", display_name: "Beta" } },
                year: { value: { kind: "number", value: 2021 } },
                type: { value: { kind: "select", label: "Book" } },
                // `notes` absent — not reported.
            },
        },
        {
            id: "r3",
            cells: {
                ref: { value: { kind: "reference", display_name: "Gamma" } },
                year: { value: { kind: "number", value: 2022 } },
                type: { value: { kind: "select", label: "Article" } },
                notes: { status: "error", error: "Extraction failed" },
            },
        },
    ],
};

describe("table chrome", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    function mount(element: React.ReactElement) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root?.render(element));
        return container;
    }

    const click = (el: Element | null) =>
        act(() =>
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );
    const text = (selector: string) =>
        container!.querySelector(selector)?.textContent ?? "";

    beforeEach(() => setHost({}));

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    it("takes its title and subtitle from the spec unless overridden", () => {
        mount(React.createElement(TableSurface, { table: spec }));
        expect(text(".bt-title")).toBe("Working from home");
        expect(text(".bt-subtitle")).toBe("OpenAlex · 3 results");

        act(() => root?.unmount());
        container?.remove();
        mount(
            React.createElement(TableSurface, {
                table: spec,
                title: "Renamed",
                subtitle: "Elsewhere",
            }),
        );
        expect(text(".bt-title")).toBe("Renamed");
        expect(text(".bt-subtitle")).toBe("Elsewhere");
    });

    it("reports coverage in the footer, not just the row count", () => {
        mount(React.createElement(TableSurface, { table: spec }));
        const footer = text(".bt-footer");
        expect(footer).toContain("3 rows");
        // One absent cell in `notes` plus two absent elsewhere are findings…
        expect(footer).toContain("not reported");
        // …and the failed cell is reported separately from them.
        expect(footer).toContain("1 failed");
    });

    it("moves the row height from the toolbar", () => {
        mount(React.createElement(TableSurface, { table: spec }));
        expect(
            container!.querySelector(".bt")?.getAttribute("data-density"),
        ).toBe("cozy");
        click(container!.querySelectorAll(".bt-density-option")[0]);
        expect(
            container!.querySelector(".bt")?.getAttribute("data-density"),
        ).toBe("compact");
    });

    it("shows a chip for every active filter and clears it on click", () => {
        mount(React.createElement(TableSurface, { table: spec }));
        expect(container!.querySelector(".bt-chip")).toBeNull();

        click(container!.querySelector(".bt-pill-button"));
        expect(text(".bt-chip")).toContain("Article");
        expect(text(".bt-rowcount")).toBe("2 of 3");

        click(container!.querySelector(".bt-chip"));
        expect(container!.querySelector(".bt-chip")).toBeNull();
        expect(text(".bt-rowcount")).toBe("3 rows");
    });

    it("replaces the toolbar with a selection bar while rows are picked", () => {
        const onImportRows = vi.fn();
        mount(
            React.createElement(SearchResultsTable, {
                table: spec,
                onImportRows,
            }),
        );
        expect(container!.querySelector(".bt-toolbar")).not.toBeNull();

        click(container!.querySelector("tr.bt-row .bt-checkbox"));
        expect(container!.querySelector(".bt-toolbar")).toBeNull();
        expect(text(".bt-selectioncount")).toBe("1 item selected");

        click(
            Array.from(
                container!.querySelectorAll(".bt-selectionbar button"),
            ).find((b) => b.textContent?.includes("Add to library"))!,
        );
        expect(onImportRows).toHaveBeenCalledTimes(1);
        expect(
            onImportRows.mock.calls[0][0].map((r: { id: string }) => r.id),
        ).toEqual(["r1"]);
    });

    it("omits a verb the surface cannot perform rather than rendering it dead", () => {
        mount(React.createElement(SearchResultsTable, { table: spec }));
        expect(text(".bt-titleactions")).toBe("");
    });

    it("exports the current view, not the whole spec", () => {
        const onExport = vi.fn();
        mount(
            React.createElement(SearchResultsTable, { table: spec, onExport }),
        );
        click(container!.querySelector(".bt-pill-button"));
        click(
            Array.from(
                container!.querySelectorAll(".bt-titleactions button"),
            ).find((b) => b.textContent?.includes("Export"))!,
        );

        const csv: string = onExport.mock.calls[0][0];
        expect(csv.split("\r\n")[0]).toBe("Item,Year,Type,Notes");
        expect(csv).toContain("Alpha");
        expect(csv).toContain("Gamma");
        expect(csv).not.toContain("Beta"); // filtered out of the view
    });
});

describe("ExtractionTable", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    const extractable: TableSpec = {
        ...spec,
        capabilities: { allow_add_column: true },
        cost_estimate: { per_row_credits: 1, estimated_seconds: 40 },
    };

    function mount(element: React.ReactElement) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root?.render(element));
        return container;
    }

    const click = (el: Element | null) =>
        act(() =>
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );
    const typeInto = (el: Element, value: string) =>
        act(() => {
            const input = el as HTMLInputElement | HTMLTextAreaElement;
            const proto =
                input instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(
                input,
                value,
            );
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    const addColumnButton = () =>
        Array.from(container!.querySelectorAll(".bt-toolbar button")).find(
            (b) => b.textContent?.includes("Add column"),
        );

    beforeEach(() => setHost({}));

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    it("offers Add column only when the spec allows it and the surface can run it", () => {
        mount(React.createElement(ExtractionTable, { table: extractable }));
        expect(addColumnButton()).toBeUndefined(); // no callback

        act(() => root?.unmount());
        container?.remove();
        mount(
            React.createElement(ExtractionTable, {
                table: spec, // no allow_add_column
                onAddColumn: vi.fn(),
            }),
        );
        expect(addColumnButton()).toBeUndefined();

        act(() => root?.unmount());
        container?.remove();
        mount(
            React.createElement(ExtractionTable, {
                table: extractable,
                onAddColumn: vi.fn(),
            }),
        );
        expect(addColumnButton()).toBeDefined();
    });

    it("states the cost before the run and refuses to submit an unfinished column", () => {
        const onAddColumn = vi.fn();
        mount(
            React.createElement(ExtractionTable, {
                table: extractable,
                onAddColumn,
            }),
        );
        click(addColumnButton()!);

        const dialog = container!.querySelector(".bt-dialog")!;
        expect(dialog.querySelector(".bt-costmain")?.textContent).toBe(
            "Runs on 3 items · about 3 credits",
        );
        expect(dialog.querySelector(".bt-costsub")?.textContent).toContain(
            "Nothing is charged until you start",
        );

        const submit = Array.from(
            dialog.querySelectorAll(".bt-dialog-actions button"),
        ).find((b) => b.textContent?.includes("Extract column")) as
            | HTMLButtonElement
            | undefined;
        expect(submit?.disabled).toBe(true);

        typeInto(dialog.querySelector(".bt-input")!, "Sample size");
        typeInto(
            dialog.querySelector(".bt-textarea")!,
            "How many participants?",
        );

        const ready = Array.from(
            container!.querySelectorAll(".bt-dialog-actions button"),
        ).find((b) => b.textContent?.includes("Extract column"))!;
        click(ready);

        expect(onAddColumn).toHaveBeenCalledWith({
            header: "Sample size",
            type: "text",
            description: "How many participants?",
        });
        expect(container!.querySelector(".bt-dialog")).toBeNull();
    });

    it("starts at tall density, because its cells hold prose", () => {
        mount(React.createElement(ExtractionTable, { table: extractable }));
        expect(
            container!.querySelector(".bt")?.getAttribute("data-density"),
        ).toBe("tall");
    });

    it("shows a column's progress in its header while it fills", () => {
        mount(
            React.createElement(ExtractionTable, {
                table: {
                    ...extractable,
                    columns: extractable.columns.map((c) =>
                        c.id === "notes"
                            ? {
                                  ...c,
                                  status: "filling" as const,
                                  progress: { done: 2, total: 3 },
                              }
                            : c,
                    ),
                },
            }),
        );
        expect(
            container!.querySelector(".bt-progress-label")?.textContent,
        ).toBe("2 of 3");
        expect(
            container!
                .querySelector(".bt-progress-fill")
                ?.getAttribute("style"),
        ).toContain("67%");
    });
});

describe("chrome regressions", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    function mount(element: React.ReactElement) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root?.render(element));
        return container;
    }
    const click = (el: Element | null) =>
        act(() =>
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );
    const typeInto = (el: Element, value: string) =>
        act(() => {
            const input = el as HTMLInputElement | HTMLTextAreaElement;
            const proto =
                input instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(
                input,
                value,
            );
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });

    beforeEach(() => setHost({}));
    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    it("changing the row height leaves every column in place", () => {
        mount(React.createElement(TableSurface, { table: spec }));
        const before = Array.from(
            container!.querySelectorAll("th.bt-th .bt-th-label"),
        ).map((el) => el.textContent);
        click(container!.querySelectorAll(".bt-density-option")[0]);
        expect(
            Array.from(
                container!.querySelectorAll("th.bt-th .bt-th-label"),
            ).map((el) => el.textContent),
        ).toEqual(before);
    });

    it("says 'row', not 'rows', for a single row", () => {
        mount(
            React.createElement(TableSurface, {
                table: { ...spec, rows: [spec.rows[0]] },
            }),
        );
        expect(container!.querySelector(".bt-rowcount")?.textContent).toBe(
            "1 row",
        );
        expect(container!.querySelector(".bt-footer")?.textContent).toContain(
            "1 row",
        );
    });

    it("re-prefills the composer when it is opened on a different column", () => {
        // The composer reads its prefill once. Without a fresh identity per
        // column, editing A then B submits A's question against B — which
        // renames B and starts a billed run with the wrong prompt.
        const onEditColumn = vi.fn();
        mount(
            React.createElement(ExtractionTable, {
                table: {
                    ...spec,
                    columns: spec.columns.map((c) =>
                        c.id === "ref"
                            ? c
                            : { ...c, description: `Question for ${c.header}` },
                    ),
                },
                onEditColumn,
            }),
        );

        const editColumn = (header: string) => {
            const th = Array.from(container!.querySelectorAll("th.bt-th")).find(
                (el) =>
                    el.querySelector(".bt-th-label")?.textContent === header,
            )!;
            click(th.querySelector(".bt-th-menu button, button.bt-th-menu"));
            const item = Array.from(
                container!.querySelectorAll('[role="menuitem"], .menu-item'),
            ).find((el) => el.textContent?.includes("Edit question"))!;
            click(item);
        };

        editColumn("Year");
        expect(
            (container!.querySelector(".bt-input") as HTMLInputElement).value,
        ).toBe("Year");

        editColumn("Notes");
        expect(
            (container!.querySelector(".bt-input") as HTMLInputElement).value,
        ).toBe("Notes");
        expect(
            (container!.querySelector(".bt-textarea") as HTMLTextAreaElement)
                .value,
        ).toBe("Question for Notes");
    });

    it("clears the composer between openings so no draft leaks into the next column", () => {
        const onAddColumn = vi.fn();
        mount(
            React.createElement(ExtractionTable, {
                table: {
                    ...spec,
                    capabilities: { allow_add_column: true },
                    cost_estimate: { per_row_credits: 1 },
                },
                onAddColumn,
            }),
        );
        const addButton = () =>
            Array.from(container!.querySelectorAll(".bt-toolbar button")).find(
                (b) => b.textContent?.includes("Add column"),
            )!;

        click(addButton());
        typeInto(container!.querySelector(".bt-input")!, "Sample size");
        click(
            Array.from(
                container!.querySelectorAll(".bt-dialog-actions button"),
            ).find((b) => b.textContent?.includes("Cancel"))!,
        );

        click(addButton());
        expect(
            (container!.querySelector(".bt-input") as HTMLInputElement).value,
        ).toBe("");
    });

    it("states that credits are used even when the price is not known", () => {
        mount(
            React.createElement(ExtractionTable, {
                table: { ...spec, capabilities: { allow_add_column: true } },
                onAddColumn: vi.fn(),
            }),
        );
        click(
            Array.from(container!.querySelectorAll(".bt-toolbar button")).find(
                (b) => b.textContent?.includes("Add column"),
            )!,
        );
        expect(container!.querySelector(".bt-costmain")?.textContent).toContain(
            "this uses credits",
        );
        expect(container!.querySelector(".bt-costsub")?.textContent).toContain(
            "not available",
        );
    });
});
