/**
 * Markdown engine bench: `block` vs `paragraph`.
 *
 * Hits the dev endpoints `/beaver/test/pdf-extract` and
 * `/beaver/test/pdf-extract-paragraph` against real Zotero attachments,
 * alternating engine order each iteration to wash out warm-cache
 * asymmetry, and emits a markdown report under
 * `tests/live/.bench-results/<key>/summary.md` plus per-page text dumps.
 *
 * Gated on `BEAVER_BENCH=1` so it does not run in normal `npm run test:live`.
 * Requires a running Zotero with the Beaver plugin and the listed
 * attachment keys present in the user's library.
 *
 * Usage:
 *   npm run bench:pdf
 *
 * To add a fixture: append to `FIXTURES`. To dial iterations:
 * `BEAVER_BENCH_ITER=10 npm run bench:pdf`.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import {
    pdfExtract,
    pdfExtractParagraph,
    workerCacheClear,
    type PdfExtractResponse,
} from '../helpers/cacheInspector';
import type { AttachmentFixture } from '../helpers/fixtures';

const BENCH_ENABLED = process.env.BEAVER_BENCH === '1';
const ITERATIONS = Math.max(
    1,
    Number.parseInt(process.env.BEAVER_BENCH_ITER ?? '5', 10) || 5,
);

const FIXTURES: AttachmentFixture[] = [
    {
        library_id: 1,
        zotero_key: 'WZVA5ZF2',
        description: 'report (100+ pages)',
    },
    {
        library_id: 1,
        zotero_key: 'HMNYG8ZT',
        description: 'Demography (23 pages)',
    },
    {
        library_id: 1,
        zotero_key: '7552DIBA',
        description: 'Science (12 pages)',
    },
    {
        library_id: 1,
        zotero_key: 'D4WGZFFX',
        description: 'Book (373 pages)',
    },
    {
        library_id: 1,
        zotero_key: 'KCHUIRXJ',
        description: 'Nature (1 page)',
    },
    {
        library_id: 1,
        zotero_key: 'L6SHB7JJ',
        description: 'Nature (10 pages)',
    },
    // Add more fixtures here. Keep `library_id` + `zotero_key` correct for
    // the local Zotero. Description is free-form.
];

const RESULTS_DIR = path.resolve(
    __dirname,
    '..',
    'live',
    '.bench-results',
);

interface PerEngineRunStats {
    /** Per-iteration end-to-end timings (HTTP round-trip), milliseconds. */
    e2eMs: number[];
    /** Per-iteration totalMs from the worker. */
    workerTotalMs: number[];
    /** Per-iteration walkMs from the worker. */
    walkMs: number[];
    /** Per-iteration analysisMs from the worker. */
    analysisMs: number[];
    /** Per-iteration sum-of-perPageMs from the worker. */
    perPageSumMs: number[];
    /** Captured page text from the LAST iteration. */
    perPageText: string[];
    /** Reported `metadata.engine` from the last iteration. */
    engine: string;
    /** Total content length (last iteration). */
    contentLength: number;
    /** `## ` heading count across all pages (last iteration). */
    headingCount: number;
    /** Page count (last iteration). */
    pageCount: number;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function p95(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

function fmt(n: number): string {
    return n.toFixed(1);
}

function ensureDir(p: string): void {
    fs.mkdirSync(p, { recursive: true });
}

function writePageDumps(
    fixtureDir: string,
    engineLabel: string,
    pages: Array<{ index: number; content: string }>,
): void {
    const dir = path.join(fixtureDir, engineLabel);
    ensureDir(dir);
    for (const page of pages) {
        const fname = `page-${String(page.index + 1).padStart(3, '0')}.txt`;
        fs.writeFileSync(path.join(dir, fname), page.content, 'utf8');
    }
}

function summarizeResponse(
    response: PdfExtractResponse,
): {
    engine: string;
    contentLength: number;
    headingCount: number;
    pageCount: number;
    perPageText: string[];
    workerTotalMs: number;
    walkMs: number;
    analysisMs: number;
    perPageSumMs: number;
} {
    if (!response.ok || !response.result) {
        throw new Error(
            `Extract failed: ${response.error?.code ?? '?'} ${response.error?.message ?? ''}`,
        );
    }
    const result = response.result;
    const pages: Array<{ index: number; content: string }> = result.pages ?? [];
    const perPageText = pages.map((p) => p.content ?? '');
    const contentLength = perPageText.reduce((s, t) => s + t.length, 0);
    const headingCount = perPageText.reduce(
        (s, t) => s + (t.match(/^## /gm)?.length ?? 0),
        0,
    );
    const timings = result.metadata?.timings ?? {};
    const perPageMs: number[] = timings.perPageMs ?? [];
    return {
        engine: result.metadata?.engine ?? '(unattributed)',
        contentLength,
        headingCount,
        pageCount: pages.length,
        perPageText,
        workerTotalMs: timings.totalMs ?? 0,
        walkMs: timings.walkMs ?? 0,
        analysisMs: timings.analysisMs ?? 0,
        perPageSumMs: perPageMs.reduce((s, n) => s + n, 0),
    };
}

async function runOnce(
    attachment: AttachmentFixture,
    engineLabel: 'block' | 'paragraph',
): Promise<{
    e2eMs: number;
    summary: ReturnType<typeof summarizeResponse>;
    pages: Array<{ index: number; content: string }>;
}> {
    const t0 = performance.now();
    const response =
        engineLabel === 'block'
            ? await pdfExtract(attachment)
            : await pdfExtractParagraph(attachment);
    const e2eMs = performance.now() - t0;
    const summary = summarizeResponse(response);
    const pages = response.result.pages.map((p: any) => ({
        index: p.index ?? 0,
        content: p.content ?? '',
    }));
    return { e2eMs, summary, pages };
}

function summarizeFixture(
    block: PerEngineRunStats,
    paragraph: PerEngineRunStats,
    fixture: AttachmentFixture,
): string {
    const lines: string[] = [];
    lines.push(`# ${fixture.zotero_key} — ${fixture.description}`);
    lines.push('');
    lines.push(`Iterations per engine: **${ITERATIONS}** (cold-cache; cache cleared between runs).`);
    lines.push('');
    lines.push('## Latency (ms)');
    lines.push('');
    lines.push('| metric | block | paragraph | Δ (paragraph − block) |');
    lines.push('|---|---:|---:|---:|');
    const rows: Array<[string, number[], number[]]> = [
        ['e2e median', block.e2eMs, paragraph.e2eMs],
        ['e2e p95', block.e2eMs, paragraph.e2eMs],
        ['worker total median', block.workerTotalMs, paragraph.workerTotalMs],
        ['worker total p95', block.workerTotalMs, paragraph.workerTotalMs],
        ['walk median', block.walkMs, paragraph.walkMs],
        ['analysis median', block.analysisMs, paragraph.analysisMs],
        ['perPage sum median', block.perPageSumMs, paragraph.perPageSumMs],
    ];
    for (const [label, b, p] of rows) {
        const fn = label.includes('p95') ? p95 : median;
        const bv = fn(b);
        const pv = fn(p);
        const delta = pv - bv;
        lines.push(`| ${label} | ${fmt(bv)} | ${fmt(pv)} | ${delta >= 0 ? '+' : ''}${fmt(delta)} |`);
    }
    lines.push('');
    lines.push('## Content shape (last iteration)');
    lines.push('');
    lines.push('| metric | block | paragraph |');
    lines.push('|---|---:|---:|');
    lines.push(`| pages | ${block.pageCount} | ${paragraph.pageCount} |`);
    lines.push(`| metadata.engine | \`${block.engine}\` | \`${paragraph.engine}\` |`);
    lines.push(`| total content length (chars) | ${block.contentLength} | ${paragraph.contentLength} |`);
    lines.push(`| heading count (\`## \`) | ${block.headingCount} | ${paragraph.headingCount} |`);
    lines.push('');
    lines.push('## Per-page content lengths (last iteration)');
    lines.push('');
    lines.push('| page | block | paragraph | Δ |');
    lines.push('|---:|---:|---:|---:|');
    const maxPages = Math.max(block.perPageText.length, paragraph.perPageText.length);
    for (let i = 0; i < maxPages; i++) {
        const bl = block.perPageText[i]?.length ?? 0;
        const pl = paragraph.perPageText[i]?.length ?? 0;
        lines.push(`| ${i + 1} | ${bl} | ${pl} | ${pl - bl >= 0 ? '+' : ''}${pl - bl} |`);
    }
    lines.push('');
    lines.push('Per-page text dumps live in `block/` and `paragraph/` next to this file.');
    lines.push('');
    return lines.join('\n');
}

describe('markdown engines bench (block vs paragraph)', () => {
    let available: boolean = false;

    beforeAll(async () => {
        available = await isZoteroAvailable();
    });

    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
        if (!BENCH_ENABLED) ctx.skip();
    });

    it.each(FIXTURES)(
        'benches $zotero_key',
        async (fixture) => {
            // Warm-up: each engine once, results discarded. Pays WASM init,
            // PDF disk-read, and any first-call costs that aren't being
            // measured.
            await runOnce(fixture, 'block').catch(() => undefined);
            await runOnce(fixture, 'paragraph').catch(() => undefined);

            const stats: Record<'block' | 'paragraph', PerEngineRunStats> = {
                block: emptyStats(),
                paragraph: emptyStats(),
            };
            let lastBlockPages: Array<{ index: number; content: string }> = [];
            let lastParagraphPages: Array<{ index: number; content: string }> = [];

            for (let iter = 0; iter < ITERATIONS; iter++) {
                // Alternate order each iteration.
                const order: Array<'block' | 'paragraph'> =
                    iter % 2 === 0 ? ['block', 'paragraph'] : ['paragraph', 'block'];

                for (const engineLabel of order) {
                    await workerCacheClear({ resetCounters: false });
                    const { e2eMs, summary, pages } = await runOnce(
                        fixture,
                        engineLabel,
                    );
                    stats[engineLabel].e2eMs.push(e2eMs);
                    stats[engineLabel].workerTotalMs.push(summary.workerTotalMs);
                    stats[engineLabel].walkMs.push(summary.walkMs);
                    stats[engineLabel].analysisMs.push(summary.analysisMs);
                    stats[engineLabel].perPageSumMs.push(summary.perPageSumMs);
                    stats[engineLabel].engine = summary.engine;
                    stats[engineLabel].contentLength = summary.contentLength;
                    stats[engineLabel].headingCount = summary.headingCount;
                    stats[engineLabel].pageCount = summary.pageCount;
                    stats[engineLabel].perPageText = summary.perPageText;
                    if (engineLabel === 'block') lastBlockPages = pages;
                    else lastParagraphPages = pages;
                }
            }

            // Sanity asserts only — bench does not pass/fail on relative perf.
            expect(stats.block.contentLength).toBeGreaterThan(0);
            expect(stats.paragraph.contentLength).toBeGreaterThan(0);
            expect(stats.paragraph.engine).toBe('paragraph');

            // Persist artifacts.
            const fixtureDir = path.join(RESULTS_DIR, fixture.zotero_key);
            ensureDir(fixtureDir);
            writePageDumps(fixtureDir, 'block', lastBlockPages);
            writePageDumps(fixtureDir, 'paragraph', lastParagraphPages);
            const summary = summarizeFixture(stats.block, stats.paragraph, fixture);
            fs.writeFileSync(path.join(fixtureDir, 'summary.md'), summary, 'utf8');

            // Console-friendly headline.
            console.log(
                `[bench] ${fixture.zotero_key}: ` +
                    `block worker median=${fmt(median(stats.block.workerTotalMs))}ms, ` +
                    `paragraph worker median=${fmt(median(stats.paragraph.workerTotalMs))}ms, ` +
                    `Δ=${fmt(median(stats.paragraph.workerTotalMs) - median(stats.block.workerTotalMs))}ms ` +
                    `(${stats.block.pageCount} pages)`,
            );
        },
        // 5 iterations × 2 engines × N seconds per call. Conservative cap.
        5 * 60 * 1000,
    );
});

function emptyStats(): PerEngineRunStats {
    return {
        e2eMs: [],
        workerTotalMs: [],
        walkMs: [],
        analysisMs: [],
        perPageSumMs: [],
        perPageText: [],
        engine: '',
        contentLength: 0,
        headingCount: 0,
        pageCount: 0,
    };
}
