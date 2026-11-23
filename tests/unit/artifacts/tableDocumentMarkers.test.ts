import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Evidence, TableSpec } from "@beaver/agent-core/layouts/table";

const citationCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@beaver/agent-core/layouts/tableCitations", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@beaver/agent-core/layouts/tableCitations")>();
    return {
        ...actual,
        citationForEvidence: (...args: Parameters<typeof actual.citationForEvidence>) => {
            citationCalls.count += 1;
            return actual.citationForEvidence(...args);
        },
    };
});

import { buildTableDocument } from "../../../src/services/artifacts/tableDocument";

function evidence(quote: string, document: string): Evidence {
    return { document, locator: "s3", quote, page: 2 };
}

function specWith(rows: TableSpec["rows"]): TableSpec {
    return {
        id: "t",
        title: "Markers",
        columns: [
            { id: "_reference", header: "Item", type: "reference" },
            { id: "finding", header: "Finding", type: "text", description: "What did it find?" },
        ],
        rows,
    };
}

function row(id: string, key: string, entries: Evidence[]): TableSpec["rows"][number] {
    return {
        id,
        ref: { kind: "item", library_ref: "u", library_id: 1, zotero_key: key },
        documents: [`u-${key}PDF`],
        cells: {
            _reference: { outcome: "answered", provenance: "system", value: { kind: "reference", display_name: id } },
            finding: { outcome: "answered", provenance: "system", value: { kind: "text", text: "Yes" }, evidence: entries },
        },
    };
}

describe("evidence markers in the static document", () => {
    beforeEach(() => {
        citationCalls.count = 0;
    });

    it("builds each evidence entry's citation once, though the entry renders in its cell and its expanded row", () => {
        const html = buildTableDocument(
            specWith([
                row("r1", "AAAA1111", [evidence("first", "u-AAAA1111PDF"), evidence("second", "u-AAAA1111PDF")]),
                row("r2", "BBBB2222", [evidence("third", "u-BBBB2222PDF")]),
            ]),
        ).html;

        expect(citationCalls.count).toBe(3);
        // Each entry's marker still appears twice: in the grid and beside its quote.
        expect(html.match(/class="bt-cite /g)).toHaveLength(6);
    });

    it("builds a marker per row for an entry object two rows share", () => {
        const shared = evidence("shared", "u-AAAA1111PDF");
        const html = buildTableDocument(
            specWith([row("r1", "AAAA1111", [shared]), row("r2", "BBBB2222", [shared])]),
        ).html;

        expect(citationCalls.count).toBe(2);
        expect(html.match(/class="bt-cite /g)).toHaveLength(4);
    });
});
