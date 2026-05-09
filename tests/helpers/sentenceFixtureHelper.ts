/**
 * Shared loader + matcher for sentence-extraction regression fixtures.
 *
 * Captured by the "Create Sentence Test" item in the
 * reader's dev-only context menu (see
 * `react/utils/extractionFixtures.ts`). Both the unit tier
 * (`tests/unit/pdf/sentenceFixtures.unit.test.ts`) and the live tier
 * (`tests/live/sentenceFixtures.live.test.ts`) consume the same
 * `fixture.json` so failure messages stay consistent.
 *
 * Failures always surface `{libraryID, key, pageIndex, pageLabel}` and a
 * `zotero://select` URL so an agent can pivot straight to debug
 * endpoints (`/beaver/test/pdf-render-overlay`,
 * `/beaver/test/pdf-pipeline-trace`).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FixtureBBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface FixtureSentenceExpected {
    index: number;
    paragraphIndex: number;
    kind: 'text' | 'heading';
    text: string;
    bboxes: FixtureBBox[];
    /**
     * Producer hint that this sentence is continued by the next one in
     * reading order (cross-column / cross-page continuation). Omitted ≡
     * false; we never serialize the explicit `false`. Older fixtures
     * captured before the field existed have no key — comparator treats
     * that the same as `false`.
     */
    joinWithNext?: boolean;
}

export interface FixtureExpected {
    paragraphCount: number;
    stats: {
        /** Total paragraphs that fell back to a whole-paragraph bbox. */
        degradation: number;
    };
    sentences: FixtureSentenceExpected[];
}

export interface FixtureSourceMeta {
    libraryID: number;
    itemKey: string;
    title: string;
    pageIndex: number;
    pageLabel: string | null;
    language: string | null;
    splitterId: string;
    pdfSha256: string;
    pdfBytes: number;
    pageWidth: number;
    pageHeight: number;
}

export interface FixtureFile {
    schema: 2;
    createdAt: string;
    source: FixtureSourceMeta;
    extractor: { gitSha: string | null; marginsPreset: 'default' };
    artifacts: {
        sharedPdfSha: string;
        pagePng: string;
        rawExtraction: string;
    };
    tolerance: { bboxAbsPt: number };
    expected: FixtureExpected;
}

export interface LoadedFixture {
    folder: string;          // absolute path
    folderName: string;      // basename
    fixture: FixtureFile;
}

/**
 * Glob `<rootDir>/*<libraryID>__<key>__p<pageIndex>/fixture.json` and
 * return parsed entries. `_shared/` is excluded. Returns `[]` (no error)
 * when the root is missing — both test tiers then early-skip.
 */
export function loadFixtures(rootDir: string): LoadedFixture[] {
    if (!fs.existsSync(rootDir)) return [];
    const entries: LoadedFixture[] = [];
    for (const name of fs.readdirSync(rootDir)) {
        if (name.startsWith('_') || name.startsWith('.')) continue;
        const folder = path.join(rootDir, name);
        if (!fs.statSync(folder).isDirectory()) continue;
        const fixtureJson = path.join(folder, 'fixture.json');
        if (!fs.existsSync(fixtureJson)) continue;
        const parsed = JSON.parse(
            fs.readFileSync(fixtureJson, 'utf8'),
        ) as { schema?: unknown } & Partial<FixtureFile>;
        const schema = parsed.schema;
        if (schema === 1) {
            throw new Error(
                `Fixture ${name} is on schema 1 — run \`npx tsx tests/scripts/migrateSentenceFixtures.ts\` to migrate.`,
            );
        }
        if (schema !== 2) {
            throw new Error(
                `Fixture ${name} has unknown schema ${JSON.stringify(schema)} — only schema 2 is supported.`,
            );
        }
        entries.push({ folder, folderName: name, fixture: parsed as FixtureFile });
    }
    // Stable order so test output is deterministic.
    entries.sort((a, b) => a.folderName.localeCompare(b.folderName));
    return entries;
}

/** A `PageSentenceBBoxResult`-shaped subset that both tiers can produce. */
export interface ActualSentenceResult {
    paragraphs: Array<{ sentences: Array<{ text: string }> }>;
    sentences: Array<{
        text: string;
        bboxes: FixtureBBox[];
        kind?: 'text' | 'heading';
        // Page-local addressing fields populated by the producer.
        paragraphIndex?: number;
        sentenceIndex?: number;
        // Cross-paragraph continuation hint. Omitted ≡ false.
        joinWithNext?: boolean;
    }>;
    /**
     * Producer-shaped degradation summary. Omitted when no paragraphs
     * degraded; the comparator reads it as `actual.degradation?.count ?? 0`.
     */
    degradation?: { count: number; notes: unknown[] };
}

export interface MatchOptions {
    tolerancePt: number;
    source: FixtureSourceMeta;
    folder: string;
}

/**
 * Compare actual extractor output against `fixture.expected`. Throws an
 * `Error` whose message starts with the standard `FAIL …` block so an
 * agent can paste the libraryID/key/page directly into a debug endpoint.
 *
 * Comparison rules:
 *  1. Sentence count exact.
 *  2. Per-sentence text whitespace-normalized equality.
 *  3. Per-sentence paragraphIndex exact equality.
 *  4. Per-sentence bbox count exact; per-bbox |Δ| ≤ tolerancePt for x/y/w/h.
 *  5. Degradation count may improve but not regress.
 */
export function expectSentencesMatch(
    actual: ActualSentenceResult,
    expected: FixtureExpected,
    opts: MatchOptions,
): void {
    const failures: string[] = [];

    // Degradation regression check.
    const actualDegradation = actual.degradation?.count ?? 0;
    if (actualDegradation > expected.stats.degradation) {
        failures.push(
            `degradation regressed: ${actualDegradation} > ${expected.stats.degradation}`,
        );
    }

    // Build paragraph index per actual flat sentence (mirrors the same
    // mapping the fixture builder uses).
    const actualParaIdxBySentence: number[] = [];
    {
        let cursor = 0;
        actual.paragraphs.forEach((p, pIdx) => {
            for (let i = 0; i < p.sentences.length; i++) {
                actualParaIdxBySentence[cursor++] = pIdx;
            }
        });
    }

    // Sentence count.
    if (actual.sentences.length !== expected.sentences.length) {
        failures.push(
            `sentence count: expected ${expected.sentences.length}, got ${actual.sentences.length}`,
        );
        const maxLen = Math.max(actual.sentences.length, expected.sentences.length);
        for (let i = 0; i < maxLen; i++) {
            const e = expected.sentences[i]?.text ?? '<missing>';
            const a = actual.sentences[i]?.text ?? '<missing>';
            if (norm(e) !== norm(a)) {
                failures.push(`  [${i}] expected: ${truncate(e)}`);
                failures.push(`        actual: ${truncate(a)}`);
            }
        }
    } else {
        // Derive expected sentenceIndex from within-paragraph position in
        // the flat expected list (fixture stores paragraphIndex per sentence
        // but not sentenceIndex). For each contiguous run of sentences with
        // the same paragraphIndex, sentenceIndex resets at 0.
        const expectedSentenceIdxByPos: number[] = [];
        {
            let runStart = 0;
            for (let i = 0; i < expected.sentences.length; i++) {
                if (
                    i > 0 &&
                    expected.sentences[i].paragraphIndex !==
                        expected.sentences[i - 1].paragraphIndex
                ) {
                    runStart = i;
                }
                expectedSentenceIdxByPos[i] = i - runStart;
            }
        }

        // Per-sentence comparison.
        for (let i = 0; i < expected.sentences.length; i++) {
            const exp = expected.sentences[i];
            const act = actual.sentences[i];
            if (norm(act.text) !== norm(exp.text)) {
                failures.push(
                    `[${i}] text mismatch:\n` +
                        `       expected: ${truncate(exp.text)}\n` +
                        `         actual: ${truncate(act.text)}`,
                );
            }
            const actParaIdx = actualParaIdxBySentence[i] ?? -1;
            if (actParaIdx !== exp.paragraphIndex) {
                failures.push(
                    `[${i}] paragraphIndex (re-derived from grouping): expected ${exp.paragraphIndex}, got ${actParaIdx}`,
                );
            }
            // Direct assertion on the new SentenceBBox.paragraphIndex field.
            if (act.paragraphIndex !== undefined && act.paragraphIndex !== exp.paragraphIndex) {
                failures.push(
                    `[${i}] sentence.paragraphIndex (direct): expected ${exp.paragraphIndex}, got ${act.paragraphIndex}`,
                );
            }
            // Direct assertion on the new SentenceBBox.sentenceIndex field
            // (paragraph-local position).
            const expSentenceIdx = expectedSentenceIdxByPos[i];
            if (act.sentenceIndex !== undefined && act.sentenceIndex !== expSentenceIdx) {
                failures.push(
                    `[${i}] sentence.sentenceIndex: expected ${expSentenceIdx} (paragraph-local), got ${act.sentenceIndex}`,
                );
            }
            const actKind = act.kind ?? 'text';
            if (actKind !== exp.kind) {
                failures.push(
                    `[${i}] kind: expected "${exp.kind}", got "${actKind}"`,
                );
            }
            // joinWithNext: omitted ≡ false on both sides. Detects regressions
            // in the continuation heuristic without forcing the field to be
            // present on legacy fixtures.
            const actJoin = act.joinWithNext === true;
            const expJoin = exp.joinWithNext === true;
            if (actJoin !== expJoin) {
                failures.push(
                    `[${i}] joinWithNext: expected ${expJoin}, got ${actJoin}`,
                );
            }
            if (act.bboxes.length !== exp.bboxes.length) {
                failures.push(
                    `[${i}] bbox count: expected ${exp.bboxes.length}, got ${act.bboxes.length}`,
                );
                continue;
            }
            for (let j = 0; j < exp.bboxes.length; j++) {
                const ex = exp.bboxes[j];
                const ac = act.bboxes[j];
                const diffs: string[] = [];
                if (Math.abs(ac.x - ex.x) > opts.tolerancePt) diffs.push(`x ${ac.x} vs ${ex.x}`);
                if (Math.abs(ac.y - ex.y) > opts.tolerancePt) diffs.push(`y ${ac.y} vs ${ex.y}`);
                if (Math.abs(ac.w - ex.w) > opts.tolerancePt) diffs.push(`w ${ac.w} vs ${ex.w}`);
                if (Math.abs(ac.h - ex.h) > opts.tolerancePt) diffs.push(`h ${ac.h} vs ${ex.h}`);
                if (diffs.length > 0) {
                    failures.push(
                        `[${i}] bbox[${j}] outside tol=${opts.tolerancePt}pt: ${diffs.join(', ')}`,
                    );
                }
            }
        }
    }

    if (failures.length > 0) {
        throw new Error(formatFailureBlock(opts, failures));
    }
}

function formatFailureBlock(opts: MatchOptions, failures: string[]): string {
    const { source, folder } = opts;
    const labelStr = source.pageLabel ? ` (label "${source.pageLabel}")` : '';
    const header =
        `\n` +
        `FAIL libraryID=${source.libraryID} key=${source.itemKey} ` +
        `page=${source.pageIndex + 1}${labelStr}\n` +
        `     fixture: ${folder}\n` +
        `     zotero://select/library/items/${source.itemKey}\n` +
        `     pdfSha256=${source.pdfSha256}\n`;
    return header + failures.map((f) => '     ' + f).join('\n') + '\n';
}

function norm(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max = 80): string {
    const n = norm(s);
    return n.length > max ? n.slice(0, max) + '…' : n;
}

/**
 * Default fixture root used by both test tiers. Resolved relative to the
 * project root so unit + live tiers see the same files.
 */
export function defaultFixtureRoot(): string {
    return path.resolve(__dirname, '..', 'fixtures', 'pdfs', 'sentences');
}
