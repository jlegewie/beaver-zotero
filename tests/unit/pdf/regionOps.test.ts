/**
 * Unit tests for `opDetectRegions` page-error handling
 * (`src/beaver-extract/worker/regionOps.ts`).
 *
 * The doc cache, WASM init, page walk and region detector are mocked; the real
 * `wasmFatal` classification is used. Ordinary page errors are reported per
 * page; a WASM trap or heap exhaustion must abort the op and mark the cached
 * document failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    acquireDoc: vi.fn(),
    releaseDoc: vi.fn(),
    extractRawPageDetailedFromDoc: vi.fn(),
    resolveTruePageCount: vi.fn(),
    detectRegions: vi.fn(),
    ensureApi: vi.fn(),
}));

vi.mock('../../../src/beaver-extract/worker/docCache', () => ({
    acquireDoc: mocks.acquireDoc,
    releaseDoc: mocks.releaseDoc,
}));
vi.mock('../../../src/beaver-extract/worker/docHelpers', () => ({
    extractRawPageDetailedFromDoc: mocks.extractRawPageDetailedFromDoc,
    resolveTruePageCount: mocks.resolveTruePageCount,
}));
vi.mock('../../../src/beaver-extract/worker/wasmInit', () => ({
    ensureApi: mocks.ensureApi,
}));
vi.mock('../../../src/beaver-extract/regions/RegionDetector', () => ({
    detectRegions: mocks.detectRegions,
}));
vi.mock('../../../src/beaver-extract/regions/docContext', () => ({
    buildRegionDocContext: vi.fn(() => ({})),
}));

import { opDetectRegions } from '../../../src/beaver-extract/worker/regionOps';

const RECOVERABLE = () => new Error('syntax error in content stream');
const FATAL = () => new Error('memory access out of bounds');
const OOM = () => new Error('malloc (1048576 bytes) failed');

/** Fake doc whose `loadPage(i)` throws for indices in `contextErrors`. */
function makeDoc(contextErrors: Record<number, () => Error> = {}) {
    return {
        loadPage: vi.fn((i: number) => {
            if (contextErrors[i]) throw contextErrors[i]();
            return { getGraphicsSummary: () => ({ count: 0, overflow: false }), destroy: vi.fn() };
        }),
    };
}

/** Make the page walk fail (or succeed) per target page index. */
function walkResults(errors: Record<number, () => Error>) {
    mocks.extractRawPageDetailedFromDoc.mockImplementation(
        (_doc: unknown, i: number, _b: boolean, _f: unknown, _o: unknown, onGraphics: (g: unknown) => void) => {
            if (errors[i]) throw errors[i]();
            onGraphics({ count: 1, overflow: false });
            return { width: 100, height: 200 };
        },
    );
}

describe('opDetectRegions page errors', () => {
    let doc: ReturnType<typeof makeDoc>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureApi.mockResolvedValue({ supportsGraphicsSummary: true, Font: {} });
        mocks.resolveTruePageCount.mockReturnValue(4);
        mocks.detectRegions.mockReturnValue({ scanned: false, bodySize: 10, ms: 0, candidates: [] });
        doc = makeDoc();
        mocks.acquireDoc.mockResolvedValue(doc);
    });

    const run = (pageIndices: number[], contextPages = 4) =>
        opDetectRegions({ pdfData: new Uint8Array(1), pageIndices, contextPages, classify: false });

    it('reports a recoverable target-page error as that page error and succeeds', async () => {
        walkResults({ 1: RECOVERABLE });

        const { result } = await run([0, 1]);

        expect(result.pages[0].error).toBeUndefined();
        expect(result.pages[1].error).toMatch(/syntax error/);
        expect(mocks.releaseDoc).toHaveBeenCalledWith(doc, false);
    });

    it('rejects and marks the document failed on a fatal target-page error', async () => {
        walkResults({ 1: FATAL });

        await expect(run([0, 1])).rejects.toThrow(/memory access out of bounds/);

        expect(mocks.releaseDoc).toHaveBeenCalledTimes(1);
        expect(mocks.releaseDoc).toHaveBeenCalledWith(doc, true);
    });

    it('rejects and marks the document failed on heap exhaustion', async () => {
        walkResults({ 0: OOM });

        await expect(run([0])).rejects.toThrow(/malloc/);

        expect(mocks.releaseDoc).toHaveBeenCalledWith(doc, true);
    });

    it('ignores a recoverable context-page error', async () => {
        walkResults({});
        doc = makeDoc({ 2: RECOVERABLE });
        mocks.acquireDoc.mockResolvedValue(doc);

        const { result } = await run([0]);

        expect(result.pages[0].error).toBeUndefined();
        expect(doc.loadPage).toHaveBeenCalledWith(2);
        expect(mocks.releaseDoc).toHaveBeenCalledWith(doc, false);
    });

    it('rejects and marks the document failed on a fatal context-page error', async () => {
        walkResults({});
        doc = makeDoc({ 2: FATAL });
        mocks.acquireDoc.mockResolvedValue(doc);

        await expect(run([0])).rejects.toThrow(/memory access out of bounds/);

        expect(mocks.releaseDoc).toHaveBeenCalledTimes(1);
        expect(mocks.releaseDoc).toHaveBeenCalledWith(doc, true);
    });
});
