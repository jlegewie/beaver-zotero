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

    // Use regex-based approach to avoid DOMParser re-serialization issues.
    // DOMParser + innerHTML can change attribute order, whitespace, and entity encoding.
    let simplified = rawHtml;

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
    // Display math: <pre class="math">$$...$$</pre> → $$...$$
    simplified = simplified.replace(
        /<pre\s+class="math">(\$\$[^<]*\$\$)<\/pre>/g,
        (_match, content) => content
    );
    // Inline math: <span class="math">$...$</span> → $...$
    simplified = simplified.replace(
        /<span\s+class="math">(\$[^<]*\$)<\/span>/g,
        (_match, content) => content
    );

    // 7. Strip Beaver footers — user-facing metadata, not content.
    simplified = stripBeaverEditFooter(simplified);
    simplified = stripBeaverCreatedFooter(simplified);

    // 8. Strip the outer wrapper div.
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
 * &quot; is only decoded in text segments (outside HTML tags) to avoid
 * corrupting attribute values like title="a &quot;b&quot;".
 * Numeric entities and &apos; are decoded globally since ' is safe
 * inside double-quoted attributes.
 */
export function decodeHtmlEntities(s: string): string {
    // Phase 1: Decode numeric entities (except structural: & < >) and &apos;
    let result = s
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
            const code = parseInt(hex, 16);
            // Preserve structural HTML characters: & (0x26), < (0x3C), > (0x3E)
            if (code === 0x26 || code === 0x3C || code === 0x3E) return match;
            return String.fromCodePoint(code);
        })
        .replace(/&#(\d+);/g, (match, dec) => {
            const code = parseInt(dec, 10);
            if (code === 38 || code === 60 || code === 62) return match;
            return String.fromCodePoint(code);
        })
        .replace(/&apos;/g, "'");
    // Note: &lt;, &gt;, &amp; intentionally NOT decoded — PM preserves these

    // Phase 2: Decode &quot; only in text segments (between tags), not in
    // attribute values where bare " would break the markup.
    // split(/(<[^>]*>)/) puts text at even indices, tags at odd indices.
    const parts = result.split(/(<[^>]*>)/);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i].replace(/&quot;/g, '"');
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
 */
export function expandToRawHtml(
    str: string,
    metadata: SimplificationMetadata,
    context: 'old' | 'new'
): string {
    // Expand citations (all self-closing: <citation ... />)
    str = str.replace(
        /<citation\s+([^/]*?)\s*\/>/g,
        (match, attrStr) => {
            const ref = extractAttr(attrStr, 'ref');
            const itemId = extractAttr(attrStr, 'item_id');
            const attId = extractAttr(attrStr, 'att_id');
            const items = extractAttr(attrStr, 'items');

            // Case 1: Existing citation (has ref) — look up from metadata map
            if (ref) {
                const stored = metadata.elements.get(ref);
                if (!stored) {
                    throw new Error(
                        `Unknown citation ref="${ref}". Cannot modify citation references not present in the note.`
                    );
                }
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

            // Case 2: New citation (no ref) — only allowed in new_string
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
 * Rebuild the data-citation-items attribute on the wrapper div.
 * Scans all data-citation attributes in the HTML, collects unique URIs,
 * looks up fresh itemData, and injects as data-citation-items on the wrapper div.
 */
export function rebuildDataCitationItems(html: string): string {
    const storedCitationItems: any[] = [];
    const seenUris = new Set<string>();
    const citationAttrRegex = /data-citation="([^"]*)"/g;

    let attrMatch;
    while ((attrMatch = citationAttrRegex.exec(html)) !== null) {
        try {
            const citation = JSON.parse(decodeURIComponent(attrMatch[1]));
            for (const ci of citation.citationItems || []) {
                const uriKey = ci.uris?.[0];
                if (uriKey && !seenUris.has(uriKey)) {
                    seenUris.add(uriKey);
                    // getURIItem is async (returns a Promise) — use sync equivalents
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
    try {
        const instances = (Zotero as any).Notes._editorInstances;
        if (!Array.isArray(instances)) return item.getNote();
        for (const instance of instances) {
            if (!instance._item || instance._item.id !== item.id) continue;
            try {
                const frameElement = instance._iframeWindow?.frameElement;
                if (frameElement?.isConnected !== true) continue;
                let noteData = instance._iframeWindow.wrappedJSObject.getDataSync(true);
                if (noteData) {
                    // Clone out of XPCOM sandbox wrapper
                    noteData = JSON.parse(JSON.stringify(noteData));
                }
                if (typeof noteData?.html === 'string') {
                    return noteData.html;
                }
            } catch {
                continue;
            }
        }
    } catch {
        // Fall through
    }
    return item.getNote();
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
// Context-Anchored Range Finding
// =============================================================================

/**
 * Find the range in currentHtml bracketed by before/after context strings.
 * Used for context-anchored undo and PM normalization refresh.
 */
export function findRangeByContexts(
    currentHtml: string,
    beforeCtx?: string,
    afterCtx?: string
): { start: number; end: number } | null {
    const hasBefore = beforeCtx != null && beforeCtx.length > 0;
    const hasAfter = afterCtx != null && afterCtx.length > 0;

    if (hasBefore && hasAfter) {
        // Both anchors — bracket the region
        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            const afterIdx = currentHtml.indexOf(afterCtx!, start);
            if (afterIdx !== -1 && afterIdx >= start) {
                return { start, end: afterIdx };
            }
            searchFrom = beforeIdx + 1;
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
 */
export async function waitForPMNormalization(
    item: any,
    savedStrippedHtml: string,
    undoData: { undo_new_html?: string; undo_before_context?: string; undo_after_context?: string }
): Promise<void> {
    if (!undoData.undo_new_html) return;

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
            let range = findRangeByContexts(currentStripped, beforeCtx, afterCtx);
            if (!range) {
                const decodedBefore = beforeCtx != null ? decodeHtmlEntities(beforeCtx) : undefined;
                const decodedAfter = afterCtx != null ? decodeHtmlEntities(afterCtx) : undefined;
                range = findRangeByContexts(currentStripped, decodedBefore, decodedAfter);
            }
            if (!range) {
                logger('waitForPMNormalization: context anchors not found in PM-normalized HTML, skipping refresh', 1);
                return;
            }

            const actualFragment = currentStripped.substring(range.start, range.end);

            // Skip update if the fragment didn't actually change
            if (actualFragment === undoData.undo_new_html) return;

            // Update in-place with PM-normalized data
            undoData.undo_new_html = actualFragment;
            undoData.undo_before_context = currentStripped.substring(
                Math.max(0, range.start - PM_UNDO_CONTEXT_LENGTH), range.start
            );
            undoData.undo_after_context = currentStripped.substring(
                range.end, range.end + PM_UNDO_CONTEXT_LENGTH
            );

            logger('waitForPMNormalization: updated undo_new_html after PM normalization', 1);
            return;
        } catch (e: any) {
            logger(`waitForPMNormalization: error during poll: ${e?.message || e}`, 1);
            return;
        }
    }
    // Timeout — PM didn't change anything, keep original undo data
}
