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
 * Replaces citations, annotations, annotation-images, and regular images
 * with semantic tags, and strips data-citation-items from the wrapper div.
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
    simplified = simplified.replace(
        /<span\s+class="citation"\s+data-citation="([^"]*)">([\s\S]*?)<\/span>/g,
        (match, encodedCitation, visibleContent) => {
            try {
                const citationData = JSON.parse(decodeURIComponent(encodedCitation));
                const citationItems = citationData.citationItems || [];

                if (citationItems.length === 0) {
                    return match; // No citation items — leave unchanged
                }

                // Extract visible text (label) — the full visible content of the citation span
                const label = visibleContent
                    .replace(/<[^>]+>/g, '') // Strip HTML tags (e.g., <span class="citation-item">)
                    .trim();

                if (citationItems.length === 1) {
                    // Single citation
                    const ci = citationItems[0];
                    const uri = ci.uris?.[0] || '';
                    const itemKey = extractItemKeyFromUri(uri) || 'unknown';
                    const itemId = `${libraryID}-${itemKey}`;
                    const page = ci.locator || '';

                    // Content-based ID with occurrence counter
                    const keyForCount = itemKey;
                    const occurrence = citationKeyCounts.get(keyForCount) || 0;
                    citationKeyCounts.set(keyForCount, occurrence + 1);
                    const id = `c_${itemKey}_${occurrence}`;

                    metadata.elements.set(id, {
                        rawHtml: match,
                        type: 'citation',
                        originalAttrs: { item_id: itemId, page: page || undefined },
                    });

                    let tag = `<citation id="${id}" item_id="${itemId}"`;
                    if (page) tag += ` page="${page}"`;
                    tag += ` label="${escapeAttr(label)}"`;
                    tag += '/>';
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
                    const id = `c_${compoundKey}_${occurrence}`;

                    // Build items attribute: "LIB-KEY1:page=P1, LIB-KEY2:page=P2"
                    const itemsAttr = citationItems.map((ci: any) => {
                        const uri = ci.uris?.[0] || '';
                        const key = extractItemKeyFromUri(uri) || 'unknown';
                        const itemId = `${libraryID}-${key}`;
                        const page = ci.locator || '';
                        return page ? `${itemId}:page=${page}` : itemId;
                    }).join(', ');

                    metadata.elements.set(id, {
                        rawHtml: match,
                        type: 'compound-citation',
                        isCompound: true,
                    });

                    let tag = `<citation id="${id}" items="${escapeAttr(itemsAttr)}"`;
                    tag += ` label="${escapeAttr(label)}"`;
                    tag += '/>';
                    return tag;
                }
            } catch {
                return match;
            }
        }
    );

    return { simplified, metadata };
}

/** Escape a string for use as an HTML attribute value */
function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Unescape HTML attribute value */
function unescapeAttr(s: string): string {
    return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// =============================================================================
// Expansion: Simplified → Raw HTML
// =============================================================================

/** Extract a named attribute value from an attribute string */
function extractAttr(attrStr: string, name: string): string | undefined {
    const match = attrStr.match(new RegExp(`${name}="([^"]*)"`));
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

/** Build a new citation from simplified attributes (item_id format: "LIB-KEY") */
function buildCitationFromSimplifiedAttrs(attrs: { item_id: string; page?: string }): string {
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
    return createCitationHTML(item, attrs.page);
}

/** Build a new citation from an attachment ID (att_id format: "LIB-KEY") */
function buildCitationFromAttId(attId: string, page?: string): string {
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
    // createCitationHTML handles attachment-to-parent resolution internally
    return createCitationHTML(item, page);
}

/**
 * Expand simplified tags in a string back to their raw HTML equivalents.
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
            const id = extractAttr(attrStr, 'id');
            const itemId = extractAttr(attrStr, 'item_id');
            const attId = extractAttr(attrStr, 'att_id');
            const items = extractAttr(attrStr, 'items');

            // Case 1: Existing citation (has id) — look up from metadata map
            if (id) {
                const stored = metadata.elements.get(id);
                if (!stored) {
                    throw new Error(
                        `Unknown citation id="${id}". Cannot modify citation references not present in the note.`
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
                        return buildCitationFromSimplifiedAttrs(newAttrs);
                    }
                }
                return stored.rawHtml; // exact original
            }

            // Case 2: New citation (no id) — only allowed in new_string
            if (context === 'old') {
                throw new Error(
                    'Error: New citations (without an id) can only appear in new_string, not old_string. '
                    + 'To reference an existing citation, include its id attribute.'
                );
            }
            if (itemId) {
                const attrs = parseSimplifiedCitationAttrs(attrStr);
                return buildCitationFromSimplifiedAttrs(attrs);
            }
            if (attId) {
                return buildCitationFromAttId(attId, extractAttr(attrStr, 'page'));
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
            const normalizeWS = (s: string) => s.replace(/\s+/g, ' ').trim();
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

    return str;
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
                    const item = Zotero.URI.getURIItem(uriKey);
                    if (item) {
                        storedCitationItems.push({
                            uris: ci.uris,
                            itemData: Zotero.Utilities.Item.itemToCSLJSON(item)
                        });
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
 * Check if a note is currently open in the Zotero editor.
 */
export function isNoteInEditor(itemId: number): boolean {
    try {
        return (Zotero as any).Notes._editorInstances.some(
            (instance: any) => instance._item && instance._item.id === itemId
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

    // Check for new compound citations (items attr without id)
    const compoundRegex = /<citation\s+(?!.*id=)([^/]*items="[^"]*"[^/]*)\/>/g;
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
    const normalizeWS = (s: string) => s.replace(/\s+/g, ' ').trim();

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
    // Find new citations (item_id without id) in new_string
    const newCitationRegex = /<citation\s+(?!id=)[^>]*item_id="([^"]*)"[^/]*\/>/g;
    let match;
    const warnings: string[] = [];

    while ((match = newCitationRegex.exec(newString)) !== null) {
        const newItemId = match[1];
        // Check if any existing citation references the same item
        for (const [existingId, stored] of metadata.elements) {
            if (stored.type === 'citation' && stored.originalAttrs?.item_id === newItemId) {
                warnings.push(
                    ` (Note: item ${newItemId} is already cited in this note as ${existingId}` +
                    ` — if you intended to move the existing citation, use its id attribute instead.)`
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
