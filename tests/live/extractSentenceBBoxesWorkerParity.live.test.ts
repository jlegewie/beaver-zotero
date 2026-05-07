/**
 * Step-1 parity gate (live).
 *
 * Hits `/beaver/test/pdf-sentence-bboxes-parity`, which runs both:
 *   - the legacy main-thread `runSentenceExtractionPipeline()`, and
 *   - the new `getMuPDFWorkerClient().extractSentenceBBoxes()` worker op,
 *
 * against the same fixture page and returns both `PageSentenceBBoxResult`
 * payloads. This test deep-equals them. Both must match byte-for-byte
 * before the `PDFExtractor` facade flips to the worker path.
 *
 * Iterates the captured fixtures under `tests/fixtures/pdfs/sentences/`
 * to maximize coverage across single/double-column, headings, multi-line
 * sentences, dehyphenation, and language variation.
 *
 * After Step 6 (trace/debug migrate to the worker) this test and the
 * `pdf-sentence-bboxes-parity` endpoint can be removed — the worker
 * becomes the only path and there's no main-thread pipeline left to
 * compare against.
 *
 * Run: `npm run test:live -- extractSentenceBBoxesWorkerParity`
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import {
    defaultFixtureRoot,
    loadFixtures,
} from '../helpers/sentenceFixtureHelper';

interface ParityResponse {
    ok: boolean;
    mainThread?: unknown;
    worker?: unknown;
    error?: { name?: string; code?: string; message?: string };
}

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const fixtureRoot = defaultFixtureRoot();
const fixtures = loadFixtures(fixtureRoot);

describe('extractSentenceBBoxes worker-vs-mainThread parity (live)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    if (fixtures.length === 0) {
        it.skip(`no fixtures in ${fixtureRoot}`, () => {});
        return;
    }

    for (const fx of fixtures) {
        it(`${fx.folderName} — worker matches runSentenceExtractionPipeline`, async () => {
            const res = await post<ParityResponse>(
                '/beaver/test/pdf-sentence-bboxes-parity',
                {
                    library_id: fx.fixture.source.libraryID,
                    zotero_key: fx.fixture.source.itemKey,
                    page_index: fx.fixture.source.pageIndex,
                },
                { timeout: 60000 },
            );
            if (!res.ok) {
                throw new Error(
                    `parity endpoint failed for ${fx.folderName}: ` +
                        `${JSON.stringify(res.error ?? {})}`,
                );
            }
            expect(res.worker).toEqual(res.mainThread);
        });
    }
});
