import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const endpoint = vi.hoisted(() => ({
    calls: [] as unknown[][],
    answer: (): Promise<unknown> => Promise.resolve({}),
}));
vi.mock('@beaver/agent-core/transport/apiService', () => ({
    ApiService: class {
        get(...args: unknown[]) {
            endpoint.calls.push(args);
            return endpoint.answer();
        }
    },
}));
const mutation = vi.hoisted(() => ({
    coordinateLibraryMutation: vi.fn(async (work: () => Promise<unknown>) => work()),
}));
vi.mock('../../../src/services/libraryMutations', () => mutation);

import { fetchRecordSnapshot, saveRecordSnapshot } from '../../../src/services/itemImport/recordSnapshot';

const Z = Zotero as any;
const rendered = {
    external_id: 'NCT04292899',
    title: 'ClinicalTrials.gov record (2026-11-03)',
    url: 'https://clinicaltrials.gov/study/NCT04292899',
    html: '<!DOCTYPE html><html><body>Record</body></html>',
    data_as_of: '2026-10-30',
};

beforeEach(() => {
    vi.clearAllMocks();
    endpoint.calls = [];
});

describe('fetchRecordSnapshot', () => {
    it('asks the record endpoint for the id, with a generous timeout', async () => {
        endpoint.answer = () => Promise.resolve(rendered);
        await expect(fetchRecordSnapshot('NCT04292899')).resolves.toEqual(rendered);
        expect(endpoint.calls).toEqual([[
            '/api/v1/external-references/NCT04292899/record',
            { timeoutMs: 45_000 },
        ]]);
    });

    it('fails when the backend fails', async () => {
        endpoint.answer = () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
        await expect(fetchRecordSnapshot('NCT00000000')).rejects.toThrow('Not found');
    });

    it('fails on an answer without HTML', async () => {
        endpoint.answer = () => Promise.resolve({ ...rendered, html: '  ' });
        await expect(fetchRecordSnapshot('NCT04292899')).rejects.toThrow(/empty/);
    });
});

describe('saveRecordSnapshot', () => {
    const parent = { id: 7, libraryID: 1, key: 'PARENTAA' } as any;

    beforeEach(() => {
        Z.Items = { getByLibraryAndKeyAsync: vi.fn(async () => ({ ...parent, deleted: false })) };
        Z.Attachments = { importFromSnapshotContent: vi.fn(async () => ({ key: 'RECORD01' })) };
    });

    it('stores the HTML as a snapshot child with the record URL and title, through the mutation queue', async () => {
        const signal = new AbortController().signal;
        const assertCurrent = vi.fn();
        const saved = await saveRecordSnapshot(parent, rendered.html, { title: rendered.title, url: rendered.url, signal, assertCurrent });
        expect(saved).toEqual({ key: 'RECORD01' });
        expect(Z.Attachments.importFromSnapshotContent).toHaveBeenCalledWith({
            url: rendered.url,
            title: rendered.title,
            snapshotContent: rendered.html,
            parentItemID: 7,
        });
        expect(mutation.coordinateLibraryMutation).toHaveBeenCalledWith(expect.any(Function), { signal, assertCurrent });
        expect(assertCurrent).toHaveBeenCalled();
    });

    it('saves nothing when access was revoked', async () => {
        const assertCurrent = () => { throw new Error('Library is excluded or unavailable'); };
        await expect(saveRecordSnapshot(parent, rendered.html, {
            title: rendered.title, url: rendered.url, signal: new AbortController().signal, assertCurrent,
        })).rejects.toThrow('excluded');
        expect(Z.Attachments.importFromSnapshotContent).not.toHaveBeenCalled();
    });

    it('saves nothing when the parent was deleted meanwhile', async () => {
        Z.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({ ...parent, deleted: true }));
        await expect(saveRecordSnapshot(parent, rendered.html, {
            title: rendered.title, url: rendered.url, signal: new AbortController().signal, assertCurrent: () => {},
        })).rejects.toThrow(/unavailable/);
        expect(Z.Attachments.importFromSnapshotContent).not.toHaveBeenCalled();
    });
});
