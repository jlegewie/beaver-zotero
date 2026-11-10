import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const { resolveItemReference, resolveFieldForItemType, excluded } = vi.hoisted(() => ({
    resolveItemReference: vi.fn(),
    resolveFieldForItemType: vi.fn(),
    excluded: new Set<number>(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference,
    resolveLibraryRef: () => 1,
    modelObjectIdFromReference: (ref: { library_id: number; zotero_key: string }) => `${ref.library_id}-${ref.zotero_key}`,
    libraryRefForLibraryID: () => undefined,
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: (id: number) => (excluded.has(id) ? { message: `Library ${id} is excluded` } : null),
    excludedLibraryMessage: vi.fn(),
    getDeferredToolPreference: vi.fn(),
}));
vi.mock('../../../src/utils/libraryMessages', () => ({
    excludedLibraryUserMessage: () => 'This library is excluded from Beaver.',
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    resolveFieldForItemType,
    sanitizeCreators: (creators: unknown) => creators,
}));

import {
    executeEditMetadataAction,
    undoEditMetadataAction,
} from '../../../src/services/manualActions/editMetadataActions';

const DOCUMENT_FIELDS = new Set(['title', 'publisher']);

/** A document item that, like Zotero, rejects labels belonging to other types. */
function makeDocumentItem(fields: Record<string, string>) {
    return {
        libraryID: 1,
        itemTypeID: 7,
        getField: vi.fn((field: string) => (DOCUMENT_FIELDS.has(field) ? (fields[field] ?? '') : '')),
        setField: vi.fn((field: string, value: string) => {
            if (!DOCUMENT_FIELDS.has(field)) {
                throw new Error(`'${field}' is not a valid field for type 'document'`);
            }
            fields[field] = value;
        }),
        saveTx: vi.fn(async () => true),
        getCreatorsJSON: vi.fn(() => []),
    };
}

function makeAction(overrides: Record<string, unknown> = {}) {
    return {
        id: 'action-1',
        proposed_data: {
            library_id: 1,
            zotero_key: 'ABCD1234',
            edits: [{ field: 'institution', new_value: 'MIT' }],
        },
        ...overrides,
    } as any;
}

describe('edit_metadata manual actions with wrong-type field labels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveFieldForItemType.mockImplementation((_typeID: number, field: string) =>
            field === 'institution' || field === 'university' ? 'publisher' : field,
        );
    });

    it('applies an approved edit to the field equivalent for the item type', async () => {
        const fields: Record<string, string> = { publisher: 'Old Press' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        const result = await executeEditMetadataAction(makeAction());

        expect(fields.publisher).toBe('MIT');
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        expect(result.failed_edits).toEqual([]);
        // The agent-supplied label is reported so results match the request.
        expect(result.applied_edits).toEqual([
            { field: 'institution', applied_value: 'MIT', old_value: 'Old Press' },
        ]);
    });

    it('reverts an edit stored under a wrong-type label', async () => {
        const fields: Record<string, string> = { publisher: 'MIT' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        const result = await undoEditMetadataAction(makeAction({
            result_data: {
                applied_edits: [{ field: 'university', new_value: 'MIT', old_value: 'Old Press' }],
            },
        }));

        expect(fields.publisher).toBe('Old Press');
        expect(result.fieldsReverted).toBe(1);
        expect(result.alreadyReverted).toEqual([]);
        expect(item.saveTx).toHaveBeenCalledTimes(1);
    });
});

describe('applying a stored edit_metadata proposal later', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveFieldForItemType.mockImplementation((_typeID: number, field: string) => field);
    });

    function proposal(edits: unknown[], extra: Record<string, unknown> = {}) {
        return makeAction({ proposed_data: { library_id: 1, zotero_key: 'ABCD1234', edits, ...extra } });
    }

    it('refuses without writing when a field changed in Zotero since the proposal', async () => {
        const fields: Record<string, string> = { title: 'Edited by the user' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        await expect(executeEditMetadataAction(proposal([
            { field: 'title', old_value: 'Original', new_value: 'Proposed' },
        ]))).rejects.toMatchObject({ code: 'stale_proposal', message: expect.stringContaining('title') });

        expect(item.setField).not.toHaveBeenCalled();
        expect(item.saveTx).not.toHaveBeenCalled();
        expect(fields.title).toBe('Edited by the user');
    });

    it('treats a field already at the proposed value as unchanged', async () => {
        const fields: Record<string, string> = { title: 'Proposed', publisher: 'Old Press' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        const result = await executeEditMetadataAction(proposal([
            { field: 'title', old_value: 'Original', new_value: 'Proposed' },
            { field: 'publisher', old_value: 'Old Press', new_value: 'New Press' },
        ]));

        expect(fields.publisher).toBe('New Press');
        expect(result.failed_edits).toEqual([]);
    });

    it('treats an empty field and a null baseline as the same value', async () => {
        const fields: Record<string, string> = {};
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        await executeEditMetadataAction(proposal([{ field: 'title', old_value: null, new_value: 'Proposed' }]));

        expect(fields.title).toBe('Proposed');
    });

    it('writes anyway when the user skips the check', async () => {
        const fields: Record<string, string> = { title: 'Edited by the user' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        const result = await executeEditMetadataAction(
            proposal([{ field: 'title', old_value: 'Original', new_value: 'Proposed' }]),
            { skipStaleCheck: true },
        );

        expect(fields.title).toBe('Proposed');
        expect(result.applied_edits[0]).toMatchObject({ field: 'title', old_value: 'Edited by the user' });
    });

    it('does not check a proposal stored without baselines', async () => {
        const fields: Record<string, string> = { title: 'Edited by the user' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        await executeEditMetadataAction(proposal([{ field: 'title', new_value: 'Proposed' }]));

        expect(fields.title).toBe('Proposed');
    });

    it('refuses when the creators changed since the proposal', async () => {
        const item = makeDocumentItem({});
        item.getCreatorsJSON.mockReturnValue([{ creatorType: 'author', lastName: 'Edited' }] as any);
        (item as any).setCreators = vi.fn();
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        await expect(executeEditMetadataAction(proposal([], {
            creators: [{ creatorType: 'author', lastName: 'Proposed' }],
            old_creators: [{ creatorType: 'author', lastName: 'Original' }],
        }))).rejects.toMatchObject({ code: 'stale_proposal', message: expect.stringContaining('Creators') });

        expect((item as any).setCreators).not.toHaveBeenCalled();
    });

    it('records a partly failed apply as applied, listing the fields it could not set', async () => {
        const fields: Record<string, string> = { title: 'Original' };
        const item = makeDocumentItem(fields);
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        const result = await executeEditMetadataAction(proposal([
            { field: 'title', old_value: 'Original', new_value: 'Proposed' },
            { field: 'pages', old_value: null, new_value: '1-10' },
        ]));

        expect(item.saveTx).toHaveBeenCalledTimes(1);
        expect(result.applied_edits).toEqual([{ field: 'title', applied_value: 'Proposed', old_value: 'Original' }]);
        expect(result.failed_edits).toEqual([{ field: 'pages', error: expect.stringContaining('not a valid field') }]);
    });

    it('fails the apply when no edit could be made', async () => {
        const item = makeDocumentItem({});
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        await expect(executeEditMetadataAction(proposal([
            { field: 'pages', new_value: '1-10' },
        ]))).rejects.toThrow(/No edits could be applied: pages/);
        expect(item.saveTx).not.toHaveBeenCalled();
    });
    it('refuses an item in a library excluded since the proposal, before resolving it', async () => {
        excluded.add(1);
        try {
            await expect(executeEditMetadataAction(proposal([
                { field: 'title', new_value: 'Proposed' },
            ]))).rejects.toMatchObject({ code: 'library_not_searchable', userMessage: 'This library is excluded from Beaver.' });
            expect(resolveItemReference).not.toHaveBeenCalled();
        } finally {
            excluded.delete(1);
        }
    });

    it('restores the item in memory when the save fails, so a later save cannot persist the edit', async () => {
        const fields: Record<string, string> = { title: 'Original' };
        const item = makeDocumentItem(fields);
        item.saveTx.mockRejectedValueOnce(new Error('database is locked'));
        resolveItemReference.mockResolvedValue({ status: 'found', item });

        await expect(executeEditMetadataAction(proposal([
            { field: 'title', old_value: 'Original', new_value: 'Proposed' },
        ]))).rejects.toMatchObject({ code: 'save_failed' });
        expect(fields.title).toBe('Original');
    });
});
