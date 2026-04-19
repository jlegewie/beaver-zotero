/**
 * Unit tests for react/utils/toolActionRegistry.ts.
 *
 * Each test stubs the underlying execute / undo utilities and ctx setters,
 * then asserts the exact call sequence the registry should produce. These
 * encode the subtle orchestration moved out of AgentActionView — especially
 * the bimodal throw contract that keeps isUndoError state correct.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../react/utils/editMetadataActions', () => ({
    executeEditMetadataAction: vi.fn(),
    undoEditMetadataAction: vi.fn(),
}));

vi.mock('../../../react/utils/createCollectionActions', () => ({
    executeCreateCollectionAction: vi.fn(),
    undoCreateCollectionAction: vi.fn(),
}));

vi.mock('../../../react/utils/organizeItemsActions', () => ({
    executeOrganizeItemsAction: vi.fn(),
    undoOrganizeItemsAction: vi.fn(),
}));

vi.mock('../../../react/utils/createItemActions', () => ({
    executeCreateItemActions: vi.fn(),
    undoCreateItemActions: vi.fn(),
}));

vi.mock('../../../react/utils/createNoteActions', () => ({
    executeCreateNoteAction: vi.fn(),
    undoCreateNoteAction: vi.fn(),
}));

vi.mock('../../../react/utils/manageTagsActions', () => ({
    executeManageTagsAction: vi.fn(),
    undoManageTagsAction: vi.fn(),
}));

vi.mock('../../../react/utils/manageCollectionsActions', () => ({
    executeManageCollectionsAction: vi.fn(),
    undoManageCollectionsAction: vi.fn(),
}));

vi.mock('../../../react/utils/editNoteActions', () => ({
    executeEditNoteAction: vi.fn(),
    undoEditNoteAction: vi.fn(),
}));

vi.mock('../../../react/components/agentRuns/agentActionViewHelpers', () => ({
    confirmOverwriteManualChanges: vi.fn(),
}));

import {
    TOOL_ACTION_REGISTRY,
    canonicalizeToolName,
    isAgentActionTool,
    type ToolActionContext,
} from '../../../react/utils/toolActionRegistry';
import { executeEditMetadataAction, undoEditMetadataAction } from '../../../react/utils/editMetadataActions';
import { executeCreateCollectionAction, undoCreateCollectionAction } from '../../../react/utils/createCollectionActions';
import { executeOrganizeItemsAction, undoOrganizeItemsAction } from '../../../react/utils/organizeItemsActions';
import { executeCreateItemActions, undoCreateItemActions } from '../../../react/utils/createItemActions';
import { executeCreateNoteAction, undoCreateNoteAction } from '../../../react/utils/createNoteActions';
import { executeManageTagsAction, undoManageTagsAction } from '../../../react/utils/manageTagsActions';
import { executeManageCollectionsAction, undoManageCollectionsAction } from '../../../react/utils/manageCollectionsActions';
import { executeEditNoteAction, undoEditNoteAction } from '../../../react/utils/editNoteActions';
import { confirmOverwriteManualChanges } from '../../../react/components/agentRuns/agentActionViewHelpers';

function makeCtx(overrides: Partial<ToolActionContext> = {}): ToolActionContext {
    return {
        actions: [],
        runId: 'run-1',
        ackAgentActions: vi.fn().mockResolvedValue(undefined),
        setAgentActionsToError: vi.fn(),
        undoAgentAction: vi.fn(),
        markExternalReferenceImported: vi.fn(),
        markExternalReferenceDeleted: vi.fn(),
        ...overrides,
    };
}

function makeAction(overrides: Partial<{ id: string; status: string; proposed_data: any; result_data: any }> = {}): any {
    return {
        id: 'action-1',
        run_id: 'run-1',
        action_type: 'edit_metadata',
        status: 'pending',
        proposed_data: {},
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('canonicalizeToolName', () => {
    it('maps create_item alias to create_items', () => {
        expect(canonicalizeToolName('create_item')).toBe('create_items');
    });

    it('returns canonical name unchanged', () => {
        expect(canonicalizeToolName('create_items')).toBe('create_items');
        expect(canonicalizeToolName('edit_metadata')).toBe('edit_metadata');
        expect(canonicalizeToolName('create_collection')).toBe('create_collection');
        expect(canonicalizeToolName('organize_items')).toBe('organize_items');
        expect(canonicalizeToolName('manage_tags')).toBe('manage_tags');
        expect(canonicalizeToolName('manage_collections')).toBe('manage_collections');
        expect(canonicalizeToolName('create_note')).toBe('create_note');
        expect(canonicalizeToolName('edit_note')).toBe('edit_note');
    });

    it('returns null for tools not in the registry', () => {
        expect(canonicalizeToolName('confirm_extraction')).toBeNull();
        expect(canonicalizeToolName('confirm_external_search')).toBeNull();
        expect(canonicalizeToolName('search')).toBeNull();
        expect(canonicalizeToolName('')).toBeNull();
    });

    it('isAgentActionTool narrows correctly', () => {
        expect(isAgentActionTool('create_item')).toBe(true);
        expect(isAgentActionTool('edit_note')).toBe(true);
        expect(isAgentActionTool('confirm_extraction')).toBe(false);
    });
});

describe('create_items handler', () => {
    it('apply: on mixed success/failure, ack successes and per-failure error; does NOT throw', async () => {
        const action1 = makeAction({ id: 'a1', status: 'pending', proposed_data: { item: { source_id: 'src-1' } } });
        const action2 = makeAction({ id: 'a2', status: 'pending', proposed_data: { item: { source_id: 'src-2' } } });
        const action3 = makeAction({ id: 'a3', status: 'pending', proposed_data: { item: {} } }); // no source_id

        (executeCreateItemActions as any).mockResolvedValue({
            successes: [
                { action: action1, result: { library_id: 1, zotero_key: 'KEY1' } },
                { action: action3, result: { library_id: 1, zotero_key: 'KEY3' } },
            ],
            failures: [
                { action: action2, error: 'boom', errorDetails: { stack_trace: 'trace' } },
            ],
        });

        const ctx = makeCtx({ actions: [action1, action2, action3] });

        await expect(TOOL_ACTION_REGISTRY.create_items.apply(ctx)).resolves.toBeUndefined();

        expect(ctx.ackAgentActions).toHaveBeenCalledTimes(1);
        expect(ctx.ackAgentActions).toHaveBeenCalledWith('run-1', [
            { action_id: 'a1', result_data: { library_id: 1, zotero_key: 'KEY1' } },
            { action_id: 'a3', result_data: { library_id: 1, zotero_key: 'KEY3' } },
        ]);

        // External-reference only for successes with source_id
        expect(ctx.markExternalReferenceImported).toHaveBeenCalledTimes(1);
        expect(ctx.markExternalReferenceImported).toHaveBeenCalledWith('src-1', { library_id: 1, zotero_key: 'KEY1' });

        expect(ctx.setAgentActionsToError).toHaveBeenCalledTimes(1);
        expect(ctx.setAgentActionsToError).toHaveBeenCalledWith(['a2'], 'boom', { stack_trace: 'trace' });
    });

    it('apply: filters out actions already in applied status', async () => {
        const action1 = makeAction({ id: 'a1', status: 'applied' });
        const action2 = makeAction({ id: 'a2', status: 'pending', proposed_data: { item: {} } });

        (executeCreateItemActions as any).mockResolvedValue({ successes: [], failures: [] });
        const ctx = makeCtx({ actions: [action1, action2] });

        await TOOL_ACTION_REGISTRY.create_items.apply(ctx);

        expect(executeCreateItemActions).toHaveBeenCalledWith([action2]);
    });

    it('apply: returns early without calling executor when all actions already applied', async () => {
        const ctx = makeCtx({ actions: [makeAction({ status: 'applied' })] });
        await TOOL_ACTION_REGISTRY.create_items.apply(ctx);
        expect(executeCreateItemActions).not.toHaveBeenCalled();
    });

    it('undo: on mixed success/failure, per-success undoAction + markDeleted, per-failure error; does NOT throw', async () => {
        const action1 = makeAction({ id: 'a1', status: 'applied', proposed_data: { item: { source_id: 'src-1' } } });
        const action2 = makeAction({ id: 'a2', status: 'applied', proposed_data: { item: {} } });
        const action3 = makeAction({ id: 'a3', status: 'applied', proposed_data: { item: { source_id: 'src-3' } } });

        (undoCreateItemActions as any).mockResolvedValue({
            successes: ['a1', 'a2'],
            failures: [
                { actionId: 'a3', error: 'fail', errorDetails: { error_name: 'E' } },
            ],
        });

        const ctx = makeCtx({ actions: [action1, action2, action3] });

        await expect(TOOL_ACTION_REGISTRY.create_items.undo(ctx)).resolves.toBeUndefined();

        expect(ctx.undoAgentAction).toHaveBeenCalledTimes(2);
        expect(ctx.undoAgentAction).toHaveBeenCalledWith('a1');
        expect(ctx.undoAgentAction).toHaveBeenCalledWith('a2');

        // Only a1 has a source_id
        expect(ctx.markExternalReferenceDeleted).toHaveBeenCalledTimes(1);
        expect(ctx.markExternalReferenceDeleted).toHaveBeenCalledWith('src-1');

        expect(ctx.setAgentActionsToError).toHaveBeenCalledTimes(1);
        expect(ctx.setAgentActionsToError).toHaveBeenCalledWith(['a3'], 'fail', { error_name: 'E' });
    });

    it('undo: filters to only applied actions', async () => {
        const action1 = makeAction({ id: 'a1', status: 'pending' });
        const action2 = makeAction({ id: 'a2', status: 'applied', proposed_data: { item: {} } });

        (undoCreateItemActions as any).mockResolvedValue({ successes: [], failures: [] });
        const ctx = makeCtx({ actions: [action1, action2] });

        await TOOL_ACTION_REGISTRY.create_items.undo(ctx);

        expect(undoCreateItemActions).toHaveBeenCalledWith([action2]);
    });

    it('apply: rethrows on catastrophic failure (batch call itself throws)', async () => {
        (executeCreateItemActions as any).mockRejectedValue(new Error('catastrophic'));
        const ctx = makeCtx({ actions: [makeAction({ status: 'pending', proposed_data: { item: {} } })] });

        await expect(TOOL_ACTION_REGISTRY.create_items.apply(ctx)).rejects.toThrow('catastrophic');
    });
});

describe('edit_metadata handler', () => {
    it('undo: confirmation path — user confirms → second force-revert call', async () => {
        const action = makeAction({ id: 'm1', action_type: 'edit_metadata' });
        (undoEditMetadataAction as any)
            .mockResolvedValueOnce({
                fieldsReverted: 0,
                alreadyReverted: [],
                manuallyModified: ['title', 'abstract'],
                needsConfirmation: true,
            })
            .mockResolvedValueOnce({
                fieldsReverted: 2,
                alreadyReverted: [],
                manuallyModified: [],
                needsConfirmation: false,
            });
        (confirmOverwriteManualChanges as any).mockReturnValue(true);

        const ctx = makeCtx({ actions: [action] });
        await TOOL_ACTION_REGISTRY.edit_metadata.undo(ctx);

        expect(undoEditMetadataAction).toHaveBeenCalledTimes(2);
        expect(undoEditMetadataAction).toHaveBeenNthCalledWith(1, action, false);
        expect(undoEditMetadataAction).toHaveBeenNthCalledWith(2, action, true);
        expect(confirmOverwriteManualChanges).toHaveBeenCalledWith(['title', 'abstract']);
        expect(ctx.undoAgentAction).toHaveBeenCalledWith('m1');
    });

    it('undo: confirmation path — user declines → single call, still marks undone (matches current behavior)', async () => {
        const action = makeAction({ id: 'm1', action_type: 'edit_metadata' });
        (undoEditMetadataAction as any).mockResolvedValueOnce({
            fieldsReverted: 0,
            alreadyReverted: [],
            manuallyModified: ['title'],
            needsConfirmation: true,
        });
        (confirmOverwriteManualChanges as any).mockReturnValue(false);

        const ctx = makeCtx({ actions: [action] });
        await TOOL_ACTION_REGISTRY.edit_metadata.undo(ctx);

        expect(undoEditMetadataAction).toHaveBeenCalledTimes(1);
        expect(ctx.undoAgentAction).toHaveBeenCalledWith('m1');
    });

    it('apply: calls executor, acks result, rethrows on failure', async () => {
        const action = makeAction({ id: 'm1' });
        (executeEditMetadataAction as any).mockResolvedValue({ applied_edits: [] });

        const ctx = makeCtx({ actions: [action] });
        await TOOL_ACTION_REGISTRY.edit_metadata.apply(ctx);

        expect(ctx.ackAgentActions).toHaveBeenCalledWith('run-1', [
            { action_id: 'm1', result_data: { applied_edits: [] } },
        ]);
    });

    it('apply: rethrows on executor failure without calling ack', async () => {
        (executeEditMetadataAction as any).mockRejectedValue(new Error('exec failed'));
        const ctx = makeCtx({ actions: [makeAction()] });
        await expect(TOOL_ACTION_REGISTRY.edit_metadata.apply(ctx)).rejects.toThrow('exec failed');
        expect(ctx.ackAgentActions).not.toHaveBeenCalled();
    });
});

describe('single-action undo handlers rethrow on failure (preserves Retry Undo semantics)', () => {
    const cases: Array<{ tool: keyof typeof TOOL_ACTION_REGISTRY; undoMock: any }> = [
        { tool: 'edit_metadata', undoMock: undoEditMetadataAction },
        { tool: 'create_collection', undoMock: undoCreateCollectionAction },
        { tool: 'organize_items', undoMock: undoOrganizeItemsAction },
        { tool: 'manage_tags', undoMock: undoManageTagsAction },
        { tool: 'manage_collections', undoMock: undoManageCollectionsAction },
        { tool: 'create_note', undoMock: undoCreateNoteAction },
        { tool: 'edit_note', undoMock: undoEditNoteAction },
    ];

    it.each(cases)('$tool undo rethrows', async ({ tool, undoMock }) => {
        (undoMock as any).mockRejectedValue(new Error(`${tool} undo failed`));
        const ctx = makeCtx({ actions: [makeAction()] });
        await expect(TOOL_ACTION_REGISTRY[tool].undo(ctx)).rejects.toThrow(`${tool} undo failed`);
        // undoAgentAction must NOT be called when undo throws
        expect(ctx.undoAgentAction).not.toHaveBeenCalled();
    });
});

describe('single-action apply handlers rethrow on failure', () => {
    const cases: Array<{ tool: keyof typeof TOOL_ACTION_REGISTRY; executeMock: any }> = [
        { tool: 'edit_metadata', executeMock: executeEditMetadataAction },
        { tool: 'create_collection', executeMock: executeCreateCollectionAction },
        { tool: 'organize_items', executeMock: executeOrganizeItemsAction },
        { tool: 'manage_tags', executeMock: executeManageTagsAction },
        { tool: 'manage_collections', executeMock: executeManageCollectionsAction },
        { tool: 'create_note', executeMock: executeCreateNoteAction },
        { tool: 'edit_note', executeMock: executeEditNoteAction },
    ];

    it.each(cases)('$tool apply rethrows and does not ack', async ({ tool, executeMock }) => {
        (executeMock as any).mockRejectedValue(new Error(`${tool} apply failed`));
        const ctx = makeCtx({ actions: [makeAction()] });
        await expect(TOOL_ACTION_REGISTRY[tool].apply(ctx)).rejects.toThrow(`${tool} apply failed`);
        expect(ctx.ackAgentActions).not.toHaveBeenCalled();
    });
});

describe('single-action apply handlers happy-path ack', () => {
    it('create_note passes runId to executor', async () => {
        const action = makeAction({ id: 'n1' });
        (executeCreateNoteAction as any).mockResolvedValue({ library_id: 1, zotero_key: 'NK' });
        const ctx = makeCtx({ actions: [action], runId: 'r-42' });

        await TOOL_ACTION_REGISTRY.create_note.apply(ctx);

        expect(executeCreateNoteAction).toHaveBeenCalledWith(action, 'r-42');
        expect(ctx.ackAgentActions).toHaveBeenCalledWith('r-42', [
            { action_id: 'n1', result_data: { library_id: 1, zotero_key: 'NK' } },
        ]);
    });

    it('edit_note apply acks result, undo calls undoAgentAction', async () => {
        const action = makeAction({ id: 'en1', action_type: 'edit_note' });
        (executeEditNoteAction as any).mockResolvedValue({ library_id: 1, zotero_key: 'NK' });
        (undoEditNoteAction as any).mockResolvedValue(undefined);

        const applyCtx = makeCtx({ actions: [action], runId: 'r-7' });
        await TOOL_ACTION_REGISTRY.edit_note.apply(applyCtx);
        expect(executeEditNoteAction).toHaveBeenCalledWith(action);
        expect(applyCtx.ackAgentActions).toHaveBeenCalledWith('r-7', [
            { action_id: 'en1', result_data: { library_id: 1, zotero_key: 'NK' } },
        ]);

        const undoCtx = makeCtx({ actions: [action] });
        await TOOL_ACTION_REGISTRY.edit_note.undo(undoCtx);
        expect(undoEditNoteAction).toHaveBeenCalledWith(action);
        expect(undoCtx.undoAgentAction).toHaveBeenCalledWith('en1');
    });

    it('create_collection, organize_items, manage_tags, manage_collections call undoAgentAction on undo success', async () => {
        const action = makeAction();
        (undoCreateCollectionAction as any).mockResolvedValue(undefined);
        (undoOrganizeItemsAction as any).mockResolvedValue(undefined);
        (undoManageTagsAction as any).mockResolvedValue(undefined);
        (undoManageCollectionsAction as any).mockResolvedValue(undefined);

        for (const tool of ['create_collection', 'organize_items', 'manage_tags', 'manage_collections'] as const) {
            const ctx = makeCtx({ actions: [action] });
            await TOOL_ACTION_REGISTRY[tool].undo(ctx);
            expect(ctx.undoAgentAction).toHaveBeenCalledWith(action.id);
        }
    });
});
