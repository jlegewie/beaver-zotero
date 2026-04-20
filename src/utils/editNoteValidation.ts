/**
 * `edit_note` new-string / old-string validation helpers.
 *
 *   - `validateNewString`          reject fabricated annotations / images /
 *                                  compound citations in new_string
 *   - `checkNewCitationItemsExist` verify any new citations reference items
 *                                  that actually exist in the library
 *   - `checkDuplicateCitations`    warn when a new citation duplicates an
 *                                  already-cited item
 *   - `enrichOldStringCitationRefs` / `applyOldStringEnrichment`
 *                                  add the `ref` attribute to no-ref citations
 *                                  in old_string so existing citations are
 *                                  identified unambiguously
 */

import type { SimplificationMetadata } from './noteHtmlSimplifier';
import {
    extractAttr,
    normalizePageLocator,
    translatePageNumberToLabel,
} from './noteCitationExpand';

// =============================================================================
// New-string validation
// =============================================================================

/**
 * Validate new_string for fabricated annotations/images and invalid citations.
 * Returns an error message string, or null if valid.
 */
export function validateNewString(
    newString: string,
    metadata: SimplificationMetadata
): string | null {
    // Check for fabricated annotations (id not in map, or no id at all)
    const annotationRegex = /<annotation(?:\s+id="(a_[^"]*)")?[^>]*>[\s\S]*?<\/annotation>/g;
    let annotMatch;
    while ((annotMatch = annotationRegex.exec(newString)) !== null) {
        const id = annotMatch[1];
        if (!id || !metadata.elements.has(id)) {
            return 'Error: New annotations cannot be created. Annotations originate from PDF highlights in the Zotero reader.';
        }
    }

    // Check for fabricated annotation-images
    const annotImageRegex = /<annotation-image(?:\s+id="(ai_[^"]*)")?[^/]*\/>/g;
    let aiMatch;
    while ((aiMatch = annotImageRegex.exec(newString)) !== null) {
        const id = aiMatch[1];
        if (!id || !metadata.elements.has(id)) {
            return 'Error: New annotation images cannot be created. They originate from PDF annotations in the Zotero reader.';
        }
    }

    // Check for fabricated images
    const imageRegex = /<image(?:\s+id="(i_[^"]*)")?[^/]*\/>/g;
    let imgMatch;
    while ((imgMatch = imageRegex.exec(newString)) !== null) {
        const id = imgMatch[1];
        if (!id || !metadata.elements.has(id)) {
            return 'Error: New images cannot be inserted via note editing. Use Zotero\'s editor to add images.';
        }
    }

    // Check for new compound citations (items attr without ref)
    const compoundRegex = /<citation\s+(?!.*ref=)([^/]*items="[^"]*"[^/]*)\/>/g;
    let compMatch;
    while ((compMatch = compoundRegex.exec(newString)) !== null) {
        return 'Error: Cannot create new compound citations. Insert individual <citation item_id="..." /> tags instead.';
    }

    return null;
}

/**
 * Check that all new citation tags in `newString` reference Zotero items that
 * actually exist.  Citations with a `ref` that maps to a known element in
 * metadata are treated as existing and skipped.  Citations with an unknown
 * `ref` are treated as new (the model likely fabricated the ref).
 *
 * Returns an error string if any cited item is missing, or `null` if all OK.
 */
export function checkNewCitationItemsExist(
    newString: string,
    metadata: SimplificationMetadata,
): string | null {
    const citationRegex = /<citation\s+([^/]*?)\s*\/>/g;
    let m;
    while ((m = citationRegex.exec(newString)) !== null) {
        const attrStr = m[1];
        const ref = extractAttr(attrStr, 'ref');

        // Existing citation whose ref is in the metadata map — skip
        if (ref && metadata.elements.has(ref)) continue;

        // New citation (no ref) or unknown ref — validate the item exists
        const itemId = extractAttr(attrStr, 'item_id');
        const attId = extractAttr(attrStr, 'att_id');
        const id = itemId || attId;
        if (!id) continue; // will fail later in expansion with a proper error

        const dashIdx = id.indexOf('-');
        if (dashIdx === -1) continue; // will fail later in expansion

        const libId = parseInt(id.substring(0, dashIdx), 10);
        const key = id.substring(dashIdx + 1);
        const item = Zotero.Items.getByLibraryAndKey(libId, key);
        if (!item) {
            const label = itemId ? 'item_id' : 'att_id';
            return `Citation references a Zotero item that does not exist: ${label}="${id}". Verify the item ID is correct.`;
        }
    }
    return null;
}

// =============================================================================
// Duplicate Citation Check
// =============================================================================

/**
 * When a new citation is inserted, check if the same item is already cited
 * elsewhere in the note. Returns a warning string or null.
 */
export function checkDuplicateCitations(
    newString: string,
    metadata: SimplificationMetadata
): string | null {
    // Find new citations (item_id without ref) in new_string
    const newCitationRegex = /<citation\s+(?![^/]*\bref=)[^>]*item_id="([^"]*)"[^/]*\/>/g;
    let match;
    const warnings: string[] = [];

    while ((match = newCitationRegex.exec(newString)) !== null) {
        const newItemId = match[1];
        // Check if any existing citation references the same item
        for (const [existingId, stored] of metadata.elements) {
            if (stored.type === 'citation' && stored.originalAttrs?.item_id === newItemId) {
                warnings.push(
                    ` (Note: item ${newItemId} is already cited in this note as ${existingId}` +
                    ` — if you intended to move the existing citation, use its ref attribute instead.)`
                );
                break;
            }
        }
    }
    return warnings.length > 0 ? warnings.join('') : null;
}

// =============================================================================
// Old-String Citation Ref Enrichment
// =============================================================================

/**
 * Find the unique ref in `metadata.elements` for a citation identified by
 * `item_id` + optional `page`. Returns `null` if zero or multiple entries
 * match (caller should skip enrichment and let the validator error path run).
 */
function findUniqueCitationRef(
    metadata: SimplificationMetadata,
    itemId: string,
    page: string | undefined,
): string | null {
    let candidateRef: string | null = null;
    let candidateCount = 0;
    for (const [ref, el] of metadata.elements) {
        if (el.type !== 'citation') continue;
        if (el.originalAttrs?.item_id !== itemId) continue;
        const storedPage = el.originalAttrs.page || undefined;
        if (storedPage !== page) continue;
        candidateRef = ref;
        candidateCount++;
        if (candidateCount > 1) return null;
    }
    return candidateCount === 1 ? candidateRef : null;
}

/**
 * Resolve an `att_id="LIB-KEY"` (attachment reference) to the parent item's
 * `item_id="LIB-PARENT_KEY"`. Returns the resolved parent id and the
 * attachment item (so callers can translate page numbers the same way
 * `buildCitationFromAttId` did at insert time), or `null` when:
 *   - the id is malformed
 *   - the item doesn't exist
 *   - the item isn't an attachment
 *   - the attachment has no parent (top-level)
 */
function resolveAttIdToParent(
    attId: string,
): { parentItemId: string; attachmentItem: any } | null {
    const dashIdx = attId.indexOf('-');
    if (dashIdx <= 0) return null;
    const libId = parseInt(attId.substring(0, dashIdx), 10);
    const key = attId.substring(dashIdx + 1);
    if (!libId || !key) return null;
    const item = Zotero.Items.getByLibraryAndKey(libId, key);
    if (!item || typeof item === 'boolean') return null;
    if (!item.isAttachment?.()) return null;
    const parentKey = (item as any).parentKey;
    if (!parentKey) return null;
    return {
        parentItemId: `${item.libraryID}-${parentKey}`,
        attachmentItem: item,
    };
}

/**
 * Normalize a citation page locator the way `buildCitationFromAttId` did at
 * insert time: strip whitespace, then translate pure-numeric locators from
 * 1-based page numbers to the attachment's page labels. Mirrors
 * `resolvePageForCitation(item, page, true)` in noteCitationExpand. Returns
 * the unchanged input when the cache isn't populated (label translation is
 * best-effort), which is why callers should compare both forms.
 */
function translateAttIdPageLocator(
    attachmentItem: any,
    page: string | undefined,
): string | undefined {
    if (!page) return undefined;
    const normalized = normalizePageLocator(page);
    try {
        if (attachmentItem?.id != null) {
            return translatePageNumberToLabel(attachmentItem.id, normalized);
        }
    } catch {
        /* best-effort */
    }
    return normalized;
}

/**
 * Enrich no-ref citations in `old_string` with the `ref` attribute from the
 * metadata map.
 *
 * Handles two source forms the model tends to produce in `old_string`:
 *   1. `<citation item_id="LIB-KEY"/>` — unique lookup by item_id + page,
 *      inject `ref`.
 *   2. `<citation att_id="LIB-ATT"/>` — resolve attachment to parent item,
 *      look up by parent item_id + page, rewrite as `item_id` + `ref`.
 *      Needed because the simplifier re-reads att_id-based citations in
 *      their parent-item form, so the model's recalled `att_id` text never
 *      exact-matches the current note.
 *
 * Returns the enriched `oldString`, or `null` if no citations were
 * enriched (caller should continue with the original `old_string`).
 */
export function enrichOldStringCitationRefs(
    oldString: string,
    metadata: SimplificationMetadata,
): string | null {
    if (!oldString) return null;

    interface Replacement { start: number; end: number; replacement: string; }
    const replacements: Replacement[] = [];

    const citationRe = /<citation\s+([^/]*?)\s*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = citationRe.exec(oldString)) !== null) {
        const attrStr = m[1];
        // Skip if it already has a ref — enrichment not needed
        if (extractAttr(attrStr, 'ref') !== undefined) continue;

        const page = extractAttr(attrStr, 'page') || undefined;

        const itemId = extractAttr(attrStr, 'item_id');
        if (itemId) {
            const candidateRef = findUniqueCitationRef(metadata, itemId, page);
            if (candidateRef === null) continue;

            // Inject ` ref="..."` before the self-closing `/>`, preserving all
            // existing attributes verbatim. extractAttr's word-boundary guard
            // requires the attribute to be preceded by a non-word character,
            // so we always prepend a space.
            const trimmedAttrs = attrStr.replace(/\s+$/, '');
            replacements.push({
                start: m.index,
                end: m.index + m[0].length,
                replacement: `<citation ${trimmedAttrs} ref="${candidateRef}"/>`,
            });
            continue;
        }

        const attId = extractAttr(attrStr, 'att_id');
        if (attId) {
            const resolved = resolveAttIdToParent(attId);
            if (!resolved) continue;
            const { parentItemId, attachmentItem } = resolved;

            // `buildCitationFromAttId` translates the 1-based page number
            // through the attachment's page-label map at insert time, so the
            // stored `originalAttrs.page` is the display label (e.g., "iii").
            // When the model re-uses its own prior att_id form — with the
            // raw number it originally wrote — the unadjusted comparison
            // misses the stored citation. Try both the translated and the
            // raw form before giving up, since the label cache may be empty
            // on a fresh session and we don't want the enrichment to be all-
            // or-nothing in that case.
            const translatedPage = translateAttIdPageLocator(attachmentItem, page);
            const candidateRef
                = findUniqueCitationRef(metadata, parentItemId, translatedPage)
                ?? (translatedPage !== page
                    ? findUniqueCitationRef(metadata, parentItemId, page)
                    : null);
            if (candidateRef === null) continue;

            // Drop `att_id` and write the parent `item_id` + `ref`. Use the
            // translated page so the enriched tag matches the simplified
            // form the matcher will see downstream.
            const finalPageAttr = translatedPage !== undefined
                ? ` page="${translatedPage}"`
                : '';
            replacements.push({
                start: m.index,
                end: m.index + m[0].length,
                replacement: `<citation item_id="${parentItemId}"${finalPageAttr} ref="${candidateRef}"/>`,
            });
            continue;
        }
    }

    if (replacements.length === 0) return null;

    // Apply replacements in reverse order so earlier indices stay valid.
    let result = oldString;
    for (let i = replacements.length - 1; i >= 0; i--) {
        const r = replacements[i];
        result = result.substring(0, r.start) + r.replacement + result.substring(r.end);
    }
    return result;
}

/**
 * Apply no-ref citation enrichment, returning the (possibly unchanged) string.
 * Centralizes the null-vs-string dance so validator + executor share one entry.
 */
export function applyOldStringEnrichment(
    oldString: string | undefined,
    metadata: SimplificationMetadata,
): string | undefined {
    if (!oldString) return oldString;
    const enriched = enrichOldStringCitationRefs(oldString, metadata);
    return enriched ?? oldString;
}
