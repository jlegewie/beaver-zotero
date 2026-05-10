/**
 * Unit tests for `beaver-extract fixture …`.
 *
 * Runs `runCli` in-process with mocked Node API + a real temp directory
 * for filesystem effects. We don't mock `fs` — the fixture command's
 * write-temp/rename flow is part of the contract and worth exercising.
 *
 * Coverage targets from the plan:
 *   1. capture refuses to overwrite without --update
 *   2. update preserves capturedAt and bumps updatedAt
 *   3. repeated update is a no-op (true idempotence — file mtime unchanged)
 *   4. missing _shared/<sha>.pdf produces a clear error
 *   5. malformed fixture.json produces a targeted format error
 *   6. default --root resolves to the public corpus
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { runCli } from '../../../src/services/pdf/node/runCli';
import type { CliDeps } from '../../../src/services/pdf/cli/runCliTypes';
import type * as NodeApi from '../../../src/services/pdf/node/api';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

class StringSink extends Writable {
    chunks: string[] = [];
    _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
        this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
    }
    text(): string {
        return this.chunks.join('');
    }
}

interface DepFakes {
    stdout: StringSink;
    stderr: StringSink;
    deps: CliDeps;
    api: { [K in keyof typeof NodeApi]: ReturnType<typeof vi.fn> };
}

const FAKE_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
const FAKE_PDF_SHA = createHash('sha256').update(FAKE_PDF_BYTES).digest('hex');

function pageWithSentences(): unknown {
    return {
        index: 0,
        width: 595,
        height: 842,
        content: 'Hello.',
        sentences: [
            {
                pageIndex: 0,
                paragraphIndex: 0,
                sentenceIndex: 0,
                text: 'Hello.',
                bboxes: [{ x: 10, y: 10, w: 80, h: 12 }],
            },
        ],
        paragraphs: [
            {
                item: { type: 'paragraph', idx: 0, text: 'Hello.' },
                paragraphText: 'Hello.',
                sentences: [],
            },
        ],
    };
}

function makeDeps(api: Partial<DepFakes['api']> = {}): DepFakes {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const fakeApi = {
        getPageCount: vi.fn(),
        getMetadata: vi.fn(),
        extractPdf: vi.fn().mockResolvedValue({
            pages: [pageWithSentences()],
            analysis: {},
            fullText: 'Hello.',
            metadata: {},
        }),
        analyzeLayout: vi.fn(),
        renderPages: vi.fn(),
        extractRawPageDetailed: vi.fn(),
        analyzeOCRNeeds: vi.fn(),
        ...api,
    };
    const deps: CliDeps = {
        api: fakeApi as unknown as typeof NodeApi,
        drawOverlay: vi.fn().mockResolvedValue(new Uint8Array()),
        loadPdf: vi.fn().mockResolvedValue(FAKE_PDF_BYTES),
        writePngFile: vi.fn().mockResolvedValue(undefined),
        writeJsonFile: vi.fn().mockResolvedValue(undefined),
        stdout,
        stderr,
    };
    return { stdout, stderr, deps, api: fakeApi as DepFakes['api'] };
}

let tmpRoot = '';

beforeEach(() => {
    process.exitCode = undefined;
    tmpRoot = mkdtempSync(join(tmpdir(), 'beaver-fixture-'));
});

afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = '';
});

function readFixtureJson(id: string): {
    schema: number;
    id: string;
    capturedAt: string;
    updatedAt: string;
    pdfSha256: string;
    config: { pageIndices: number[]; analysisScope: unknown };
    expected: { perPage: unknown[] };
} {
    return JSON.parse(readFileSync(join(tmpRoot, id, 'fixture.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. capture creates a fresh fixture; refuses overwrite without --update
// ---------------------------------------------------------------------------

describe('fixture capture', () => {
    it('writes a fresh fixture and shared PDF with sane metadata', async () => {
        const { deps, stdout } = makeDeps();
        const code = await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'synth__p0',
                '--pages',
                '0',
                '--json',
            ],
            deps,
        );
        expect(code, `stdout=${stdout.text()}`).toBe(0);

        const fix = readFixtureJson('synth__p0');
        expect(fix.schema).toBe(1);
        expect(fix.id).toBe('synth__p0');
        expect(fix.pdfSha256).toBe(FAKE_PDF_SHA);
        expect(fix.config.pageIndices).toEqual([0]);
        expect(fix.config.analysisScope).toBe('document'); // default
        expect(fix.capturedAt).toBe(fix.updatedAt); // first capture
        expect(fix.expected.perPage).toHaveLength(1);

        // Shared PDF was written.
        expect(existsSync(join(tmpRoot, '_shared', `${FAKE_PDF_SHA}.pdf`))).toBe(true);
    });

    it('refuses to overwrite an existing fixture without --update', async () => {
        const { deps } = makeDeps();
        const args = (extra: string[] = []) => [
            'fixture',
            'capture',
            'fake.pdf',
            '--root',
            tmpRoot,
            '--id',
            'synth__p0',
            '--pages',
            '0',
            '--json',
            ...extra,
        ];

        // First capture succeeds.
        expect(await runCli(args(), deps)).toBe(0);

        // Second capture without --update fails.
        const { deps: deps2, stderr: stderr2 } = makeDeps();
        const code = await runCli(args(), deps2);
        expect(code).toBe(1);
        const env = JSON.parse(stderr2.text()) as { ok: boolean; error: { message: string } };
        expect(env.ok).toBe(false);
        expect(env.error.message).toMatch(/--update/);
    });

    it('rejects mutually exclusive --analysis-scope + --analysis-window', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'x',
                '--pages',
                '0',
                '--analysis-scope',
                'document',
                '--analysis-window',
                '5',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/mutually exclusive/);
    });

    it('reports wrote=true when --update actually rewrites a changed fixture', async () => {
        // Regression: previously `wrote` was recomputed by re-reading the
        // just-written file and comparing to itself, so existing-and-changed
        // captures always reported wrote=false.
        const { deps: capDeps } = makeDeps();
        const baseArgs = [
            'fixture',
            'capture',
            'fake.pdf',
            '--root',
            tmpRoot,
            '--id',
            'wrote__p0',
            '--pages',
            '0',
            '--json',
        ];
        expect(await runCli(baseArgs, capDeps)).toBe(0);

        // Re-capture with --update and a mutated extract result.
        const mutated = pageWithSentences() as Record<string, unknown>;
        const sentences = (mutated.sentences as Record<string, unknown>[]).slice();
        sentences[0] = { ...sentences[0], text: 'Mutated sentence.' };
        mutated.sentences = sentences;
        mutated.content = 'Mutated content.';

        const { deps: updateDeps, stdout } = makeDeps({
            extractPdf: vi.fn().mockResolvedValue({
                pages: [mutated],
                analysis: {},
                fullText: 'Mutated content.',
                metadata: {},
            }),
        });
        const code = await runCli([...baseArgs, '--update'], updateDeps);
        expect(code).toBe(0);
        const env = JSON.parse(stdout.text()) as {
            ok: boolean;
            result: { wrote: boolean; capturedAt: string; updatedAt: string };
        };
        expect(env.ok).toBe(true);
        expect(env.result.wrote).toBe(true);
        expect(env.result.updatedAt).not.toBe(env.result.capturedAt);
    });

    it('reports wrote=false when --update on an unchanged fixture is a true no-op', async () => {
        const { deps: capDeps } = makeDeps();
        const baseArgs = [
            'fixture',
            'capture',
            'fake.pdf',
            '--root',
            tmpRoot,
            '--id',
            'noop__p0',
            '--pages',
            '0',
            '--json',
        ];
        expect(await runCli(baseArgs, capDeps)).toBe(0);

        const { deps: updateDeps, stdout } = makeDeps();
        const code = await runCli([...baseArgs, '--update'], updateDeps);
        expect(code).toBe(0);
        const env = JSON.parse(stdout.text()) as {
            ok: boolean;
            result: { wrote: boolean };
        };
        expect(env.result.wrote).toBe(false);
    });

    it('stores --analysis-window N as { window: N } in the fixture config', async () => {
        const { deps } = makeDeps();
        const code = await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'win5',
                '--pages',
                '0',
                '--analysis-window',
                '5',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        const fix = readFixtureJson('win5');
        expect(fix.config.analysisScope).toEqual({ window: 5 });
    });

    it('renders preview-p<n>.png for each captured page when --preview is set', async () => {
        const { deps, api } = makeDeps();
        api.renderPages.mockResolvedValue({
            pageCount: 1,
            pageLabels: {},
            pages: [
                {
                    pageIndex: 0,
                    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
                    width: 800,
                    height: 1200,
                    format: 'png',
                    scale: 1.5,
                    dpi: 108,
                },
            ],
        });

        const code = await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'preview__p0',
                '--pages',
                '0',
                '--preview',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        expect(api.renderPages).toHaveBeenCalledTimes(1);
        expect(api.renderPages.mock.calls[0][0]).toMatchObject({
            pageIndices: [0],
            options: { scale: 1.5, format: 'png' },
        });
        expect(deps.drawOverlay).toHaveBeenCalledTimes(1);
        expect(deps.writePngFile).toHaveBeenCalledWith(
            join(tmpRoot, 'preview__p0', 'preview-p0.png'),
            expect.any(Uint8Array),
        );
    });

    it('does NOT render preview by default (off without --preview)', async () => {
        const { deps, api } = makeDeps();
        const code = await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'no-preview__p0',
                '--pages',
                '0',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        expect(api.renderPages).not.toHaveBeenCalled();
        expect(deps.drawOverlay).not.toHaveBeenCalled();
        expect(deps.writePngFile).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 2 + 3. update preserves capturedAt; repeated update is a true no-op
// ---------------------------------------------------------------------------

describe('fixture update', () => {
    async function captureBaseline(): Promise<string> {
        const { deps } = makeDeps();
        const code = await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'rebase__p0',
                '--pages',
                '0',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        return readFixtureJson('rebase__p0').capturedAt;
    }

    it('preserves capturedAt and the fixture file is bytewise unchanged on a true no-op', async () => {
        const capturedAt = await captureBaseline();
        const fixturePath = join(tmpRoot, 'rebase__p0', 'fixture.json');
        const before = readFileSync(fixturePath);
        const beforeMtime = statSync(fixturePath).mtimeMs;

        // Wait a tick so any rewrite would yield a different mtime.
        await new Promise((r) => setTimeout(r, 10));

        const { deps } = makeDeps();
        const code = await runCli(
            ['fixture', 'update', 'rebase__p0', '--root', tmpRoot, '--json'],
            deps,
        );
        expect(code).toBe(0);

        const after = readFileSync(fixturePath);
        expect(after.equals(before)).toBe(true);
        expect(statSync(fixturePath).mtimeMs).toBe(beforeMtime);

        // capturedAt is preserved
        expect(readFixtureJson('rebase__p0').capturedAt).toBe(capturedAt);
    });

    it('rewrites and bumps updatedAt when extractPdf returns a different snapshot', async () => {
        const capturedAt = await captureBaseline();

        // Mutate the API mock to return a different snapshot.
        const mutated = pageWithSentences() as Record<string, unknown>;
        const sentences = (mutated.sentences as Record<string, unknown>[]).slice();
        sentences[0] = { ...sentences[0], text: 'Different sentence text.' };
        mutated.sentences = sentences;
        mutated.content = 'Different content.';

        const { deps } = makeDeps({
            extractPdf: vi.fn().mockResolvedValue({
                pages: [mutated],
                analysis: {},
                fullText: 'Different content.',
                metadata: {},
            }),
        });

        const code = await runCli(
            ['fixture', 'update', 'rebase__p0', '--root', tmpRoot, '--json'],
            deps,
        );
        expect(code).toBe(0);

        const fix = readFixtureJson('rebase__p0');
        expect(fix.capturedAt).toBe(capturedAt); // preserved
        expect(fix.updatedAt).not.toBe(capturedAt); // bumped
        expect(fix.expected.perPage).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 4. evaluate surfaces missing shared-PDF errors clearly
// ---------------------------------------------------------------------------

describe('fixture evaluate', () => {
    it('errors clearly when the shared PDF is missing', async () => {
        // Hand-write a fixture pointing at a sha that has no matching PDF.
        const fakeSha = 'a'.repeat(64);
        mkdirSync(join(tmpRoot, 'orphan__p0'), { recursive: true });
        writeFileSync(
            join(tmpRoot, 'orphan__p0', 'fixture.json'),
            JSON.stringify(buildSyntheticFixture(fakeSha), null, 2),
        );

        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['fixture', 'evaluate', 'orphan__p0', '--root', tmpRoot, '--json'],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/shared PDF missing/);
        expect(env.error.message).toContain(fakeSha);
    });

    it('exits 0 when the snapshot matches', async () => {
        // Capture, then evaluate with the SAME mock — should succeed.
        const { deps: capDeps } = makeDeps();
        await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'eval__p0',
                '--pages',
                '0',
                '--json',
            ],
            capDeps,
        );

        const { deps: evalDeps } = makeDeps();
        const code = await runCli(
            ['fixture', 'evaluate', 'eval__p0', '--root', tmpRoot, '--json'],
            evalDeps,
        );
        expect(code).toBe(0);
    });

    it('exits 1 with a structured envelope when the snapshot drifts', async () => {
        const { deps: capDeps } = makeDeps();
        await runCli(
            [
                'fixture',
                'capture',
                'fake.pdf',
                '--root',
                tmpRoot,
                '--id',
                'drift__p0',
                '--pages',
                '0',
                '--json',
            ],
            capDeps,
        );

        const mutated = pageWithSentences() as Record<string, unknown>;
        const sentences = (mutated.sentences as Record<string, unknown>[]).slice();
        sentences[0] = { ...sentences[0], text: 'Drifted sentence.' };
        mutated.sentences = sentences;

        const { deps: evalDeps, stdout } = makeDeps({
            extractPdf: vi.fn().mockResolvedValue({
                pages: [mutated],
                analysis: {},
                fullText: '',
                metadata: {},
            }),
        });

        const code = await runCli(
            ['fixture', 'evaluate', 'drift__p0', '--root', tmpRoot, '--json'],
            evalDeps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stdout.text()) as {
            ok: boolean;
            result: { diffCount: number };
        };
        expect(env.ok).toBe(false);
        expect(env.result.diffCount).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// 5. malformed fixture.json — targeted format error
// ---------------------------------------------------------------------------

describe('fixture loader validation', () => {
    it('produces a path-prefixed error for an invalid analysisScope', async () => {
        mkdirSync(join(tmpRoot, '_shared'), { recursive: true });
        writeFileSync(join(tmpRoot, '_shared', `${FAKE_PDF_SHA}.pdf`), Buffer.from(FAKE_PDF_BYTES));

        const malformed = buildSyntheticFixture(FAKE_PDF_SHA);
        (malformed.config as Record<string, unknown>).analysisScope = 42 as unknown;

        mkdirSync(join(tmpRoot, 'bad__p0'), { recursive: true });
        writeFileSync(
            join(tmpRoot, 'bad__p0', 'fixture.json'),
            JSON.stringify(malformed, null, 2),
        );

        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['fixture', 'evaluate', 'bad__p0', '--root', tmpRoot, '--json'],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/analysisScope/);
    });
});

// ---------------------------------------------------------------------------
// Synthetic fixture builder used by the malformed/orphan tests
// ---------------------------------------------------------------------------

function buildSyntheticFixture(sha: string): Record<string, unknown> {
    return {
        schema: 1,
        id: 'synthetic',
        capturedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        pdfSha256: sha,
        pdfBytes: 8,
        config: {
            pageIndices: [0],
            analysisScope: 'document',
            splitterConfig: { type: 'sentencex' },
            settings: {},
            paragraphSettings: {},
        },
        fingerprints: {
            extractorGitSha: null,
            extractorVersion: null,
            mupdfWasmSha256: '0'.repeat(64),
            sentencexWasmSha256: '0'.repeat(64),
        },
        tolerance: { bboxAbsPt: 0.5 },
        expected: {
            perPage: [],
            totals: { paragraphCount: 0, sentenceCount: 0, degradedParagraphs: 0 },
        },
    };
}
