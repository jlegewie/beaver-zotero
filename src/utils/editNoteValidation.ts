/**
 * `edit_note` new-string / old-string validation helpers.
 *
 *   - `validateNewString`          reject fabricated annotations / images /
 *                                  compound citations in new_string
 *   - `checkNewCitationItemsExist` verify any new citations reference items
 *                                  that actually exist in the library
 *   - `checkDuplicateCitations`    warn when a new citation duplicates an
 *                                  already-cited item
 *   - `normalizeOldStringCitations` / `applyOldStringEnrichment`
 *                                  fix up `<citation .../>` tags in old_string
 *                                  so they match current metadata. Handles two
 *                                  failure modes: (a) no ref — inject one; and
 *                                  (b) stale ref — rewrite it when the current
 *                                  ref is missing from metadata or points to a
 *                                  citation with different (item_id, page).
 *   - `enrichOldStringCitationRefs`
 *                                  deprecated alias kept for back-compat. New
 *                                  callers should use `normalizeOldStringCitations`.
 */

import type { SimplificationMetadata } from './noteHtmlSimplifier';
import {
    extractAttr,
    normalizePageLocator,
    translatePageNumberToLabel,
} from './noteCitationExpand';
import { escapeAttr } from './noteHtmlEntities';

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
 * Rewrite the `ref="..."` value inside a citation's attribute string.
 * Uses the same word-boundary guard as `extractAttr` so `xref="..."` or
 * similar substrings are never matched.
 */
function rewriteRefAttr(attrStr: string, newRef: string): string {
    return attrStr.replace(/(?<![\w])ref="[^"]*"/, `ref="${newRef}"`);
}

interface NormalizeCitationOptions {
    /**
     * When true, a bare citation (no `ref`) whose (item_id, page) uniquely
     * matches an existing citation in metadata is enriched by injecting the
     * current ref. Only valid for `old_string` — in `new_string`, a bare
     * citation is a legitimate new-citation request and must be preserved.
     */
    enrichBareCitations: boolean;
    /**
     * When true, a ref that exists in metadata as a single citation for the
     * same item but with a different `page` is treated as stale and repaired
     * via content lookup. Only valid for `old_string` — in `new_string`, a
     * ref + mismatched page is the supported way to edit an existing
     * citation's locator (expandToRawHtml rebuilds it with the new attrs),
     * so the ref must pass through unchanged.
     */
    repairMismatchedRefs: boolean;
}

/**
 * Core per-tag normalization — shared by old_string and new_string paths.
 * Single regex sweep, per-tag logic is branched by the caller-supplied
 * options.
 */
function normalizeCitationRefs(
    str: string,
    metadata: SimplificationMetadata,
    options: NormalizeCitationOptions,
): string | null {
    if (!str) return null;

    interface Replacement { start: number; end: number; replacement: string; }
    const replacements: Replacement[] = [];

    const citationRe = /<citation\s+([^/]*?)\s*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = citationRe.exec(str)) !== null) {
        const attrStr = m[1];
        const ref = extractAttr(attrStr, 'ref');
        const page = extractAttr(attrStr, 'page') || undefined;
        const itemId = extractAttr(attrStr, 'item_id');
        const attId = extractAttr(attrStr, 'att_id');

        // ── item_id branch (no-ref enrichment + stale-ref repair) ──
        if (itemId) {
            if (ref !== undefined) {
                const stored = metadata.elements.get(ref);
                const storedIsCitationForItem = (
                    stored?.type === 'citation'
                    && stored.originalAttrs?.item_id === itemId
                );
                if (storedIsCitationForItem) {
                    const storedPage = stored!.originalAttrs!.page || undefined;
                    if (storedPage === page) continue; // exact match — no change
                    // Page mismatches: in new_string this is a legitimate
                    // locator edit (`item_id + ref + new page` tells
                    // expandToRawHtml to rebuild with the new attrs), so the
                    // ref must pass through. In old_string, the ref is stale
                    // from renumbering and we repair below via content lookup.
                    if (!options.repairMismatchedRefs) continue;
                }
            }

            if (ref === undefined && !options.enrichBareCitations) {
                continue; // bare citation in new_string — legitimate new citation
            }

            const candidateRef = findUniqueCitationRef(metadata, itemId, page);
            if (candidateRef === null) continue;

            if (ref === undefined) {
                // No ref — inject one. extractAttr's word-boundary guard
                // requires a non-word char before the attribute name, so we
                // always prepend a space.
                const trimmedAttrs = attrStr.replace(/\s+$/, '');
                replacements.push({
                    start: m.index,
                    end: m.index + m[0].length,
                    replacement: `<citation ${trimmedAttrs} ref="${candidateRef}"/>`,
                });
            } else if (candidateRef !== ref) {
                // Stale ref — rewrite in place, preserving all other attrs.
                const newAttrStr = rewriteRefAttr(attrStr, candidateRef);
                replacements.push({
                    start: m.index,
                    end: m.index + m[0].length,
                    replacement: `<citation ${newAttrStr.replace(/^\s+/, '').replace(/\s+$/, '')}/>`,
                });
            }
            continue;
        }

        // ── att_id branch (resolve to parent, then preserve-if-valid or repair) ──
        if (attId) {
            // In new_string, a bare `att_id` citation is the model's canonical
            // form for a NEW citation from a PDF annotation. Only the stale-ref
            // repair path runs — a bare att_id must pass through so
            // expandToRawHtml('new') builds a fresh citation via
            // buildCitationFromAttId. The preserve-if-valid and content-lookup
            // branches below are both gated on `ref !== undefined` in that mode.
            if (ref === undefined && !options.enrichBareCitations) continue;

            const resolved = resolveAttIdToParent(attId);
            if (!resolved) continue;
            const { parentItemId, attachmentItem } = resolved;

            // `buildCitationFromAttId` translates the 1-based page number
            // through the attachment's page-label map at insert time, so the
            // stored `originalAttrs.page` is the display label (e.g., "iii").
            // When the model re-uses its own prior att_id form — with the raw
            // number it originally wrote — the unadjusted comparison misses
            // the stored citation. Try both translated and raw before giving
            // up, since the label cache may be empty on a fresh session and
            // we don't want normalization to be all-or-nothing in that case.
            const translatedPage = translateAttIdPageLocator(attachmentItem, page);

            // If the model already supplied a ref that resolves to a single
            // citation for this parent AND the tag's page doesn't contradict
            // the stored page, preserve the ref. Note metadata is always
            // stored as `item_id` (Zotero notes cannot cite attachments),
            // so parent-item equality is a necessary condition. The page
            // parity guard prevents a stale ref from silently retargeting
            // edits when the same parent is cited at multiple locators: if
            // the model wrote page="4" but the ref stores page="99", fall
            // through to content lookup below to find the real (parent, 4)
            // citation. When the tag omits page we defer to the stored form
            // (expandToRawHtml with ref + no item_id would return
            // stored.rawHtml verbatim, so the tag and stored form are
            // interchangeable).
            if (ref !== undefined) {
                const stored = metadata.elements.get(ref);
                if (
                    stored
                    && stored.type === 'citation'
                    && stored.originalAttrs?.item_id === parentItemId
                ) {
                    const storedPage = stored.originalAttrs.page || undefined;
                    const pageMatches = page === undefined
                        || storedPage === page
                        || storedPage === translatedPage;
                    if (pageMatches) {
                        // Escape the locator: `originalAttrs.page` is stored
                        // raw (unescaped) by the simplifier, while the
                        // emitted tag must be valid HTML for
                        // extractAttr/expandToRawHtml to round-trip it.
                        // Free-form locators like `fn. "A"` would otherwise
                        // produce malformed markup.
                        const pageAttr = storedPage !== undefined
                            ? ` page="${escapeAttr(storedPage)}"`
                            : '';
                        replacements.push({
                            start: m.index,
                            end: m.index + m[0].length,
                            replacement: `<citation item_id="${parentItemId}"${pageAttr} ref="${ref}"/>`,
                        });
                        continue;
                    }
                    // Page mismatch with a ref that still points at this
                    // parent: in new_string this is the locator-edit form
                    // (`att_id + ref + new page` → expandToRawHtml rebuilds
                    // with the new attrs), so the ref must pass through
                    // instead of being redirected to a sibling citation.
                    // In old_string, fall through to content lookup to repair.
                    if (!options.repairMismatchedRefs) continue;
                }
            }

            let matchedPage = translatedPage;
            let candidateRef = findUniqueCitationRef(metadata, parentItemId, translatedPage);
            if (candidateRef === null && translatedPage !== page) {
                candidateRef = findUniqueCitationRef(metadata, parentItemId, page);
                if (candidateRef !== null) matchedPage = page;
            }
            if (candidateRef === null) continue;

            // Drop `att_id` in favor of `item_id`. Writing the matched-page
            // variant keeps the downstream `attrsChanged` check in
            // expandToRawHtml treating this tag as identical to the stored
            // citation. Escape the locator — it comes from the simplifier's
            // raw stored form (or the model's input via translateAttIdPageLocator),
            // neither of which applies attribute escaping.
            const finalPageAttr = matchedPage !== undefined
                ? ` page="${escapeAttr(matchedPage)}"`
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
    let result = str;
    for (let i = replacements.length - 1; i >= 0; i--) {
        const r = replacements[i];
        result = result.substring(0, r.start) + r.replacement + result.substring(r.end);
    }
    return result;
}

/**
 * Normalize `<citation .../>` tags in `old_string` so they line up with the
 * current simplifier metadata. Two failure modes are handled:
 *
 *   1. **No ref** — the model wrote a bare citation (commonly from copying a
 *      form it used in `create_note`, where simplification later injected the
 *      ref). Inject the current ref when (item_id, page) is unique.
 *
 *   2. **Stale ref** — the ref no longer exists in metadata, or it points to a
 *      different citation than the one the model's other attrs claim. This
 *      happens when a prior `edit_note` call in the same turn removed or
 *      re-ordered citations and the simplifier renumbered occurrences. Rewrite
 *      the ref to the current one when (item_id, page) is unique.
 *
 * Per-tag handling:
 *   - Compound citations (`items="..."`, no `item_id`) → skipped; they are
 *     immutable and expansion returns `stored.rawHtml` verbatim.
 *   - `att_id` forms → resolved to parent `item_id` + page label (mirroring
 *     `buildCitationFromAttId` at insert time) and rewritten to the parent-item
 *     form the simplifier produces. This drops `att_id` in favor of `item_id`.
 *   - `item_id` forms → the ref is rewritten in place; all other attributes
 *     (including `label`) are preserved verbatim.
 *
 * Conservative under ambiguity: when (item_id, page) matches >1 or zero entries
 * in metadata, the tag is left alone. The downstream matcher and its
 * multi-match disambiguation + `target_before_context` path still run.
 *
 * Returns the rewritten `oldString`, or `null` if no citations were changed
 * (caller should continue with the original `old_string`).
 */
export function normalizeOldStringCitations(
    oldString: string,
    metadata: SimplificationMetadata,
): string | null {
    return normalizeCitationRefs(oldString, metadata, {
        enrichBareCitations: true,
        repairMismatchedRefs: true,
    });
}

/**
 * Repair stale `ref` attributes on citations in `new_string` so
 * `expandToRawHtml('new', ...)` finds the stored citation and returns its
 * raw HTML verbatim, instead of falling through to the "unknown ref → build
 * new citation" path (which re-translates numeric pages and can silently
 * change the stored locator).
 *
 * Unlike `normalizeOldStringCitations`, this function:
 *
 *   - **Never injects a ref into a bare citation.** A bare
 *     `<citation item_id="..." page="..."/>` in `new_string` is the model's
 *     canonical form for requesting a NEW citation; enriching it would
 *     silently deduplicate against an existing ref.
 *   - **Never rewrites a ref whose stored citation is for the same item but
 *     a different page.** `<citation item_id=X page=NEW ref=EXISTING/>` is the
 *     supported way to edit a citation's locator (expandToRawHtml rebuilds the
 *     citation with the new attrs); repairing would silently redirect the edit
 *     to a sibling citation that happens to already be at page NEW.
 *
 * Only genuinely-fabricated refs (not present in metadata, or pointing at a
 * compound / different item entry) are repaired via content lookup.
 *
 * Returns the rewritten `newString`, or `null` if no citations were changed.
 */
export function normalizeNewStringCitations(
    newString: string,
    metadata: SimplificationMetadata,
): string | null {
    return normalizeCitationRefs(newString, metadata, {
        enrichBareCitations: false,
        repairMismatchedRefs: false,
    });
}

/**
 * @deprecated Use `normalizeOldStringCitations`. This alias is kept so existing
 * tests and call sites continue to compile; it delegates unchanged.
 */
export function enrichOldStringCitationRefs(
    oldString: string,
    metadata: SimplificationMetadata,
): string | null {
    return normalizeOldStringCitations(oldString, metadata);
}

/**
 * Apply old_string citation normalization, returning the (possibly unchanged)
 * string. Centralizes the null-vs-string dance so validator + executor share
 * one entry point.
 */
export function applyOldStringEnrichment(
    oldString: string | undefined,
    metadata: SimplificationMetadata,
): string | undefined {
    if (!oldString) return oldString;
    const normalized = normalizeOldStringCitations(oldString, metadata);
    return normalized ?? oldString;
}

/**
 * Apply new_string citation normalization (stale-ref repair only), returning
 * the (possibly unchanged) string. Companion to `applyOldStringEnrichment`.
 */
export function applyNewStringNormalization(
    newString: string | undefined,
    metadata: SimplificationMetadata,
): string | undefined {
    if (!newString) return newString;
    const normalized = normalizeNewStringCitations(newString, metadata);
    return normalized ?? newString;
}
