import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/agents/agentActions', () => ({
    agentActionsForRunsAtom: () => ({}),
    pendingApprovalsAtom: {},
    threadAgentActionsAtom: { label: 'threadAgentActions' },
}));
vi.mock('../../../src/utils/libraryIdentity', () => {
    // This device: the user library is 1, group 5 is library 3, group 7 is library 2.
    const groups: Record<string, number> = { u: 1, g5: 3, g7: 2 };
    return {
        parseLibraryRef: (ref: string) => (/^(u|g\d+)$/.test(ref) ? { ref } : null),
        resolveLibraryRef: (ref: { library_ref?: string; library_id?: number }) => {
            if (ref.library_ref && /^(u|g\d+)$/.test(ref.library_ref)) return groups[ref.library_ref] ?? null;
            return ref.library_id ?? null;
        },
        libraryRefForLibraryID: (id: number) => Object.keys(groups).find((ref) => groups[ref] === id) ?? null,
    };
});

import { completeNoteIdentity, countPendingNoteEdits } from '../../../react/host/zotero/components/reviewChanges/useRunActionRows';
import { buildEditedNoteArtifacts } from '../../../react/host/zotero/components/reviewChangeRows';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

let idCounter = 0;
const edit = (overrides: Partial<AgentAction> & { proposed_data?: Record<string, unknown> } = {}): AgentAction => ({
    id: `action-${++idCounter}`,
    run_id: 'run-1',
    toolcall_id: `call-${idCounter}`,
    action_type: 'edit_note',
    status: 'applied',
    proposed_data: { library_ref: 'u', library_id: 1, zotero_key: 'NOTE0001', new_string: 'x' },
    ...overrides,
} as AgentAction);

describe('completeNoteIdentity', () => {
    it('re-resolves the local library id from the portable ref', () => {
        // Recorded on another device, where group 5 was library 2.
        expect(completeNoteIdentity({ library_ref: 'g5', library_id: 2, zotero_key: 'NOTE0001' }))
            .toEqual({ library_ref: 'g5', library_id: 3, zotero_key: 'NOTE0001' });
    });

    it('drops a stored library id when the ref names a library this device does not have', () => {
        expect(completeNoteIdentity({ library_ref: 'g9', library_id: 2, zotero_key: 'NOTE0001' }))
            .toEqual({ library_ref: 'g9', zotero_key: 'NOTE0001' });
    });

    it('gives a target with only a local library id the ref of that library', () => {
        expect(completeNoteIdentity({ library_id: 3, zotero_key: 'NOTE0001' }))
            .toEqual({ library_ref: 'g5', library_id: 3, zotero_key: 'NOTE0001' });
    });

    it('keeps notes in different groups apart when a stale id would join them', () => {
        const artifacts = buildEditedNoteArtifacts([[
            // Recorded elsewhere: there, group 5 was library 2, which is group 7 here.
            edit({ proposed_data: { library_ref: 'g5', library_id: 2, zotero_key: 'NOTE0001' } }),
            edit({ proposed_data: { library_ref: 'g7', library_id: 2, zotero_key: 'NOTE0001' } }),
        ]], { completeNoteIdentity });

        expect(artifacts.map((artifact) => artifact.note)).toEqual([
            { library_ref: 'g5', library_id: 3, zotero_key: 'NOTE0001' },
            { library_ref: 'g7', library_id: 2, zotero_key: 'NOTE0001' },
        ]);
    });
});

describe('countPendingNoteEdits', () => {
    it('counts unapplied edits to the note across the whole thread, live approvals included', () => {
        const actions = [
            edit({ run_id: 'run-1' }),
            edit({ run_id: 'run-2', status: 'pending' }),
            edit({ run_id: 'run-3', status: 'pending', proposed_data: { library_id: 1, zotero_key: 'NOTE0001' } }),
            edit({ run_id: 'run-3', status: 'pending', proposed_data: { library_ref: 'u', zotero_key: 'OTHER001' } }),
        ];
        const store = { get: vi.fn(() => actions) } as any;

        expect(countPendingNoteEdits(store, { library_ref: 'u', zotero_key: 'NOTE0001' })).toBe(2);
    });
});
