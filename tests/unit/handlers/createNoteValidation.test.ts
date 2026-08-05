/**
 * Unit tests for create_note validation, focused on how collection references
 * are resolved: all-or-nothing for a standalone note, ignored outright for a
 * child note (Zotero forbids child notes in collections), and the recovery
 * probe that treats a parent_id naming a collection as a collection argument.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fixture state the faked collection resolver reads.
const harness = vi.hoisted(() => ({
    collections: [] as any[],
    libraryRefs: { 1: 'u', 100: 'g12345' } as Record<number, string>,
    libraryNames: { 1: 'My Library', 100: 'Group A' } as Record<number, string>,
    searchableLibraryIds: [1, 100] as number[],
}));

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const { createCollectionResolverFake } = await import('../../helpers/collectionResolverFake');
    const fake = createCollectionResolverFake(harness);
    return {
        checkLibraryExcluded: vi.fn(() => null),
        excludedLibraryMessage: vi.fn((id: number) => `Library ${id} is excluded from Beaver.`),
        getDeferredToolPreference: vi.fn(() => 'always_ask'),
        getLibraryByIdOrName: vi.fn(() => ({ library: null, wasExplicitlyRequested: true, searchInput: null })),
        getSearchableLibraryIds: vi.fn(fake.getSearchableLibraryIds),
        isLibrarySearchable: vi.fn(fake.isLibrarySearchable),
        resolveSingleCollection: vi.fn(fake.resolveSingleCollection),
    };
});

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => harness.searchableLibraryIds), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom') }));
vi.mock('../../../react/atoms/citations', () => ({ citationMapAtom: Symbol('citationMapAtom') }));
vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
}));
vi.mock('../../../react/atoms/threads', () => ({ currentThreadIdAtom: Symbol('currentThreadIdAtom') }));
vi.mock('../../../react/atoms/runApprovalPolicy', () => ({ grantCreatedNoteEditsForRunAtom: Symbol('grant') }));
vi.mock('../../../react/agents/atoms', () => ({ activeRunAtom: Symbol('activeRunAtom') }));
vi.mock('../../../react/utils/citationRenderers', () => ({ renderToHTML: vi.fn() }));
vi.mock('../../../react/utils/citationRenderContext', () => ({ prepareCitationRenderContext: vi.fn() }));
vi.mock('../../../react/utils/noteActions', () => ({
    wrapWithSchemaVersion: vi.fn(),
    getBeaverNoteFooterHTML: vi.fn(),
}));
vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({ getOrSimplify: vi.fn() }));
vi.mock('../../../src/utils/noteCitationExpand', () => ({ preloadNotePageLabels: vi.fn() }));
vi.mock('../../../src/utils/noteEditorIO', () => ({ getLatestNoteHtml: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/actions/extractCitationReferences', () => ({
    extractCitationReferences: vi.fn(() => ({ references: [], invalidKeys: [] })),
}));
vi.mock('../../../src/services/agentDataProvider/lookupZoteroReferences', () => ({
    lookupZoteroReferences: vi.fn(),
}));
vi.mock('../../../src/services/agentDataProvider/actions/resolveCreateNoteParent', () => ({
    resolveCreateNoteParent: vi.fn(),
}));

import { validateCreateNoteAction } from '../../../src/services/agentDataProvider/actions/createNote';
import { resolveCreateNoteParent } from '../../../src/services/agentDataProvider/actions/resolveCreateNoteParent';
import { resolveSingleCollection } from '../../../src/services/agentDataProvider/utils';

function buildRequest(actionData: Record<string, any>): any {
    return {
        event: 'agent_action_validate',
        request_id: 'req-1',
        action_type: 'create_note',
        action_data: { title: 'Title', content: 'Body', ...actionData },
    };
}

const standaloneParent = {
    ok: true as const,
    parentKey: null,
    resolvedLibraryId: null,
    relatedItemKey: null,
    warning: null,
};

beforeEach(() => {
    vi.clearAllMocks();
    harness.collections = [
        { id: 1, key: 'RLKEY234', libraryID: 1, name: 'Reading List' },
        { id: 2, key: 'GRPKEY23', libraryID: 100, name: 'Group Reading' },
    ];
    harness.searchableLibraryIds = [1, 100];

    (globalThis as any).Zotero = {
        Libraries: {
            get: vi.fn((id: number) => ({ libraryID: id, name: harness.libraryNames[id], editable: true })),
            getAll: vi.fn(() => [{ libraryID: 1, name: 'My Library' }, { libraryID: 100, name: 'Group A' }]),
            userLibraryID: 1,
        },
        Groups: {
            getGroupIDFromLibraryID: vi.fn((id: number) => (id === 100 ? 12345 : false)),
            getLibraryIDFromGroupID: vi.fn((groupId: number) => (groupId === 12345 ? 100 : false)),
        },
        Utilities: {
            isValidObjectKey: vi.fn((key: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)),
        },
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async () => null),
            loadDataTypes: vi.fn(async () => undefined),
        },
        Collections: { get: vi.fn(() => null) },
    };

    vi.mocked(resolveCreateNoteParent).mockResolvedValue(standaloneParent);
});

describe('validateCreateNoteAction collections', () => {
    it('accepts a collection name and normalizes it to a bare key', async () => {
        const res = await validateCreateNoteAction(buildRequest({ collections: ['Reading List'] }));

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collection_keys).toEqual(['RLKEY234']);
    });

    it('accepts a scoped collection identifier for the note library', async () => {
        const res = await validateCreateNoteAction(buildRequest({ collections: ['u-RLKEY234'] }));

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collection_keys).toEqual(['RLKEY234']);
    });

    it('rejects the whole action when one of several collections does not resolve', async () => {
        const res = await validateCreateNoteAction(
            buildRequest({ collections: ['Reading List', 'NOSUCH'] }),
        );

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('collection_not_found');
        expect(res.error).toContain('NOSUCH');
    });

    it('rejects a collection from another library instead of filing the note without it', async () => {
        const res = await validateCreateNoteAction(
            buildRequest({ collections: ['Reading List', 'g12345-GRPKEY23'] }),
        );

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_request');
    });

    it('ignores a child note\'s collection arguments without resolving them', async () => {
        vi.mocked(resolveCreateNoteParent).mockResolvedValue({
            ok: true,
            parentKey: 'PRNTKEY2',
            resolvedLibraryId: 1,
            relatedItemKey: null,
            warning: null,
        });

        const res = await validateCreateNoteAction(
            buildRequest({ parent_item_id: '1-PRNTKEY2', collections: ['NOSUCH', 'g99999-ZZZZ2345'] }),
        );

        // Zotero forbids child notes in collections, so the arguments can
        // neither be applied nor fail the action — they are never resolved.
        // The only resolution is the separate probe of parent_id itself.
        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collection_keys).toEqual([]);
        const resolvedRefs = vi.mocked(resolveSingleCollection).mock.calls.map((call) => call[0]);
        expect(resolvedRefs).toEqual(['1-PRNTKEY2']);
    });
});

describe('validateCreateNoteAction parent_id collection recovery', () => {
    it('swaps a parent_id that names a collection in a searchable library', async () => {
        const res = await validateCreateNoteAction(
            buildRequest({ parent_item_id: 'g12345-GRPKEY23' }),
        );

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.parent_item_id).toBeNull();
        expect(res.normalized_action_data?.collection_keys).toEqual(['GRPKEY23']);
    });

    it('does not disclose a collection in an excluded library', async () => {
        harness.searchableLibraryIds = [1];
        vi.mocked(resolveCreateNoteParent).mockResolvedValue({
            ok: false,
            error: 'Parent item not found: g12345-GRPKEY23',
            errorCode: 'item_not_found',
        });

        const res = await validateCreateNoteAction(
            buildRequest({ parent_item_id: 'g12345-GRPKEY23', library: 'My Library' }),
        );

        // Neither probe may read from the excluded library...
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(vi.mocked(resolveSingleCollection).mock.calls[0][1].eligibleLibraryIds).toEqual([1]);
        // ...and the failure must not reveal that the collection exists there.
        expect(res.valid).toBe(false);
        expect(res.error).not.toContain('Group A');
        expect(res.error).not.toContain('Group Reading');
    });
});
