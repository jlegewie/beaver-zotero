/**
 * Filtering the library by a tag.
 *
 * Tags are global in Zotero's schema, so a name does not name a library. These
 * cover the two ways a caller arrives — knowing the library or not — and the
 * cases where the honest answer is to do nothing and say why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: () => {} }));

import { selectTagFilter } from '../../../src/utils/selectItem';

/** Libraries holding each tag, as the `itemTags` query would report them. */
let tagLibraries: Record<string, number[]>;
let selectedLibrary: number | null;
let appliedTags: string[];
let pane: any;

function stubZotero(overrides: { pane?: any } = {}) {
    pane = overrides.pane !== undefined ? overrides.pane : {
        collectionsView: {
            selectLibrary: async (id: number) => { selectedLibrary = id; return true; },
        },
        itemsView: { setFilter: async () => {} },
        tagSelectorShown: () => true,
        tagSelector: {
            clearTagSelection: () => { appliedTags = []; },
            handleTagSelected: (tag: string) => { appliedTags.push(tag); },
        },
    };

    (globalThis as any).Zotero = {
        Tags: {
            // Zotero returns false, never 0, for a name it has never seen.
            getID: (name: string) => (name in tagLibraries ? 42 : false),
        },
        DB: {
            queryAsync: async (_sql: string, _params: any[], opts: any) => {
                // One tag per case, so the row set is simply its libraries.
                const [libraries = []] = Object.values(tagLibraries);
                for (const libraryID of libraries) {
                    opts.onRow({ getResultByIndex: () => libraryID });
                }
            },
        },
        getActiveZoteroPane: () => pane,
        getMainWindow: () => ({ Zotero_Tabs: { select: () => {} } }),
    };
}

beforeEach(() => {
    tagLibraries = {};
    selectedLibrary = null;
    appliedTags = [];
    stubZotero();
});

describe('filtering by a tag the caller knows the library for', () => {
    it('applies the filter in that library', async () => {
        tagLibraries = { methods: [1] };

        expect(await selectTagFilter('methods', 1)).toBe('filtered');
        expect(selectedLibrary).toBe(1);
        expect(appliedTags).toEqual(['methods']);
    });

    it('reports a tag that is no longer in the library it names', async () => {
        // A persisted result can name a tag since renamed, deleted, or left
        // only in another library. The tag selector takes any string, so
        // without this the user gets an empty view and no explanation.
        tagLibraries = { methods: [5] };

        expect(await selectTagFilter('methods', 1)).toBe('not_found');
        expect(selectedLibrary).toBeNull();
        expect(appliedTags).toEqual([]);
    });

    it('reports a tag that no library holds any more', async () => {
        tagLibraries = {};

        expect(await selectTagFilter('methods', 1)).toBe('not_found');
        expect(appliedTags).toEqual([]);
    });
});

describe('filtering by a tag with no library to go on', () => {
    it('uses the one library holding it', async () => {
        tagLibraries = { methods: [5] };

        expect(await selectTagFilter('methods')).toBe('filtered');
        expect(selectedLibrary).toBe(5);
        expect(appliedTags).toEqual(['methods']);
    });

    it('refuses to choose between libraries sharing the name', async () => {
        tagLibraries = { methods: [1, 5] };

        expect(await selectTagFilter('methods')).toBe('ambiguous');
        expect(selectedLibrary).toBeNull();
        expect(appliedTags).toEqual([]);
    });

    it('reports a name no library holds', async () => {
        tagLibraries = {};

        expect(await selectTagFilter('methods')).toBe('not_found');
        expect(selectedLibrary).toBeNull();
    });
});

describe('filtering with nowhere to show the result', () => {
    it('says so before resolving anything', async () => {
        // Reported rather than mistaken for a missing tag: on macOS the app
        // outlives its windows, and there is then no pane to filter.
        tagLibraries = { methods: [1] };
        stubZotero({ pane: null });

        expect(await selectTagFilter('methods', 1)).toBe('unavailable');
        expect(selectedLibrary).toBeNull();
    });
});
