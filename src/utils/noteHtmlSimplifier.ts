/**
 * Note HTML Simplifier
 *
 * Converts Zotero note HTML to/from a simplified intermediate format that replaces
 * opaque metadata (citations with URI-encoded JSON, annotation position data,
 * base64 images, data-citation-items caches) with clean semantic tags.
 *
 * This enables LLM agents to edit notes via StrReplace without corrupting metadata.
 */

import { createCitationHTML } from './zoteroUtils';
import { getAttachmentFileStatus } from '../services/agentDataProvider/utils';
import { logger } from './logger';
import { stripBeaverEditFooter, stripBeaverCreatedFooter } from './noteEditFooter';
import type { ExternalReference } from '../../react/types/externalReferences';
import type { ZoteroItemReference } from '../../react/types/zotero';

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
// HTML Normalization (pre-simplification)
// =============================================================================

/**
 * ProseMirror-based normalization: roundtrips HTML through Zotero's note-editor
 * schema to produce the exact same canonical HTML that Zotero's note-editor
 * would produce when loading and saving a note.
 */
import { normalizeNoteHtml } from '../prosemirror/normalize';
export { normalizeNoteHtml };

/**
 * Convert a CSS hex color to rgb()/rgba() notation.
 * Handles 3-digit (#RGB), 4-digit (#RGBA), 6-digit (#RRGGBB), 8-digit (#RRGGBBAA).
 */
export function hexToRgb(hex: string): string {
    const h = hex.replace('#', '');
    let r: number, g: number, b: number, a: number | undefined;

    if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 4) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
        a = parseInt(h[3] + h[3], 16);
    } else if (h.length === 6) {
        r = parseInt(h.substring(0, 2), 16);
        g = parseInt(h.substring(2, 4), 16);
        b = parseInt(h.substring(4, 6), 16);
    } else if (h.length === 8) {
        r = parseInt(h.substring(0, 2), 16);
        g = parseInt(h.substring(2, 4), 16);
        b = parseInt(h.substring(4, 6), 16);
        a = parseInt(h.substring(6, 8), 16);
    } else {
        return hex; // unrecognized format — return as-is
    }

    if (a !== undefined) {
        // Round alpha to 3 decimal places to match browser output
        return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
    }
    return `rgb(${r}, ${g}, ${b})`;
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

/** Escape a string for use as an HTML attribute value */
function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Unescape HTML attribute value */
function unescapeAttr(s: string): string {
    return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Decode HTML entities that ProseMirror normalizes in text content.
 * PM decodes quote/apostrophe entities (&#x27; → ', &quot; → ") but
 * preserves structural entities (&lt;, &gt;, &amp;) since decoding
 * those would create actual markup or bare ampersands.
 *
 * Double-quote entities are only decoded in text segments (outside HTML tags)
 * to avoid corrupting attribute values like title="a &quot;b&quot;" or
 * title="a &#34;b&#34;".
 * Numeric entities other than structural chars and " are decoded globally
 * since they do not change tag boundaries.
 */
export function decodeHtmlEntities(s: string): string {
    const decodeNumericEntities = (segment: string, preserveDoubleQuote: boolean): string => segment
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
            const code = parseInt(hex, 16);
            // Preserve structural HTML characters: & (0x26), < (0x3C), > (0x3E)
            if (code === 0x26 || code === 0x3C || code === 0x3E) return match;
            if (preserveDoubleQuote && code === 0x22) return match;
            return String.fromCodePoint(code);
        })
        .replace(/&#(\d+);/g, (match, dec) => {
            const code = parseInt(dec, 10);
            if (code === 38 || code === 60 || code === 62) return match;
            if (preserveDoubleQuote && code === 34) return match;
            return String.fromCodePoint(code);
        });

    // Decode text and tags separately so quote entities inside attributes stay encoded.
    // split(/(<[^>]*>)/) puts text at even indices, tags at odd indices.
    const parts = s.split(/(<[^>]*>)/);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = decodeNumericEntities(parts[i], false)
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"');
    }
    for (let i = 1; i < parts.length; i += 2) {
        parts[i] = decodeNumericEntities(parts[i], true)
            .replace(/&apos;/g, "'");
    }
    // Note: &lt;, &gt;, &amp; intentionally NOT decoded — PM preserves these
    return parts.join('');
}

/** Entity encoding forms for apostrophe/quote characters */
export type EntityForm = 'hex' | 'decimal' | 'named';
/** All entity forms to try during reverse matching */
export const ENTITY_FORMS: readonly EntityForm[] = ['hex', 'decimal', 'named'];

/**
 * Encode apostrophes and quotes back to HTML entities in text segments.
 * This is the reverse of what PM normalizes: ' → entity and " → entity
 * (only in text content, not inside HTML tags).
 * Used when the model's old_string has literal chars but the note still
 * has entity-encoded forms (before PM normalization).
 *
 * Supports multiple entity spellings (hex, decimal, named) because
 * imported/pasted HTML may use any form:
 *   hex:     &#x27; / &quot;   (most common)
 *   decimal: &#39;  / &#34;
 *   named:   &apos; / &quot;   (HTML5; &quot; is the only named form for ")
 */
export function encodeTextEntities(s: string, form: EntityForm = 'hex'): string {
    const apos = form === 'hex' ? '&#x27;' : form === 'decimal' ? '&#39;' : '&apos;';
    const quot = form === 'hex' ? '&quot;' : form === 'decimal' ? '&#34;' : '&quot;';
    const parts = s.split(/(<[^>]*>)/);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i].replace(/'/g, apos).replace(/"/g, quot);
    }
    return parts.join('');
}

/** Normalize whitespace: collapse runs to single space and trim */
function normalizeWS(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalize inline data-citation payloads by stripping itemData from each
 * citation item. Zotero persists itemData centrally in data-citation-items on
 * the wrapper div, so inline itemData makes equivalent citations fail exact
 * string matching during undo.
 */
function stripInlineItemDataFromDataCitations(html: string): string {
    return html.replace(/data-citation="([^"]*)"/g, (match, encodedCitation) => {
        try {
            const citation = JSON.parse(decodeURIComponent(encodedCitation));
            if (!Array.isArray(citation?.citationItems)) {
                return match;
            }

            let changed = false;
            const citationItems = citation.citationItems.map((ci: any) => {
                if (!ci || typeof ci !== 'object' || !('itemData' in ci)) {
                    return ci;
                }
                changed = true;
                const { itemData: _itemData, ...rest } = ci;
                return rest;
            });

            if (!changed) {
                return match;
            }

            return `data-citation="${encodeURIComponent(JSON.stringify({
                ...citation,
                citationItems,
            }))}"`;
        } catch {
            return match;
        }
    });
}

// =============================================================================
// Page Label Resolution
// =============================================================================

/**
 * Translate a page number string (1-based, as humans see it) to its display label.
 *
 * Only translates strings that are purely numeric page references (digits with
 * optional whitespace/range separators like "-", "–", ","). Non-page locators
 * such as "§3.2", "fn. 5", or "xii" are returned unchanged.
 *
 * Equivalent to react/utils/pageLabels.ts:translatePageNumberToLabel but usable from src/.
 */
export function translatePageNumberToLabel(itemId: number, pageStr: string): string {
    try {
        const cache = Zotero.Beaver?.attachmentFileCache;
        if (!cache) return pageStr;
        const pageLabels = cache.getPageLabelsSync(itemId);
        if (!pageLabels) return pageStr;
        // Only translate strings that look like pure numeric page references
        // (digits, whitespace, range/list separators). Anything else (letters,
        // "§", ".", etc.) means a structured locator — return unchanged.
        if (!/^\s*\d[\d\s,\-–]*$/.test(pageStr)) return pageStr;
        return pageStr.replace(/\d+/g, (numStr) => {
            // Interpret as 1-based page number → 0-based index
            const pageIndex = parseInt(numStr, 10) - 1;
            if (isNaN(pageIndex) || pageIndex < 0) return numStr;
            return pageLabels[pageIndex] ?? numStr;
        });
    } catch {
        return pageStr;
    }
}

/**
 * Find the best PDF attachment for a regular item.
 * Prefers PDF attachments; falls back to the first attachment.
 */
function getBestPDFAttachment(item: any): any {
    try {
        const attachmentIDs = item.getAttachments();
        if (!attachmentIDs || attachmentIDs.length === 0) return null;
        for (const attID of attachmentIDs) {
            const att = Zotero.Items.get(attID);
            if (att && att.attachmentContentType === 'application/pdf') return att;
        }
        return Zotero.Items.get(attachmentIDs[0]) || null;
    } catch {
        return null;
    }
}

/**
 * Pre-load page labels into the in-memory cache for citations in a string
 * that have page attributes. Must be called (and awaited) before expandToRawHtml()
 * so that synchronous translatePageNumberToLabel lookups succeed.
 */
export async function preloadPageLabelsForNewCitations(str: string): Promise<void> {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return;

    const seen = new Set<number>();
    const regex = /<citation\s+([^/]*?)\s*\/>/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(str)) !== null) {
        const attrStr = match[1];
        const pageAttr = extractAttr(attrStr, 'page');
        if (!pageAttr) continue;

        const attIdStr = extractAttr(attrStr, 'att_id') || extractAttr(attrStr, 'attachment_id');
        const itemIdStr = extractAttr(attrStr, 'item_id');

        let attachmentItem: any = null;

        if (attIdStr) {
            const dashIdx = attIdStr.indexOf('-');
            if (dashIdx > 0) {
                const libId = parseInt(attIdStr.substring(0, dashIdx), 10);
                const key = attIdStr.substring(dashIdx + 1);
                if (libId && key) {
                    const item = Zotero.Items.getByLibraryAndKey(libId, key);
                    if (item && item.isAttachment()) {
                        attachmentItem = item;
                    }
                }
            }
        } else if (itemIdStr) {
            const dashIdx = itemIdStr.indexOf('-');
            if (dashIdx > 0) {
                const libId = parseInt(itemIdStr.substring(0, dashIdx), 10);
                const key = itemIdStr.substring(dashIdx + 1);
                if (libId && key) {
                    const item = Zotero.Items.getByLibraryAndKey(libId, key);
                    if (item && typeof item !== 'boolean') {
                        attachmentItem = item.isAttachment() ? item : getBestPDFAttachment(item);
                    }
                }
            }
        }

        if (!attachmentItem || seen.has(attachmentItem.id)) continue;
        seen.add(attachmentItem.id);

        try {
            const filePath = await attachmentItem.getFilePathAsync();
            if (!filePath) continue;
            const record = await cache.getMetadata(attachmentItem.id, filePath);
            if (record) continue;
            await getAttachmentFileStatus(attachmentItem, false);
        } catch {
            // Skip items that can't be resolved
        }
    }
}

// =============================================================================
// Expansion: Simplified → Raw HTML
// =============================================================================

/** Extract a named attribute value from an attribute string */
function extractAttr(attrStr: string, name: string): string | undefined {
    const match = attrStr.match(new RegExp(`(?<![\\w])${name}="([^"]*)"`));
    return match ? unescapeAttr(match[1]) : undefined;
}

/** Parse simplified citation attributes into a structured object */
function parseSimplifiedCitationAttrs(attrStr: string): { item_id: string; page?: string } {
    const item_id = extractAttr(attrStr, 'item_id');
    if (!item_id) {
        throw new Error('Citation must have an item_id attribute.');
    }
    const page = extractAttr(attrStr, 'page');
    return { item_id, page: page || undefined };
}

/** Check if citation attributes have changed */
function attrsChanged(
    original: { item_id: string; page?: string } | undefined,
    current: { item_id: string; page?: string }
): boolean {
    if (!original) return true;
    return original.item_id !== current.item_id || original.page !== current.page;
}

/**
 * Normalize a page locator to a single page number.
 *
 * LLM-generated citations sometimes contain page ranges ("241-243") or
 * comma-separated pages ("222, 237-238"). Zotero's "Go to Page" does an
 * exact string match against PDF page labels, so multi-page locators
 * silently fail to navigate. This extracts the first page number.
 *
 * Only applied to locators that contain range/list separators (-, –, ,).
 * Non-numeric locators like "§3.2", "xii", or "fn. 5" pass through unchanged.
 */
export function normalizePageLocator(page: string): string {
    if (!/[-–,]/.test(page)) return page;
    const match = page.match(/^\s*(\d+)/);
    return match ? match[1] : page;
}

/**
 * Resolve page for a citation, optionally translating 1-based page numbers to labels.
 * @param itemId - Zotero item ID for the attachment (or regular item)
 * @param item - The Zotero item (used to find best PDF attachment for regular items)
 * @param page - Raw page string from the citation attributes
 * @param shouldTranslate - If true, translate 1-based page numbers to labels (for model-provided pages)
 */
function resolvePageForCitation(item: any, page: string | undefined, shouldTranslate: boolean): string | undefined {
    if (!page) return undefined;
    let resolved = normalizePageLocator(page);
    if (shouldTranslate && resolved) {
        if (item.isAttachment()) {
            resolved = translatePageNumberToLabel(item.id, resolved);
        } else {
            const att = getBestPDFAttachment(item);
            if (att) {
                resolved = translatePageNumberToLabel(att.id, resolved);
            }
        }
    }
    return resolved;
}

/** Build a new citation from simplified attributes (item_id format: "LIB-KEY") */
function buildCitationFromSimplifiedAttrs(attrs: { item_id: string; page?: string }, shouldTranslatePage: boolean): string {
    const dashIdx = attrs.item_id.indexOf('-');
    if (dashIdx === -1) {
        throw new Error(`Invalid item_id format: "${attrs.item_id}". Expected "libraryID-itemKey".`);
    }
    const libId = parseInt(attrs.item_id.substring(0, dashIdx), 10);
    const key = attrs.item_id.substring(dashIdx + 1);
    const item = Zotero.Items.getByLibraryAndKey(libId, key);
    if (!item) {
        throw new Error(`Item not found: ${attrs.item_id}`);
    }
    const resolvedPage = resolvePageForCitation(item, attrs.page, shouldTranslatePage);
    return stripInlineItemDataFromDataCitations(createCitationHTML(item, resolvedPage));
}

/**
 * External reference context passed into expandToRawHtml so the citation
 * expander can resolve `<citation external_id="..."/>` (used by chat search
 * tools for non-Zotero works) into something a Zotero note can store.
 *
 * Two-tier fallback:
 *  1. If `externalItemMapping[external_id]` resolves to a Zotero item, the
 *     citation is rewritten as a normal item_id citation (best outcome).
 *  2. Otherwise, an inline `<a href="...">(Author Year)</a>` link is built
 *     from the matching `ExternalReference` metadata.
 *
 * If neither map has any data for the external_id, expansion throws with a
 * helpful message instead of silently dropping the citation.
 */
export interface ExternalRefContext {
    /** source_id → ExternalReference object (title, authors, urls, identifiers, ...) */
    externalRefs: Record<string, ExternalReference>;
    /** source_id → mapped Zotero item, or null if checked but not in library */
    externalItemMapping: Record<string, ZoteroItemReference | null>;
}

/** Format a compact "Author, Year" / "First et al., Year" label for a link. */
function formatCompactAuthorYear(ref: ExternalReference): string {
    const year = ref.year != null
        ? String(ref.year)
        : (ref.publication_date ? ref.publication_date.slice(0, 4) : '');

    const firstAuthor = ref.authors && ref.authors.length > 0 ? ref.authors[0] : '';
    let lastName = '';
    if (firstAuthor) {
        // Author may be "Last, First" or "First Last"
        if (firstAuthor.includes(',')) {
            lastName = firstAuthor.split(',')[0].trim();
        } else {
            const parts = firstAuthor.trim().split(/\s+/);
            lastName = parts[parts.length - 1] || firstAuthor.trim();
        }
    }

    if (lastName && (ref.authors?.length ?? 0) > 1) {
        return year ? `${lastName} et al., ${year}` : `${lastName} et al.`;
    }
    if (lastName) {
        return year ? `${lastName}, ${year}` : lastName;
    }
    return year;
}

/**
 * Pick the best URL for an external reference. Priority: DOI (most stable) →
 * publisher page → generic url → open-access PDF.
 */
function pickExternalRefUrl(ref: ExternalReference): string | undefined {
    const doi = ref.identifiers?.doi;
    if (doi) {
        // DOIs are passed through as-is to https://doi.org — they may contain
        // slashes and parentheses but no characters that need URL encoding
        // beyond what the surrounding attribute escape will handle.
        return `https://doi.org/${doi}`;
    }
    return ref.publication_url || ref.url || ref.open_access_url || undefined;
}

/**
 * Build an inline `<a>` link representing an external reference. Used as the
 * non-Zotero fallback for `<citation external_id="..."/>` so external works
 * still produce something useful in a saved Zotero note.
 *
 * Throws if the reference has no URL or DOI — in that case the model should
 * pick a different source rather than emit a useless bare label.
 */
function buildExternalRefLinkHTML(ref: ExternalReference, page?: string): string {
    const url = pickExternalRefUrl(ref);
    if (!url) {
        throw new Error(
            `Error: External reference "${ref.source_id ?? ''}" has no DOI or URL — `
            + 'cannot embed it in a Zotero note. Omit the citation or pick a different source.'
        );
    }

    let label = formatCompactAuthorYear(ref);
    if (!label) label = ref.title || url;
    if (page) label += `, p. ${page}`;

    // escapeAttr also escapes < > inside text — that's safe for the visible
    // anchor text since the note editor renders the literal characters.
    return `<a href="${escapeAttr(url)}" rel="noopener noreferrer">${escapeAttr(`(${label})`)}</a>`;
}

/** Build a new citation from an attachment ID (att_id format: "LIB-KEY") */
function buildCitationFromAttId(attId: string, page?: string, shouldTranslatePage = true): string {
    const dashIdx = attId.indexOf('-');
    if (dashIdx === -1) {
        throw new Error(`Invalid att_id format: "${attId}". Expected "libraryID-itemKey".`);
    }
    const libId = parseInt(attId.substring(0, dashIdx), 10);
    const key = attId.substring(dashIdx + 1);
    const item = Zotero.Items.getByLibraryAndKey(libId, key);
    if (!item) {
        throw new Error(`Attachment not found: ${attId}`);
    }
    const resolvedPage = resolvePageForCitation(item, page, shouldTranslatePage);
    // createCitationHTML handles attachment-to-parent resolution internally
    return stripInlineItemDataFromDataCitations(createCitationHTML(item, resolvedPage));
}

/**
 * Expand simplified tags in a string back to their raw HTML equivalents.
 * Handles citations, annotations, images, and math dollar notation.
 *
 * @param str - String containing simplified tags (from old_string or new_string)
 * @param metadata - The metadata map from simplification
 * @param context - 'old' for old_string, 'new' for new_string
 * @param externalRefContext - Optional. When provided, citations using
 *   `external_id` (chat-side external work IDs from search tools) are
 *   auto-resolved to a Zotero `item_id` if the work is in the library, or
 *   converted to an inline `<a>` link otherwise. When omitted, `external_id`
 *   citations throw the same "item_id or att_id" error as before.
 */
export function expandToRawHtml(
    str: string,
    metadata: SimplificationMetadata,
    context: 'old' | 'new',
    externalRefContext?: ExternalRefContext,
): string {
    // Expand citations (all self-closing: <citation ... />)
    str = str.replace(
        /<citation\s+([^/]*?)\s*\/>/g,
        (match, attrStr) => {
            const ref = extractAttr(attrStr, 'ref');
            const itemId = extractAttr(attrStr, 'item_id');
            const attId = extractAttr(attrStr, 'att_id');
            const items = extractAttr(attrStr, 'items');
            const externalId = extractAttr(attrStr, 'external_id');

            // Case 1: Existing citation (has ref) — look up from metadata map
            if (ref) {
                const stored = metadata.elements.get(ref);
                if (stored) {
                    // Compound citations are immutable — always return stored raw HTML
                    if (stored.isCompound) {
                        return stored.rawHtml;
                    }
                    // Single citation — check if attributes changed (e.g., page locator updated)
                    if (itemId) {
                        const newAttrs = parseSimplifiedCitationAttrs(attrStr);
                        if (attrsChanged(stored.originalAttrs, newAttrs)) {
                            // For existing citations, never translate the page. The agent
                            // sees and edits page LABELS (from the original locator), not
                            // 1-based page indices. Translation is only for NEW citations
                            // where the agent provides a page index that needs conversion
                            // to a label. Translating here corrupts the locator — e.g.,
                            // label "15" gets treated as 1-based index and converted to
                            // the PDF's physical page label at that index (e.g., "352").
                            return buildCitationFromSimplifiedAttrs(newAttrs, false);
                        }
                    }
                    return stored.rawHtml; // exact original
                }
                // Ref not found in metadata. In old_string context this is always an
                // error — the model must reference existing citations to locate text.
                // In new_string context the model likely fabricated the ref by
                // incrementing from an existing one (e.g. c_KEY_4 → c_KEY_5).
                // Fall through to new-citation handling below.
                if (context === 'old') {
                    throw new Error(
                        `Unknown citation ref="${ref}". Cannot modify citation references not present in the note.`
                    );
                }
                logger(`expandToRawHtml: Unknown ref="${ref}" in new_string — treating as new citation`, 1);
            }

            // Case 2: New citation (no ref, or fabricated ref) — only allowed in new_string
            if (context === 'old') {
                throw new Error(
                    'Error: New citations (without a ref) can only appear in new_string, not old_string. '
                    + 'To reference an existing citation, include its ref attribute.'
                );
            }
            // New citations from the model always use 1-based page numbers → translate
            if (itemId) {
                const attrs = parseSimplifiedCitationAttrs(attrStr);
                return buildCitationFromSimplifiedAttrs(attrs, true);
            }
            if (attId) {
                return buildCitationFromAttId(attId, extractAttr(attrStr, 'page'), true);
            }
            // external_id: chat-side external work ID (e.g. OpenAlex W-id). Two-tier
            // fallback so the model's research effort isn't lost when it tries to
            // cite an external source in a Zotero note.
            if (externalId) {
                const page = extractAttr(attrStr, 'page');

                // Tier 1: auto-resolve to Zotero item if the external work is in
                // the library. Best outcome — produces a real Zotero citation.
                const mappedItemRef = externalRefContext?.externalItemMapping?.[externalId];
                if (mappedItemRef) {
                    const itemIdStr = `${mappedItemRef.library_id}-${mappedItemRef.zotero_key}`;
                    return buildCitationFromSimplifiedAttrs({ item_id: itemIdStr, page }, true);
                }

                // Tier 2: emit an inline hyperlink from the ExternalReference
                // metadata. Lossy compared to a Zotero citation, but matches what a
                // user would type by hand for a non-library work.
                const externalRef = externalRefContext?.externalRefs?.[externalId];
                if (externalRef) {
                    return buildExternalRefLinkHTML(externalRef, page);
                }

                // Tier 3: no data at all — give the model an actionable error
                // instead of the generic "item_id or att_id" message.
                throw new Error(
                    `Error: Citation external_id="${externalId}" not found in this thread's `
                    + 'external reference cache. To cite a Zotero item use item_id="LIB-KEY", '
                    + 'or att_id="LIB-KEY" for a PDF attachment. external_id is only valid '
                    + 'for works returned by a search tool earlier in this thread.'
                );
            }
            if (items) {
                throw new Error(
                    'Error: Cannot create new compound citations. Insert individual <citation item_id="..." /> tags instead.'
                );
            }
            throw new Error('Error: Citation must have an item_id or att_id attribute.');
        }
    );

    // Expand existing annotations (from map — must be unchanged)
    str = str.replace(
        /<annotation id="(a_[^"]+)"[^>]*>([\s\S]*?)<\/annotation>/g,
        (match, id, innerText) => {
            const stored = metadata.elements.get(id);
            if (!stored) {
                throw new Error(`Unknown annotation id="${id}".`);
            }
            // Verify content wasn't modified
            if (normalizeWS(innerText) !== normalizeWS(stored.originalText ?? '')) {
                throw new Error(
                    'Error: Annotation content cannot be modified. You can move or delete annotations but not edit their text.'
                );
            }
            return stored.rawHtml;
        }
    );

    // Expand existing annotation-images (from map — must be unchanged)
    str = str.replace(
        /<annotation-image id="(ai_[^"]+)"[^/]*\/>/g,
        (_match, id) => {
            const stored = metadata.elements.get(id);
            if (!stored) {
                throw new Error(`Unknown annotation-image id="${id}".`);
            }
            return stored.rawHtml;
        }
    );

    // Expand existing images (from map — must be unchanged)
    str = str.replace(
        /<image id="(i_[^"]+)"[^/]*\/>/g,
        (_match, id) => {
            const stored = metadata.elements.get(id);
            if (!stored) {
                throw new Error(`Unknown image id="${id}".`);
            }
            return stored.rawHtml;
        }
    );

    // Preserve math wrappers that already exist in the edited string. Empty
    // placeholders now survive simplification as raw HTML, and the model may
    // keep those wrappers when filling them in. Shield them before the dollar
    // pass so `$...$` / `$$...$$` inside the wrapper doesn't get re-expanded
    // into nested math HTML.
    const preservedMathWrappers: string[] = [];
    const preserveMathWrapper = (wrapper: string): string => {
        const idx = preservedMathWrappers.push(wrapper) - 1;
        return `__BEAVER_RAW_MATH_${idx}__`;
    };
    str = str.replace(
        /<pre\b[^>]*class="math"[^>]*>[\s\S]*?<\/pre>/g,
        preserveMathWrapper
    );
    str = str.replace(
        /<span\b[^>]*class="math"[^>]*>[\s\S]*?<\/span>/g,
        preserveMathWrapper
    );

    // Expand math: dollar notation → Zotero HTML wrappers
    //
    // Pre-processing: when the agent places a standalone equation in its own <p>,
    // it should render as display math (block-level <pre class="math">). Without
    // this, ProseMirror converts the paragraph-wrapped inline math to display math
    // itself, causing empty <p> wrappers and undo data mismatches.
    // <p ...>$$...$$</p> → $$...$$ (unwrap paragraph around display math)
    str = str.replace(
        /<p(?:\s[^>]*)?>(\$\$[^<]+?\$\$)<\/p>/g,
        (_match, content) => content
    );
    // <p ...>$...$</p> → $$...$$ (standalone single-dollar math = display intent)
    str = str.replace(
        /<p(?:\s[^>]*)?>(\s*)\$(?!\$)((?:[^$\\<]|\\.)+?)\$(?!\$)(\s*)<\/p>/g,
        (_match, _ws1, content) => `$$${content}$$`
    );

    // Display math: $$...$$ → <pre class="math">$$...$$</pre>
    str = str.replace(
        /\$\$([\s\S]+?)\$\$/g,
        (match) => `<pre class="math">${match}</pre>`
    );
    // Inline math: $...$ → <span class="math">$...$</span>
    // Rules: not adjacent to another $, content starts/ends with non-whitespace,
    // allows backslash-escaped chars (e.g. \$ for literal dollar in LaTeX)
    str = str.replace(
        /(?<!\$)\$(?!\$)(?=\S)((?:[^$\\]|\\.)+?)(?<=\S)\$(?!\$)/g,
        (match) => `<span class="math">${match}</span>`
    );

    str = str.replace(
        /__BEAVER_RAW_MATH_(\d+)__/g,
        (match, idx) => preservedMathWrappers[Number(idx)] ?? match
    );

    return str;
}

// =============================================================================
// Wrapper Div Handling
// =============================================================================

/**
 * Strip the outer wrapper `<div data-schema-version="N">...</div>` from note HTML.
 *
 * Zotero notes returned by `item.getNote()` / editor `getDataSync()` are wrapped
 * in a single `<div>` (with optional `data-schema-version` and `data-citation-items`
 * attributes). This wrapper is structural metadata — not content the agent should
 * interact with. Stripping it from simplified output prevents the agent from
 * anchoring edits on `</div>`, which causes undo failures.
 *
 * Only strips when the HTML starts with `<div` and ends with `</div>` to avoid
 * accidentally stripping content from fragments or non-note HTML.
 */
export function stripNoteWrapperDiv(html: string): string {
    const trimmed = html.trim();
    // Must start with <div and end with </div>
    if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) {
        return html;
    }
    // Find the end of the opening <div ...> tag
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle === -1) return html;
    // Extract inner content (between opening tag and closing </div>)
    const inner = trimmed.substring(closeAngle + 1, trimmed.length - 6);
    // Only strip if the inner content doesn't have unmatched div nesting
    // (i.e., there's exactly one wrapper div, not nested divs where removing
    // the outer one would break structure)
    const innerDivOpens = (inner.match(/<div[\s>]/g) || []).length;
    const innerDivCloses = (inner.match(/<\/div>/g) || []).length;
    if (innerDivOpens !== innerDivCloses) {
        return html; // Unbalanced inner divs — don't strip
    }
    return inner;
}

/**
 * Check whether the HTML has a root `<div data-schema-version="...">` wrapper element.
 * Only inspects the opening tag of the root element — not arbitrary substrings —
 * so content that merely mentions `data-schema-version` (e.g. code blocks) won't match.
 */
export function hasSchemaVersionWrapper(html: string): boolean {
    const trimmed = html.trim();
    if (!trimmed.startsWith('<div')) return false;
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle === -1) return false;
    const openingTag = trimmed.substring(0, closeAngle + 1);
    return /data-schema-version="/.test(openingTag);
}

// =============================================================================
// data-citation-items Handling
// =============================================================================

/**
 * Strip data-citation-items attribute from the wrapper div.
 */
export function stripDataCitationItems(html: string): string {
    return html.replace(/\s*data-citation-items="[^"]*"/g, '');
}

/**
 * Extract the `data-citation-items` cache from the wrapper div, if present.
 * Returns the parsed array of stored citation items (each with `uris` and
 * `itemData`), or `null` when the attribute is missing or malformed.
 */
export function extractDataCitationItems(html: string): Array<{ uris: string[]; itemData: any }> | null {
    const match = html.match(/data-citation-items="([^"]*)"/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(match[1]));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Rebuild the data-citation-items attribute on the wrapper div.
 *
 * Scans all data-citation attributes in the HTML, collects unique URIs, and
 * resolves itemData for each. When `existingCache` is supplied (the pre-edit
 * cache from the wrapper), itemData is sourced from the cache first and only
 * looked up fresh when a URI is missing from the cache. This preserves
 * itemData for notes whose citations reference items outside the current
 * user's library (shared notes, imported notes, foreign userIDs) where
 * `Zotero.URI.getURIItemLibraryKey` would fail to resolve — without the
 * cache, Zotero's ProseMirror re-serialises those citations as `()`.
 */
export function rebuildDataCitationItems(
    html: string,
    existingCache?: Array<{ uris: string[]; itemData: any }> | null
): string {
    const storedCitationItems: any[] = [];
    const seenUris = new Set<string>();
    const citationAttrRegex = /data-citation="([^"]*)"/g;

    // Build a URI → itemData lookup from the pre-edit cache so we can preserve
    // itemData even when URI resolution fails (e.g. foreign user libraries).
    const cachedByUri = new Map<string, any>();
    if (existingCache) {
        for (const entry of existingCache) {
            if (!entry?.itemData || !Array.isArray(entry.uris)) continue;
            for (const uri of entry.uris) {
                if (!cachedByUri.has(uri)) cachedByUri.set(uri, entry.itemData);
            }
        }
    }

    let attrMatch;
    while ((attrMatch = citationAttrRegex.exec(html)) !== null) {
        try {
            const citation = JSON.parse(decodeURIComponent(attrMatch[1]));
            for (const ci of citation.citationItems || []) {
                const uriKey = ci.uris?.[0];
                if (uriKey && !seenUris.has(uriKey)) {
                    seenUris.add(uriKey);

                    // Prefer the pre-edit cache: it already has correct itemData
                    // for items that may not resolve via URI (foreign libraries).
                    const cachedItemData = cachedByUri.get(uriKey);
                    if (cachedItemData) {
                        storedCitationItems.push({ uris: ci.uris, itemData: cachedItemData });
                        continue;
                    }

                    // Fresh lookup for new citations not in the pre-edit cache.
                    const itemInfo = (Zotero.URI as any).getURIItemLibraryKey(uriKey);
                    if (itemInfo) {
                        const item = Zotero.Items.getByLibraryAndKey(itemInfo.libraryID, itemInfo.key);
                        if (item) {
                            storedCitationItems.push({
                                uris: ci.uris,
                                itemData: Zotero.Utilities.Item.itemToCSLJSON(item)
                            });
                        }
                    }
                }
            }
        } catch {
            // Skip malformed citation attributes
        }
    }

    if (storedCitationItems.length > 0) {
        const encoded = encodeURIComponent(JSON.stringify(storedCitationItems));
        // Insert after the opening <div ... data-schema-version="N" tag
        html = html.replace(
            /(<div\s[^>]*data-schema-version="[^"]*")([^>]*>)/,
            `$1 data-citation-items="${encoded}"$2`
        );
    }

    return html;
}

// =============================================================================
// Validation & Safeguards
// =============================================================================

/**
 * Get the latest note HTML, reading from any open editor to capture
 * unsaved changes. Falls back to item.getNote() if the note is not
 * open or if reading from the editor fails.
 */
export function getLatestNoteHtml(item: any): string {
    const savedHtml = item.getNote();
    try {
        const instances = (Zotero as any).Notes._editorInstances;
        if (!Array.isArray(instances)) return savedHtml;

        const candidates: Array<{
            instance: any;
            html: string;
            source: string;
        }> = [];

        for (const instance of instances) {
            if (!instance._item || instance._item.id !== item.id) continue;
            // Skip instances where saving is disabled (e.g., during diff
            // preview) — their content is not authoritative.
            if (instance._disableSaving) continue;
            try {
                const frameElement = instance._iframeWindow?.frameElement;
                if (frameElement?.isConnected !== true) continue;
                let noteData = instance._iframeWindow.wrappedJSObject.getDataSync(true);
                if (noteData) {
                    // Clone out of XPCOM sandbox wrapper
                    noteData = JSON.parse(JSON.stringify(noteData));
                }
                if (typeof noteData?.html === 'string') {
                    candidates.push({
                        instance,
                        html: noteData.html,
                        source: instance.tabID
                            ? `tab:${instance.tabID}`
                            : (instance.viewMode ?? 'unknown'),
                    });
                }
            } catch {
                continue;
            }
        }

        if (candidates.length === 0) return savedHtml;
        if (candidates.length === 1) return candidates[0].html;

        const selectedTabId = Zotero.getMainWindow?.()?.Zotero_Tabs?.selectedID;
        const preferred = candidates.find((candidate) => (
            selectedTabId
            && candidate.instance.tabID
            && candidate.instance.tabID === selectedTabId
        )) ?? candidates.find((candidate) => candidate.instance.viewMode === 'tab')
            ?? candidates.find((candidate) => candidate.html === savedHtml)
            ?? candidates[0];

        const distinctSnapshots = new Set(candidates.map((candidate) => candidate.html)).size;
        if (distinctSnapshots > 1) {
            logger(
                `getLatestNoteHtml: found ${candidates.length} live editor instances for item ${item.id} `
                + `with ${distinctSnapshots} distinct HTML snapshots; preferring ${preferred.source}`,
                1,
            );
        }

        return preferred.html;
    } catch {
        // Fall through
    }
    return savedHtml;
}

/**
 * Check if a note is currently open in the Zotero editor.
 *
 * Zotero's `_editorInstances` array can contain stale entries: when a note tab
 * is closed, `disconnectedCallback` → `destroy()` runs but never calls
 * `EditorInstance.uninit()`, so the instance stays in the array. We guard
 * against this by also checking that the editor's iframe is still connected
 * to the DOM.
 */
export function isNoteInEditor(itemId: number): boolean {
    try {
        return (Zotero as any).Notes._editorInstances.some(
            (instance: any) => {
                if (!instance._item || instance._item.id !== itemId) return false;
                // Verify the editor is still alive (iframe attached to the DOM)
                try {
                    const frameElement = instance._iframeWindow?.frameElement;
                    return frameElement?.isConnected === true;
                } catch {
                    return false;
                }
            }
        );
    } catch {
        return false;
    }
}

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

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findRefInsensitiveMatchPositions(haystack: string, needle: string): number[] {
    const refAttrRegex = /\bref="[^"]*"/g;
    let pattern = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = refAttrRegex.exec(needle)) !== null) {
        pattern += escapeRegex(needle.substring(lastIndex, match.index));
        pattern += 'ref="[^"]*"';
        lastIndex = match.index + match[0].length;
    }
    pattern += escapeRegex(needle.substring(lastIndex));

    const regex = new RegExp(pattern, 'g');
    const positions: number[] = [];
    while ((match = regex.exec(haystack)) !== null) {
        positions.push(match.index);
    }
    return positions;
}

function findExactSimplifiedRawMatchPosition(
    strippedHtml: string,
    simplified: string,
    oldString: string,
    expandedOld: string,
    metadata: SimplificationMetadata
): number | null {
    const simplifiedMatchPos = simplified.indexOf(oldString);
    if (simplifiedMatchPos === -1) return null;

    if (simplified.indexOf(oldString, simplifiedMatchPos + oldString.length) !== -1) {
        return null;
    }

    try {
        const expandedBefore = expandToRawHtml(
            simplified.substring(0, simplifiedMatchPos), metadata, 'old'
        );
        // Simplified HTML strips the root wrapper div, so map the content-level
        // offset back into the raw note HTML before verifying the match.
        const unwrapped = stripNoteWrapperDiv(strippedHtml);
        const wrapperPrefixLen = unwrapped !== strippedHtml
            ? strippedHtml.indexOf('>') + 1 : 0;
        const candidate = wrapperPrefixLen + expandedBefore.length;
        return strippedHtml.substring(candidate, candidate + expandedOld.length) === expandedOld
            ? candidate
            : null;
    } catch {
        return null;
    }
}

export interface EditTargetContext {
    beforeContext: string;
    afterContext: string;
}

const EDIT_TARGET_CONTEXT_LENGTH = 200;

export function captureValidatedEditTargetContext(
    strippedHtml: string,
    simplified: string,
    oldString: string,
    expandedOld: string,
    metadata: SimplificationMetadata
): EditTargetContext | null {
    const rawPos = findExactSimplifiedRawMatchPosition(
        strippedHtml, simplified, oldString, expandedOld, metadata
    );
    if (rawPos === null) return null;

    return {
        beforeContext: strippedHtml.substring(
            Math.max(0, rawPos - EDIT_TARGET_CONTEXT_LENGTH),
            rawPos
        ),
        afterContext: strippedHtml.substring(
            rawPos + expandedOld.length,
            rawPos + expandedOld.length + EDIT_TARGET_CONTEXT_LENGTH
        ),
    };
}

export function findUniqueRangeByContexts(
    currentHtml: string,
    beforeCtx?: string,
    afterCtx?: string
): { start: number; end: number } | null {
    const hasBefore = beforeCtx != null && beforeCtx.length > 0;
    const hasAfter = afterCtx != null && afterCtx.length > 0;
    let found: { start: number; end: number } | null = null;

    const recordMatch = (start: number, end: number): boolean => {
        if (found && (found.start !== start || found.end !== end)) {
            found = null;
            return false;
        }
        found = { start, end };
        return true;
    };

    if (hasBefore && hasAfter) {
        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            const afterIdx = currentHtml.indexOf(afterCtx!, start);
            if (afterIdx !== -1 && afterIdx >= start && !recordMatch(start, afterIdx)) {
                return null;
            }
            searchFrom = beforeIdx + 1;
        }
        return found;
    }

    if (hasBefore) {
        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            if (!recordMatch(start, currentHtml.length)) {
                return null;
            }
            searchFrom = beforeIdx + 1;
        }
        return found;
    }

    if (hasAfter) {
        let searchFrom = 0;
        while (true) {
            const afterIdx = currentHtml.indexOf(afterCtx!, searchFrom);
            if (afterIdx === -1) break;
            if (!recordMatch(0, afterIdx)) {
                return null;
            }
            searchFrom = afterIdx + 1;
        }
        return found;
    }

    return null;
}

function findUniqueRawPositionByContext(
    currentHtml: string,
    expandedOld: string,
    beforeCtx?: string,
    afterCtx?: string
): number | null {
    const positions = new Set<number>();
    const hasBefore = beforeCtx != null && beforeCtx.length > 0;
    const hasAfter = afterCtx != null && afterCtx.length > 0;

    if (hasBefore && hasAfter) {
        const range = findUniqueRangeByContexts(currentHtml, beforeCtx, afterCtx);
        if (range && currentHtml.substring(range.start, range.end) === expandedOld) {
            positions.add(range.start);
        }
    }

    if (hasBefore) {
        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            if (currentHtml.substring(start, start + expandedOld.length) === expandedOld) {
                positions.add(start);
            }
            searchFrom = beforeIdx + 1;
        }
    }

    if (hasAfter) {
        let searchFrom = 0;
        while (true) {
            const afterIdx = currentHtml.indexOf(afterCtx!, searchFrom);
            if (afterIdx === -1) break;
            const start = afterIdx - expandedOld.length;
            if (start >= 0 && currentHtml.substring(start, afterIdx) === expandedOld) {
                positions.add(start);
            }
            searchFrom = afterIdx + 1;
        }
    }

    return positions.size === 1 ? Array.from(positions)[0] : null;
}

export function findTargetRawMatchPosition(
    currentHtml: string,
    expandedOld: string,
    beforeCtx?: string,
    afterCtx?: string,
): number | null {
    return findUniqueRawPositionByContext(currentHtml, expandedOld, beforeCtx, afterCtx);
}

/**
 * Map a unique simplified old_string match back to its raw HTML position.
 *
 * This is used when the raw HTML fragment is duplicated due to equivalent
 * citations. This helper is intentionally conservative: citation refs are only
 * occurrence counters from the current document order, so ref values alone are
 * not treated as a stable identity signal. Returns null if the match is
 * missing, ambiguous after ref-masking, or cannot be verified against the raw
 * HTML.
 */
export function findUniqueRawMatchPosition(
    strippedHtml: string,
    simplified: string,
    oldString: string,
    expandedOld: string,
    metadata: SimplificationMetadata
): number | null {
    const matchPositions = findRefInsensitiveMatchPositions(simplified, oldString);
    if (matchPositions.length !== 1) {
        return null;
    }
    const simplifiedMatchPos = matchPositions[0];

    try {
        const expandedBefore = expandToRawHtml(
            simplified.substring(0, simplifiedMatchPos), metadata, 'old'
        );
        // Simplified HTML strips the root wrapper div, so map the content-level
        // offset back into the raw note HTML before verifying the match.
        const unwrapped = stripNoteWrapperDiv(strippedHtml);
        const wrapperPrefixLen = unwrapped !== strippedHtml
            ? strippedHtml.indexOf('>') + 1 : 0;
        const candidate = wrapperPrefixLen + expandedBefore.length;
        return strippedHtml.substring(candidate, candidate + expandedOld.length) === expandedOld
            ? candidate
            : null;
    } catch {
        return null;
    }
}


// =============================================================================
// Partial Simplified Element Stripping
// =============================================================================

/** Names of simplified-only elements (tags that don't exist in raw HTML). */
const SIMPLIFIED_ELEMENT_NAMES = /^\/?(citation|annotation-image|annotation|image)\b/;

export interface PartialElementStrip {
    /** old_string with partial element boundary fragments removed */
    strippedOld: string;
    /** new_string with corresponding fragments removed */
    strippedNew: string;
    /** Number of characters stripped from the start of old_string */
    leadingStrip: number;
    /** Number of characters stripped from the end of old_string */
    trailingStrip: number;
}

/**
 * Detect and strip partial simplified-only element fragments at the boundaries
 * of old_string/new_string.
 *
 * When a model crafts old_string from simplified note HTML, it may include a
 * fragment of a simplified element tag at the boundary — e.g. `/>—ein` where
 * `/>` is the tail of a `<citation …/>`. Such fragments don't expand back to
 * raw HTML correctly because `expandToRawHtml` only handles complete tags.
 *
 * This function detects leading/trailing fragments of simplified-only elements
 * (citation, annotation, annotation-image, image) and strips them from both
 * old_string and new_string so the remaining text can be matched in raw HTML.
 *
 * @param oldString   The old_string from the edit request
 * @param newString   The new_string from the edit request
 * @param simplified  The full simplified note HTML
 * @param simplifiedPos  Position of oldString in simplified (from indexOf)
 * @returns Stripped strings and strip offsets, or null if no stripping needed
 */
export function stripPartialSimplifiedElements(
    oldString: string,
    newString: string,
    simplified: string,
    simplifiedPos: number,
): PartialElementStrip | null {
    const matchStart = simplifiedPos;
    const matchEnd = simplifiedPos + oldString.length;
    let leadingStrip = 0;
    let trailingStrip = 0;

    // --- Leading partial element ---
    // Check if matchStart falls inside a simplified-only element tag.
    // Scan backward for an unmatched '<' (one not closed by '>' before matchStart).
    if (matchStart > 0) {
        let openPos = -1;
        for (let i = matchStart - 1; i >= Math.max(0, matchStart - 1500); i--) {
            if (simplified[i] === '>') break;       // Found a close before any open
            if (simplified[i] === '<') { openPos = i; break; }
        }
        if (openPos !== -1) {
            const tagContent = simplified.substring(
                openPos + 1,
                Math.min(openPos + 30, simplified.length),
            );
            if (SIMPLIFIED_ELEMENT_NAMES.test(tagContent)) {
                // Find the tag's closing '>' within old_string
                const closeIdx = simplified.indexOf('>', matchStart);
                if (closeIdx !== -1 && closeIdx < matchEnd) {
                    leadingStrip = closeIdx - matchStart + 1;
                }
            }
        }
    }

    // --- Trailing partial element ---
    // Check if matchEnd falls inside a simplified-only element tag.
    // Scan backward from matchEnd for an unmatched '<' within old_string.
    if (matchEnd < simplified.length) {
        let openPos = -1;
        for (let i = matchEnd - 1; i >= matchStart + leadingStrip; i--) {
            if (simplified[i] === '>') break;
            if (simplified[i] === '<') { openPos = i; break; }
        }
        if (openPos !== -1) {
            const tagContent = simplified.substring(
                openPos + 1,
                Math.min(openPos + 30, simplified.length),
            );
            if (SIMPLIFIED_ELEMENT_NAMES.test(tagContent)) {
                trailingStrip = matchEnd - openPos;
            }
        }
    }

    if (leadingStrip === 0 && trailingStrip === 0) return null;

    const strippedOld = oldString.substring(leadingStrip, oldString.length - trailingStrip);
    if (!strippedOld.trim()) return null;   // Don't strip to empty

    // Apply corresponding stripping to newString:
    // Strip the same leading/trailing fragment if newString shares it.
    let strippedNew = newString;
    if (leadingStrip > 0) {
        const leadingFragment = oldString.substring(0, leadingStrip);
        if (newString.startsWith(leadingFragment)) {
            strippedNew = strippedNew.substring(leadingStrip);
        }
    }
    if (trailingStrip > 0) {
        const trailingFragment = oldString.substring(oldString.length - trailingStrip);
        if (strippedNew.endsWith(trailingFragment)) {
            strippedNew = strippedNew.substring(0, strippedNew.length - trailingStrip);
        }
    }

    return { strippedOld, strippedNew, leadingStrip, trailingStrip };
}


// =============================================================================
// Spurious Wrapping-Tag Stripping
// =============================================================================

export interface WrappingTagStrip {
    strippedOld: string;
    strippedNew: string;
}

/**
 * Generate candidate stripped versions of old_string / new_string where
 * the LLM added a spurious leading opening tag and/or trailing closing tag
 * to produce well-formed HTML.
 *
 * Common pattern: LLM selects text mid-paragraph but prepends `<p>` (or
 * appends `</p>`) to "complete" the element, even though the real tag boundary
 * is elsewhere in the note.  When both old_string and new_string share the
 * same leading (or trailing) tag the addition is cosmetic — stripping it from
 * both preserves the intended edit semantics.
 *
 * Only strips when both strings share the *same* tag at the same position, so
 * intentional tag changes (e.g. `<p>` → `<h3>`) are never affected.
 *
 * Returns candidates in preference order — strip the least amount first to
 * preserve the maximum structural context for matching:
 *   1. Leading-only  (if applicable)
 *   2. Trailing-only (if applicable)
 *   3. Both          (if both are applicable)
 *
 * The caller should try each candidate until one produces a match.
 */
export function stripSpuriousWrappingTags(
    oldString: string,
    newString: string,
): WrappingTagStrip[] {
    // Detect shared leading opening tag
    let leadingTag: string | null = null;
    const leadingMatch = oldString.match(/^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/);
    if (leadingMatch && newString.startsWith(leadingMatch[0])) {
        leadingTag = leadingMatch[0];
    }

    // Detect shared trailing closing tag (+ optional whitespace)
    let oldTrailingMatch: RegExpMatchArray | null = null;
    let newTrailingMatch: RegExpMatchArray | null = null;
    const trailingMatch = oldString.match(/<\/([a-zA-Z][a-zA-Z0-9]*)>\s*$/);
    if (trailingMatch) {
        const tagName = trailingMatch[1];
        const newTrailing = newString.match(new RegExp(`</${tagName}>\\s*$`));
        if (newTrailing) {
            oldTrailingMatch = trailingMatch;
            newTrailingMatch = newTrailing;
        }
    }

    if (!leadingTag && !oldTrailingMatch) return [];

    const candidates: WrappingTagStrip[] = [];

    function addIfNonEmpty(strippedOld: string, strippedNew: string): void {
        if (strippedOld.trim()) {
            candidates.push({ strippedOld, strippedNew });
        }
    }

    // 1. Leading-only
    if (leadingTag) {
        addIfNonEmpty(
            oldString.substring(leadingTag.length),
            newString.substring(leadingTag.length),
        );
    }

    // 2. Trailing-only
    if (oldTrailingMatch && newTrailingMatch) {
        addIfNonEmpty(
            oldString.substring(0, oldString.length - oldTrailingMatch[0].length),
            newString.substring(0, newString.length - newTrailingMatch[0].length),
        );
    }

    // 3. Both (only when both are applicable and would differ from either alone)
    if (leadingTag && oldTrailingMatch && newTrailingMatch) {
        const strippedOld = oldString.substring(leadingTag.length);
        const strippedNew = newString.substring(leadingTag.length);
        // Apply trailing strip to the already leading-stripped strings
        const oldTrailOnStripped = strippedOld.match(
            new RegExp(`</${oldTrailingMatch[1]}>\\s*$`),
        );
        const newTrailOnStripped = strippedNew.match(
            new RegExp(`</${oldTrailingMatch[1]}>\\s*$`),
        );
        if (oldTrailOnStripped && newTrailOnStripped) {
            addIfNonEmpty(
                strippedOld.substring(0, strippedOld.length - oldTrailOnStripped[0].length),
                strippedNew.substring(0, strippedNew.length - newTrailOnStripped[0].length),
            );
        }
    }

    return candidates;
}


// =============================================================================
// Context-Anchored Range Finding
// =============================================================================

/**
 * Find the range in currentHtml bracketed by before/after context strings.
 * Used for context-anchored undo and PM normalization refresh.
 *
 * When `expectedLength` is provided and both anchors are present, all valid
 * (beforeCtx, afterCtx) pairs are evaluated and the one whose range length
 * is closest to `expectedLength` is returned. This disambiguates cases where
 * `beforeCtx` matches non-uniquely (e.g., a shared citation-span suffix
 * repeated across sibling `<li>` elements). Without `expectedLength`, the
 * first valid pair is returned (legacy behavior).
 */
export function findRangeByContexts(
    currentHtml: string,
    beforeCtx?: string,
    afterCtx?: string,
    expectedLength?: number,
): { start: number; end: number } | null {
    const hasBefore = beforeCtx != null && beforeCtx.length > 0;
    const hasAfter = afterCtx != null && afterCtx.length > 0;

    if (hasBefore && hasAfter) {
        let bestStart = -1;
        let bestEnd = -1;
        let bestScore = Number.POSITIVE_INFINITY;

        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            const afterIdx = currentHtml.indexOf(afterCtx!, start);
            if (afterIdx !== -1 && afterIdx >= start) {
                // Without expectedLength, return the first valid pair (legacy).
                if (expectedLength === undefined) {
                    return { start, end: afterIdx };
                }
                const score = Math.abs((afterIdx - start) - expectedLength);
                if (score < bestScore) {
                    bestScore = score;
                    bestStart = start;
                    bestEnd = afterIdx;
                }
            }
            searchFrom = beforeIdx + 1;
        }

        if (bestStart !== -1) {
            return { start: bestStart, end: bestEnd };
        }
    } else if (hasBefore && !hasAfter) {
        // Edit at end of note — beforeCtx anchors the start, end is end-of-string
        const beforeIdx = currentHtml.indexOf(beforeCtx!);
        if (beforeIdx !== -1) {
            return { start: beforeIdx + beforeCtx!.length, end: currentHtml.length };
        }
    } else if (!hasBefore && hasAfter) {
        // Edit at start of note — afterCtx anchors the end, start is 0
        const afterIdx = currentHtml.indexOf(afterCtx!);
        if (afterIdx !== -1) {
            return { start: 0, end: afterIdx };
        }
    }
    return null;
}

// =============================================================================
// ProseMirror Normalization Refresh
// =============================================================================

const PM_REFRESH_INTERVAL_MS = 150;
const PM_REFRESH_MAX_WAIT_MS = 2000;
// After this many polls with no change, assume PM produced identical output and stop.
// 3 polls × 150ms = 450ms — enough headroom for editors to process Notifier events.
const PM_REFRESH_EARLY_EXIT_POLLS = 3;
const PM_UNDO_CONTEXT_LENGTH = 200;

/**
 * Wait for ProseMirror to normalize the note and update undo data in-place.
 *
 * When a note is open in the editor (or in a loaded tab), ProseMirror
 * re-normalizes the HTML after `item.saveTx()` via a Notifier event. This
 * makes the stored `undo_new_html` stale. This function polls `item.getNote()`
 * until the HTML changes (PM processed it) or a timeout elapses, then extracts
 * the actual PM-normalized fragment using context anchors and updates the
 * undoData object in-place before it is returned to the caller.
 *
 * @param preEditStrippedHtml - The stripped HTML before the edit was applied.
 *   When provided, polls where PM still shows this pre-edit state are treated
 *   as "PM hasn't processed the save yet" and do NOT count toward the
 *   early-exit threshold. This prevents a subsequent serialized edit from
 *   reading stale HTML from PM's editor state.
 */
export async function waitForPMNormalization(
    item: any,
    savedStrippedHtml: string,
    undoData: { undo_new_html?: string; undo_before_context?: string; undo_after_context?: string },
    preEditStrippedHtml?: string,
): Promise<void> {
    // Skip only when undo_new_html is truly absent (undefined/null).
    // Empty string ("") is valid — it means a deletion, and we still need
    // to refresh the before/after context anchors after PM normalization.
    if (undoData.undo_new_html == null) return;

    // Only refresh edits that have context anchors.
    // Note: empty string ("") is a valid context (edit at start/end of note),
    // so we check for undefined, not falsy.
    const beforeCtx = undoData.undo_before_context;
    const afterCtx = undoData.undo_after_context;
    if (beforeCtx === undefined && afterCtx === undefined) return;

    let unchangedPolls = 0;

    // Poll until PM changes the HTML or we time out
    for (let elapsed = 0; elapsed < PM_REFRESH_MAX_WAIT_MS; elapsed += PM_REFRESH_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, PM_REFRESH_INTERVAL_MS));

        try {
            const currentHtml = getLatestNoteHtml(item);
            const currentStripped = stripDataCitationItems(currentHtml);

            // If PM still shows the pre-edit HTML, it hasn't processed the
            // save yet.  Keep waiting — do NOT count toward early-exit.
            if (preEditStrippedHtml && currentStripped === preEditStrippedHtml) {
                continue;
            }

            // If HTML still matches what we saved, PM either hasn't processed
            // yet or produced identical output (common for plain-text edits).
            if (currentStripped === savedStrippedHtml) {
                unchangedPolls++;
                if (unchangedPolls >= PM_REFRESH_EARLY_EXIT_POLLS) return;
                continue;
            }

            // HTML changed — PM has normalized. Extract the actual fragment.
            // PM may decode HTML entities (e.g. &#x27; → '), so if anchors
            // don't match, retry with entity-decoded anchors.
            //
            // Pass expectedLength so that when beforeCtx matches non-uniquely
            // (e.g. repeating citation-span suffixes in a list), we pick the
            // (beforeCtx, afterCtx) pair whose range is closest to the original
            // fragment length, rather than always picking the first match which
            // can span many unrelated elements.
            const originalLength = undoData.undo_new_html.length;
            let range = findRangeByContexts(currentStripped, beforeCtx, afterCtx, originalLength);
            if (!range) {
                const decodedBefore = beforeCtx != null ? decodeHtmlEntities(beforeCtx) : undefined;
                const decodedAfter = afterCtx != null ? decodeHtmlEntities(afterCtx) : undefined;
                range = findRangeByContexts(currentStripped, decodedBefore, decodedAfter, originalLength);
            }
            if (!range) {
                logger('waitForPMNormalization: context anchors not found in PM-normalized HTML, skipping refresh', 1);
                return;
            }

            const actualFragment = currentStripped.substring(range.start, range.end);

            // Refresh contexts from the PM-normalized HTML
            const newBeforeCtx = currentStripped.substring(
                Math.max(0, range.start - PM_UNDO_CONTEXT_LENGTH), range.start
            );
            const newAfterCtx = currentStripped.substring(
                range.end, range.end + PM_UNDO_CONTEXT_LENGTH
            );

            // Skip update if nothing actually changed (fragment AND contexts)
            if (
                actualFragment === undoData.undo_new_html
                && newBeforeCtx === undoData.undo_before_context
                && newAfterCtx === undoData.undo_after_context
            ) {
                return;
            }

            // Sanity check: PM normalization changes markup slightly (entities,
            // whitespace, wrappers) but never dramatically alters fragment size.
            // If the refreshed range is much larger than the original, the
            // context anchors were still ambiguous despite the expectedLength
            // hint — bail out and keep the original undo data rather than risk
            // overwriting it with a huge chunk that would cause undo to delete
            // unrelated content.
            const actualLength = actualFragment.length;
            const lengthDelta = actualLength - originalLength;
            if (lengthDelta > 200 && actualLength > originalLength * 2) {
                logger(
                    `waitForPMNormalization: refreshed fragment (${actualLength} chars) much larger `
                    + `than original (${originalLength} chars); keeping original undo data`,
                    1,
                );
                return;
            }

            // Update in-place with PM-normalized data
            undoData.undo_new_html = actualFragment;
            undoData.undo_before_context = newBeforeCtx;
            undoData.undo_after_context = newAfterCtx;

            logger('waitForPMNormalization: updated undo data after PM normalization', 1);
            return;
        } catch (e: any) {
            logger(`waitForPMNormalization: error during poll: ${e?.message || e}`, 1);
            return;
        }
    }
    // Timeout — PM didn't change anything, keep original undo data
}

// =============================================================================
// Post-save stabilization
// =============================================================================

/** Polling interval for stabilization check (ms). */
const STABILIZE_POLL_MS = 50;
/** Number of consecutive unchanged polls before we consider the note stable. */
const STABILIZE_THRESHOLD = 3;
/** Maximum time to wait for stabilization (ms). */
const STABILIZE_MAX_WAIT_MS = 1500;

/**
 * Wait for `item.getNote()` to stop changing after a `saveTx()`.
 *
 * When a note is open in Zotero's editor, `saveTx()` fires a Notifier event.
 * ProseMirror receives it, normalizes the HTML (entity decoding, structural
 * cleanup), and asynchronously saves back the normalized version via
 * `item.setNote()` + `item.saveTx()`.  If another edit saves before this
 * save-back completes, PM's save-back overwrites the second edit.
 *
 * This function polls `item.getNote()` until the value hasn't changed for
 * `STABILIZE_THRESHOLD` consecutive polls (~150 ms of stability), ensuring
 * PM's save-back is complete before the next edit reads the note.
 */
export async function waitForNoteSaveStabilization(
    item: any,
    savedHtml: string,
): Promise<void> {
    let lastHtml = savedHtml;
    let stableCount = 0;

    for (let elapsed = 0; elapsed < STABILIZE_MAX_WAIT_MS; elapsed += STABILIZE_POLL_MS) {
        await new Promise(resolve => setTimeout(resolve, STABILIZE_POLL_MS));

        const currentHtml: string = item.getNote();
        if (currentHtml === lastHtml) {
            stableCount++;
            if (stableCount >= STABILIZE_THRESHOLD) {
                if (currentHtml !== savedHtml) {
                    logger(`waitForNoteSaveStabilization: note was rewritten by editor `
                        + `(saved len=${savedHtml.length}, stabilized len=${currentHtml.length})`, 1);
                }
                return;
            }
        } else {
            logger(`waitForNoteSaveStabilization: note changed at ${elapsed}ms `
                + `(len ${lastHtml.length} → ${currentHtml.length})`, 1);
            lastHtml = currentHtml;
            stableCount = 0;
        }
    }
    logger(`waitForNoteSaveStabilization: timeout after ${STABILIZE_MAX_WAIT_MS}ms, proceeding`, 1);
}
