/**
 * Zero-match hint finders used by `editNotePositionLookup`.
 *
 *   - `findCandidateSnippets`    ranked candidate snippets for the agent
 *   - `findStructuralAnchorHint` locate a unique block-level tag anchor
 *   - `findInlineTagDriftMatch`  detect dropped inline formatting tags
 *
 * These live in a separate module from the orchestrator so tests can stub any
 * one of them through `vi.mock` without intercepting the whole position-lookup
 * module.
 */

import {
    normalizeCjkSpacing,
    normalizeCjkSpacingMapped,
    normalizeWS,
    normalizeWSMapped,
    trimWSOrNbsp,
} from './noteHtmlEntities';

// =============================================================================
// Candidate snippets
// =============================================================================

/**
 * How a candidate was located. Callers surface this to the model so it can
 * judge confidence.
 *
 *   - `whitespace_relaxed` — old_string matches after collapsing whitespace;
 *     very high confidence, typically a lone candidate.
 *   - `word_overlap`       — top-N lines by word-overlap ratio; lower
 *     confidence, the model should pick or rewrite.
 *   - `inline_tag_drift`   — attached by `buildZeroMatchHint` from
 *     `findInlineTagDriftMatch`.
 *   - `structural_anchor`  — attached by `buildZeroMatchHint` from
 *     `findStructuralAnchorHint`.
 *   - `fuzzy_window`       — region located by multi-line window scoring when
 *     no single line matched; region-level confidence only, the model should
 *     read_note around it rather than paste blindly.
 */
export type CandidateSource =
    | 'whitespace_relaxed'
    | 'word_overlap'
    | 'inline_tag_drift'
    | 'structural_anchor'
    | 'fuzzy_window';

export interface CandidateSnippet {
    /** Snippet to show the model. Already truncated — do not re-truncate. */
    snippet: string;
    /** True when the snippet is NOT a verbatim slice of the note. It was
     *  shortened with `…` elision markers, or otherwise reshaped. */
    truncated: boolean;
    /** How this candidate was located. */
    via: CandidateSource;
    /** 0-1 confidence. 1 for deterministic locators (whitespace_relaxed,
     *  inline_tag_drift, structural_anchor); word-overlap ratio for
     *  `word_overlap`. */
    score: number;
}

export interface FindCandidateSnippetsOptions {
    maxCandidates?: number;
    maxSnippetLength?: number;
    /** Minimum word-overlap ratio required for `word_overlap` candidates.
     *  Raised from the legacy 0.3 threshold to suppress low-confidence noise. */
    minScore?: number;
}

const DEFAULT_MAX_CANDIDATES = 3;
/** Snippet budget for hints that only point at a region of the note */
export const DEFAULT_MAX_SNIPPET_LENGTH = 200;
/** Ceiling for candidates the agent is told to paste back as `old_string` */
export const MAX_PASTEABLE_SNIPPET_LENGTH = 600;
const DEFAULT_MIN_SCORE = 0.5;

/** Snippet budget for a candidate the agent should paste verbatim: fit the
 *  whole span when it is a reasonable size, fall back to a bounded window only
 *  when it is not. */
export function pasteableSnippetBudget(spanLength: number): number {
    return Math.min(
        MAX_PASTEABLE_SNIPPET_LENGTH,
        Math.max(DEFAULT_MAX_SNIPPET_LENGTH, spanLength + 100),
    );
}

/** Truncate `text` around `pivot` with `…` markers when trimmed. Keeps roughly
 *  `before` chars before the pivot and `after` chars after. */
export function centerTruncate(
    text: string,
    pivot: number,
    maxLen: number,
): { snippet: string; truncated: boolean } {
    if (text.length <= maxLen) {
        return { snippet: text, truncated: false };
    }
    const before = Math.floor(maxLen * 0.4);
    const after = maxLen - before;
    const pivotClamped = Math.max(0, Math.min(text.length, pivot));
    let start = Math.max(0, pivotClamped - before);
    let end = Math.min(text.length, start + maxLen);
    // If we hit the right edge, shift start back so the window stays full-size.
    if (end === text.length) {
        start = Math.max(0, end - maxLen);
    } else {
        end = Math.min(text.length, pivotClamped + after);
    }
    let snippet = text.substring(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return { snippet, truncated: true };
}

/**
 * Keep `truncated: false` honest: it promises the snippet is a verbatim slice
 * of the note and can be pasted straight back as `old_string`.
 */
export function markTruncatedUnlessVerbatim(
    result: { snippet: string; truncated: boolean },
    note: string,
): { snippet: string; truncated: boolean } {
    if (result.truncated) return result;
    return { snippet: result.snippet, truncated: !note.includes(result.snippet) };
}

/**
 * Build a `whitespace_relaxed` candidate from the exact note span a relaxed
 * match resolved to, or `null` when that span cannot be handed back as a
 * ready-to-paste `old_string`.
 *
 * A relaxed hit means the note *does* contain the agent's `old_string` modulo
 * whitespace, and `[origStart, origEnd)` is where. Returning that span beats
 * returning a window around it: the agent can paste it straight back instead
 * of guessing which part of the window to copy.
 *
 * `truncated: false` promises exactly that, so each check below falls back to
 * the windowed snippet — which keeps surrounding context, and is marked
 * truncated when it has to elide — rather than making a promise the retry
 * would break:
 *   - the span does not round-trip to the needle under the same normalizer —
 *     never expected, but an index-map bug should degrade rather than hand
 *     back the wrong text
 *   - the needle is not unique in normalized space. `indexOf` above resolved
 *     to an arbitrary occurrence, and a bare span carries no context to pin
 *     down which one, so a confident paste would silently edit whichever came
 *     first. This mirrors the whitespace-relaxed matcher's own uniqueness
 *     gate, which rejects the edit for the same reason — the hint must not
 *     hand back as certain what the matcher refused as ambiguous.
 *   - the span occurs more than once verbatim, which normalized uniqueness
 *     should already imply but is cheap to confirm: normalization at a span's
 *     edges depends on its neighbours.
 *
 * There is no length ceiling: the windowed fallback already grows to fit the
 * whole match, so the exact span is never the larger of the two.
 */
function buildExactSpanCandidate(
    simplified: string,
    origStart: number,
    origEnd: number,
    normalizedNeedle: string,
    normalizedNote: string,
    normalize: (s: string) => string,
): CandidateSnippet | null {
    if (origStart < 0 || origEnd <= origStart) return null;
    if (normalizedNote.indexOf(normalizedNeedle)
        !== normalizedNote.lastIndexOf(normalizedNeedle)) return null;
    // The span can carry edge whitespace the needle doesn't: index-map ends
    // sit at the start of a collapsed run, and a dropped CJK-boundary space
    // pushes the end past it entirely. Trim over the normalizers' whitespace
    // class — a literal `&nbsp;` left behind here would silently widen what
    // the agent's retry replaces. The result is still a contiguous slice of
    // the note, and a tighter paste target.
    const snippet = trimWSOrNbsp(simplified.substring(origStart, origEnd));
    if (!snippet) return null;
    if (normalize(snippet) !== normalizedNeedle) return null;
    if (simplified.indexOf(snippet) !== simplified.lastIndexOf(snippet)) return null;
    return { snippet, truncated: false, via: 'whitespace_relaxed', score: 1 };
}

/**
 * Ranked candidate snippets for an `old_string` that didn't match exactly.
 *
 * Two tiers:
 *   1. Whitespace-relaxed exact match — if `old_string` appears in the note
 *      after collapsing whitespace, return that single high-confidence
 *      candidate.
 *   2. Word-overlap lines — score every line by fraction of old_string words
 *      present; return the top `maxCandidates` above `minScore`.
 *
 * Returns `[]` when nothing passes the threshold. Callers should fall through
 * to a generic error in that case rather than inventing low-confidence hints.
 */
export function findCandidateSnippets(
    simplified: string,
    oldString: string,
    opts: FindCandidateSnippetsOptions = {},
): CandidateSnippet[] {
    const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const maxSnippetLength = opts.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH;
    const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

    const normSearch = normalizeWS(oldString);
    if (!normSearch) return [];

    // Tier 1: whitespace-relaxed exact match. The note contains `old_string`
    // modulo whitespace, and the normalizers' index maps say exactly where —
    // so return that span verbatim, which is what the agent needs to paste
    // back. Only when the span can't be promised as pasteable (see
    // `buildExactSpanCandidate`) do we fall back to a window around it, widened
    // so the full match stays visible even for long old_strings.
    //
    // Try the CJK-aware normalizer first so a needle that differs only by
    // Pangu spacing at CJK ↔ non-CJK prose boundaries still surfaces the
    // matching note span; fall back to the plain ws-normalizer, which stays
    // reachable when the two normalizers disagree on a boundary space (e.g.
    // one at the needle's edge, where the CJK rule has no left/right context).
    const cjkNormSearch = normalizeCjkSpacing(oldString);
    const cjkNormHtmlMapped = normalizeCjkSpacingMapped(simplified);
    const cjkIdx = cjkNormSearch ? cjkNormHtmlMapped.text.indexOf(cjkNormSearch) : -1;
    if (cjkIdx !== -1) {
        const matchEndNorm = cjkIdx + cjkNormSearch.length;
        const origStart = cjkNormHtmlMapped.indexMap[cjkIdx] ?? 0;
        const origEnd = cjkNormHtmlMapped.indexMap[matchEndNorm] ?? simplified.length;
        const exact = buildExactSpanCandidate(
            simplified, origStart, origEnd,
            cjkNormSearch, cjkNormHtmlMapped.text, normalizeCjkSpacing,
        );
        if (exact) return [exact];
        const pivot = Math.floor((origStart + origEnd) / 2);
        const window = Math.max(maxSnippetLength, (origEnd - origStart) + 100);
        const { snippet, truncated } = markTruncatedUnlessVerbatim(
            centerTruncate(simplified, pivot, window),
            simplified,
        );
        return [{ snippet, truncated, via: 'whitespace_relaxed', score: 1 }];
    }
    const normHtmlMapped = normalizeWSMapped(simplified);
    const normHtml = normHtmlMapped.text;
    const idx = normHtml.indexOf(normSearch);
    if (idx !== -1) {
        const matchEnd = idx + normSearch.length;
        const exact = buildExactSpanCandidate(
            simplified,
            normHtmlMapped.indexMap[idx] ?? -1,
            normHtmlMapped.indexMap[matchEnd] ?? -1,
            normSearch,
            normHtml,
            normalizeWS,
        );
        if (exact) return [exact];
        const pivot = Math.floor((idx + matchEnd) / 2);
        const window = Math.max(maxSnippetLength, normSearch.length + 100);
        // Cut from the normalized note, so the slice only matches the note
        // verbatim when its whitespace survived normalization untouched.
        const { snippet, truncated } = markTruncatedUnlessVerbatim(
            centerTruncate(normHtml, pivot, window),
            simplified,
        );
        return [{ snippet, truncated, via: 'whitespace_relaxed', score: 1 }];
    }

    // Tier 2: word-overlap line scoring. Score on text-only (so `<p>` doesn't
    // match the word "p") but return the tag-ful line so the agent can paste
    // an exact simplified-form substring as its next `old_string`.
    const searchWords = new Set(
        normSearch.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    );
    if (searchWords.size === 0) return [];

    const scored: Array<{
        score: number;
        line: string;
        firstMatchIdx: number;
    }> = [];

    for (const line of simplified.split('\n')) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        const textOnly = normalizeWS(trimmedLine.replace(/<[^>]+>/g, ''));
        if (!textOnly) continue;
        const loweredText = textOnly.toLowerCase();
        const lineWords = loweredText.split(/\s+/);
        const uniqueLineWords = new Set(lineWords);
        let matches = 0;
        let firstMatchedWord: string | null = null;
        for (const w of searchWords) {
            if (!uniqueLineWords.has(w)) continue;
            matches += 1;
            if (firstMatchedWord === null) firstMatchedWord = w;
        }
        const score = matches / searchWords.size;
        if (score < minScore) continue;

        // Locate the first matched word in the tag-ful line as the truncation
        // pivot. Falling back to 0 keeps centerTruncate well-defined.
        let pivot = 0;
        if (firstMatchedWord) {
            const p = trimmedLine.toLowerCase().indexOf(firstMatchedWord);
            if (p !== -1) pivot = p;
        }
        scored.push({ score, line: trimmedLine, firstMatchIdx: pivot });
    }

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const out: CandidateSnippet[] = [];
    for (const entry of scored) {
        if (out.length >= maxCandidates) break;
        // A word-overlap snippet is a literal note line, so a high-scoring one
        // can be pasted straight back — budget it accordingly. Clipping it
        // wouldn't make the model's choice of line any better, it would just
        // guarantee the paste fails. An explicit caller budget still wins.
        const budget = opts.maxSnippetLength ?? pasteableSnippetBudget(entry.line.length);
        const { snippet, truncated } = markTruncatedUnlessVerbatim(
            centerTruncate(entry.line, entry.firstMatchIdx, budget),
            simplified,
        );
        if (seen.has(snippet)) continue;
        seen.add(snippet);
        out.push({ snippet, truncated, via: 'word_overlap', score: entry.score });
    }

    return out;
}

/** Minimum window word-overlap for a `fuzzy_window` candidate to be emitted.
 *  Below this the region is too uncertain to point at — callers fall through
 *  to a generic "call read_note" hint rather than emit a misleading anchor. */
const WINDOW_MIN_SCORE = 0.35;

/** Grow a window no further than this multiple of the old_string length;
 *  beyond it the extra lines only dilute precision. */
const WINDOW_MAX_LENGTH_FACTOR = 1.5;

/**
 * Tier-3 fallback for `findCandidateSnippets`: when no single note line
 * carries enough of `old_string`'s words, score windows of consecutive lines.
 *
 * This catches cases the per-line scorer misses because the target text is
 * spread across many lines — e.g. `old_string` is a Markdown table row whose
 * cells the rendered note splits across many `<td>` lines, or a long
 * multi-block span. A sliding line window grown to roughly `old_string`'s
 * length localizes the region; the most word-dense individual lines from that
 * region are then returned as short, pasteable `old_string` candidates.
 *
 * Confidence is region-level only — `score` is the window overlap, and the
 * `fuzzy_window` source signals that the caller should steer the model toward
 * `read_note` rather than a blind paste.
 *
 * Returns `[]` when `old_string` has fewer than 3 content words or no window
 * clears `WINDOW_MIN_SCORE`.
 */
export function findWindowCandidates(
    simplified: string,
    oldString: string,
    opts: FindCandidateSnippetsOptions = {},
): CandidateSnippet[] {
    const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const maxSnippetLength = opts.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH;

    const normSearch = normalizeWS(oldString);
    if (!normSearch) return [];
    const searchWords = new Set(
        normSearch.toLowerCase().split(/\s+/).filter(w => w.length > 2),
    );
    // Need a few distinct content words to localize a region reliably; short
    // old_strings are already handled by the per-line scorer.
    if (searchWords.size < 3) return [];

    // Precompute, per line: the tag-ful trimmed line (for the returned
    // snippet), its lowercased text-only word list (for scoring), and its
    // length (for the window char budget).
    const lineInfo = simplified.split('\n').map((line) => {
        const trimmed = line.trim();
        const textOnly = normalizeWS(trimmed.replace(/<[^>]+>/g, '')).toLowerCase();
        return {
            trimmed,
            words: textOnly ? textOnly.split(/\s+/) : [],
            len: line.length + 1,
        };
    });

    const targetLen = Math.max(normSearch.length, 1);
    const maxWindowLen = targetLen * WINDOW_MAX_LENGTH_FACTOR;

    // Slide a window from each start line, growing it until its combined
    // length covers the target; track the union of matched search words.
    let best = { start: 0, end: 0, score: 0 };
    for (let i = 0; i < lineInfo.length; i++) {
        const matched = new Set<string>();
        let charLen = 0;
        for (let j = i; j < lineInfo.length; j++) {
            for (const w of lineInfo[j].words) {
                if (searchWords.has(w)) matched.add(w);
            }
            charLen += lineInfo[j].len;
            const score = matched.size / searchWords.size;
            if (score > best.score) best = { start: i, end: j, score };
            if (charLen >= maxWindowLen) break;
        }
    }
    if (best.score < WINDOW_MIN_SCORE) return [];

    // Return the most word-dense individual lines from the winning region as
    // short pasteable anchors. Skip pure-structure lines (no content words).
    const regionLines: Array<{ score: number; line: string; pivot: number }> = [];
    for (let k = best.start; k <= best.end; k++) {
        const info = lineInfo[k];
        if (info.words.length === 0) continue;
        let matches = 0;
        let firstWord: string | null = null;
        for (const w of new Set(info.words)) {
            if (!searchWords.has(w)) continue;
            matches += 1;
            if (firstWord === null) firstWord = w;
        }
        if (matches === 0) continue;
        let pivot = 0;
        if (firstWord) {
            const p = info.trimmed.toLowerCase().indexOf(firstWord);
            if (p !== -1) pivot = p;
        }
        regionLines.push({
            score: matches / searchWords.size,
            line: info.trimmed,
            pivot,
        });
    }
    regionLines.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const out: CandidateSnippet[] = [];
    for (const entry of regionLines) {
        if (out.length >= maxCandidates) break;
        const { snippet, truncated } = markTruncatedUnlessVerbatim(
            centerTruncate(entry.line, entry.pivot, maxSnippetLength),
            simplified,
        );
        if (seen.has(snippet)) continue;
        seen.add(snippet);
        // score is the region-level window overlap, shared by all lines so
        // the model (and the backend regime classifier) treats them uniformly.
        out.push({ snippet, truncated, via: 'fuzzy_window', score: best.score });
    }
    return out;
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
