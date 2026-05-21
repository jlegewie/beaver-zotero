/**
 * Unit tests for `BeaverExtractor.extract({ mode: "structured" })` — the
 * production sentence-level extraction path.
 *
 * The key regression check: the facade dispatches exactly one `extract`
 * worker op — NOT a fan-out of `getPageCount` /
 * `extractRawPageDetailed` / `extractSentenceDebug` calls. Also
 * verifies that the public `structured.splitter` / `structured.language`
 * args are translated to a serializable `splitterConfig` on the wire,
 * including the "explicit splitter wins over language" precedence rule.
 *
 * Uses the same MockWorker pattern as `mupdfWorkerClient.test.ts` so we
 * observe the actual `postMessage` payload — not just whether some
 * client method was called.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    MockWorker,
    setupZoteroMainWindowWithMockWorker,
} from '../../helpers/mockWorker';

import { disposeMuPDFWorker } from '../../../src/beaver-extract/MuPDFWorkerClient';
import { BeaverExtractor } from '../../../src/beaver-extract';
import {
    SCHEMA_VERSION,
    type StructuredExtractResult,
} from '../../../src/beaver-extract/schema';

const FAKE_STRUCTURED_RESULT: StructuredExtractResult = {
    mode: 'structured',
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    diagnostics: {
        engine: 'structured',
        settings: {},
        timings: {
            totalMs: 0,
            docOpenMs: 0,
            walkMs: 0,
            analysisMs: 0,
            perPageMs: [0],
        },
    },
    document: {
        pageCount: 1,
        bboxOrigin: 'top-left',
        bboxPrecision: 1,
        pages: [
            {
                index: 0,
                width: 612,
                height: 792,
                items: [
                    {
                        id: 'p1',
                        kind: 'text',
                        pageIndex: 0,
                        order: 0,
                        bbox: [0, 0, 100, 10],
                        text: 'A sentence.',
                        sentences: [
                            {
                                id: 's1',
                                order: 0,
                                text: 'A sentence.',
                                bboxes: [[0, 0, 100, 10]],
                            },
                        ],
                    },
                ],
            },
        ],
        citationIndex: {
            p1: { id: 'p1', kind: 'item', pageIndex: 0, itemId: 'p1' },
            s1: {
                id: 's1',
                kind: 'sentence',
                pageIndex: 0,
                itemId: 'p1',
                sentenceId: 's1',
            },
        },
    },
};

describe('BeaverExtractor.extract({ mode: "structured" }) — single worker round-trip', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        setupZoteroMainWindowWithMockWorker();
    });

    afterEach(async () => {
        await disposeMuPDFWorker();
        delete (globalThis as any).Zotero.__beaverMuPDFWorkerClient;
    });

    it('dispatches exactly one extract op (no fan-out)', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1, 2, 3]), {
            mode: 'structured',
            pageIndices: [0],
        });
        const worker = MockWorker.instances[0];
        expect(worker).toBeDefined();
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        // Exactly one posted op message (configure handshake is excluded
        // from `posted`), and it's the worker op we expect.
        expect(worker.posted).toHaveLength(1);
        const [message] = worker.opCall(0);
        expect(message).toMatchObject({
            op: 'extract',
            args: { mode: 'structured', pageIndices: [0] },
        });

        // None of the legacy main-thread fan-out ops appear on the wire.
        const ops = worker.posted.map(
            (p) => (p.message as { op: string }).op,
        );
        expect(ops).not.toContain('getPageCount');
        expect(ops).not.toContain('extractRawPageDetailed');
        expect(ops).not.toContain('extractSentenceDebug');
    });

    it('defaults splitter to { type: "sentencex", language: undefined } when none provided', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [0],
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured.splitterConfig).toEqual({
            type: 'sentencex',
            language: undefined,
        });
    });

    it('uses structured.language to seed sentencex when splitter is omitted', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [0],
            structured: { language: 'fr' },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured.splitterConfig).toEqual({
            type: 'sentencex',
            language: 'fr',
        });
    });

    it('forwards { type: "simple" } verbatim', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [0],
            structured: { splitter: { type: 'simple' } },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured.splitterConfig).toEqual({
            type: 'simple',
        });
    });

    it('forwards an explicit sentencex language verbatim', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [0],
            structured: {
                splitter: { type: 'sentencex', language: 'de' },
            },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured.splitterConfig).toEqual({
            type: 'sentencex',
            language: 'de',
        });
    });

    it('honors splitter precedence: explicit structured.splitter wins over structured.language', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [0],
            structured: {
                splitter: { type: 'sentencex', language: 'de' },
                language: 'en',
            },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured.splitterConfig).toEqual({
            type: 'sentencex',
            language: 'de',
        });
    });

    it('forwards paragraphSettings and analysisWindow on the wire', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [7],
            paragraphSettings: { headingFontSizeBoost: 1.2 } as any,
            analysisWindow: 5,
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args).toMatchObject({
            mode: 'structured',
            pageIndices: [7],
            paragraphSettings: { headingFontSizeBoost: 1.2 },
            analysisWindow: 5,
        });
    });

    it('does NOT carry a `structured` field on the wire when mode is markdown', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'markdown',
            pageIndices: [0],
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured).toBeUndefined();
    });

    it('returns the StructuredExtractResult shape with document items populated', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            pageIndices: [0],
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_STRUCTURED_RESULT });
        const result = await promise;

        expect(result.mode).toBe('structured');
        if (result.mode !== 'structured') return;
        expect(result.diagnostics?.engine).toBe('structured');
        expect(result.schemaVersion).toBe(SCHEMA_VERSION);
        expect(result.document.pages[0].items).toHaveLength(1);
        expect(result.document.pages[0].items[0]).toMatchObject({
            kind: 'text',
            sentences: expect.arrayContaining([
                expect.objectContaining({ text: 'A sentence.' }),
            ]),
        });
    });
});
