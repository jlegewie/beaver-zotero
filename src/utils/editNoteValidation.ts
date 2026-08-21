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
 *   - `buildCitationRefHint` / `buildExpansionErrorMessage`
 *                                  attach the note's real `<citation .../>`
 *                                  tags to an unresolvable-ref error
 */

import type { SimplificationMetadata } from './noteHtmlSimplifier';
import {
    extractAttr,
    isCitationRefNotFoundError,
    normalizePageLocator,
    translatePageNumberToLabel,
} from './noteCitationExpand';
import {
    getPageLocator,
    normalizeCitationTag,
    parseRawCitationAttributes,
} from '@beaver/agent-core/citations/citationGrammar';
import type { PageLabelsByAttachmentId } from '@beaver/agent-core/citations/atoms';
import { modelObjectId, modelObjectIdFromReference, resolveObjectId, UNRESOLVED_LIBRARY_ID } from './libraryIdentity';
import { checkLibraryExcluded } from '../services/agentDataProvider/utils';
import { logger } from '@beaver/agent-core/platform/logger';

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

        const id = modelObjectIdFromReference(normalized.ref);
        const label = extractAttr(attrStr, 'id') ? 'id' : extractAttr(attrStr, 'item_id') ? 'item_id' : 'att_id';
        if (normalized.ref.library_id === UNRESOLVED_LIBRARY_ID) {
            return `Citation ${label}="${id}" references an item in a library that is not available on this computer.`;
        }
        // Reject before the existence lookup: an excluded library's items must
        // not be cited, and the response must not reveal whether the item exists.
        const excluded = checkLibraryExcluded(normalized.ref.library_id);
        if (excluded) {
            return `Citation ${label}="${id}": ${excluded.message}`;
        }
        const item = Zotero.Items.getByLibraryAndKey(normalized.ref.library_id, normalized.ref.zotero_key);
        if (!item) {
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
        const newItemId = modelObjectIdFromReference(normalized.ref);
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
    const ref = resolveObjectId(attId);
    if (!ref || ref.library_id === UNRESOLVED_LIBRARY_ID) return null;
    const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
    if (!item || typeof item === 'boolean') return null;
    if (!item.isAttachment?.()) return null;
    const parentKey = (item as any).parentKey;
    if (!parentKey) return null;
    return {
        parentItemId: modelObjectId(item.libraryID, parentKey),
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
    const ref = resolveObjectId(id);
    if (!ref || ref.library_id === UNRESOLVED_LIBRARY_ID) return { itemId: id };
    const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
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
        const rawItemId = explicitItemId || resolvedUnifiedId.itemId;
        // Normalize to the portable id `simplifyNoteHtml` stores in
        // `originalAttrs.item_id` so a legacy numeric id written by the model
        // still matches — `normalized.ref` covers `item_id`/`id` identity
        // attributes (see `firstZoteroIdentity`'s priority order).
        const itemId = rawItemId && normalized.ok && normalized.ref.kind === 'zotero'
            ? modelObjectIdFromReference(normalized.ref)
            : rawItemId;
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

// =============================================================================
// Citation-ref recovery hint
// =============================================================================

/** How many citation tags the recovery hint lists at most. */
const MAX_CITATION_REF_HINT_TAGS = 5;

/** Simplified citation tags are self-closing and `escapeAttr` escapes `>`
 *  inside attribute values, so `[^>]` cannot run past the tag. */
const SIMPLIFIED_CITATION_TAG_RE = /<citation\s[^>]*\/>/g;

interface NoteCitationTag {
    tag: string;
    /** Offset of the tag in the simplified note. */
    index: number;
}

/** Every `<citation .../>` tag in the simplified note, in document order. */
function collectCitationTags(simplified: string): NoteCitationTag[] {
    const tags: NoteCitationTag[] = [];
    SIMPLIFIED_CITATION_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SIMPLIFIED_CITATION_TAG_RE.exec(simplified)) !== null) {
        tags.push({ tag: m[0], index: m.index });
    }
    return tags;
}

interface ContentWord {
    word: string;
    /** Offset of the word in the text it was tokenized from. */
    index: number;
}

/**
 * Content words of `text`, in order, each with its offset.
 *
 * Markup is masked with an equal-length run of spaces rather than deleted, so
 * tag names and attribute values stay out of the token stream while every
 * returned offset remains valid in `text`'s own coordinates.
 */
function contentWordPositions(text: string): ContentWord[] {
    const masked = text.replace(/<[^>]+>/g, (tag) => ' '.repeat(tag.length));
    const words: ContentWord[] = [];
    const wordRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(masked)) !== null) {
        if (m[0].length > 2) words.push({ word: m[0].toLowerCase(), index: m.index });
    }
    return words;
}

/** Content words used to score a citation's surroundings against old_string. */
function contentWords(text: string): Set<string> {
    return new Set(contentWordPositions(text).map((w) => w.word));
}

/**
 * Bounds on the half-width, in characters, of the window that locates the
 * densest cluster of matched words inside a line. The window tracks
 * `old_string`'s own length, since that approximates the span being targeted;
 * the bounds stop a one-word `old_string` from collapsing it to a point and a
 * paragraph-sized one from widening it to the whole line.
 */
const ANCHOR_WINDOW_MIN_HALF_WIDTH = 40;
const ANCHOR_WINDOW_MAX_HALF_WIDTH = 400;

/**
 * Offset of the densest cluster of `matches` within its line.
 */
function findClusterOffset(matches: ContentWord[], halfWidth: number): number {
    const counts = new Map<string, number>();
    for (const { word } of matches) counts.set(word, (counts.get(word) ?? 0) + 1);

    // prefix[i] = summed weight of matches[0..i-1], so a window's weight is one
    // subtraction.
    const prefix = [0];
    for (const { word } of matches) {
        prefix.push(prefix[prefix.length - 1] + 1 / counts.get(word)!);
    }

    let bestOffset = matches[0].index;
    let bestWeight = 0;
    // Both window edges only ever advance, since `matches` is sorted.
    let lo = 0;
    let hi = 0;
    for (const match of matches) {
        while (matches[lo].index < match.index - halfWidth) lo++;
        while (hi < matches.length && matches[hi].index <= match.index + halfWidth) hi++;
        const weight = prefix[hi] - prefix[lo];
        // Strictly greater keeps the EARLIEST of equally dense clusters.
        if (weight > bestWeight) {
            bestWeight = weight;
            bestOffset = match.index;
        }
    }
    return bestOffset;
}

/**
 * Offset in `simplified` that best overlaps `oldString`'s content words, or
 * `null` when nothing scores.
 *
 * `old_string` did not resolve, so there is no matched position to measure
 * from; the best-scoring region is the available stand-in for where the model
 * was aiming. Scoring one anchor and measuring distance from it beats scoring
 * each citation's own neighbourhood, which saturates on short notes — every
 * window then covers every word, all scores tie, and the tie-break rather than
 * the evidence decides.
 */
function findAnchorIndex(simplified: string, oldString: string): number | null {
    const searchWords = contentWords(oldString);
    if (searchWords.size === 0) return null;

    const halfWidth = Math.min(
        Math.max(oldString.length, ANCHOR_WINDOW_MIN_HALF_WIDTH),
        ANCHOR_WINDOW_MAX_HALF_WIDTH,
    );

    let bestIndex: number | null = null;
    let bestScore = 0;
    let lineStart = 0;
    for (const line of simplified.split('\n')) {
        const matches = contentWordPositions(line).filter((w) => searchWords.has(w.word));
        // Score the line on distinct words so one word repeated down it cannot
        // outscore a line matching many different ones.
        const distinct = new Set(matches.map((m) => m.word));
        // Strictly greater keeps the FIRST best line on a tie.
        if (distinct.size > bestScore) {
            bestScore = distinct.size;
            bestIndex = lineStart + findClusterOffset(matches, halfWidth);
        }
        lineStart += line.length + 1; // +1 for the split '\n'
    }
    return bestIndex;
}

/**
 * Pick the `max` citations nearest to where `oldString` seems to target,
 * returned in document order.
 *
 * With no anchor (old_string is pure markup, or shares no words with the note)
 * the head of the note wins, which is no worse than an arbitrary pick.
 */
function selectNearestCitations(
    simplified: string,
    tags: NoteCitationTag[],
    oldString: string,
    max: number,
): NoteCitationTag[] {
    if (tags.length <= max) return tags;

    const anchor = findAnchorIndex(simplified, oldString);
    if (anchor === null) return tags.slice(0, max);

    return tags
        .map((t, order) => ({ t, order, distance: Math.abs(t.index - anchor) }))
        .sort((a, b) => a.distance - b.distance || a.order - b.order)
        .slice(0, max)
        .sort((a, b) => a.order - b.order)
        .map((s) => s.t);
}

/**
 * Build the block appended to an old_string citation-ref error: the note's
 * actual `<citation .../>` tags, ready to paste.
 *
 * The bare error tells the model to copy a tag verbatim from `read_note` but
 * hands it nothing to copy, so recovery costs a round trip — and a model that
 * guesses instead tends to walk the ref grammar (`c_KEY_1`, `_2`, …) and fail
 * repeatedly. Listing the real tags makes recovery copy-paste.
 *
 * Returns `null` when the note has no citations at all; the unmodified error
 * already says what to do in that case.
 */
export function buildCitationRefHint(
    simplified: string,
    oldString: string,
    max: number = MAX_CITATION_REF_HINT_TAGS,
): string | null {
    const tags = collectCitationTags(simplified);
    if (tags.length === 0) return null;

    const picked = selectNearestCitations(simplified, tags, oldString, max);
    const header = picked.length < tags.length
        ? `The ${picked.length} citation tags in the note closest to your old_string `
            + `(of ${tags.length} total):`
        : tags.length === 1
            ? 'The note\'s only citation tag:'
            : `All ${tags.length} citation tags in the note:`;

    return (
        `${header}\n\`\`\`\n${picked.map((t) => t.tag).join('\n')}\n\`\`\`\n`
        + 'Copy one of these verbatim (including its `ref`). `ref` values are '
        + 'positional: they shift whenever citations are added or removed, so '
        + 're-read the note after an applied edit before reusing them.'
    );
}

/**
 * Error message for a failed old_string/new_string expansion, with the note's
 * real citation tags appended when the failure was an unresolvable old_string
 * citation ref. Any other expansion failure passes through unchanged.
 *
 * The `old_string` mention in the base message is load-bearing — the backend
 * branches on it to decide whether a retry should be preceded by `read_note` —
 * so keep it in the message text, not only in the appended block.
 *
 * Enriching an error must never be able to make it worse: this runs on a path
 * whose caller has already decided to report `expansion_failed`, so a throw in
 * here would escape into the handler's outer catch and downgrade a precise,
 * actionable error into an opaque one. Any failure falls back to the plain
 * message.
 */
export function buildExpansionErrorMessage(
    error: unknown,
    simplified: string,
    oldString: string | undefined,
): string {
    const message = (error as { message?: string } | null)?.message || String(error);
    try {
        if (!isCitationRefNotFoundError(error)) return message;
        const hint = buildCitationRefHint(simplified, oldString ?? '');
        return hint ? `${message}\n\n${hint}` : message;
    } catch (e) {
        logger(`buildExpansionErrorMessage: failed to build the citation-ref hint: ${e}`, 1);
        return message;
    }
}
