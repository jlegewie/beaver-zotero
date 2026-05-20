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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePDFForTests } from '../../helpers/configurePDFForTests';

import { disposeMuPDFWorker } from '../../../src/beaver-extract/MuPDFWorkerClient';
import { BeaverExtractor } from '../../../src/beaver-extract';

class MockWorker {
    static instances: MockWorker[] = [];
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onmessageerror: ((event: any) => void) | null = null;
    posted: Array<{ message: any; transfer: Transferable[] | undefined }> = [];
    configureMessages: any[] = [];
    postMessage = vi.fn((message: any, transfer?: Transferable[]) => {
        if (message?.kind === 'configure') {
            this.configureMessages.push(message);
            return;
        }
        this.posted.push({ message, transfer });
    });
    terminate = vi.fn();

    constructor(public url: string, public options: any) {
        MockWorker.instances.push(this);
    }

    /** Helper: deliver a reply to the most recently posted op message. */
    replyToLast(reply: any): void {
        const last = this.posted[this.posted.length - 1];
        const id = (last?.message as { id: number } | undefined)?.id;
        this.onmessage?.({ data: { id, ...reply } });
    }

    opCall(n: number): [any, Transferable[] | undefined] {
        const e = this.posted[n];
        return [e?.message, e?.transfer];
    }
}

function setupZoteroMainWindowWithMockWorker() {
    const win: any = { Worker: MockWorker };
    (globalThis as any).Zotero = (globalThis as any).Zotero ?? {};
    (globalThis as any).Zotero.getMainWindow = vi.fn(() => win);
    (globalThis as any).Zotero.__beaverMuPDFWorkerClient = undefined;
    configurePDFForTests({
        slotHost: (globalThis as any).Zotero,
        slotKey: '__beaverMuPDFWorkerClient',
        getWorkerHost: () => win,
    });
}

const FAKE_EXTRACTION_RESULT = {
    pages: [
        {
            index: 0,
            label: undefined,
            width: 612,
            height: 792,
            content: '## Title\n\nA sentence.',
            columns: [],
            items: [],
            sentences: [],
        },
    ],
    analysis: {
        pageCount: 1,
        hasTextLayer: true,
        styleProfile: {} as any,
        marginAnalysis: {} as any,
    },
    fullText: '## Title\n\nA sentence.',
    metadata: {
        extractedAt: new Date().toISOString(),
        version: '3.0.0',
        settings: {},
        engine: 'structured',
        timings: {
            totalMs: 0,
            docOpenMs: 0,
            walkMs: 0,
            analysisMs: 0,
            perPageMs: [0],
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
        });
        const worker = MockWorker.instances[0];
        expect(worker).toBeDefined();
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
        await promise;

        // Exactly one posted op message (configure handshake is excluded
        // from `posted`), and it's the worker op we expect.
        expect(worker.posted).toHaveLength(1);
        const [message] = worker.opCall(0);
        expect(message).toMatchObject({
            op: 'extract',
            args: { mode: 'structured' },
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
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
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
            structured: { language: 'fr' },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
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
            structured: { splitter: { type: 'simple' } },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured.splitterConfig).toEqual({
            type: 'simple',
        });
    });

    it('forwards an explicit sentencex language verbatim', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
            structured: {
                splitter: { type: 'sentencex', language: 'de' },
            },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
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
            structured: {
                splitter: { type: 'sentencex', language: 'de' },
                language: 'en',
            },
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
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
            paragraphSettings: { headingFontSizeBoost: 1.2 } as any,
            analysisWindow: 5,
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args).toMatchObject({
            mode: 'structured',
            paragraphSettings: { headingFontSizeBoost: 1.2 },
            analysisWindow: 5,
        });
    });

    it('does NOT carry a `structured` field on the wire when mode is markdown', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'markdown',
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.structured).toBeUndefined();
    });

    it('returns the InternalExtractionResult shape with structured fields populated', async () => {
        const promise = new BeaverExtractor().extract(new Uint8Array([1]), {
            mode: 'structured',
        });
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_EXTRACTION_RESULT });
        const result = await promise;

        expect(result.metadata.engine).toBe('structured');
        expect(result.metadata.version).toBe('3.0.0');
        expect(result.pages[0]).toHaveProperty('items');
        expect(result.pages[0]).toHaveProperty('sentences');
        expect(result.pages[0]).not.toHaveProperty('paragraphs');
    });
});
