/**
 * Zero-match hint finders used by `editNotePositionLookup`.
 *
 *   - `findFuzzyMatch`          word-overlap fuzzy match for a search snippet
 *   - `findStructuralAnchorHint` locate a unique block-level tag anchor
 *   - `findInlineTagDriftMatch`  detect dropped inline formatting tags
 *
 * These live in a separate module from the orchestrator so tests can stub any
 * one of them through `vi.mock` without intercepting the whole position-lookup
 * module.
 */

import { normalizeWS } from './noteHtmlEntities';

// =============================================================================
// Fuzzy Matching
// =============================================================================

/**
 * Find a fuzzy match for a search string in the simplified HTML.
 * Used to provide hints when exact matching fails.
 */
export function findFuzzyMatch(simplified: string, searchStr: string): string | null {
    // 1. Try whitespace-relaxed exact match
    const normSearch = normalizeWS(searchStr);
    const normHtml = normalizeWS(simplified);

    const idx = normHtml.indexOf(normSearch);
    if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(normHtml.length, idx + normSearch.length + 50);
        return normHtml.substring(start, end);
    }

    // 2. Fall back to best-matching line by word overlap
    const searchWords = new Set(
        normSearch.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    );
    if (searchWords.size === 0) return null;

    const lines = simplified.split('\n');
    let bestLine = '';
    let bestScore = 0;

    for (const line of lines) {
        const text = normalizeWS(line.replace(/<[^>]+>/g, '')).toLowerCase();
        if (!text) continue;
        const lineWords = text.split(/\s+/);
        const matches = lineWords.filter(w => searchWords.has(w)).length;
        const score = matches / searchWords.size;
        if (score > bestScore) {
            bestScore = score;
            bestLine = line.trim();
        }
    }

    // Require at least 30% word overlap
    return bestScore >= 0.3 ? bestLine : null;
}

// =============================================================================
// Structural Anchor Hint
// =============================================================================

/**
 * Distinctive block-level tags that can serve as structural anchors when
 * old_string is mostly HTML structure with little or no word content
 * (e.g. `</h2>\n<table>`). These tags are typically unique or rare in a
 * note, so finding their real location gives the model a usable anchor.
 */
const STRUCTURAL_ANCHOR_TAG_NAMES = [
    'table', 'thead', 'tbody', 'tfoot',
    'ul', 'ol', 'dl',
    'blockquote', 'pre', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
] as const;

const STRUCTURAL_ANCHOR_TAG_IN_OLD_RE = new RegExp(
    `</?(${STRUCTURAL_ANCHOR_TAG_NAMES.join('|')})\\b[^>]*>`,
    'gi',
);

export interface StructuralAnchorHint {
    /** The tag name (lowercased, without angle brackets) used as the anchor. */
    tagName: string;
    /** Context snippet showing where that tag actually appears in the note. */
    context: string;
}

/**
 * When fuzzy text matching fails because old_string is mostly structural HTML
 * (no meaningful words for `findFuzzyMatch` to latch onto), look for
 * block-level tag openers referenced in old_string and check whether any of
 * them appears exactly once in the simplified note. If so, return a context
 * snippet around the real location — this gives the model a concrete anchor
 * to rewrite its old_string against, instead of a generic "not found" error.
 *
 * Returns null when:
 *  - old_string is empty
 *  - old_string references no recognized structural tags
 *  - none of the referenced tags appears exactly once in the simplified note
 */
export function findStructuralAnchorHint(
    simplified: string,
    oldString: string,
): StructuralAnchorHint | null {
    if (!oldString) return null;

    // Collect unique tag names referenced in old_string (opening or closing).
    // Preserves insertion order so we prefer the first-mentioned tag.
    const tagsInOld: string[] = [];
    const seen = new Set<string>();
    for (const m of oldString.matchAll(STRUCTURAL_ANCHOR_TAG_IN_OLD_RE)) {
        const name = m[1].toLowerCase();
        if (!seen.has(name)) {
            seen.add(name);
            tagsInOld.push(name);
        }
    }
    if (tagsInOld.length === 0) return null;

    // For each candidate tag, find where its opening tag occurs in `simplified`.
    // If it occurs exactly once, return that context.
    for (const tagName of tagsInOld) {
        const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
        const matches = [...simplified.matchAll(openRe)];
        if (matches.length !== 1) continue;

        const match = matches[0];
        const idx = match.index ?? -1;
        if (idx < 0) continue;
        const matchLen = match[0].length;

        // Simple character-based window around the match
        const CONTEXT_CHARS = 250;
        const start = Math.max(0, idx - CONTEXT_CHARS);
        const end = Math.min(simplified.length, idx + matchLen + CONTEXT_CHARS);

        let context = simplified.substring(start, end);
        if (start > 0) context = '…' + context;
        if (end < simplified.length) context = context + '…';

        return { tagName, context };
    }

    return null;
}

// =============================================================================
// Inline Tag Drift Detection
// =============================================================================

/**
 * Inline formatting tags that the model commonly drops from old_string when
 * copying text from a note. Most are character-level wrappers whose removal
 * changes the HTML but not the visible text. <br> is a void line-break
 * element that the model commonly drops in the same way.
 */
const INLINE_FORMAT_TAG_NAMES = [
    'strong', 'b', 'em', 'i', 'u', 's', 'code', 'sup', 'sub', 'mark', 'br', 'span',
] as const;

const INLINE_FORMAT_TAG_PATTERN =
    `</?(?:${INLINE_FORMAT_TAG_NAMES.join('|')})\\b[^>]*>`;
const INLINE_FORMAT_TAG_RE_GLOBAL = new RegExp(INLINE_FORMAT_TAG_PATTERN, 'gi');
const INLINE_FORMAT_TAG_RE_ANCHORED = new RegExp(`^${INLINE_FORMAT_TAG_PATTERN}`, 'i');

/** Strip inline formatting tags (strong/em/b/i/u/s/code/sup/sub/mark/br/span). */
function stripInlineFormatTags(s: string): string {
    return s.replace(INLINE_FORMAT_TAG_RE_GLOBAL, '');
}

export interface InlineTagDriftMatch {
    /** The matching span from the note in its original (with-tags) form. */
    noteSpan: string;
    /** Tags present in noteSpan but missing from old_string (multiset diff). */
    droppedTags: string[];
}

/**
 * Detect "inline tag drift": when old_string text matches a unique span in
 * the simplified note after both have inline formatting tags stripped, but
 * old_string is missing some of the inline tags that the note has.
 *
 * Returns null when:
 *  - old_string is empty
 *  - the stripped form has no match or multiple matches in the note
 *  - the matched span is identical to old_string (no actual drift)
 *  - no tags were dropped (e.g. old_string has more tags than the note)
 *
 */
export function findInlineTagDriftMatch(
    simplified: string,
    oldString: string,
): InlineTagDriftMatch | null {
    if (!oldString || !oldString.trim()) return null;

    const strippedOld = stripInlineFormatTags(oldString);
    if (!strippedOld.trim()) return null;

    const strippedSimplified = stripInlineFormatTags(simplified);

    const firstIdx = strippedSimplified.indexOf(strippedOld);
    if (firstIdx === -1) return null;
    if (strippedSimplified.indexOf(strippedOld, firstIdx + 1) !== -1) {
        // Ambiguous — refuse to guess which span the model meant.
        return null;
    }

    // Walk simplified, tracking the stripped offset, to map firstIdx and
    // firstIdx + strippedOld.length back to original positions.
    const targetStart = firstIdx;
    const targetEnd = firstIdx + strippedOld.length;
    let strippedPos = 0;
    let origStart = -1;
    let origEnd = -1;
    let i = 0;

    while (i <= simplified.length) {
        if (origStart === -1 && strippedPos === targetStart) {
            origStart = i;
        }
        if (strippedPos === targetEnd) {
            origEnd = i;
            break;
        }
        if (i >= simplified.length) break;

        const tail = simplified.substring(i);
        const tagMatch = tail.match(INLINE_FORMAT_TAG_RE_ANCHORED);
        if (tagMatch) {
            i += tagMatch[0].length;
        } else {
            strippedPos++;
            i++;
        }
    }

    if (origStart === -1 || origEnd === -1) return null;

    // Extend leftward through opening inline tags directly preceding origStart.
    // The text "<strong>foo</strong>" stripped to "foo" — when origStart lands
    // on "f", we want the span to include the leading "<strong>".
    const openTagRe = new RegExp(
        `<(?:${INLINE_FORMAT_TAG_NAMES.join('|')})\\b[^>]*>$`, 'i',
    );
    while (origStart > 0) {
        const m = simplified.substring(0, origStart).match(openTagRe);
        if (!m) break;
        origStart -= m[0].length;
    }
    // Extend rightward through closing inline tags directly following origEnd.
    const closeTagRe = new RegExp(
        `^</(?:${INLINE_FORMAT_TAG_NAMES.join('|')})\\s*>`, 'i',
    );
    while (origEnd < simplified.length) {
        const m = simplified.substring(origEnd).match(closeTagRe);
        if (!m) break;
        origEnd += m[0].length;
    }

    const noteSpan = simplified.substring(origStart, origEnd);

    // No drift if the span is byte-identical to old_string.
    if (noteSpan === oldString) return null;

    // Compute the multiset of tags present in noteSpan but missing from
    // old_string. We compare full tag tokens (including attributes) so an
    // attribute mismatch is treated as a drop, not a match.
    const noteTags = noteSpan.match(INLINE_FORMAT_TAG_RE_GLOBAL) ?? [];
    const oldTags = oldString.match(INLINE_FORMAT_TAG_RE_GLOBAL) ?? [];
    const oldCounts = new Map<string, number>();
    for (const t of oldTags) {
        oldCounts.set(t, (oldCounts.get(t) ?? 0) + 1);
    }
    const droppedTags: string[] = [];
    for (const t of noteTags) {
        const c = oldCounts.get(t) ?? 0;
        if (c > 0) {
            oldCounts.set(t, c - 1);
        } else {
            droppedTags.push(t);
        }
    }

    if (droppedTags.length === 0) return null;

    return { noteSpan, droppedTags };
}
