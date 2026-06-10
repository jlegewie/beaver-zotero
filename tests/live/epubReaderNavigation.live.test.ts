/**
 * EPUB reader-state + citation-navigation live suite (plan F-4 / F-5).
 *
 * Drives two dev endpoints against the live reader:
 *   - `/beaver/test/reader-state` — the `getReaderState` position fields:
 *     `current_page` (1-based EPUB section ordinal via `getCurrentPage`) and
 *     `content_kind` from `reader.type`; PDF readers keep page semantics.
 *   - `/beaver/test/epub-citation-navigate` — the citation-click path:
 *     `resolveEpubCitationRange` (href/ordinal section resolution, anchor-id
 *     scoping, sentence-text range anchoring) and the full
 *     `navigateToEpubCitation` flow including the temporary-annotation flash.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Fixture attachments seeded (NON_PDF — a multi-section EPUB, SMALL_PDF).
 *   - Opens reader tabs in the running Zotero.
 *
 * Run with: `npm run test:live -- epubReaderNavigation`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { fetchDocument, post } from '../helpers/zoteroHttpClient';
import { NON_PDF, SMALL_PDF } from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

// Opening a reader + cold extraction can take a while on first hit.
const READER_TIMEOUT = 60_000;

interface ReaderStateResponse {
    ok: boolean;
    error?: string;
    reader_type?: string | null;
    current_page?: number | null;
    content_kind?: 'pdf' | 'epub' | null;
    section_count?: number | null;
}

interface CitationNavigateResponse {
    ok: boolean;
    error?: string;
    outcome?: 'highlighted' | 'section' | 'opened' | 'failed';
    temporary_annotation_count?: number;
    resolved?: boolean;
    section_index?: number;
    has_range?: boolean;
    range_text?: string | null;
    range_anchor_id?: string | null;
    section_count?: number;
}

function readerState(body: Record<string, unknown>): Promise<ReaderStateResponse> {
    return post('/beaver/test/reader-state', body, { timeout: READER_TIMEOUT });
}

function navigateCitation(
    body: Record<string, unknown>,
): Promise<CitationNavigateResponse> {
    return post('/beaver/test/epub-citation-navigate', body, { timeout: READER_TIMEOUT });
}

function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

interface EpubSentenceFixture {
    sectionIndex: number;
    sectionOrdinal: number;
    rawHref: string;
    anchorId?: string;
    text: string;
}

interface EpubDocumentShape {
    sectionCount: number;
    sections: {
        index: number;
        rawHref: string;
        items: {
            id: string;
            kind: string;
            text?: string;
            anchorId?: string;
            sentences?: { id: string; text: string }[];
        }[];
    }[];
}

let cachedDoc: EpubDocumentShape | null = null;

/** Fetch the extracted EPUB document once; tests pick citation targets from it. */
async function getEpubDocument(): Promise<EpubDocumentShape> {
    if (cachedDoc) return cachedDoc;
    const res = await fetchDocument(NON_PDF, { mode: 'markdown' }, { timeout: READER_TIMEOUT });
    const doc = res.result as unknown as EpubDocumentShape | null;
    if (!doc || !Array.isArray(doc.sections)) {
        throw new Error(`No EPUB document for fixture: ${JSON.stringify(res.error ?? res)}`);
    }
    cachedDoc = doc;
    return doc;
}

/** Pick a mid-length anchored sentence from a mid-document section. */
async function pickAnchoredSentence(): Promise<EpubSentenceFixture> {
    const doc = await getEpubDocument();
    for (const section of doc.sections) {
        if (section.index === 0) continue; // skip cover/front matter
        for (const item of section.items) {
            if (item.kind !== 'text' || !item.anchorId) continue;
            for (const sentence of item.sentences ?? []) {
                const text = normalize(sentence.text);
                if (text.length >= 40 && text.length <= 240) {
                    return {
                        sectionIndex: section.index,
                        sectionOrdinal: section.index + 1,
                        rawHref: section.rawHref,
                        anchorId: item.anchorId,
                        text,
                    };
                }
            }
        }
    }
    throw new Error('Fixture EPUB has no anchored mid-length sentence to cite');
}

/**
 * Find one normalized text that occurs at two distinct locations (different
 * section, or different anchor within a section) — a repeated phrase for the
 * disambiguation test. Returns null when the fixture has no repeats.
 */
async function pickRepeatedText(): Promise<
    { text: string; occurrences: EpubSentenceFixture[] } | null
> {
    const doc = await getEpubDocument();
    const byText = new Map<string, EpubSentenceFixture[]>();
    for (const section of doc.sections) {
        for (const item of section.items) {
            const candidates = [
                ...(item.text ? [item.text] : []),
                ...(item.sentences ?? []).map((s) => s.text),
            ];
            for (const raw of candidates) {
                const text = normalize(raw);
                if (text.length < 12 || text.length > 240) continue;
                const list = byText.get(text) ?? [];
                const isNewLocation = !list.some(
                    (o) =>
                        o.sectionIndex === section.index
                        && o.anchorId === item.anchorId,
                );
                if (isNewLocation) {
                    list.push({
                        sectionIndex: section.index,
                        sectionOrdinal: section.index + 1,
                        rawHref: section.rawHref,
                        anchorId: item.anchorId,
                        text,
                    });
                }
                byText.set(text, list);
            }
        }
    }
    for (const [text, occurrences] of byText) {
        if (occurrences.length >= 2) return { text, occurrences };
    }
    return null;
}

describe('reader state (F-5)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it(
        'reports the EPUB section ordinal as current_page with content_kind epub',
        { timeout: READER_TIMEOUT },
        async () => {
            const state = await readerState(NON_PDF);
            expect(state.ok).toBe(true);
            expect(state.reader_type).toBe('epub');
            expect(state.content_kind).toBe('epub');
            expect(state.section_count).toBeGreaterThan(0);
            // 1-based ordinal within the spine.
            expect(state.current_page).toBeGreaterThanOrEqual(1);
            expect(state.current_page).toBeLessThanOrEqual(state.section_count!);
            expect(Number.isInteger(state.current_page)).toBe(true);
        },
    );

    it(
        'keeps PDF reader semantics unchanged (page number, content_kind pdf)',
        { timeout: READER_TIMEOUT },
        async () => {
            const state = await readerState(SMALL_PDF);
            expect(state.ok).toBe(true);
            expect(state.reader_type).toBe('pdf');
            expect(state.content_kind).toBe('pdf');
            expect(state.current_page).toBeGreaterThanOrEqual(1);
        },
    );
});

describe('EPUB citation navigation (F-4)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it(
        'anchors the cited sentence to a precise live-DOM range via section href',
        { timeout: READER_TIMEOUT },
        async () => {
            const target = await pickAnchoredSentence();
            const res = await navigateCitation({
                ...NON_PDF,
                section_href: target.rawHref,
                anchor_id: target.anchorId,
                text: target.text,
            });
            expect(res.ok).toBe(true);
            expect(res.resolved).toBe(true);
            // All-XHTML fixture spine: extraction section indexes are 1:1
            // with the reader's spine indexes.
            expect(res.section_index).toBe(target.sectionIndex);
            expect(res.has_range).toBe(true);
            expect(normalize(res.range_text ?? '')).toBe(target.text);
        },
    );

    it(
        'falls back to the 1-based section ordinal when no href is given',
        { timeout: READER_TIMEOUT },
        async () => {
            const target = await pickAnchoredSentence();
            const res = await navigateCitation({
                ...NON_PDF,
                section_ordinal: target.sectionOrdinal,
            });
            expect(res.ok).toBe(true);
            expect(res.resolved).toBe(true);
            expect(res.section_index).toBe(target.sectionOrdinal - 1);
            // No text/anchor: coarse section-only resolution.
            expect(res.has_range).toBe(false);
        },
    );

    it(
        'resolves the section without a range for text that does not exist',
        { timeout: READER_TIMEOUT },
        async () => {
            const target = await pickAnchoredSentence();
            const res = await navigateCitation({
                ...NON_PDF,
                section_href: target.rawHref,
                text: 'This exact sentence does not appear anywhere in the fixture book.',
            });
            expect(res.ok).toBe(true);
            expect(res.resolved).toBe(true);
            expect(res.section_index).toBe(target.sectionIndex);
            expect(res.has_range).toBe(false);
        },
    );

    it(
        'disambiguates a repeated phrase by anchor id',
        { timeout: READER_TIMEOUT },
        async (ctx) => {
            const repeated = await pickRepeatedText();
            if (!repeated) {
                // Fixture has no repeated text; anchor scoping is still
                // covered by the precise-range test above.
                ctx.skip();
                return;
            }
            const [first, second] = repeated.occurrences;
            const resFirst = await navigateCitation({
                ...NON_PDF,
                section_href: first.rawHref,
                anchor_id: first.anchorId,
                text: repeated.text,
            });
            const resSecond = await navigateCitation({
                ...NON_PDF,
                section_href: second.rawHref,
                anchor_id: second.anchorId,
                text: repeated.text,
            });
            expect(resFirst.ok).toBe(true);
            expect(resSecond.ok).toBe(true);
            expect(resFirst.has_range).toBe(true);
            expect(resSecond.has_range).toBe(true);
            // Each resolution lands at its own occurrence (its section/anchor),
            // not at the document-wide first match of the repeated text.
            expect(resFirst.section_index).toBe(first.sectionIndex);
            expect(resSecond.section_index).toBe(second.sectionIndex);
            if (first.anchorId) {
                expect(resFirst.range_anchor_id).toBe(first.anchorId);
            }
            if (second.anchorId) {
                expect(resSecond.range_anchor_id).toBe(second.anchorId);
            }
            expect(
                resFirst.section_index !== resSecond.section_index
                || resFirst.range_anchor_id !== resSecond.range_anchor_id,
            ).toBe(true);
        },
    );

    it(
        'full navigation flow flashes a temporary highlight annotation',
        { timeout: READER_TIMEOUT },
        async () => {
            const target = await pickAnchoredSentence();
            const res = await navigateCitation({
                ...NON_PDF,
                mode: 'navigate',
                section_href: target.rawHref,
                anchor_id: target.anchorId,
                text: target.text,
                preview_text: 'Live-test citation flash',
                use_temporary_annotations: true,
                cleanup: true,
            });
            expect(res.ok).toBe(true);
            expect(res.outcome).toBe('highlighted');
            expect(res.temporary_annotation_count).toBeGreaterThanOrEqual(1);
        },
    );
});
