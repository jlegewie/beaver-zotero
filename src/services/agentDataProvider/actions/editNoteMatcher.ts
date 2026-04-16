/**
 * Ranked matcher for `edit_note` `old_string` lookup.
 *
 * Replaces a hand-rolled 13-layer fallback cascade with a single table of
 * normalization strategies. Each strategy attempts one transformation; the
 * first one that yields at least one match wins. Disambiguation of multi-match
 * results is the caller's responsibility — strategies never decide between
 * multiple occurrences.
 *
 * Strategies are tried in this order (ranked most- to least-specific):
 *   1. exact                    — no transformation
 *   2. entity_decode            — `&#x27;` → `'` on the search needle
 *   3. entity_encode            — `'` → `&#x27;` / `&#39;` / `&apos;`
 *   4. nfkc                     — CJK full-width → half-width
 *   5. trim_trailing_newlines   — strip extra `\n` at end of old_string
 *   6. json_unescape            — convert literal `\n`, `\"`, `\\` etc.
 *   7. partial_element_strip    — strip malformed `<citation.../>` fragments
 *   8. spurious_wrap_strip      — unwrap surrounding `<p>…</p>` etc.
 *   9. markdown_to_html         — convert `**bold**` / `## h` to HTML equivalents
 */

import {
    countOccurrences,
    type SimplificationMetadata,
} from '../../../utils/noteHtmlSimplifier';
import { stripNoteWrapperDiv } from '../../../utils/noteWrapper';
import {
    expandToRawHtml,
    type ExternalRefContext,
} from '../../../utils/noteCitationExpand';
import {
    decodeHtmlEntities,
    encodeTextEntities,
    ENTITY_FORMS,
} from '../../../utils/noteHtmlEntities';
import {
    stripPartialSimplifiedElements,
    stripSpuriousWrappingTags,
} from '../../../utils/editNoteStrippers';
import type { EditNoteOperation } from '../../../../react/types/agentActions/editNote';

// =============================================================================
// Types
// =============================================================================

export type MatchStrategyName =
    | 'exact'
    | 'entity_decode'
    | 'entity_encode'
    | 'nfkc'
    | 'trim_trailing_newlines'
    | 'json_unescape'
    | 'partial_element_strip'
    | 'spurious_wrap_strip'
    | 'markdown_to_html';

export interface MatchInput {
    /** Enriched, simplified-space old_string. */
    oldString: string;
    /**
     * Simplified-space new_string.
     * For insert operations validation usually passes the raw payload, while
     * execution often passes the already-merged replacement from
     * normalized_action_data.
     */
    newString: string;
    operation: EditNoteOperation;
    metadata: SimplificationMetadata;
    simplified: string;
    /** `normalizeNoteHtml(rawHtml)` with `data-citation-items` stripped. */
    strippedHtml: string;
    externalRefContext: ExternalRefContext;
}

export interface BaseExpansion {
    expandedOld: string;
    expandedNew: string;
}

export interface MatchResult {
    strategy: MatchStrategyName;
    /** Simplified-space old_string after any strategy rewrite. */
    oldString: string;
    /** Simplified-space new_string after any strategy rewrite, preserving the input form. */
    newString: string;
    /** Raw-HTML-space match needle. */
    expandedOld: string;
    /** Raw-HTML-space replacement. */
    expandedNew: string;
    matchCount: number;
    /**
     * Pre-computed raw position into `strippedHtml`. Only set by
     * `partial_element_strip` when disambiguation via simplified-position
     * translation succeeds. Consumers should prefer this over running
     * `locateEditTarget` when present.
     */
    rawPositionHint?: number;
    /**
     * Transforms a context anchor the same way the strategy transformed
     * `expandedOld`. Identity for strategies that mutate the simplified-space
     * input (trim, json_unescape, partial_strip, spurious_wrap). Non-identity
     * for representation-level transforms (entity_decode, entity_encode, nfkc)
     * so executors can re-apply to stored anchors.
     */
    normalizeAnchor: (anchor: string) => string;
}

interface Strategy {
    name: MatchStrategyName;
    tryMatch(input: MatchInput, base: BaseExpansion): MatchResult | null;
}

// =============================================================================
// Shared helpers
// =============================================================================

const identity = (s: string): string => s;

function rewriteInsertReplacementForTrim(
    operation: EditNoteOperation,
    oldString: string,
    newString: string,
    trimmedOld: string,
): string {
    if (operation === 'insert_after' && newString.startsWith(oldString)) {
        return trimmedOld + newString.substring(oldString.length);
    }
    if (operation === 'insert_before' && newString.endsWith(oldString)) {
        return newString.substring(0, newString.length - oldString.length) + trimmedOld;
    }
    return newString;
}

/**
 * Expand `old_string` and `new_string` to raw-HTML space. Throws on invalid
 * input; both production call sites (`validateEditNoteAction`,
 * `executeEditNoteAction`) catch and translate into an `expansion_failed`
 * response envelope.
 */
export function expandBase(input: MatchInput): BaseExpansion {
    return {
        expandedOld: expandToRawHtml(input.oldString, input.metadata, 'old'),
        expandedNew: expandToRawHtml(
            input.newString,
            input.metadata,
            'new',
            input.externalRefContext,
        ),
    };
}

/**
 * Convert a small, conservative set of CommonMark/GFM inline patterns to the
 * HTML the rendered note contains. Only `**bold**`, `__bold__`, and ATX
 * headings on their own line are handled — these are the patterns production
 * data shows the model reverts to when copying `old_string` from the markdown
 * it originally wrote in `create_note`, instead of the rendered `note_content`.
 *
 * Skipped entirely: italic (ambiguous with bold), links, lists, tables, code,
 * math, smart-punctuation drift. Splits on `<...>` boundaries so content inside
 * HTML tag attributes (e.g. `<citation label="**x**"/>`) is never transformed.
 *
 * ATX headings follow CommonMark: up to 3 leading spaces, one or more
 * spaces/tabs after the `#`s, optional closing `#+` fence preceded by
 * whitespace, trailing whitespace (including a stray `\r` from CRLF input)
 * stripped from the heading text. `## Section#5` keeps the trailing `#5`
 * because there is no whitespace before the second `#`.
 *
 * Returns the input unchanged when nothing matches.
 */
function convertMarkdownToHtml(s: string): string {
    if (!s) return s;
    // Text at even indices, tags at odd indices — same pattern as noteHtmlEntities.
    const parts = s.split(/(<[^>]*>)/);
    let changed = false;
    for (let i = 0; i < parts.length; i += 2) {
        const before = parts[i];
        let after = before;
        // ATX headings: `# h` through `###### h`, each on its own line.
        // `\r?` lets `$` (which matches before `\n`) absorb a stray `\r` from
        // CRLF input so the captured text never contains a trailing `\r`.
        after = after.replace(
            /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/gm,
            (_m, hashes, text) => `<h${hashes.length}>${text}</h${hashes.length}>`,
        );
        // Strong emphasis: `**text**` and `__text__`. Non-greedy and
        // same-line so `**a** plain **b**` becomes two independent matches and
        // markers can't straddle paragraph breaks.
        after = after.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>');
        after = after.replace(/__([^\n_]+?)__/g, '<strong>$1</strong>');
        if (after !== before) {
            parts[i] = after;
            changed = true;
        }
    }
    return changed ? parts.join('') : s;
}

// =============================================================================
// Strategies
// =============================================================================

const exactStrategy: Strategy = {
    name: 'exact',
    tryMatch(input, base) {
        const matchCount = countOccurrences(input.strippedHtml, base.expandedOld);
        if (matchCount === 0) return null;
        return {
            strategy: 'exact',
            oldString: input.oldString,
            newString: input.newString,
            expandedOld: base.expandedOld,
            expandedNew: base.expandedNew,
            matchCount,
            normalizeAnchor: identity,
        };
    },
};

const entityDecodeStrategy: Strategy = {
    name: 'entity_decode',
    tryMatch(input, base) {
        // Forward direction: model wrote entity form (`&#x27;`) but PM has
        // already decoded the note to the literal character (`'`). Decode the
        // expanded search needle so it lines up with the note's text.
        const decodedOld = decodeHtmlEntities(base.expandedOld);
        if (decodedOld === base.expandedOld) return null;
        const matchCount = countOccurrences(input.strippedHtml, decodedOld);
        if (matchCount === 0) return null;
        return {
            strategy: 'entity_decode',
            oldString: input.oldString,
            newString: input.newString,
            expandedOld: decodedOld,
            expandedNew: decodeHtmlEntities(base.expandedNew),
            matchCount,
            normalizeAnchor: decodeHtmlEntities,
        };
    },
};

const entityEncodeStrategy: Strategy = {
    name: 'entity_encode',
    tryMatch(input, base) {
        // Reverse direction: model wrote literal char (`'`) but the note
        // stored an entity-encoded form. Try each known entity spelling and
        // use the first one that matches.
        for (const form of ENTITY_FORMS) {
            const encodedOld = encodeTextEntities(base.expandedOld, form);
            if (encodedOld === base.expandedOld) continue;
            const matchCount = countOccurrences(input.strippedHtml, encodedOld);
            if (matchCount === 0) continue;
            return {
                strategy: 'entity_encode',
                oldString: input.oldString,
                newString: input.newString,
                expandedOld: encodedOld,
                expandedNew: encodeTextEntities(base.expandedNew, form),
                matchCount,
                normalizeAnchor: (s) => encodeTextEntities(s, form),
            };
        }
        return null;
    },
};

const nfkcStrategy: Strategy = {
    name: 'nfkc',
    tryMatch(input, base) {
        // CJK full-width → half-width drift: notes written originally with
        // full-width punctuation (，（）) may be stored in half-width after a
        // prior create_note round. NFKC-normalize both sides symmetrically.
        const nfkcOld = base.expandedOld.normalize('NFKC');
        if (nfkcOld === base.expandedOld) return null;
        const matchCount = countOccurrences(input.strippedHtml, nfkcOld);
        if (matchCount === 0) return null;
        return {
            strategy: 'nfkc',
            oldString: input.oldString,
            newString: input.newString,
            expandedOld: nfkcOld,
            expandedNew: base.expandedNew.normalize('NFKC'),
            matchCount,
            normalizeAnchor: (s) => s.normalize('NFKC'),
        };
    },
};

const trimTrailingNewlinesStrategy: Strategy = {
    name: 'trim_trailing_newlines',
    tryMatch(input) {
        if (!input.oldString) return null;
        const trimmedOld = input.oldString.replace(/\n+$/, '');
        if (trimmedOld === input.oldString) return null;

        let expandedOld: string;
        try {
            expandedOld = expandToRawHtml(trimmedOld, input.metadata, 'old');
        } catch {
            return null;
        }
        const matchCount = countOccurrences(input.strippedHtml, expandedOld);
        if (matchCount === 0) return null;

        // For insert operations validation usually passes the raw payload, but
        // execution often passes a merged replacement from normalized_action_data.
        // Preserve the input form while trimming the copied anchor fragment when
        // it is already embedded in new_string.
        const isInsert = input.operation === 'insert_after' || input.operation === 'insert_before';
        const trimmedNew = isInsert
            ? rewriteInsertReplacementForTrim(
                input.operation,
                input.oldString,
                input.newString,
                trimmedOld,
            )
            : input.newString.replace(/\n+$/, '');

        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                trimmedNew, input.metadata, 'new', input.externalRefContext,
            );
        } catch {
            return null;
        }

        return {
            strategy: 'trim_trailing_newlines',
            oldString: trimmedOld,
            newString: trimmedNew,
            expandedOld,
            expandedNew,
            matchCount,
            normalizeAnchor: identity,
        };
    },
};

const JSON_ESCAPE_PATTERN = /\\(["\\/nrt])/g;
const unescapeJsonEscapes = (s: string): string =>
    s.replace(JSON_ESCAPE_PATTERN, (_match, c) => {
        switch (c) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            default: return c; // " \ /
        }
    });

const jsonUnescapeStrategy: Strategy = {
    name: 'json_unescape',
    tryMatch(input) {
        if (!input.oldString) return null;
        if (!/\\["\\/nrt]/.test(input.oldString)) return null;
        const unescapedOld = unescapeJsonEscapes(input.oldString);
        if (unescapedOld === input.oldString) return null;

        let expandedOld: string;
        try {
            expandedOld = expandToRawHtml(unescapedOld, input.metadata, 'old');
        } catch {
            return null;
        }
        const matchCount = countOccurrences(input.strippedHtml, expandedOld);
        if (matchCount === 0) return null;

        const unescapedNew = unescapeJsonEscapes(input.newString);
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                unescapedNew, input.metadata, 'new', input.externalRefContext,
            );
        } catch {
            return null;
        }

        return {
            strategy: 'json_unescape',
            oldString: unescapedOld,
            newString: unescapedNew,
            expandedOld,
            expandedNew,
            matchCount,
            normalizeAnchor: identity,
        };
    },
};

const partialElementStripStrategy: Strategy = {
    name: 'partial_element_strip',
    tryMatch(input) {
        if (!input.oldString) return null;
        const simplifiedPos = input.simplified.indexOf(input.oldString);
        if (simplifiedPos === -1) return null;
        // Gate on simplified-space uniqueness so the leadingStrip offset is
        // meaningful — otherwise we can't translate back to a raw position.
        if (input.simplified.indexOf(input.oldString, simplifiedPos + 1) !== -1) return null;

        const stripped = stripPartialSimplifiedElements(
            input.oldString, input.newString, input.simplified, simplifiedPos,
        );
        if (!stripped) return null;

        let expandedOld: string;
        let expandedNew: string;
        try {
            expandedOld = expandToRawHtml(stripped.strippedOld, input.metadata, 'old');
            expandedNew = expandToRawHtml(
                stripped.strippedNew, input.metadata, 'new', input.externalRefContext,
            );
        } catch {
            return null;
        }
        const matchCount = countOccurrences(input.strippedHtml, expandedOld);
        if (matchCount === 0) return null;

        // Multi-match with str_replace: translate the known simplified position
        // to a raw-HTML position so the caller can emit precise context
        // anchors. If translation fails, fall through to the next strategy
        // (mirrors the pre-refactor behavior of setting `matchCount = 0`).
        let rawPositionHint: number | undefined;
        if (matchCount > 1 && input.operation !== 'str_replace_all') {
            try {
                const strippedStart = simplifiedPos + stripped.leadingStrip;
                const expandedBefore = expandToRawHtml(
                    input.simplified.substring(0, strippedStart),
                    input.metadata,
                    'old',
                );
                const unwrapped = stripNoteWrapperDiv(input.strippedHtml);
                const wrapperPrefixLen = unwrapped !== input.strippedHtml
                    ? input.strippedHtml.indexOf('>') + 1
                    : 0;
                const rawPos = wrapperPrefixLen + expandedBefore.length;
                if (input.strippedHtml.substring(rawPos, rawPos + expandedOld.length) === expandedOld) {
                    rawPositionHint = rawPos;
                }
            } catch {
                // prefix expansion failed — no hint available
            }
            if (rawPositionHint === undefined) return null;
        }

        return {
            strategy: 'partial_element_strip',
            oldString: stripped.strippedOld,
            newString: stripped.strippedNew,
            expandedOld,
            expandedNew,
            matchCount,
            rawPositionHint,
            normalizeAnchor: identity,
        };
    },
};

const spuriousWrapStripStrategy: Strategy = {
    name: 'spurious_wrap_strip',
    tryMatch(input) {
        if (!input.oldString) return null;
        const candidates = stripSpuriousWrappingTags(input.oldString, input.newString);
        // Candidates are ordered least-to-most aggressive (leading-only,
        // trailing-only, both) — take the first that matches to preserve as
        // much structural context as possible.
        for (const candidate of candidates) {
            let expandedOld: string;
            let expandedNew: string;
            try {
                expandedOld = expandToRawHtml(candidate.strippedOld, input.metadata, 'old');
                expandedNew = expandToRawHtml(
                    candidate.strippedNew, input.metadata, 'new', input.externalRefContext,
                );
            } catch {
                continue;
            }
            const matchCount = countOccurrences(input.strippedHtml, expandedOld);
            if (matchCount === 0) continue;
            return {
                strategy: 'spurious_wrap_strip',
                oldString: candidate.strippedOld,
                newString: candidate.strippedNew,
                expandedOld,
                expandedNew,
                matchCount,
                normalizeAnchor: identity,
            };
        }
        return null;
    },
};

const markdownToHtmlStrategy: Strategy = {
    name: 'markdown_to_html',
    tryMatch(input) {
        if (!input.oldString) return null;
        const convertedOld = convertMarkdownToHtml(input.oldString);
        if (convertedOld === input.oldString) return null;

        let expandedOld: string;
        try {
            expandedOld = expandToRawHtml(convertedOld, input.metadata, 'old');
        } catch {
            return null;
        }
        const matchCount = countOccurrences(input.strippedHtml, expandedOld);
        if (matchCount === 0) return null;

        // Convert new_string the same way so the replacement is HTML too.
        // For insert_after / insert_before at execution time, `newString` is
        // the already-merged `old + injected`; converting the whole thing
        // keeps the prefix aligned with `convertedOld` because the same
        // transform is applied on both sides.
        //
        // Tradeoff: a caller that genuinely wants literal `**` / `##` in the
        // saved note cannot reach this branch anyway — exact match runs first
        // and wins for HTML old_strings like `<strong>bold</strong>`. The
        // only way to land here is to use markdown in old_string, which
        // signals "speaking markdown" and makes symmetric conversion of
        // new_string the consistent choice. Leaving new_string literal would
        // instead persist raw `**` into HTML (rendered as plain asterisks),
        // which is almost never what the model intended.
        const convertedNew = convertMarkdownToHtml(input.newString);

        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                convertedNew, input.metadata, 'new', input.externalRefContext,
            );
        } catch {
            return null;
        }

        return {
            strategy: 'markdown_to_html',
            oldString: convertedOld,
            newString: convertedNew,
            expandedOld,
            expandedNew,
            matchCount,
            normalizeAnchor: identity,
        };
    },
};

// =============================================================================
// Public API
// =============================================================================

const STRATEGIES: Strategy[] = [
    exactStrategy,
    entityDecodeStrategy,
    entityEncodeStrategy,
    nfkcStrategy,
    trimTrailingNewlinesStrategy,
    jsonUnescapeStrategy,
    partialElementStripStrategy,
    spuriousWrapStripStrategy,
    markdownToHtmlStrategy,
];

/**
 * Run each strategy in rank order and return the first one that produces at
 * least one match. Returns `null` when nothing matches — callers should
 * translate that to an `old_string_not_found` response with a zero-match hint.
 */
export function findBestMatch(
    input: MatchInput,
    base: BaseExpansion,
): MatchResult | null {
    for (const strategy of STRATEGIES) {
        const result = strategy.tryMatch(input, base);
        if (result && result.matchCount > 0) return result;
    }
    return null;
}
