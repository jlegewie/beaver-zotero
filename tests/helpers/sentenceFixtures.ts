/**
 * Sentence-extraction fixture loader and diff helpers for the live
 * regression suite (`tests/live/sentenceExtractionFixtures.live.test.ts`).
 *
 * Fixtures are JSON files under `tests/fixtures/sentence-extraction/`,
 * captured in a running Zotero via the dev menu item "Capture Sentence
 * Fixture (current page)". Each file is a snapshot of the sentence
 * pipeline's output for one PDF page; the test runner replays
 * `/beaver/test/pdf-sentence-bboxes` and compares.
 *
 * This module runs in the vitest worker (Node), so it uses Node `fs`
 * rather than Zotero `IOUtils`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBaseUrl } from './fixtures';
import type { PdfSentenceBBoxesResponse } from './cacheInspector';

/** Absolute tolerance applied to every bbox coord (x, y, w, h), in pt. */
export const BBOX_TOLERANCE_PT = 0.5;

/** Resolve the fixtures dir relative to this helper. */
function fixturesDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', 'fixtures', 'sentence-extraction');
}

export interface SentenceFixtureBBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SentenceFixtureSentence {
    text: string;
    bboxes: SentenceFixtureBBox[];
}

export interface SentenceFixtureSource {
    libraryId: number;
    zoteroKey: string;
    filePath?: string;
    pageIndex: number;
    pageLabel?: string | null;
}

export interface SentenceFixture {
    schemaVersion: number;
    name: string;
    source: SentenceFixtureSource;
    capturedAt: string;
    extractionOptions?: { splitter?: string };
    expected: {
        pageWidth: number;
        pageHeight: number;
        stats: {
            sentences: number;
            paragraphs: number;
            degradedParagraphs: number;
            unmappedParagraphs: number;
        };
        sentences: SentenceFixtureSentence[];
    };
}

/**
 * Synchronously load every `.json` fixture from the sentence-extraction
 * fixtures dir. Returns `[]` if the dir does not exist or contains no
 * fixtures — never throws on the empty-dir case so an empty live suite
 * collapses to a single `it.skip` instead of erroring at module init.
 */
export function loadAllSentenceFixtures(): SentenceFixture[] {
    const dir = fixturesDir();
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const out: SentenceFixture[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const path = join(dir, entry);
        try {
            const text = readFileSync(path, 'utf8');
            const parsed = JSON.parse(text) as SentenceFixture;
            if (parsed && parsed.expected && Array.isArray(parsed.expected.sentences)) {
                out.push(parsed);
            }
        } catch (e) {
            console.warn(
                `[sentenceFixtures] Failed to load ${path}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Compare a captured fixture to the live `/beaver/test/pdf-sentence-bboxes`
 * response. Returns a list of human-readable diff strings — empty array
 * means the response matches the fixture within `BBOX_TOLERANCE_PT`.
 */
export function diffSentenceFixture(
    fixture: SentenceFixture,
    response: PdfSentenceBBoxesResponse,
): string[] {
    const diffs: string[] = [];

    if (response.ok !== true || !response.result) {
        const msg =
            response.error?.message ?? 'response did not return ok=true';
        diffs.push(`response not ok: ${msg}`);
        return diffs;
    }

    const result = response.result;
    const exp = fixture.expected;

    if (result.width !== exp.pageWidth) {
        diffs.push(
            `pageWidth: expected ${exp.pageWidth}, got ${result.width}`,
        );
    }
    if (result.height !== exp.pageHeight) {
        diffs.push(
            `pageHeight: expected ${exp.pageHeight}, got ${result.height}`,
        );
    }

    if (result.sentences.length !== exp.stats.sentences) {
        diffs.push(
            `stats.sentences: expected ${exp.stats.sentences}, got ${result.sentences.length}`,
        );
    }
    if (result.paragraphs.length !== exp.stats.paragraphs) {
        diffs.push(
            `stats.paragraphs: expected ${exp.stats.paragraphs}, got ${result.paragraphs.length}`,
        );
    }
    if (result.degradedParagraphs !== exp.stats.degradedParagraphs) {
        diffs.push(
            `stats.degradedParagraphs: expected ${exp.stats.degradedParagraphs}, got ${result.degradedParagraphs}`,
        );
    }
    if (result.unmappedParagraphs !== exp.stats.unmappedParagraphs) {
        diffs.push(
            `stats.unmappedParagraphs: expected ${exp.stats.unmappedParagraphs}, got ${result.unmappedParagraphs}`,
        );
    }

    const n = Math.min(exp.sentences.length, result.sentences.length);
    for (let i = 0; i < n; i++) {
        const a = exp.sentences[i];
        const b = result.sentences[i];
        const aText = a.text.trim();
        const bText = b.text.trim();
        if (aText !== bText) {
            diffs.push(
                `sentence[${i}].text: expected ${JSON.stringify(
                    truncate(aText, 80),
                )}, got ${JSON.stringify(truncate(bText, 80))}`,
            );
        }
        if (a.bboxes.length !== b.bboxes.length) {
            diffs.push(
                `sentence[${i}].bboxes.length: expected ${a.bboxes.length}, got ${b.bboxes.length}`,
            );
            continue;
        }
        for (let j = 0; j < a.bboxes.length; j++) {
            const ab = a.bboxes[j];
            const bb = b.bboxes[j];
            for (const k of ['x', 'y', 'w', 'h'] as const) {
                const diff = Math.abs(ab[k] - bb[k]);
                if (diff > BBOX_TOLERANCE_PT) {
                    diffs.push(
                        `sentence[${i}].bboxes[${j}].${k}: expected ${ab[k].toFixed(2)}, got ${bb[k].toFixed(2)} (diff ${diff.toFixed(2)} > ${BBOX_TOLERANCE_PT.toFixed(2)})`,
                    );
                }
            }
        }
    }

    return diffs;
}

/**
 * Format a fixture-mismatch failure block. Includes enough context
 * (zoteroKey, libraryId, page, file path, reproduce-curl) for a
 * developer or AI agent to load the offending page and investigate.
 */
export function formatFailure(
    fixture: SentenceFixture,
    diffs: string[],
): string {
    const src = fixture.source;
    const baseUrl = getBaseUrl();
    const reproBody = JSON.stringify({
        library_id: src.libraryId,
        zotero_key: src.zoteroKey,
        page_index: src.pageIndex,
    });
    const lines = [
        `Fixture: ${fixture.name}`,
        `  zoteroKey:  ${src.zoteroKey}`,
        `  libraryId:  ${src.libraryId}`,
        `  page:       ${src.pageIndex}${src.pageLabel ? ` (label "${src.pageLabel}")` : ''}`,
        `  file:       ${src.filePath ?? '(unknown)'}`,
        '',
        'Reproduce:',
        `  curl -sS -X POST ${baseUrl}/beaver/test/pdf-sentence-bboxes \\`,
        `    -H 'Content-Type: application/json' \\`,
        `    -d '${reproBody}'`,
        '',
        `Differences (${diffs.length}):`,
        ...diffs.map((d) => `  - ${d}`),
    ];
    return lines.join('\n');
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
}
