/**
 * Focused unit tests for resolveTagsFilter and tagsFilterError
 * (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that these functions never touch, so every unrelated
 * dependency is stubbed out just to make the module importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn() },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
    isLibraryAccessReadyAtom: Symbol('isLibraryAccessReadyAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

import {
    resolveStoredTagName,
    resolveTagsFilter,
    tagsFilterError,
} from '../../../src/services/agentDataProvider/utils';

/** Tags per library, in the casing Zotero stores. */
const TAGS_BY_LIBRARY = new Map<number, string[]>([
    [1, ['Economics', 'economic history', 'Sociology', 'to read']],
    [100, ['Methods', 'Economics']],
    [300, ['Secret Project']],
]);

let getAll: ReturnType<typeof vi.fn>;

function installZoteroMock() {
    getAll = vi.fn(async (libraryId: number) =>
        (TAGS_BY_LIBRARY.get(libraryId) ?? []).map((tag) => ({ tag, type: 0 }))
    );
    (globalThis as any).Zotero = { Tags: { getAll } };
}

describe('resolveTagsFilter', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('resolves a tag to the casing Zotero stores, not the casing asked for', async () => {
        // The metadata search matches tags case-sensitively, so the stored
        // spelling is the only one that finds anything.
        const resolution = await resolveTagsFilter(['economics'], [1]);
        expect(resolution.tags).toEqual(['Economics']);
        expect(resolution.unresolved).toEqual([]);
    });

    it('keeps every stored casing when a library has more than one', async () => {
        TAGS_BY_LIBRARY.set(1, ['Economics', 'economics', 'Sociology']);
        try {
            const resolution = await resolveTagsFilter(['ECONOMICS'], [1]);
            expect(resolution.tags.sort()).toEqual(['Economics', 'economics']);
        } finally {
            TAGS_BY_LIBRARY.set(1, ['Economics', 'economic history', 'Sociology', 'to read']);
        }
    });

    it('resolves across every searched library and deduplicates', async () => {
        const resolution = await resolveTagsFilter(['economics', 'methods'], [1, 100]);
        expect(resolution.tags.sort()).toEqual(['Economics', 'Methods']);
        expect(getAll).toHaveBeenCalledTimes(2);
    });

    it('reports a tag no searched library has as unresolved', async () => {
        const resolution = await resolveTagsFilter(['Methods'], [1]);
        expect(resolution.tags).toEqual([]);
        expect(resolution.unresolved.map((entry) => entry.input)).toEqual(['Methods']);
    });

    it('resolves nothing without looking tags up when no library is in scope', async () => {
        // An empty scope must not reach the libraries the user excluded from
        // Beaver, and must not claim a tag is unknown while access is loading.
        const resolution = await resolveTagsFilter(['Secret Project'], []);
        expect(resolution).toEqual({ tags: [], unresolved: [] });
        expect(getAll).not.toHaveBeenCalled();
    });

    it('never resolves or suggests a tag from a library outside the search', async () => {
        const resolution = await resolveTagsFilter(['Secret Projekt'], [1, 100]);
        expect(resolution.tags).toEqual([]);
        expect(resolution.unresolved[0].suggestions).toEqual([]);
        expect(getAll).not.toHaveBeenCalledWith(300);
    });

    it('keeps the tags it found when only some entries resolve', async () => {
        const resolution = await resolveTagsFilter(['Sociology', 'nonexistent-tag'], [1]);
        expect(resolution.tags).toEqual(['Sociology']);
        expect(resolution.unresolved.map((entry) => entry.input)).toEqual(['nonexistent-tag']);
    });

    it('trims entries and drops blank and non-string ones', async () => {
        const resolution = await resolveTagsFilter(
            ['  Sociology  ', '   ', null as any, { name: 'x' } as any],
            [1]
        );
        expect(resolution.tags).toEqual(['Sociology']);
        expect(resolution.unresolved).toEqual([]);
    });

    it('resolves nothing for a filter of only unusable entries', async () => {
        // Nothing to report, but nothing resolved either: the caller must return
        // no results rather than search without a tag filter.
        const resolution = await resolveTagsFilter(['  '], [1]);
        expect(resolution).toEqual({ tags: [], unresolved: [] });
    });

    describe('suggestions', () => {
        it('offers a misspelled tag its closest stored spelling', async () => {
            const resolution = await resolveTagsFilter(['Sociolgy'], [1]);
            expect(resolution.unresolved[0].suggestions).toContain('Sociology');
        });

        it('offers the longer tag when the entry is a fragment of it', async () => {
            const resolution = await resolveTagsFilter(['econ'], [1]);
            expect(resolution.unresolved[0].suggestions).toContain('Economics');
        });

        it('ranks the closest stored tag first', async () => {
            const resolution = await resolveTagsFilter(['economic'], [1]);
            expect(resolution.unresolved[0].suggestions[0]).toBe('Economics');
        });

        it('offers nothing for an entry that resembles no tag', async () => {
            const resolution = await resolveTagsFilter(['quantum chromodynamics'], [1]);
            expect(resolution.unresolved[0].suggestions).toEqual([]);
        });

        it('offers at most three suggestions', async () => {
            TAGS_BY_LIBRARY.set(1, ['tag-a', 'tag-b', 'tag-c', 'tag-d', 'tag-e']);
            try {
                const resolution = await resolveTagsFilter(['tag-x'], [1]);
                expect(resolution.unresolved[0].suggestions).toHaveLength(3);
            } finally {
                TAGS_BY_LIBRARY.set(1, ['Economics', 'economic history', 'Sociology', 'to read']);
            }
        });
    });
});

describe('tagsFilterError', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('reports an unknown tag with its error code and a pointer to list_tags', async () => {
        const error = tagsFilterError(await resolveTagsFilter(['nonexistent-tag'], [1]));
        expect(error?.error_code).toBe('tag_not_found');
        expect(error?.message).toContain('Tag not found: "nonexistent-tag"');
        expect(error?.message).toContain('list_tags');
    });

    it('names the suggestions in the message', async () => {
        const error = tagsFilterError(await resolveTagsFilter(['Sociolgy'], [1]));
        expect(error?.message).toContain('did you mean "Sociology"');
    });

    it('lists every unresolved entry when several are unknown', async () => {
        const error = tagsFilterError(await resolveTagsFilter(['no-such-tag', 'other-missing'], [1]));
        expect(error?.message).toContain('Tags not found');
        expect(error?.message).toContain('"no-such-tag"');
        expect(error?.message).toContain('"other-missing"');
    });

    it('raises no error when one entry resolved and another did not', async () => {
        // The filter ORs its tags, so an entry that matches no tag would have
        // contributed nothing anyway — the search is the one the model asked for.
        const error = tagsFilterError(await resolveTagsFilter(['Sociology', 'nonexistent-tag'], [1]));
        expect(error).toBeNull();
    });

    it('raises no error while no library is in scope, so no reason is invented', async () => {
        expect(tagsFilterError(await resolveTagsFilter(['nonexistent-tag'], []))).toBeNull();
    });

    it('raises no error for an empty filter, so callers keep their own no-filter path', async () => {
        expect(tagsFilterError(await resolveTagsFilter([], [1]))).toBeNull();
    });
});

describe('resolveStoredTagName', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('resolves a mis-cased tag to the casing the library stores', async () => {
        const resolution = await resolveStoredTagName(1, 'My Library', 'ECONOMICS');
        expect(resolution).toEqual({ found: true, name: 'Economics' });
    });

    it('keeps a tag that already matches a stored casing', async () => {
        const resolution = await resolveStoredTagName(1, 'My Library', 'Sociology');
        expect(resolution).toEqual({ found: true, name: 'Sociology' });
    });

    it('reports a tag the library does not have, naming it and the library', async () => {
        const resolution = await resolveStoredTagName(1, 'My Library', 'Methods');
        expect(resolution.found).toBe(false);
        expect(resolution.found === false && resolution.error).toContain('"Methods"');
        expect(resolution.found === false && resolution.error).toContain('My Library');
    });

    it('prefers the exact casing when the library stores several', async () => {
        TAGS_BY_LIBRARY.set(1, ['Economics', 'economics', 'Sociology']);
        try {
            const resolution = await resolveStoredTagName(1, 'My Library', 'economics');
            expect(resolution).toEqual({ found: true, name: 'economics' });
        } finally {
            TAGS_BY_LIBRARY.set(1, ['Economics', 'economic history', 'Sociology', 'to read']);
        }
    });

    it('resolves a name Zotero lists once per tag type', async () => {
        // getAll() returns one row per tag type for the same name.
        getAll.mockResolvedValueOnce([
            { tag: 'Economics', type: 0 },
            { tag: 'Economics', type: 1 },
        ]);

        const resolution = await resolveStoredTagName(1, 'My Library', 'ECONOMICS');
        expect(resolution).toEqual({ found: true, name: 'Economics' });
    });

    it('names the stored casings rather than guessing when a mis-cased tag is ambiguous', async () => {
        TAGS_BY_LIBRARY.set(1, ['Economics', 'economics', 'Sociology']);
        try {
            const resolution = await resolveStoredTagName(1, 'My Library', 'ECONOMICS');
            expect(resolution.found).toBe(false);
            expect(resolution.found === false && resolution.error).toContain('"Economics"');
            expect(resolution.found === false && resolution.error).toContain('"economics"');
        } finally {
            TAGS_BY_LIBRARY.set(1, ['Economics', 'economic history', 'Sociology', 'to read']);
        }
    });
});
