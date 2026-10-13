import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const { resolveItemReference, resolveFieldForItemType } = vi.hoisted(() => ({
    resolveItemReference: vi.fn(),
    resolveFieldForItemType: vi.fn(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference,
    libraryRefForLibraryID: () => undefined,
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
        resolveItemReference.mockResolvedValue({ status: 'resolved', item });

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
        resolveItemReference.mockResolvedValue({ status: 'resolved', item });

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
