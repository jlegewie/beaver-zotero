// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    Cell,
    CellValue,
    TableSpec,
} from "@beaver/agent-core/layouts/table";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";
import { DataTable } from "@beaver/agent-ui/layouts/DataTable";
import {
    useTableState,
    type TableState,
} from "@beaver/agent-ui/layouts/useTableState";
import { setHost } from "@beaver/agent-ui/host";

const externalRef: ExternalReference = {
    source: "openalex",
    source_id: "W1",
    title: "Alpha",
    library_items: [],
};

/** An answer the producer filled, which carries no marks. */
function answered(value: CellValue): Cell {
    return { outcome: "answered", provenance: "system", value };
}

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
            documents: ["u-ATTACH01"],
            cells: {
                ref: {
                    outcome: "answered",
                    provenance: "system",
                    value: {
                        kind: "reference",
                        display_name: "Smith 2020",
                        subtitle: "Alpha",
                    },
                },
                cites: answered({ kind: "number", value: 120 }),
                type: answered({ kind: "select", label: "Article" }),
                oa: answered({ kind: "boolean", value: true }),
                methods: {
                    outcome: "answered",
                    provenance: "model",
                    documents: ["u-ATTACH01"],
                    value: { kind: "text", text: "Survey" },
                    reasoning: "The methods section names one instrument.",
                    evidence: [
                        {
                            document: "u-ATTACH01",
                            locator: "s3",
                            quote: "We surveyed 1,200 adults.",
                            page: 2,
                        },
                    ],
                },
            },
        },
        {
            id: "rK2",
            ref: {
                kind: "item",
                library_id: 1,
                zotero_key: "K2",
                library_ref: "u",
            },
            documents: ["u-ATTACH02"],
            cells: {
                ref: {
                    outcome: "answered",
                    provenance: "system",
                    value: { kind: "reference", display_name: "Jones 2018" },
                },
                cites: answered({ kind: "number", value: 7 }),
                type: answered({ kind: "select", label: "Book" }),
                oa: answered({ kind: "boolean", value: false }),
                methods: { outcome: "not_reported", provenance: "model", documents: ["u-ATTACH02"] },
            },
        },
        {
            id: "r3",
            failure: { code: "no_text_layer", message: "No text layer" },
            cells: {
                ref: {
                    outcome: "answered",
                    provenance: "system",
                    value: { kind: "reference", display_name: "Adams 2022" },
                },
                type: answered({ kind: "select", label: "Article" }),
                methods: {
                    outcome: "failed",
                    provenance: "model",
                    error_code: "no_locator",
                    error: "Extraction failed",
                },
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

    it("shows a select column's category definitions on its header and pills", () => {
        const defined: TableSpec = {
            ...spec,
            columns: spec.columns.map((column) =>
                column.id === "type"
                    ? {
                          ...column,
                          description: "What kind of work is it?",
                          options: [
                              { label: "Article", color: "blue", description: "A peer-reviewed journal article." },
                              { label: "Book" },
                          ],
                      }
                    : column,
            ),
        };
        mount(React.createElement(DataTable, { table: defined }));
        expect(headerFor("Type").getAttribute("title")).toBe(
            "What kind of work is it?\n\nCategories\nArticle — A peer-reviewed journal article.",
        );
        const rows = container!.querySelectorAll("tr.bt-row");
        expect(rows[0].querySelector(".bt-pill-blue")?.getAttribute("title")).toContain(
            "Article: A peer-reviewed journal article.",
        );
        // Without definitions the header says only the question.
        expect(headerFor("Methods").getAttribute("title")).toBe("What method did the study use?");
    });

    it("distinguishes filled, empty, not-reported and failed cells", () => {
        mount(React.createElement(DataTable, { table: spec }));
        const rows = container!.querySelectorAll("tr.bt-row");

        expect(rows[0].querySelector(".bt-pill-blue")?.textContent).toBe(
            "Article",
        );
        expect(rows[0].querySelector(".bt-bool-yes")).not.toBeNull();

        // False is the word, muted, never an empty cell.
        expect(rows[1].querySelector(".bt-bool-no")?.textContent).toBe("No");
        // Not reported is a finding, so it reads as a value.
        expect(
            rows[1].querySelector('[id="rK2/methods"] .bt-empty')?.textContent,
        ).toBe("Not reported");

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

    it("expands a row into every written cell, with its reasoning and evidence", () => {
        mount(React.createElement(DataTable, { table: spec }));
        expect(container!.querySelector(".bt-detail")).toBeNull();

        click(container!.querySelector("tr.bt-row .bt-rail-chevron"));

        const detail = container!.querySelector(".bt-detail")!;
        expect(
            Array.from(detail.querySelectorAll("dt")).map(
                (dt) => dt.textContent,
            ),
        ).toEqual(["Item", "Citations", "Type", "Open access", "Methods"]);

        const methods = detail.querySelectorAll("dd")[4];
        expect(methods.querySelector(".bt-details-text")?.textContent).toBe(
            "The methods section names one instrument.",
        );
        // Each evidence entry is a quote followed by its citation, rendered
        // from the assembled citation with no citation store behind it.
        expect(
            Array.from(methods.querySelectorAll(".bt-details-list li")).map(
                (li) => li.textContent,
            ),
        ).toEqual(["“We surveyed 1,200 adults.” Smith 2020, p.3"]);
    });

    it("lists a failed or not-reported cell in the expanded row, but not an unattempted one", () => {
        mount(React.createElement(DataTable, { table: spec }));
        // Sorted by citations: the second row is the item row.
        click(container!.querySelectorAll(".bt-rail-chevron")[1]);
        const fields = Array.from(
            container!.querySelectorAll(".bt-detail dt"),
        ).map((dt) => dt.textContent);
        expect(fields).toContain("Methods");

        act(() => root?.unmount());
        container?.remove();
        mount(React.createElement(DataTable, { table: spec }));
        click(container!.querySelectorAll(".bt-rail-chevron")[2]);
        // The third row never had citations or open access attempted.
        expect(
            Array.from(container!.querySelectorAll(".bt-detail dt")).map(
                (dt) => dt.textContent,
            ),
        ).toEqual(["Item", "Type", "Methods"]);
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
            "Could not be read. No text layer",
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

    it("puts no verb on the anchor title that the table does not declare", () => {
        setHost({
            navigation: {
                revealInLibrary: vi.fn(),
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
        // The anchor is where a row's primary verb is placed, not a way around
        // `capabilities.row_actions`: with only import declared, the item row's
        // title is plain text.
        mount(
            React.createElement(DataTable, {
                table: { ...spec, capabilities: { row_actions: ["import"] } },
            }),
        );
        expect(container!.querySelector(".bt-ref-title-button")).toBeNull();
        expect(container!.querySelector(".bt-ref-reveal")).toBeNull();
    });

    it("renders no row actions without a host, and resolved ones with a host", () => {
        mount(React.createElement(DataTable, { table: spec }));
        expect(container!.querySelector(".bt-ref-actions")).toBeNull();

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

        // Off-library external row gets the labelled Add, not a bare glyph.
        // The host component keeps its reveal glyph so it can flip to it once
        // the import lands; opening stays off, since the row has no file yet.
        expect(externalReferenceActions).toHaveBeenCalledWith(
            expect.objectContaining({
                item: externalRef,
                importButtonMode: "full",
                revealButtonMode: "icon-only",
                pdfButtonMode: "none",
            }),
        );

        // Every verb lives at the edge of the sticky anchor cell, never in a
        // column of its own: the host's Add control for the external row…
        const rows = container!.querySelectorAll("tr.bt-row");
        expect(container!.querySelector(".bt-td-actions")).toBeNull();
        expect(
            rows[0].querySelector(".bt-td-anchor .bt-ref-actions .host-import"),
        ).not.toBeNull();

        // …and for the in-library item row the reveal glyph, with the title
        // as the same target.
        click(
            rows[1].querySelector(
                '.bt-td-anchor .bt-ref-actions button[aria-label="Reveal in library"]',
            ),
        );
        expect(revealInLibrary).toHaveBeenCalledWith({
            library_id: 1,
            zotero_key: "K2",
            library_ref: "u",
        });

        click(rows[1].querySelector(".bt-ref-title-button"));
        expect(revealInLibrary).toHaveBeenCalledTimes(2);

        // One reveal control besides the title, and no menu: the table declares
        // no other verb for the row to hold.
        expect(
            rows[1].querySelectorAll('button[aria-label="Reveal in library"]'),
        ).toHaveLength(1);
        expect(
            rows[1].querySelector('button[aria-label="More actions"]'),
        ).toBeNull();

        // The clamp must sit on a span inside the button, never on the button:
        // Gecko forces a button's display to a flow root and the clamp never
        // reaches the anonymous block its text is laid out in, so the title
        // wraps to full length and takes the row height with it.
        expect(container!.querySelector("button.bt-ref-title")).toBeNull();
        expect(
            container!.querySelector(".bt-ref-title-button > .bt-ref-title"),
        ).not.toBeNull();

        // A row with no ref offers nothing.
        expect(rows[2].querySelector(".bt-ref-actions")).toBeNull();
    });

    it("offers import only when the table declares it", () => {
        const externalReferenceActions = vi.fn(() =>
            React.createElement("button", { className: "host-import" }, "Add"),
        );
        setHost({
            components: {
                externalReferenceActions,
                agentActionInStream: () => null,
                pendingActionsReview: () => null,
                itemTypeIcon: () => null,
                revealInLibraryIcon: () => null,
            },
        });
        mount(
            React.createElement(DataTable, {
                table: { ...spec, capabilities: { row_actions: ["reveal"] } },
            }),
        );
        expect(externalReferenceActions).not.toHaveBeenCalled();
        expect(container!.querySelector(".host-import")).toBeNull();
    });

    it("keeps the verbs on the anchor cell whatever state its value is in, once per row", () => {
        setHost({
            navigation: {
                revealInLibrary: vi.fn(),
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
        const itemRow = spec.rows[1];
        mount(
            React.createElement(DataTable, {
                table: {
                    ...spec,
                    columns: [
                        ...spec.columns,
                        {
                            id: "cites_ref",
                            header: "Cited by",
                            type: "reference",
                        },
                    ],
                    rows: [
                        {
                            ...itemRow,
                            cells: {
                                ...itemRow.cells,
                                // The anchor failed…
                                ref: {
                                    outcome: "failed",
                                    provenance: "system",
                                    error: "Could not load the item",
                                },
                                // …and a second reference column must not grow
                                // a copy of the row's verbs, nor a title verb.
                                cites_ref: {
                                    outcome: "answered",
                                    provenance: "system",
                                    value: {
                                        kind: "reference",
                                        display_name: "Smith 2020",
                                    },
                                },
                            },
                        },
                    ],
                },
            }),
        );
        const row = container!.querySelector("tr.bt-row")!;
        expect(row.querySelectorAll(".bt-ref-actions")).toHaveLength(1);
        expect(
            row.querySelector(
                '.bt-td-anchor .bt-ref-actions button[aria-label="Reveal in library"]',
            ),
        ).not.toBeNull();
        expect(row.querySelector(".bt-ref-title-button")).toBeNull();
    });

    it("puts the verbs beyond the primary one behind a menu on the anchor cell", () => {
        setHost({
            navigation: {
                revealInLibrary: vi.fn(),
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
        mount(
            React.createElement(DataTable, {
                table: {
                    ...spec,
                    capabilities: { row_actions: ["reveal", "open"] },
                },
            }),
        );
        const rows = container!.querySelectorAll("tr.bt-row");
        const actions = rows[1].querySelector(".bt-td-anchor .bt-ref-actions")!;
        expect(
            actions.querySelector('button[aria-label="Reveal in library"]'),
        ).not.toBeNull();
        expect(
            actions.querySelector('button[aria-label="More actions"]'),
        ).not.toBeNull();
    });

    it("marks answers to review, stale, from title and abstract and user-owned cells", () => {
        const text = (value: string): CellValue => ({
            kind: "text",
            text: value,
        });
        const read = (value: CellValue, extra: Record<string, unknown> = {}) =>
            ({ outcome: "answered", provenance: "model", documents: ["u-DOC1"], value, ...extra }) as Cell;
        const table: TableSpec = {
            id: "states",
            columns: [
                { id: "m", header: "Methods", type: "text" },
                { id: "n", header: "Sample", type: "number" },
            ],
            rows: [
                {
                    id: "review",
                    documents: ["u-DOC1"],
                    cells: {
                        m: read(text("Survey"), { confidence: "low" }),
                        // Medium marks a number, never prose.
                        n: read({ kind: "number", value: 40 }, { confidence: "medium" }),
                    },
                },
                {
                    id: "medium",
                    documents: ["u-DOC1"],
                    cells: { m: read(text("Cohort"), { confidence: "medium" }) },
                },
                {
                    id: "stale",
                    documents: ["u-DOC1"],
                    cells: { m: read(text("Panel"), { stale: true }) },
                },
                {
                    id: "moved",
                    documents: ["u-DOC2"],
                    cells: { m: read(text("Diary")) },
                },
                {
                    id: "metadata",
                    cells: {
                        m: { outcome: "answered", provenance: "model", value: text("Interviews") },
                    },
                },
                {
                    id: "cleared",
                    cells: { m: { outcome: "cleared", provenance: "user" } },
                },
                {
                    id: "edited",
                    documents: ["u-DOC2"],
                    cells: {
                        m: {
                            outcome: "answered",
                            provenance: "user",
                            value: text("Experiment"),
                        },
                    },
                },
                {
                    id: "blanked",
                    cells: { m: { outcome: "not_reported", provenance: "user" } },
                },
            ],
        };
        mount(React.createElement(DataTable, { table }));
        const cell = (rowId: string, column = "m") =>
            container!.querySelector(`[id="${rowId}/${column}"]`)!;

        expect(cell("review").textContent).toBe("Survey · To review");
        expect(cell("review").querySelector(".bt-review")?.getAttribute("title")).toBe(
            "Beaver is not confident in this answer; check it against the paper",
        );
        expect(cell("review", "n").textContent).toBe("40 · To review");
        expect(cell("medium").textContent).toBe("Cohort");
        expect(cell("stale").textContent).toBe("Panel · Stale");
        expect(cell("stale").querySelector(".bt-stale")?.getAttribute("title")).toBe("The question changed");
        expect(cell("moved").querySelector(".bt-stale")?.getAttribute("title")).toBe(
            "The paper's document changed",
        );
        expect(
            cell("metadata").querySelector(".bt-title-abstract")?.textContent,
        ).toBe(" · From title and abstract");
        expect(cell("metadata").closest("td")?.classList.contains("bt-td-title-abstract")).toBe(true);
        expect(cell("cleared").textContent).toBe(" · Cleared by you");
        expect(cell("edited").querySelector(".bt-edited")).not.toBeNull();
        // A user's answer is never stale by the row rule.
        expect(cell("edited").querySelector(".bt-stale")).toBeNull();
        expect(
            cell("edited").querySelector('.bt-edit-mark[title="Edited by you"]'),
        ).not.toBeNull();
        expect(cell("blanked").textContent).toBe("Not reported · Edited by you");
    });

    it("reads an absence as an answer, with the reason first and the closest passages after", () => {
        const table: TableSpec = {
            id: "absent",
            columns: [
                { id: "rct", header: "RCT?", type: "boolean" },
                { id: "funder", header: "Funder", type: "text" },
            ],
            rows: [
                {
                    id: "r",
                    documents: ["u-DOC1"],
                    cells: {
                        rct: {
                            outcome: "answered",
                            provenance: "model",
                            documents: ["u-DOC1"],
                            value: { kind: "boolean", value: false },
                            absent: true,
                            reasoning: "No randomisation is described.",
                            evidence: [{ document: "u-DOC1", locator: "s7", quote: "Participants chose a group." }],
                        },
                        funder: {
                            outcome: "not_reported",
                            provenance: "model",
                            documents: ["u-DOC1"],
                            reasoning: "No funding statement.",
                        },
                    },
                },
            ],
        };
        mount(React.createElement(DataTable, { table }));
        const rct = container!.querySelector('[id="r/rct"]')!;
        expect(rct.querySelector(".bt-bool-no")?.textContent).toBe("No");
        expect(rct.querySelector(".bt-absent")?.textContent).toBe(" · not in paper");
        expect(container!.querySelector('[id="r/funder"]')?.textContent).toBe("Not reported");

        click(container!.querySelector(".bt-rail-chevron"));
        const [rctDetail, funderDetail] = Array.from(container!.querySelectorAll(".bt-detail dd"));
        const parts = Array.from(rctDetail.querySelectorAll(".bt-details-text, .bt-details-label, li")).map(
            (el) => el.textContent,
        );
        expect(parts[0]).toBe("No randomisation is described.");
        expect(parts[1]).toBe("Closest passages");
        expect(parts[2]).toContain("“Participants chose a group.”");
        // A not-reported cell shows its reason.
        expect(funderDetail.querySelector(".bt-details-text")?.textContent).toBe("No funding statement.");
    });

    it("shows a number's display text as is, and the unit only beside a bare number", () => {
        const table: TableSpec = {
            id: "numbers",
            columns: [{ id: "share", header: "Share", type: "number", unit: "%" }],
            rows: [
                { id: "worded", cells: { share: answered({ kind: "number", value: 90, display: "90% or higher" }) } },
                { id: "bare", cells: { share: answered({ kind: "number", value: 12 }) } },
            ],
        };
        mount(React.createElement(DataTable, { table }));
        const worded = container!.querySelector('[id="worded/share"]')!;
        expect(worded.textContent).toBe("90% or higher");
        expect(worded.querySelector(".bt-unit")).toBeNull();
        expect(container!.querySelector('[id="bare/share"] .bt-unit')?.textContent).toBe("%");
    });

    it("sets a cited table row's caption and header rows above its quote", () => {
        const table: TableSpec = {
            id: "context",
            columns: [{ id: "share", header: "Share", type: "number" }],
            rows: [
                {
                    id: "r",
                    documents: ["u-DOC1"],
                    cells: {
                        share: {
                            outcome: "answered",
                            provenance: "model",
                            documents: ["u-DOC1"],
                            value: { kind: "number", value: 41 },
                            evidence: [
                                {
                                    document: "u-DOC1",
                                    locator: "s30",
                                    quote: "Women 41",
                                    context: "Table 2. Participants | Group | %",
                                },
                            ],
                        },
                    },
                },
            ],
        };
        mount(React.createElement(DataTable, { table }));
        click(container!.querySelector(".bt-rail-chevron"));
        const entry = container!.querySelector(".bt-detail .bt-details-list li")!;
        expect(entry.firstElementChild?.className).toBe("bt-evidence-context");
        expect(entry.firstElementChild?.textContent).toBe("Table 2. Participants | Group | %");
        expect(entry.textContent).toContain("“Women 41”");
        // Not a "closest passages" list: this is the answer's support.
        expect(container!.querySelector(".bt-detail .bt-details-label")).toBeNull();
    });

    it("tells a row with nothing to read from one whose document could not be read", () => {
        const table: TableSpec = {
            id: "failures",
            columns: [{ id: "m", header: "Methods", type: "text" }],
            rows: [
                {
                    id: "empty",
                    failure: { code: "no_source", message: "This item has no document or abstract to read." },
                    cells: {},
                },
                {
                    id: "locked",
                    documents: ["u-DOC1"],
                    failure: { code: "encrypted", message: "The PDF is password-protected." },
                    cells: {},
                },
            ],
        };
        mount(React.createElement(DataTable, { table }));
        const rows = container!.querySelectorAll("tr.bt-row");
        expect(rows[0].classList.contains("bt-row-error")).toBe(true);
        expect(rows[1].classList.contains("bt-row-error")).toBe(true);
        // Its unattempted cells stay empty.
        expect(container!.querySelector('[id="locked/m"]')?.textContent).toBe("");
        click(container!.querySelectorAll(".bt-rail-chevron")[0]);
        click(container!.querySelectorAll(".bt-rail-chevron")[1]);
        expect(
            Array.from(container!.querySelectorAll(".bt-detail-error")).map((el) => el.textContent),
        ).toEqual([
            "Nothing to read. This item has no document or abstract to read.",
            "Could not be read. The PDF is password-protected.",
        ]);
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

    it("starts a different table from its own hidden-column defaults", () => {
        const typeColumn = {
            id: "_type",
            header: "Type",
            type: "select" as const,
            role: "row_type" as const,
            system: true as const,
        };
        const itemRow = spec.rows[1];
        const uniform: TableSpec = {
            ...spec,
            id: "uniform",
            columns: [spec.columns[0], typeColumn],
            rows: [itemRow],
        };
        const mixed: TableSpec = {
            ...uniform,
            id: "mixed",
            rows: [itemRow, spec.rows[0]],
        };
        mount(React.createElement(DataTable, { table: uniform }));
        // One kind of row: the type column stays out of the way.
        expect(headerLabels()).toEqual(["Item"]);

        // Same mounted surface, another table: its own defaults apply rather
        // than the previous table's hidden set.
        act(() =>
            root?.render(React.createElement(DataTable, { table: mixed })),
        );
        expect(headerLabels()).toEqual(["Item", "Type"]);
    });

    it("keeps the viewer's column choices when the same table gains its stored key", () => {
        const typeColumn = {
            id: "_type",
            header: "Type",
            type: "select" as const,
            role: "row_type" as const,
            system: true as const,
        };
        const unsaved: TableSpec = {
            ...spec,
            id: "draft",
            columns: [spec.columns[0], typeColumn],
            rows: [spec.rows[1]],
        };
        let latest: TableState | null = null;
        function Harness({ table }: { table: TableSpec }) {
            const state = useTableState(table);
            latest = state;
            return React.createElement(DataTable, { table, state });
        }
        mount(React.createElement(Harness, { table: unsaved }));
        expect(headerLabels()).toEqual(["Item"]);
        act(() => latest!.toggleColumn("_type"));
        expect(headerLabels()).toEqual(["Item", "Type"]);

        // Persisting the table gives it a key; it is still the same table.
        act(() =>
            root?.render(
                React.createElement(Harness, {
                    table: { ...unsaved, key: "ABCD1234", version: 1 },
                }),
            ),
        );
        expect(headerLabels()).toEqual(["Item", "Type"]);

        // A different stored table is not.
        act(() =>
            root?.render(
                React.createElement(Harness, {
                    table: { ...unsaved, key: "WXYZ5678", version: 1 },
                }),
            ),
        );
        expect(headerLabels()).toEqual(["Item"]);
    });

    it("shows the type column as soon as the same table mixes kinds, but keeps a column the viewer hid", () => {
        const typeColumn = {
            id: "_type",
            header: "Type",
            type: "select" as const,
            role: "row_type" as const,
            system: true as const,
        };
        const uniform: TableSpec = {
            ...spec,
            id: "draft",
            columns: [spec.columns[0], typeColumn, spec.columns[1]],
            rows: [spec.rows[1]],
        };
        let latest: TableState | null = null;
        function Harness({ table }: { table: TableSpec }) {
            const state = useTableState(table);
            latest = state;
            return React.createElement(DataTable, { table, state });
        }
        mount(React.createElement(Harness, { table: uniform }));
        expect(headerLabels()).toEqual(["Item", "Citations"]);
        // The viewer hides Citations by hand.
        act(() => latest!.toggleColumn("cites"));
        expect(headerLabels()).toEqual(["Item"]);

        // An in-place update brings an annotation row: the type column is now
        // due by default, and the viewer's own choice about Citations stands.
        const annotationRow = {
            id: "rA",
            ref: {
                kind: "annotation" as const,
                library_ref: "u",
                library_id: 1,
                zotero_key: "A",
                attachment: { library_ref: "u", library_id: 1, zotero_key: "F" },
            },
            cells: {
                ref: {
                    outcome: "answered" as const,
                    provenance: "system" as const,
                    value: { kind: "annotation" as const, text: "A passage" },
                },
            },
        };
        act(() =>
            root?.render(
                React.createElement(Harness, {
                    table: {
                        ...uniform,
                        rows: [...uniform.rows, annotationRow],
                    },
                }),
            ),
        );
        expect(headerLabels()).toEqual(["Item", "Type"]);

        // Show all clears every override, defaults included.
        act(() => latest!.showAllColumns());
        expect(headerLabels()).toEqual(["Item", "Type", "Citations"]);
    });

    it("cannot tell two unstored tables with one render id apart, so a surface remounts between them", () => {
        const typeColumn = {
            id: "_type",
            header: "Type",
            type: "select" as const,
            role: "row_type" as const,
            system: true as const,
        };
        const first: TableSpec = {
            ...spec,
            id: "draft",
            columns: [spec.columns[0], typeColumn],
            rows: [spec.rows[1]],
        };
        // A different unstored table that happens to reuse the render id.
        const second: TableSpec = { ...first, rows: [spec.rows[2]] };
        let latest: TableState | null = null;
        function Harness({ table }: { table: TableSpec }) {
            const state = useTableState(table);
            latest = state;
            return React.createElement(DataTable, { table, state });
        }

        // Same React key: the hook has nothing to go on and keeps the choice.
        mount(React.createElement(Harness, { key: "showing-1", table: first }));
        act(() => latest!.toggleColumn("_type"));
        expect(headerLabels()).toEqual(["Item", "Type"]);
        act(() =>
            root?.render(
                React.createElement(Harness, {
                    key: "showing-1",
                    table: second,
                }),
            ),
        );
        expect(headerLabels()).toEqual(["Item", "Type"]);

        // A new showing remounts, and the second table starts from its own
        // defaults — which is what the Beaver window does per surface id.
        act(() =>
            root?.render(
                React.createElement(Harness, {
                    key: "showing-2",
                    table: second,
                }),
            ),
        );
        expect(headerLabels()).toEqual(["Item"]);
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
        // rail 3.2 + anchor 20 + number 8 ("Citations") + select 9.5
        // + boolean 9 ("Open access") + text 14: short columns fit their header.
        expect(style).toContain("63.7rem");
    });
});
