import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test only reads the pane object it is handed, but it imports
// the logger, which pulls in the runtime adapter. Stub it and capture calls so
// the "log once per failure kind" behavior can be asserted.
const loggerCalls: string[] = [];
vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: (msg: string) => { loggerCalls.push(msg); },
}));

import {
    getSelectedLibraryIds,
    getSelectedLibraryId,
    getSelectedCollections,
    getSelectedCollection,
    getSelectedSavedSearches,
} from '../../../src/utils/zoteroSelection';

const collection = (key: string, libraryID = 1) => ({ key, name: key, libraryID }) as any;
const search = (key: string, libraryID = 1) => ({ key, name: key, libraryID }) as any;

/** A getter that was removed: it still exists as a function, but throws. */
const removed = (name: string) => () => {
    throw new Error(`ZoteroPane.${name}() was removed -- use the plural getter`);
};

/**
 * Panes shaped like each supported Zotero generation, so the accessor ordering
 * is pinned against the real API surfaces rather than a hypothetical one.
 */
const panes = {
    /** Single-row selection only: no plural getters anywhere. */
    singleSelectEra: (selected: { collection?: any; search?: any; libraryID?: number }) => ({
        getSelectedCollection: () => selected.collection ?? false,
        getSelectedSavedSearch: () => selected.search ?? false,
        getSelectedLibraryID: () => selected.libraryID ?? false,
        collectionsView: {},
    }),
    /**
     * Multi-row selection, but only the collections tree has the plural saved-search
     * getter — the pane does not, and its singular getter truncates to the first row.
     */
    treePluralOnly: (collections: any[], searches: any[]) => ({
        getSelectedCollections: () => collections,
        getSelectedSavedSearch: () => searches[0] ?? false,
        getSelectedLibraryID: () => 1,
        collectionsView: {
            getSelectedCollections: () => collections,
            getSelectedSearches: () => searches,
        },
    }),
    /** Plural getters on the pane; the singular ones have been removed and throw. */
    panePlural: (collections: any[], searches: any[], libraryIDs: number[]) => ({
        getSelectedCollections: () => collections,
        getSelectedSavedSearches: () => searches,
        getSelectedLibraryIDs: () => libraryIDs,
        getSelectedCollection: removed('getSelectedCollection'),
        getSelectedSavedSearch: removed('getSelectedSavedSearch'),
        getSelectedLibraryID: removed('getSelectedLibraryID'),
        collectionsView: {
            getSelectedCollections: () => collections,
            getSelectedSearches: () => searches,
        },
    }),
};

describe('zoteroSelection', () => {
    beforeEach(() => {
        loggerCalls.length = 0;
    });

    describe('getSelectedLibraryIds', () => {
        it('uses the plural getter when it exists', () => {
            const zp = { getSelectedLibraryIDs: () => [1, 3] };
            expect(getSelectedLibraryIds(zp)).toEqual([1, 3]);
        });

        it('falls back to the singular getter when the plural is absent', () => {
            const zp = { getSelectedLibraryID: () => 7 };
            expect(getSelectedLibraryIds(zp)).toEqual([7]);
        });

        it('normalizes the singular getter returning false for an empty selection', () => {
            const zp = { getSelectedLibraryID: () => false };
            expect(getSelectedLibraryIds(zp)).toEqual([]);
        });

        it('prefers the plural getter even when the singular one throws', () => {
            const zp = {
                getSelectedLibraryIDs: () => [4],
                getSelectedLibraryID: removed('getSelectedLibraryID'),
            };
            expect(getSelectedLibraryIds(zp)).toEqual([4]);
        });

        it('returns empty when the only available getter throws', () => {
            const zp = { getSelectedLibraryID: removed('getSelectedLibraryID') };
            expect(getSelectedLibraryIds(zp)).toEqual([]);
        });

        it('returns empty for a missing pane', () => {
            expect(getSelectedLibraryIds(null)).toEqual([]);
            expect(getSelectedLibraryIds(undefined)).toEqual([]);
        });

        it('tolerates a plural getter that does not return an array', () => {
            const zp = { getSelectedLibraryIDs: () => undefined };
            expect(getSelectedLibraryIds(zp)).toEqual([]);
        });
    });

    describe('getSelectedLibraryId', () => {
        it('returns the first selected id', () => {
            expect(getSelectedLibraryId({ getSelectedLibraryIDs: () => [5, 9] })).toBe(5);
        });

        it('returns null when nothing is selected', () => {
            expect(getSelectedLibraryId({ getSelectedLibraryIDs: () => [] })).toBeNull();
        });
    });

    describe('getSelectedCollections', () => {
        it('returns every selected collection from the plural getter', () => {
            const zp = { getSelectedCollections: () => [collection('AAA'), collection('BBB', 3)] };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['AAA', 'BBB']);
        });

        it('falls back to the singular getter when the plural is absent', () => {
            const zp = { getSelectedCollection: () => collection('ONE') };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['ONE']);
        });

        it('normalizes the singular getter returning false', () => {
            expect(getSelectedCollections({ getSelectedCollection: () => false })).toEqual([]);
        });

        it('prefers the plural getter even when the singular one throws', () => {
            const zp = {
                getSelectedCollections: () => [collection('PLURAL')],
                getSelectedCollection: removed('getSelectedCollection'),
            };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['PLURAL']);
        });

        it('returns empty when the only available getter throws', () => {
            expect(getSelectedCollections({ getSelectedCollection: removed('getSelectedCollection') })).toEqual([]);
        });
    });

    describe('getSelectedCollection', () => {
        it('returns the first selected collection', () => {
            const zp = { getSelectedCollections: () => [collection('FIRST'), collection('SECOND')] };
            expect(getSelectedCollection(zp)?.key).toBe('FIRST');
        });

        it('returns null when nothing is selected', () => {
            expect(getSelectedCollection({ getSelectedCollections: () => [] })).toBeNull();
        });
    });

    describe('getSelectedSavedSearches', () => {
        it('returns every selected saved search from the plural getter', () => {
            const zp = { getSelectedSavedSearches: () => [search('S1'), search('S2')] };
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['S1', 'S2']);
        });

        it('falls back to the singular getter when the plural is absent', () => {
            const zp = { getSelectedSavedSearch: () => search('ONLY') };
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['ONLY']);
        });

        it('normalizes the singular getter returning false', () => {
            expect(getSelectedSavedSearches({ getSelectedSavedSearch: () => false })).toEqual([]);
        });

        it('prefers the plural getter even when the singular one throws', () => {
            const zp = {
                getSelectedSavedSearches: () => [search('PLURAL')],
                getSelectedSavedSearch: removed('getSelectedSavedSearch'),
            };
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['PLURAL']);
        });

    });

    describe('accessor ordering across Zotero generations', () => {
        it('reads every saved search from the tree when the pane lacks the plural getter', () => {
            // The regression this guards: falling straight through to the pane's
            // singular getter here reports only the first of several selected
            // saved searches.
            const searches = [search('S1'), search('S2'), search('S3')];
            const zp = panes.treePluralOnly([collection('C1')], searches);

            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['S1', 'S2', 'S3']);
        });

        it('reads every collection from the tree when the pane lacks the plural getter', () => {
            const collections = [collection('C1'), collection('C2')];
            const zp: any = panes.treePluralOnly(collections, []);
            delete zp.getSelectedCollections; // tree-only, as with saved searches

            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['C1', 'C2']);
        });

        it('prefers the pane plural getter over the tree one', () => {
            const zp = {
                getSelectedSavedSearches: () => [search('FROM_PANE')],
                collectionsView: { getSelectedSearches: () => [search('FROM_TREE')] },
            };
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['FROM_PANE']);
        });

        it('never calls a removed singular getter when a plural one exists', () => {
            const zp = panes.panePlural(
                [collection('C1'), collection('C2')],
                [search('S1'), search('S2')],
                [1, 3],
            );
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['C1', 'C2']);
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['S1', 'S2']);
            expect(getSelectedLibraryIds(zp)).toEqual([1, 3]);
        });

        it('falls back to the singular getters when no plural getter exists', () => {
            const zp = panes.singleSelectEra({
                collection: collection('ONLY_C'),
                search: search('ONLY_S'),
                libraryID: 4,
            });
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['ONLY_C']);
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['ONLY_S']);
            expect(getSelectedLibraryIds(zp)).toEqual([4]);
        });

        it('reports an empty selection on a single-select pane with nothing selected', () => {
            const zp = panes.singleSelectEra({});
            expect(getSelectedCollections(zp)).toEqual([]);
            expect(getSelectedSavedSearches(zp)).toEqual([]);
            expect(getSelectedLibraryIds(zp)).toEqual([]);
        });

        it('falls back to the singular getter when collectionsView is unavailable', () => {
            const zp = { getSelectedCollection: () => collection('NO_TREE'), collectionsView: null };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['NO_TREE']);
        });
    });

    describe('a rung that throws falls through to the next one', () => {
        it('uses the tree plural getter when the pane plural getter has been retired', () => {
            const zp = {
                getSelectedCollections: removed('getSelectedCollections'),
                collectionsView: { getSelectedCollections: () => [collection('C1'), collection('C2')] },
            };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['C1', 'C2']);
        });

        it('uses the singular getter when both plural getters have been retired', () => {
            const zp = {
                getSelectedCollections: removed('getSelectedCollections'),
                getSelectedCollection: () => collection('SINGULAR'),
                collectionsView: { getSelectedCollections: removed('getSelectedCollections') },
            };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['SINGULAR']);
        });

        it('falls through for saved searches too', () => {
            const zp = {
                getSelectedSavedSearches: removed('getSelectedSavedSearches'),
                collectionsView: { getSelectedSearches: () => [search('S1'), search('S2')] },
            };
            expect(getSelectedSavedSearches(zp).map((s: any) => s.key)).toEqual(['S1', 'S2']);
        });

        it('does not log when a later rung succeeds', async () => {
            vi.resetModules();
            const fresh = await import('../../../src/utils/zoteroSelection');
            loggerCalls.length = 0;

            const zp = {
                getSelectedCollections: removed('getSelectedCollections'),
                collectionsView: { getSelectedCollections: () => [collection('C1')] },
            };
            expect(fresh.getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['C1']);
            expect(loggerCalls).toEqual([]);
        });

        it('reports an empty selection when a rung throws and no later rung exists', () => {
            const zp = { getSelectedCollections: removed('getSelectedCollections'), collectionsView: {} };
            expect(getSelectedCollections(zp)).toEqual([]);
        });

        it('tolerates collectionsView itself throwing', () => {
            const zp = {
                getSelectedCollection: () => collection('VIA_SINGULAR'),
                get collectionsView() { throw new Error('pane not ready'); },
            };
            expect(getSelectedCollections(zp).map((c: any) => c.key)).toEqual(['VIA_SINGULAR']);
        });
    });

    describe('failure logging', () => {
        // Suppression state lives for the life of the module (a broken pane API
        // should not spam the log), so this needs a fresh module instance rather
        // than the one the tests above have already logged through.
        it('logs a read failure once per kind, not once per call', async () => {
            vi.resetModules();
            const fresh = await import('../../../src/utils/zoteroSelection');
            loggerCalls.length = 0;

            const zp = {
                getSelectedCollection: removed('getSelectedCollection'),
                getSelectedLibraryID: removed('getSelectedLibraryID'),
            };

            fresh.getSelectedCollections(zp);
            fresh.getSelectedCollections(zp);
            fresh.getSelectedCollections(zp);
            const afterCollections = loggerCalls.length;

            fresh.getSelectedLibraryIds(zp);
            fresh.getSelectedLibraryIds(zp);

            // One line for collections, one for library ids — repeats suppressed
            expect(afterCollections).toBe(1);
            expect(loggerCalls.length).toBe(2);
            expect(loggerCalls[0]).toContain('the selected collections');
            expect(loggerCalls[1]).toContain('the selected library IDs');
        });
    });
});
