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

// Charset labels that decode identically to UTF-8 for extraction purposes.
const UTF8_COMPATIBLE_CHARSETS = new Set(["utf-8", "utf8", "us-ascii", "ascii"]);

/**
 * Return the lowercased declared charset, or null when none can be read.
 */
export function getDeclaredCharset(doc: Document): string | null {
    try {
        const metaCharset = doc.querySelector("meta[charset]")?.getAttribute("charset");
        if (metaCharset && metaCharset.trim()) return metaCharset.trim().toLowerCase();
        const contentType = doc
            .querySelector('meta[http-equiv="content-type" i]')
            ?.getAttribute("content");
        const match = contentType ? /charset\s*=\s*([^\s;"']+)/i.exec(contentType) : null;
        return match ? match[1].trim().toLowerCase() : null;
    } catch {
        return null;
    }
}

/** True when a declared charset is present and not UTF-8/ASCII compatible. */
export function isLikelyNonUtf8Charset(charset: string | null): boolean {
    return charset != null && !UTF8_COMPATIBLE_CHARSETS.has(charset);
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
