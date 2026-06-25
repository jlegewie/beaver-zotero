/**
 * Dev-only HTTP handler for the `/beaver/test/epub-extract` endpoint.
 *
 * Runs the EPUB extractor over a raw file path (corpus files that are not
 * Zotero attachments) or an attachment ref, and returns the extracted
 * `EpubDocument` plus structural stats used to triage extraction quality
 * across a corpus. Wired to its path in `useHttpEndpoints.ts`.
 */

import {
    extractEpubDocument,
    extractEpubDocumentFromFile,
    type EpubDocument,
} from '../../../src/services/documentExtraction/epub';
import type {
    DomItem,
    DomItemKind,
    DomSection,
} from '../../../src/services/documentExtraction/dom/schema';

// Sentences at or below this length are flagged as likely fragments or
// over-eager sentence splits; sentences at or above the long threshold likely
// missed a boundary (e.g. an abbreviation or a label with no terminal punct).
const DEFAULT_SHORT_SENTENCE_CHARS = 15;
const DEFAULT_LONG_SENTENCE_CHARS = 600;

interface EpubExtractStats {
    sectionCount: number;
    itemCount: number;
    sentenceCount: number;
    itemsByKind: Record<DomItemKind, number>;
    emptySections: number;
    sectionsWithoutLabel: number;
    emptyTextItems: number;
    sentenceBearingItems: number;
    shortSentences: number;
    longSentences: number;
    avgSentenceChars: number;
    maxSentenceChars: number;
    avgItemsPerSection: number;
    maxItemsInSection: number;
    pages: EpubPageStats;
}

// Page-number health, for validating the per-item `pageNumber` coordinate and
// optional physical `pageLabel` markers across a corpus.
interface EpubPageStats {
    /** `document.pageCount` (max stamped page number), or null if absent. */
    pageCount: number | null;
    /** Max `pageNumber` observed across items (0 when no items carry one). */
    maxPageNumber: number;
    itemsWithPageNumber: number;
    itemsMissingPageNumber: number;
    /** Items carrying a publisher page marker (physical-paging signal). */
    itemsWithPageLabel: number;
    /** True when any item carries a `pageLabel` (physical marker mapping used). */
    isPhysicalPaging: boolean;
    /** `pageNumber` is non-decreasing across reading order (section, then item order). */
    monotonic: boolean;
    /** Smallest `pageNumber` across items is 1 (the expected origin). */
    startsAtOne: boolean;
    /** `document.pageCount` equals the max observed `pageNumber`. */
    pageCountMatchesMax: boolean;
}

interface EpubExtractSample {
    sectionLabels: string[];
    firstItems: { id: string; kind: DomItemKind; text: string }[];
    shortSentenceSamples: { id: string; itemId: string; text: string }[];
    longSentenceSamples: { id: string; itemId: string; text: string }[];
}

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

function computeStats(
    document: EpubDocument,
    shortChars: number,
    longChars: number,
): { stats: EpubExtractStats; sample: EpubExtractSample } {
    const itemsByKind = emptyKindCounts();
    let itemCount = 0;
    let sentenceCount = 0;
    let emptySections = 0;
    let sectionsWithoutLabel = 0;
    let emptyTextItems = 0;
    let sentenceBearingItems = 0;
    let shortSentences = 0;
    let longSentences = 0;
    let totalSentenceChars = 0;
    let maxSentenceChars = 0;
    let maxItemsInSection = 0;

    // Page-number tracking. `document.sections`/`section.items` are already in
    // raw spine + DOM order, which is the reading order page numbers are stamped
    // against, so a single pass validates monotonicity.
    let itemsWithPageNumber = 0;
    let itemsMissingPageNumber = 0;
    let itemsWithPageLabel = 0;
    let maxPageNumber = 0;
    let minPageNumber = Infinity;
    let prevPageNumber = -Infinity;
    let pageMonotonic = true;

    const sectionLabels: string[] = [];
    const firstItems: EpubExtractSample['firstItems'] = [];
    const shortSentenceSamples: EpubExtractSample['shortSentenceSamples'] = [];
    const longSentenceSamples: EpubExtractSample['longSentenceSamples'] = [];

    for (const section of document.sections as DomSection[]) {
        if (section.items.length === 0) emptySections += 1;
        if (!section.label) sectionsWithoutLabel += 1;
        else if (sectionLabels.length < 20) sectionLabels.push(section.label);
        if (section.items.length > maxItemsInSection) {
            maxItemsInSection = section.items.length;
        }

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
            if (item.pageLabel) itemsWithPageLabel += 1;
            if (firstItems.length < 25) {
                firstItems.push({
                    id: item.id,
                    kind: item.kind,
                    text: truncate(item.text ?? '', 160),
                });
            }

            const sentences = item.sentences ?? [];
            if (sentences.length > 0) sentenceBearingItems += 1;
            for (const sentence of sentences) {
                sentenceCount += 1;
                const len = sentence.text.length;
                totalSentenceChars += len;
                if (len > maxSentenceChars) maxSentenceChars = len;
                if (len <= shortChars) {
                    shortSentences += 1;
                    if (shortSentenceSamples.length < 25) {
                        shortSentenceSamples.push({
                            id: sentence.id,
                            itemId: item.id,
                            text: sentence.text,
                        });
                    }
                }
                if (len >= longChars) {
                    longSentences += 1;
                    if (longSentenceSamples.length < 15) {
                        longSentenceSamples.push({
                            id: sentence.id,
                            itemId: item.id,
                            text: truncate(sentence.text, 400),
                        });
                    }
                }
            }
        }
    }

    const sectionCount = document.sectionCount;
    const pageCount = typeof document.pageCount === 'number' ? document.pageCount : null;
    const pages: EpubPageStats = {
        pageCount,
        maxPageNumber,
        itemsWithPageNumber,
        itemsMissingPageNumber,
        itemsWithPageLabel,
        isPhysicalPaging: itemsWithPageLabel > 0,
        monotonic: pageMonotonic,
        startsAtOne: itemsWithPageNumber === 0 ? false : minPageNumber === 1,
        pageCountMatchesMax: pageCount !== null && pageCount === maxPageNumber,
    };
    const stats: EpubExtractStats = {
        sectionCount,
        itemCount,
        sentenceCount,
        itemsByKind,
        emptySections,
        sectionsWithoutLabel,
        emptyTextItems,
        sentenceBearingItems,
        shortSentences,
        longSentences,
        avgSentenceChars: sentenceCount > 0
            ? Math.round(totalSentenceChars / sentenceCount)
            : 0,
        maxSentenceChars,
        avgItemsPerSection: sectionCount > 0
            ? Math.round((itemCount / sectionCount) * 10) / 10
            : 0,
        maxItemsInSection,
        pages,
    };

    return {
        stats,
        sample: {
            sectionLabels,
            firstItems,
            shortSentenceSamples,
            longSentenceSamples,
        },
    };
}

/**
 * Extract an EPUB and return structural stats for corpus-quality triage.
 *
 * Accepts either `{ file_path }` (any absolute path; the corpus driver uses
 * this) or `{ library_id, zotero_key }` (a real EPUB attachment). Pass
 * `include_document: true` to also return the full `EpubDocument` (large).
 */
export async function handleTestEpubExtractHttpRequest(request: any): Promise<any> {
    const shortChars = typeof request?.short_sentence_chars === 'number'
        ? request.short_sentence_chars
        : DEFAULT_SHORT_SENTENCE_CHARS;
    const longChars = typeof request?.long_sentence_chars === 'number'
        ? request.long_sentence_chars
        : DEFAULT_LONG_SENTENCE_CHARS;
    const includeDocument = request?.include_document === true;

    let source: Record<string, unknown>;
    let document: EpubDocument;
    const startedAt = Date.now();

    try {
        if (typeof request?.file_path === 'string' && request.file_path.length > 0) {
            const filePath = request.file_path as string;
            const exists = await IOUtils.exists(filePath).catch(() => false);
            if (!exists) {
                return {
                    ok: false,
                    error: { name: 'Error', message: `File not found: ${filePath}` },
                };
            }
            source = { kind: 'file_path', file_path: filePath };
            document = await extractEpubDocumentFromFile(filePath, {
                language: typeof request?.language === 'string' ? request.language : undefined,
            });
        } else if (request?.library_id != null && request?.zotero_key != null) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                request.library_id,
                request.zotero_key,
            );
            if (!item || !item.isAttachment()) {
                return {
                    ok: false,
                    error: { name: 'Error', message: 'Item is not an attachment' },
                };
            }
            source = {
                kind: 'attachment',
                library_id: request.library_id,
                zotero_key: request.zotero_key,
            };
            document = await extractEpubDocument(item);
        } else {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: 'Provide file_path, or library_id + zotero_key',
                },
            };
        }
    } catch (e: any) {
        return {
            ok: false,
            error: {
                name: e?.name ?? 'Error',
                message: e instanceof Error ? e.message : String(e),
            },
        };
    }

    const extractMs = Date.now() - startedAt;
    const { stats, sample } = computeStats(document, shortChars, longChars);

    return {
        ok: true,
        source,
        timing: { extractMs },
        thresholds: { shortChars, longChars },
        // Authoritative text-coverage signal, computed inside the extractor and
        // carried on the document model.
        diagnostics: document.diagnostics,
        stats,
        sample,
        ...(includeDocument ? { document } : {}),
    };
}
