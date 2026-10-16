/**
 * Full-text search on Zotero's own index (no Beaver index).
 *
 * 1. Scope: searchable libraries, narrowed by filters and explicit attachments.
 * 2. Stage 1: Zotero's index ranks the scope's attachments; the top N become
 *    candidates. Explicit attachments that fit in N skip this step.
 * 3. Stage 2: passages are cut from each candidate's text — Beaver's cached
 *    extraction when there is one (sentence locators, every page), otherwise
 *    Zotero's own extracted text (page numbers only) — and ranked together with
 *    in-memory BM25. The top passages go to the backend for reranking.
 *
 * Excluded libraries never enter the scope, so their text is never read here.
 */

import type {
    ResolveSearchFiltersUnresolved,
    WSZoteroFulltextSearchRequest,
    WSZoteroFulltextSearchResponse,
    ZoteroFulltextDocument,
    ZoteroFulltextDropReason,
    ZoteroFulltextEngine,
    ZoteroFulltextPassage,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { StructuredDocument } from '@beaver/agent-core/extract/schema';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../utils/libraryIdentity';
import { serializeAttachmentStub, serializeItemStub, safeStub } from '../../utils/zoteroSerializers';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { handleResolveSearchFiltersRequest } from '../agentDataProvider/handleResolveSearchFiltersRequest';
import {
    getSearchableLibraryIds,
    isLibraryAccessReady,
    librariesFilterError,
    resolveLibrariesFilter,
} from '../agentDataProvider/utils';
import { domDocumentPassages, structuredDocumentPassages } from './beaverPassages';
import { buildQueryTerms, cutPassages, hasPageBreaksFor, selectPassages, termDisplay } from './text';
import {
    detectEngine,
    listScopeAttachments,
    rankWithFts5,
    rankWithWordIndex,
    readSnapshotFileText,
    readZoteroCacheText,
    type ScopeAttachment,
} from './zoteroIndex';

export const DEFAULT_MAX_DOCUMENTS = 16;
export const DEFAULT_MAX_PASSAGES = 160;
export const DEFAULT_TIMEOUT_MS = 8000;
const MAX_DOCUMENTS_LIMIT = 50;
const MAX_PASSAGES_LIMIT = 400;
/** Stage 1 runs within this budget on the word-index path (one search per term). */
const STAGE1_TIMEOUT_MS = 10_000;
/** Extra stage-1 candidates, so copies of one file in several libraries don't shrink the candidate set. */
const DUPLICATE_SLACK = 8;
/** Section reported for reference-list passages of Zotero's text, so the reranker demotes them. */
const REFERENCE_SECTION = 'References';

interface CandidateText {
    attachment: ScopeAttachment;
    item: Zotero.Item;
    source: 'beaver' | 'zotero';
    passages: { pageIndex: number | null; text: string; reference?: boolean; locator?: Record<string, unknown> }[];
}

const clamp = (value: number | undefined, fallback: number, max: number) =>
    Math.max(1, Math.min(max, Math.floor(value ?? fallback)));

function reference(libraryID: number, key: string): ZoteroItemReference {
    return { library_id: libraryID, library_ref: libraryRefForLibraryID(libraryID) ?? undefined, zotero_key: key };
}

function hasItemFilters(request: WSZoteroFulltextSearchRequest): boolean {
    const year = request.year;
    return !!(request.collections?.length || request.tags?.length || request.authors?.length
        || (year && ((year.min ?? 0) > 0 || (year.max ?? 0) > 0 || (year.exact ?? 0) > 0)));
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
        const fingerprint = `${text.source}:${text.passages.length}:${textHash(text.passages.map((passage) => passage.text))}`;
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
    });
}

/** Beaver's cached extraction of an attachment as passages, or null on a cache miss. */
async function beaverPassages(item: Zotero.Item, kind: ScopeAttachment['contentKind']): Promise<CandidateText['passages'] | null> {
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

/** Read one candidate's passages: Beaver's cache first, then Zotero's extracted text. */
async function readCandidate(attachment: ScopeAttachment): Promise<CandidateText | ZoteroFulltextDropReason> {
    const item = await Zotero.Items.getAsync(attachment.itemID);
    if (!item) return 'file_missing';
    try {
        const passages = await beaverPassages(item, attachment.contentKind);
        if (passages?.length) return { attachment, item, source: 'beaver', passages };
    } catch (error) {
        logger(`zoteroFulltext: cached extraction unreadable for ${item.libraryID}/${item.key}: ${error}`, 2);
    }
    const text = await readZoteroCacheText(item)
        ?? (attachment.contentKind === 'snapshot' ? await readSnapshotFileText(item) : null);
    if (!text) return 'no_text';
    const paged = attachment.contentKind === 'pdf' && hasPageBreaksFor(text, attachment.indexedPages);
    const passages = cutPassages(text, paged);
    return passages.length ? { attachment, item, source: 'zotero', passages } : 'no_text';
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | 'timeout'> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A read that outlives the deadline finishes unobserved; keep its failure from going unhandled
    promise.catch(() => undefined);
    try {
        return await Promise.race([
            promise,
            new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), remaining); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function documentMetadata(candidate: CandidateText, rank: number): Promise<ZoteroFulltextDocument> {
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
    return {
        attachment: reference(attachment.libraryID, attachment.key),
        content_kind: attachment.contentKind,
        ...(parentStub ? { parent_item: parentStub } : {}),
        ...(() => {
            const stub = safeStub(() => serializeAttachmentStub(item, attachment.contentKind));
            return stub ? { served_attachment: stub } : {};
        })(),
        stage1_rank: rank,
        passage_source: candidate.source,
        ...(attachment.partial ? { partially_indexed: true } : {}),
        ...(attachment.indexedPages != null ? { indexed_pages: attachment.indexedPages } : {}),
        ...(attachment.totalPages != null ? { total_pages: attachment.totalPages } : {}),
    };
}

/**
 * Remove everything from libraries excluded while the search ran: their
 * documents and passages, dropped or unindexed attachments, and the scope's
 * coverage counts, which would describe them.
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
    const { coverage: _coverage, dropped, unindexed_attachments: unindexed, ...rest } = response;
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
    if (hasItemFilters(request)) {
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
    if (explicit) {
        // Requested attachments that are not PDFs, EPUBs or snapshots, or were filtered out
        const inScope = new Set(scope.map((attachment) => attachment.itemID));
        for (const [id, ref] of explicitIDs) if (!inScope.has(id)) unindexedAttachments.push(ref);
    }
    const coverage = {
        total: scope.length,
        indexed: scope.filter((attachment) => attachment.indexed).length,
        partial: scope.filter((attachment) => attachment.partial).length,
    };
    lap('scope', scopeStart);
    let unindexedField = unindexedAttachments.length ? { unindexed_attachments: unindexedAttachments } : {};
    if (!scope.length) return respond({ status: 'unavailable', unavailable_reason: 'scope_empty', coverage, ...unindexedField });
    if (!terms.length) return respond({ status: 'unavailable', unavailable_reason: 'no_terms', coverage, ...unindexedField });

    // ---- stage 1: candidates from Zotero's index ----------------------------
    const stage1Start = Date.now();
    let candidates: ScopeAttachment[];
    let incompleteSearch = false;
    const byId = new Map(scope.map((attachment) => [attachment.itemID, attachment]));
    if (explicit && scope.length <= maxDocuments) {
        // Every requested attachment is read; Zotero's index is not needed to find them
        const order = [...explicitIDs.keys()];
        candidates = order.map((id) => byId.get(id)).filter((a): a is ScopeAttachment => !!a);
    } else {
        if (explicit) {
            // Too many requested attachments to read them all: Zotero's index ranks them, so
            // the ones it has not indexed cannot be searched
            for (const attachment of scope) {
                if (!attachment.indexed) unindexedAttachments.push(explicitIDs.get(attachment.itemID)!);
            }
            unindexedField = unindexedAttachments.length ? { unindexed_attachments: unindexedAttachments } : {};
        }
        if (engine === 'none') return respond({ status: 'unavailable', unavailable_reason: 'no_index', coverage, ...unindexedField });
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
                    coverage,
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
    if (!candidates.length) return respond({ status: 'no_matches', coverage, ...unindexedField });
    const incompleteField = incompleteSearch ? { incomplete_search: true } : {};

    // ---- stage 2: passages ---------------------------------------------------
    const readStart = Date.now();
    const deadline = readStart + timeoutMs;
    const texts: CandidateText[] = [];
    const dropped: { attachment: ZoteroItemReference; reason: ZoteroFulltextDropReason }[] = [];
    for (const candidate of candidates) {
        let outcome: CandidateText | ZoteroFulltextDropReason | 'timeout';
        try {
            // Past the budget, the remaining candidates are not read at all
            outcome = Date.now() >= deadline ? 'timeout' : await withDeadline(readCandidate(candidate), deadline);
        } catch (error) {
            logger(`zoteroFulltext: reading ${candidate.libraryID}/${candidate.key} failed: ${error}`, 1);
            outcome = 'error';
        }
        if (typeof outcome === 'string') dropped.push({ attachment: reference(candidate.libraryID, candidate.key), reason: outcome });
        else texts.push(outcome);
    }
    lap('read', readStart);
    const distinctTexts = withoutDuplicateTexts(texts);
    timing.duplicate_documents = texts.length - distinctTexts.length;
    texts.splice(0, texts.length, ...distinctTexts);
    timing.beaver_documents = texts.filter((text) => text.source === 'beaver').length;
    timing.zotero_documents = texts.filter((text) => text.source === 'zotero').length;
    const droppedField = dropped.length ? { dropped } : {};
    if (!texts.length) return respond({ status: 'no_matches', coverage, ...droppedField, ...unindexedField, ...incompleteField });

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
            documents.push(await documentMetadata(text, candidates.indexOf(text.attachment) + 1));
        }
        const passage = text.passages[entry.passage];
        passages.push({
            document: docIndex.get(entry.candidate)!,
            rank: i + 1,
            text: passage.text,
            page_index: passage.pageIndex,
            ...(passage.reference ? { section: REFERENCE_SECTION } : {}),
            ...(passage.locator ? { locator: passage.locator } : {}),
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
        coverage,
        ...droppedField,
        ...unindexedField,
    });
}
