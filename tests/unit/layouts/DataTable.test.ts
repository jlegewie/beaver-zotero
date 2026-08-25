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
    anchor_column_id: "ref",
    columns: [
        { id: "ref", header: "Item", type: "reference", priority: "primary" },
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
        {
            id: "methods",
            header: "Methods",
            type: "text",
            description: "What method did the study use?",
        },
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
                oa: { value: { kind: "boolean", value: false } },
                methods: { status: "pending" },
            },
        },
        {
            id: "r3",
            status: "error",
            error: "No text layer",
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
        Array.from(container!.querySelectorAll("tr.bt-row .bt-ref-title")).map(
            (el) => el.textContent?.trim(),
        );
    const headerLabels = () =>
        Array.from(container!.querySelectorAll("th.bt-th .bt-th-label")).map(
            (el) => el.textContent,
        );
    const click = (el: Element | null) =>
        act(() =>
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );
    const headerFor = (label: string) =>
        Array.from(container!.querySelectorAll("th.bt-th")).find(
            (th) => th.querySelector(".bt-th-label")?.textContent === label,
        )!;

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

    it("renders every column with the initial sort applied and empties last", () => {
        mount(React.createElement(DataTable, { table: spec }));
        expect(headerLabels()).toEqual([
            "Item",
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

    it("renders a column's question as a header line rather than a tooltip", () => {
        mount(React.createElement(DataTable, { table: spec }));
        expect(
            headerFor("Methods").querySelector(".bt-th-description")
                ?.textContent,
        ).toBe("What method did the study use?");
    });

    it("distinguishes filled, empty, pending and failed cells", () => {
        mount(React.createElement(DataTable, { table: spec }));
        const rows = container!.querySelectorAll("tr.bt-row");

        expect(rows[0].querySelector(".bt-pill-blue")?.textContent).toBe(
            "Article",
        );
        expect(rows[0].querySelector(".bt-bool-yes")).not.toBeNull();

        // False renders the marker with no glyph — the check is the signal.
        expect(rows[1].querySelector(".bt-bool-no")?.textContent).toBe("");
        expect(rows[1].querySelector(".bt-skeleton")).not.toBeNull();

        // An absent value renders blank rather than a placeholder glyph; what
        // is missing is counted in the footer instead.
        expect(
            rows[2].querySelector('[id="r3/cites"] .bt-empty')?.textContent,
        ).toBe("");
        expect(
            rows[2].querySelector(".bt-cell-error-text")?.textContent,
        ).toContain("Extraction failed");
        expect(rows[2].classList.contains("bt-row-error")).toBe(true);
    });

    it("sorts on any column, cycling asc → desc → none", () => {
        mount(React.createElement(DataTable, { table: spec }));

        // Reference columns sort too — every column does.
        click(headerFor("Item").querySelector("button"));
        expect(rowNames()).toEqual(["Adams 2022", "Jones 2018", "Smith 2020"]);

        const cites = () => headerFor("Citations").querySelector("button");
        click(cites());
        expect(rowNames()).toEqual(["Jones 2018", "Smith 2020", "Adams 2022"]);
        click(cites());
        expect(rowNames()).toEqual(["Smith 2020", "Jones 2018", "Adams 2022"]);
        click(cites());
        expect(container!.querySelector("th[aria-sort]")).toBeNull();
    });

    it("expands a row into every field in full, including cell details", () => {
        mount(React.createElement(DataTable, { table: spec }));
        expect(container!.querySelector(".bt-detail")).toBeNull();

        click(container!.querySelector("tr.bt-row .bt-rail-chevron"));

        const detail = container!.querySelector(".bt-detail")!;
        expect(detail.textContent).toContain("An abstract about alpha.");
        expect(
            Array.from(detail.querySelectorAll("dt")).map(
                (dt) => dt.textContent,
            ),
        ).toEqual(["Item", "Citations", "Type", "Open access", "Methods"]);
    });

    it("spans the detail row across every column", () => {
        // The window is an XHTML document, where a JSX `colSpan` lands as a
        // case-sensitive attribute the cell never reads — so this is set as the
        // IDL property, and read back as one here.
        mount(React.createElement(DataTable, { table: spec }));
        click(container!.querySelector("tr.bt-row .bt-rail-chevron"));
        const cell = container!.querySelector(
            "tr.bt-detail-row td",
        ) as HTMLTableCellElement;
        // rail + 5 columns (no actions column without a host)
        expect(cell.colSpan).toBe(6);
    });

    it("shows a row-level error in the expanded row", () => {
        mount(React.createElement(DataTable, { table: spec }));
        click(container!.querySelectorAll(".bt-rail-chevron")[2]);
        expect(container!.querySelector(".bt-detail-error")?.textContent).toBe(
            "No text layer",
        );
    });

    it("selects rows from the rail and from the header", () => {
        mount(React.createElement(DataTable, { table: spec }));

        click(container!.querySelector("tr.bt-row .bt-checkbox"));
        expect(container!.querySelectorAll("tr.bt-row-selected").length).toBe(
            1,
        );

        const headerBox = () =>
            container!.querySelector("th.bt-th-rail .bt-checkbox");
        click(headerBox());
        expect(container!.querySelectorAll("tr.bt-row-selected").length).toBe(
            3,
        );
        click(headerBox());
        expect(container!.querySelectorAll("tr.bt-row-selected").length).toBe(
            0,
        );
    });

    it("filters by clicking a select pill, and unfilters on a second click", () => {
        mount(React.createElement(DataTable, { table: spec }));

        click(container!.querySelector(".bt-pill-button"));
        expect(rowNames()).toEqual(["Smith 2020", "Adams 2022"]);

        click(container!.querySelector(".bt-pill-button"));
        expect(rowNames().length).toBe(3);
    });

    it("renders no row actions without a host, and resolved ones with a host", () => {
        mount(React.createElement(DataTable, { table: spec }));
        expect(container!.querySelector(".bt-td-actions")).toBeNull();

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
        mount(React.createElement(DataTable, { table: spec }));

        // Off-library external row gets the labelled Add, not a bare glyph;
        // reveal is not offered because there is nothing to reveal.
        expect(externalReferenceActions).toHaveBeenCalledWith(
            expect.objectContaining({
                item: externalRef,
                importButtonMode: "full",
                revealButtonMode: "none",
            }),
        );

        // In-library item row: reveal, from the action column and from the title.
        const rows = container!.querySelectorAll("tr.bt-row");
        click(rows[1].querySelector('button[aria-label="Reveal in library"]'));
        expect(revealInLibrary).toHaveBeenCalledWith({
            library_id: 1,
            zotero_key: "K2",
            library_ref: "u",
        });

        click(rows[1].querySelector(".bt-ref-title-button"));
        expect(revealInLibrary).toHaveBeenCalledTimes(2);

        // The clamp must sit on a span inside the button, never on the button:
        // Gecko forces a button's display to a flow root and the clamp never
        // reaches the anonymous block its text is laid out in, so the title
        // wraps to full length and takes the row height with it.
        expect(container!.querySelector("button.bt-ref-title")).toBeNull();
        expect(
            container!.querySelector(".bt-ref-title-button > .bt-ref-title"),
        ).not.toBeNull();

        // A row with no ref offers nothing.
        expect(rows[2].querySelector(".bt-actions")?.children.length).toBe(0);
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

describe("DataTable — density, columns and expansion", () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    function mount(element: React.ReactElement) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root?.render(element));
        return container;
    }
    const headerLabels = () =>
        Array.from(container!.querySelectorAll("th.bt-th .bt-th-label")).map(
            (el) => el.textContent,
        );
    const click = (el: Element | null) =>
        act(() =>
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );

    beforeEach(() => setHost({}));
    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        vi.clearAllMocks();
    });

    it("keeps every column when only the row height changes", () => {
        // Row height is the viewer's lever; dropping columns from under them
        // because they wanted shorter rows would be a different feature.
        mount(React.createElement(DataTable, { table: spec }));
        const before = headerLabels();
        expect(before.length).toBe(5);
        act(() =>
            root?.render(React.createElement(DataTable, { table: spec })),
        );
        expect(headerLabels()).toEqual(before);
    });

    it("drops non-primary columns only when the surface says it is narrow", () => {
        mount(
            React.createElement(DataTable, {
                table: spec,
                primaryColumnsOnly: true,
            }),
        );
        expect(headerLabels()).toEqual(["Item", "Citations"]);

        // Nothing is lost: the rest are listed when the row is expanded.
        click(container!.querySelector("tr.bt-row .bt-rail-chevron"));
        expect(
            Array.from(container!.querySelectorAll(".bt-detail dt")).map(
                (dt) => dt.textContent,
            ),
        ).toEqual(["Item", "Citations", "Type", "Open access", "Methods"]);
    });

    it("keeps a failed column in the expanded row and offers its retry", () => {
        const onRetryCell = vi.fn();
        mount(React.createElement(DataTable, { table: spec, onRetryCell }));
        click(container!.querySelectorAll(".bt-rail-chevron")[2]);

        const detail = container!.querySelector(".bt-detail")!;
        expect(
            Array.from(detail.querySelectorAll("dt")).map(
                (dt) => dt.textContent,
            ),
        ).toContain("Methods");

        click(detail.querySelector(".bt-inline-link"));
        expect(onRetryCell).toHaveBeenCalledTimes(1);
        expect(onRetryCell.mock.calls[0][1].id).toBe("methods");
    });

    it("offers no expansion when the table says rows are not expandable", () => {
        mount(
            React.createElement(DataTable, {
                table: {
                    ...spec,
                    capabilities: {
                        ...spec.capabilities,
                        expandable_rows: false,
                    },
                },
            }),
        );
        expect(
            container!.querySelector("tr.bt-row button.bt-rail-chevron"),
        ).toBeNull();
    });

    it("widens the table to fit its columns rather than starving them", () => {
        mount(React.createElement(DataTable, { table: spec }));
        const style = container!
            .querySelector("table.bt-table")!
            .getAttribute("style")!;
        // Every column contributes, including a floor for the flexible one.
        // rail 3.2 + anchor 20 + number 6.5 + select 9.5 + boolean 5.5 + text 14
        expect(style).toContain("58.7rem");
    });
});
