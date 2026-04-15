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
import { extractAttr } from './noteCitationExpand';

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
 * Enrich no-ref citations in `old_string` with the `ref` attribute from the
 * metadata map.
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
        // Only enrich item_id citations; att_id maps to parent item_id at
        // simplification time so the reverse lookup isn't unique.
        const itemId = extractAttr(attrStr, 'item_id');
        if (!itemId) continue;
        const page = extractAttr(attrStr, 'page') || undefined;

        // Find metadata entries whose originalAttrs match exactly.
        let candidateRef: string | null = null;
        let candidateCount = 0;
        for (const [ref, el] of metadata.elements) {
            if (el.type !== 'citation') continue;
            if (el.originalAttrs?.item_id !== itemId) continue;
            const storedPage = el.originalAttrs.page || undefined;
            if (storedPage !== page) continue;
            candidateRef = ref;
            candidateCount++;
            if (candidateCount > 1) break;
        }

        // Unique candidate only — ambiguous or missing citations fall through.
        if (candidateCount !== 1 || candidateRef === null) continue;

        // Inject ` ref="..."` before the self-closing `/>`, preserving all
        // existing attributes verbatim. extractAttr's word-boundary guard
        // requires the attribute to be preceded by a non-word character, so
        // we always prepend a space.
        const trimmedAttrs = attrStr.replace(/\s+$/, '');
        const enrichedTag = `<citation ${trimmedAttrs} ref="${candidateRef}"/>`;

        replacements.push({
            start: m.index,
            end: m.index + m[0].length,
            replacement: enrichedTag,
        });
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
