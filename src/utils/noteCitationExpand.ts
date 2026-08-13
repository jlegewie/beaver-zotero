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
import { getBestPDFAttachment, getBestPDFAttachmentAsync } from './zoteroItemHelpers';
import { getAttachmentFileStatus, checkLibraryExcluded } from '../services/agentDataProvider/utils';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    escapeAttr,
    normalizeWS,
    unescapeAttr,
} from './noteHtmlEntities';
import {
    buildZoteroCitationLinkHTML,
    isLinkCitationItem,
} from './zoteroLinkCitation';
import type { LocatorSpace, SimplificationMetadata } from './noteHtmlSimplifier';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { PageLabelsByAttachmentId } from '../../react/atoms/citations';
import {
    citationIndexCandidateIdsForLocator,
    getPageLocator,
    normalizeCitationTag,
    parseLoc,
    parseRawCitationAttributes,
    requestedCitationKey,
    type CitationRef,
    type Locator,
} from '@beaver/agent-core/citations/citationGrammar';
import type { StructuredExtractResult } from '@beaver/agent-core/extract/schema';
import { translatePageNumberToLabel } from './pageLabelTranslation';
import {
    modelObjectIdFromReference,
    resolveObjectId,
    UNRESOLVED_LIBRARY_ID,
} from './libraryIdentity';

export { translatePageNumberToLabel } from './pageLabelTranslation';

/**
 * Map of `requestedCitationKey` (e.g. `zotero:1-KEY:s4`) → resolved page string
 * for citations whose locator is a non-page structural locator (sentence,
 * paragraph, heading, …). Native Zotero citations only store page locators, so
 * structural locators are resolved to the page they appear on (via the
 * structured extraction cache) before being stored. Resolve up-front with
 * `preloadStructuralLocatorPages`.
 */
export type ResolvedLocatorPages = Record<string, string>;

export interface StructuralLocatorPreload {
    pages: ResolvedLocatorPages;
    /**
     * `id="LIB-KEY" loc="..."` descriptions of structural locators that could
     * not be mapped to a page (no structured extraction cached, or the locator
     * is not in the document's citation index). Surfaced as a save warning.
     */
    unresolved: string[];
}

// =============================================================================
// Page Label Resolution
// =============================================================================

/**
 * Resolve page labels for citations in a string that carry page locators.
 *
 * Returns a `PageLabelsByAttachmentId` map (attachment item ID → 0-based page
 * index → label). Callers thread the returned map into `expandToRawHtml` so
 * expansion can translate model-provided 1-based page numbers to display
 * labels without reading mutable cache state synchronously.
 *
 * On a metadata cache miss a full extraction is run via
 * `getAttachmentFileStatus`; the freshly written labels are then read back.
 */
export async function preloadPageLabelsForNewCitations(str: string): Promise<PageLabelsByAttachmentId> {
    const labelsByAttachmentId: PageLabelsByAttachmentId = {};
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return labelsByAttachmentId;

    const seen = new Set<number>();
    const regex = /<citation\s+([^/]*?)\s*\/>/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(str)) !== null) {
        const attrStr = match[1];
        const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
        if (!normalized.ok || normalized.ref.kind !== 'zotero' || !getPageLocator(normalized.ref)) continue;
        // A portable ref whose library isn't on this device cannot be looked
        // up (and Zotero throws on the unresolved sentinel); expansion reports
        // the unavailable library with a proper error later.
        if (normalized.ref.library_id === UNRESOLVED_LIBRARY_ID) continue;
        // Skip citations into libraries the user excluded from Beaver — page
        // label preloading would read (and possibly extract) their attachments.
        // Expansion rejects such citations with a proper error.
        if (checkLibraryExcluded(normalized.ref.library_id)) continue;

        let attachmentItem: any = null;
        const item = Zotero.Items.getByLibraryAndKey(normalized.ref.library_id, normalized.ref.zotero_key);
        if (item && typeof item !== 'boolean') {
            attachmentItem = item.isAttachment() ? item : getBestPDFAttachment(item);
        }

        if (!attachmentItem || seen.has(attachmentItem.id)) continue;
        seen.add(attachmentItem.id);

        try {
            const filePath = await attachmentItem.getFilePathAsync();
            if (!filePath) continue;
            let record = await cache.getMetadata({
                libraryId: attachmentItem.libraryID,
                zoteroKey: attachmentItem.key,
            }, filePath);
            if (!record) {
                // Cache miss — run a full extraction, then read labels back.
                await getAttachmentFileStatus(attachmentItem, false);
                record = await cache.getMetadata({
                    libraryId: attachmentItem.libraryID,
                    zoteroKey: attachmentItem.key,
                }, filePath);
            }
            if (record?.pageLabels && Object.keys(record.pageLabels).length > 0) {
                labelsByAttachmentId[attachmentItem.id] = { ...record.pageLabels };
            }
        } catch {
            // Skip items that can't be resolved
        }
    }

    return labelsByAttachmentId;
}

/**
 * Map a non-page (structural) locator to the page it appears on, using the
 * document's structured citation index. Returns the page's display label when
 * available, otherwise the 1-based page number; null when the locator is not
 * indexed.
 */
function resolvePageFromStructuredResult(
    result: StructuredExtractResult,
    locator: Locator,
): string | null {
    const index = result.document.citationIndex ?? {};
    for (const id of citationIndexCandidateIdsForLocator(locator)) {
        const entry = index[id];
        if (!entry || !Number.isInteger(entry.pageIndex) || entry.pageIndex < 0) continue;
        return entry.pageLabel && entry.pageLabel.trim() !== ''
            ? entry.pageLabel
            : String(entry.pageIndex + 1);
    }
    return null;
}

/**
 * Resolve the page for every structural (non-page) citation locator in a
 * string, so expansion can store a page locator instead of dropping the
 * locator. Note citations only support page locators; a `loc="s4"` sentence
 * locator (and paragraph/heading/figure/… locators) is mapped to the page it
 * sits on via the structured extraction cache.
 *
 * Read-only: on a cache miss the locator is reported as unresolved (and the
 * citation is saved without a locator) rather than triggering a full
 * extraction. Callers thread the returned `pages` map into `expandToRawHtml`
 * and surface `unresolved` as a save warning.
 */
export async function preloadStructuralLocatorPages(str: string): Promise<StructuralLocatorPreload> {
    const pages: ResolvedLocatorPages = {};
    const unresolved: string[] = [];
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return { pages, unresolved };

    const seen = new Set<string>();
    const resultsByAttachment = new Map<number, Promise<StructuredExtractResult | null>>();
    const regex = /<citation\s+([^/]*?)\s*\/>/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(str)) !== null) {
        const attrStr = match[1];
        const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
        if (!normalized.ok || normalized.ref.kind !== 'zotero') continue;
        const loc = normalized.ref.loc;
        // Page locators and locator-less citations are handled elsewhere.
        if (!loc || loc.kind === 'page') continue;

        const citationKey = requestedCitationKey(normalized.ref);
        if (seen.has(citationKey)) continue;
        seen.add(citationKey);

        // A portable ref whose library isn't on this device can't be looked
        // up; skip it here rather than misreport it as an unresolved locator —
        // expansion rejects the citation with a proper unavailable-library
        // error.
        if (normalized.ref.library_id === UNRESOLVED_LIBRARY_ID) continue;
        // Skip citations into libraries the user excluded from Beaver — locator
        // resolution would read their cached extractions. Expansion rejects
        // such citations with a proper error.
        if (checkLibraryExcluded(normalized.ref.library_id)) continue;

        const describe = `id="${modelObjectIdFromReference(normalized.ref)}" loc="${loc.raw}"`;
        try {
            const item = Zotero.Items.getByLibraryAndKey(normalized.ref.library_id, normalized.ref.zotero_key);
            // Use the async helper so a regular parent item's child attachments
            // are loaded before lookup — the sync variant calls getAttachments()
            // which throws or returns nothing when childItems is lazily unloaded.
            const attachmentItem = item && typeof item !== 'boolean'
                ? (item.isAttachment() ? item : await getBestPDFAttachmentAsync(item))
                : null;
            if (!attachmentItem) { unresolved.push(describe); continue; }

            let resultPromise = resultsByAttachment.get(attachmentItem.id);
            if (!resultPromise) {
                resultPromise = (async () => {
                    const filePath = await attachmentItem.getFilePathAsync();
                    if (!filePath) return null;
                    const result = await cache.getResult(
                        { libraryId: attachmentItem.libraryID, zoteroKey: attachmentItem.key },
                        'structured',
                        filePath,
                    );
                    return result && result.mode === 'structured' ? result : null;
                })();
                resultsByAttachment.set(attachmentItem.id, resultPromise);
            }
            const result = await resultPromise;
            if (!result) { unresolved.push(describe); continue; }

            const page = resolvePageFromStructuredResult(result, loc);
            if (page == null) { unresolved.push(describe); continue; }
            pages[citationKey] = page;
        } catch {
            unresolved.push(describe);
        }
    }

    return { pages, unresolved };
}

/**
 * Build a non-blocking save warning describing structural locators that could
 * not be mapped to a page (and were therefore stored without a locator).
 * Returns null when nothing was dropped.
 */
export function buildUnresolvedLocatorWarning(unresolved: string[]): string | null {
    if (unresolved.length === 0) return null;
    return `Note citations only support page locators. These structural locators `
        + `could not be mapped to a page and were saved without a locator: `
        + `${unresolved.join('; ')}. They map to a page once the cited document's `
        + `text extraction is available.`;
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
interface SimplifiedCitationAttrs {
    item_id: string;
    /**
     * The locator token exactly as the tag carries it. Recorded verbatim on the
     * stored citation, which is also what the simplifier projects back, so a tag
     * copied out of the note and sent back unchanged compares equal as a string.
     */
    loc?: string;
    /**
     * Zotero's own page locator for `loc`, resolved at write time: a page token
     * as written, or the page a structural token sits on.
     */
    page?: string;
    /** CSL label to store `page` under. Defaults to `page`. */
    cslLabel?: string;
}

/**
 * The locator token a citation tag carries, read with the citation grammar's own
 * attribute precedence so every spelling it accepts is seen here too. A legacy
 * bare `page="5"` is read as the `page5` token the simplifier projects, so both
 * spellings of the same locator compare equal against a stored token.
 */
export function locatorToken(rawAttrs: Record<string, string>): string | undefined {
    const token = rawAttrs.loc
        ?? rawAttrs.sid
        ?? (rawAttrs.page != null ? `page${rawAttrs.page}` : undefined);
    return token || undefined;
}

/**
 * Resolve the page locator to store for a citation ref. Page locators are used
 * as-is; non-page structural locators (sentence/paragraph/…) are substituted
 * with the page pre-resolved from the extraction cache, and stored without a
 * page when they resolve to none.
 */
function resolveLocatorPage(
    ref: CitationRef,
    resolvedLocatorPages?: ResolvedLocatorPages,
): string | undefined {
    const page = getPageLocator(ref);
    if (page) return page;

    if (ref.loc && ref.loc.kind !== 'page' && resolvedLocatorPages) {
        return resolvedLocatorPages[requestedCitationKey(ref)];
    }
    return undefined;
}

function parseSimplifiedCitationAttrs(
    attrStr: string,
    resolvedLocatorPages?: ResolvedLocatorPages,
): SimplifiedCitationAttrs {
    const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
    if (!normalized.ok || normalized.ref.kind !== 'zotero') {
        throw new Error('Citation must have an "id" attribute. Legacy "item_id" / "att_id" are also accepted.');
    }
    const item_id = modelObjectIdFromReference(normalized.ref);
    const loc = locatorToken(normalized.rawAttrs);
    const page = resolveLocatorPage(normalized.ref, resolvedLocatorPages);
    return { item_id, ...(loc ? { loc } : {}), ...(page ? { page } : {}) };
}

/**
 * True when a locator token addresses a page — an absent token included, since a
 * page carried without one is a page as written. False only for a structural
 * token, whose page was substituted from the extraction cache.
 */
function isPageToken(loc: string | undefined): boolean {
    return (parseLoc(loc)?.kind ?? 'page') === 'page';
}

/**
 * Check if citation attributes have changed.
 *
 * Locators are compared as TOKENS, the form both the citation stores and the
 * simplifier projects: a tag copied back verbatim compares equal and keeps the
 * note's raw HTML, and any other token is a locator the model chose.
 */
function attrsChanged(
    original: { item_id: string; loc?: string } | undefined,
    current: SimplifiedCitationAttrs,
): boolean {
    if (!original) return true;
    return original.item_id !== current.item_id
        || (original.loc || undefined) !== (current.loc || undefined);
}

/**
 * Resolve page for a citation, optionally translating 1-based page numbers to labels.
 * @param item - The Zotero item (used to find best PDF attachment for regular items)
 * @param page - Raw page string from the citation attributes
 * @param shouldTranslate - If true, translate 1-based page numbers to labels (for model-provided pages)
 * @param pageLabels - Pre-resolved label map keyed by attachment item ID
 */
function resolvePageForCitation(
    item: any,
    page: string | undefined,
    shouldTranslate: boolean,
    pageLabels?: PageLabelsByAttachmentId,
): string | undefined {
    if (!page) return undefined;
    let resolved = normalizePageLocator(page);
    if (shouldTranslate && resolved) {
        if (item.isAttachment()) {
            resolved = translatePageNumberToLabel(pageLabels?.[item.id] ?? null, resolved);
        } else {
            const att = getBestPDFAttachment(item);
            if (att) {
                resolved = translatePageNumberToLabel(pageLabels?.[att.id] ?? null, resolved);
            }
        }
    }
    return resolved;
}

/**
 * Build the stored citation HTML for a resolved item.
 *
 * Beaver's locator key asserts one thing about the token it carries: that the
 * token counts DOCUMENT positions. So the space of the token being stored is
 * settled here, once, and answers both questions this function asks:
 *
 *  - a structural token (`s56-s59`, `p3`, …) exists only in document space,
 *    whatever the citation stored before, and its page came pre-resolved from
 *    the extraction cache, so it is stored as-is;
 *  - a page token is in the space of the projection the agent wrote it against
 *    (`projectedSpace`): a physical page number when that projection was
 *    document space, translated to the document's printed label before being
 *    stored; otherwise the citation's own printed label, stored as sent.
 *
 * The key is written only for a document-space token. Recording a note-space
 * label under it would relabel that label as a physical page, and the next edit
 * of the citation would translate it — silently changing its numbering mid-life.
 */
function buildCitationHTML(
    item: any,
    attrs: { loc?: string; page?: string; cslLabel?: string },
    projectedSpace: LocatorSpace,
    pageLabels?: PageLabelsByAttachmentId,
): string {
    const pageToken = isPageToken(attrs.loc);
    const isDocumentSpace = !pageToken || projectedSpace === 'document';
    const page = pageToken
        ? resolvePageForCitation(item, attrs.page, isDocumentSpace, pageLabels)
        : attrs.page;
    return stripInlineItemDataFromDataCitations(createCitationHTML(item, page, {
        ...(attrs.cslLabel ? { cslLabel: attrs.cslLabel } : {}),
        ...(attrs.loc && isDocumentSpace ? { beaverLoc: attrs.loc } : {}),
    }));
}

/** Build a new citation from simplified attributes (item_id: portable "u-KEY" / "gGROUP-KEY", or legacy "LIB-KEY") */
function buildCitationFromSimplifiedAttrs(
    attrs: SimplifiedCitationAttrs,
    projectedSpace: LocatorSpace,
    pageLabels?: PageLabelsByAttachmentId,
): string {
    const ref = resolveObjectId(attrs.item_id);
    if (!ref) {
        throw new Error(`Invalid item_id format: "${attrs.item_id}". Expected "libraryID-itemKey".`);
    }
    if (ref.library_id === UNRESOLVED_LIBRARY_ID) {
        throw new Error(`Cannot cite item_id="${attrs.item_id}": its library is not available on this computer.`);
    }
    // Never resolve a citation target in a library the user excluded from
    // Beaver — building the citation would embed the item's metadata.
    const excluded = checkLibraryExcluded(ref.library_id);
    if (excluded) {
        throw new Error(`Cannot cite item_id="${attrs.item_id}": ${excluded.message}`);
    }
    const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${attrs.item_id}`);
    }
    if (isLinkCitationItem(item)) {
        return buildZoteroCitationLinkHTML(item);
    }
    return buildCitationHTML(item, attrs, projectedSpace, pageLabels);
}

/** Build a new citation from an attachment ID (att_id: portable "u-KEY" / "gGROUP-KEY", or legacy "LIB-KEY") */
function buildCitationFromAttId(
    attId: string,
    attrs: { loc?: string; page?: string },
    projectedSpace: LocatorSpace,
    pageLabels?: PageLabelsByAttachmentId,
): string {
    const ref = resolveObjectId(attId);
    if (!ref) {
        throw new Error(`Invalid att_id format: "${attId}". Expected "libraryID-itemKey".`);
    }
    if (ref.library_id === UNRESOLVED_LIBRARY_ID) {
        throw new Error(`Cannot cite att_id="${attId}": its library is not available on this computer.`);
    }
    // Never resolve a citation target in a library the user excluded from
    // Beaver — building the citation would embed the item's metadata.
    const excluded = checkLibraryExcluded(ref.library_id);
    if (excluded) {
        throw new Error(`Cannot cite att_id="${attId}": ${excluded.message}`);
    }
    const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
    if (!item) {
        throw new Error(`Attachment not found: ${attId}`);
    }
    // createCitationHTML handles attachment-to-parent resolution internally
    return buildCitationHTML(item, attrs, projectedSpace, pageLabels);
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
 * `code` set on expansion throws whose recovery is to copy a real
 * `<citation .../>` tag out of the note. Callers detect it to append the
 * note's actual tags to the error (see `buildCitationRefHint`) instead of
 * telling the model to go find them itself.
 */
export const CITATION_REF_NOT_FOUND_CODE = 'citation_ref_not_found';

/** Build an expansion error tagged with `CITATION_REF_NOT_FOUND_CODE`. */
function citationRefNotFoundError(message: string): Error {
    const error = new Error(message);
    (error as Error & { code?: string }).code = CITATION_REF_NOT_FOUND_CODE;
    return error;
}

/** True when `error` was thrown for an old_string citation ref that the note
 *  does not contain. */
export function isCitationRefNotFoundError(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === CITATION_REF_NOT_FOUND_CODE;
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
 *   citations throw the standard missing identity error.
 * @param pageLabels - Optional pre-resolved page-label map (attachment item ID
 *   → 0-based page index → label). Used to translate model-provided 1-based
 *   page numbers into display labels: on NEW citations, and on an existing
 *   citation whose locator the model changed and whose stored token counts
 *   document pages (see `locSpace`). Resolve it up-front via
 *   `preloadPageLabelsForNewCitations`.
 * @param resolvedLocatorPages - Optional pre-resolved pages for non-page
 *   structural locators; see {@link ResolvedLocatorPages}.
 */
export function expandToRawHtml(
    str: string,
    metadata: SimplificationMetadata,
    context: 'old' | 'new',
    externalRefContext?: ExternalRefContext,
    pageLabels?: PageLabelsByAttachmentId,
    resolvedLocatorPages?: ResolvedLocatorPages,
): string {
    // Expand citations (all self-closing: <citation ... />)
    str = str.replace(
        /<citation\s+([^/]*?)\s*\/>/g,
        (match, attrStr) => {
            const ref = extractAttr(attrStr, 'ref');
            const explicitItemId = extractAttr(attrStr, 'item_id');
            const unifiedId = extractAttr(attrStr, 'id');
            const itemId = explicitItemId || unifiedId;
            const attId = extractAttr(attrStr, 'att_id') || extractAttr(attrStr, 'attachment_id');
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
                        const newAttrs = parseSimplifiedCitationAttrs(attrStr, resolvedLocatorPages);
                        if (attrsChanged(stored.originalAttrs, newAttrs)) {
                            // A changed locator is stored in the numbering the
                            // agent was shown it in: a document-space token was
                            // read as a physical page, so a new one is
                            // translated to the document's printed label, while
                            // a note-space one is already a label and is stored
                            // as sent (see `locSpace`).
                            //
                            // A rebuild that leaves the locator token untouched
                            // keeps the citation's CSL label, so retargeting a
                            // `chapter`/`section` citation does not silently
                            // convert it to a page citation. A rebuild that sets
                            // a different token, or that stores the page a
                            // structural token resolves to, is writing a page
                            // locator and takes the default `page` label.
                            const keepsStoredLocator =
                                newAttrs.loc === (stored.originalAttrs?.loc || undefined)
                                && isPageToken(newAttrs.loc);

                            // A locator the projection could not carry survives
                            // a rebuild untouched: the agent was never shown it,
                            // so this edit cannot be changing it. Stored as it
                            // stands — it is the citation's own printed locator,
                            // not a position read off the document.
                            const unprojected = stored.originalAttrs?.cslLocator;
                            if (keepsStoredLocator && newAttrs.loc === undefined && unprojected) {
                                return buildCitationFromSimplifiedAttrs(
                                    { ...newAttrs, page: unprojected, cslLabel: stored.originalAttrs?.cslLabel },
                                    'note',
                                    pageLabels,
                                );
                            }

                            const rebuilt = keepsStoredLocator
                                ? { ...newAttrs, cslLabel: stored.originalAttrs?.cslLabel }
                                : newAttrs;
                            // A citation that projected no locator has no space
                            // of its own: there was nothing for the agent to
                            // copy, so a locator it adds was read off the
                            // document, exactly like one on a new citation.
                            return buildCitationFromSimplifiedAttrs(
                                rebuilt,
                                stored.originalAttrs?.locSpace ?? 'document',
                                pageLabels,
                            );
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
                    throw citationRefNotFoundError(
                        `Citation ref="${ref}" referenced in old_string was not found `
                        + 'in the note\'s existing citations. To reference an existing '
                        + 'citation, copy its full <citation .../> tag (including `ref`) '
                        + 'verbatim from read_note. New citations (without a ref) can only '
                        + 'appear in new_string.'
                    );
                }
                logger(`expandToRawHtml: Unknown ref="${ref}" in new_string — treating as new citation`, 1);
            }

            // Case 2: New citation (no ref, or fabricated ref) — only allowed in new_string
            if (context === 'old') {
                // Quote the offending tag back to the model so the error names
                // which citation in old_string couldn't be resolved. Without
                // this, the validator's `applyOldStringEnrichment` silently
                // no-ops and the model only sees the generic "no ref" message,
                // never learning which identifier was unresolvable.
                const ident = unifiedId
                    ? `id="${unifiedId}"`
                    : explicitItemId
                        ? `item_id="${explicitItemId}"`
                        : attId
                            ? `att_id="${attId}"`
                            : externalId
                                ? `external_id="${externalId}"`
                                : items
                                    ? `items="${items}"`
                                    : 'unknown';
                const locAttr = extractAttr(attrStr, 'loc');
                const pageAttr = extractAttr(attrStr, 'page');
                const locatorStr = locAttr ? ` loc="${locAttr}"` : pageAttr ? ` page="${pageAttr}"` : '';
                throw citationRefNotFoundError(
                    `Citation \`<citation ${ident}${locatorStr}/>\` referenced in old_string `
                    + 'was not found in the note. To reference an existing citation, copy '
                    + 'its full <citation .../> tag (including `ref`) verbatim from '
                    + 'read_note. New citations (without a ref) can only appear in new_string.'
                );
            }
            // New citations from the model always use 1-based page numbers → translate
            const normalizedCitation = normalizeCitationTag(parseRawCitationAttributes(attrStr));
            if (itemId) {
                const attrs = parseSimplifiedCitationAttrs(attrStr, resolvedLocatorPages);
                return buildCitationFromSimplifiedAttrs(attrs, 'document', pageLabels);
            }
            if (attId) {
                // Resolve structural locators on legacy att_id/attachment_id
                // citations the same way as the unified id path.
                const attrs = {
                    loc: locatorToken(normalizedCitation.rawAttrs),
                    page: normalizedCitation.ok
                        ? resolveLocatorPage(normalizedCitation.ref, resolvedLocatorPages)
                        : extractAttr(attrStr, 'page'),
                };
                return buildCitationFromAttId(attId, attrs, 'document', pageLabels);
            }
            if (normalizedCitation.ok && normalizedCitation.ref.kind === 'zotero') {
                const attrs = parseSimplifiedCitationAttrs(attrStr, resolvedLocatorPages);
                return buildCitationFromSimplifiedAttrs(attrs, 'document', pageLabels);
            }
            // external_id: chat-side external work ID (e.g. OpenAlex W-id). Two-tier
            // fallback so the model's research effort isn't lost when it tries to
            // cite an external source in a Zotero note.
            if (externalId) {
                const page = normalizedCitation.ok ? getPageLocator(normalizedCitation.ref) : extractAttr(attrStr, 'page');

                // Tier 1: auto-resolve to Zotero item if the external work is in
                // the library. Best outcome — produces a real Zotero citation.
                const mappedItemRef = externalRefContext?.externalItemMapping?.[externalId];
                if (mappedItemRef) {
                    const itemIdStr = modelObjectIdFromReference(mappedItemRef);
                    const loc = locatorToken(normalizedCitation.rawAttrs);
                    return buildCitationFromSimplifiedAttrs(
                        { item_id: itemIdStr, ...(loc ? { loc } : {}), ...(page ? { page } : {}) },
                        'document',
                        pageLabels,
                    );
                }

                // Tier 2: emit an inline hyperlink from the ExternalReference
                // metadata. Lossy compared to a Zotero citation, but matches what a
                // user would type by hand for a non-library work.
                const externalRef = externalRefContext?.externalRefs?.[externalId];
                if (externalRef) {
                    return buildExternalRefLinkHTML(externalRef, page);
                }

                // Tier 3: no data at all — give the model an actionable error
                // instead of the generic missing identity message.
                throw new Error(
                    `Error: Citation external_id="${externalId}" not found in this thread's `
                    + 'external reference cache. To cite a Zotero item use id="LIB-KEY", '
                    + 'or att_id="LIB-KEY" for a PDF attachment. external_id is only valid '
                    + 'for works returned by a search tool earlier in this thread.'
                );
            }
            if (items) {
                throw new Error(
                    'Error: Cannot create new compound citations. Insert individual <citation id="..." /> tags instead.'
                );
            }
            throw new Error('Error: Citation must have an "id" attribute. Legacy "item_id" / "att_id" are also accepted.');
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

    // Expand self-linking anchor tokens (<link href="X"/>) back to raw anchors.
    // Found in metadata → return the exact stored raw <a> (a verbatim slice of
    // the note, so the matcher's exact strategy succeeds). Not found → a new
    // URL the model wrote in new_string, so reconstruct the canonical anchor.
    // The expanded anchors are shielded behind placeholders so the dollar-math
    // passes below cannot corrupt a URL that contains `$...$`.
    const rawLinkAnchors: string[] = [];
    str = str.replace(
        /<link\s+href="([^"]*)"\s*\/>/g,
        (_match, tokenHref) => {
            const decodedHref = unescapeAttr(tokenHref);
            const stored = metadata.elements.get(`link:${decodedHref}`);
            // For an unknown URL, re-encode the decoded href canonically so the
            // reconstructed anchor matches what normalizeNoteHtml emits — a
            // model-written bare `&` becomes `&amp;`, and a token that already
            // carried `&amp;` is never double-escaped to `&amp;amp;`.
            const escapedHref = escapeAttr(decodedHref);
            const anchor = stored
                ? stored.rawHtml
                : `<a href="${escapedHref}" rel="noopener noreferrer nofollow">${escapedHref}</a>`;
            const idx = rawLinkAnchors.push(anchor) - 1;
            return `__BEAVER_RAW_LINK_${idx}__`;
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

    // Shield code from the dollar-math passes below. A literal `$` inside a
    // <pre>/<code> element (e.g. "$schema" in a JSON block, or shell like
    // $HOME:$PATH) is not math and must stay literal: a normalized Zotero note
    // cannot represent math inside code (codeBlock content is plain text and the
    // `code` mark excludes every other mark), so wrapping such a dollar in a math
    // span makes ProseMirror normalization split the code block and permanently
    // corrupt the note. Shielding code is therefore lossless. Choose a placeholder
    // prefix that does not already occur in the string so a literal copy of the
    // token text in the note can never collide with a real placeholder.
    let codePlaceholderPrefix = '__BEAVER_RAW_CODE_';
    for (let n = 1; str.includes(codePlaceholderPrefix); n++) {
        codePlaceholderPrefix = `__BEAVER_RAW_CODE${n}_`;
    }
    const escapedCodePrefix = codePlaceholderPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const preservedCodeBlocks: string[] = [];
    const preserveCodeBlock = (block: string): string => {
        const idx = preservedCodeBlocks.push(block) - 1;
        return `${codePlaceholderPrefix}${idx}__`;
    };
    // <pre> first so a <code> nested inside an already-masked <pre> isn't masked
    // twice. The class="math" wrappers were masked just above, so these regexes
    // only ever match real code elements. Case-insensitive because HTML tag
    // names are case-insensitive and a model may emit <PRE>/<Code>.
    str = str.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, preserveCodeBlock);
    str = str.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, preserveCodeBlock);

    // Expand math: dollar notation → Zotero HTML wrappers
    //
    // Pre-processing: when the agent places a standalone equation in its own <p>,
    // it should render as display math (block-level <pre class="math">). Without
    // this, ProseMirror converts the paragraph-wrapped inline math to display math
    // itself, causing empty <p> wrappers and undo data mismatches.
    const expandDollarMath = (segment: string): string => {
        // <p ...>$$...$$</p> → $$...$$ (unwrap paragraph around display math)
        segment = segment.replace(
            /<p(?:\s[^>]*)?>(\$\$[^<]+?\$\$)<\/p>/g,
            (_match, content) => content
        );
        // <p ...>$...$</p> → $$...$$ (standalone single-dollar math = display intent)
        segment = segment.replace(
            /<p(?:\s[^>]*)?>(\s*)\$(?!\$)((?:[^$\\<]|\\.)+?)\$(?!\$)(\s*)<\/p>/g,
            (_match, _ws1, content) => `$$${content}$$`
        );

        // Display math: $$...$$ → <pre class="math">$$...$$</pre>
        segment = segment.replace(
            /\$\$([\s\S]+?)\$\$/g,
            (match) => `<pre class="math">${match}</pre>`
        );
        // Inline math: $...$ → <span class="math">$...$</span>
        // Rules: not adjacent to another $, content starts/ends with non-whitespace,
        // allows backslash-escaped chars (e.g. \$ for literal dollar in LaTeX)
        segment = segment.replace(
            /(?<!\$)\$(?!\$)(?=\S)((?:[^$\\]|\\.)+?)(?<=\S)\$(?!\$)/g,
            (match) => `<span class="math">${match}</span>`
        );
        return segment;
    };
    // Run the dollar passes only on the segments between code placeholders. Split
    // with a capturing group so placeholder tokens survive as their own array
    // elements and are left untouched; without this per-segment isolation the
    // inline `[^$\\]` / display `[\s\S]` classes could match a `$...$` or `$$...$$`
    // pair that straddles a masked code block.
    const codeTokenSplit = new RegExp('(' + escapedCodePrefix + '\\d+__)');
    const codeTokenExact = new RegExp('^' + escapedCodePrefix + '\\d+__$');
    str = str
        .split(codeTokenSplit)
        .map((segment) => (codeTokenExact.test(segment) ? segment : expandDollarMath(segment)))
        .join('');

    // Restore masked code elements before the math/link restores below. A masked
    // code block can internally hold __BEAVER_RAW_MATH_n__ or __BEAVER_RAW_LINK_n__
    // placeholders (a plain <pre> may nest a class="math" wrapper or a <link/>
    // token masked in an earlier step), so code must be restored first for those
    // later restores to resolve the now-visible nested placeholders.
    str = str.replace(
        new RegExp(escapedCodePrefix + '(\\d+)__', 'g'),
        (match, idx) => preservedCodeBlocks[Number(idx)] ?? match
    );

    str = str.replace(
        /__BEAVER_RAW_MATH_(\d+)__/g,
        (match, idx) => preservedMathWrappers[Number(idx)] ?? match
    );

    // Restore shielded self-linking anchors (see the <link/> expansion above).
    str = str.replace(
        /__BEAVER_RAW_LINK_(\d+)__/g,
        (match, idx) => rawLinkAnchors[Number(idx)] ?? match
    );

    return str;
}
