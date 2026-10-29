import { describe, expect, it, vi } from 'vitest';

const hotClient = vi.hoisted(() => ({ slot: 'hot' }));

vi.mock('../../../src/beaver-extract/MuPDFWorkerClient', async () => {
    const actual = await vi.importActual<typeof import('../../../src/beaver-extract/MuPDFWorkerClient')>(
        '../../../src/beaver-extract/MuPDFWorkerClient',
    );
    return { ...actual, getMuPDFWorkerClient: vi.fn(() => hotClient) };
});

import { BeaverExtractor, type WorkerClientRunner } from '../../../src/beaver-extract';

function routedClient() {
    const op = (name: string) => vi.fn(async () => name);
    return {
        extract: op('extract'),
        analyzeLayout: op('analyzeLayout'),
        analyzeOCRNeeds: op('analyzeOCRNeeds'),
        getPageCount: op('getPageCount'),
        getMetadata: op('getMetadata'),
        renderPages: op('renderPages'),
        search: op('search'),
    };
}

describe('BeaverExtractor with a request worker', () => {
    it('runs every op on the worker the runner chose', async () => {
        const client = routedClient();
        const runner: WorkerClientRunner = { run: vi.fn((op) => op(client as never)) };
        const extractor = new BeaverExtractor(runner);
        const pdf = new Uint8Array([1]);
        const signal = new AbortController().signal;

        await expect(extractor.getPageCount(pdf, signal)).resolves.toBe('getPageCount');
        await expect(extractor.getMetadata(pdf, signal)).resolves.toBe('getMetadata');
        await expect(extractor.renderPages(pdf, { pageIndices: [0] }, signal)).resolves.toBe('renderPages');
        await expect(extractor.search(pdf, 'q', { maxPageCount: 5 }, signal)).resolves.toBe('search');
        await expect(extractor.extract(pdf, { mode: 'markdown' }, signal)).resolves.toBe('extract');
        await expect(extractor.analyzeLayout(pdf)).resolves.toBe('analyzeLayout');
        await expect(extractor.analyzeOCRNeeds(pdf, {}, signal)).resolves.toBe('analyzeOCRNeeds');

        expect(runner.run).toHaveBeenCalledTimes(7);
        expect(client.getPageCount).toHaveBeenCalledWith(pdf, signal);
        expect(client.renderPages).toHaveBeenCalledWith(pdf, { pageIndices: [0] }, signal);
        expect(client.search).toHaveBeenCalledWith(pdf, 'q', {}, { maxPageCount: 5 }, signal);
    });

    it('uses the hot worker without a runner', async () => {
        Object.assign(hotClient, { getPageCount: vi.fn(async () => 7) });
        await expect(new BeaverExtractor().getPageCount(new Uint8Array([1]))).resolves.toBe(7);
    });
});
