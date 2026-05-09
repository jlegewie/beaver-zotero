/**
 * Live regression tests for sentence-level PDF extraction.
 *
 * For each captured fixture under `tests/fixtures/pdfs/sentences/`, this
 * suite calls `/beaver/test/pdf-sentence-bboxes` (which routes through
 * the production worker sentence extraction op) and compares the live
 * output against `fixture.json#expected`. End-to-end coverage: PDF bytes
 * → MuPDF worker → paragraph detection → sentencex splitter → mapper.
 *
 * Catches what the unit tier cannot:
 *  - MuPDF wrapper drift (ligatures, char/quad indexing)
 *  - sentencex splitter drift
 *  - language-detection / pref changes
 *
 * Skips cleanly when Zotero is not running. Each fixture must reference
 * an item present in the developer's Zotero library — they were captured
 * there in the first place.
 *
 * Run: `npm run test:live -- sentenceFixtures`
 */

import { describe, it, beforeAll, beforeEach } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { pdfSentenceBBoxes } from '../helpers/cacheInspector';
import {
    defaultFixtureRoot,
    expectSentencesMatch,
    loadFixtures,
    type ActualSentenceResult,
    type FixtureBBox,
} from '../helpers/sentenceFixtureHelper';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const fixtureRoot = defaultFixtureRoot();
const fixtures = loadFixtures(fixtureRoot);

describe('sentence-extraction fixtures (live)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    if (fixtures.length === 0) {
        it.skip(`no fixtures in ${fixtureRoot} — capture some via the reader menu`, () => {});
        return;
    }

    for (const fx of fixtures) {
        it(`${fx.folderName} — matches expected`, async () => {
            const res = await pdfSentenceBBoxes(
                {
                    library_id: fx.fixture.source.libraryID,
                    zotero_key: fx.fixture.source.itemKey,
                },
                { page_index: fx.fixture.source.pageIndex },
            );
            if (!res.ok) {
                throw new Error(
                    `pdf-sentence-bboxes failed for ${fx.folderName}: ` +
                        `${JSON.stringify(res.error ?? {})}`,
                );
            }
            const actual = normalizeLiveResult(res.result);
            expectSentencesMatch(actual, fx.fixture.expected, {
                tolerancePt: fx.fixture.tolerance.bboxAbsPt,
                source: fx.fixture.source,
                folder: fx.folder,
            });
        });
    }
});

/**
 * Normalize the live `PageSentenceBBoxResult` payload into the shape the
 * shared comparator expects.
 */
function normalizeLiveResult(result: any): ActualSentenceResult {
    const sentences = (result?.sentences ?? []).map((s: any) => ({
        text: String(s.text ?? ''),
        kind: (s.kind === 'heading' ? 'heading' : 'text') as 'text' | 'heading',
        bboxes: (s.bboxes ?? []).map((b: any): FixtureBBox => ({
            x: Number(b.x),
            y: Number(b.y),
            w: Number(b.w),
            h: Number(b.h),
        })),
    }));
    const paragraphs = (result?.paragraphs ?? []).map((p: any) => ({
        sentences: (p.sentences ?? []).map((s: any) => ({
            text: String(s.text ?? ''),
        })),
    }));
    const deg = result?.degradation;
    return {
        sentences,
        paragraphs,
        degradation: deg
            ? {
                  count: Number(deg.count ?? 0),
                  notes: Array.isArray(deg.notes) ? deg.notes : [],
              }
            : undefined,
    };
}
