/**
 * Full-text search on Zotero's own index (no Beaver index).
 *
 * 1. Scope: searchable libraries, narrowed by filters and explicit attachments.
 * 2. Stage 1: Zotero's index ranks the scope's attachments; the top N become
 *    candidates. Explicit attachments that fit in N skip this step.
 * 3. Stage 2: passages with sentence locators are cut from Beaver's extraction
 *    of each candidate — cached candidates first, then the others extracted now
 *    in stage-1 order until the deadline — and ranked together with in-memory
 *    BM25. The top passages go to the backend for reranking.
 *
 * Excluded libraries never enter the scope, so their documents are never read
 * or extracted here.
 */

import type {
    ResolveSearchFiltersUnresolved,
    WSZoteroFulltextSearchRequest,
    WSZoteroFulltextSearchResponse,
    ZoteroDocumentErrorCode,
    ZoteroFulltextDocument,
    ZoteroFulltextDropReason,
    ZoteroFulltextEngine,
    ZoteroFulltextPassage,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { StructuredDocument } from '@beaver/agent-core/extract/schema';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID, modelObjectId, resolveLibraryRef } from '../../utils/libraryIdentity';
import { serializeAttachmentStub, serializeItemStub, safeStub } from '../../utils/zoteroSerializers';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import {
    extractAndCacheEpubDocument,
    extractAndCacheResolvedPdfDocument,
    extractAndCacheSnapshotDocument,
} from '../documentExtractionCore';
import { DEFAULT_PAGES_TIMEOUT_SECONDS } from '../agentDataProvider/timeout';
import { enqueuePdfExtractionRetry } from '../agentDataProvider/pdfExtractionRetry';
import { handleResolveSearchFiltersRequest, hasItemLevelFilters } from '../agentDataProvider/handleResolveSearchFiltersRequest';
import {
    getSearchableLibraryIds,
    isLibraryAccessReady,
    librariesFilterError,
    resolveLibrariesFilter,
} from '../agentDataProvider/utils';
import { domDocumentPassages, structuredDocumentPassages, type BeaverPassage } from './beaverPassages';
import { withDeadline } from './deadline';
import { buildQueryTerms, selectPassages, termDisplay } from './text';
import {
    detectEngine,
    listScopeAttachments,
    rankWithFts5,
    rankWithWordIndex,
    type ScopeAttachment,
} from './zoteroIndex';

export const DEFAULT_MAX_DOCUMENTS = 16;
export const DEFAULT_MAX_PASSAGES = 160;
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DOCUMENTS_LIMIT = 50;
const MAX_PASSAGES_LIMIT = 400;
/** Stage 1 runs within this budget on the word-index path (one search per term). */
const STAGE1_TIMEOUT_MS = 10_000;
/** Extra stage-1 candidates, so copies of one file in several libraries don't shrink the candidate set. */
const DUPLICATE_SLACK = 8;

interface CandidateText {
    attachment: ScopeAttachment;
    item: Zotero.Item;
    /** Served from the document cache rather than extracted by this search. */
    cached: boolean;
    passages: BeaverPassage[];
}

const clamp = (value: number | undefined, fallback: number, max: number) =>
    Math.max(1, Math.min(max, Math.floor(value ?? fallback)));

function reference(libraryID: number, key: string): ZoteroItemReference {
    return { library_id: libraryID, library_ref: libraryRefForLibraryID(libraryID) ?? undefined, zotero_key: key };
}

/**
 * Move later copies of a file Zotero synced into several libraries (same
 * storage hash) behind the other candidates. Identical documents would take
 * several result slots with the same passages; a copy still read is dropped by
 * the text comparison after reading. The hash describes the last synced file,
 * so a copy that has diverged locally is only deferred, never discarded.
 */
function deferDuplicateFiles(candidates: ScopeAttachment[]): ScopeAttachment[] {
    const seen = new Set<string>();
    const first: ScopeAttachment[] = [];
    const copies: ScopeAttachment[] = [];
    for (const candidate of candidates) {
        if (candidate.storageHash && seen.has(candidate.storageHash)) {
            copies.push(candidate);
        } else {
            if (candidate.storageHash) seen.add(candidate.storageHash);
            first.push(candidate);
        }
    }
    return [...first, ...copies];
}

/** 53-bit hash of the passages' full text (cyrb53), for spotting identical documents. */
function textHash(texts: readonly string[]): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (const text of texts) {
        for (let i = 0; i <= text.length; i++) {
            const code = i < text.length ? text.charCodeAt(i) : 0;
            h1 = Math.imul(h1 ^ code, 2654435761);
            h2 = Math.imul(h2 ^ code, 1597334677);
        }
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Drop later candidates whose passages repeat an earlier candidate's (copies without a storage hash). */
function withoutDuplicateTexts(texts: CandidateText[]): CandidateText[] {
    const seen = new Set<string>();
    return texts.filter((text) => {
        const fingerprint = `${text.passages.length}:${textHash(text.passages.map((passage) => passage.text))}`;
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
    });
}

/** Passages of Beaver's cached extraction of an attachment, or null on a cache miss. */
async function cachedPassages(item: Zotero.Item, kind: ScopeAttachment['contentKind']): Promise<BeaverPassage[] | null> {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return null;
    const source = await resolveAttachmentFileSource({ item, localSizeStrategy: 'stat' });
    if (source.kind === 'error') return null;
    const ref = { libraryId: item.libraryID, zoteroKey: item.key };
    const filePath = source.source.filePath;
    if (kind === 'pdf') {
        const result = await cache.getResult(ref, 'structured', filePath);
        if (!result || result.mode !== 'structured') return null;
        return structuredDocumentPassages(result.document as StructuredDocument);
    }
    const document = kind === 'epub'
        ? await cache.getEpubResult(ref, filePath)
        : await cache.getSnapshotResult(ref, filePath);
    return document ? domDocumentPassages(document, kind) : null;
}

/** Drop reason for a failed extraction. */
function dropReason(code: ZoteroDocumentErrorCode): ZoteroFulltextDropReason {
    switch (code) {
        case 'timeout':
            return 'timeout';
        case 'no_text_layer':
        case 'empty_document':
            return 'no_text';
        case 'file_missing':
        case 'file_permission_denied':
        case 'download_failed':
            return 'file_missing';
        case 'file_too_large':
        case 'too_many_pages':
            return 'too_large';
        default:
            return 'error';
    }
}

/**
 * Extract an attachment with Beaver on the hot worker, the way `read` does, so
 * the result is cached for later searches and reads. A PDF that exceeds the
 * hot-worker timeout is queued for background extraction, as `read` does.
 */
async function extractPassages(item: Zotero.Item, kind: ScopeAttachment['contentKind']): Promise<BeaverPassage[] | ZoteroFulltextDropReason> {
    const source = { kind: 'zotero' as const, item };
    const resolvedKey = modelObjectId(item.libraryID, item.key);
    const contentType = item.attachmentContentType || 'unknown';
    if (kind === 'pdf') {
        const result = await extractAndCacheResolvedPdfDocument({
            source,
            resolvedKey,
            contentType,
            mode: 'structured',
            maxPages: null,
            timeoutSeconds: DEFAULT_PAGES_TIMEOUT_SECONDS,
            workerName: 'hot',
        });
        if (result.kind === 'ok') {
            return result.result?.mode === 'structured'
                ? structuredDocumentPassages(result.result.document as StructuredDocument)
                : 'error';
        }
        if (result.kind === 'timeout' || result.kind === 'external_abort') {
            // Hot extraction gave up: finish it in the background so the next
            // search (or read) finds it in the cache
            await enqueuePdfExtractionRetry({
                libraryId: item.libraryID,
                zoteroKey: item.key,
                mode: 'structured',
                maxPages: null,
                logContext: 'zoteroFulltext',
            });
            return 'timeout';
        }
        return dropReason(result.code);
    }
    const args = { source, resolvedKey, contentType, maxPages: null };
    const result = kind === 'epub' ? await extractAndCacheEpubDocument(args) : await extractAndCacheSnapshotDocument(args);
    return result.kind === 'ok' ? domDocumentPassages(result.document, kind) : dropReason(result.code);
}

type CandidateOutcome = CandidateText | ZoteroFulltextDropReason;

/** One candidate from Beaver's document cache, or its loaded item when the cache has no extraction. */
async function readCachedCandidate(attachment: ScopeAttachment): Promise<CandidateOutcome | { uncached: Zotero.Item }> {
    const item = await Zotero.Items.getAsync(attachment.itemID);
    if (!item) return 'file_missing';
    try {
        const passages = await cachedPassages(item, attachment.contentKind);
        if (passages) return passages.length ? { attachment, item, cached: true, passages } : 'no_text';
    } catch (error) {
        logger(`zoteroFulltext: cached extraction unreadable for ${item.libraryID}/${item.key}: ${error}`, 2);
    }
    return { uncached: item };
}

/** One candidate extracted by this search. */
async function extractCandidate(attachment: ScopeAttachment, item: Zotero.Item): Promise<CandidateOutcome> {
    const passages = await extractPassages(item, attachment.contentKind);
    if (typeof passages === 'string') return passages;
    return passages.length ? { attachment, item, cached: false, passages } : 'no_text';
}

async function documentMetadata(candidate: CandidateText): Promise<ZoteroFulltextDocument> {
    const { attachment, item } = candidate;
    let parentStub;
    if (item.parentItemID) {
        const parent = await Zotero.Items.getAsync(item.parentItemID);
        if (parent?.isRegularItem?.()) {
            await Zotero.Items.loadDataTypes([parent], ['itemData', 'creators']);
            parentStub = safeStub(() => serializeItemStub(parent));
        }
    }
    await Zotero.Items.loadDataTypes([item], ['itemData']);
    const attachmentStub = safeStub(() => serializeAttachmentStub(item, attachment.contentKind));
    return {
        attachment: reference(attachment.libraryID, attachment.key),
        content_kind: attachment.contentKind,
        ...(parentStub ? { parent_item: parentStub } : {}),
        ...(attachmentStub ? { served_attachment: attachmentStub } : {}),
    };
}

/**
 * Remove everything from libraries excluded while the search ran: their
 * documents and passages, and dropped or unindexed attachments.
 */
export function withoutRevokedLibraries(
    response: WSZoteroFulltextSearchResponse,
    scopeLibraryIds: readonly number[],
): WSZoteroFulltextSearchResponse {
    const searchable = new Set(getSearchableLibraryIds());
    if (scopeLibraryIds.every((id) => searchable.has(id))) return response;
    const allowed = (ref: ZoteroItemReference) => {
        const libraryID = resolveLibraryRef(ref);
        return libraryID != null && searchable.has(libraryID);
    };
    const remap = new Map<number, number>();
    const documents = response.documents.filter((document, index) => {
        if (!allowed(document.attachment)) return false;
        remap.set(index, remap.size);
        return true;
    });
    const passages = response.passages
        .filter((passage) => remap.has(passage.document))
        .map((passage, index) => ({ ...passage, document: remap.get(passage.document)!, rank: index + 1 }));
    const { dropped, unindexed_attachments: unindexed, ...rest } = response;
    const keptDropped = dropped?.filter((entry) => allowed(entry.attachment)) ?? [];
    const keptUnindexed = unindexed?.filter(allowed) ?? [];
    return {
        ...rest,
        status: response.status === 'ok' && !passages.length ? 'no_matches' : response.status,
        documents,
        passages,
        ...(keptDropped.length ? { dropped: keptDropped } : {}),
        ...(keptUnindexed.length ? { unindexed_attachments: keptUnindexed } : {}),
    };
}

export async function runZoteroFulltextSearch(
    request: WSZoteroFulltextSearchRequest,
): Promise<WSZoteroFulltextSearchResponse> {
    const start = Date.now();
    const timing: Record<string, number> = {};
    const lap = (name: string, since: number) => { timing[`${name}_ms`] = Date.now() - since; };
    const maxDocuments = clamp(request.max_documents, DEFAULT_MAX_DOCUMENTS, MAX_DOCUMENTS_LIMIT);
    const maxPassages = clamp(request.max_passages, DEFAULT_MAX_PASSAGES, MAX_PASSAGES_LIMIT);
    const timeoutMs = clamp(request.timeout_ms, DEFAULT_TIMEOUT_MS, 60_000);

    const { terms, truncated } = buildQueryTerms(request.query ?? '', request.keywords ?? []);
    let engine: ZoteroFulltextEngine = await detectEngine();
    let unresolved: ResolveSearchFiltersUnresolved | undefined;
    // Libraries in the search scope, set once the scope is resolved
    let scopeLibraryIds: number[] = [];
    const respond = (
        partial: Partial<WSZoteroFulltextSearchResponse> & Pick<WSZoteroFulltextSearchResponse, 'status'>,
    ): WSZoteroFulltextSearchResponse => withoutRevokedLibraries({
        type: 'zotero_fulltext_search',
        request_id: request.request_id,
        engine,
        terms: terms.map(termDisplay),
        ...(truncated ? { terms_truncated: truncated } : {}),
        documents: [],
        passages: [],
        ...(unresolved ? { unresolved } : {}),
        ...partial,
        timing: { ...timing, total_ms: Date.now() - start },
    }, scopeLibraryIds);

    // ---- scope -----------------------------------------------------------
    const scopeStart = Date.now();
    let libraryIds = getSearchableLibraryIds();
    if (request.libraries?.length) {
        const resolution = resolveLibrariesFilter(request.libraries);
        const filterError = librariesFilterError(resolution);
        if (filterError) return respond({ status: 'unavailable', error: filterError.message, error_code: filterError.error_code });
        libraryIds = resolution.libraryIds;
        const notFound = [...resolution.unresolved, ...resolution.excluded.map((entry) => entry.input)];
        if (notFound.length && isLibraryAccessReady()) unresolved = { libraries: notFound };
    }
    if (!libraryIds.length) return respond({ status: 'unavailable', unavailable_reason: 'no_searchable_libraries' });
    scopeLibraryIds = libraryIds;

    let itemIDs: number[] | undefined;
    if (hasItemLevelFilters(request)) {
        const resolved = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: request.request_id,
            libraries: libraryIds,
            collections: request.collections,
            tags: request.tags,
            authors: request.authors,
            year: request.year,
        });
        if (resolved.error) return respond({ status: 'unavailable', error: resolved.error, error_code: resolved.error_code });
        unresolved = { ...unresolved, ...resolved.unresolved };
        if (unresolved.libraries === undefined) delete unresolved.libraries;
        if (!Object.keys(unresolved).length) unresolved = undefined;
        itemIDs = resolved.attachments
            .map((ref) => Zotero.Items.getIDFromLibraryAndKey(ref.library_id, ref.zotero_key))
            .filter((id): id is number => typeof id === 'number');
    }

    const explicit = request.attachments?.length ? request.attachments : null;
    const explicitIDs = new Map<number, ZoteroItemReference>();
    const unindexedAttachments: ZoteroItemReference[] = [];
    if (explicit) {
        for (const ref of explicit) {
            const libraryID = resolveLibraryRef(ref);
            const id = libraryID != null && libraryIds.includes(libraryID)
                ? Zotero.Items.getIDFromLibraryAndKey(libraryID, ref.zotero_key)
                : false;
            if (typeof id === 'number') explicitIDs.set(id, ref);
            else unindexedAttachments.push(ref);
        }
        const filterSet = itemIDs ? new Set(itemIDs) : null;
        itemIDs = [...explicitIDs.keys()].filter((id) => !filterSet || filterSet.has(id));
    }

    const searchScope = { libraryIds, itemIDs };
    const scope = await listScopeAttachments(searchScope, engine);
    // Every requested attachment is read when they all fit; Zotero's index is
    // not needed to find them
    const readAllExplicit = !!explicit && scope.length <= maxDocuments;
    if (explicit) {
        // Requested attachments that are not PDFs, EPUBs or snapshots, or were filtered out
        const inScope = new Set(scope.map((attachment) => attachment.itemID));
        for (const [id, ref] of explicitIDs) if (!inScope.has(id)) unindexedAttachments.push(ref);
        if (!readAllExplicit) {
            // Too many requested attachments to read them all: Zotero's index ranks them, so
            // the ones it has not indexed cannot be searched
            for (const attachment of scope) {
                if (!attachment.indexed) unindexedAttachments.push(explicitIDs.get(attachment.itemID)!);
            }
        }
    }
    lap('scope', scopeStart);
    const unindexedField = unindexedAttachments.length ? { unindexed_attachments: unindexedAttachments } : {};
    if (!scope.length) return respond({ status: 'unavailable', unavailable_reason: 'scope_empty', ...unindexedField });
    if (!terms.length) return respond({ status: 'unavailable', unavailable_reason: 'no_terms', ...unindexedField });

    // ---- stage 1: candidates from Zotero's index ----------------------------
    const stage1Start = Date.now();
    let candidates: ScopeAttachment[];
    let incompleteSearch = false;
    const byId = new Map(scope.map((attachment) => [attachment.itemID, attachment]));
    if (readAllExplicit) {
        candidates = [...explicitIDs.keys()].map((id) => byId.get(id)).filter((a): a is ScopeAttachment => !!a);
    } else {
        if (engine === 'none') return respond({ status: 'unavailable', unavailable_reason: 'no_index', ...unindexedField });
        const indexed = scope.filter((attachment) => attachment.indexed);
        let ranked: number[] = [];
        if (engine === 'fts5') {
            try {
                ranked = await rankWithFts5(terms, searchScope, maxDocuments + DUPLICATE_SLACK);
            } catch (error) {
                logger(`zoteroFulltext: FTS5 search failed, using the word index: ${error}`, 1);
                engine = 'word_index';
            }
        }
        if (engine === 'word_index') {
            const result = await rankWithWordIndex(terms, indexed, maxDocuments + DUPLICATE_SLACK, Date.now() + STAGE1_TIMEOUT_MS);
            ranked = result.ranked;
            incompleteSearch = result.incomplete;
            // Nothing found by a search that did not finish is not evidence of no matches
            if (!ranked.length && result.incomplete) {
                lap('stage1', stage1Start);
                return respond({
                    status: 'unavailable',
                    ...unindexedField,
                    error: result.timedOut
                        ? "Zotero's full-text search did not finish in time."
                        : "Zotero's full-text search failed.",
                    error_code: result.timedOut ? 'timeout' : 'database_error',
                });
            }
        }
        candidates = deferDuplicateFiles(
            ranked.map((id) => byId.get(id)).filter((a): a is ScopeAttachment => !!a),
        ).slice(0, maxDocuments);
    }
    lap('stage1', stage1Start);
    timing.candidates = candidates.length;
    if (!candidates.length) return respond({ status: 'no_matches', ...unindexedField });
    const incompleteField = incompleteSearch ? { incomplete_search: true } : {};

    // ---- stage 2: passages ---------------------------------------------------
    const readStart = Date.now();
    const deadline = readStart + timeoutMs;
    // Work that outlives the deadline finishes unobserved: an extraction runs on
    // to its own timeout and is cached, or queued for background extraction if
    // it times out. Past the deadline, no further candidate is read.
    const attempt = async <T>(candidate: ScopeAttachment, work: () => Promise<T>): Promise<T | ZoteroFulltextDropReason> => {
        if (Date.now() >= deadline) return 'timeout';
        try {
            return await withDeadline(work(), deadline);
        } catch (error) {
            logger(`zoteroFulltext: reading ${candidate.libraryID}/${candidate.key} failed: ${error}`, 1);
            return 'error';
        }
    };
    // Cached candidates first, so a slow extraction never costs one that is
    // ready; then the others are extracted in stage-1 order.
    const outcomes: CandidateOutcome[] = [];
    const uncached: { index: number; item: Zotero.Item }[] = [];
    for (const [index, candidate] of candidates.entries()) {
        const outcome = await attempt(candidate, () => readCachedCandidate(candidate));
        if (typeof outcome === 'object' && 'uncached' in outcome) uncached.push({ index, item: outcome.uncached });
        else outcomes[index] = outcome;
    }
    for (const { index, item } of uncached) {
        outcomes[index] = await attempt(candidates[index], () => extractCandidate(candidates[index], item));
    }
    const read: CandidateText[] = [];
    const dropped: { attachment: ZoteroItemReference; reason: ZoteroFulltextDropReason }[] = [];
    for (const [index, outcome] of outcomes.entries()) {
        if (typeof outcome === 'string') {
            dropped.push({ attachment: reference(candidates[index].libraryID, candidates[index].key), reason: outcome });
        } else {
            read.push(outcome);
        }
    }
    lap('read', readStart);
    timing.cached_documents = read.filter((text) => text.cached).length;
    timing.extracted_documents = read.length - timing.cached_documents;
    const texts = withoutDuplicateTexts(read);
    timing.duplicate_documents = read.length - texts.length;
    const droppedField = dropped.length ? { dropped } : {};
    if (!texts.length) return respond({ status: 'no_matches', ...droppedField, ...unindexedField, ...incompleteField });

    const rankStart = Date.now();
    const selected = selectPassages(texts, terms, maxPassages);
    lap('bm25', rankStart);
    timing.passage_pool = texts.reduce((sum, text) => sum + text.passages.length, 0);

    const metadataStart = Date.now();
    const docIndex = new Map<number, number>();
    const documents: ZoteroFulltextDocument[] = [];
    const passages: ZoteroFulltextPassage[] = [];
    for (const [i, entry] of selected.entries()) {
        const text = texts[entry.candidate];
        if (!docIndex.has(entry.candidate)) {
            docIndex.set(entry.candidate, documents.length);
            documents.push(await documentMetadata(text));
        }
        const passage = text.passages[entry.passage];
        passages.push({
            document: docIndex.get(entry.candidate)!,
            rank: i + 1,
            text: passage.text,
            locator: passage.locator,
        });
    }
    lap('metadata', metadataStart);
    timing.matched_passages = selected.filter((entry) => entry.score > 0).length;

    // Unmatched passages still go out: the reranker can find a passage worded
    // differently from the query (another language, synonyms Zotero's index lacked).
    return respond({
        ...incompleteField,
        status: passages.length ? 'ok' : 'no_matches',
        documents,
        passages,
        ...droppedField,
        ...unindexedField,
    });
}
