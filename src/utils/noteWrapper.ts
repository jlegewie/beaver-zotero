/**
 * Zotero note wrapper div + `data-citation-items` handling.
 *
 * Zotero notes are stored as a single `<div data-schema-version="N"
 * data-citation-items="…">…</div>` wrapper around the real content. This
 * module handles stripping, inspecting, and rebuilding that wrapper.
 *
 *   - `stripNoteWrapperDiv`       remove the outer wrapper entirely
 *   - `hasSchemaVersionWrapper`   predicate on the root element
 *   - `stripDataCitationItems`    remove only the cache attribute
 *   - `extractDataCitationItems`  parse the cache attribute
 *   - `rebuildDataCitationItems`  regenerate the cache from inline citations
 */

// =============================================================================
// Wrapper Div
// =============================================================================

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
 */
export function stripNoteWrapperDiv(html: string): string {
    const trimmed = html.trim();
    // Must start with <div and end with </div>
    if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) {
        return html;
    }
    // Find the end of the opening <div ...> tag
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle === -1) return html;
    // Extract inner content (between opening tag and closing </div>)
    const inner = trimmed.substring(closeAngle + 1, trimmed.length - 6);
    // Only strip if the inner content doesn't have unmatched div nesting
    // (i.e., there's exactly one wrapper div, not nested divs where removing
    // the outer one would break structure)
    const innerDivOpens = (inner.match(/<div[\s>]/g) || []).length;
    const innerDivCloses = (inner.match(/<\/div>/g) || []).length;
    if (innerDivOpens !== innerDivCloses) {
        return html; // Unbalanced inner divs — don't strip
    }
    return inner;
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
