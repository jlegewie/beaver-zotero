/**
 * Citation preprocessing utilities.
 * 
 * Handles parsing and normalizing citation tags from LLM output
 * before they are rendered by React components.
 */

import type { NormalizedCitationAttrs } from '../types/citations';
import {
    baseCitationKey,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
} from './citationGrammar';

/**
 * State for tracking consecutive citations across preprocessing calls.
 * 
 * - `lastIdentityKey`: Preserved across segments for consecutive detection
 * - `lastEndIndex`: Reset per segment (adjacency is segment-scoped)
 */
export interface CitationPreprocessState {
    /** The identity key of the last citation processed (preserved across segments) */
    lastIdentityKey: string;
    /** The end index of the last citation in the current content (reset per segment) */
    lastEndIndex: number;
}

/**
 * Create initial preprocessing state.
 */
export function createPreprocessState(): CitationPreprocessState {
    return { lastIdentityKey: '', lastEndIndex: -1 };
}

/**
 * Result of preprocessing a single citation tag.
 */
export interface PreprocessedCitation {
    /** Normalized attributes */
    attrs: NormalizedCitationAttrs | Record<string, string>;
    /** Citation key for metadata lookup */
    citationKey: string;
    /** Whether this cites the same item as the previous citation */
    isConsecutive: boolean;
    /** Whether this is adjacent (only whitespace between) to previous */
    isAdjacent: boolean;
    /** The reconstructed HTML tag */
    html: string;
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function attr(name: string, value: string | number | undefined): string | null {
    if (value == null) return null;
    return `${name}="${escapeAttr(String(value))}"`;
}

/**
 * Preprocess a single citation match.
 * 
 * @param attributesStr Raw attribute string from the citation tag
 * @param offset Position in the content
 * @param matchLength Length of the matched tag
 * @param fullString The full content string
 * @param state Mutable state for tracking consecutive citations
 * @returns Preprocessed citation result
 */
export function preprocessCitationMatch(
    attributesStr: string,
    offset: number,
    matchLength: number,
    fullString: string,
    state: CitationPreprocessState
): PreprocessedCitation {
    const rawAttrs = parseRawCitationAttributes(attributesStr);
    const normalized = normalizeCitationTag(rawAttrs);
    const identityKey = normalized.ok
        ? baseCitationKey(normalized.ref)
        : (normalized.requestedKey || '');
    
    // Check if this citation references the same item as the previous one
    const isConsecutive = !!(identityKey && identityKey === state.lastIdentityKey);
    
    // Check if adjacent (only whitespace between this and previous citation)
    const isAdjacent = isConsecutive && state.lastEndIndex >= 0 && 
        fullString.substring(state.lastEndIndex, offset).trim() === '';
    
    // Update state for next iteration
    state.lastIdentityKey = identityKey;
    state.lastEndIndex = offset + matchLength;
    
    const attrParts: Array<string | null> = [];
    let citationKey = '';

    if (normalized.ok) {
        const ref = normalized.ref;
        citationKey = requestedCitationKey(ref);
        if (ref.kind === 'zotero') {
            attrParts.push(
                attr('data-library-id', ref.library_id),
                attr('data-zotero-key', ref.zotero_key),
            );
        } else {
            attrParts.push(
                attr('data-external-id', ref.external_id),
                attr('data-external-source', ref.source),
            );
        }
        if (ref.loc) {
            attrParts.push(attr('data-loc', ref.loc.raw), attr('data-loc-kind', ref.loc.kind), attr('data-loc-value', ref.loc.value));
        }
        attrParts.push(attr('data-requested-citation-key', citationKey));
    } else {
        citationKey = normalized.requestedKey || '';
        attrParts.push(
            attr('data-invalid-reason', normalized.reason),
            attr('data-requested-citation-key', citationKey || undefined),
            attr('data-raw-identity', normalized.rawIdentity),
            attr('data-identity-attr', normalized.identityAttr),
        );
    }

    if (isConsecutive) attrParts.push(attr('data-consecutive', 'true'));
    if (isAdjacent) attrParts.push(attr('data-adjacent', 'true'));

    const baseAttrs = attrParts.filter((part): part is string => !!part).join(' ');
    
    let html: string;
    html = baseAttrs ? `<citation ${baseAttrs}></citation>` : '<citation></citation>';
    
    return {
        attrs: rawAttrs,
        citationKey,
        isConsecutive,
        isAdjacent,
        html
    };
}

/**
 * Unwrap backtick-wrapped citation tags (common LLM mistake).
 * Matches: `<citation att_id="...">` → <citation att_id="...">
 *
 * Also handles multiple adjacent citation tags sharing one pair of backticks
 * (e.g. consecutive citations of the same item):
 * `<citation .../><citation .../>` → <citation .../><citation .../>
 */
const UNWRAP_BACKTICK_PATTERN = /`(<citation[^>]*>(?:\s*<citation[^>]*>)*)`/g;

/**
 * Regex pattern for matching citation tags in all formats:
 * - Self-closing: <citation att_id="..."/>
 * - Opening only (missing /): <citation att_id="...">
 * - Full pair: <citation att_id="..."></citation>
 */
export const CITATION_TAG_PATTERN = /<citation(?:\s+([^>]*?))?\s*(?:\/>|>(?:<\/citation>)?)/g;

/**
 * Preprocess citations in markdown content.
 * 
 * Handles various LLM output formats gracefully:
 * - Self-closing: <citation att_id="..."/>
 * - Opening only (missing /): <citation att_id="...">
 * - Full pair: <citation att_id="..."></citation>
 * - Attribute variations: attachment_id → att_id
 * 
 * Injects data-requested-citation-key for metadata lookup.
 * 
 * **State behavior across segments:**
 * - `lastIdentityKey` is preserved across calls (consecutive detection works across segments)
 * - `lastEndIndex` is reset per call (adjacency detection is scoped to each segment)
 * 
 * @param content Markdown content with citation tags
 * @param state Optional state for tracking across multiple calls
 * @returns Preprocessed content with normalized citations
 */
export function preprocessCitations(
    content: string, 
    state: CitationPreprocessState = createPreprocessState()
): string {
    // Unwrap backtick-wrapped citation tags (common LLM mistake)
    content = content.replace(UNWRAP_BACKTICK_PATTERN, '$1');

    // Reset the regex lastIndex for each call
    CITATION_TAG_PATTERN.lastIndex = 0;

    // Reset lastEndIndex for this new content string - adjacency detection
    // should only apply within the same content, not across different segments.
    // Keep lastIdentityKey so consecutive detection still works across segments.
    state.lastEndIndex = -1;

    return content.replace(
        CITATION_TAG_PATTERN,
        (match, attributesStr = '', offset, fullString) => {
            const result = preprocessCitationMatch(
                attributesStr,
                offset,
                match.length,
                fullString,
                state
            );
            return result.html;
        }
    );
}

/**
 * Legacy wrapper for backwards compatibility.
 * @deprecated Use preprocessCitations with CitationPreprocessState instead
 */
export function preprocessCitationsWithRef(
    content: string, 
    lastCitationKeyRef: { value: string }
): string {
    const state: CitationPreprocessState = {
        lastIdentityKey: lastCitationKeyRef.value,
        lastEndIndex: -1
    };
    const result = preprocessCitations(content, state);
    lastCitationKeyRef.value = state.lastIdentityKey;
    return result;
}
