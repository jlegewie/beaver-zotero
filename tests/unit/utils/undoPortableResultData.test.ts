import { installMutationInstance } from '../../helpers/mutationInstance';
/**
 * Undo works on an applied action the backend named only by `library_ref`.
 *
 * `toAgentAction` normalizes an absent `library_id` to `UNRESOLVED_LIBRARY_ID`,
 * so a portably-named applied action reaches undo carrying `library_id: 0`.
 * `hasAppliedZoteroItem` now admits those into the undo list, so the undo
 * handlers must accept them too — a guard on the rowid alone turns what used to
 * be a silently-skipped note into a failed undo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

const mocks = vi.hoisted(() => ({
    cancelTasksForItem: vi.fn(),
}));
vi.mock('../../../react/utils/backgroundTaskCancellation', () => ({
    cancelTasksForItem: mocks.cancelTasksForItem,
}));

import { undoCreateNoteAction } from '../../../react/utils/createNoteActions';

// Group 50 lives at local rowid 5 on this device.
const eraseTx = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    eraseTx.mockResolvedValue(undefined);
    const zotero = (globalThis as any).Zotero;
    zotero.Libraries = { ...zotero.Libraries, userLibraryID: 1 };
    zotero.Groups = {
        ...zotero.Groups,
        getLibraryIDFromGroupID: vi.fn((groupID: number) => (groupID === 50 ? 5 : false)),
        getGroupIDFromLibraryID: vi.fn((libraryID: number) => (libraryID === 5 ? 50 : false)),
    };
    zotero.Items = {
        ...zotero.Items,
        getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
            libraryID === 5 && key === 'AAAAAAA1' ? { eraseTx } : null),
    };
});

function appliedNote(result_data: Record<string, unknown>) {
    return {
        id: 'action-1',
        run_id: 'run-1',
        action_type: 'create_note',
        status: 'applied',
        proposed_data: {},
        result_data,
    } as any;
}

describe('undoCreateNoteAction with portable-only result data', () => {
    it('deletes the note when the result carries the unresolved sentinel', async () => {
        await undoCreateNoteAction(appliedNote({
            library_id: 0,
            library_ref: 'g50',
            zotero_key: 'AAAAAAA1',
        }));

        expect(Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(5, 'AAAAAAA1');
        expect(eraseTx).toHaveBeenCalledTimes(1);
    });

    it('deletes it when the result carries no numeric library_id at all', async () => {
        await undoCreateNoteAction(appliedNote({
            library_ref: 'g50',
            zotero_key: 'AAAAAAA1',
        }));

        expect(eraseTx).toHaveBeenCalledTimes(1);
    });

    it('still deletes a legacy note named by rowid alone', async () => {
        await undoCreateNoteAction(appliedNote({ library_id: 5, zotero_key: 'AAAAAAA1' }));

        expect(eraseTx).toHaveBeenCalledTimes(1);
    });

    it('returns quietly when the library is not on this device', async () => {
        await undoCreateNoteAction(appliedNote({
            library_id: 0,
            library_ref: 'g999999',
            zotero_key: 'AAAAAAA1',
        }));

        expect(eraseTx).not.toHaveBeenCalled();
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('still refuses a result that names no library at all', async () => {
        await expect(undoCreateNoteAction(appliedNote({
            library_id: 0,
            zotero_key: 'AAAAAAA1',
        }))).rejects.toThrow('Cannot undo');
        expect(eraseTx).not.toHaveBeenCalled();
    });
});

beforeEach(installMutationInstance);
