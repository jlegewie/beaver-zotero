import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks (must precede imports)
//
// `undoAppliedActionsInReverse` is a dispatch table over action_type; the only
// things worth stubbing are the per-type undo functions it dispatches TO. The
// type predicates stay real, since "does this action_type reach its branch" is
// exactly what is under test.
// =============================================================================

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../react/utils/editNoteBlocksActions', () => ({
    undoEditNoteBlocksAction: vi.fn(async () => {}),
}));

vi.mock('../../../react/utils/editNoteActions', () => ({
    undoEditNoteAction: vi.fn(async () => {}),
    undoEditNoteBatchAction: vi.fn(async () => {}),
}));

vi.mock('../../../react/utils/createNoteActions', () => ({
    undoCreateNoteAction: vi.fn(async () => {}),
}));

import { undoAppliedActionsInReverse } from '../../../react/atoms/agentRunAtoms';
import { undoEditNoteBlocksAction } from '../../../react/utils/editNoteBlocksActions';
import { undoEditNoteAction, undoEditNoteBatchAction } from '../../../react/utils/editNoteActions';
import { logger } from '@beaver/agent-core/platform/logger';

function appliedAction(id: string, action_type: string): any {
    return { id, action_type, status: 'applied', proposed_data: {}, result_data: {} };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('undoAppliedActionsInReverse', () => {
    it('undoes an applied edit_note_blocks action and records it', async () => {
        const action = appliedAction('blocks-1', 'edit_note_blocks');

        const undoneIds = await undoAppliedActionsInReverse([action]);

        expect(undoEditNoteBlocksAction).toHaveBeenCalledTimes(1);
        expect(undoEditNoteBlocksAction).toHaveBeenCalledWith(action);
        expect(undoneIds).toEqual(['blocks-1']);
    });

    it('routes each note-edit variant to its own undo', async () => {
        await undoAppliedActionsInReverse([
            appliedAction('legacy-1', 'edit_note'),
            appliedAction('batch-1', 'edit_note_batch'),
            appliedAction('blocks-1', 'edit_note_blocks'),
        ]);

        expect(undoEditNoteAction).toHaveBeenCalledTimes(1);
        expect(undoEditNoteBatchAction).toHaveBeenCalledTimes(1);
        expect(undoEditNoteBlocksAction).toHaveBeenCalledTimes(1);
    });

    it('does NOT record an action type with no undo branch as undone, and logs it', async () => {
        // The regression this guards: the push used to sit outside the if/else
        // chain, so an unhandled type mutated nothing yet was reported as undone
        // — and silently, because nothing threw into the catch.
        const undoneIds = await undoAppliedActionsInReverse([
            appliedAction('unhandled-1', 'confirm_extraction'),
        ]);

        expect(undoneIds).toEqual([]);
        expect(vi.mocked(logger).mock.calls.map((c) => String(c[0])).join('\n'))
            .toContain('no undo handler for action unhandled-1 (confirm_extraction)');
    });

    it('keeps unwinding the handled actions around an unhandled one', async () => {
        const undoneIds = await undoAppliedActionsInReverse([
            appliedAction('blocks-1', 'edit_note_blocks'),
            appliedAction('unhandled-1', 'confirm_external_search'),
            appliedAction('batch-1', 'edit_note_batch'),
        ]);

        // Reverse array order, with the unhandled action dropped.
        expect(undoneIds).toEqual(['batch-1', 'blocks-1']);
    });

    it('ignores actions that were never applied', async () => {
        const undoneIds = await undoAppliedActionsInReverse([
            { id: 'blocks-1', action_type: 'edit_note_blocks', status: 'pending', proposed_data: {} } as any,
        ]);

        expect(undoEditNoteBlocksAction).not.toHaveBeenCalled();
        expect(undoneIds).toEqual([]);
    });
});
