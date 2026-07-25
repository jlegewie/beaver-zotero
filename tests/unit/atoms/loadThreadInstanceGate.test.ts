import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module mocks — react/atoms/threads drags in the WS layer, citations, and
// supabase-backed services; stub everything loadThreadAtom touches.
// =============================================================================

const getThreadRunsMock = vi.fn();
vi.mock('../../../src/services/agentService', () => ({
    agentRunService: { getThreadRuns: (...args: unknown[]) => getThreadRunsMock(...args) },
    agentService: { cancel: vi.fn() },
}));

const getThreadMock = vi.fn();
vi.mock('../../../src/services/threadService', () => ({
    threadService: { getThread: (...args: unknown[]) => getThreadMock(...args) },
}));

const currentZoteroInstanceRefMock = vi.fn();
vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    currentZoteroInstanceRef: (...args: unknown[]) => currentZoteroInstanceRefMock(...args),
}));

const getPrefMock = vi.fn();
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (...args: unknown[]) => getPrefMock(...args),
}));

const confirmMock = vi.fn();
vi.mock('../../../react/host', () => ({
    getHost: () => ({ dialogs: { confirm: confirmMock } }),
}));

vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    const currentMessageContentAtom = atom('');
    const currentMessagePillsAtom = atom<unknown[]>([]);
    const composerResetTokenAtom = atom(0);
    return {
        currentMessageItemsAtom: atom<unknown[]>([]),
        currentMessageContentAtom,
        currentMessagePillsAtom,
        composerResetTokenAtom,
        clearComposerAtom: atom(null, (get, set) => {
            set(currentMessageContentAtom, '');
            set(currentMessagePillsAtom, []);
            set(composerResetTokenAtom, get(composerResetTokenAtom) + 1);
        }),
        currentMessageCollectionsAtom: atom<unknown[]>([]),
        currentMessageExternalFilesAtom: atom<unknown[]>([]),
        updateMessageItemsFromZoteroSelectionAtom: atom(null, () => {}),
        updateReaderAttachmentAtom: atom(null, () => {}),
    };
});

vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return {
        isLibraryTabAtom: atom(true),
        isWebSearchEnabledAtom: atom(false),
        removePopupMessagesByTypeAtom: atom(null, () => {}),
        userScrolledAtom: atom(false),
        windowUserScrolledAtom: atom(false),
    };
});

vi.mock('../../../react/atoms/citations', async () => {
    const { atom } = await import('jotai');
    return {
        citationsAtom: atom<unknown[]>([]),
        citationMapAtom: atom(new Map()),
        processCitationsAtom: atom(null, () => {}),
        resetCitationMarkersAtom: atom(null, () => {}),
        mergePageLabelsByAttachmentIdAtom: atom(null, () => {}),
    };
});

vi.mock('../../../react/utils/pageLabels', () => ({
    preloadPageLabelsForCitations: vi.fn(async () => new Map()),
}));

vi.mock('../../../react/atoms/messageUIState', async () => {
    const { atom } = await import('jotai');
    return { resetMessageUIStateAtom: atom(null, () => {}) };
});

vi.mock('../../../react/atoms/externalReferences', async () => {
    const { atom } = await import('jotai');
    return {
        checkExternalReferencesAtom: atom(null, () => {}),
        clearExternalReferenceCacheAtom: atom(null, () => {}),
        addExternalReferencesToMappingAtom: atom(null, () => {}),
    };
});

vi.mock('../../../react/agents/atoms', async () => {
    const { atom } = await import('jotai');
    return {
        threadRunsAtom: atom<unknown[]>([]),
        activeRunAtom: atom<unknown | null>(null),
    };
});

vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return {
        isWSChatPendingAtom: atom(false),
        isWSConnectedAtom: atom(false),
        isWSReadyAtom: atom(false),
    };
});

const validateAppliedAgentActionMock = vi.fn(async () => 'valid' as const);
const undoAgentActionWriteMock = vi.fn();
vi.mock('../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return {
        threadAgentActionsAtom: atom<unknown[]>([]),
        isCreateItemAgentAction: vi.fn(() => false),
        validateAppliedAgentAction: (...args: unknown[]) => validateAppliedAgentActionMock(...args),
        undoAgentActionAtom: atom(null, (_get: unknown, _set: unknown, actionId: string) => {
            undoAgentActionWriteMock(actionId);
        }),
        clearAllPendingApprovalsAtom: atom(null, () => {}),
    };
});

vi.mock('../../../react/agents/pendingQuestions', async () => {
    const { atom } = await import('jotai');
    return { clearAllPendingQuestionsAtom: atom(null, () => {}) };
});

vi.mock('../../../react/agents/toolResultProcessing', () => ({
    processToolReturnResults: vi.fn(async () => {}),
}));

vi.mock('../../../react/compat/legacyToolResults', () => ({
    upgradeToolReturn: vi.fn(),
}));

vi.mock('../../../react/utils/agentActionUtils', () => ({
    loadItemDataForAgentActions: vi.fn(async () => {}),
}));

vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn(async () => {}) },
}));

vi.mock('../../../react/types/attachments/converters', () => ({
    enrichMessageAttachmentStub: vi.fn(),
}));

vi.mock('../../../react/types/attachments/apiTypes', () => ({
    zoteroReferenceKey: vi.fn(() => 'key'),
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference: vi.fn(async () => ({ status: 'not_found' })),
}));

import {
    loadThreadAtom,
    currentThreadIdAtom,
    isLoadingThreadAtom,
    pendingScrollToRunAtom,
} from '../../../react/atoms/threads';
import { ApiError } from '../../../react/types/apiErrors';

const CURRENT = { zoteroUserId: '111', zoteroLocalId: 'CURKEY' };
const FOREIGN = { zoteroUserId: '999', zoteroLocalId: 'FOREIGNKEY' };

// The confirmed-thread set is module-level; use a fresh thread id per test.
let threadSeq = 0;
const nextThreadId = () => `thread-${++threadSeq}`;

describe('loadThreadAtom instance-mismatch gate', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        vi.clearAllMocks();
        store = createStore();
        getPrefMock.mockReturnValue(true); // statefulChat
        currentZoteroInstanceRefMock.mockReturnValue(CURRENT);
        confirmMock.mockReturnValue(true);
        getThreadRunsMock.mockResolvedValue({ runs: [], agent_actions: [] });
    });

    it('cancel on the mismatch confirm aborts with false and mutates nothing', async () => {
        confirmMock.mockReturnValue(false);
        const threadId = nextThreadId();
        store.set(pendingScrollToRunAtom, 'run-1');

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Foreign', threadIdentity: FOREIGN,
        });

        expect(loaded).toBe(false);
        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(getThreadRunsMock).not.toHaveBeenCalled();
        expect(store.get(currentThreadIdAtom)).toBeNull();
        expect(store.get(pendingScrollToRunAtom)).toBeNull();
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });

    it('confirming loads the thread and never re-prompts in the same session', async () => {
        const threadId = nextThreadId();

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Foreign', threadIdentity: FOREIGN,
        });

        expect(loaded).toBe(true);
        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(store.get(currentThreadIdAtom)).toBe(threadId);

        const reloaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Foreign', threadIdentity: FOREIGN,
        });
        expect(reloaded).toBe(true);
        expect(confirmMock).toHaveBeenCalledTimes(1);
    });

    it('does not auto-undo applied actions when opening a mismatched thread', async () => {
        const threadId = nextThreadId();
        validateAppliedAgentActionMock.mockResolvedValue('invalid');
        getThreadRunsMock.mockResolvedValue({
            runs: [{
                id: 'run-1',
                status: 'completed',
                completed_at: '2024-01-01T00:00:00Z',
                user_prompt: { attachments: [] },
                model_messages: [],
                metadata: {},
            }],
            agent_actions: [{ id: 'action-1', status: 'applied' }],
        });

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Foreign', threadIdentity: FOREIGN,
        });

        expect(loaded).toBe(true);
        expect(validateAppliedAgentActionMock).not.toHaveBeenCalled();
        expect(undoAgentActionWriteMock).not.toHaveBeenCalled();
    });

    it('still auto-undos invalid applied actions on a matching-instance thread', async () => {
        const threadId = nextThreadId();
        validateAppliedAgentActionMock.mockResolvedValue('invalid');
        getThreadRunsMock.mockResolvedValue({
            runs: [{
                id: 'run-1',
                status: 'completed',
                completed_at: '2024-01-01T00:00:00Z',
                user_prompt: { attachments: [] },
                model_messages: [],
                metadata: {},
            }],
            agent_actions: [{ id: 'action-1', status: 'applied' }],
        });

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Mine', threadIdentity: CURRENT,
        });

        expect(loaded).toBe(true);
        expect(validateAppliedAgentActionMock).toHaveBeenCalled();
        expect(undoAgentActionWriteMock).toHaveBeenCalledWith('action-1');
    });

    it('matching and unattributed identities load without a confirm', async () => {
        const loadedMatching = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId: nextThreadId(), threadName: 'Mine', threadIdentity: CURRENT,
        });
        const loadedUnattributed = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId: nextThreadId(), threadName: 'Unattributed',
            threadIdentity: { zoteroUserId: null, zoteroLocalId: null },
        });

        expect(loadedMatching).toBe(true);
        expect(loadedUnattributed).toBe(true);
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('skipInstanceMismatchConfirm bypasses the prompt for headless drivers', async () => {
        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId: nextThreadId(), threadName: 'Foreign',
            threadIdentity: FOREIGN, skipInstanceMismatchConfirm: true,
        });

        expect(loaded).toBe(true);
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('fetches identity (and name) when the caller has none, then gates on it', async () => {
        const threadId = nextThreadId();
        getThreadMock.mockResolvedValue({
            id: threadId, name: 'Fetched name',
            zotero_user_id: FOREIGN.zoteroUserId, zotero_local_id: FOREIGN.zoteroLocalId,
        });
        confirmMock.mockReturnValue(false);

        const loaded = await store.set(loadThreadAtom, { user_id: 'u1', threadId });

        expect(getThreadMock).toHaveBeenCalledWith(threadId);
        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(loaded).toBe(false);
        expect(getThreadRunsMock).not.toHaveBeenCalled();
    });

    it('an identity-fetch failure aborts with false instead of degrading to matching', async () => {
        const threadId = nextThreadId();
        getThreadMock.mockRejectedValue(new Error('network down'));

        const loaded = await store.set(loadThreadAtom, { user_id: 'u1', threadId });

        expect(loaded).toBe(false);
        expect(getThreadRunsMock).not.toHaveBeenCalled();
        expect(store.get(currentThreadIdAtom)).toBeNull();
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });

    it('canceling the active-run interrupt clears a pending deep-link target', async () => {
        const { isWSChatPendingAtom } = await import('../../../react/atoms/agentRunAtoms');
        store.set(isWSChatPendingAtom as any, true);
        store.set(pendingScrollToRunAtom, 'run-9');
        confirmMock.mockReturnValue(false);

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId: nextThreadId(), threadName: 'Busy', threadIdentity: CURRENT,
        });

        expect(loaded).toBe(false);
        expect(store.get(pendingScrollToRunAtom)).toBeNull();
        expect(getThreadRunsMock).not.toHaveBeenCalled();
    });

    it('a 404 while loading runs returns false and resets to the empty state', async () => {
        const threadId = nextThreadId();
        getThreadRunsMock.mockRejectedValue(new ApiError(404, 'Not Found'));

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Gone', threadIdentity: CURRENT,
        });

        expect(loaded).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBeNull();
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });
});
