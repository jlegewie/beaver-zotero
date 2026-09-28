/**
 * Embedding units and their text.
 *
 * A unit is a regular item. Its text is title + abstract, or, when the abstract
 * is short, title + text derived from its best readable attachment
 * (`attachment_embedding_text`). The index never waits for derived text: a
 * unit uses what is available now and requests an ordinary `document_extract`
 * job for the attachment when its text is missing or outdated.
 */

import {
    attachmentRefKey,
    type AttachmentEmbeddingTextRecord,
    type AttachmentProcessingStateRecord,
    type BackgroundJobInput,
    type BeaverDB,
    type EmbeddingSource,
} from './database';
import { getBestAttachmentBatch } from './documentExtraction/attachmentInfoBatch';
import { liveAttachmentContentKind } from './documentExtraction/attachmentResolution';
import { EMBEDDING_TEXT_VERSION } from './documentExtraction/embeddingText';
import { observeAttachmentSource } from './documentExtraction/sourceObservation';
import { getFileSignature, getRemoteFileHash } from './documentFileIdentity';
import { EMBEDDING_EXTRACT_PRIORITY } from './backgroundProcessing/constants';
import { buildBackgroundExtractPayload } from './backgroundProcessing/utils';
import { isLibraryInScope } from './libraryScope';
import { logger } from '@beaver/agent-core/platform/logger';

/** Minimum length of a unit's text; units with less content are not indexed. */
export const MIN_CONTENT_LENGTH = 40;

/** Abstracts shorter than this (trimmed) are replaced by derived attachment text when available. */
export const ABSTRACT_ENRICHMENT_THRESHOLD = 400;

/** Content types whose structured extraction yields derived text: PDF, EPUB and HTML snapshots. */
export const EMBEDDABLE_CONTENT_TYPES = [
    'application/pdf',
    'application/epub+zip',
    'text/html',
    'application/xhtml+xml',
] as const;

type EmbeddableKind = AttachmentProcessingStateRecord['contentKind'];

export interface UnitText {
    text: string;
    source: EmbeddingSource;
    sourceAttachmentId: number | null;
}

/** Derived text offered to a unit by its best readable attachment. */
export interface DerivedUnitText {
    attachmentId: number;
    keywords: string | null;
    body: string;
}

/** A unit's best readable attachment and its stored derived text, if any. */
export interface ExtractionCandidate {
    attachment: Zotero.Item;
    kind: EmbeddableKind;
    row: AttachmentEmbeddingTextRecord | null;
}

export interface UnitResolution {
    item: Zotero.Item;
    /** Null when the item is not indexable. */
    unit: UnitText | null;
    /** Set when the unit needs derived text and has a readable attachment. */
    candidate: ExtractionCandidate | null;
    /** Set when reading the item's fields threw; the item is not resolved. */
    error?: unknown;
}

function buildMetadataText(title: string, abstract: string): string {
    return `${title}\n\n${abstract}`.trim();
}

function itemTitle(item: Zotero.Item): string {
    return (item.getField('title', false, true) as string) || '';
}

function itemAbstract(item: Zotero.Item): string {
    return (item.getField('abstractNote') as string) || '';
}

/** True for regular, non-trashed items whose abstract is too short to stand on its own. */
export function needsDerivedText(item: Zotero.Item): boolean {
    return item.isRegularItem()
        && !item.deleted
        && itemAbstract(item).trim().length < ABSTRACT_ENRICHMENT_THRESHOLD;
}

/**
 * The single indexing rule: which text a unit embeds, or null when it is not
 * indexable. Requires the item's `itemData` to be loaded.
 */
export function resolveUnitText(item: Zotero.Item, derived: DerivedUnitText | null): UnitText | null {
    if (!item.isRegularItem() || item.deleted) return null;
    const title = itemTitle(item);
    const abstract = itemAbstract(item);
    if (abstract.trim().length < ABSTRACT_ENRICHMENT_THRESHOLD && derived?.body) {
        const text = [title.trim(), derived.keywords ? `Keywords: ${derived.keywords}` : '', derived.body]
            .filter(Boolean)
            .join('\n\n');
        if (text.length >= MIN_CONTENT_LENGTH) {
            return { text, source: 'attachment_text', sourceAttachmentId: derived.attachmentId };
        }
    }
    if ((title.trim() + abstract.trim()).length < MIN_CONTENT_LENGTH) return null;
    return { text: buildMetadataText(title, abstract), source: 'metadata', sourceAttachmentId: null };
}

export interface FileIdentityCheck {
    /** Stat the files of these attachments (or all, when true) and drop stored text of changed files. */
    checkFileIdentity?: boolean | ReadonlySet<number>;
}


function shouldCheckFile(options: FileIdentityCheck, attachmentId: number): boolean {
    const check = options.checkFileIdentity;
    return check === true || (typeof check === 'object' && check.has(attachmentId));
}

async function attachmentContentHash(attachment: Zotero.Item): Promise<string | null> {
    try {
        return (await attachment.attachmentHash) || null;
    } catch {
        return null;
    }
}

/** Delete stored text of checked attachments whose file no longer matches it. */
async function dropChangedFileTexts(
    attachments: Iterable<Zotero.Item>,
    rows: Map<string, AttachmentEmbeddingTextRecord>,
    db: BeaverDB,
    options: FileIdentityCheck,
): Promise<void> {
    const stale: { libraryId: number; zoteroKey: string }[] = [];
    for (const attachment of attachments) {
        const refKey = attachmentRefKey(attachment.libraryID, attachment.key);
        const row = rows.get(refKey);
        if (!row || !shouldCheckFile(options, attachment.id)) continue;
        const path = await attachment.getFilePathAsync();
        if (path) {
            const signature = await getFileSignature(path).catch(() => null);
            if (!signature
                || (signature.mtime_ms === row.fileMtimeMs && signature.size_bytes === row.fileSizeBytes)) {
                continue;
            }
            // Downloads, sync and touches change the signature without changing
            // the content; the stored hash tells them apart.
            if (row.fileHash && await attachmentContentHash(attachment) === row.fileHash) {
                await db.updateAttachmentEmbeddingTextFile(attachment.libraryID, attachment.key, signature);
                continue;
            }
        } else {
            // Without a local file, compare with the synced file's hash; nothing is downloaded.
            const remoteHash = await getRemoteFileHash(attachment).catch(() => null);
            if (!remoteHash || !row.fileHash || remoteHash === row.fileHash) continue;
        }
        rows.delete(refKey);
        stale.push({ libraryId: attachment.libraryID, zoteroKey: attachment.key });
    }
    if (stale.length > 0) await db.deleteAttachmentEmbeddingTexts(stale);
}

/**
 * Resolve the text of every item with one batched best-attachment query and one
 * batched derived-text lookup. Items must have `itemData` loaded.
 */
export async function resolveUnitsBatch(
    items: Zotero.Item[],
    db: BeaverDB,
    options: FileIdentityCheck = {},
): Promise<UnitResolution[]> {
    // A corrupt item fails alone: errors are reported per item, not thrown.
    const needing = items.filter((item) => {
        try {
            return needsDerivedText(item);
        } catch {
            return false;
        }
    });
    const bestIds = needing.length > 0
        ? await getBestAttachmentBatch(needing.map((item) => item.id), EMBEDDABLE_CONTENT_TYPES)
        : new Map<number, number>();
    const attachmentIds = [...new Set(bestIds.values())];
    const attachments = new Map<number, Zotero.Item>();
    if (attachmentIds.length > 0) {
        for (const attachment of await Zotero.Items.getAsync(attachmentIds)) {
            if (attachment) attachments.set(attachment.id, attachment);
        }
    }
    const rows = await db.getAttachmentEmbeddingTexts(
        [...attachments.values()].map((a) => ({ libraryId: a.libraryID, zoteroKey: a.key })),
    );
    if (options.checkFileIdentity) {
        await dropChangedFileTexts(attachments.values(), rows, db, options);
    }

    return items.map((item) => {
        const attachmentId = bestIds.get(item.id);
        const attachment = attachmentId !== undefined ? attachments.get(attachmentId) : undefined;
        const kind = attachment ? liveAttachmentContentKind(attachment) : null;
        const candidate = attachment && (kind === 'pdf' || kind === 'epub' || kind === 'snapshot')
            ? {
                attachment,
                kind,
                row: rows.get(attachmentRefKey(attachment.libraryID, attachment.key)) ?? null,
            }
            : null;
        const derived = candidate?.row
            ? { attachmentId: candidate.attachment.id, keywords: candidate.row.keywords, body: candidate.row.body }
            : null;
        try {
            return { item, unit: resolveUnitText(item, derived), candidate };
        } catch (error) {
            return { item, unit: null, candidate: null, error };
        }
    });
}

/** A ledger verdict that further extraction of the same file cannot change. */
function isTerminalExtractionVerdict(
    ledger: Pick<AttachmentProcessingStateRecord, 'extractStatus' | 'ocrStatus'> | null | undefined,
): boolean {
    return ledger?.extractStatus === 'failed'
        || ledger?.extractStatus === 'skipped'
        || ledger?.ocrStatus === 'needed'
        || ledger?.ocrStatus === 'failed';
}

/**
 * Enqueue `document_extract` jobs for candidates whose derived text is missing
 * or outdated. Skips attachments outside the searchable libraries, files that
 * are not available locally, and attachments whose ledger holds a terminal
 * verdict for their current source. Candidates are enqueued in input order,
 * which the queue preserves within a priority. Returns the number of jobs.
 */
export async function enqueueEmbeddingExtractions(
    candidates: ExtractionCandidate[],
    db: BeaverDB,
): Promise<number> {
    const seen = new Set<number>();
    const pending: ExtractionCandidate[] = [];
    for (const candidate of candidates) {
        const { attachment, row } = candidate;
        if (seen.has(attachment.id) || !isLibraryInScope(attachment.libraryID)) continue;
        seen.add(attachment.id);
        if (row && row.textVersion >= EMBEDDING_TEXT_VERSION) continue;
        // Remote-only files are not downloaded for the index.
        if (!await attachment.getFilePathAsync()) continue;
        pending.push(candidate);
    }
    if (pending.length === 0) return 0;

    // Missing or outdated text defers to terminal ledger verdicts, unless the
    // source changed since the verdict was recorded.
    const ledgers = new Map<string, AttachmentProcessingStateRecord>();
    const refs = pending.map(({ attachment }) => ({ libraryId: attachment.libraryID, zoteroKey: attachment.key }));
    for (const ledger of await db.getAttachmentProcessingStatesByRefs(refs)) {
        ledgers.set(attachmentRefKey(ledger.libraryId, ledger.zoteroKey), ledger);
    }

    const now = Date.now();
    const jobs: BackgroundJobInput[] = [];
    for (const candidate of pending) {
        const { attachment, kind } = candidate;
        const ledger = ledgers.get(attachmentRefKey(attachment.libraryID, attachment.key));
        if (isTerminalExtractionVerdict(ledger)) {
            if (!ledger?.extractionSource) continue;
            const observed = await observeAttachmentSource(attachment, kind);
            if (!observed || observed.identity === ledger.extractionSource) continue;
            if (!isLibraryInScope(attachment.libraryID)) continue;
            // The verdict describes an earlier file or extractor. Reopen it, as
            // background processing does, so the next outcome is recorded for
            // the current source instead of retrying on every scan.
            await db.resetAttachmentExtraction(attachment.libraryID, attachment.key, 'source_recheck');
        }
        if (!isLibraryInScope(attachment.libraryID)) continue;
        jobs.push({
            jobType: 'document_extract',
            libraryId: attachment.libraryID,
            itemId: attachment.id,
            zoteroKey: attachment.key,
            contentKind: kind,
            payloadKind: 'structured',
            priority: EMBEDDING_EXTRACT_PRIORITY,
            payload: buildBackgroundExtractPayload(kind),
            now,
        });
    }
    if (jobs.length === 0) return 0;
    await db.enqueueBackgroundJobs(jobs);
    logger(`EmbeddingIndex: Enqueued ${jobs.length} extractions for derived text`, 3);
    Zotero.Beaver?.backgroundExtractor?.notify();
    return jobs.length;
}
