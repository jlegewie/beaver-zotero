/**
 * Regression: `node/api.ts` must funnel every op through the worker
 * `enqueue` FIFO so concurrent Node calls (e.g. the CLI `info` command
 * running `getPageCount` + `getMetadata` via `Promise.all`) don't race
 * on shared MuPDF/WASM heap state.
 *
 * We mock the worker ops to track concurrency and assert that two
 * deliberately-overlapping `getPageCount` calls do NOT overlap when they
 * pass through `node/api.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let inflight = 0;
let maxInflight = 0;
const sleep = (ms: number) =>
    new Promise<void>((res) => setTimeout(res, ms));

vi.mock('../../../src/beaver-extract/worker/ops', () => {
    async function tracked<T>(value: T): Promise<{ result: T }> {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await sleep(15);
        inflight--;
        return { result: value };
    }
    return {
        opGetPageCount: vi.fn(async () => tracked({ count: 7 })),
        opGetMetadata: vi.fn(async () =>
            tracked({ pageCount: 7, pageLabels: {} }),
        ),
        opExtract: vi.fn(async () =>
            tracked({ pages: [], analysis: {}, fullText: '', metadata: {} }),
        ),
        opAnalyzeLayout: vi.fn(async () =>
            tracked({
                pages: [],
                pageCount: 0,
                analysisPageIndices: [],
                analysis: {},
                metadata: {},
            }),
        ),
        opAnalyzeOCRNeeds: vi.fn(async () => tracked({ needsOCR: false })),
        opExtractRawPageDetailed: vi.fn(async () =>
            tracked({ pageIndex: 0, blocks: [], width: 0, height: 0 }),
        ),
        opRenderPages: vi.fn(async () =>
            tracked({ pageCount: 0, pageLabels: {}, pages: [] }),
        ),
    };
});

// Keep `ensureExtractionRuntime` from trying to load WASM in unit tests.
vi.mock('../../../src/beaver-extract/node/bootstrap', () => ({
    ensureExtractionRuntime: vi.fn(async () => undefined),
    ensureMuPDFNode: vi.fn(async () => undefined),
    ensureSentencexNode: vi.fn(async () => undefined),
}));

beforeEach(() => {
    inflight = 0;
    maxInflight = 0;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('node/api.ts serialization', () => {
    it('Promise.all of two ops never lets them overlap (queue is FIFO)', async () => {
        const { getPageCount, getMetadata } = await import(
            '../../../src/beaver-extract/node/api'
        );
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const [count, meta] = await Promise.all([
            getPageCount(bytes),
            getMetadata(bytes),
        ]);
        expect(count.count).toBe(7);
        expect(meta.pageCount).toBe(7);
        // Both ops would normally overlap (each takes ~15ms via the mock).
        // The shared `enqueue` chain must keep maxInflight at 1.
        expect(maxInflight).toBe(1);
    });

    it('three concurrent ops still run one at a time', async () => {
        const { getPageCount, getMetadata, extractPdf } = await import(
            '../../../src/beaver-extract/node/api'
        );
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        await Promise.all([
            getPageCount(bytes),
            getMetadata(bytes),
            extractPdf({ pdfData: bytes, pageIndices: [0] }),
        ]);
        expect(maxInflight).toBe(1);
    });
});
