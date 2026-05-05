/**
 * Hermetic regression tests for sentence-level PDF extraction.
 *
 * Each fixture under `tests/fixtures/pdfs/sentences/` was captured from a
 * real PDF via the dev-only "Create/Update Sentence Test" reader
 * menu (see `react/utils/extractionFixtures.ts`). We replay the captured
 * `raw-extraction.json` (rawPages + detailedPage + splitter recording)
 * through `extractPageSentenceBBoxes` and assert the result matches
 * `fixture.json#expected`.
 *
 * Why no MuPDF here: sentencex needs `chrome://` URLs that don't resolve
 * outside Zotero's runtime. The captured `splitterRecording` (produced
 * during fixture creation) lets us replay the real splitter output
 * without depending on either MuPDF or sentencex at test time.
 *
 * The matching fixture data is gitignored — when the folder is empty,
 * this suite reports a single skipped test rather than failing.
 *
 * To update fixtures after an intentional pipeline change, run with
 * `UPDATE_FIXTURES=1` to overwrite `expected` from the current pipeline:
 *   UPDATE_FIXTURES=1 npx vitest run tests/unit/pdf/sentenceFixtures
 *
 * Run: `npx vitest run tests/unit/pdf/sentenceFixtures`
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import {
    detectFilteredParagraphs,
    extractPageSentenceBBoxes,
} from '../../../src/services/pdf';
import type {
    RawPageData,
    RawPageDataDetailed,
    SentenceRange,
    SentenceSplitter,
} from '../../../src/services/pdf';
import {
    defaultFixtureRoot,
    expectSentencesMatch,
    loadFixtures,
    type FixtureFile,
    type LoadedFixture,
} from '../../helpers/sentenceFixtureHelper';

interface RawExtraction {
    rawPages: RawPageData[];
    detailedPage: RawPageDataDetailed;
    pageIndex: number;
    language: string | null;
    splitterLanguage: string;
    splitterRecording: Array<{ text: string; ranges: SentenceRange[] }>;
}

const fixtureRoot = defaultFixtureRoot();
const fixtures = loadFixtures(fixtureRoot);
const updateMode = process.env.UPDATE_FIXTURES === '1';

describe('sentence-extraction fixtures (hermetic)', () => {
    if (fixtures.length === 0) {
        it.skip(`no fixtures in ${fixtureRoot} — capture some via the reader menu`, () => {});
        return;
    }

    for (const fx of fixtures) {
        it(`${fx.folderName} — matches expected`, () => {
            const actual = runPipelineForFixture(fx);

            if (updateMode) {
                writeUpdatedExpected(fx, actual);
                console.log(
                    `[UPDATE_FIXTURES] rewrote expected for ${fx.folderName} ` +
                        `(${actual.sentences.length} sentences)`,
                );
                return;
            }

            expectSentencesMatch(actual, fx.fixture.expected, {
                tolerancePt: fx.fixture.tolerance.bboxAbsPt,
                source: fx.fixture.source,
                folder: fx.folder,
            });
        });
    }
});

function runPipelineForFixture(fx: LoadedFixture) {
    const raw = JSON.parse(
        fs.readFileSync(path.join(fx.folder, 'raw-extraction.json'), 'utf8'),
    ) as RawExtraction;

    const splitter = makeReplaySplitter(raw.splitterRecording);
    const filtered = detectFilteredParagraphs({
        pages: pagesForFilter(raw.rawPages, raw.pageIndex, raw.detailedPage),
        pageIndex: raw.pageIndex,
    });
    return extractPageSentenceBBoxes(raw.detailedPage, {
        splitter,
        precomputed: { paragraphResult: filtered.paragraphResult },
    });
}

/**
 * Substitute the captured detailed page into the analysis window
 * before paragraph detection runs. Mirrors `pagesForFilter` in
 * `react/utils/extractionOverlay.ts`.
 */
function pagesForFilter(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage: RawPageDataDetailed,
): RawPageData[] {
    return pages.map((p) =>
        p.pageIndex === pageIndex ? detailedTargetPage : p,
    );
}

/**
 * Build a `SentenceSplitter` that returns the captured ranges for
 * matching paragraph text. If unknown text comes in (mapper changed the
 * input it gives the splitter), throws with a descriptive error so the
 * regression is visible rather than silently producing wrong output.
 */
function makeReplaySplitter(
    recording: ReadonlyArray<{ text: string; ranges: SentenceRange[] }>,
): SentenceSplitter {
    const byText = new Map<string, SentenceRange[]>();
    for (const entry of recording) byText.set(entry.text, entry.ranges);
    return (text: string): SentenceRange[] => {
        const hit = byText.get(text);
        if (hit) return hit;
        throw new Error(
            `replaySplitter: no recorded splitter output for paragraph text ` +
                `(len=${text.length}, head="${text.slice(0, 60)}…"). ` +
                `Mapper input changed since fixture capture — re-capture via ` +
                `"Create/Update Sentence Test" or run with UPDATE_FIXTURES=1.`,
        );
    };
}

interface ActualLikeResult {
    paragraphs: Array<{ sentences: Array<{ text: string; bboxes: any[] }> }>;
    sentences: Array<{ text: string; bboxes: any[] }>;
    degradedParagraphs: number;
    unmappedParagraphs: number;
}

function writeUpdatedExpected(fx: LoadedFixture, actual: ActualLikeResult): void {
    const next = buildExpectedFromActual(actual);
    const updated: FixtureFile = {
        ...fx.fixture,
        expected: next,
    };
    fs.writeFileSync(
        path.join(fx.folder, 'fixture.json'),
        JSON.stringify(updated, null, 2) + '\n',
        'utf8',
    );
}

function buildExpectedFromActual(
    actual: ActualLikeResult,
): FixtureFile['expected'] {
    const paragraphIndexBySentence: number[] = [];
    let cursor = 0;
    actual.paragraphs.forEach((pws, pIdx) => {
        for (let i = 0; i < pws.sentences.length; i++) {
            paragraphIndexBySentence[cursor++] = pIdx;
        }
    });
    return {
        paragraphCount: actual.paragraphs.length,
        stats: {
            degradedParagraphs: actual.degradedParagraphs,
            unmappedParagraphs: actual.unmappedParagraphs,
        },
        sentences: actual.sentences.map((s, idx) => ({
            index: idx,
            paragraphIndex: paragraphIndexBySentence[idx] ?? -1,
            text: s.text,
            bboxes: s.bboxes.map((b: any) => ({
                x: round3(b.x),
                y: round3(b.y),
                w: round3(b.w),
                h: round3(b.h),
            })),
        })),
    };
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

// Keep the helper-injected `expect` reachable so vitest doesn't tree-shake it
// out of the unit tier (it runs on the it-with-no-fixtures branch only).
void expect;
