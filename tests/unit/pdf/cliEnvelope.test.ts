/**
 * In-process CLI envelope tests.
 *
 * Imports `runCli(argv, deps)` directly with mocked Node API + fake fs
 * helpers — no real WASM, no spawn boundary, no sharp. Vitest module
 * mocks would NOT survive `child_process.spawn`, which is why this is
 * the unit-tier test seam.
 *
 * Uses the `Writable`-collecting pattern instead of console spies so
 * commander's own help/error output is included.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';

import { buildProgram, runCli } from '../../../src/services/pdf/node/runCli';
import type { CliDeps } from '../../../src/services/pdf/cli/runCliTypes';
import type * as NodeApi from '../../../src/services/pdf/node/api';

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

function makeDeps(api: Partial<DepFakes['api']> = {}): DepFakes {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const fakeApi = {
        getPageCount: vi.fn(),
        getMetadata: vi.fn(),
        extractPdf: vi.fn(),
        analyzeLayout: vi.fn(),
        renderPages: vi.fn(),
        extractRawPageDetailed: vi.fn(),
        analyzeOCRNeeds: vi.fn(),
        ...api,
    };
    const deps: CliDeps = {
        api: fakeApi as unknown as typeof NodeApi,
        drawOverlay: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
        loadPdf: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])), // %PDF
        writePngFile: vi.fn().mockResolvedValue(undefined),
        writeJsonFile: vi.fn().mockResolvedValue(undefined),
        stdout,
        stderr,
    };
    return { stdout, stderr, deps, api: fakeApi as DepFakes['api'] };
}

beforeEach(() => {
    process.exitCode = undefined;
});

describe('runCli — info command', () => {
    it('emits a success envelope with effective options + result', async () => {
        const { deps, stdout, api } = makeDeps();
        api.getPageCount.mockResolvedValue({ count: 7 });
        api.getMetadata.mockResolvedValue({
            pageCount: 7,
            title: 'Test',
            author: 'Anon',
            pageLabels: {},
        });

        const code = await runCli(['info', 'fake.pdf', '--json'], deps);
        expect(code).toBe(0);
        expect(api.getPageCount).toHaveBeenCalledTimes(1);
        expect(api.getMetadata).toHaveBeenCalledTimes(1);

        const env = JSON.parse(stdout.text()) as {
            ok: boolean;
            input: { file: string; pdfBytes: number; pdfSha256: string };
            options: Record<string, unknown>;
            result: { pageCount: number; metadata: { title: string } };
        };
        expect(env.ok).toBe(true);
        expect(env.input.file).toBe('fake.pdf');
        expect(env.input.pdfBytes).toBe(4);
        expect(env.input.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(env.result.pageCount).toBe(7);
        expect(env.result.metadata.title).toBe('Test');
    });

    it('writes a structured error envelope to stderr on API failure', async () => {
        const { deps, stderr, api } = makeDeps();
        api.getPageCount.mockRejectedValue(new Error('boom'));
        api.getMetadata.mockResolvedValue({ pageCount: 0, pageLabels: {} });

        const code = await runCli(['info', 'fake.pdf', '--json'], deps);
        expect(code).toBe(1);

        const env = JSON.parse(stderr.text()) as {
            ok: boolean;
            error: { name: string; message: string };
        };
        expect(env.ok).toBe(false);
        expect(env.error.message).toBe('boom');
    });
});

describe('runCli — extract command', () => {
    it('passes --pages, --analysis-window, --language through to extractPdf', async () => {
        const { deps, api } = makeDeps();
        api.extractPdf.mockResolvedValue({
            pages: [{ index: 0 }, { index: 1 }],
            analysis: {},
            fullText: '',
            metadata: {},
        });

        const code = await runCli(
            [
                'extract',
                'fake.pdf',
                '--pages',
                '0,1',
                '--analysis-window',
                '3',
                '--language',
                'en',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        const call = api.extractPdf.mock.calls[0][0];
        expect(call).toMatchObject({
            mode: 'structured',
            pageIndices: [0, 1],
            analysisWindow: 3,
            structured: { splitterConfig: { type: 'sentencex', language: 'en' } },
        });
    });

    it('rejects --pages with a non-integer value via a structured error', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['extract', 'fake.pdf', '--pages', '0,abc', '--json'],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as {
            ok: boolean;
            error: { message: string };
        };
        expect(env.ok).toBe(false);
        expect(env.error.message).toContain('--pages');
    });
});

describe('runCli — overlay command', () => {
    it('runs structured extract → builder → drawOverlay → writePngFile (and sidecar)', async () => {
        const { deps, api } = makeDeps();
        api.renderPages.mockResolvedValue({
            pageCount: 1,
            pageLabels: {},
            pages: [
                {
                    pageIndex: 0,
                    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
                    width: 1000,
                    height: 1500,
                    format: 'png',
                    scale: 2,
                    dpi: 144,
                },
            ],
        });
        api.extractPdf.mockResolvedValue({
            pages: [
                {
                    index: 0,
                    width: 500,
                    height: 750,
                    blocks: [],
                    content: '',
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
                },
            ],
            analysis: {},
            fullText: '',
            metadata: {},
        });

        const code = await runCli(
            [
                'overlay',
                'fake.pdf',
                '--page',
                '0',
                '--level',
                'sentences',
                '--out',
                '/tmp/out.png',
                '--sidecar-json',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        expect(deps.drawOverlay).toHaveBeenCalledTimes(1);
        expect(deps.writePngFile).toHaveBeenCalledWith(
            '/tmp/out.png',
            expect.any(Uint8Array),
        );
        expect(deps.writeJsonFile).toHaveBeenCalledWith(
            '/tmp/out.png.json',
            expect.objectContaining({ ok: true }),
            false,
        );
    });
});

describe('runCli — render command', () => {
    it('writes per-page PNGs and reports paths in JSON, never base64', async () => {
        const { deps, stdout, api } = makeDeps();
        api.renderPages.mockResolvedValue({
            pageCount: 3,
            pageLabels: { 0: '1', 1: '2' },
            pages: [
                {
                    pageIndex: 0,
                    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
                    width: 100,
                    height: 200,
                    format: 'png',
                    scale: 1,
                    dpi: 72,
                },
                {
                    pageIndex: 1,
                    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]),
                    width: 100,
                    height: 200,
                    format: 'png',
                    scale: 1,
                    dpi: 72,
                },
            ],
        });

        const code = await runCli(
            ['render', 'fake.pdf', '--pages', '0,1', '--out', '/tmp/render', '--json'],
            deps,
        );
        expect(code).toBe(0);
        expect(deps.writePngFile).toHaveBeenCalledTimes(2);
        const env = JSON.parse(stdout.text()) as {
            result: {
                pages: Array<{
                    path: string;
                    sha256: string;
                    base64?: string;
                    width: number;
                }>;
            };
        };
        expect(env.result.pages).toHaveLength(2);
        expect(env.result.pages[0].path).toMatch(/page-0000\.png$/);
        expect(env.result.pages[1].path).toMatch(/page-0001\.png$/);
        expect(env.result.pages[0].sha256).toMatch(/^[0-9a-f]{64}$/);
        // PNG bytes must NEVER be inlined unless --inline-base64 is set.
        expect(env.result.pages[0].base64).toBeUndefined();
    });

    it('inlines base64 only when --inline-base64 is explicitly set', async () => {
        const { deps, stdout, api } = makeDeps();
        api.renderPages.mockResolvedValue({
            pageCount: 1,
            pageLabels: {},
            pages: [
                {
                    pageIndex: 0,
                    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
                    width: 100,
                    height: 200,
                    format: 'png',
                    scale: 1,
                    dpi: 72,
                },
            ],
        });
        const code = await runCli(
            [
                'render',
                'fake.pdf',
                '--pages',
                '0',
                '--out',
                '/tmp/x.png',
                '--inline-base64',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        const env = JSON.parse(stdout.text()) as {
            result: { pages: Array<{ base64: string }> };
        };
        expect(env.result.pages[0].base64).toBe('iVBORw==');
    });
});

describe('buildProgram', () => {
    it('registers every top-level command', () => {
        const { deps } = makeDeps();
        const program = buildProgram(deps);
        const names = new Set(program.commands.map((c) => c.name()));
        // Set containment keeps the assertion resilient as commands land.
        for (const expected of [
            'analyze-layout',
            'extract',
            'fixture',
            'info',
            'overlay',
            'raw-detailed',
            'render',
        ]) {
            expect(names.has(expected), `missing command: ${expected}`).toBe(true);
        }
    });
});

describe('runCli — error envelope from option parsing', () => {
    // Regression: overlay and raw-detailed previously parsed argv-derived
    // options BEFORE the try block, so a bad `--page`/`--level` produced
    // commander's plain-text failure path even when `--json` was set.
    // Now those parses live inside the command try, so structured envelopes
    // are guaranteed.
    it('overlay --page abc --json writes a structured error envelope', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            [
                'overlay',
                'fake.pdf',
                '--page',
                'abc',
                '--level',
                'sentences',
                '--out',
                '/tmp/out.png',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as {
            ok: boolean;
            error: { message: string };
        };
        expect(env.ok).toBe(false);
        expect(env.error.message).toContain('--page');
    });

    it('overlay --level garbage --json writes a structured error envelope', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            [
                'overlay',
                'fake.pdf',
                '--page',
                '0',
                '--level',
                'garbage',
                '--out',
                '/tmp/out.png',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as {
            ok: boolean;
            error: { message: string };
        };
        expect(env.ok).toBe(false);
        expect(env.error.message).toContain('--level');
    });

    it('raw-detailed --page abc --json writes a structured error envelope', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['raw-detailed', 'fake.pdf', '--page', 'abc', '--json'],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as {
            ok: boolean;
            error: { message: string };
        };
        expect(env.ok).toBe(false);
        expect(env.error.message).toContain('--page');
    });
});

describe('runCli — analysis window accepts Infinity', () => {
    // Regression: parseAnalysisWindow used Number.isFinite which rejects
    // Infinity even though the error message and downstream
    // resolveAnalysisPages explicitly support it.
    it('extract --analysis-window Infinity passes Infinity to extractPdf', async () => {
        const { deps, api } = makeDeps();
        api.extractPdf.mockResolvedValue({
            pages: [{ index: 0 }],
            analysis: {},
            fullText: '',
            metadata: {},
        });
        const code = await runCli(
            [
                'extract',
                'fake.pdf',
                '--pages',
                '0',
                '--analysis-window',
                'Infinity',
                '--json',
            ],
            deps,
        );
        expect(code).toBe(0);
        expect(api.extractPdf.mock.calls[0][0].analysisWindow).toBe(
            Number.POSITIVE_INFINITY,
        );
    });

    it('extract --analysis-window 0 still works (lower bound)', async () => {
        const { deps, api } = makeDeps();
        api.extractPdf.mockResolvedValue({
            pages: [],
            analysis: {},
            fullText: '',
            metadata: {},
        });
        const code = await runCli(
            ['extract', 'fake.pdf', '--pages', '0', '--analysis-window', '0', '--json'],
            deps,
        );
        expect(code).toBe(0);
        expect(api.extractPdf.mock.calls[0][0].analysisWindow).toBe(0);
    });

    it('extract --analysis-window -1 rejects via structured envelope', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['extract', 'fake.pdf', '--pages', '0', '--analysis-window', '-1', '--json'],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toContain('--analysis-window');
    });

    it('extract --analysis-window 2.5 rejects via structured envelope (must be integer)', async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ['extract', 'fake.pdf', '--pages', '0', '--analysis-window', '2.5', '--json'],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toContain('--analysis-window');
    });
});

describe('runCli — --log-level global option', () => {
    it('accepts each valid level when placed before the subcommand', async () => {
        for (const level of ['error', 'warn', 'info', 'silent']) {
            const { deps, api } = makeDeps();
            api.getPageCount.mockResolvedValue({ count: 1 });
            api.getMetadata.mockResolvedValue({ pageCount: 1, pageLabels: {} });
            const code = await runCli(
                ['--log-level', level, 'info', 'fake.pdf', '--json'],
                deps,
            );
            expect(code).toBe(0);
        }
    });

    it('rejects an unknown level with a non-zero exit code', async () => {
        const { deps, api } = makeDeps();
        const code = await runCli(
            ['--log-level', 'loud', 'info', 'fake.pdf', '--json'],
            deps,
        );
        // commander resolves `InvalidArgumentError` from option parsing to
        // its own exitCode (1) and writes the message via its internal
        // output writer (not `deps.stderr`). What matters here is the
        // non-zero exit and that the action never ran.
        expect(code).not.toBe(0);
        expect(api.getPageCount).not.toHaveBeenCalled();
        expect(api.getMetadata).not.toHaveBeenCalled();
    });
});
