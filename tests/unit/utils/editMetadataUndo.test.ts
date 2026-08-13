import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

let item: any;

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference: async () => ({ status: 'found', item }),
}));

import { undoEditMetadataAction } from '../../../react/utils/editMetadataActions';
import type { AgentAction } from '../../../react/agents/agentActions';

/** An edit_metadata action that set `publisher`, applied. */
function publisherEdit(): AgentAction {
    return {
        id: 'action-1',
        run_id: 'run-1',
        action_type: 'edit_metadata',
        status: 'applied',
        proposed_data: { library_id: 1, zotero_key: 'ITEMKEY1' },
        result_data: {
            applied_edits: [
                { field: 'publisher', old_value: 'Old Press', applied_value: 'New Press' },
            ],
        },
    } as unknown as AgentAction;
}

describe('undoEditMetadataAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        item = {
            loadDataType: vi.fn().mockResolvedValue(undefined),
            getField: vi.fn(() => 'New Press'),
            setField: vi.fn(),
            getCreatorsJSON: vi.fn(() => []),
            setCreators: vi.fn(),
            saveTx: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('loads item data before reading fields', async () => {
        // getAsync loads primary data only, so an item fetched fresh would
        // throw on getField and the undo would misread its own effect.
        await undoEditMetadataAction(publisherEdit());

        expect(item.loadDataType).toHaveBeenCalledWith('itemData');
        expect(item.loadDataType.mock.invocationCallOrder[0])
            .toBeLessThan(item.getField.mock.invocationCallOrder[0]);
    });

    it('reverts a field the action set', async () => {
        const result = await undoEditMetadataAction(publisherEdit());

        expect(item.setField).toHaveBeenCalledWith('publisher', 'Old Press');
        expect(result.fieldsReverted).toBe(1);
        expect(result.failed).toEqual([]);
    });

    it('reports a field whose current value cannot be read', async () => {
        // Unreadable is not the same as empty: treating it as null would match
        // an empty old value and read as already reverted, so the caller would
        // be told the undo completed while the applied value is still there.
        item.getField = vi.fn(() => { throw new Error('Invalid field'); });

        const result = await undoEditMetadataAction(publisherEdit());

        expect(item.setField).not.toHaveBeenCalled();
        expect(result.alreadyReverted).toEqual([]);
        expect(result.failed).toEqual(['publisher']);
    });

    it('reports a field whose write throws', async () => {
        item.setField = vi.fn(() => { throw new Error('not a valid field for this item type'); });

        const result = await undoEditMetadataAction(publisherEdit());

        expect(result.fieldsReverted).toBe(0);
        expect(result.failed).toEqual(['publisher']);
    });

    it('sees through the trimming and NFC folding Zotero applies on write', async () => {
        // setField stores a trimmed, NFC-normalized string, so a proposal
        // carrying an NFD accent comes back differently than it went in.
        // Comparing raw would read that as the user having edited the field.
        const action = publisherEdit();
        (action as any).result_data.applied_edits = [
            { field: 'publisher', old_value: 'Old Press', applied_value: ' Presse Universitée ' },
        ];
        item.getField = vi.fn(() => 'Presse Universitée');

        const result = await undoEditMetadataAction(action);

        expect(item.setField).toHaveBeenCalledWith('publisher', 'Old Press');
        expect(result.manuallyModified).toEqual([]);
        expect(result.fieldsReverted).toBe(1);
    });

    it('reports creators whose write throws', async () => {
        item.setCreators = vi.fn(() => { throw new Error('bad creator'); });
        item.getCreatorsJSON = vi.fn(() => [{ firstName: 'New', lastName: 'Author', creatorType: 'author' }]);
        const action = publisherEdit();
        (action as any).result_data.old_creators = [{ firstName: 'Old', lastName: 'Author', creatorType: 'author' }];
        (action as any).result_data.new_creators = [{ firstName: 'New', lastName: 'Author', creatorType: 'author' }];

        const result = await undoEditMetadataAction(action);

        expect(result.failed).toEqual(['creators']);
    });
});
