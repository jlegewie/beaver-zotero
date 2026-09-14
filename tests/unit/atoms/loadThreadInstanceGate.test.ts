import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createThreadStore as createStore } from '../../helpers/threadRepository';

// =============================================================================
// Module mocks — react/atoms/threads drags in the WS layer, citations, and
// supabase-backed services; stub everything loadThreadAtom touches.
// =============================================================================

const getThreadRunsMock = vi.fn();
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentRunService: { getThreadRuns: (...args: unknown[]) => getThreadRunsMock(...args) },
    agentService: { cancel: vi.fn() },
}));

const getThreadMock = vi.fn();
vi.mock('@beaver/agent-core/transport/threadService', () => ({
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
vi.mock('@beaver/agent-ui/host', () => ({
    getHost: () => ({ dialogs: { confirm: confirmMock } }),
}));

vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    const currentMessageContentAtom = atom('');
    const currentMessagePillsAtom = atom<unknown[]>([]);
    const composerResetTokenAtom = atom(0);
    return {
        readerActionContextAtom: atom(null),
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
        isAtBottomAtom: atom(true),
        windowIsAtBottomAtom: atom(true),
    };
});

vi.mock('@beaver/agent-core/citations/atoms', async () => {
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

// The Zotero-only citation onboarding tip; stubbing it keeps the popup/prefs
// chain out of the thread atoms' import graph.
vi.mock('../../../react/atoms/citationTip', async () => {
    const { atom } = await import('jotai');
    return { maybeShowCitationTipAtom: atom(null, () => {}) };
});

// Partial mock: the module only pulls in jotai, so keep every atom real and stub
// just the reset. A hand-written export list would silently resolve any atom
// added later to `undefined`, and loadThreadAtom writes to several of them.
vi.mock('../../../react/atoms/messageUIState', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../react/atoms/messageUIState')>();
    const { atom } = await import('jotai');
    return { ...actual, resetMessageUIStateAtom: atom(null, () => {}) };
});

vi.mock('../../../react/atoms/externalReferences', async () => {
    const { atom } = await import('jotai');
    return {
        checkExternalReferencesAtom: atom(null, () => {}),
    };
});

vi.mock('@beaver/agent-core/citations/externalReferences', async () => {
    const { atom } = await import('jotai');
    return {
        clearExternalReferenceCacheAtom: atom(null, () => {}),
        addExternalReferencesToMappingAtom: atom(null, () => {}),
    };
});

vi.mock('@beaver/agent-core/run-state/atoms', async () => {
    const { atom } = await import('jotai');
    return {
        threadRunsAtom: atom<unknown[]>([]),
        activeRunAtom: atom<unknown | null>(null),
        // threads.ts re-exports these three from the run state, so the stub must
        // provide them
        currentThreadIdAtom: atom<string | null>(null),
        currentThreadNameAtom: atom<string | null>(null),
        isLoadingThreadAtom: atom<boolean>(false),
        resetRunSelectorCaches: () => {},
    };
});

vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return {
        abandonActiveRunLocallyAtom: atom(null, () => {}),
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

vi.mock('@beaver/agent-core/run-state/pendingQuestions', async () => {
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

vi.mock('@beaver/agent-core/types/attachments/apiTypes', () => ({
    zoteroReferenceKey: vi.fn(() => 'key'),
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference: vi.fn(async () => ({ status: 'not_found' })),
}));

import {
    loadThreadAtom,
    newThreadAtom,
    threadNavigationSeqAtom,
    currentThreadIdAtom,
    isLoadingThreadAtom,
    pendingScrollToRunAtom,
} from '../../../react/atoms/threads';
import { currentMessageContentAtom, readerActionContextAtom } from '../../../react/atoms/messageComposition';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { ApiError } from '@beaver/agent-core/types/apiErrors';

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
        store.set(threadNavigationSeqAtom, 7);

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Foreign', threadIdentity: FOREIGN,
        });

        expect(loaded).toBe(false);
        expect(store.get(threadNavigationSeqAtom)).toBe(7);
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

    it('a 404 while loading runs returns false, resets to the empty state, and marks the thread deleted', async () => {
        const threadId = nextThreadId();
        getThreadRunsMock.mockRejectedValue(new ApiError(404, 'Not Found'));

        const loaded = await store.set(loadThreadAtom, {
            user_id: 'u1', threadId, threadName: 'Gone', threadIdentity: CURRENT,
        });

        expect(loaded).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBeNull();
        expect(store.get(isLoadingThreadAtom)).toBe(false);
        expect(Zotero.Beaver.presence.getSnapshot().deleted).toEqual([threadId]);
    });

    it('a 404 on the identity fetch marks the thread deleted for the instance instead of leaving it stale', async () => {
        const threadId = nextThreadId();
        // Realtime cannot be relied on to have delivered the deletion, so the
        // failed refresh is the instance's first sign the chat is gone.
        getThreadMock.mockRejectedValue(new ApiError(404, 'Not Found'));

        const loaded = await store.set(loadThreadAtom, { user_id: 'u1', threadId });

        expect(loaded).toBe(false);
        expect(getThreadRunsMock).not.toHaveBeenCalled();
        expect(Zotero.Beaver.presence.getSnapshot().deleted).toEqual([threadId]);
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });

    it('a non-404 identity-fetch failure does not mark the thread deleted', async () => {
        const threadId = nextThreadId();
        getThreadMock.mockRejectedValue(new ApiError(500, 'Server Error'));

        expect(await store.set(loadThreadAtom, { user_id: 'u1', threadId })).toBe(false);
        expect(Zotero.Beaver.presence.getSnapshot().deleted).toEqual([]);
    });
    it.each(['identity', 'runs'])('does not let a stale %s response overwrite a new reader-action draft', async (phase) => {
        let finish!: (value: any) => void;
        const deferred = new Promise(resolve => { finish = resolve; });
        if (phase === 'identity') getThreadMock.mockReturnValueOnce(deferred);
        else getThreadRunsMock.mockReturnValueOnce(deferred);
        const old = store.set(loadThreadAtom, {
            user_id: 'u1', threadId: nextThreadId(),
            ...(phase === 'runs' ? { threadIdentity: CURRENT } : {}),
        });
        await vi.waitFor(() => expect(phase === 'identity' ? getThreadMock : getThreadRunsMock).toHaveBeenCalled());
        await store.set(newThreadAtom, { skipAutoPopulate: true });
        store.set(currentMessageContentAtom, 'new reader action');
        const context = { item: { id: 42 }, selection: null } as any;
        store.set(readerActionContextAtom, context);
        finish(phase === 'identity' ? { id: 'old', name: 'Old' } : { runs: [], agent_actions: [] });
        expect(await old).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBeNull();
        expect(store.get(currentMessageContentAtom)).toBe('new reader action');
        expect(store.get(readerActionContextAtom)).toBe(context);
    });

});

describe('finished-chat staged loading', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPrefMock.mockReturnValue(true);
        currentZoteroInstanceRefMock.mockReturnValue(CURRENT);
    });
    const history = { runs: [], agent_actions: [], tail_run_id: null, activity: { state: 'idle', run_id: null } };
    const request = () => ({ user_id: 'u1', threadId: nextThreadId(), threadIdentity: CURRENT, canCommit: () => true });
    const destination = () => {
        const store = createStore();
        store.set(currentThreadIdAtom, 'destination');
        store.set(currentMessageContentAtom, 'keep me');
        return store;
    };
    it('preserves chat and draft after history fetch failure', async () => {
        const store = destination();
        getThreadRunsMock.mockRejectedValue(new Error('offline'));
        expect(await store.set(loadThreadAtom, request())).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBe('destination');
        expect(store.get(currentMessageContentAtom)).toBe('keep me');
    });
    it.each(['active', 'unknown', 'expired'])('does not open %s server activity', async state => {
        const store = destination();
        getThreadRunsMock.mockResolvedValue({ ...history, activity: { state, run_id: 'run' } });
        expect(await store.set(loadThreadAtom, request())).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBe('destination');
        expect(store.get(currentMessageContentAtom)).toBe('keep me');
    });
    it('rechecks server activity after hydration before committing', async () => {
        const store = destination();
        getThreadRunsMock.mockResolvedValueOnce(history).mockResolvedValueOnce({ ...history, activity: { state: 'active', run_id: 'new' } });
        expect(await store.set(loadThreadAtom, request())).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBe('destination');
        expect(store.get(currentMessageContentAtom)).toBe('keep me');
    });
    it('commits the requested finished chat and clears only the accepted draft', async () => {
        const store = destination();
        const target = request();
        getThreadRunsMock.mockImplementation(async () => {
            expect(store.get(currentThreadIdAtom)).toBe('destination');
            expect(store.get(currentMessageContentAtom)).toBe('keep me');
            return history;
        });
        expect(await store.set(loadThreadAtom, target)).toBe(true);
        expect(store.get(currentThreadIdAtom)).toBe(target.threadId);
        expect(store.get(currentMessageContentAtom)).toBe('');
    });
    it('rejects an invalidated destination while preserving newer edits', async () => {
        const store = destination();
        let valid = true;
        getThreadRunsMock.mockImplementation(async () => {
            store.set(currentMessageContentAtom, 'new draft');
            valid = false;
            return history;
        });
        expect(await store.set(loadThreadAtom, { ...request(), canCommit: () => valid })).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBe('destination');
        expect(store.get(currentMessageContentAtom)).toBe('new draft');
    });
    it.each(['success', 'failure', 'invalidated'] as const)(
        'clears a superseded ordinary preflight spinner when a guarded load ends in %s', async outcome => {
            const store = destination();
            let finishIdentity!: (value: unknown) => void;
            getThreadMock.mockReturnValueOnce(new Promise(resolve => { finishIdentity = resolve; }));
            const ordinary = store.set(loadThreadAtom, { user_id: 'u1', threadId: nextThreadId() });
            expect(store.get(isLoadingThreadAtom)).toBe(true);

            let finishHistory!: (value: unknown) => void;
            getThreadRunsMock.mockReturnValueOnce(new Promise(resolve => { finishHistory = resolve; })).mockResolvedValue(history);
            let valid = true;
            const target = { ...request(), canCommit: () => valid };
            const guarded = store.set(loadThreadAtom, target);
            expect(store.get(isLoadingThreadAtom)).toBe(false);
            finishIdentity({ id: 'old', name: 'Old' });
            expect(await ordinary).toBe(false);
            if (outcome === 'invalidated') valid = false;
            finishHistory(outcome === 'failure' ? { ...history, activity: { state: 'active', run_id: 'run' } } : history);
            expect(await guarded).toBe(outcome === 'success');
            expect(store.get(isLoadingThreadAtom)).toBe(false);
            expect(store.get(currentThreadIdAtom)).toBe(outcome === 'success' ? target.threadId : 'destination');
        },
    );

    it('does not let superseded ordinary and guarded loads clear a newer ordinary spinner', async () => {
        const store = destination();
        let finishOld!: (value: unknown) => void;
        let finishNew!: (value: unknown) => void;
        getThreadMock.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
            .mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
        const ordinary = store.set(loadThreadAtom, { user_id: 'u1', threadId: nextThreadId() });
        let finishGuarded!: (value: unknown) => void;
        getThreadRunsMock.mockReturnValueOnce(new Promise(resolve => { finishGuarded = resolve; })).mockResolvedValue(history);
        const guarded = store.set(loadThreadAtom, request());
        const newestId = nextThreadId();
        const newest = store.set(loadThreadAtom, { user_id: 'u1', threadId: newestId });
        expect(store.get(isLoadingThreadAtom)).toBe(true);
        finishOld({ id: 'old', name: 'Old' });
        expect(await ordinary).toBe(false);
        finishGuarded(history);
        expect(await guarded).toBe(false);
        expect(store.get(isLoadingThreadAtom)).toBe(true);
        finishNew({ id: newestId, name: 'Newest', zotero_user_id: CURRENT.zoteroUserId, zotero_local_id: CURRENT.zoteroLocalId });
        expect(await newest).toBe(true);
        expect(store.get(isLoadingThreadAtom)).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBe(newestId);
    });

    it('does not let superseded committed hydration clear a newer preflight spinner', async () => {
        const store = destination();
        let finishOld!: (value: unknown) => void;
        getThreadRunsMock.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(history);
        const old = store.set(loadThreadAtom, { user_id: 'u1', threadId: nextThreadId(), threadIdentity: CURRENT });
        await vi.waitFor(() => expect(getThreadRunsMock).toHaveBeenCalled());
        let finishNew!: (value: unknown) => void;
        getThreadMock.mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
        const newestId = nextThreadId();
        const newest = store.set(loadThreadAtom, { user_id: 'u1', threadId: newestId });
        finishOld(history);
        expect(await old).toBe(true);
        expect(store.get(isLoadingThreadAtom)).toBe(true);
        finishNew({ id: newestId, name: 'Newest', zotero_user_id: CURRENT.zoteroUserId, zotero_local_id: CURRENT.zoteroLocalId });
        expect(await newest).toBe(true);
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });

});


describe('committed hydration while replacement navigation is pending', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getThreadMock.mockReset();
        getThreadRunsMock.mockReset();
        getPrefMock.mockReturnValue(true);
        currentZoteroInstanceRefMock.mockReturnValue(CURRENT);
        confirmMock.mockReturnValue(true);
    });
    const historyFor = (threadId: string) => ({
        runs: [{ id: `run-${threadId}`, thread_id: threadId, status: 'completed', user_prompt: { attachments: [] }, model_messages: [], metadata: { citations: [{ id: `citation-${threadId}` }] } }],
        agent_actions: [], tail_run_id: `run-${threadId}`, activity: { state: 'idle', run_id: null },
    });
    const identityFor = (id: string, foreign = false) => ({
        id, name: id,
        zotero_user_id: (foreign ? FOREIGN : CURRENT).zoteroUserId,
        zotero_local_id: (foreign ? FOREIGN : CURRENT).zoteroLocalId,
    });
    it.each([
        ['identity failure', false], ['identity failure', true],
        ['mismatch cancellation', false], ['mismatch cancellation', true],
        ['guarded refusal', false], ['guarded refusal', true],
    ] as const)('retains coherent history after %s (hydration finishes first: %s)', async (outcome, hydrationFirst) => {
        const store = createStore();
        store.set(threadRunsAtom, [{ id: 'previous-chat-run' }] as any);
        store.set(citationsAtom, [{ id: 'previous-chat-citation' }] as any);
        const committedId = nextThreadId();
        let finishHydration!: (value: unknown) => void;
        getThreadRunsMock.mockReturnValueOnce(new Promise(resolve => { finishHydration = resolve; }));
        const committed = store.set(loadThreadAtom, { user_id: 'u1', threadId: committedId, threadIdentity: CURRENT });
        await vi.waitFor(() => expect(getThreadRunsMock).toHaveBeenCalledOnce());
        expect(store.get(currentThreadIdAtom)).toBe(committedId);

        const replacementId = nextThreadId();
        let abandon!: () => void;
        let allowed = true;
        if (outcome === 'guarded refusal') {
            getThreadRunsMock.mockReturnValueOnce(new Promise(resolve => {
                abandon = () => { allowed = false; resolve(historyFor(replacementId)); };
            }));
        } else {
            getThreadMock.mockReturnValueOnce(new Promise((resolve, reject) => {
                abandon = () => outcome === 'identity failure'
                    ? reject(new ApiError(500, 'Unavailable'))
                    : resolve(identityFor(replacementId, true));
            }));
            if (outcome === 'mismatch cancellation') confirmMock.mockReturnValue(false);
        }
        const replacement = store.set(loadThreadAtom, {
            user_id: 'u1', threadId: replacementId,
            ...(outcome === 'guarded refusal' ? { threadIdentity: CURRENT, canCommit: () => allowed } : {}),
        });
        if (hydrationFirst) {
            finishHydration(historyFor(committedId));
            expect(await committed).toBe(true);
            expect(store.get(isLoadingThreadAtom)).toBe(outcome !== 'guarded refusal');
        }
        abandon();
        expect(await replacement).toBe(false);
        if (!hydrationFirst) {
            finishHydration(historyFor(committedId));
            expect(await committed).toBe(true);
        }
        expect(store.get(currentThreadIdAtom)).toBe(committedId);
        expect(store.get(threadRunsAtom)).toEqual(historyFor(committedId).runs);
        expect(store.get(citationsAtom)).toEqual([{ id: `citation-${committedId}`, run_id: `run-${committedId}` }]);
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });

    it.each(['ordinary', 'guarded'] as const)('rejects late hydration once a %s replacement commits', async kind => {
        const store = createStore();
        let finishHydration!: (value: unknown) => void;
        getThreadRunsMock.mockReturnValueOnce(new Promise(resolve => { finishHydration = resolve; }));
        const oldId = nextThreadId();
        const old = store.set(loadThreadAtom, { user_id: 'u1', threadId: oldId, threadIdentity: CURRENT });
        await vi.waitFor(() => expect(getThreadRunsMock).toHaveBeenCalledOnce());
        const replacementId = nextThreadId();
        getThreadRunsMock.mockResolvedValue(historyFor(replacementId));
        expect(await store.set(loadThreadAtom, {
            user_id: 'u1', threadId: replacementId, threadIdentity: CURRENT,
            ...(kind === 'guarded' ? { canCommit: () => true } : {}),
        })).toBe(true);
        const runs = store.get(threadRunsAtom);
        const citations = store.get(citationsAtom);
        finishHydration(historyFor(oldId));
        expect(await old).toBe(false);
        expect(store.get(currentThreadIdAtom)).toBe(replacementId);
        expect(store.get(threadRunsAtom)).toBe(runs);
        expect(store.get(citationsAtom)).toBe(citations);
        expect(store.get(isLoadingThreadAtom)).toBe(false);
    });
});
