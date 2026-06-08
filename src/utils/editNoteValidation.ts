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
import {
    getPageLocator,
    normalizeCitationTag,
    parseRawCitationAttributes,
} from '../../react/utils/citationGrammar';
import type { PageLabelsByAttachmentId } from '../../react/atoms/citations';

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
        return 'Error: Cannot create new compound citations. Insert individual <citation id="..." /> tags instead.';
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
        const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
        if (!normalized.ok || normalized.ref.kind !== 'zotero') continue; // will fail later in expansion with a proper error

        const id = `${normalized.ref.library_id}-${normalized.ref.zotero_key}`;
        const item = Zotero.Items.getByLibraryAndKey(normalized.ref.library_id, normalized.ref.zotero_key);
        if (!item) {
            const label = extractAttr(attrStr, 'id') ? 'id' : extractAttr(attrStr, 'item_id') ? 'item_id' : 'att_id';
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
    const newCitationRegex = /<citation\s+(?![^/]*\bref=)([^>]*?)\/>/g;
    let match;
    const warnings: string[] = [];

    while ((match = newCitationRegex.exec(newString)) !== null) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1]));
        if (!normalized.ok || normalized.ref.kind !== 'zotero') continue;
        const newItemId = `${normalized.ref.library_id}-${normalized.ref.zotero_key}`;
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
    pageLabels?: PageLabelsByAttachmentId,
): string | undefined {
    if (!page) return undefined;
    const normalized = normalizePageLocator(page);
    try {
        if (attachmentItem?.id != null) {
            return translatePageNumberToLabel(pageLabels?.[attachmentItem.id] ?? null, normalized);
        }
    } catch {
        /* best-effort */
    }
    return normalized;
}

function resolveUnifiedIdForOldString(id: string): { itemId?: string; attId?: string } {
    const dashIdx = id.indexOf('-');
    if (dashIdx <= 0) return { itemId: id };
    const libId = parseInt(id.substring(0, dashIdx), 10);
    const key = id.substring(dashIdx + 1);
    if (!libId || !key) return { itemId: id };
    const item = Zotero.Items.getByLibraryAndKey(libId, key);
    if (item && typeof item !== 'boolean' && item.isAttachment?.()) {
        return { attId: id };
    }
    return { itemId: id };
}

function addParentCitationRefReplacement(
    replacements: { start: number; end: number; replacement: string }[],
    metadata: SimplificationMetadata,
    match: RegExpExecArray,
    attrStr: string,
    attId: string,
    page: string | undefined,
    pageLabels?: PageLabelsByAttachmentId,
): boolean {
    const resolved = resolveAttIdToParent(attId);
    if (!resolved) return false;
    const { parentItemId, attachmentItem } = resolved;

    // Attachment citations are stored as parent-item citations after expansion,
    // so compare both translated and raw page locators before giving up.
    const translatedPage = translateAttIdPageLocator(attachmentItem, page, pageLabels);
    let matchedPage = translatedPage;
    let candidateRef = findUniqueCitationRef(metadata, parentItemId, translatedPage);
    if (candidateRef === null && translatedPage !== page) {
        candidateRef = findUniqueCitationRef(metadata, parentItemId, page);
        if (candidateRef !== null) matchedPage = page;
    }
    if (candidateRef === null) return false;

    const finalPageAttr = matchedPage !== undefined
        ? ` page="${matchedPage}"`
        : '';
    replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: `<citation item_id="${parentItemId}"${finalPageAttr} ref="${candidateRef}"/>`,
    });
    return true;
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
    pageLabels?: PageLabelsByAttachmentId,
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

        const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
        if (normalized.ok && normalized.ref.loc && !getPageLocator(normalized.ref)) continue;
        const page = normalized.ok
            ? getPageLocator(normalized.ref)
            : extractAttr(attrStr, 'page') || undefined;

        const explicitItemId = extractAttr(attrStr, 'item_id');
        const unifiedId = extractAttr(attrStr, 'id');
        const resolvedUnifiedId = unifiedId ? resolveUnifiedIdForOldString(unifiedId) : {};
        const itemId = explicitItemId || resolvedUnifiedId.itemId;
        const unifiedAttId = resolvedUnifiedId.attId;
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

        const attId = extractAttr(attrStr, 'att_id') || extractAttr(attrStr, 'attachment_id') || unifiedAttId;
        if (attId) {
            addParentCitationRefReplacement(replacements, metadata, m, attrStr, attId, page, pageLabels);
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
    pageLabels?: PageLabelsByAttachmentId,
): string | undefined {
    if (!oldString) return oldString;
    const enriched = enrichOldStringCitationRefs(oldString, metadata, pageLabels);
    return enriched ?? oldString;
}

// =============================================================================
// Partial Simplified-Tag Detection
// =============================================================================

export interface PartialSimplifiedTag {
    kind: 'citation' | 'annotation' | 'link';
    snippet: string;
}

/**
 * Detect a partial `<citation …>` or `<annotation …>` opener in `oldString`.
 * The matcher's raw-HTML expansion in `expandToRawHtml` only rewrites complete
 * simplified tags: citations must be self-closing (`/>`), while annotations
 * must have a closing `</annotation>` pair. Malformed openers pass through
 * unchanged into the haystack search and produce a generic
 * `old_string_not_found` error. This detector lets the validator/executor
 * surface a targeted message instead.
 *
 * Detection is intentionally narrow: only unclosed `<citation` /
 * `<annotation` openers count. Generic unmatched-attribute heuristics on
 * prose (e.g. `label="..."` without a tag context) are excluded because
 * they misclassify normal text. Returns the first partial encountered, or
 * `null` when every opener closes cleanly.
 */
export function detectPartialSimplifiedTag(
    oldString: string,
): PartialSimplifiedTag | null {
    if (!oldString) return null;
    const openerRe = /<(citation|annotation|link)(?=\s|>|\/|$)/g;
    let m: RegExpExecArray | null;
    while ((m = openerRe.exec(oldString)) !== null) {
        const kind = m[1] as 'citation' | 'annotation' | 'link';
        const start = m.index;
        let cursor = start + m[0].length;
        let closed = false;
        while (cursor < oldString.length) {
            const c = oldString[cursor];
            // A new `<` or a newline before any close means the opener was
            // never terminated — the model truncated the tag.
            if (c === '<' || c === '\n') break;
            if (c === '/' && oldString[cursor + 1] === '>') {
                closed = kind === 'citation' || kind === 'link';
                cursor += 2;
                break;
            }
            if (c === '>') {
                cursor += 1;
                if (kind === 'annotation') {
                    const closeIdx = oldString.indexOf('</annotation>', cursor);
                    if (closeIdx !== -1) {
                        closed = true;
                    }
                }
                break;
            }
            cursor++;
        }
        if (!closed) {
            return {
                kind,
                snippet: oldString.slice(start, Math.min(cursor, start + 60)),
            };
        }
    }
    return null;
}

/**
 * Build the error message for a partial `<citation …>` / `<annotation …>` opener
 * in `old_string`. Surfaces the actionable rewrite hint (use the FULL tag from
 * `read_note`) so the model can self-correct on the next turn instead of
 * reading the generic zero-match hint.
 */
export function buildPartialSimplifiedTagMessage(partial: PartialSimplifiedTag): string {
    if (partial.kind === 'link') {
        return (
            '`<link/>` tags are atomic — the matcher cannot match a partial tag. '
            + `Found a partial opener in old_string: \`${partial.snippet}\`.\n`
            + 'A `<link/>` tag is a hyperlink. Copy the FULL `<link href="..."/>` '
            + 'tag from `read_note` verbatim as old_string, not a prefix of it.'
        );
    }
    return (
        `${partial.kind === 'citation' ? 'Citation' : 'Annotation'} tags are atomic — `
        + `the matcher cannot match a partial tag. Found a partial opener in old_string: `
        + `\`${partial.snippet}\`.\n`
        + 'To rename across all citations, use `str_replace_all` on the FULL '
        + '`<citation .../>` tag from `read_note` (including `ref`), not on a prefix.\n'
        + 'To replace a citation, copy the full tag (including `ref`) as old_string '
        + 'and write a new `<citation id="..." loc="page..."/>` (without `ref`) as '
        + 'new_string. The `ref` attribute is read-only.'
    );
}
