/**
 * Parse a snapshot's HTML into the same DOM the Zotero reader renders, so headless
 * anchor ids, character offsets, and CSS selectors line up with the live
 * `SnapshotView`. The single parse entry point for every headless snapshot DOM
 * (extraction, annotation resolution, and the reference for live navigation).
 *
 * Mirrors the reader's `_getSrcDoc` (reader/src/dom/snapshot/snapshot-view.ts):
 * utf-8 decode → parse as `text/html` → strip `<base>`, CSP `<meta>`, and
 * `<noscript>` → serialize and reparse. The reader feeds the serialized HTML into
 * the iframe `srcdoc`, which reparses it; doing the round-trip unconditionally
 * makes malformed/mis-nested markup normalize identically (so `:nth-child` indices
 * agree). The base/CSP elements the reader adds to `<head>` are intentionally not
 * reproduced — every selector, offset, and anchor is body-scoped, so head-only
 * changes never affect them, and this keeps the parser independent of the source
 * URL.
 */

function removeMatching(doc: Document, selector: string): void {
    const nodes = doc.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) {
        (nodes.item(i) as Element | null)?.remove();
    }
}

/** Apply the reader's in-place pre-parse transforms (body-affecting subset). */
export function prepareSnapshotDocument(doc: Document): void {
    removeMatching(doc, "base");
    removeMatching(doc, 'meta[http-equiv="Content-Security-Policy" i]');
    // Removing <noscript> matches the reader and keeps body `:nth-child` indices
    // aligned (a left-in <noscript> sibling would shift them).
    removeMatching(doc, "noscript");
}

/** Decode + parse + transform + serialize/reparse snapshot bytes into a Document. */
export function parseSnapshotHtml(bytes: Uint8Array): Document {
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed = new DOMParser().parseFromString(text, "text/html");
    prepareSnapshotDocument(parsed);

    // Serialize + reparse to match the reader's iframe `srcdoc` round-trip.
    const doctype = parsed.doctype
        ? new XMLSerializer().serializeToString(parsed.doctype)
        : "";
    const html = parsed.documentElement?.outerHTML ?? "";
    return new DOMParser().parseFromString(doctype + html, "text/html");
}
