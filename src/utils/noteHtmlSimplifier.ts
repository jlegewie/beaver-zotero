/**
 * Note HTML Simplifier
 *
 * Converts Zotero note HTML to a simplified intermediate format that replaces
 * opaque metadata (citations with URI-encoded JSON, annotation position data,
 * base64 images, data-citation-items caches) with clean semantic tags.
 *
 * This enables LLM agents to edit notes via StrReplace without corrupting
 * metadata. The reverse transformation (simplified → raw) lives in
 * `noteCitationExpand.ts`.
 */

import { stripBeaverEditFooter, stripBeaverCreatedFooter } from './noteEditFooter';
import { escapeAttr } from './noteHtmlEntities';
import { stripDataCitationItems, stripNoteWrapperDiv } from './noteWrapper';
import { normalizeNoteHtml } from '../prosemirror/normalize';

export { normalizeNoteHtml };

// =============================================================================
// Types
// =============================================================================

export interface SimplificationResult {
    simplified: string;
    metadata: SimplificationMetadata;
}

export interface SimplificationMetadata {
    elements: Map<string, StoredElement>;
}

export interface StoredElement {
    rawHtml: string;
    type: 'citation' | 'compound-citation' | 'annotation' | 'annotation-image' | 'image';
    originalAttrs?: { item_id: string; page?: string };
    isCompound?: boolean;
    originalText?: string;
}

interface CachedSimplification {
    contentHash: string;
    simplified: string;
    metadata: SimplificationMetadata;
}

// =============================================================================
// Cache
// =============================================================================

const MAX_CACHE_SIZE = 50;
const simplificationCache = new Map<string, CachedSimplification>();

function quickHash(str: string): string {
    // Simple hash for content comparison (not cryptographic)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return String(hash) + ':' + str.length;
}

/**
 * Get a cached simplification or re-simplify if cache is stale/missing.
 */
export function getOrSimplify(
    noteId: string,
    rawHtml: string,
    libraryID: number
): { simplified: string; metadata: SimplificationMetadata; isStale: boolean } {
    const contentHash = quickHash(rawHtml);
    const cached = simplificationCache.get(noteId);

    if (cached && cached.contentHash === contentHash) {
        return { simplified: cached.simplified, metadata: cached.metadata, isStale: false };
    }

    // Cache miss or stale — re-simplify
    const result = simplifyNoteHtml(rawHtml, libraryID);

    // Evict oldest entries if cache is full
    if (simplificationCache.size >= MAX_CACHE_SIZE) {
        const firstKey = simplificationCache.keys().next().value;
        if (firstKey !== undefined) {
            simplificationCache.delete(firstKey);
        }
    }

    simplificationCache.set(noteId, {
        contentHash,
        simplified: result.simplified,
        metadata: result.metadata,
    });

    return {
        simplified: result.simplified,
        metadata: result.metadata,
        isStale: cached !== undefined,
    };
}

/**
 * Invalidate cache entry for a note.
 */
export function invalidateSimplificationCache(noteId: string): void {
    simplificationCache.delete(noteId);
}

// =============================================================================
// Simplification: Raw HTML → Simplified + Metadata
// =============================================================================

/**
 * Extract the item key from a Zotero URI.
 * e.g., "http://zotero.org/users/17517181/items/FQSW6YKU" → "FQSW6YKU"
 */
function extractItemKeyFromUri(uri: string): string | null {
    const match = uri.match(/\/items\/([A-Z0-9]+)$/i);
    return match ? match[1] : null;
}

/**
 * Simplify Zotero note HTML to a clean format for LLM editing.
 *
 * Replaces citations, annotations, annotation-images, regular images, and
 * math elements with semantic tags / dollar notation, and strips
 * data-citation-items from the wrapper div.
 * Stores original raw HTML in the metadata map for expansion back.
 */
export function simplifyNoteHtml(rawHtml: string, libraryID: number): SimplificationResult {
    const metadata: SimplificationMetadata = { elements: new Map() };

    // Track occurrence counts for content-based IDs
    const citationKeyCounts = new Map<string, number>();

    // Strip Beaver footers FIRST, before any normalization. The footer regexes
    // require <a href="zotero://beaver/thread/..."> to be present, but Zotero's
    // chrome HTMLDocument (used by normalizeNoteHtml under getDocument()) silently
    // drops href attrs whose scheme is `zotero://` when parsing via innerHTML.
    // Once the href is gone, ProseMirror's link mark (`tag: 'a[href]'`) can't
    // bind, the <a> is dropped on re-serialization, and the regexes never match —
    // so the footer would leak into the simplified view that the agent sees and
    // edits. Stripping pre-normalize keeps the regexes operating on the raw shape
    // that the writers (`getBeaverNoteFooterHTML`, `buildEditFooterHtml`) actually
    // emit. Note: this only affects what the agent sees in the simplified view —
    // the raw HTML on disk is untouched, since edit_note saves changes against
    // its own normalize'd-but-uncached `strippedHtml`, not against `simplified`.
    let simplified = stripBeaverEditFooter(rawHtml);
    simplified = stripBeaverCreatedFooter(simplified);

    // Use regex-based approach to avoid DOMParser re-serialization issues.
    // DOMParser + innerHTML can change attribute order, whitespace, and entity encoding.
    // Pre-normalize to ProseMirror-canonical format so the simplified output is stable
    // across PM re-serializations (hex→rgb, style splitting, legacy elements, etc.).
    simplified = normalizeNoteHtml(simplified);

    // 1. Strip data-citation-items from wrapper div
    simplified = stripDataCitationItems(simplified);

    // 2. Replace annotation images (img with both data-attachment-key and data-annotation)
    // Must process before regular images since annotation images also have data-attachment-key
    simplified = simplified.replace(
        /<img\s+([^>]*data-attachment-key="([^"]*)"[^>]*data-annotation="([^"]*)"[^>]*)\/?\s*>/g,
        (match, _allAttrs, attachmentKey, encodedAnnotation) => {
            try {
                const annotationData = JSON.parse(decodeURIComponent(encodedAnnotation));
                const annotationKey = annotationData.annotationKey || 'unknown';
                const id = `ai_${annotationKey}`;

                // Extract width/height from attrs
                const widthMatch = match.match(/width="(\d+)"/);
                const heightMatch = match.match(/height="(\d+)"/);
                const width = widthMatch ? widthMatch[1] : '';
                const height = heightMatch ? heightMatch[1] : '';

                metadata.elements.set(id, {
                    rawHtml: match,
                    type: 'annotation-image',
                });

                let tag = `<annotation-image id="${id}" key="${annotationKey}" attachment="${attachmentKey}"`;
                if (width) tag += ` width="${width}"`;
                if (height) tag += ` height="${height}"`;
                tag += ' />';
                return tag;
            } catch {
                return match; // Leave unchanged if parsing fails
            }
        }
    );

    // 3. Replace regular images (img with data-attachment-key but no data-annotation)
    simplified = simplified.replace(
        /<img\s+([^>]*data-attachment-key="([^"]*)"[^>]*)\/?\s*>/g,
        (match, _allAttrs, attachmentKey) => {
            // Skip if this was already handled as annotation-image (check if it has data-annotation)
            if (match.includes('data-annotation=')) {
                return match;
            }
            const id = `i_${attachmentKey}`;

            metadata.elements.set(id, {
                rawHtml: match,
                type: 'image',
            });

            return `<image id="${id}" attachment="${attachmentKey}" />`;
        }
    );

    // 4. Replace annotations (span.highlight with data-annotation)
    simplified = simplified.replace(
        /<span\s+class="highlight"\s+data-annotation="([^"]*)">([\s\S]*?)<\/span>/g,
        (match, encodedAnnotation, innerText) => {
            try {
                const annotationData = JSON.parse(decodeURIComponent(encodedAnnotation));
                const annotationKey = annotationData.annotationKey || 'unknown';
                const color = annotationData.color || '';
                const pageLabel = annotationData.pageLabel || '';
                const id = `a_${annotationKey}`;

                metadata.elements.set(id, {
                    rawHtml: match,
                    type: 'annotation',
                    originalText: innerText,
                });

                let tag = `<annotation id="${id}" key="${annotationKey}"`;
                if (color) tag += ` color="${color}"`;
                if (pageLabel) tag += ` page="${pageLabel}"`;
                tag += `>${innerText}</annotation>`;
                return tag;
            } catch {
                return match;
            }
        }
    );

    // 5. Replace citations (span.citation with data-citation)
    // Regex handles nested <span class="citation-item"> tags inside citations.
    // Zotero's formatCitation() wraps each item: (<span class="citation-item">Author, 2024</span>)
    // The content group matches: non-< chars, or nested <span>...</span> pairs (one level deep).
    simplified = simplified.replace(
        /<span\s+class="citation"\s+data-citation="([^"]*)">((?:[^<]*(?:<span\b[^>]*>[^<]*<\/span>)?)*)<\/span>/g,
        (match, encodedCitation, visibleContent) => {
            try {
                const citationData = JSON.parse(decodeURIComponent(encodedCitation));
                const citationItems = citationData.citationItems || [];

                if (citationItems.length === 0) {
                    return match; // No citation items — leave unchanged
                }

                // Extract visible text (label) — the full visible content of the citation span
                let label = visibleContent
                    .replace(/<[^>]+>/g, '') // Strip HTML tags (e.g., <span class="citation-item">)
                    .trim();

                // ProseMirror atom nodes regenerate visible text from data-citation attrs.
                // When itemData is missing (schema v2+ moves it to container), toDOM
                // produces "()" — recover a useful label by looking up the item.
                if (!label || label === '()') {
                    label = generateCitationLabel(citationData);
                }

                if (citationItems.length === 1) {
                    // Single citation
                    const ci = citationItems[0];
                    const uri = ci.uris?.[0] || '';
                    const itemKey = extractItemKeyFromUri(uri) || 'unknown';
                    const itemId = `${libraryID}-${itemKey}`;
                    const page = ci.locator != null ? String(ci.locator) : '';

                    // Content-based ref with occurrence counter
                    const keyForCount = itemKey;
                    const occurrence = citationKeyCounts.get(keyForCount) || 0;
                    citationKeyCounts.set(keyForCount, occurrence + 1);
                    const ref = `c_${itemKey}_${occurrence}`;

                    metadata.elements.set(ref, {
                        rawHtml: match,
                        type: 'citation',
                        originalAttrs: { item_id: itemId, page: page || undefined },
                    });

                    let tag = `<citation item_id="${itemId}"`;
                    if (page) tag += ` page="${escapeAttr(page)}"`;
                    tag += ` label="${escapeAttr(label)}"`;
                    tag += ` ref="${ref}"/>`;
                    return tag;
                } else {
                    // Compound citation (multiple items)
                    const keys = citationItems.map((ci: any) => {
                        const uri = ci.uris?.[0] || '';
                        return extractItemKeyFromUri(uri) || 'unknown';
                    });
                    const compoundKey = keys.join('+');

                    const occurrence = citationKeyCounts.get(compoundKey) || 0;
                    citationKeyCounts.set(compoundKey, occurrence + 1);
                    const ref = `c_${compoundKey}_${occurrence}`;

                    // Build items attribute: "LIB-KEY1:page=P1, LIB-KEY2:page=P2"
                    const itemsAttr = citationItems.map((ci: any) => {
                        const uri = ci.uris?.[0] || '';
                        const key = extractItemKeyFromUri(uri) || 'unknown';
                        const itemId = `${libraryID}-${key}`;
                        const page = ci.locator != null ? String(ci.locator) : '';
                        return page ? `${itemId}:page=${page}` : itemId;
                    }).join(', ');

                    metadata.elements.set(ref, {
                        rawHtml: match,
                        type: 'compound-citation',
                        isCompound: true,
                    });

                    let tag = `<citation items="${escapeAttr(itemsAttr)}"`;
                    tag += ` label="${escapeAttr(label)}"`;
                    tag += ` ref="${ref}"/>`;
                    return tag;
                }
            } catch {
                return match;
            }
        }
    );

    // 6. Simplify math to dollar notation
    // Strip HTML wrappers from math elements, leaving dollar-delimited content.
    // Empty math blocks (`$$$$` / `$$`) are intentionally left as HTML: the
    // expandToRawHtml regex requires non-empty content between `$` delimiters,
    // so simplifying them would break the round-trip (the expander can't
    // rewrap them, and edit_note old_string matching fails).
    // Display math: <pre class="math">$$...$$</pre> → $$...$$
    simplified = simplified.replace(
        /<pre\s+class="math">(\$\$[^<]+\$\$)<\/pre>/g,
        (_match, content) => content
    );
    // Inline math: <span class="math">$...$</span> → $...$
    simplified = simplified.replace(
        /<span\s+class="math">(\$[^<]+\$)<\/span>/g,
        (_match, content) => content
    );

    // 7. Strip the outer wrapper div.
    // Zotero notes are wrapped in <div data-schema-version="N">...</div>.
    // This wrapper is structural metadata, not content the agent should edit.
    // Stripping it prevents the agent from anchoring edits on </div>.
    simplified = stripNoteWrapperDiv(simplified);

    return { simplified, metadata };
}

/**
 * Generate a label for a citation when the visible text is empty/just parentheses.
 * This happens when ProseMirror round-trips citations: the atom node's toDOM
 * regenerates visible text from data-citation attrs, and if itemData is missing
 * (schema v2+ strips it into the container), the output is just "()".
 *
 * Uses Zotero.EditorInstanceUtilities.formatCitation when available (produces
 * "(<span class='citation-item'>Author, Year</span>)"), falling back to a
 * minimal "Author, Year" format from CSL-JSON data.
 */
function generateCitationLabel(citationData: any): string {
    // Try using Zotero's formatter if available
    try {
        const citationItems = citationData.citationItems || [];
        // Ensure each item has itemData — look up from library if missing
        const enriched = citationItems.map((ci: any) => {
            if (ci.itemData) return ci;
            const uri = ci.uris?.[0];
            if (!uri) return ci;
            const itemInfo = (Zotero.URI as any).getURIItemLibraryKey(uri);
            if (!itemInfo) return ci;
            const item = Zotero.Items.getByLibraryAndKey(itemInfo.libraryID, itemInfo.key);
            if (!item) return ci;
            return { ...ci, itemData: Zotero.Utilities.Item.itemToCSLJSON(item) };
        });

        const enrichedCitation = { ...citationData, citationItems: enriched };
        const formatted = Zotero.EditorInstanceUtilities.formatCitation(enrichedCitation);
        // Strip HTML tags from the formatted output
        const text = formatted.replace(/<[^>]+>/g, '').trim();
        if (text && text !== '()') return text;
    } catch {
        // Fall through to manual construction
    }
    return '()';
}

// =============================================================================
// Utility: Count Occurrences
// =============================================================================

export function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}
