// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    createSentenceRange,
    createTableRowRange,
} from "../../../src/services/documentExtraction/dom/textRange";
import { linearizeTableRows, normalizeText } from "../../../src/services/documentExtraction/dom/domWalk";
import { buildAnnotationFromDocument } from "../../../src/services/annotations/snapshot/snapshotAnnotationResolver";
import type { SnapshotSelector } from "../../../src/services/annotations/snapshot/snapshotAnnotationGeometry";

function docWith(bodyHtml: string): Document {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = bodyHtml;
    return doc;
}

function isCss(
    selector: SnapshotSelector,
): selector is Extract<SnapshotSelector, { type: "CssSelector" }> {
    return selector.type === "CssSelector";
}

const TABLE_HTML =
    "<table>"
    + "<tr><td>Header A</td><td>Header B</td><td>Header C</td></tr>"
    + "<tr><td>Cell A</td><td>Cell B</td><td>Cell C</td></tr>"
    + "</table>";

describe("createTableRowRange — data-table citation matching", () => {
    it("locates a row from its extractor linearization (which never appears verbatim in the DOM)", () => {
        const doc = docWith(TABLE_HTML);
        // Sanity: this is exactly the sentence text extraction produces for the row.
        const rowText = linearizeTableRows(doc.querySelector("table")!)[1];
        expect(rowText).toBe("Cell A | Cell B | Cell C");

        // The " | " separator means the plain flat search cannot find it...
        const range = createSentenceRange(doc.body, rowText);
        expect(range).toBeDefined();
        // ...but the row is located and ranged over.
        const text = range!.toString();
        expect(text).toContain("Cell A");
        expect(text).toContain("Cell C");
        expect(text).not.toContain("Header A");
    });

    it("matches a truncated (prefix) row citation", () => {
        const doc = docWith(TABLE_HTML);
        const range = createTableRowRange(doc.body, "Cell A | Cell B");
        expect(range).toBeDefined();
        expect(range!.toString()).toContain("Cell B");
    });

    it("locates a row with an empty cell despite the stored double-space separator", () => {
        // Extraction joins cells without a final whitespace collapse, so an empty
        // cell yields a double space; the cited text arrives normalized to a single
        // space. The matcher must reconcile the two scales.
        const doc = docWith(
            "<table><tr><td>Cell A</td><td></td><td>Cell C</td></tr></table>",
        );
        const stored = linearizeTableRows(doc.querySelector("table")!)[0];
        expect(stored).toBe("Cell A |  | Cell C"); // double space around the empty cell
        const citedAsNormalized = normalizeText(stored);
        expect(citedAsNormalized).toBe("Cell A | | Cell C"); // single space in transit

        const range = createTableRowRange(doc.body, citedAsNormalized);
        expect(range).toBeDefined();
        expect(range!.toString()).toContain("Cell A");
        expect(range!.toString()).toContain("Cell C");
    });

    it("prefers an exact row match over a longer row it is a prefix of", () => {
        // The superset row appears FIRST in DOM order; an exact citation for the
        // shorter row must not be stolen by it via the prefix fallback.
        const doc = docWith(
            "<table>"
            + "<tr><td>A</td><td>B</td><td>C</td></tr>"
            + "<tr><td>A</td><td>B</td></tr>"
            + "</table>",
        );
        const range = createTableRowRange(doc.body, "A | B");
        expect(range).toBeDefined();
        // The exact "A | B" row has no "C".
        expect(range!.toString()).not.toContain("C");
    });

    it("does not let an earlier single-cell row steal a truncated multi-cell citation", () => {
        // A single-cell row ("Total") reconstructs without a separator and appears
        // FIRST; a truncated citation "Total | 100" must resolve to the real
        // multi-cell row, not the single-cell one (which "Total | 100" starts with).
        const doc = docWith(
            "<table>"
            + "<tr><td>Total</td></tr>"
            + "<tr><td>Total</td><td>100</td><td>200</td></tr>"
            + "</table>",
        );
        const range = createTableRowRange(doc.body, "Total | 100");
        expect(range).toBeDefined();
        expect(range!.toString()).toContain("200");
    });

    it("returns undefined for a non-matching row and for non-row text", () => {
        const doc = docWith(TABLE_HTML);
        expect(createTableRowRange(doc.body, "Nope X | Nope Y")).toBeUndefined();
        // No separator → not treated as a table row.
        expect(createTableRowRange(doc.body, "Cell A")).toBeUndefined();
    });

    it("does not mis-resolve pipe-containing prose onto an unrelated row (mid-cell prefix)", () => {
        // A shell snippet "cmd | grep x" contains " | " but is not a table row.
        // A 2-cell row whose cells are "cmd" and "grep" is a substring prefix of
        // it, yet "grep" only partially overlaps the cited cell "grep x" — the
        // cell-boundary guard must reject it rather than land on the wrong row.
        const doc = docWith(
            "<table><tr><td>cmd</td><td>grep</td></tr></table>",
        );
        expect(createTableRowRange(doc.body, "cmd | grep x")).toBeUndefined();
        // And the same passage routed through createSentenceRange (flat search
        // misses because " | " is absent verbatim) likewise resolves to nothing.
        expect(createSentenceRange(doc.body, "cmd | grep x")).toBeUndefined();
    });

    it("still matches a cell-aligned shorter live row (longer truncated citation)", () => {
        // The cited text is longer than the live row, but ends a cell exactly at
        // the row's last cell boundary, so it is a genuine structural match.
        const doc = docWith(
            "<table><tr><td>A</td><td>B</td></tr></table>",
        );
        const range = createTableRowRange(doc.body, "A | B | C");
        expect(range).toBeDefined();
        expect(range!.toString()).toContain("B");
    });

    it("resolves a snapshot annotation for a table-row citation instead of failing", () => {
        const doc = docWith(TABLE_HTML);
        const built = buildAnnotationFromDocument(doc, { text: "Cell A | Cell B | Cell C" });

        expect("error" in built).toBe(false);
        if ("error" in built) return;
        expect(isCss(built.position)).toBe(true);
        if (!isCss(built.position)) return;

        // The stored selector resolves to the cited row in the (overlay-bearing) body.
        const resolved = doc.body.querySelector(built.position.value);
        expect(resolved?.localName).toBe("tr");
        expect(resolved?.textContent).toContain("Cell C");
    });
});
