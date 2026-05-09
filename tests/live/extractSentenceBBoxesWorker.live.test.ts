/**
 * Live tests for the worker-backed `PDFExtractor.extractSentenceBBoxes`
 * with each `SentenceSplitterConfig` variant.
 *
 * After Step 1, `/beaver/test/pdf-sentence-bboxes` routes through the
 * worker op. This suite exercises both splitter configs against a real
 * fixture page and asserts:
 *   - both variants succeed end-to-end,
 *   - sentencex output ≠ simple output for at least one fixture (so we
 *     know sentencex actually ran inside the worker — not silently
 *     fallback'd to the regex splitter).
 *
 * Skips cleanly when Zotero is not running.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { pdfSentenceBBoxes } from '../helpers/cacheInspector';
import {
    defaultFixtureRoot,
    loadFixtures,
} from '../helpers/sentenceFixtureHelper';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const fixtureRoot = defaultFixtureRoot();
const fixtures = loadFixtures(fixtureRoot);

// Pick a stable, non-trivial fixture for the per-config smoke checks.
// Any fixture with at least a few sentences is fine; sort-stability of
// `loadFixtures` makes this deterministic.
const probeFixture = fixtures[0];

describe('extractSentenceBBoxes worker — splitter config (live)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    if (!probeFixture) {
        it.skip(`no fixtures in ${fixtureRoot}`, () => {});
        return;
    }

    const attachment = {
        library_id: probeFixture.fixture.source.libraryID,
        zotero_key: probeFixture.fixture.source.itemKey,
    };
    const pageIndex = probeFixture.fixture.source.pageIndex;

    it('{ type: "simple" } returns a parseable result', async () => {
        const res = await pdfSentenceBBoxes(attachment, {
            page_index: pageIndex,
            options: { splitter: { type: 'simple' } },
        });
        if (!res.ok) {
            throw new Error(
                `pdf-sentence-bboxes (simple) failed for ${probeFixture.folderName}: ` +
                    `${JSON.stringify(res.error ?? {})}`,
            );
        }
        const result = res.result as any;
        expect(Array.isArray(result?.sentences)).toBe(true);
        expect(Array.isArray(result?.paragraphs)).toBe(true);
        expect(result.sentences.length).toBeGreaterThan(0);
    });

    it('{ type: "sentencex" } returns a parseable result', async () => {
        const res = await pdfSentenceBBoxes(attachment, {
            page_index: pageIndex,
            options: { splitter: { type: 'sentencex' } },
        });
        if (!res.ok) {
            throw new Error(
                `pdf-sentence-bboxes (sentencex) failed for ${probeFixture.folderName}: ` +
                    `${JSON.stringify(res.error ?? {})}`,
            );
        }
        const result = res.result as any;
        expect(Array.isArray(result?.sentences)).toBe(true);
        expect(result.sentences.length).toBeGreaterThan(0);
    });

    it('sentencex and simple disagree on at least one fixture (proves sentencex ran)', async () => {
        // If sentencex silently fell back to the regex splitter inside the
        // worker, every fixture would produce identical output for both
        // configs. Across the captured fixtures we expect at least one
        // sentence-count divergence (sentencex is rule-based and strictly
        // more conservative than the regex on common English prose).
        const sample = fixtures.slice(0, 5);
        let foundDivergence = false;

        for (const fx of sample) {
            const att = {
                library_id: fx.fixture.source.libraryID,
                zotero_key: fx.fixture.source.itemKey,
            };
            const idx = fx.fixture.source.pageIndex;
            const [simple, sentencex] = await Promise.all([
                pdfSentenceBBoxes(att, {
                    page_index: idx,
                    options: { splitter: { type: 'simple' } },
                }),
                pdfSentenceBBoxes(att, {
                    page_index: idx,
                    options: { splitter: { type: 'sentencex' } },
                }),
            ]);
            if (!simple.ok || !sentencex.ok) continue;
            const simpleSents = (simple.result as any).sentences;
            const sentencexSents = (sentencex.result as any).sentences;
            // Different sentence counts, OR same count but different first
            // sentence text (regex misses some sentence-final punctuation
            // patterns that sentencex catches and vice versa).
            if (
                simpleSents.length !== sentencexSents.length ||
                simpleSents[0]?.text !== sentencexSents[0]?.text
            ) {
                foundDivergence = true;
                break;
            }
        }

        expect(foundDivergence).toBe(true);
    }, 90_000);
});
