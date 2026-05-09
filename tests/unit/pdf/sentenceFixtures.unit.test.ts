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
 * `UPDATE_FIXTURES` only rewrites `fixture.json#expected`. If the change
 * also shifts paragraph boundaries, the captured `splitterRecording` in
 * `raw-extraction.json` is now stale (the splitter is asked to split text
 * that was never recorded). The only correct fix is to recapture the
 * affected fixture(s) through the in-reader dev menu (right-click in the
 * reader → "Update Sentence Test (current page)") so the recording is
 * refreshed with real sentencex output. There is intentionally no
 * regex-fallback path — a recording produced from `simpleRegexSentenceSplit`
 * would not reflect production behavior and would silently mask sentencex
 * regressions.
 *
 * Run: `npx vitest run tests/unit/pdf/sentenceFixtures`
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import {
    detectFilteredParagraphs,
    extractPageSentenceBBoxes,
    pagesForFilterWithBridgedFonts,
} from '../../../src/services/pdf';
import type {
    RawPageData,
    RawPageDataDetailed,
    SentenceRange,
    SentenceSplitter,
} from '../../../src/services/pdf';
import { simpleRegexSentenceSplit } from '../../../src/services/pdf/SentenceMapper';
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

    const { splitter, unknownTexts } = makeReplaySplitter(
        raw.splitterRecording,
    );
    const filtered = detectFilteredParagraphs({
        pages: pagesForFilter(raw.rawPages, raw.pageIndex, raw.detailedPage),
        pageIndex: raw.pageIndex,
    });
    const result = extractPageSentenceBBoxes(raw.detailedPage, {
        splitter,
        precomputed: { paragraphResult: filtered.paragraphResult },
    });

    assertUnknownsAreContinuationProbes(unknownTexts, result, fx);
    return result;
}

/**
 * Validate every text the splitter received that wasn't in the recording.
 *
 * Each unknown MUST exactly equal a candidate continuation-probe string —
 * `<last sentence text>.trimEnd() + " " + <first sentence text>.trimStart()`
 * for some adjacent paragraph pair in the result. Anything else means the
 * mapper started passing the splitter a paragraph text that wasn't captured
 * (drift) — fail loudly so re-capture is required.
 */
function assertUnknownsAreContinuationProbes(
    unknownTexts: ReadonlyArray<string>,
    result: { paragraphs: ActualLikeResult['paragraphs'] },
    fx: LoadedFixture,
): void {
    if (unknownTexts.length === 0) return;
    const candidates = new Set<string>();
    for (let i = 0; i < result.paragraphs.length - 1; i++) {
        const cur = result.paragraphs[i].sentences;
        const next = result.paragraphs[i + 1].sentences;
        if (cur.length === 0 || next.length === 0) continue;
        const left = cur[cur.length - 1].text.replace(/\s+$/u, '');
        const right = next[0].text.replace(/^\s+/u, '');
        if (!left || !right) continue;
        candidates.add(`${left} ${right}`);
    }
    for (const text of unknownTexts) {
        if (!candidates.has(text)) {
            throw new Error(
                `replaySplitter: splitter received unrecorded text that is ` +
                    `not a valid continuation-probe candidate ` +
                    `(fixture=${fx.folderName}, len=${text.length}, ` +
                    `head="${text.slice(0, 60)}…"). Paragraph boundaries ` +
                    `drifted since fixture capture — recapture via the ` +
                    `reader's "Update Sentence Test (current page)" menu ` +
                    `so the splitter recording is refreshed with real ` +
                    `sentencex output. UPDATE_FIXTURES=1 alone will not ` +
                    `fix this: it only rewrites \`expected\`.`,
            );
        }
    }
}

/**
 * Substitute the captured detailed page into the analysis window
 * before paragraph detection runs, AND bridge fonts from the JSON-walk
 * version onto it (the wasm font binding leaves detailed-walk lines
 * with empty `font.{name, family, weight, style}`). Mirrors
 * `pagesForFilter` in `react/utils/extractionOverlay.ts` and the
 * production sentence pipeline. The bridge is a no-op for fixtures
 * captured after the bridge was added (those already have populated
 * fonts on the detailed page).
 */
function pagesForFilter(
    pages: RawPageData[],
    pageIndex: number,
    detailedTargetPage: RawPageDataDetailed,
): RawPageData[] {
    return pagesForFilterWithBridgedFonts(pages, pageIndex, detailedTargetPage);
}

/**
 * Build a `SentenceSplitter` that returns the captured ranges for matching
 * paragraph text.
 *
 * Two distinct call sites feed this splitter inside `extractPageSentenceBBoxes`:
 *   1. Per-paragraph splits (`resolveSentencesInParagraph`) — texts here MUST
 *      come from the recording. An unrecorded paragraph text means the mapper
 *      input drifted since fixture capture; re-capture via UPDATE_FIXTURES=1.
 *   2. Cross-column join probes (`annotateColumnContinuations`) — the helper
 *      builds a *combined* string from the last + first sentence around each
 *      column boundary. These probes are not part of the recording.
 *
 * The splitter cannot tell the two call sites apart synchronously. Instead
 * of choosing one regression-coverage failure mode, we collect every
 * unrecorded text into `unknownTexts`. The caller validates after extraction
 * that each unknown matches a valid continuation-probe candidate from the
 * actual result; anything else indicates real mapper drift on a paragraph
 * split. This preserves drift detection on per-paragraph splits without
 * requiring re-capture for every code change that adds new probe inputs.
 */
function makeReplaySplitter(
    recording: ReadonlyArray<{ text: string; ranges: SentenceRange[] }>,
): { splitter: SentenceSplitter; unknownTexts: string[] } {
    const byText = new Map<string, SentenceRange[]>();
    for (const entry of recording) byText.set(entry.text, entry.ranges);
    const unknownTexts: string[] = [];
    const splitter: SentenceSplitter = (text: string): SentenceRange[] => {
        const hit = byText.get(text);
        if (hit) return hit;
        unknownTexts.push(text);
        return simpleRegexSentenceSplit(text);
    };
    return { splitter, unknownTexts };
}

interface ActualLikeResult {
    paragraphs: Array<{ sentences: Array<{ text: string; bboxes: any[] }> }>;
    sentences: Array<{
        text: string;
        bboxes: any[];
        kind?: 'text' | 'heading';
        joinWithNext?: boolean;
    }>;
    degradation?: { count: number; notes: unknown[] };
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
            degradation: actual.degradation?.count ?? 0,
        },
        sentences: actual.sentences.map((s, idx) => {
            const out: FixtureFile['expected']['sentences'][number] = {
                index: idx,
                paragraphIndex: paragraphIndexBySentence[idx] ?? -1,
                kind: (s.kind ?? 'text') as 'text' | 'heading',
                text: s.text,
                bboxes: s.bboxes.map((b: any) => ({
                    x: round3(b.x),
                    y: round3(b.y),
                    w: round3(b.w),
                    h: round3(b.h),
                })),
            };
            // Only serialize joinWithNext when true. Omitted ≡ false.
            if (s.joinWithNext) out.joinWithNext = true;
            return out;
        }),
    };
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

// Keep the helper-injected `expect` reachable so vitest doesn't tree-shake it
// out of the unit tier (it runs on the it-with-no-fixtures branch only).
void expect;
