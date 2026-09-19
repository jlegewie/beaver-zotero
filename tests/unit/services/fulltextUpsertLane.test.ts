import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/services/backgroundQueue/fulltextUpsertExecutor', () => ({
    FulltextUpsertExecutor: class { constructor(_api?: unknown, public jobType = 'fulltext_upsert') {} },
}));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: {} }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { startFulltextUpsertLane } from '../../../src/services/backgroundProcessing/fulltextUpsertLane';
let cleanup: (() => Promise<void>) | undefined;
let owner: any;
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    owner = {
        db: { restoreIndexCleanup: vi.fn(async () => 1) },
        account: { getSnapshot: () => ({ session: { user: { id: 'account' } } }) },
        backgroundExtractor: { registerExecutor: vi.fn(), unregisterExecutor: vi.fn(), notify: vi.fn() },
    };
    (Zotero as any).Beaver = owner;
});
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers(); });
it.each([true, false])('registers entitled uploads and preserves cleanup when access=%s', access => {
    cleanup = startFulltextUpsertLane(access);
    expect(owner.backgroundExtractor.registerExecutor.mock.calls.map(([executor]: any[]) => executor.jobType))
        .toEqual(access ? ['fulltext_upsert', 'fulltext_untag'] : ['fulltext_untag']);
});
it('restores durable cleanup and stops its timer on disposal', async () => {
    cleanup = startFulltextUpsertLane(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(owner.db.restoreIndexCleanup).toHaveBeenCalledExactlyOnceWith('account');
    expect(owner.backgroundExtractor.notify).toHaveBeenCalledTimes(1);
    await cleanup(); cleanup = undefined;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(owner.db.restoreIndexCleanup).toHaveBeenCalledTimes(1);
    expect(owner.backgroundExtractor.unregisterExecutor).toHaveBeenCalledTimes(2);
});
