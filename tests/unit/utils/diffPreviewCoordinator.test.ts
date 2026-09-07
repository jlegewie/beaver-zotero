/**
 * Unit tests for diffPreviewCoordinator.ts — handleBannerAction scoping.
 *
 * The banner's "Approve All" / "Reject All" buttons must only act on
 * edit_note approvals for the note currently being previewed, not on
 * approvals for other notes.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { atom, createStore } from 'jotai';

// ---------------------------------------------------------------------------
// Hoisted variables — accessible inside vi.mock factories
// ---------------------------------------------------------------------------

const {
    capturedHandlers,
    mockDismissDiffPreview,
    mockShowDiffPreview,
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
        mockShowDiffPreview: vi.fn().mockResolvedValue(true),
        storeRef: { current: null as any },
        // Will be set after atom() is available
        testPendingApprovalsAtom: { ref: null as any },
    };
});

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted, so only reference hoisted variables above
// ---------------------------------------------------------------------------

vi.mock('../../../react/utils/noteEditorDiffPreview', () => ({
    showDiffPreview: (...args: any[]) => mockShowDiffPreview(...args),
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

vi.mock('@beaver/agent-core/platform/logger', () => ({
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
import { noteLibraryIdFromActionData, updateDiffPreviewForNote } from '../../../react/utils/diffPreviewCoordinator';

// Now create the real atom and assign it
const pendingApprovalsAtom = atom<Map<string, any>>(new Map());
testPendingApprovalsAtom.ref = pendingApprovalsAtom;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingApproval(overrides: {
    actionId: string;
    actionType?: string;
    library_id?: number | null;
    library_ref?: string;
    zotero_key?: string;
    old_string?: string;
    new_string?: string;
    operation?: string;
    edits?: any[];
}) {
    return {
        actionId: overrides.actionId,
        toolcallId: `tc-${overrides.actionId}`,
        actionType: overrides.actionType ?? 'edit_note',
        actionData: {
            // `null` opts out entirely, for the portable-only shape the backend
            // sends once it stops pinning device-local rowids.
            ...(overrides.library_id === null ? {} : { library_id: overrides.library_id ?? 1 }),
            ...(overrides.library_ref ? { library_ref: overrides.library_ref } : {}),
            zotero_key: overrides.zotero_key ?? 'AAAA1111',
            old_string: overrides.old_string ?? 'old',
            new_string: overrides.new_string ?? 'new',
            operation: overrides.operation,
            ...(overrides.edits !== undefined ? { edits: overrides.edits } : {}),
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

    it('includes pending append approvals in automatic diff preview edits', async () => {
        seedApprovals(makePendingApproval({
            actionId: 'append-1',
            old_string: '',
            new_string: '<p>Appended</p>',
            operation: 'append',
        }));

        updateDiffPreviewForNote(1, 'AAAA1111');
        await Promise.resolve();

        expect(mockShowDiffPreview).toHaveBeenCalledWith(1, 'AAAA1111', [
            { oldString: '', newString: '<p>Appended</p>', operation: 'append' },
        ]);
    });

    it('preserves disambiguation anchors for automatic batch previews', async () => {
        seedApprovals(makePendingApproval({
            actionId: 'batch-1',
            actionType: 'edit_note_batch',
            edits: [{
                index: 0,
                old_string: 'Repeated text',
                new_string: 'Targeted replacement',
                target_before_context: '<p>first occurrence</p><p>',
                target_after_context: '</p></div>',
            }],
        }));

        updateDiffPreviewForNote(1, 'AAAA1111');
        await Promise.resolve();

        expect(mockShowDiffPreview).toHaveBeenCalledWith(1, 'AAAA1111', [{
            oldString: 'Repeated text',
            newString: 'Targeted replacement',
            operation: 'str_replace',
            targetBeforeContext: '<p>first occurrence</p><p>',
            targetAfterContext: '</p></div>',
        }]);
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

    // An edit_note approval names its note by portable `library_ref`; the numeric
    // `library_id` is absent or the unresolved sentinel once the backend stops
    // pinning rowids. Everything below the coordinator's API works in rowids, so
    // the ref has to be resolved before any note key is built. Group 555 is the
    // local library 100 on this device.
    describe('portable library identity', () => {
        let previousGroups: any;

        beforeEach(() => {
            previousGroups = (globalThis as any).Zotero.Groups;
            (globalThis as any).Zotero.Groups = {
                getLibraryIDFromGroupID: (groupID: number) => (groupID === 555 ? 100 : false),
                getGroupIDFromLibraryID: (libraryID: number) => (libraryID === 100 ? 555 : false),
            };
        });

        afterEach(() => {
            (globalThis as any).Zotero.Groups = previousGroups;
        });

        it('shows the preview for an approval that carries only a library_ref', () => {
            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: null, library_ref: 'g555', zotero_key: 'NOTE_A' }),
            );

            updateDiffPreviewForNote(100, 'NOTE_A');

            expect(mockShowDiffPreview).toHaveBeenCalledWith(100, 'NOTE_A', expect.any(Array));
        });

        it('shows the preview when library_id is the unresolved sentinel', () => {
            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 0, library_ref: 'g555', zotero_key: 'NOTE_A' }),
            );

            updateDiffPreviewForNote(100, 'NOTE_A');

            expect(mockShowDiffPreview).toHaveBeenCalledWith(100, 'NOTE_A', expect.any(Array));
        });

        it('does not confuse two libraries that both arrive with the sentinel', () => {
            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: 0, library_ref: 'g555', zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'b1', library_id: 0, library_ref: 'u', zotero_key: 'NOTE_A' }),
            );

            updateDiffPreviewForNote(100, 'NOTE_A');

            // Only the group-library edit belongs to this preview.
            expect(mockShowDiffPreview).toHaveBeenCalledTimes(1);
            const [, , edits] = mockShowDiffPreview.mock.calls[0];
            expect(edits).toHaveLength(1);
        });

        // The helper `agentActions.ts` calls at both approval entry points, so a
        // regression there is caught here rather than only through the UI.
        describe('noteLibraryIdFromActionData', () => {
            it('resolves a portable ref, with or without the sentinel', () => {
                expect(noteLibraryIdFromActionData({ library_ref: 'g555' })).toBe(100);
                expect(noteLibraryIdFromActionData({ library_ref: 'g555', library_id: 0 })).toBe(100);
            });

            it('lets library_ref win over a disagreeing numeric library_id', () => {
                expect(noteLibraryIdFromActionData({ library_ref: 'g555', library_id: 7 })).toBe(100);
            });

            it('keeps reading a legacy numeric library_id when no ref is present', () => {
                expect(noteLibraryIdFromActionData({ library_id: 7 })).toBe(7);
            });

            it('returns null when nothing names a library this device has', () => {
                expect(noteLibraryIdFromActionData({ library_ref: 'g999999' })).toBeNull();
                expect(noteLibraryIdFromActionData({ library_id: 0 })).toBeNull();
                expect(noteLibraryIdFromActionData({})).toBeNull();
                expect(noteLibraryIdFromActionData(undefined)).toBeNull();
            });
        });

        it('scopes the banner to the previewed note when approvals name it portably', async () => {
            capturedHandlers.previewNoteKey = { libraryId: 100, zoteroKey: 'NOTE_A' };

            seedApprovals(
                makePendingApproval({ actionId: 'a1', library_id: null, library_ref: 'g555', zotero_key: 'NOTE_A' }),
                makePendingApproval({ actionId: 'b1', library_id: null, library_ref: 'g555', zotero_key: 'NOTE_B' }),
            );
            await capturedHandlers.bannerAction!('approveAll');

            expect(getApprovalResponses()).toEqual([{ actionId: 'a1', approved: true }]);
            expect(storeRef.current.get(pendingApprovalsAtom).size).toBe(1);
        });
    });
});
