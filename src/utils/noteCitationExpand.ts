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

import { noteCitationTagPattern } from './noteCitationTags';
import {
    formatExternalFileCitationHTML,
    externalFileLocatorSuffix,
    type ExternalFileCitationData,
} from './externalFileCitation';
import { createCitationHTML, noteCitationHTML, type NoteCitationItemOptions } from './zoteroUtils';
import {
    buildBeaverCitationMeta,
    citationReadback,
    citedChildKey,
    locatorToken,
    readBeaverCitationMeta,
    type CitationReadback,
} from './noteCitationMeta';
import {
    buildAnnotationNoteCitation,
    buildExternalNoteCitation,
    citesPrintedPages,
    rebuildEmbeddedNoteCitation,
} from './noteCitationBuilders';
import { getBestPDFAttachment, getBestPDFAttachmentAsync } from './zoteroItemHelpers';
import { getAttachmentFileStatus, checkLibraryExcluded } from '../services/agentDataProvider/utils';
import { isRemoteFilePath, makeRemoteFilePath } from '../services/documentFileIdentity';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    escapeAttr,
    normalizeWS,
    unescapeAttr,
} from './noteHtmlEntities';
import {
    buildZoteroCitationLinkHTML,
    isLinkCitationItem,
    isStandaloneAttachment,
    parseLinkCitationPageSuffix,
    parseZoteroCitationLinkHref,
    zoteroLinkCitationPattern,
} from './zoteroLinkCitation';
import type { SimplificationMetadata } from './noteHtmlSimplifier';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { PageLabelsByAttachmentId } from '@beaver/agent-core/citations/atoms';
import {
    citationIndexCandidateIdsForLocator,
    getPageLocator,
    isRecordIdRange,
    normalizeCitationTag,
    parseLoc,
    parseRawCitationAttributes,
    requestedCitationKey,
    type CitationRef,
    type Locator,
} from '@beaver/agent-core/citations/citationGrammar';
import type { PageLabels } from '../services/documentCache';
import type { ExternalFileRecord } from '../services/database';
import type { StructuredExtractResult } from '@beaver/agent-core/extract/schema';
import { getCitationIndex } from '../beaver-extract/schema/citationIndex';
import {
    locatorSchemaVersion,
    structuredPdfResultForSchema,
} from '../services/documentExtraction/structuredPdfResult';
import { isCurrentExtractionSchemaVersion, producibleExtractionSchemaVersions } from '../services/documentExtraction/shared/extractionSchemaVersions';
import {
    firstPageNumber,
    formatCitationPages,
    normalizePageLocator,
    translatePageLabelToNumber,
    translatePageNumberToLabel,
} from './pageLabelTranslation';
import { citationItemRefFromUri } from './zoteroUri';
import { isPdfDocument } from './attachmentFiles';
import { ensureLibraryItemsLoaded } from './zoteroDataLoading';
import {
    modelObjectId,
    modelObjectIdFromReference,
    resolveLibraryRef,
    resolveObjectId,
    UNRESOLVED_LIBRARY_ID,
} from './libraryIdentity';

export { normalizePageLocator, translatePageNumberToLabel } from './pageLabelTranslation';

/** The page a structural locator was resolved to, for display and navigation. */
export interface ResolvedLocatorPage {
    /** Display page label stored as the citation's locator; may be a range. */
    label: string;
    /** First physical 1-based page, for links that navigate the reader. */
    page?: number;
}

/**
 * Map of `requestedCitationKey` (e.g. `zotero:1-KEY:s4`) → resolved page for
 * citations whose locator is a non-page structural locator (sentence,
 * paragraph, heading, …). Native Zotero citations only store page locators, so
 * structural locators are resolved to the page they appear on (via the
 * structured extraction cache) before being stored. Resolve up-front with
 * `preloadStructuralLocatorPages`.
 */
export type ResolvedLocatorPages = Record<string, ResolvedLocatorPage>;

export interface StructuralLocatorPreload {
    pages: ResolvedLocatorPages;
    /**
     * `id="LIB-KEY" loc="..."` descriptions of structural locators that could
     * not be mapped to a page (no structured extraction cached, or the locator
     * is not in the document's citation index). Surfaced as a save warning.
     */
    unresolved: string[];
    /**
     * Descriptions of record-id locators whose id scheme names a PDF schema
     * version this plugin cannot produce, so they can never map to a page.
     */
    unavailable: string[];
    /**
     * Descriptions of locators that are not in the cited document's text
     * extraction (a sentence or page past its end, a mistyped id).
     */
    missing: string[];
}

// =============================================================================
// Page Label Resolution
// =============================================================================

/**
 * Load the libraries that citations in the given texts point to, plus any
 * extra library ids (typically the note's own library).
 *
 * Citation expansion, validation and simplification resolve cited items with
 * synchronous Zotero lookups, which throw for items in a library that has not
 * been opened this session. Await this before those synchronous passes.
 * Covers simplified `<citation .../>` tags, `data-citation` URIs and Zotero
 * link citations, including the items of compound tags read from a note.
 * Unavailable libraries are skipped. Excluded libraries are skipped too
 * (expansion rejects those citations) unless `includeExcluded` is set for
 * render paths, which must keep showing persisted history.
 * `externalItemMapping` adds the library of every `external_id` citation that
 * maps to a library item, since expansion cites that item instead.
 * Returns the ids of the libraries this call loaded.
 */
export async function ensureCitedLibrariesLoaded(
    texts: (string | null | undefined)[],
    extraLibraryIds: (number | null | undefined)[] = [],
    { includeExcluded = false, externalItemMapping }: {
        includeExcluded?: boolean;
        externalItemMapping?: Record<string, ZoteroItemReference | null>;
    } = {},
): Promise<number[]> {
    const libraryIds = new Set<number>();
    const add = (libraryId: number | null | undefined) => {
        if (typeof libraryId !== 'number' || libraryId === UNRESOLVED_LIBRARY_ID) return;
        if (!includeExcluded && checkLibraryExcluded(libraryId)) return;
        libraryIds.add(libraryId);
    };
    extraLibraryIds.forEach(add);

    for (const text of texts) {
        if (!text) continue;
        const tagRegex = noteCitationTagPattern();
        let match: RegExpExecArray | null;
        while ((match = tagRegex.exec(text)) !== null) {
            const attrs = parseRawCitationAttributes(match[1]);
            const normalized = normalizeCitationTag(attrs);
            if (normalized.ok && normalized.ref.kind === 'zotero') add(normalized.ref.library_id);
            if (normalized.ok && normalized.ref.kind === 'external') {
                const mapped = externalItemMapping?.[normalized.ref.external_id];
                if (mapped) add(resolveLibraryRef(mapped));
            }
            // Compound tags list their items as "id:page,id:page".
            for (const entry of attrs.items?.split(',') ?? []) {
                add(resolveObjectId(entry.trim().split(':')[0])?.library_id);
            }
        }
        for (const link of text.matchAll(zoteroLinkCitationPattern())) {
            const parsed = parseZoteroCitationLinkHref(link[3]);
            if (parsed) add(parsed.libraryId);
        }
        for (const citation of text.matchAll(/data-citation="([^"]*)"/g)) {
            try {
                const citationData = JSON.parse(decodeURIComponent(citation[1]));
                for (const ci of citationData.citationItems || []) {
                    const uri = ci?.uris?.[0];
                    if (!uri) continue;
                    const info = (Zotero.URI as any).getURIItemLibraryKey(uri);
                    if (info) add(info.libraryID);
                }
            } catch {
                // Malformed citation metadata is reported by the simplifier.
            }
        }
    }

    return ensureLibraryItemsLoaded(libraryIds);
}

/**
 * The document-cache key for an attachment: its local file, or the remote key
 * of a sync-backed attachment with no local copy. Remote-only documents are
 * read from the cache only; preloads never download them.
 */
async function attachmentCacheFilePath(attachmentItem: any): Promise<{ filePath: string; isRemoteOnly: boolean }> {
    const localFilePath = await attachmentItem.getFilePathAsync();
    const filePath = localFilePath || makeRemoteFilePath(attachmentItem);
    return { filePath, isRemoteOnly: !localFilePath || isRemoteFilePath(filePath) };
}

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
 * Remote-only attachments use cached labels only.
 */
export async function preloadPageLabelsForNewCitations(str: string): Promise<PageLabelsByAttachmentId> {
    const labelsByAttachmentId: PageLabelsByAttachmentId = {};
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return labelsByAttachmentId;
    await ensureCitedLibrariesLoaded([str]);

    const seen = new Set<number>();
    const regex = noteCitationTagPattern();
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
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(normalized.ref.library_id, normalized.ref.zotero_key);
            if (item) {
                attachmentItem = item.isAttachment() ? item : await getBestPDFAttachmentAsync(item);
            }
        } catch {
            // Expansion reports items that cannot be resolved.
        }

        if (!attachmentItem || seen.has(attachmentItem.id)) continue;
        seen.add(attachmentItem.id);

        try {
            const { filePath, isRemoteOnly } = await attachmentCacheFilePath(attachmentItem);
            let record = await cache.getMetadata({
                libraryId: attachmentItem.libraryID,
                zoteroKey: attachmentItem.key,
            }, filePath);
            if (!record && !isRemoteOnly) {
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
 * Whether an item exists, loading it if needed. Zotero returns a plain `false`
 * (not a promise) for a key it does not know, and the lookup can throw.
 */
async function itemExists(libraryID: number, key: string): Promise<boolean> {
    try {
        return !!(await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key));
    } catch {
        return false;
    }
}

/**
 * Load cached page labels for citations already stored in a raw Zotero note,
 * both native ones and the plain links used for standalone attachments.
 *
 * This path is cache-first. Warm-cache reads only consult `documentCache`
 * metadata; callers can opt into local metadata seeding on a cache miss when
 * agent-facing note simplification needs read/edit views to resolve page
 * locators consistently. Remote-only attachments stay cache-only unless
 * `allowRemoteDownloads` is explicitly enabled.
 * The returned map is keyed by the simplifier's model-facing item id (see
 * `modelObjectId`).
 */
export async function preloadNotePageLabels(
    rawHtml: string,
    libraryID: number,
    {
        extractOnCacheMiss = false,
        allowRemoteDownloads = false,
    }: { extractOnCacheMiss?: boolean; allowRemoteDownloads?: boolean } = {},
): Promise<Record<string, PageLabels>> {
    const labelsByItemId: Record<string, PageLabels> = {};
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return labelsByItemId;
    await ensureCitedLibrariesLoaded([rawHtml], [libraryID]);

    const seen = new Set<string>();
    // Keyed with the simplifier's portable item id so lookups in
    // `simplifyNoteHtml` (which builds the same id via `modelObjectId`)
    // resolve to the labels seeded here.
    const loadLabels = async (targetLibraryID: number, itemKey: string): Promise<void> => {
        const itemId = modelObjectId(targetLibraryID, itemKey);
        if (seen.has(itemId)) return;
        seen.add(itemId);
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(targetLibraryID, itemKey);
            const attachmentItem = item
                ? (item.isAttachment() ? item : await getBestPDFAttachmentAsync(item))
                : null;
            if (!attachmentItem) return;

            const { filePath, isRemoteOnly } = await attachmentCacheFilePath(attachmentItem);
            let record = await cache.getMetadata({
                libraryId: attachmentItem.libraryID,
                zoteroKey: attachmentItem.key,
            }, filePath);
            if (!record && extractOnCacheMiss && (!isRemoteOnly || allowRemoteDownloads)) {
                await getAttachmentFileStatus(attachmentItem, false);
                record = await cache.getMetadata({
                    libraryId: attachmentItem.libraryID,
                    zoteroKey: attachmentItem.key,
                }, filePath);
            }
            if (record?.pageLabels && Object.keys(record.pageLabels).length > 0) {
                labelsByItemId[itemId] = { ...record.pageLabels };
            }
        } catch {
            // Skip attachments whose file or metadata cannot be read.
        }
    };

    const regex = /data-citation="([^"]*)"/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(rawHtml)) !== null) {
        try {
            const citationData = JSON.parse(decodeURIComponent(match[1]));
            const citationItems = citationData.citationItems || [];
            for (const ci of citationItems) {
                const locator = ci?.locator != null ? String(ci.locator) : '';
                if (!locator || (ci?.label != null && ci.label !== 'page')) continue;

                // Resolved the same way as the simplifier, so the cited item's
                // own library keys (and loads) the labels.
                const itemRef = citationItemRefFromUri(ci?.uris?.[0] || '', libraryID);
                if (!itemRef || checkLibraryExcluded(itemRef.libraryID)) continue;

                // A single citation with Beaver metadata reads back as the
                // simplifier shows it: with the locator Beaver recorded (no
                // labels needed), or with its stored page under the id of the
                // cited child or the item.
                let readback: CitationReadback | null = null;
                if (citationItems.length === 1) {
                    const childKey = citedChildKey(readBeaverCitationMeta(ci));
                    const childExists = childKey ? await itemExists(itemRef.libraryID, childKey) : false;
                    readback = citationReadback(ci, () => childExists);
                }
                if (readback && readback.loc !== null) continue;
                await loadLabels(itemRef.libraryID, readback?.childKey ?? itemRef.key);
            }
        } catch {
            // Skip malformed citation metadata or attachments that can't load.
        }
    }

    // Link citations (standalone attachments) carry no `data-citation`, so their
    // labels have to come from the link itself. Without them the simplifier
    // cannot translate the stored label into the physical page number the agent
    // writes, and a later locator edit would be read in the wrong convention.
    // The link names its own library, which need not be the note's.
    for (const link of rawHtml.matchAll(zoteroLinkCitationPattern())) {
        const [, openParen, , rawHref, rawSuffix, closeParen] = link;
        // Only the wrapped form carries a locator into the simplified citation.
        if (!openParen || !closeParen) continue;
        if (parseLinkCitationPageSuffix(rawSuffix) === null) continue;
        const parsed = parseZoteroCitationLinkHref(rawHref);
        // Reading an excluded library's cached extraction is off limits; the
        // citation still renders, only its locator convention is left as stored.
        if (!parsed || checkLibraryExcluded(parsed.libraryId)) continue;
        await loadLabels(parsed.libraryId, parsed.itemKey);
    }

    return labelsByItemId;
}

/**
 * Map a non-page (structural) locator to the page it appears on, using the
 * document's structured citation index. The label is the page's display label
 * when available, otherwise the 1-based page number; null when the locator is
 * not indexed. With `includeRange`, every page the locator names is kept; they
 * read as one first–last span only when the locator is a contiguous run, so a
 * sentence list that skips pages (`s2.1,s9.1`) reads "2, 9".
 */
function resolvePageFromStructuredResult(
    result: StructuredExtractResult,
    locator: Locator,
    includeRange = false,
): ResolvedLocatorPage | null {
    const index = getCitationIndex(result.document);
    const pages: number[] = [];
    const labels: PageLabels = {};
    for (const id of citationIndexCandidateIdsForLocator(locator)) {
        const entry = index[id];
        if (!entry || !Number.isInteger(entry.pageIndex) || entry.pageIndex < 0) continue;
        pages.push(entry.pageIndex + 1);
        if (entry.pageLabel) labels[entry.pageIndex] = entry.pageLabel;
        if (!includeRange) break;
    }
    const label = formatCitationPages(pages, labels, {
        inclusiveRange: includeRange && isRecordIdRange(locator),
    });
    // The physical page is kept alongside the label: a label cannot be
    // translated back once the extraction result is out of scope, and link
    // citations navigate the reader by physical page.
    return label ? { label, page: Math.min(...pages) } : null;
}

/**
 * Resolve the page for every structural (non-page) citation locator in a
 * string, so expansion can give the citation a page. Zotero shows note
 * citations with page locators only; a `loc="s4"` sentence locator (and
 * paragraph/heading/figure/… locators) is mapped to the page it sits on via
 * the structured extraction cache. The locator itself is kept in the
 * citation's private metadata either way.
 *
 * Locators resolve against the PDF schema version their id scheme names (see
 * `pdfSchemaVersionForLocator`). The current version is read from the cache,
 * and a local file is extracted on a miss; a remote-only file is never
 * downloaded, so its locator is reported as unresolved (and the citation shows
 * no page). A producible non-current version is extracted on demand without
 * the cache. Callers
 * thread the returned `pages` map into `expandToRawHtml` and surface
 * `unresolved` as a save warning.
 * External-file links use the same cached page lookup, but retain their
 * structural locator when no page is available instead of dropping it.
 */
export async function preloadStructuralLocatorPages(str: string): Promise<StructuralLocatorPreload> {
    const pages: ResolvedLocatorPages = {};
    const unresolved: string[] = [];
    const unavailable: string[] = [];
    const missing: string[] = [];
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return { pages, unresolved, unavailable, missing };
    await ensureCitedLibrariesLoaded([str]);

    const seen = new Set<string>();
    // Keyed by attachment (or external file) and schema version.
    const resultsByAttachment = new Map<string, Promise<StructuredExtractResult | null>>();
    const resultsByExternalFile = new Map<string, Promise<StructuredExtractResult | null>>();
    const externalFileRecords = new Map<string, Promise<ExternalFileRecord | null | undefined>>();
    const regex = noteCitationTagPattern();
    let match: RegExpExecArray | null;

    while ((match = regex.exec(str)) !== null) {
        const attrStr = match[1];
        const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
        if (!normalized.ok) continue;
        const loc = normalized.ref.loc;
        // Page locators and locator-less citations are handled elsewhere.
        if (!loc || loc.kind === 'page') continue;

        const citationKey = requestedCitationKey(normalized.ref);
        if (seen.has(citationKey)) continue;
        seen.add(citationKey);

        if (normalized.ref.kind === 'external_file') {
            const key = normalized.ref.ext_key;
            try {
                let recordPromise = externalFileRecords.get(key);
                if (!recordPromise) {
                    recordPromise = Promise.resolve(Zotero.Beaver?.db?.getExternalFileByKey(key));
                    externalFileRecords.set(key, recordPromise);
                }
                const record = await recordPromise;
                const schemaVersion = locatorSchemaVersion(loc, record?.contentKind === 'pdf');
                const resultKey = `${key}:${schemaVersion}`;
                let resultPromise = resultsByExternalFile.get(resultKey);
                if (!resultPromise) {
                    resultPromise = (async () => {
                        if (!record?.storedPath) return null;
                        const { EXTERNAL_LIBRARY_ID } = await import('../services/externalFiles');
                        return structuredPdfResultForSchema({
                            source: {
                                kind: 'external',
                                filePath: record.storedPath,
                                itemRef: { id: 0, libraryID: EXTERNAL_LIBRARY_ID, key },
                            },
                            filePath: record.storedPath,
                            schemaVersion,
                        });
                    })();
                    resultsByExternalFile.set(resultKey, resultPromise);
                }
                const result = await resultPromise;
                const resolved = result && resolvePageFromStructuredResult(result, loc, true);
                if (resolved) pages[citationKey] = resolved;
            } catch {
                // File links retain their structural locator when cached pages are unavailable.
            }
            continue;
        }
        if (normalized.ref.kind !== 'zotero') continue;

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
        // Only a PDF citation shows a page, so only there is a locator that
        // could not be mapped to one worth a warning.
        let citesPdf = true;
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(normalized.ref.library_id, normalized.ref.zotero_key);
            // Use the async helper so a regular parent item's child attachments
            // are loaded before lookup — the sync variant calls getAttachments()
            // which throws or returns nothing when childItems is lazily unloaded.
            const attachmentItem = item && typeof item !== 'boolean'
                ? (item.isAttachment() ? item : await getBestPDFAttachmentAsync(item))
                : null;
            if (!attachmentItem) { unresolved.push(describe); continue; }
            citesPdf = isPdfDocument(attachmentItem);

            const schemaVersion = locatorSchemaVersion(loc, citesPdf);
            if (!producibleExtractionSchemaVersions('pdf').includes(schemaVersion)) {
                unavailable.push(describe);
                continue;
            }
            const resultKey = `${attachmentItem.id}:${schemaVersion}`;
            let resultPromise = resultsByAttachment.get(resultKey);
            if (!resultPromise) {
                resultPromise = (async () => {
                    const { filePath, isRemoteOnly } = await attachmentCacheFilePath(attachmentItem);
                    // A local PDF is extracted when its result is not cached
                    // (evicted, or read on another computer and served from
                    // the backend's cache). Other documents are never run
                    // through the PDF extractor, and a remote-only file is
                    // never downloaded: the current version is a cache read,
                    // older ones are unavailable.
                    if (isRemoteOnly && !isCurrentExtractionSchemaVersion('pdf', schemaVersion)) return null;
                    return structuredPdfResultForSchema({
                        source: { kind: 'zotero', item: attachmentItem },
                        filePath,
                        schemaVersion,
                        extractOnMiss: !isRemoteOnly && citesPdf,
                    });
                })();
                resultsByAttachment.set(resultKey, resultPromise);
            }
            const result = await resultPromise;
            const resolved = result && resolvePageFromStructuredResult(result, loc, isStandaloneAttachment(item));
            if (resolved) pages[citationKey] = resolved;
            else if (citesPdf) (result ? missing : unresolved).push(describe);
        } catch {
            if (citesPdf) unresolved.push(describe);
        }
    }

    return { pages, unresolved, unavailable, missing };
}

/**
 * Build a non-blocking save warning describing structural locators that could
 * not be mapped to a page (and were therefore stored without a locator).
 * Returns null when nothing was dropped.
 */
export function buildUnresolvedLocatorWarning(
    unresolved: string[],
    unavailable: string[] = [],
    missing: string[] = [],
): string | null {
    if (unresolved.length === 0 && unavailable.length === 0 && missing.length === 0) return null;
    let warning = 'Zotero shows note citations with page numbers only.';
    if (unresolved.length > 0) {
        warning += ` These structural locators could not be mapped to a page, so their `
            + `citations show no page number: ${unresolved.join('; ')}. They map to a page once `
            + `the cited document's text extraction is available.`;
    }
    if (unavailable.length > 0) {
        warning += ` These locators come from a version of the document's text that `
            + `can't be loaded, so their citations show no page number: `
            + `${unavailable.join('; ')}. Re-read the cited pages and use the locators `
            + `shown there.`;
    }
    if (missing.length > 0) {
        warning += ` These locators are not in the cited document, so their citations show `
            + `no page number: ${missing.join('; ')}. Re-read the cited pages and use the `
            + `locators shown there.`;
    }
    return warning;
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
    page?: string;
    pageConvention?: 'number' | 'label';
    cslLabel?: string;
    /**
     * True when `page` was resolved from a structural locator and is already a
     * final page label — `buildCitation` must store it
     * verbatim and skip the 1-based-page-number → label translation.
     */
    pageIsResolvedLabel?: boolean;
    /**
     * Physical 1-based page behind `page`, carried alongside a resolved label
     * so link citations can still navigate the reader to it.
     */
    navPage?: number;
    /** The locator as written, recorded in the citation's private metadata. */
    loc?: Locator;
}

/**
 * Resolve the page locator to store for a citation ref. Page locators are used
 * as-is; non-page structural locators (sentence/paragraph/…) are substituted
 * with the page pre-resolved from the extraction cache. `pageIsResolvedLabel`
 * marks a substituted page so callers skip the 1-based-number → label
 * translation (the resolved value is already a final page label).
 */
function resolveLocatorPageAttr(
    ref: CitationRef,
    resolvedLocatorPages?: ResolvedLocatorPages,
): { page?: string; pageIsResolvedLabel?: boolean; navPage?: number } {
    const page = getPageLocator(ref);
    if (page) return { page };

    if (ref.loc && ref.loc.kind !== 'page' && resolvedLocatorPages) {
        const resolved = resolvedLocatorPages[requestedCitationKey(ref)];
        if (resolved) return { page: resolved.label, pageIsResolvedLabel: true, navPage: resolved.page };
    }
    return {};
}

function parseSimplifiedCitationAttrs(
    attrStr: string,
    resolvedLocatorPages?: ResolvedLocatorPages,
): SimplifiedCitationAttrs {
    const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
    if (normalized.ok && normalized.ref.kind === 'external_file') {
        throw citationRefNotFoundError('External-file references are stored as links or plain text in notes. Copy the existing link or text from read_note into old_string.');
    }
    if (!normalized.ok && normalized.reason === 'invalid_zotero_id') {
        throw new Error(`Invalid citation id "${normalized.rawIdentity ?? ''}". Expected "libraryID-itemKey", as returned by search and read tools.`);
    }
    if (!normalized.ok || normalized.ref.kind !== 'zotero') {
        throw new Error('Citation must have an "id" attribute. Legacy "item_id" / "att_id" are also accepted.');
    }
    const item_id = modelObjectIdFromReference(normalized.ref);
    const { page, pageIsResolvedLabel, navPage } = resolveLocatorPageAttr(normalized.ref, resolvedLocatorPages);
    return {
        item_id,
        ...(page ? { page, pageIsResolvedLabel, navPage } : {}),
        ...(normalized.ref.loc ? { loc: normalized.ref.loc } : {}),
    };
}

/** Comparable form of a locator: its kind and value, not its spelling. */
function locatorKey(loc: Locator | undefined): string {
    return loc ? `${loc.kind}:${loc.value}` : '';
}

/**
 * Whether `loc` is the locator a citation was shown with, given the token from
 * its private metadata (empty when it was shown without one).
 */
export function matchesStoredLocator(storedToken: string, loc: Locator | undefined): boolean {
    return locatorKey(storedToken ? parseLoc(storedToken) : undefined) === locatorKey(loc);
}

/**
 * Check if citation attributes have changed. A citation read back from its
 * private metadata (`original.loc`) is compared by the locator it was shown
 * with; any other by its page.
 */
function attrsChanged(
    original: { item_id: string; page?: string; loc?: string } | undefined,
    current: { item_id: string; page?: string; loc?: Locator }
): boolean {
    if (!original) return true;
    if (original.item_id !== current.item_id) return true;
    if (original.loc !== undefined) return !matchesStoredLocator(original.loc, current.loc);
    return original.page !== current.page;
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
 * Build a citation or item link, preserving the source attribute in errors.
 * `citationOptions` carries CSL fields (label, prefix, …) of the citation being
 * rewritten, so moving a locator does not discard them.
 *
 * Native citations record what was cited in their private metadata (see
 * `noteCitationMeta.ts`): the locator as written, and the attachment or
 * annotation when the citation names its parent item.
 */
function buildCitation({
    item_id,
    page,
    pageIsResolvedLabel,
    navPage,
    loc,
    attrName = 'item_id',
    shouldTranslatePage = true,
    pageLabels,
    citationOptions,
}: SimplifiedCitationAttrs & {
    attrName?: 'item_id' | 'att_id';
    shouldTranslatePage?: boolean;
    pageLabels?: PageLabelsByAttachmentId;
    citationOptions?: NoteCitationItemOptions;
}): string {
    const ref = resolveObjectId(item_id);
    if (!ref) {
        throw new Error(`Invalid ${attrName} format: "${item_id}". Expected "libraryID-itemKey".`);
    }
    if (ref.library_id === UNRESOLVED_LIBRARY_ID) {
        throw new Error(`Cannot cite ${attrName}="${item_id}": its library is not available on this computer.`);
    }
    // Reject excluded targets before reading metadata to embed in the note.
    const excluded = checkLibraryExcluded(ref.library_id);
    if (excluded) {
        throw new Error(`Cannot cite ${attrName}="${item_id}": ${excluded.message}`);
    }
    const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
    if (!item) {
        throw new Error(`${attrName === 'att_id' ? 'Attachment' : 'Item'} not found: ${item_id}`);
    }
    if (item.isAnnotation?.() === true) {
        const annotationCitation = buildAnnotationNoteCitation(item, citationOptions);
        if (annotationCitation) return stripInlineItemDataFromDataCitations(noteCitationHTML(annotationCitation));
    }
    if (isLinkCitationItem(item)) {
        // Item links can display full ranges; native CSL navigation needs a single page.
        const labels = pageLabels?.[item.id];
        // `page` is a physical page number from the model, but a page already
        // resolved from a structural locator — or read back from a note, where
        // locators are stored as labels — is a display label.
        const pageIsLabel = pageIsResolvedLabel === true || !shouldTranslatePage;
        const displayPage = isStandaloneAttachment(item) && page
            ? pageIsLabel ? page : translatePageNumberToLabel(labels, page)
            : undefined;
        // The link navigates by physical page, so a label has to be translated
        // back. Without labels the translation is a no-op and the displayed
        // number is the best available guess.
        const linkPage = displayPage
            ? navPage ?? firstPageNumber(pageIsLabel ? translatePageLabelToNumber(labels, displayPage) : page)
            : undefined;
        return buildZoteroCitationLinkHTML(item, displayPage
            ? { kind: 'page', value: displayPage, raw: `page${displayPage}` }
            : undefined, linkPage);
    }
    // Only a PDF page is a printed page. For other attachments a page locator
    // is left out of the CSL citation; the private metadata keeps it. A
    // locator the citation labels otherwise (a chapter, …) is kept.
    const isPageLocator = !citationOptions?.label || citationOptions.label === 'page';
    let resolvedPage: string | undefined;
    if (!isPageLocator || citesPrintedPages(item)) {
        // Structural locators already resolve to final labels; do not translate twice.
        resolvedPage = pageIsResolvedLabel
            ? page
            : resolvePageForCitation(item, page, shouldTranslatePage, pageLabels);
    }
    // A page locator kept in the convention it was read in is a printed label,
    // not the physical page number the metadata records.
    const recordLoc = loc && (loc.kind !== 'page' || shouldTranslatePage) ? locatorToken(loc) : undefined;
    const meta = buildBeaverCitationMeta({
        loc: recordLoc,
        att: item.isAttachment() ? item.key : undefined,
    });
    return stripInlineItemDataFromDataCitations(createCitationHTML(item, resolvedPage, citationOptions, meta));
}

/**
 * The first citation item of the native citation stored for a `ref`, or
 * undefined for a link citation.
 */
function storedCitationItem(rawHtml: string): unknown {
    const match = rawHtml.match(/data-citation="([^"]*)"/);
    if (!match) return undefined;
    try {
        return JSON.parse(decodeURIComponent(match[1]))?.citationItems?.[0];
    } catch {
        return undefined;
    }
}

/**
 * CSL options (label, prefix, …) of a stored citation item (see
 * {@link storedCitationItem}), or undefined when it has none.
 */
function storedCitationOptions(citationItem: unknown): NoteCitationItemOptions | undefined {
    if (!citationItem || typeof citationItem !== 'object') return undefined;
    const item = citationItem as Record<string, unknown>;
    const options: NoteCitationItemOptions = {};
    for (const field of ['label', 'prefix', 'suffix'] as const) {
        const value = item[field];
        if (typeof value === 'string' && value) options[field] = value;
    }
    if (item['suppress-author'] === true) options['suppress-author'] = true;
    return Object.keys(options).length > 0 ? options : undefined;
}

/** Whether two model item ids (`u-KEY`, `1-KEY`, `g123-KEY`) name the same item. */
function citesSameItem(a: string, b: string): boolean {
    const left = resolveObjectId(a);
    const right = resolveObjectId(b);
    return !!left && !!right && left.library_id === right.library_id && left.zotero_key === right.zotero_key;
}

/**
 * Comparable form of a compound citation's `items` attribute
 * (`id:page=P, id, …`). Each id is resolved, so the legacy `1-KEY` and portable
 * `u-KEY` forms of one item compare equal; locators and order still count,
 * and whitespace does not.
 */
function normalizeCompoundItems(items: string): string {
    return items.split(',').map((entry) => {
        const compact = entry.replace(/\s+/g, '');
        const separator = compact.indexOf(':');
        const id = separator === -1 ? compact : compact.slice(0, separator);
        const locator = separator === -1 ? '' : compact.slice(separator);
        const ref = resolveObjectId(id);
        // A library not on this device has no local id; its portable ref
        // still tells two such libraries apart.
        const library = ref && (ref.library_id !== UNRESOLVED_LIBRARY_ID ? ref.library_id : ref.library_ref);
        return `${ref && library != null ? `${library}-${ref.zotero_key}` : id}${locator}`;
    }).join(',');
}

// =============================================================================
// External reference fallback
// =============================================================================

/**
 * External reference context passed into expandToRawHtml so the citation
 * expander can resolve `<citation external_id="..."/>` (used by chat search
 * tools for non-Zotero works) into something a Zotero note can store.
 *
 *  1. If `externalItemMapping[external_id]` resolves to a Zotero item, the
 *     citation is rewritten as a normal item_id citation.
 *  2. Otherwise the work is cited as an embedded item built from the matching
 *     `ExternalReference` metadata (see `buildExternalNoteCitation`).
 *
 * If neither map has any data for the external_id, expansion throws with a
 * helpful message instead of silently dropping the citation.
 */
export interface ExternalRefContext {
    /** Every external-file key in new_string must have a preloaded entry, including missing files. */
    externalFiles?: Record<string, ExternalFileCitationData>;
    externalFileWarnings?: string[];
    /** source_id → ExternalReference object (title, authors, urls, identifiers, ...) */
    externalRefs: Record<string, ExternalReference>;
    /** source_id → mapped Zotero item, or null if checked but not in library */
    externalItemMapping: Record<string, ZoteroItemReference | null>;
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
 * Cite an external work: as the library item it maps to when the user has it,
 * otherwise as an embedded item built from the thread's reference metadata,
 * or from a citation of the work the note already holds (which carries its
 * data), so a note can be edited from any chat. `ownCitation` is the stored
 * citation being rewritten, whose data is preferred over that of other
 * citations of the work. Throws when none has it.
 */
function buildExternalRefCitation(
    externalId: string,
    loc: Locator | undefined,
    externalRefContext: ExternalRefContext | undefined,
    pageLabels: PageLabelsByAttachmentId | undefined,
    metadata: SimplificationMetadata,
    citationOptions?: NoteCitationItemOptions,
    ownCitation?: string,
): string {
    const mappedItemRef = externalRefContext?.externalItemMapping?.[externalId];
    if (mappedItemRef) {
        return buildCitation({
            item_id: modelObjectIdFromReference(mappedItemRef),
            ...(loc?.kind === 'page' ? { page: loc.value } : {}),
            loc,
            pageLabels,
        });
    }
    const externalRef = externalRefContext?.externalRefs?.[externalId];
    if (externalRef) {
        return stripInlineItemDataFromDataCitations(
            noteCitationHTML(buildExternalNoteCitation(externalId, externalRef, loc, citationOptions)),
        );
    }
    const sameWork = [...metadata.elements.values()]
        .filter(stored => stored.originalAttrs?.external_id === externalId)
        .map(stored => stored.rawHtml);
    for (const rawHtml of ownCitation ? [ownCitation, ...sameWork] : sameWork) {
        const rebuilt = rebuildEmbeddedNoteCitation(storedCitationItem(rawHtml), loc, citationOptions);
        if (rebuilt) return stripInlineItemDataFromDataCitations(noteCitationHTML(rebuilt));
    }
    throw new Error(
        `Error: Citation external_id="${externalId}" not found in this thread's `
        + 'external reference cache or in the note. To cite a Zotero item use id="LIB-KEY", '
        + 'or att_id="LIB-KEY" for a PDF attachment. external_id is only valid '
        + 'for works returned by a search tool earlier in this thread or already cited in the note.'
    );
}

/**
 * Expand the `<citation …/>` tags in a string into note citation HTML: native
 * Zotero citations for library items, annotations (cited as their parent item)
 * and external works (cited as embedded items), links for notes and standalone
 * attachments, and links or text for external files. Native citations carry
 * Beaver's private metadata, so they read back as written.
 * This is the citation pass of {@link expandToRawHtml}; note creation runs it on
 * its own (with empty `metadata`) so new and edited notes store identical
 * citations.
 *
 * Throws on a citation that cannot be stored: an unknown or excluded item, an
 * unknown `ref` in old_string, or a change to a compound citation.
 */
export function expandNoteCitationTags(
    str: string,
    metadata: SimplificationMetadata,
    context: 'old' | 'new',
    externalRefContext?: ExternalRefContext,
    pageLabels?: PageLabelsByAttachmentId,
    resolvedLocatorPages?: ResolvedLocatorPages,
): string {
    return str.replace(
        noteCitationTagPattern(),
        (match, attrStr) => {
            const ref = extractAttr(attrStr, 'ref');
            const explicitItemId = extractAttr(attrStr, 'item_id');
            const unifiedId = extractAttr(attrStr, 'id');
            const itemId = explicitItemId || unifiedId;
            const attId = extractAttr(attrStr, 'att_id') || extractAttr(attrStr, 'attachment_id');
            const items = extractAttr(attrStr, 'items');
            const externalId = extractAttr(attrStr, 'external_id');

            const normalizedCitation = normalizeCitationTag(parseRawCitationAttributes(attrStr));
            // External files are ordinary links/text in notes, including when
            // replacing an existing Zotero citation's identity in new_string.
            if (context === 'new' && normalizedCitation.ok && normalizedCitation.ref.kind === 'external_file'
                && !(ref && metadata.elements.get(ref)?.isCompound)) {
                const fileRef = normalizedCitation.ref;
                const file = externalRefContext?.externalFiles?.[fileRef.ext_key];
                if (!file) {
                    throw new Error(`External file ext-${fileRef.ext_key} was not preloaded for note expansion.`);
                }
                const resolved = resolvedLocatorPages?.[requestedCitationKey(fileRef)];
                return formatExternalFileCitationHTML(
                    file.filename,
                    resolved ? `, p. ${resolved.label}` : externalFileLocatorSuffix(fileRef.loc),
                    file.href,
                );
            }

            // Case 1: Existing citation (has ref) — look up from metadata map
            if (ref) {
                const stored = metadata.elements.get(ref);
                if (stored) {
                    // Compound citations are immutable. Leaving one as read is
                    // fine; a changed one is refused rather than silently kept.
                    if (stored.isCompound) {
                        const changedItems = items !== undefined && stored.originalItems !== undefined
                            && normalizeCompoundItems(items) !== normalizeCompoundItems(stored.originalItems);
                        if (context === 'new' && (changedItems || itemId || attId || externalId)) {
                            throw new Error(
                                `Error: Citation ref="${ref}" is a compound citation, which cannot be `
                                + 'edited. Keep its tag exactly as read_note shows it, or remove the tag '
                                + 'and insert individual <citation id="..."/> tags without a ref.'
                            );
                        }
                        return stored.rawHtml;
                    }
                    // An embedded external work, read back as `external_id`.
                    const storedExternalId = stored.originalAttrs?.external_id;
                    if (storedExternalId && externalId && !itemId) {
                        const loc = normalizedCitation.ok ? normalizedCitation.ref.loc : undefined;
                        const sameWork = externalId === storedExternalId;
                        const unchanged = sameWork && matchesStoredLocator(stored.originalAttrs?.loc ?? '', loc);
                        if (unchanged || context === 'old') return stored.rawHtml;
                        const citationOptions = sameWork
                            ? storedCitationOptions(storedCitationItem(stored.rawHtml))
                            : undefined;
                        return buildExternalRefCitation(
                            externalId, loc, externalRefContext, pageLabels, metadata, citationOptions,
                            sameWork ? stored.rawHtml : undefined,
                        );
                    }
                    // Single citation — check if attributes changed (e.g., page locator updated)
                    if (itemId) {
                        const newAttrs = parseSimplifiedCitationAttrs(attrStr, resolvedLocatorPages);
                        if (attrsChanged(stored.originalAttrs, newAttrs)) {
                            // Newly added locators use physical pages. Existing
                            // locators retain the convention exposed when read.
                            const original = stored.originalAttrs;
                            const shouldTranslatePage = !original?.page
                                || (original.pageConvention === 'number'
                                    && (original.cslLabel == null || original.cslLabel === 'page'));
                            // Keep the citation's CSL label, prefix and suffix
                            // while it still cites the same item.
                            const citationOptions = original && citesSameItem(original.item_id, newAttrs.item_id)
                                ? storedCitationOptions(storedCitationItem(stored.rawHtml))
                                : undefined;
                            return buildCitation({ ...newAttrs, shouldTranslatePage, pageLabels, citationOptions });
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
            if (itemId) {
                const attrs = parseSimplifiedCitationAttrs(attrStr, resolvedLocatorPages);
                return buildCitation({ ...attrs, pageLabels });
            }
            if (attId) {
                // Resolve structural locators on legacy att_id/attachment_id
                // citations the same way as the unified id path.
                const { page, pageIsResolvedLabel, navPage } = normalizedCitation.ok
                    ? resolveLocatorPageAttr(normalizedCitation.ref, resolvedLocatorPages)
                    : { page: extractAttr(attrStr, 'page'), pageIsResolvedLabel: false, navPage: undefined };
                return buildCitation({
                    item_id: attId,
                    attrName: 'att_id',
                    page,
                    pageLabels,
                    pageIsResolvedLabel,
                    navPage,
                    loc: normalizedCitation.ok ? normalizedCitation.ref.loc : undefined,
                });
            }
            if (normalizedCitation.ok && normalizedCitation.ref.kind === 'zotero') {
                const attrs = parseSimplifiedCitationAttrs(attrStr, resolvedLocatorPages);
                return buildCitation({ ...attrs, pageLabels });
            }
            // external_id: chat-side external work ID (e.g. OpenAlex W-id).
            if (externalId) {
                const loc = normalizedCitation.ok ? normalizedCitation.ref.loc : undefined;
                return buildExternalRefCitation(externalId, loc, externalRefContext, pageLabels, metadata);
            }
            if (items) {
                throw new Error(
                    'Error: Cannot create new compound citations. Insert individual <citation id="..." /> tags instead.'
                );
            }
            throw new Error('Error: Citation must have an "id" attribute. Legacy "item_id" / "att_id" are also accepted.');
        }
    );
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
 *   cited as an embedded work otherwise. When omitted, new `external_id`
 *   citations throw the missing-reference error.
 * @param pageLabels - Optional pre-resolved page-label map (attachment item ID
 *   → 0-based page index → label). Used to translate model-provided 1-based
 *   page numbers on NEW citations into display labels. Resolve it up-front via
 *   `preloadPageLabelsForNewCitations`.
 */
export function expandToRawHtml(
    str: string,
    metadata: SimplificationMetadata,
    context: 'old' | 'new',
    externalRefContext?: ExternalRefContext,
    pageLabels?: PageLabelsByAttachmentId,
    resolvedLocatorPages?: ResolvedLocatorPages,
): string {
    str = expandNoteCitationTags(str, metadata, context, externalRefContext, pageLabels, resolvedLocatorPages);

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
