import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchReadiness } from '@beaver/agent-core/protocol/agentProtocol';
import { evaluateSearchReadiness, unknownSearchReadiness, SEARCH_READINESS_MAX_AGE_MS } from '../../../src/services/searchIndex/searchReadinessPolicy';
import { describeSearchReadiness } from '../../../react/components/preferences/searchReadinessSentence';

const { census, requirements, verify } = vi.hoisted(() => ({ census: vi.fn(), requirements: vi.fn(), verify: vi.fn() }));
vi.mock('../../../src/services/searchIndex/searchCensus', () => ({ discoverSearchCensus: census }));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: { requirements, verify } }));
vi.mock('../../../src/utils/zoteroInstanceIdentity', () => ({
    getZoteroUserIdentifier: () => ({ localUserKey: 'device-a' }), getIndexScopeRef: (id: number) => `g${id}`,
}));
import { InstanceSearchReadiness } from '../../../src/services/searchIndex/instanceSearchReadiness';

const versions = { pdf: ['4'], epub: ['2'], snapshot: ['1'] };
const observation = (confirmed = 95, supported = 100): SearchReadiness => ({
    ...unknownSearchReadiness(), discovery_complete: true, verified_at: new Date().toISOString(),
    index_version: 3, extract_schema_versions: versions, zotero_local_id: 'device-a',
    libraries: [{ scope_ref: 'g1', supported, confirmed }],
});

describe('search readiness policy v1', () => {
    it.each([[10, false], [94, false], [95, true], [96, true], [100, true]])('initial coverage %i gives ready=%s', (count, ready) => {
        expect(evaluateSearchReadiness(observation(count), false).ready).toBe(ready);
    });
    it('requires complete discovery even with complete known coverage', () => {
        expect(evaluateSearchReadiness({ ...observation(100), discovery_complete: false }, true).ready).toBe(false);
    });
    it('does not let a large prepared library hide an unprepared small one', () => {
        const value = observation(10000, 10000);
        value.libraries.push({ scope_ref: 'g2', supported: 10, confirmed: 1 });
        expect(evaluateSearchReadiness(value, false).ready).toBe(false);
    });
    it('keeps small additions ready but a large import revokes readiness', () => {
        expect(evaluateSearchReadiness(observation(95, 105), true).ready).toBe(true);
        expect(evaluateSearchReadiness(observation(95, 106), true).ready).toBe(false);
        expect(evaluateSearchReadiness(observation(90), true).ready).toBe(true);
        expect(evaluateSearchReadiness(observation(89), true).ready).toBe(false);
    });
    it('does not mark empty libraries ready or let them block a prepared nonempty one', () => {
        const value = observation(0, 0);
        expect(evaluateSearchReadiness(value, false).reason).toBe('empty');
        value.libraries.push({ scope_ref: 'g2', supported: 20, confirmed: 19 });
        expect(evaluateSearchReadiness(value, false).ready).toBe(true);
    });
    it('expires at exactly 24 hours and rejects future timestamps', () => {
        const now = Date.now();
        expect(evaluateSearchReadiness({ ...observation(), verified_at: new Date(now - SEARCH_READINESS_MAX_AGE_MS).toISOString() }, true, now).reason).toBe('stale');
        expect(evaluateSearchReadiness({ ...observation(), verified_at: new Date(now + 1).toISOString() }, true, now).ready).toBe(false);
    });
    it('rejects invalid counts and unknown observations', () => {
        expect(evaluateSearchReadiness(observation(101), true).ready).toBe(false);
        expect(evaluateSearchReadiness(unknownSearchReadiness(), true).ready).toBe(false);
    });
});

describe('instance search verification', () => {
    let generation: number;
    let service: InstanceSearchReadiness;
    const library = (total = 100, extracted = total) => [{ libraryId: 1, scopeRef: 'g1', attachments:
        Array.from({ length: total }, (_, i) => ({ libraryId: 1, zoteroKey: String(i), contentKind: 'pdf',
            identity: i < extracted ? { docHash: `hash${i}`, schemaVersion: '4' } : null })) }];
    beforeEach(() => {
        vi.clearAllMocks();
        generation = 1;
        Zotero.Beaver = { libraryScopeInitialized: true, hasSearchIndexAccess: true, searchableLibraryIds: [1],
            account: { getGeneration: () => generation, getSnapshot: () => ({ session: { user: { id: `user${generation}` } } }) },
            runtime: { publish: vi.fn() } } as any;
        census.mockResolvedValue(library());
        requirements.mockResolvedValue({ index_version: 3, extract_schema_versions: versions });
        verify.mockImplementation(async (_device, refs) => ({ refs: refs.map((ref: any) => ({ ...ref,
            state: 'current', index_version: 3, extract_schema_version: '4' })) }));
        service = new InstanceSearchReadiness();
    });
    it('counts failures and unavailable files, with bounded exact membership requests', async () => {
        census.mockResolvedValue(library(101, 10));
        await service.refresh();
        expect(service.getStatus().current).toMatchObject({ ready: false, libraries: [{ supported: 101, confirmed: 10 }] });
        census.mockResolvedValue(library(101));
        await service.refresh();
        expect(verify.mock.calls.slice(1).map((call) => call[1].length)).toEqual([50, 50, 1]);
        expect(service.getStatus().current.ready).toBe(true);
    });
    it('does not trust historical local success when a namespace is missing', async () => {
        verify.mockImplementation(async (_device, refs) => ({ refs: refs.map((ref: any) => ({ ...ref, state: 'missing' })) }));
        await service.refresh();
        expect(service.getStatus().current.libraries[0].confirmed).toBe(0);
        expect(service.getStatus().current.ready).toBe(false);
    });
    it('revokes readiness when confirmed membership is lost before a later batch fails', async () => {
        await service.refresh();
        verify.mockImplementationOnce(async (_device, refs) => ({ refs: refs.map((ref: any) => ({ ...ref, state: 'missing' })) }));
        verify.mockRejectedValueOnce(new Error('offline'));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
        expect(service.getStatus().lastConfirmed?.libraries[0].confirmed).toBe(100);
    });
    it('requires 95% again after falling below the retention threshold', async () => {
        await service.refresh();
        census.mockResolvedValue(library(100, 89));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
        census.mockResolvedValue(library(100, 92));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
        census.mockResolvedValue(library(100, 95));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(true);
    });
    it('requires matching accepted versions and current content identities', async () => {
        verify.mockImplementation(async (_device, refs) => ({ refs: refs.map((ref: any) => ({ ...ref, state: 'current', index_version: 2, extract_schema_version: '4' })) }));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
    });
    it('preserves last confirmed counts and timestamp on network failure', async () => {
        await service.refresh();
        const before = service.getStatus().lastConfirmed;
        verify.mockRejectedValue(new Error('offline'));
        await service.refresh();
        expect(service.getStatus().lastConfirmed).toEqual(before);
        expect(service.getStatus().error).toBeTruthy();
        expect(describeSearchReadiness(service.getStatus()).caption).toContain('Last successful check: 100 of 100 files indexed (100%)');
    });
    it('treats incomplete responses as unknown instead of zero', async () => {
        verify.mockResolvedValue({ refs: [] });
        await service.refresh();
        expect(service.getStatus().lastConfirmed).toBeNull();
        expect(service.getStatus().current.ready).toBe(false);
    });
    it('rejects duplicate verification identities rather than counting them twice', async () => {
        verify.mockImplementation(async (_device, refs) => ({ refs: [...refs, refs[0]] }));
        await service.refresh();
        expect(service.getStatus().lastConfirmed).toBeNull();
        expect(service.getStatus().error).toBeTruthy();
    });
    it('matches unordered verification results by exact identity', async () => {
        verify.mockImplementation(async (_device, refs) => ({ refs: refs.map((ref: any) => ({ ...ref,
            state: 'current', index_version: 3, extract_schema_version: '4' })).reverse() }));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(true);
    });
    it('does not rebuild the scope snapshot for each attachment freshness check', async () => {
        const snapshot = vi.spyOn(Zotero.Beaver.account, 'getSnapshot');
        census.mockImplementation(async (_ids, isCurrent) => {
            for (let i = 0; i < 10_000; i++) expect(isCurrent()).toBe(true);
            return library(1);
        });
        try {
            await service.refresh();
            expect(snapshot.mock.calls.length).toBeLessThan(20);
            expect(service.getStatus().current.ready).toBe(true);
        } finally {
            snapshot.mockRestore();
        }
    });
    it('checks changed scope after a remote batch even before account reconciliation arrives', async () => {
        verify.mockImplementation(async () => {
            Zotero.Beaver.searchableLibraryIds = [];
            return { refs: [] };
        });
        await service.refresh();
        expect(service.getStatus().lastConfirmed).toBeNull();
        expect(verify).toHaveBeenCalledTimes(1);
    });
    it('clears scope and hysteresis on account and library changes', async () => {
        await service.refresh();
        generation++;
        expect(service.getStatus().lastConfirmed).toBeNull();
        census.mockResolvedValue(library(100, 92));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
        Zotero.Beaver.searchableLibraryIds = [1, 2];
        expect(service.getStatus().current.discovery_complete).toBe(false);
    });
    it('discards late verification after an account switch', async () => {
        verify.mockImplementation(async () => { generation++; return { refs: [] }; });
        await service.refresh();
        expect(service.getStatus().lastConfirmed).toBeNull();
    });
    it('discards verified hashes replaced by extraction while verification is running', async () => {
        census.mockResolvedValueOnce(library());
        census.mockResolvedValue(library(100, 10));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
        expect(service.getStatus().lastConfirmed).toBeNull();
    });
    it('revokes old readiness if a fresh census changes and the network fails', async () => {
        await service.refresh();
        census.mockResolvedValue(library(200, 100));
        verify.mockRejectedValue(new Error('offline'));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
        expect(service.getStatus().lastConfirmed?.libraries[0].supported).toBe(100);
    });
    it('resets hysteresis for new accepted versions', async () => {
        await service.refresh();
        census.mockResolvedValue(library(100, 92));
        requirements.mockResolvedValue({ index_version: 4, extract_schema_versions: versions });
        verify.mockImplementation(async (_device, refs) => ({ refs: refs.map((ref: any) => ({ ...ref, state: 'current', index_version: 4, extract_schema_version: '4' })) }));
        await service.refresh();
        expect(service.getStatus().current.ready).toBe(false);
    });
    it('reports unknown coverage offline at startup, never zero coverage', async () => {
        requirements.mockRejectedValue(new Error('offline'));
        await service.refresh();
        expect(service.getStatus().lastConfirmed).toBeNull();
        expect(describeSearchReadiness(service.getStatus()).caption).not.toContain('0 of 0');
    });

    it('rechecks a changed library scope within one second while idle', async () => {
        vi.useFakeTimers();
        census.mockImplementation(async (ids) => ids.length ? library(1) : []);
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(service.getStatus().current.ready).toBe(true);
            Zotero.Beaver.searchableLibraryIds = [];
            service.reconcile();
            expect(service.getStatus().lastConfirmed).toBeNull();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(service.getStatus().current).toMatchObject({ discovery_complete: true, ready: false, libraries: [] });
            Zotero.Beaver.searchableLibraryIds = [1];
            service.reconcile();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(service.getStatus().current.ready).toBe(true);
            expect(verify).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(verify).toHaveBeenCalledTimes(3);
        } finally {
            await service.dispose();
            vi.useRealTimers();
        }
    });

    it('rechecks promptly when search access returns and cancels a scheduled scope retry on disposal', async () => {
        vi.useFakeTimers();
        census.mockResolvedValue(library(1));
        Zotero.Beaver.hasSearchIndexAccess = false;
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(verify).not.toHaveBeenCalled();
            Zotero.Beaver.hasSearchIndexAccess = true;
            service.reconcile();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(service.getStatus().current.ready).toBe(true);
            Zotero.Beaver.searchableLibraryIds = [];
            service.reconcile();
            await service.dispose();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(verify).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await service.dispose();
            vi.useRealTimers();
        }
    });

    it.each(['library', 'account'])('rechecks a %s change discovered during verification as soon as the old pass settles', async (change) => {
        vi.useFakeTimers();
        let finishVerification!: (value: { refs: [] }) => void;
        census.mockImplementation(async (ids) => ids.length ? library(1) : []);
        verify.mockReturnValueOnce(new Promise((resolve) => { finishVerification = resolve; }));
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(0);
            const pending = service.refresh();
            if (change === 'library') Zotero.Beaver.searchableLibraryIds = [];
            else generation++;
            // No external reconciliation: the pass must notice the changed scope itself.
            finishVerification({ refs: [] });
            await pending;
            expect(service.getStatus().current.discovery_complete).toBe(true);
            expect(service.getStatus().current.libraries).toHaveLength(change === 'library' ? 0 : 1);
            expect(verify).toHaveBeenCalledTimes(change === 'library' ? 1 : 2);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            finishVerification({ refs: [] });
            await service.dispose();
            vi.useRealTimers();
        }
    });

    it('rechecks extraction changes without notifications until the census settles', async () => {
        vi.useFakeTimers();
        census.mockResolvedValueOnce(library(1)).mockResolvedValueOnce(library(2))
            .mockResolvedValueOnce(library(2)).mockResolvedValueOnce(library(3))
            .mockResolvedValue(library(3));
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(service.getStatus().current).toMatchObject({ ready: true, libraries: [{ supported: 3, confirmed: 3 }] });
            expect(verify).toHaveBeenCalledTimes(3);
            expect(census).toHaveBeenCalledTimes(6);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            await service.dispose();
            vi.useRealTimers();
        }
    });

    it.each([100, 1_500])('refreshes immediately after an invalidated pass settles %i ms after notification', async (delay) => {
        vi.useFakeTimers();
        let finishVerification!: (value: { refs: [] }) => void;
        const register = vi.spyOn(Zotero.Notifier, 'registerObserver');
        census.mockResolvedValue(library(1));
        verify.mockReturnValueOnce(new Promise((resolve) => { finishVerification = resolve; }));
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(0);
            const pending = service.refresh();
            const observer = register.mock.calls[0][0];
            census.mockResolvedValue(library(2));
            observer.notify('add', 'item', [2], {});
            observer.notify('download', 'file', [2], {});
            expect(service.getStatus().current.ready).toBe(false);
            await vi.advanceTimersByTimeAsync(delay);
            expect(verify).toHaveBeenCalledTimes(1);

            finishVerification({ refs: [] });
            await pending;
            expect(service.getStatus().current).toMatchObject({
                ready: true, libraries: [{ supported: 2, confirmed: 2 }],
            });
            expect(verify).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(59_999);
            expect(verify).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(verify).toHaveBeenCalledTimes(3);
        } finally {
            finishVerification({ refs: [] });
            await service.dispose();
            register.mockRestore();
            vi.useRealTimers();
        }
    });

    it('preserves an earlier notification timer scheduled as a pass finishes', async () => {
        vi.useFakeTimers();
        const register = vi.spyOn(Zotero.Notifier, 'registerObserver');
        census.mockResolvedValue(library(1));
        vi.mocked(Zotero.Beaver.runtime.publish).mockImplementationOnce(() => {
            census.mockResolvedValue(library(2));
            register.mock.calls[0][0].notify('add', 'item', [2], {});
        });
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(verify).toHaveBeenCalledTimes(1);
            expect(service.getStatus().current.ready).toBe(false);
            await vi.advanceTimersByTimeAsync(999);
            expect(verify).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(verify).toHaveBeenCalledTimes(2);
            expect(service.getStatus().current.ready).toBe(true);
        } finally {
            await service.dispose();
            register.mockRestore();
            vi.useRealTimers();
        }
    });

    it('discards a queued notification refresh when disposed during verification', async () => {
        vi.useFakeTimers();
        let finishVerification!: (value: { refs: [] }) => void;
        const register = vi.spyOn(Zotero.Notifier, 'registerObserver');
        verify.mockReturnValueOnce(new Promise((resolve) => { finishVerification = resolve; }));
        service.start();
        try {
            await vi.advanceTimersByTimeAsync(0);
            register.mock.calls[0][0].notify('modify', 'item', [1], {});
            const disposing = service.dispose();
            finishVerification({ refs: [] });
            await disposing;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(census).toHaveBeenCalledTimes(1);
            expect(verify).toHaveBeenCalledTimes(1);
            expect(service.getStatus().current.ready).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            finishVerification({ refs: [] });
            await service.dispose();
            register.mockRestore();
            vi.useRealTimers();
        }
    });
});

describe('full-text search status wording', () => {
    const libraries = [
        { library_id: 1, group_id: null, name: 'My Library', is_group: false, type: 'user', type_id: 1 },
        { library_id: 2, group_id: 77, name: 'Female Legislator', is_group: true, type: 'group', type_id: 77 },
    ] as any[];
    const status = (current: SearchReadiness, lastConfirmed: SearchReadiness | null = null, error: string | null = null) =>
        ({ current, lastConfirmed, error, refreshing: false });
    const now = new Date('2026-09-18T15:54:27');

    it('reports ready coverage with a relative check time', () => {
        const sentence = describeSearchReadiness(status(
            { ...observation(415, 434), ready: true, reason: 'ready', verified_at: '2026-09-18T15:54:27' }), [], now);
        expect(sentence.headline).toBe('Ready');
        expect(sentence.tone).toBe('idle');
        expect(sentence.caption).toMatch(/^415 of 434 files indexed \(95%\)\. Last checked today at /);
    });
    it('names the libraries that hold full-text search back', () => {
        const current: SearchReadiness = { ...observation(), reason: 'coverage', libraries: [
            { scope_ref: 'labc', supported: 400, confirmed: 398 },
            { scope_ref: 'g77', supported: 28, confirmed: 12 },
        ] };
        const sentence = describeSearchReadiness(status(current), libraries, now);
        expect(sentence.headline).toBe('Not ready yet');
        expect(sentence.caption).toContain('410 of 428 files indexed (95%)');
        expect(sentence.caption).toBe('410 of 428 files indexed (95%). Full-text search turns on once at least 95% of the files in each library are indexed.');
        expect(sentence.libraries).toEqual(['Female Legislator: 12 of 28 files indexed (42%)']);
    });
    it('keeps the last successful check visible after a failed one', () => {
        const confirmed = { ...observation(100, 100), ready: true, reason: 'ready' as const, verified_at: '2026-09-17T09:05:00' };
        const sentence = describeSearchReadiness(status(unknownSearchReadiness(), confirmed, 'Could not reach the search index to verify your files.'), [], now);
        expect(sentence.tone).toBe('error');
        expect(sentence.headline).toBe('Could not check');
        expect(sentence.caption).toContain('Beaver will try again automatically.');
        expect(sentence.caption).toMatch(/Last successful check: 100 of 100 files indexed \(100%\), yesterday at /);
    });
    it('explains empty and unavailable states in plain words', () => {
        expect(describeSearchReadiness(status({ ...unknownSearchReadiness(), reason: 'empty' })).headline).toBe('Nothing to search yet');
        expect(describeSearchReadiness(status({ ...unknownSearchReadiness(), reason: 'unavailable' })).headline).toBe('Not available');
        expect(describeSearchReadiness(undefined).headline).toBe('Checking…');
    });
    it.each(['discovering', 'unknown', 'stale'] as const)('shows the fail-closed reason %s as a check in progress', (reason) => {
        const sentence = describeSearchReadiness(status({ ...unknownSearchReadiness(), reason }));
        expect(sentence.headline).toBe('Checking…');
        expect(sentence.tone).toBe('busy');
    });
});
