/**
 * Citation preprocessing utilities.
 * 
 * Handles parsing and normalizing citation tags from LLM output
 * before they are rendered by React components.
 */

import { 
    parseCitationAttributes, 
    computeCitationKeyFromAttrs, 
    getCitationIdentityKey,
    NormalizedCitationAttrs
} from '../types/citations';

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
    attrs: NormalizedCitationAttrs;
    /** Citation key for metadata lookup */
    citationKey: string;
    /** Whether this cites the same item as the previous citation */
    isConsecutive: boolean;
    /** Whether this is adjacent (only whitespace between) to previous */
    isAdjacent: boolean;
    /** The reconstructed HTML tag */
    html: string;
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
    // Parse and normalize attributes using shared utility
    const normalizedAttrs = parseCitationAttributes(attributesStr);
    
    // Get identity key for consecutive detection
    const identityKey = getCitationIdentityKey(normalizedAttrs);
    
    // Check if this citation references the same item as the previous one
    const isConsecutive = !!(identityKey && identityKey === state.lastIdentityKey);
    
    // Check if adjacent (only whitespace between this and previous citation)
    const isAdjacent = isConsecutive && state.lastEndIndex >= 0 && 
        fullString.substring(state.lastEndIndex, offset).trim() === '';
    
    // Update state for next iteration
    state.lastIdentityKey = identityKey;
    state.lastEndIndex = offset + matchLength;
    
    // Build normalized attribute string for HTML output
    const attrParts: string[] = [];
    if (normalizedAttrs.item_id) attrParts.push(`item_id="${normalizedAttrs.item_id}"`);
    if (normalizedAttrs.att_id) attrParts.push(`att_id="${normalizedAttrs.att_id}"`);
    if (normalizedAttrs.external_id) attrParts.push(`external_id="${normalizedAttrs.external_id}"`);
    if (normalizedAttrs.sid) attrParts.push(`sid="${normalizedAttrs.sid}"`);
    const normalizedAttrStr = attrParts.join(' ');
    
    // Compute citation_key for metadata lookup (single source of truth)
    const citationKey = computeCitationKeyFromAttrs(normalizedAttrs);
    const citationKeyAttr = citationKey ? `citation_key="${citationKey}"` : '';
    
    // Build final tag with normalized attributes
    const baseAttrs = [normalizedAttrStr, citationKeyAttr].filter(Boolean).join(' ');
    
    let html: string;
    if (isAdjacent) {
        html = `<citation ${baseAttrs} consecutive="true" adjacent="true"></citation>`;
    } else if (isConsecutive) {
        html = `<citation ${baseAttrs} consecutive="true"></citation>`;
    } else {
        html = `<citation ${baseAttrs}></citation>`;
    }
    
    return {
        attrs: normalizedAttrs,
        citationKey,
        isConsecutive,
        isAdjacent,
        html
    };
}

/**
 * Regex pattern for matching citation tags in all formats:
 * - Self-closing: <citation att_id="..."/>
 * - Opening only (missing /): <citation att_id="...">
 * - Full pair: <citation att_id="..."></citation>
 */
export const CITATION_TAG_PATTERN = /<citation\s+((?:[^>])+?)\s*(?:\/>|>(?:<\/citation>)?)/g;

/**
 * Preprocess citations in markdown content.
 * 
 * Handles various LLM output formats gracefully:
 * - Self-closing: <citation att_id="..."/>
 * - Opening only (missing /): <citation att_id="...">
 * - Full pair: <citation att_id="..."></citation>
 * - Attribute variations: attachment_id → att_id
 * 
 * Injects citation_key for metadata lookup (e.g., "zotero:1-ABC123" or "external:xyz")
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
    // Reset the regex lastIndex for each call
    CITATION_TAG_PATTERN.lastIndex = 0;
    
    // Reset lastEndIndex for this new content string - adjacency detection
    // should only apply within the same content, not across different segments.
    // Keep lastIdentityKey so consecutive detection still works across segments.
    state.lastEndIndex = -1;
    
    return content.replace(
        CITATION_TAG_PATTERN,
        (match, attributesStr, offset, fullString) => {
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

