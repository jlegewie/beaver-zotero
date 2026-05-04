/**
 * Sentence-extraction regression suite.
 *
 * Auto-discovers JSON fixtures under
 * `tests/fixtures/sentence-extraction/` and replays each one against a
 * running Zotero by hitting `/beaver/test/pdf-sentence-bboxes`. A
 * fixture mismatch surfaces structured diffs (page width/height,
 * paragraph/sentence counts, per-sentence text, per-bbox coords within
 * a 0.5pt tolerance) plus a reproduce-curl pointing at the offending
 * page.
 *
 * To capture a fixture: open a PDF in Zotero (dev build), navigate to
 * the page of interest, then click Dev Tools → "Capture Sentence
 * Fixture (current page)". Re-clicking on the same page overwrites the
 * file. See `tests/README.md` for details.
 *
 * Run: `npm run test:live -- sentenceExtractionFixtures`. Tests skip
 * gracefully when Zotero is unavailable; an empty fixtures dir
 * collapses to a single `it.skip` placeholder.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { pdfSentenceBBoxes } from '../helpers/cacheInspector';
import {
    loadAllSentenceFixtures,
    diffSentenceFixture,
    formatFailure,
} from '../helpers/sentenceFixtures';

const fixtures = loadAllSentenceFixtures();

describe('Sentence extraction fixtures (real-world PDFs)', () => {
    let available = false;
    beforeAll(async () => {
        available = await isZoteroAvailable();
        if (!available) {
            console.warn(
                '\n⚠  Zotero not available — sentence-extraction fixture tests will be skipped.\n',
            );
        }
    });

    if (fixtures.length === 0) {
        it.skip(
            'no fixtures captured yet — use the "Capture Sentence Fixture (current page)" dev menu item',
            () => {
                /* placeholder so the suite is non-empty */
            },
        );
        return;
    }

    for (const f of fixtures) {
        it(f.name, async (ctx) => {
            skipIfNoZotero(ctx, available);
            const res = await pdfSentenceBBoxes(
                {
                    library_id: f.source.libraryId,
                    zotero_key: f.source.zoteroKey,
                    description: f.name,
                },
                { page_index: f.source.pageIndex },
            );
            const diffs = diffSentenceFixture(f, res);
            if (diffs.length > 0) {
                expect.fail(formatFailure(f, diffs));
            }
        });
    }
});
