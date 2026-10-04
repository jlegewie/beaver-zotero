import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ensureLibraryItemsLoaded,
    getParentItemAsync,
    isInTrashAsync,
    readWithDataReload,
} from '../../../src/utils/zoteroDataLoading';

function unloadedDataError(message = "'creators' not loaded for item"): Error {
    const error = new Error(message);
    error.name = 'UnloadedDataException';
    return error;
}

describe('ensureLibraryItemsLoaded', () => {
    let libraries: Map<number, { getDataLoaded: ReturnType<typeof vi.fn>; waitForDataLoad: ReturnType<typeof vi.fn> }>;

    beforeEach(() => {
        vi.clearAllMocks();
        libraries = new Map([
            [1, { getDataLoaded: vi.fn(() => true), waitForDataLoad: vi.fn().mockResolvedValue(undefined) }],
            [5, { getDataLoaded: vi.fn(() => false), waitForDataLoad: vi.fn().mockResolvedValue(undefined) }],
        ]);
        (globalThis as any).Zotero.Libraries = {
            exists: vi.fn((id: number) => libraries.has(id)),
            get: vi.fn((id: number) => libraries.get(id) ?? false),
        };
    });

    it('loads items only for libraries that are not loaded yet, once per library', async () => {
        expect(await ensureLibraryItemsLoaded([1, 5, 5])).toEqual([5]);

        expect(libraries.get(1)!.waitForDataLoad).not.toHaveBeenCalled();
        expect(libraries.get(5)!.waitForDataLoad).toHaveBeenCalledOnce();
        expect(libraries.get(5)!.waitForDataLoad).toHaveBeenCalledWith('item');
    });

    it('ignores invalid and unknown library ids', async () => {
        await ensureLibraryItemsLoaded([null, undefined, 0, -1, 1.5, 99]);

        expect((globalThis as any).Zotero.Libraries.get).not.toHaveBeenCalled();
    });

    it('does not throw when a library fails to load', async () => {
        libraries.get(5)!.waitForDataLoad.mockRejectedValue(new Error('database locked'));

        await expect(ensureLibraryItemsLoaded([5])).resolves.toEqual([]);
    });
});

describe('getParentItemAsync / isInTrashAsync', () => {
    const items = new Map<number, any>();

    beforeEach(() => {
        items.clear();
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async (id: number) => items.get(id) ?? false),
        };
    });

    it('loads the parent asynchronously and returns null for top-level items', async () => {
        const parent = { id: 1, parentID: false, deleted: false };
        items.set(1, parent);

        expect(await getParentItemAsync({ id: 2, parentID: 1 } as any)).toBe(parent);
        expect(await getParentItemAsync({ id: 1, parentID: false } as any)).toBeNull();
    });

    it('reports a child as trashed when an ancestor is trashed', async () => {
        items.set(1, { id: 1, parentID: false, deleted: true });
        items.set(2, { id: 2, parentID: 1, deleted: false });

        expect(await isInTrashAsync({ id: 3, parentID: 2, deleted: false } as any)).toBe(true);
    });

    it('reports a child as not trashed when no ancestor is trashed', async () => {
        items.set(1, { id: 1, parentID: false, deleted: false });

        expect(await isInTrashAsync({ id: 2, parentID: 1, deleted: false } as any)).toBe(false);
    });
});

describe('readWithDataReload', () => {
    beforeEach(() => {
        (globalThis as any).Zotero.Items = {
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('reloads the data types and retries once when Zotero reports unloaded data', async () => {
        const item = { id: 1 } as any;
        const read = vi.fn()
            .mockImplementationOnce(() => { throw unloadedDataError(); })
            .mockImplementationOnce(() => 'value');

        await expect(readWithDataReload(item, ['creators'], read)).resolves.toBe('value');
        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith([item], ['creators']);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('rethrows other errors without reloading', async () => {
        const read = vi.fn(() => { throw new Error('boom'); });

        await expect(readWithDataReload({ id: 1 } as any, ['creators'], read)).rejects.toThrow('boom');
        expect((globalThis as any).Zotero.Items.loadDataTypes).not.toHaveBeenCalled();
    });

    it('propagates a second unloaded-data error', async () => {
        const read = vi.fn(() => { throw unloadedDataError(); });

        await expect(readWithDataReload({ id: 1 } as any, ['creators'], read)).rejects.toThrow('not loaded');
        expect(read).toHaveBeenCalledTimes(2);
    });
});
