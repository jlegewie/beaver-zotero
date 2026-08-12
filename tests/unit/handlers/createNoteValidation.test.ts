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

import { validateCreateNoteAction, executeCreateNoteAction } from '../../../src/services/agentDataProvider/actions/createNote';
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

/** Minimal timeout context; the guards under test run before any abort check. */
const executeCtx: any = { signal: new AbortController().signal, timeoutSeconds: 30, startTime: Date.now() };

function buildExecuteRequest(actionData: Record<string, any>): any {
    return {
        event: 'agent_action_execute',
        request_id: 'req-1',
        action_type: 'create_note',
        action_data: { title: 'Title', content: 'Body', library_id: 1, ...actionData },
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

    // The contract is that every requested collection resolves or the action is
    // rejected. Dropping an off-contract entry would file the note in fewer
    // collections than asked for, with nothing in the result to say so.
    it.each([
        ['a number', 12345],
        ['a boolean', true],
        ['an object', { key: 'RLKEY234' }],
    ])('rejects %s collection entry rather than dropping it', async (_label, value) => {
        const res = await validateCreateNoteAction(
            buildRequest({ collections: ['Reading List', value] }),
        );

        expect(res.valid).toBe(false);
        expect(res.normalized_action_data?.collection_keys).toBeUndefined();
    });

    // A child note never resolves its collection arguments, so an off-contract
    // entry has to be rejected up front — otherwise it survives into the
    // normalized data that is sent to the backend and persisted.
    it.each([
        ['a number', 12345],
        ['an object', { key: 'RLKEY234' }],
    ])('drops %s in the legacy singular collection field on a child note', async (_label, value) => {
        vi.mocked(resolveCreateNoteParent).mockResolvedValue({
            ok: true,
            parentKey: 'PRNTKEY2',
            resolvedLibraryId: 1,
            relatedItemKey: null,
            warning: null,
        });

        const res = await validateCreateNoteAction(
            buildRequest({ parent_item_id: '1-PRNTKEY2', collection: value }),
        );

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collection).toBeNull();
        expect(res.normalized_action_data?.collections).toEqual([]);
    });

    it.each([
        ['a number', 12345],
        ['an object', { key: 'RLKEY234' }],
    ])('rejects %s collection entry on a child note too', async (_label, value) => {
        vi.mocked(resolveCreateNoteParent).mockResolvedValue({
            ok: true,
            parentKey: 'PRNTKEY2',
            resolvedLibraryId: 1,
            relatedItemKey: null,
            warning: null,
        });

        const res = await validateCreateNoteAction(
            buildRequest({ parent_item_id: '1-PRNTKEY2', collections: [value] }),
        );

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collections).toEqual([]);
        expect(res.normalized_action_data?.collection).toBeNull();
        expect(res.normalized_action_data?.collection_keys).toEqual([]);
    });

    // A nullish entry is malformed rather than blank: it must be rejected before
    // it reaches the blank-entry filter, which would throw on it.
    it.each([
        ['null', null],
        ['undefined', undefined],
    ])('rejects %s collection entry without throwing', async (_label, value) => {
        const res = await validateCreateNoteAction(
            buildRequest({ collections: ['Reading List', value] }),
        );

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_request');
        expect(res.error).not.toContain('TypeError');
    });

    // Blank carries no request on either shape; the singular field must not
    // reject the whole note over it while the plural quietly drops it.
    it.each([
        ['an empty singular collection', { collection: '' }],
        ['a whitespace-only singular collection', { collection: '   ' }],
    ])('drops %s and still creates the note', async (_label, override) => {
        const res = await validateCreateNoteAction(buildRequest(override));

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collection_keys).toEqual([]);
    });

    it.each([
        ['an empty string', ''],
        ['whitespace only', '   '],
    ])('drops %s entry as carrying no request', async (_label, value) => {
        const res = await validateCreateNoteAction(
            buildRequest({ collections: ['Reading List', value] }),
        );

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.collection_keys).toEqual(['RLKEY234']);
    });

    it('rejects a non-array collections container instead of ignoring it', async () => {
        const res = await validateCreateNoteAction(
            buildRequest({ collections: 'Reading List' }),
        );

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_request');
        expect(res.error).toContain('"collections" parameter must be a list');
    });

    it('rejects a non-array tags container instead of throwing', async () => {
        const res = await validateCreateNoteAction(buildRequest({ tags: 'urgent' }));

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_request');
        expect(res.error).not.toContain('TypeError');
    });

    // Same rule as collections: an off-contract entry is rejected, not dropped,
    // so the note is never created with fewer tags than were asked for.
    it('rejects a non-string tags entry rather than dropping it', async () => {
        const res = await validateCreateNoteAction(buildRequest({ tags: ['urgent', 123] }));

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_request');
        expect(res.error).toContain('Every entry in "tags"');
    });

    it('still drops blank tag entries', async () => {
        const res = await validateCreateNoteAction(buildRequest({ tags: ['urgent', '  ', ''] }));

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data?.tags).toEqual(['urgent']);
    });

    // Execute repeats the container check because a request may skip validation.
    // Without it a bare string is walked character by character, writing one tag
    // per letter onto the created note.
    it.each([
        ['tags', { tags: 'urgent' }],
        ['collection_keys', { collection_keys: 'RLKEY234' }],
    ])('rejects a non-array %s on the execute path too', async (field, override) => {
        const res = await executeCreateNoteAction(
            buildExecuteRequest(override),
            executeCtx,
        );

        expect(res.success).toBe(false);
        expect(res.error_code).toBe('invalid_request');
        expect(res.error).toContain(`"${field}" must be a list`);
    });

    // Execute creates the note and skips what it cannot apply, so a reference that
    // went stale between proposal and apply does not cost the note its content; a
    // malformed entry is dropped on the same principle. A malformed *container* is
    // still rejected, since iterating it would corrupt every tag on the note.
    // This harness cannot construct a Zotero item, so it pins only the half that
    // is observable here: a malformed entry must not reject the action. The drop
    // itself is covered end to end against a live Zotero.
    it.each([
        ['tags', { tags: ['ok', 123] }],
        ['collection_keys', { collection_keys: ['RLKEY234', 123] }],
    ])('does not reject a non-string %s entry on the execute path', async (_field, override) => {
        const res = await executeCreateNoteAction(
            buildExecuteRequest(override),
            executeCtx,
        );

        // Contrast with the container cases above, which return invalid_request
        // through this same harness: a malformed entry must not reject the action.
        expect(res.error_code).not.toBe('invalid_request');
        expect(res.error ?? '').not.toContain('must be a list');
    });

    it('rejects a non-string parent_key on the execute path instead of throwing', async () => {
        const res = await executeCreateNoteAction(
            buildExecuteRequest({ parent_key: 12345 }),
            executeCtx,
        );

        expect(res.success).toBe(false);
        expect(res.error_code).toBe('invalid_request');
        expect(res.error).toContain('"parent_key" must be an item key string');
    });

    it('rejects a non-string parent_item_id instead of throwing', async () => {
        const res = await validateCreateNoteAction(buildRequest({ parent_item_id: 12345 }));

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_parent_id');
        expect(res.error).not.toContain('TypeError');
    });

    // An off-contract title/content must stay on the typed error path rather
    // than throwing on `.trim()` and surfacing a raw JS error to the model.
    // The message has to name the type: told only that the value is "empty", the
    // model can resend the same off-contract value unchanged.
    it.each([
        ['title', { title: 42 }, 'invalid_title'],
        ['content', { content: 42 }, 'invalid_content'],
    ])('rejects a non-string %s with its own error code and names the type', async (field, override, code) => {
        const res = await validateCreateNoteAction(buildRequest(override));

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe(code);
        expect(res.error).toContain(`"${field}" parameter must be a string`);
        expect(res.error).not.toContain('empty');
        expect(res.error).not.toContain('TypeError');
    });

    it.each([
        ['title', { title: 42 }],
        ['content', { content: 42 }],
    ])('names the offending type for a non-string %s on the execute path', async (field, override) => {
        const res = await executeCreateNoteAction(buildExecuteRequest(override), executeCtx);

        expect(res.success).toBe(false);
        expect(res.error).toContain(`"${field}" must be a string`);
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
