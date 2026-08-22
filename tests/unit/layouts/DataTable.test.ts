// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableSpec } from "@beaver/agent-core/layouts/table";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";
import { DataTable } from "@beaver/agent-ui/layouts/DataTable";
import { setHost } from "@beaver/agent-ui/host";

const externalRef: ExternalReference = {
    source: "openalex",
    source_id: "W1",
    title: "Alpha",
    library_items: [],
};

const spec: TableSpec = {
    id: "t",
    title: "Results",
    columns: [
        {
            id: "ref",
            header: "Reference",
            type: "reference",
            priority: "primary",
        },
        {
            id: "cites",
            header: "Citations",
            type: "number",
            priority: "primary",
        },
        {
            id: "type",
            header: "Type",
            type: "select",
            options: [{ label: "Article", color: "blue" }, { label: "Book" }],
        },
        { id: "oa", header: "Open access", type: "boolean" },
        { id: "methods", header: "Methods", type: "text" },
    ],
    rows: [
        {
            id: "ext:openalex:W1",
            ref: {
                kind: "external",
                source: "openalex",
                source_id: "W1",
                reference: externalRef,
            },
            cells: {
                ref: {
                    value: {
                        kind: "reference",
                        display_name: "Smith 2020",
                        subtitle: "Alpha",
                        library_items: [{ library_id: 1, zotero_key: "K1" }],
                    },
                    details: {
                        kind: "text",
                        text: "An abstract about alpha.",
                        label: "Abstract",
                    },
                },
                cites: { value: { kind: "number", value: 120 } },
                type: { value: { kind: "select", label: "Article" } },
                oa: { value: { kind: "boolean", value: true } },
                methods: { value: { kind: "text", text: "Survey" } },
            },
        },
        {
            id: "item:u:K2",
            ref: {
                kind: "item",
                library_id: 1,
                zotero_key: "K2",
                library_ref: "u",
            },
            cells: {
                ref: {
                    value: { kind: "reference", display_name: "Jones 2018" },
                },
                cites: { value: { kind: "number", value: 7 } },
                type: { value: { kind: "select", label: "Book" } },
                methods: { status: "pending" },
            },
        },
        {
            id: "r3",
            cells: {
                ref: {
                    value: { kind: "reference", display_name: "Adams 2022" },
                },
                type: { value: { kind: "select", label: "Article" } },
                methods: { status: "error", error: "Extraction failed" },
            },
        },
    ],
    sort: { column_id: "cites", direction: "desc" },
    capabilities: { row_actions: ["import", "reveal"] },
};

describe("DataTable", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    function mount(element: React.ReactElement) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root?.render(element));
        return container;
    }

    const rowNames = () =>
        Array.from(container!.querySelectorAll("tr.bt-row .bt-ref-name")).map(
            (el) => el.textContent?.trim(),
        );
    const click = (el: Element | null) =>
        act(() =>
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );

    beforeEach(() => {
        setHost({});
    });

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    it("renders every column in full density, applying the initial sort with empties last", () => {
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        const headers = Array.from(container!.querySelectorAll("th.bt-th")).map(
            (th) => th.textContent,
        );
        expect(headers).toEqual([
            "Reference",
            "Citations",
            "Type",
            "Open access",
            "Methods",
        ]);
        expect(rowNames()).toEqual(["Smith 2020", "Jones 2018", "Adams 2022"]);
        expect(
            container!
                .querySelector("th[aria-sort]")
                ?.getAttribute("aria-sort"),
        ).toBe("descending");
    });

    it("renders value kinds: empty dash, pending spinner, error, select colour, in-library badge", () => {
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        const rows = container!.querySelectorAll("tr.bt-row");
        expect(
            rows[2].querySelector(".bt-kind-number .bt-empty")?.textContent,
        ).toBe("—");
        expect(
            rows[1].querySelector(".bt-kind-text .bt-cell-pending"),
        ).not.toBeNull();
        expect(
            rows[2]
                .querySelector(".bt-kind-text .bt-cell-error")
                ?.getAttribute("title"),
        ).toBe("Extraction failed");
        expect(rows[0].querySelector(".bt-select")?.className).toContain(
            "bt-select-blue",
        );
        expect(rows[1].querySelector(".bt-select")?.className).toContain(
            "bt-select-gray",
        );
        expect(rows[0].querySelector(".bt-ref-in-library")).not.toBeNull();
        expect(rows[1].querySelector(".bt-ref-in-library")).toBeNull();
        expect(rows[0].querySelector(".bt-boolean-true")).not.toBeNull();
        expect(
            rows[0].querySelector(`[id="ext:openalex:W1/cites"]`),
        ).not.toBeNull();
    });

    it("cycles a column sort asc → desc → none on header clicks", () => {
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        const header = Array.from(container!.querySelectorAll("th.bt-th")).find(
            (th) => th.textContent === "Reference",
        )!;
        const button = header.querySelector("button");
        expect(button).toBeNull(); // reference columns are not sortable by default

        const cites = Array.from(container!.querySelectorAll("th.bt-th")).find(
            (th) => th.textContent?.startsWith("Citations"),
        )!;
        click(cites.querySelector("button"));
        expect(rowNames()).toEqual(["Smith 2020", "Jones 2018", "Adams 2022"]); // desc → none: spec order
        expect(container!.querySelector("th[aria-sort]")).toBeNull();
        click(cites.querySelector("button"));
        expect(rowNames()).toEqual(["Jones 2018", "Smith 2020", "Adams 2022"]); // none → asc, empty last
        click(cites.querySelector("button"));
        expect(rowNames()).toEqual(["Smith 2020", "Jones 2018", "Adams 2022"]); // asc → desc
    });

    it("filters with the quick-filter box and by clicking a select pill", () => {
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        const input = container!.querySelector<HTMLInputElement>(
            "input.bt-quick-filter",
        )!;
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )!.set!;
        act(() => {
            setter.call(input, "jones");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(rowNames()).toEqual(["Jones 2018"]);
        expect(container!.querySelector(".bt-row-count")?.textContent).toBe(
            "1 of 3 rows",
        );

        act(() => {
            setter.call(input, "");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        click(container!.querySelector("tr.bt-row .bt-select-button"));
        expect(rowNames()).toEqual(["Smith 2020", "Adams 2022"]);
        expect(
            container!.querySelector(".bt-filter-chip")?.textContent,
        ).toContain("Type:");

        click(container!.querySelector(".bt-filter-chip"));
        expect(rowNames()).toHaveLength(3);
    });

    it("renders select pills as plain text in a column that opts out of filtering", () => {
        const unfilterable: TableSpec = {
            ...spec,
            columns: spec.columns.map((c) =>
                c.id === "type" ? { ...c, filterable: false } : c,
            ),
        };
        mount(
            React.createElement(DataTable, {
                table: unfilterable,
                density: "full",
            }),
        );
        expect(
            container!.querySelector("tr.bt-row .bt-select-button"),
        ).toBeNull();
        expect(
            container!.querySelector("tr.bt-row .bt-select")?.textContent,
        ).toBe("Article");
        expect(container!.querySelectorAll("tr.bt-row")).toHaveLength(3);
    });

    it("expands a cell with details inline under its row", () => {
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        expect(container!.querySelector(".bt-detail-row")).toBeNull();
        click(container!.querySelector("tr.bt-row .bt-expand"));
        const detail = container!.querySelector(".bt-detail-row");
        expect(detail?.querySelector(".bt-details-label")?.textContent).toBe(
            "Abstract",
        );
        expect(detail?.querySelector(".bt-details-text")?.textContent).toBe(
            "An abstract about alpha.",
        );
        click(container!.querySelector("tr.bt-row .bt-expand"));
        expect(container!.querySelector(".bt-detail-row")).toBeNull();
    });

    it("shows only primary columns in compact density and lists the rest on row expand", () => {
        mount(
            React.createElement(DataTable, { table: spec, density: "compact" }),
        );
        const headers = Array.from(container!.querySelectorAll("th.bt-th")).map(
            (th) => th.textContent,
        );
        expect(headers).toEqual(["Reference", "Citations"]);
        click(container!.querySelector("td.bt-td-expand button"));
        const terms = Array.from(
            container!.querySelectorAll(".bt-hidden-columns dt"),
        ).map((dt) => dt.textContent);
        expect(terms).toEqual(["Type", "Open access", "Methods"]);
    });

    it("uses the injected text renderer for text cells and details", () => {
        const renderText = vi.fn((text: string) =>
            React.createElement("em", null, text),
        );
        mount(
            React.createElement(DataTable, {
                table: spec,
                density: "full",
                renderText,
            }),
        );
        expect(container!.querySelector(".bt-kind-text em")?.textContent).toBe(
            "Survey",
        );
        expect(renderText).toHaveBeenCalledWith("Survey");
    });

    it("renders no row actions without a host, and host-resolved actions with one", () => {
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        expect(
            container!.querySelector(".bt-actions")?.children.length ?? 0,
        ).toBe(0);
        act(() => root?.unmount());
        container?.remove();

        const externalReferenceActions = vi.fn(() =>
            React.createElement(
                "button",
                { className: "host-import" },
                "Import",
            ),
        );
        const revealInLibrary = vi.fn();
        setHost({
            components: {
                externalReferenceActions,
                agentActionInStream: () => null,
                pendingActionsReview: () => null,
                itemTypeIcon: () => null,
                revealInLibraryIcon: () => null,
            },
            navigation: {
                revealInLibrary,
                revealLibrary: () => {},
                revealCollection: () => {},
                launchFile: () => {},
                openExternalUrl: () => {},
                activateCitation: () => {},
                openSource: () => {},
                openAnnotation: () => {},
                navigateToAttachmentMatch: () => {},
                launchExternalFile: () => {},
            },
        });
        mount(React.createElement(DataTable, { table: spec, density: "full" }));
        expect(externalReferenceActions).toHaveBeenCalledWith(
            expect.objectContaining({
                item: externalRef,
                importButtonMode: "icon-only",
                revealButtonMode: "icon-only",
                pdfButtonMode: "none",
            }),
        );
        expect(container!.querySelector(".host-import")).not.toBeNull();

        const rows = container!.querySelectorAll("tr.bt-row");
        click(rows[1].querySelector('button[aria-label="Reveal in library"]'));
        expect(revealInLibrary).toHaveBeenCalledWith({
            library_id: 1,
            zotero_key: "K2",
            library_ref: "u",
        });
        expect(rows[1].querySelector('button[aria-label="Open"]')).toBeNull(); // 'open' not in row_actions
        expect(rows[2].querySelector(".bt-actions")?.children.length).toBe(0); // no ref
    });

    it("renders the empty text for a table without rows", () => {
        mount(
            React.createElement(DataTable, {
                table: { ...spec, rows: [] },
                emptyText: "Nothing found",
            }),
        );
        expect(container!.querySelector(".bt-empty-table")?.textContent).toBe(
            "Nothing found",
        );
    });
});
