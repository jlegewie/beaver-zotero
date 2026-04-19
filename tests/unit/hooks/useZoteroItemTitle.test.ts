/**
 * Pure-function unit tests for `resolveAndCacheTitle`.
 *
 * The helper is fully dependency-injected, so every async hop
 * (getItem → getItemByID → loadItemDataTypes → resolveTitle → writeCache)
 * is mockable in isolation. Tests here cover the happy path, the parent-
 * load branch (including the reviewer-flagged attachment-with-uncached-
 * parent regression case), each async rejection, and cancellation at
 * each of the four checkpoints.
 *
 * The `libraryId=0` / `zoteroKey=''` guards live in the hook wrapper
 * (not here) — the helper takes `number` / `string` and does not gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The hook module imports shortItemTitle from zoteroUtils, which transitively
// pulls in apiService/supabase env validation. Stubbing here keeps the pure-
// helper tests runnable in the Node-only unit environment. Matches the
// pattern used in tests/unit/notes/editNote.test.ts.
vi.mock('../../../src/utils/zoteroUtils', () => ({
    shortItemTitle: vi.fn(async (_item: any) => 'stubbed-title'),
}));
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import { resolveAndCacheTitle, type ResolveAndCacheTitleInput } from '../../../react/hooks/useZoteroItemTitle';
import { createMockItem } from '../../helpers/factories';

type Collaborators = Pick<
    ResolveAndCacheTitleInput,
    'getItem' | 'getItemByID' | 'loadItemDataTypes' | 'resolveTitle' | 'writeCache' | 'isCancelled' | 'logError'
>;

function makeCollaborators(overrides: Partial<Collaborators> = {}): Collaborators {
    return {
        getItem: vi.fn().mockResolvedValue(undefined),
        getItemByID: vi.fn().mockResolvedValue(null),
        loadItemDataTypes: vi.fn().mockResolvedValue(undefined),
        resolveTitle: vi.fn().mockResolvedValue(''),
        writeCache: vi.fn(),
        isCancelled: vi.fn().mockReturnValue(false),
        logError: vi.fn(),
        ...overrides,
    };
}

async function run(collaborators: Collaborators, overrides: Partial<ResolveAndCacheTitleInput> = {}) {
    await resolveAndCacheTitle({
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        cacheKey: 'cache-key',
        ...collaborators,
        ...overrides,
    });
}

describe('resolveAndCacheTitle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('case 1: cache miss happy path calls getItem, loadItemDataTypes, resolveTitle, writeCache in order', async () => {
        const item = createMockItem();
        const order: string[] = [];
        const collaborators = makeCollaborators({
            getItem: vi.fn(async () => { order.push('getItem'); return item as any; }),
            loadItemDataTypes: vi.fn(async () => { order.push('loadItemDataTypes'); }),
            resolveTitle: vi.fn(async () => { order.push('resolveTitle'); return 'My Title'; }),
            writeCache: vi.fn(() => { order.push('writeCache'); }),
        });

        await run(collaborators);

        expect(collaborators.getItem).toHaveBeenCalledWith(1, 'ABCD1234');
        expect(collaborators.loadItemDataTypes).toHaveBeenCalledWith([item], ['itemData', 'note']);
        expect(collaborators.resolveTitle).toHaveBeenCalledWith(item);
        expect(collaborators.writeCache).toHaveBeenCalledWith('cache-key', 'My Title');
        expect(collaborators.logError).not.toHaveBeenCalled();
        expect(order).toEqual(['getItem', 'loadItemDataTypes', 'resolveTitle', 'writeCache']);
    });

    it('case 2: getItem returns undefined → no loadItemDataTypes, resolveTitle, writeCache, or log', async () => {
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(undefined),
        });

        await run(collaborators);

        expect(collaborators.getItemByID).not.toHaveBeenCalled();
        expect(collaborators.loadItemDataTypes).not.toHaveBeenCalled();
        expect(collaborators.resolveTitle).not.toHaveBeenCalled();
        expect(collaborators.writeCache).not.toHaveBeenCalled();
        expect(collaborators.logError).not.toHaveBeenCalled();
    });

    it('case 3: non-top-level item with parentID fetches parent via getItemByID and passes [item, parent] to loadItemDataTypes', async () => {
        const parent = createMockItem({ id: 10, key: 'PARENT' });
        const item = createMockItem({ id: 11, key: 'CHILD', parentID: 10, isTopLevelItem: false });
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            getItemByID: vi.fn().mockResolvedValue(parent as any),
            resolveTitle: vi.fn().mockResolvedValue('child title'),
        });

        await run(collaborators, { libraryId: 1, zoteroKey: 'CHILD' });

        expect(collaborators.getItemByID).toHaveBeenCalledWith(10);
        expect(collaborators.loadItemDataTypes).toHaveBeenCalledWith([item, parent], ['itemData', 'note']);
        expect(collaborators.writeCache).toHaveBeenCalledWith('cache-key', 'child title');
    });

    it('case 4: attachment with parentID but parentItem initially unset still gets parent loaded via getItemByID (regression guard)', async () => {
        // The factory's default parentItem is null — this is the uncached-parent
        // regression case: a plan that had relied on `item.parentItem` instead of
        // `getAsync(parentID)` would have returned falsy here and skipped the parent.
        const parent = createMockItem({ id: 10, key: 'PARENT' });
        const item = createMockItem({
            id: 11,
            key: 'CHILD',
            parentID: 10,
            parentItem: null, // explicitly not cached — documents the regression scenario
            isTopLevelItem: false,
        });
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            getItemByID: vi.fn().mockResolvedValue(parent as any),
            resolveTitle: vi.fn().mockResolvedValue('t'),
        });

        await run(collaborators);

        expect(collaborators.getItemByID).toHaveBeenCalledWith(10);
        expect(collaborators.loadItemDataTypes).toHaveBeenCalledWith([item, parent], ['itemData', 'note']);
    });

    it('case 5: non-top-level with getItemByID returning null (deleted parent) loads [item] only, no throw, title still resolved', async () => {
        const item = createMockItem({ id: 11, parentID: 10, isTopLevelItem: false });
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            getItemByID: vi.fn().mockResolvedValue(null),
            resolveTitle: vi.fn().mockResolvedValue('fallback title'),
        });

        await run(collaborators);

        expect(collaborators.getItemByID).toHaveBeenCalledWith(10);
        expect(collaborators.loadItemDataTypes).toHaveBeenCalledWith([item], ['itemData', 'note']);
        expect(collaborators.writeCache).toHaveBeenCalledWith('cache-key', 'fallback title');
        expect(collaborators.logError).not.toHaveBeenCalled();
    });

    it('case 6: top-level item skips getItemByID and loads [item] only', async () => {
        const item = createMockItem(); // default isTopLevelItem=true, parentID=null
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            resolveTitle: vi.fn().mockResolvedValue('top-level title'),
        });

        await run(collaborators);

        expect(collaborators.getItemByID).not.toHaveBeenCalled();
        expect(collaborators.loadItemDataTypes).toHaveBeenCalledWith([item], ['itemData', 'note']);
    });

    it('case 7: getItem rejects → logError called once, no writeCache, no throw', async () => {
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockRejectedValue(new Error('fetch failed')),
        });

        await expect(run(collaborators)).resolves.toBeUndefined();

        expect(collaborators.logError).toHaveBeenCalledTimes(1);
        expect(collaborators.logError).toHaveBeenCalledWith(expect.stringContaining('fetch failed'));
        expect(collaborators.writeCache).not.toHaveBeenCalled();
    });

    it('case 8: getItemByID rejects → logError called, no writeCache, no throw', async () => {
        const item = createMockItem({ id: 11, parentID: 10, isTopLevelItem: false });
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            getItemByID: vi.fn().mockRejectedValue(new Error('parent fetch failed')),
        });

        await expect(run(collaborators)).resolves.toBeUndefined();

        expect(collaborators.logError).toHaveBeenCalledTimes(1);
        expect(collaborators.logError).toHaveBeenCalledWith(expect.stringContaining('parent fetch failed'));
        expect(collaborators.loadItemDataTypes).not.toHaveBeenCalled();
        expect(collaborators.writeCache).not.toHaveBeenCalled();
    });

    it('case 9: loadItemDataTypes rejects → logError called, no resolveTitle, no writeCache', async () => {
        const item = createMockItem();
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            loadItemDataTypes: vi.fn().mockRejectedValue(new Error('load failed')),
        });

        await expect(run(collaborators)).resolves.toBeUndefined();

        expect(collaborators.logError).toHaveBeenCalledWith(expect.stringContaining('load failed'));
        expect(collaborators.resolveTitle).not.toHaveBeenCalled();
        expect(collaborators.writeCache).not.toHaveBeenCalled();
    });

    it('case 10: resolveTitle rejects → logError called, no writeCache', async () => {
        const item = createMockItem();
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            resolveTitle: vi.fn().mockRejectedValue(new Error('resolver blew up')),
        });

        await expect(run(collaborators)).resolves.toBeUndefined();

        expect(collaborators.logError).toHaveBeenCalledWith(expect.stringContaining('resolver blew up'));
        expect(collaborators.writeCache).not.toHaveBeenCalled();
    });

    it('case 11: cancel immediately after getItem resolves → no getItemByID, no loadItemDataTypes, no resolveTitle, no writeCache', async () => {
        const item = createMockItem({ id: 11, parentID: 10, isTopLevelItem: false });
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            isCancelled: vi.fn().mockReturnValueOnce(true), // first check: cancel
        });

        await run(collaborators);

        expect(collaborators.getItemByID).not.toHaveBeenCalled();
        expect(collaborators.loadItemDataTypes).not.toHaveBeenCalled();
        expect(collaborators.resolveTitle).not.toHaveBeenCalled();
        expect(collaborators.writeCache).not.toHaveBeenCalled();
        expect(collaborators.logError).not.toHaveBeenCalled();
    });

    it('case 11b: cancel after getItemByID resolves (before loadItemDataTypes) → no loadItemDataTypes, no resolveTitle, no writeCache', async () => {
        // Non-top-level path: post-getItem check passes, post-parent-fetch check cancels.
        // Prevents the expensive loadItemDataTypes from running on an unmounted component.
        const parent = createMockItem({ id: 10, key: 'PARENT' });
        const item = createMockItem({ id: 11, parentID: 10, isTopLevelItem: false });
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            getItemByID: vi.fn().mockResolvedValue(parent as any),
            isCancelled: vi.fn()
                .mockReturnValueOnce(false) // check 1: post-getItem
                .mockReturnValueOnce(true),  // check 2: post-getItemByID → cancel
        });

        await run(collaborators);

        expect(collaborators.getItemByID).toHaveBeenCalledTimes(1);
        expect(collaborators.loadItemDataTypes).not.toHaveBeenCalled();
        expect(collaborators.resolveTitle).not.toHaveBeenCalled();
        expect(collaborators.writeCache).not.toHaveBeenCalled();
        expect(collaborators.logError).not.toHaveBeenCalled();
    });

    it('case 12: cancel after loadItemDataTypes resolves (before resolveTitle) → no resolveTitle, no writeCache', async () => {
        const item = createMockItem();
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            // first check (post-getItem) passes, second check (post-loadItemDataTypes) cancels.
            isCancelled: vi.fn()
                .mockReturnValueOnce(false)
                .mockReturnValueOnce(true),
        });

        await run(collaborators);

        expect(collaborators.loadItemDataTypes).toHaveBeenCalledTimes(1);
        expect(collaborators.resolveTitle).not.toHaveBeenCalled();
        expect(collaborators.writeCache).not.toHaveBeenCalled();
    });

    it('case 13: cancel after resolveTitle resolves (before writeCache) → no writeCache (post-resolver cancel check)', async () => {
        const item = createMockItem();
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            resolveTitle: vi.fn().mockResolvedValue('t'),
            // passes checks 1 and 2; cancels on check 3.
            isCancelled: vi.fn()
                .mockReturnValueOnce(false)
                .mockReturnValueOnce(false)
                .mockReturnValueOnce(true),
        });

        await run(collaborators);

        expect(collaborators.resolveTitle).toHaveBeenCalledTimes(1);
        expect(collaborators.writeCache).not.toHaveBeenCalled();
    });

    it('case 14: async resolver (returning a Promise) is awaited before writeCache', async () => {
        const item = createMockItem();
        let titleResolved = false;
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            resolveTitle: vi.fn(() => new Promise<string>((resolve) => {
                setTimeout(() => {
                    titleResolved = true;
                    resolve('async title');
                }, 0);
            })),
            writeCache: vi.fn((_cacheKey, _title) => {
                expect(titleResolved).toBe(true);
            }),
        });

        await run(collaborators);

        expect(collaborators.writeCache).toHaveBeenCalledWith('cache-key', 'async title');
    });

    it('sync resolver (returning a plain string) works without Promise wrapping', async () => {
        const item = createMockItem();
        const collaborators = makeCollaborators({
            getItem: vi.fn().mockResolvedValue(item as any),
            resolveTitle: vi.fn(() => 'sync title'),
        });

        await run(collaborators);

        expect(collaborators.writeCache).toHaveBeenCalledWith('cache-key', 'sync title');
    });

});
