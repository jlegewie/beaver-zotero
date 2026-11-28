import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { assertTagsSaved, isTagCacheError, rebuildTagCache, rebuildTagCacheQueued, withTagCacheRepair } from '../../../src/services/tagCache';

const Z = Zotero as any;

// Errors Zotero raised for a user whose tag cache had drifted from the `tags` table.
const MAPPED_ID_WITHOUT_ROW = 'Error(s) encountered during statement execution: FOREIGN KEY constraint failed '
    + '[QUERY: INSERT OR REPLACE INTO itemTags (itemID, tagID, type) VALUES (?, ?, ?)] [PARAMS: 417, 210, 0] '
    + '[ERROR: FOREIGN KEY constraint failed]';
const ROW_WITHOUT_MAPPING = 'Error(s) encountered during statement execution: UNIQUE constraint failed: tags.name '
    + '[QUERY: INSERT INTO tags (tagID, name) VALUES (?, ?)] [PARAMS: 199, "ethnobotany"] [ERROR: UNIQUE constraint failed: tags.name]';
const REMOVED_WITHOUT_MAPPING = "Invalid boolean parameter 1 'false' [QUERY: DELETE FROM itemTags WHERE itemID=? AND tagID=? AND type=?]";

let inTransaction: boolean;
let initCalledInTransaction: boolean[];

beforeEach(() => {
    vi.clearAllMocks();
    inTransaction = false;
    initCalledInTransaction = [];
    Z.DB = {
        executeTransaction: vi.fn(async (work: () => Promise<unknown>) => {
            inTransaction = true;
            try { return await work(); } finally { inTransaction = false; }
        }),
    };
    Z.Tags = {
        init: vi.fn(async () => { initCalledInTransaction.push(inTransaction); }),
    };
    Z.Beaver = { libraryOperations: { run: vi.fn(async () => rebuildTagCache()) } };
});

describe('isTagCacheError', () => {
    it.each([MAPPED_ID_WITHOUT_ROW, ROW_WITHOUT_MAPPING, REMOVED_WITHOUT_MAPPING])('recognizes %s', (message) => {
        expect(isTagCacheError(new Error(message))).toBe(true);
        expect(isTagCacheError(message)).toBe(true);
    });

    it('ignores other constraint failures', () => {
        expect(isTagCacheError(new Error('FOREIGN KEY constraint failed [QUERY: INSERT INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)]'))).toBe(false);
        expect(isTagCacheError(new Error('UNIQUE constraint failed: collections.key'))).toBe(false);
        expect(isTagCacheError(new Error('database is locked'))).toBe(false);
        expect(isTagCacheError(undefined)).toBe(false);
    });
});

describe('rebuildTagCache', () => {
    it('reloads Zotero.Tags inside its own transaction', async () => {
        await rebuildTagCache();
        expect(Z.Tags.init).toHaveBeenCalledOnce();
        expect(initCalledInTransaction).toEqual([true]);
    });

    it('shares one rebuild between concurrent callers', async () => {
        await Promise.all([rebuildTagCache(), rebuildTagCache(), rebuildTagCache()]);
        expect(Z.Tags.init).toHaveBeenCalledOnce();
        await rebuildTagCache();
        expect(Z.Tags.init).toHaveBeenCalledTimes(2);
    });
});

describe('rebuildTagCacheQueued', () => {
    it('runs the rebuild as a library operation, shared between concurrent callers', async () => {
        await Promise.all([rebuildTagCacheQueued(), rebuildTagCacheQueued()]);
        expect(Z.Beaver.libraryOperations.run).toHaveBeenCalledOnce();
        expect(Z.Beaver.libraryOperations.run).toHaveBeenCalledWith('rebuildTagCache', []);
        expect(Z.Tags.init).toHaveBeenCalledOnce();
    });
});

describe('withTagCacheRepair', () => {
    it('rebuilds the cache and saves again after a stale-tag failure', async () => {
        const save = vi.fn()
            .mockRejectedValueOnce(new Error(MAPPED_ID_WITHOUT_ROW))
            .mockResolvedValueOnce('saved');
        await expect(withTagCacheRepair(save, 'test')).resolves.toBe('saved');
        expect(save).toHaveBeenCalledTimes(2);
        expect(Z.Tags.init).toHaveBeenCalledOnce();
        // The rebuild happens between the attempts, not during one.
        expect(Z.Tags.init.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[1]);
    });

    it('runs the retry checks after the rebuild and skips the retry when they fail', async () => {
        const save = vi.fn().mockRejectedValue(new Error(MAPPED_ID_WITHOUT_ROW));
        const beforeRetry = vi.fn(() => { throw new Error('Library is excluded'); });
        await expect(withTagCacheRepair(save, 'test', { beforeRetry })).rejects.toThrow('Library is excluded');
        expect(save).toHaveBeenCalledOnce();
        expect(Z.Tags.init.mock.invocationCallOrder[0]).toBeLessThan(beforeRetry.mock.invocationCallOrder[0]);
    });

    it('does not run the retry checks when the first save succeeds', async () => {
        const beforeRetry = vi.fn();
        await withTagCacheRepair(async () => 'saved', 'test', { beforeRetry });
        expect(beforeRetry).not.toHaveBeenCalled();
    });

    it('retries only once', async () => {
        const save = vi.fn().mockRejectedValue(new Error(ROW_WITHOUT_MAPPING));
        await expect(withTagCacheRepair(save, 'test')).rejects.toThrow('tags.name');
        expect(save).toHaveBeenCalledTimes(2);
        expect(Z.Tags.init).toHaveBeenCalledOnce();
    });

    it('does not retry other failures', async () => {
        const save = vi.fn().mockRejectedValue(new Error('database is locked'));
        await expect(withTagCacheRepair(save, 'test')).rejects.toThrow('database is locked');
        expect(save).toHaveBeenCalledOnce();
        expect(Z.Tags.init).not.toHaveBeenCalled();
    });

    it('does not retry a save that already committed', async () => {
        const save = vi.fn().mockRejectedValue(Object.assign(new Error(MAPPED_ID_WITHOUT_ROW), { committed: true }));
        await expect(withTagCacheRepair(save, 'test')).rejects.toThrow('FOREIGN KEY');
        expect(save).toHaveBeenCalledOnce();
    });
});

describe('assertTagsSaved', () => {
    const stored = (names: string[]) => {
        Z.DB.queryAsync = vi.fn(async (_sql: string, _params: unknown[], opts?: { onRow?: (row: any) => void }) => {
            for (const name of names) opts?.onRow?.({ getResultByIndex: () => name });
        });
    };

    it('passes when every requested tag is stored, compared the way Zotero stores names', async () => {
        stored(['ethnobotany', 'Café']);
        await expect(assertTagsSaved(42, [' ethnobotany ', 'Cafe\u0301'])).resolves.toBeUndefined();
        expect(Z.DB.queryAsync).toHaveBeenCalledWith(expect.stringContaining('itemTags'), [42], expect.anything());
    });

    it('accepts a tag Zotero matched to an existing row stored with whitespace or decomposed Unicode', async () => {
        stored([' ethnobotany ', 'Cafe\u0301']);
        await expect(assertTagsSaved(42, ['ethnobotany', 'Caf\u00e9'])).resolves.toBeUndefined();
    });

    it('throws a tag-cache error naming the missing tags', async () => {
        stored(['ethnobotany']);
        const error = await assertTagsSaved(42, ['ethnobotany', 'TB phytochemicals']).catch((e) => e);
        expect(error.message).toBe('Requested tags were not saved on item 42: TB phytochemicals');
        expect(isTagCacheError(error)).toBe(true);
        expect(isTagCacheError(error.message)).toBe(true);
    });

    it('skips the read when no tags were requested', async () => {
        stored([]);
        await assertTagsSaved(42, ['  ']);
        expect(Z.DB.queryAsync).not.toHaveBeenCalled();
    });
});
