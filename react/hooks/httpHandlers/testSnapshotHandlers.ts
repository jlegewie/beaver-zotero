/**
 * Dev-only HTTP handler for the `/beaver/test/snapshot-extract` endpoint.
 *
 * Runs the snapshot extractor over a raw HTML file path or a Zotero attachment
 * ref, and returns the extracted `SnapshotDocument` plus structural stats used to
 * triage extraction quality. Wired to its path in `useHttpEndpoints.ts`.
 */

import {
    extractSnapshotDocument,
    extractSnapshotDocumentFromFile,
    type SnapshotDocument,
} from '../../../src/services/documentExtraction/snapshot';
import type {
    DomItem,
    DomItemKind,
    DomSection,
} from '../../../src/services/documentExtraction/dom/schema';
import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';

const DEFAULT_SHORT_SENTENCE_CHARS = 15;
const DEFAULT_LONG_SENTENCE_CHARS = 600;

function emptyKindCounts(): Record<DomItemKind, number> {
    return {
        text: 0,
        section_header: 0,
        list_item: 0,
        caption: 0,
        footnote: 0,
        table: 0,
        picture: 0,
    };
}

function truncate(text: string, max = 200): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function computeStats(document: SnapshotDocument, shortChars: number, longChars: number) {
    const itemsByKind = emptyKindCounts();
    let itemCount = 0;
    let sentenceCount = 0;
    let emptyTextItems = 0;
    let sentenceBearingItems = 0;
    let shortSentences = 0;
    let longSentences = 0;
    let totalSentenceChars = 0;
    let maxSentenceChars = 0;

    let itemsWithPageNumber = 0;
    let itemsMissingPageNumber = 0;
    let itemsWithPageLabel = 0;
    let maxPageNumber = 0;
    let minPageNumber = Infinity;
    let prevPageNumber = -Infinity;
    let pageMonotonic = true;

    const firstItems: { id: string; kind: DomItemKind; text: string }[] = [];
    const shortSentenceSamples: { id: string; itemId: string; text: string }[] = [];
    const longSentenceSamples: { id: string; itemId: string; text: string }[] = [];

    for (const section of document.sections as DomSection[]) {
        for (const item of section.items as DomItem[]) {
            itemCount += 1;
            itemsByKind[item.kind] += 1;
            if (!item.text || item.text.trim().length === 0) emptyTextItems += 1;

            const pageNumber = item.pageNumber;
            if (typeof pageNumber === 'number') {
                itemsWithPageNumber += 1;
                if (pageNumber > maxPageNumber) maxPageNumber = pageNumber;
                if (pageNumber < minPageNumber) minPageNumber = pageNumber;
                if (pageNumber < prevPageNumber) pageMonotonic = false;
                prevPageNumber = pageNumber;
            } else {
                itemsMissingPageNumber += 1;
            }
            // Snapshots should never carry a publisher page label.
            if (item.pageLabel) itemsWithPageLabel += 1;

            if (firstItems.length < 25) {
                firstItems.push({ id: item.id, kind: item.kind, text: truncate(item.text ?? '', 160) });
            }

            const sentences = item.sentences ?? [];
            if (sentences.length > 0) sentenceBearingItems += 1;
            for (const sentence of sentences) {
                sentenceCount += 1;
                const len = sentence.text.length;
                totalSentenceChars += len;
                if (len > maxSentenceChars) maxSentenceChars = len;
                if (len <= shortChars && shortSentenceSamples.length < 25) {
                    shortSentenceSamples.push({ id: sentence.id, itemId: item.id, text: sentence.text });
                }
                if (len <= shortChars) shortSentences += 1;
                if (len >= longChars) {
                    longSentences += 1;
                    if (longSentenceSamples.length < 15) {
                        longSentenceSamples.push({ id: sentence.id, itemId: item.id, text: truncate(sentence.text, 400) });
                    }
                }
            }
        }
    }

    const pageCount = typeof document.pageCount === 'number' ? document.pageCount : null;
    return {
        stats: {
            sectionCount: document.sectionCount,
            itemCount,
            sentenceCount,
            itemsByKind,
            emptyTextItems,
            sentenceBearingItems,
            shortSentences,
            longSentences,
            avgSentenceChars: sentenceCount > 0 ? Math.round(totalSentenceChars / sentenceCount) : 0,
            maxSentenceChars,
            pages: {
                pageCount,
                maxPageNumber,
                itemsWithPageNumber,
                itemsMissingPageNumber,
                itemsWithPageLabel,
                monotonic: pageMonotonic,
                startsAtOne: itemsWithPageNumber === 0 ? false : minPageNumber === 1,
                pageCountMatchesMax: pageCount !== null && pageCount === maxPageNumber,
            },
        },
        sample: {
            sectionLabel: document.sections[0]?.label ?? null,
            sectionRawHref: document.sections[0]?.rawHref ?? null,
            firstItems,
            shortSentenceSamples,
            longSentenceSamples,
        },
    };
}

/**
 * Extract a snapshot and return structural stats for quality triage.
 *
 * Accepts either `{ file_path }` (any absolute HTML path) or
 * `{ library_id, zotero_key }` (a real snapshot attachment). Pass
 * `include_document: true` to also return the full `SnapshotDocument` (large).
 */
export async function handleTestSnapshotExtractHttpRequest(request: any): Promise<any> {
    const shortChars = typeof request?.short_sentence_chars === 'number'
        ? request.short_sentence_chars
        : DEFAULT_SHORT_SENTENCE_CHARS;
    const longChars = typeof request?.long_sentence_chars === 'number'
        ? request.long_sentence_chars
        : DEFAULT_LONG_SENTENCE_CHARS;
    const includeDocument = request?.include_document === true;

    let source: Record<string, unknown>;
    let document: SnapshotDocument;
    const startedAt = Date.now();

    try {
        if (typeof request?.file_path === 'string' && request.file_path.length > 0) {
            const filePath = request.file_path as string;
            const exists = await IOUtils.exists(filePath).catch(() => false);
            if (!exists) {
                return { ok: false, error: { name: 'Error', message: `File not found: ${filePath}` } };
            }
            source = { kind: 'file_path', file_path: filePath };
            document = await extractSnapshotDocumentFromFile(filePath, {
                language: typeof request?.language === 'string' ? request.language : undefined,
            });
        } else if (request?.library_id != null && request?.zotero_key != null) {
            if (request.library_id === UNRESOLVED_LIBRARY_ID) {
                return { ok: false, error: { name: 'Error', message: 'Library not available on this device' } };
            }
            const item = await Zotero.Items.getByLibraryAndKeyAsync(request.library_id, request.zotero_key);
            if (!item || !item.isAttachment()) {
                return { ok: false, error: { name: 'Error', message: 'Item is not an attachment' } };
            }
            source = { kind: 'attachment', library_id: request.library_id, zotero_key: request.zotero_key };
            document = await extractSnapshotDocument(item);
        } else {
            return {
                ok: false,
                error: { name: 'Error', message: 'Provide file_path, or library_id + zotero_key' },
            };
        }
    } catch (e: any) {
        return {
            ok: false,
            error: { name: e?.name ?? 'Error', message: e instanceof Error ? e.message : String(e) },
        };
    }

    const extractMs = Date.now() - startedAt;
    const { stats, sample } = computeStats(document, shortChars, longChars);

    return {
        ok: true,
        source,
        timing: { extractMs },
        thresholds: { shortChars, longChars },
        diagnostics: document.diagnostics,
        stats,
        sample,
        ...(includeDocument ? { document } : {}),
    };
}
