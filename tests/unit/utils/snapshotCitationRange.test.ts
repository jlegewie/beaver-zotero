// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveSnapshotCitationRange } from "../../../react/utils/snapshotVisualizer/snapshotRangeResolver";

function bodyWith(html: string): HTMLElement {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = html;
    return doc.body;
}

describe("resolveSnapshotCitationRange", () => {
    it("finds the cited sentence and returns a matching range", () => {
        const body = bodyWith(
            "<p>First sentence here. The cited sentence lives here. Last one.</p>",
        );
        const range = resolveSnapshotCitationRange(body, {
            text: "The cited sentence lives here.",
        });
        expect(range?.toString()).toBe("The cited sentence lives here.");
    });

    it("disambiguates repeated phrases via the anchor id scope", () => {
        const body = bodyWith(
            '<p id="p1">Repeated phrase.</p><p id="p2">Repeated phrase.</p>',
        );
        const range = resolveSnapshotCitationRange(body, {
            anchorId: "p2",
            text: "Repeated phrase.",
        });
        const second = body.querySelector("#p2")!;
        expect(range).not.toBeNull();
        expect(second.contains(range!.startContainer)).toBe(true);
    });

    it("falls back to the anchor element contents when the text is not found", () => {
        const body = bodyWith(
            '<p id="target">Anchor paragraph content.</p><p>Other.</p>',
        );
        const range = resolveSnapshotCitationRange(body, {
            anchorId: "target",
            text: "Text that appears nowhere in the snapshot.",
        });
        expect(range?.toString()).toBe("Anchor paragraph content.");
    });

    it("resolves an anchor-only locator (anchor id, no cited text) to the anchor contents", () => {
        // An anchor-only snapshot citation must still spotlight on click — the
        // same locator produces a saved highlight headlessly.
        const body = bodyWith(
            '<p id="intro">Some lead-in text.</p><p id="target">Anchored passage with no cited text.</p>',
        );
        const range = resolveSnapshotCitationRange(body, { anchorId: "target" });
        expect(range?.toString()).toBe("Anchored passage with no cited text.");
        expect(body.querySelector("#target")!.contains(range!.startContainer)).toBe(true);
    });

    it("returns null when neither the anchor nor the text resolves", () => {
        const body = bodyWith("<p>Some content.</p>");
        const range = resolveSnapshotCitationRange(body, {
            anchorId: "missing-anchor",
            text: "Text that appears nowhere in the snapshot.",
        });
        expect(range).toBeNull();
    });

    it("returns null for an empty locator", () => {
        const body = bodyWith("<p>Some content.</p>");
        expect(resolveSnapshotCitationRange(body, {})).toBeNull();
    });
});
