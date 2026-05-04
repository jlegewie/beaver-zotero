/**
 * Unit tests for diffPreviewCoordinator.ts — handleBannerAction scoping.
 *
 * The banner's "Approve All" / "Reject All" buttons must only act on
 * edit_note approvals for the note currently being previewed, not on
 * approvals for other notes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { atom, createStore } from 'jotai';

// ---------------------------------------------------------------------------
// Hoisted variables — accessible inside vi.mock factories
// ---------------------------------------------------------------------------

const {
    capturedHandlers,
    mockDismissDiffPreview,
    storeRef,
    testPendingApprovalsAtom,
} = vi.hoisted(() => {
    // We need a real Jotai atom for pendingApprovalsAtom that the coordinator
    // will read/write. We create it here so both the mock and the test body
    // can reference the same atom instance.
    //
    // Cannot call `atom()` here (hoisted runs before imports), so we store a
    // reference that gets set after imports.
    return {
        capturedHandlers: {
            bannerAction: null as ((action: string) => void | Promise<void>) | null,
            dismiss: null as (() => void) | null,
            previewNoteKey: null as { libraryId: number; zoteroKey: string } | null,
        },
        mockDismissDiffPreview: vi.fn(),
        storeRef: { current: null as any },
        // Will be set after atom() is available
        testPendingApprovalsAtom: { ref: null as any },
    };
});

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted, so only reference hoisted variables above
// ---------------------------------------------------------------------------

vi.mock('../../../react/utils/noteEditorDiffPreview', () => ({
    showDiffPreview: vi.fn().mockResolvedValue(true),
    dismissDiffPreview: (...args: any[]) => mockDismissDiffPreview(...args),
    isDiffPreviewActive: vi.fn().mockReturnValue(false),
    isDiffPreviewSupported: vi.fn().mockReturnValue(true),
    isNoteInSelectedTab: vi.fn().mockReturnValue(true),
    getPreviewNoteKey: () => capturedHandlers.previewNoteKey,
    setOnBannerAction: (handler: any) => { capturedHandlers.bannerAction = handler; },
    setOnDismiss: (handler: any) => { capturedHandlers.dismiss = handler; },
}));

vi.mock('../../../react/store', () => ({
    get store() { return storeRef.current; },
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// Mock agentActions — provide a real atom for pendingApprovalsAtom so the
// coordinator can store.get / store.set it via the real Jotai store.
vi.mock('../../../react/agents/agentActions', () => ({
    get pendingApprovalsAtom() { return testPendingApprovalsAtom.ref; },
}));

// Mock sendApprovalResponseAtom — a real writable atom that records calls.
// We need it inside the hoisted scope so the mock factory can reference it.
const { approvalResponses, mockSendApprovalAtom } = vi.hoisted(() => {
    const approvalResponses: Array<{ actionId: string; approved: boolean }> = [];
    // Create a minimal writable atom shape that Jotai can call .write on
    const mockSendApprovalAtom = {
        read: () => null,
        write: (_get: any, _set: any, payload: any) => {
            approvalResponses.push(payload);
        },
        init: null,
        toString: () => 'sendApprovalResponseAtom',
    };
    return { approvalResponses, mockSendApprovalAtom };
});

vi.mock('../../../react/atoms/agentRunAtoms', () => ({
    sendApprovalResponseAtom: mockSendApprovalAtom,
}));

// ---------------------------------------------------------------------------
// Import under test (triggers module-level setOnBannerAction registration)
// ---------------------------------------------------------------------------

import { diffPreviewNoteKeyAtom } from '../../../react/utils/diffPreviewCoordinator';

// Now create the real atom and assign it
const pendingApprovalsAtom = atom<Map<string, any>>(new Map());
testPendingApprovalsAtom.ref = pendingApprovalsAtom;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingApproval(overrides: {
    actionId: string;
    actionType?: string;
    library_id?: number;
    zotero_key?: string;
}) {
    return {
        actionId: overrides.actionId,
        toolcallId: `tc-${overrides.actionId}`,
        actionType: overrides.actionType ?? 'edit_note',
        actionData: {
            library_id: overrides.library_id ?? 1,
            zotero_key: overrides.zotero_key ?? 'AAAA1111',
            old_string: 'old',
            new_string: 'new',
        },
    };
}

function seedApprovals(...approvals: ReturnType<typeof makePendingApproval>[]) {
    const map = new Map<string, any>();
    for (const pa of approvals) {
        map.set(pa.actionId, pa);
    }
    storeRef.current.set(pendingApprovalsAtom, map);
}

/** Get all approval responses recorded by the mock sendApprovalResponseAtom. */
function getApprovalResponses(): Array<{ actionId: string; approved: boolean }> {
    return [...approvalResponses];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diffPreviewCoordinator — handleBannerAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeRef.current = createStore();
        capturedHandlers.previewNoteKey = null;
        approvalResponses.length = 0;
    });

    it('registers a banner action handler on module load', () => {
        expect(capturedHandlers.bannerAction).toBeTypeOf('function');
    });

    it('registers a dismiss handler on module load', () => {
        expect(capturedHandlers.dismiss).toBeTypeOf('function');
    });

    it('ignores unknown actions', () => {
        seedApprovals(makePendingApproval({ actionId: 'a1' }));
        capturedHandlers.bannerAction!('unknownAction');

        expect(getApprovalResponses()).toHaveLength(0);
        expect(storeRef.current.get(pendingApprovalsAtom).size).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Core scoping tests (the fix under review)
    // -----------------------------------------------------------------------

    describe('scopes to previewed note', () => {
        it('approveAll only approves edits for the previewed note', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'b1', library_id: 1, zotero_key: 'NOTE_B' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            const responses = getApprovalResponses();
            expect(responses).toEqual([
                { actionId: 'a1', approved: true },
            ]);

            const remaining = storeRef.current.get(pendingApprovalsAtom);
            expect(remaining.has('a1')).toBe(false);
            expect(remaining.has('b1')).toBe(true);
        });

        it('rejectAll only rejects edits for the previewed note', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'a2', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'b1', library_id: 1, zotero_key: 'NOTE_B' }),
            );
            await capturedHandlers.bannerAction!('rejectAll');

            const responses = getApprovalResponses();
            expect(responses).toEqual([
                { actionId: 'a1', approved: false },
                { actionId: 'a2', approved: false },
            ]);

            const remaining = storeRef.current.get(pendingApprovalsAtom);
            expect(remaining.has('a1')).toBe(false);
            expect(remaining.has('a2')).toBe(false);
            expect(remaining.has('b1')).toBe(true);
        });

        it('scopes correctly across different libraries', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 2, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'lib1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'lib2', library_id: 2, zotero_key: 'NOTE_A' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            const responses = getApprovalResponses();
            expect(responses).toEqual([
                { actionId: 'lib2', approved: true },
            ]);

            const remaining = storeRef.current.get(pendingApprovalsAtom);
            expect(remaining.has('lib1')).toBe(true);
            expect(remaining.has('lib2')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Fallback when no preview key is available
    // -----------------------------------------------------------------------

    describe('fallback when previewKey is null', () => {
        it('approves ALL edit_note approvals when no note is previewed', async () => {
            capturedHandlers.previewNoteKey = null;

            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'b1', library_id: 1, zotero_key: 'NOTE_B' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            const responses = getApprovalResponses();
            expect(responses).toHaveLength(2);
            expect(responses).toEqual([
                { actionId: 'a1', approved: true },
                { actionId: 'b1', approved: true },
            ]);

            expect(storeRef.current.get(pendingApprovalsAtom).size).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Non-edit_note actions are never touched
    // -----------------------------------------------------------------------

    describe('ignores non-edit_note action types', () => {
        it('does not approve/reject edit_metadata approvals', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'e1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({
                    actionId: 'm1',
                    actionType: 'edit_metadata',
                    library_id: 1,
                    zotero_key: 'NOTE_A',
                }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            const responses = getApprovalResponses();
            expect(responses).toEqual([
                { actionId: 'e1', approved: true },
            ]);

            const remaining = storeRef.current.get(pendingApprovalsAtom);
            expect(remaining.has('m1')).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Dismiss and atom clearing
    // -----------------------------------------------------------------------

    describe('dismissal side effects', () => {
        it('calls dismissDiffPreview and clears diffPreviewNoteKeyAtom', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };
            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 1, zotero_key: 'NOTE_A' }),
            );

            storeRef.current.set(diffPreviewNoteKeyAtom, '1-NOTE_A');
            await capturedHandlers.bannerAction!('approveAll');

            expect(mockDismissDiffPreview).toHaveBeenCalledOnce();
            expect(storeRef.current.get(diffPreviewNoteKeyAtom)).toBeNull();
        });

        it('captures preview key before dismiss clears it', async () => {
            // Simulate dismiss clearing the preview key (as real code does)
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };
            mockDismissDiffPreview.mockImplementation(() => {
                capturedHandlers.previewNoteKey = null;
            });

            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'b1', library_id: 1, zotero_key: 'NOTE_B' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            // Should still scope to NOTE_A despite dismiss clearing the key
            const responses = getApprovalResponses();
            expect(responses).toEqual([
                { actionId: 'a1', approved: true },
            ]);
        });
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    describe('edge cases', () => {
        it('handles empty pending approvals gracefully', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };
            seedApprovals();

            await capturedHandlers.bannerAction!('approveAll');

            expect(getApprovalResponses()).toHaveLength(0);
            expect(mockDismissDiffPreview).toHaveBeenCalledOnce();
        });

        it('handles all approvals being for other notes', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'b1', library_id: 1, zotero_key: 'NOTE_B' }),
                makePendingApproval({ actionId: 'c1', library_id: 1, zotero_key: 'NOTE_C' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            expect(getApprovalResponses()).toHaveLength(0);
            expect(storeRef.current.get(pendingApprovalsAtom).size).toBe(2);
        });

        it('handles multiple edits for the same previewed note', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 1, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'a2', library_id: 1, zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'a3', library_id: 1, zotero_key: 'NOTE_A' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            const responses = getApprovalResponses();
            expect(responses).toHaveLength(3);
            expect(responses.every(r => r.approved === true)).toBe(true);
            expect(storeRef.current.get(pendingApprovalsAtom).size).toBe(0);
        });
    });
});
