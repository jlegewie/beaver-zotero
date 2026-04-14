/**
 * Citation / annotation / math expansion from simplified tags back to raw
 * Zotero note HTML.
 *
 * The simplifier produces tags like `<citation ref="..."/>`,
 * `<annotation id="..."/>`, `<image id="..."/>`, and `$...$` math notation.
 * This module turns them back into the full raw HTML that Zotero's note editor
 * expects (with data-citation payloads, annotation spans, and `<pre
 * class="math">` wrappers).
 *
 * Also owns the citation-building helpers and page-label resolution used
 * exclusively during expansion.
 */

import { createCitationHTML } from './zoteroUtils';
import { getAttachmentFileStatus } from '../services/agentDataProvider/utils';
import { logger } from './logger';
import {
    escapeAttr,
    normalizeWS,
    unescapeAttr,
} from './noteHtmlEntities';
import type { SimplificationMetadata } from './noteHtmlSimplifier';
import type { ExternalReference } from '../../react/types/externalReferences';
import type { ZoteroItemReference } from '../../react/types/zotero';

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

// =============================================================================
// Citation payload helpers
// =============================================================================

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
// Simplified-citation attribute helpers
// =============================================================================

/** Extract a named attribute value from an attribute string */
export function extractAttr(attrStr: string, name: string): string | undefined {
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

// =============================================================================
// External reference fallback
// =============================================================================

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

// =============================================================================
// Expansion: Simplified → Raw HTML
// =============================================================================

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
