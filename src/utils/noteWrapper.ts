/**
 * Zotero note wrapper div + `data-citation-items` handling.
 *
 * Zotero notes are stored as a single `<div data-schema-version="N"
 * data-citation-items="…">…</div>` wrapper around the real content. This
 * module handles stripping, inspecting, and rebuilding that wrapper.
 *
 *   - `findNoteWrapperBounds`     locate the wrapper's body, or refuse
 *   - `stripNoteWrapperDiv`       remove the outer wrapper entirely
 *   - `hasSchemaVersionWrapper`   predicate on the root element
 *   - `stripDataCitationItems`    remove only the cache attribute
 *   - `extractDataCitationItems`  parse the cache attribute
 *   - `rebuildDataCitationItems`  regenerate the cache from inline citations
 */

// =============================================================================
// Wrapper Div
// =============================================================================

/** Offsets delimiting the body of a note's outer wrapper `<div>`. */
export interface NoteWrapperBounds {
    /** Offset in the INPUT string just past the wrapper's opening `<div …>` tag. */
    bodyStart: number;
    /** Offset in the INPUT string of the wrapper's closing `</div>`. */
    bodyEnd: number;
}

// Length of the closing `</div>` terminator.
const CLOSING_DIV_LEN = 6;

/**
 * Locate the body of the outer wrapper `<div data-schema-version="N">…</div>`,
 * or return `null` when this HTML has no strippable wrapper.
 *
 * WHY THIS EXISTS: `stripNoteWrapperDiv` returns the input UNCHANGED in every
 * case where it declines to strip, so a caller cannot tell "there was nothing to
 * strip" from "I refused". Block addressing must be able to refuse — it splices
 * by offset into the raw note, and an unrecognized wrapper means every offset it
 * would compute is meaningless. This helper is the refusal-capable form: the
 * detection logic is identical, only the failure signal differs.
 *
 * COORDINATE SPACE: the returned offsets are valid in the ORIGINAL, untrimmed
 * `html`. Detection runs on `html.trim()` (as it always has), so the leading
 * whitespace length is added back before returning. `html.slice(bodyStart,
 * bodyEnd)` is therefore always exactly what `stripNoteWrapperDiv(html)`
 * returns — including for notes that begin with whitespace, where forgetting
 * the offset would shift every subsequent splice.
 */
export function findNoteWrapperBounds(html: string): NoteWrapperBounds | null {
    const trimmed = html.trim();
    // Must start with <div and end with </div>
    if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) {
        return null;
    }
    // Find the end of the opening <div ...> tag
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle === -1) return null;

    // Inner content spans (opening tag end, closing `</div>`) in TRIMMED
    // coordinates. `String.prototype.substring` — which the original
    // implementation used — SWAPS its arguments when start > end, which happens
    // for degenerate input whose only `>` is the one in the trailing `</div>`
    // (e.g. `<div class="a" </div>`). min/max reproduces that exactly, so this
    // helper and `stripNoteWrapperDiv` stay byte-identical on such input.
    const rawStart = closeAngle + 1;
    const rawEnd = trimmed.length - CLOSING_DIV_LEN;
    const lo = Math.min(rawStart, rawEnd);
    const hi = Math.max(rawStart, rawEnd);
    const inner = trimmed.slice(lo, hi);

    // Only strip if the inner content doesn't have unmatched div nesting
    // (i.e., there's exactly one wrapper div, not nested divs where removing
    // the outer one would break structure)
    const innerDivOpens = (inner.match(/<div[\s>]/g) || []).length;
    const innerDivCloses = (inner.match(/<\/div>/g) || []).length;
    if (innerDivOpens !== innerDivCloses) {
        return null; // Unbalanced inner divs — don't strip
    }

    // Translate back into the ORIGINAL string's coordinates.
    const leadingWhitespace = html.length - html.trimStart().length;
    return { bodyStart: leadingWhitespace + lo, bodyEnd: leadingWhitespace + hi };
}

/**
 * Strip the outer wrapper `<div data-schema-version="N">...</div>` from note HTML.
 *
 * Zotero notes returned by `item.getNote()` / editor `getDataSync()` are wrapped
 * in a single `<div>` (with optional `data-schema-version` and `data-citation-items`
 * attributes). This wrapper is structural metadata — not content the agent should
 * interact with. Stripping it from simplified output prevents the agent from
 * anchoring edits on `</div>`, which causes undo failures.
 *
 * Only strips when the HTML starts with `<div` and ends with `</div>` to avoid
 * accidentally stripping content from fragments or non-note HTML.
 *
 * This is a thin wrapper over {@link findNoteWrapperBounds}. Its TOLERANT
 * signature — `string → string`, returning the input unchanged whenever there is
 * nothing to strip — is deliberately preserved: `edit_note` and
 * `edit_note_batch` depend on byte-identical behavior. Callers that need to
 * distinguish "nothing to strip" from "refused" must call
 * {@link findNoteWrapperBounds} directly.
 */
export function stripNoteWrapperDiv(html: string): string {
    const bounds = findNoteWrapperBounds(html);
    if (!bounds) return html;
    return html.slice(bounds.bodyStart, bounds.bodyEnd);
}

/**
 * Check whether the HTML has a root `<div data-schema-version="...">` wrapper element.
 * Only inspects the opening tag of the root element — not arbitrary substrings —
 * so content that merely mentions `data-schema-version` (e.g. code blocks) won't match.
 */
export function hasSchemaVersionWrapper(html: string): boolean {
    const trimmed = html.trim();
    if (!trimmed.startsWith('<div')) return false;
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle === -1) return false;
    const openingTag = trimmed.substring(0, closeAngle + 1);
    return /data-schema-version="/.test(openingTag);
}

// =============================================================================
// data-citation-items
// =============================================================================

/**
 * Strip data-citation-items attribute from the wrapper div.
 */
export function stripDataCitationItems(html: string): string {
    return html.replace(/\s*data-citation-items="[^"]*"/g, '');
}

/**
 * Extract the `data-citation-items` cache from the wrapper div, if present.
 * Returns the parsed array of stored citation items (each with `uris` and
 * `itemData`), or `null` when the attribute is missing or malformed.
 */
export function extractDataCitationItems(html: string): Array<{ uris: string[]; itemData: any }> | null {
    const match = html.match(/data-citation-items="([^"]*)"/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(match[1]));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Rebuild the data-citation-items attribute on the wrapper div.
 *
 * Scans all data-citation attributes in the HTML, collects unique URIs, and
 * resolves itemData for each. When `existingCache` is supplied (the pre-edit
 * cache from the wrapper), itemData is sourced from the cache first and only
 * looked up fresh when a URI is missing from the cache. This preserves
 * itemData for notes whose citations reference items outside the current
 * user's library (shared notes, imported notes, foreign userIDs) where
 * `Zotero.URI.getURIItemLibraryKey` would fail to resolve — without the
 * cache, Zotero's ProseMirror re-serialises those citations as `()`.
 */
export function rebuildDataCitationItems(
    html: string,
    existingCache?: Array<{ uris: string[]; itemData: any }> | null
): string {
    const storedCitationItems: any[] = [];
    const seenUris = new Set<string>();
    const citationAttrRegex = /data-citation="([^"]*)"/g;

    // Build a URI → itemData lookup from the pre-edit cache so we can preserve
    // itemData even when URI resolution fails (e.g. foreign user libraries).
    const cachedByUri = new Map<string, any>();
    if (existingCache) {
        for (const entry of existingCache) {
            if (!entry?.itemData || !Array.isArray(entry.uris)) continue;
            for (const uri of entry.uris) {
                if (!cachedByUri.has(uri)) cachedByUri.set(uri, entry.itemData);
            }
        }
    }

    let attrMatch;
    while ((attrMatch = citationAttrRegex.exec(html)) !== null) {
        try {
            const citation = JSON.parse(decodeURIComponent(attrMatch[1]));
            for (const ci of citation.citationItems || []) {
                const uriKey = ci.uris?.[0];
                if (uriKey && !seenUris.has(uriKey)) {
                    seenUris.add(uriKey);

                    // Prefer the pre-edit cache: it already has correct itemData
                    // for items that may not resolve via URI (foreign libraries).
                    const cachedItemData = cachedByUri.get(uriKey);
                    if (cachedItemData) {
                        storedCitationItems.push({ uris: ci.uris, itemData: cachedItemData });
                        continue;
                    }

                    // Fresh lookup for new citations not in the pre-edit cache.
                    const itemInfo = (Zotero.URI as any).getURIItemLibraryKey(uriKey);
                    if (itemInfo) {
                        const item = Zotero.Items.getByLibraryAndKey(itemInfo.libraryID, itemInfo.key);
                        if (item) {
                            storedCitationItems.push({
                                uris: ci.uris,
                                itemData: Zotero.Utilities.Item.itemToCSLJSON(item)
                            });
                        }
                    }
                }
            }
        } catch {
            // Skip malformed citation attributes
        }
    }

    if (storedCitationItems.length > 0) {
        const encoded = encodeURIComponent(JSON.stringify(storedCitationItems));
        // Insert after the opening <div ... data-schema-version="N" tag
        html = html.replace(
            /(<div\s[^>]*data-schema-version="[^"]*")([^>]*>)/,
            `$1 data-citation-items="${encoded}"$2`
        );
    }

    return html;
}
