/**
 * Unit tests for `PDFExtractor.extractSentenceBBoxes` after the worker flip.
 *
 * The key regression check: the facade dispatches exactly one
 * `extractSentenceBBoxes` worker op — NOT three separate
 * `getPageCount` / `extractRawPages` / `extractRawPageDetailed` calls
 * (which is what the pre-flip main-thread path did). It also verifies
 * that the public `splitter: SentenceSplitterConfig` arg is translated
 * to a serializable `splitterConfig` on the wire, including the
 * "explicit splitter wins over args.language" precedence rule.
 *
 * Uses the same MockWorker pattern as `mupdfWorkerClient.test.ts` so we
 * observe the actual `postMessage` payload — not just whether some
 * client method was called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePDFForTests } from '../../helpers/configurePDFForTests';

import { disposeMuPDFWorker } from '../../../src/services/pdf/MuPDFWorkerClient';
import { PDFExtractor } from '../../../src/services/pdf';

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

const FAKE_RESULT = {
    paragraphs: [],
    sentences: [],
    unmappedParagraphs: 0,
    degradedParagraphs: 0,
};

describe('PDFExtractor.extractSentenceBBoxes — single worker round-trip', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        setupZoteroMainWindowWithMockWorker();
    });

    afterEach(async () => {
        await disposeMuPDFWorker();
        delete (globalThis as any).Zotero.__beaverMuPDFWorkerClient;
    });

    it('dispatches exactly one extractSentenceBBoxes op (no fan-out)', async () => {
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1, 2, 3]),
            { pageIndex: 0 },
        );
        const worker = MockWorker.instances[0];
        expect(worker).toBeDefined();
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        // Exactly one posted op message (configure handshake is excluded
        // from `posted`), and it's the worker op we expect.
        expect(worker.posted).toHaveLength(1);
        const [message] = worker.opCall(0);
        expect(message).toMatchObject({
            op: 'extractSentenceBBoxes',
            args: { pageIndex: 0 },
        });

        // None of the legacy main-thread fan-out ops appear on the wire.
        const ops = worker.posted.map(
            (p) => (p.message as { op: string }).op,
        );
        expect(ops).not.toContain('getPageCount');
        expect(ops).not.toContain('extractRawPages');
        expect(ops).not.toContain('extractRawPageDetailed');
    });

    it('defaults splitter to { type: "sentencex", language: undefined } when none provided', async () => {
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1]),
            { pageIndex: 0 },
        );
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.options.splitterConfig).toEqual({
            type: 'sentencex',
            language: undefined,
        });
    });

    it('uses args.language to seed sentencex when splitter is omitted', async () => {
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1]),
            { pageIndex: 0, language: 'fr' },
        );
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.options.splitterConfig).toEqual({
            type: 'sentencex',
            language: 'fr',
        });
    });

    it('forwards { type: "simple" } verbatim', async () => {
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1]),
            { pageIndex: 0, splitter: { type: 'simple' } },
        );
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.options.splitterConfig).toEqual({ type: 'simple' });
    });

    it('forwards an explicit sentencex language verbatim', async () => {
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1]),
            {
                pageIndex: 0,
                splitter: { type: 'sentencex', language: 'de' },
            },
        );
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.options.splitterConfig).toEqual({
            type: 'sentencex',
            language: 'de',
        });
    });

    it('honors splitter precedence: explicit splitter.language wins over args.language', async () => {
        // Both fields set: the explicit splitter config must win — args.language
        // is only consulted when `splitter` is omitted entirely.
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1]),
            {
                pageIndex: 0,
                splitter: { type: 'sentencex', language: 'de' },
                language: 'en',
            },
        );
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args.options.splitterConfig).toEqual({
            type: 'sentencex',
            language: 'de',
        });
    });

    it('forwards paragraphSettings and analysisWindow on the wire', async () => {
        const promise = new PDFExtractor().extractSentenceBBoxes(
            new Uint8Array([1]),
            {
                pageIndex: 7,
                paragraphSettings: { headingFontSizeBoost: 1.2 } as any,
                analysisWindow: 5,
            },
        );
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: FAKE_RESULT });
        await promise;

        const [message] = worker.opCall(0);
        expect(message.args).toMatchObject({
            pageIndex: 7,
            options: {
                paragraphSettings: { headingFontSizeBoost: 1.2 },
                analysisWindow: 5,
            },
        });
    });
});
