import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module mocks — react/atoms/threads drags in the WS layer, citations, and
// supabase-backed services; stub everything the thread atoms touch.
// =============================================================================

const cancelMock = vi.fn();
const getThreadRunsMock = vi.fn();
const getThreadMock = vi.fn();
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentRunService: { getThreadRuns: (...args: unknown[]) => getThreadRunsMock(...args) },
    agentService: { cancel: (...args: unknown[]) => cancelMock(...args) },
}));

vi.mock('@beaver/agent-core/transport/threadService', () => ({
    threadService: { getThread: (...args: unknown[]) => getThreadMock(...args) },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    currentZoteroInstanceRef: vi.fn(() => ({ zoteroUserId: '111', zoteroLocalId: 'CURKEY' })),
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
    return {
        currentMessageItemsAtom: atom<unknown[]>([]),
        clearComposerAtom: atom(null, () => {}),
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
        isWSChatPendingAtom: atom(false),
        isWSConnectedAtom: atom(false),
        isWSReadyAtom: atom(false),
    };
});

vi.mock('../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return {
        threadAgentActionsAtom: atom<unknown[]>([]),
        isCreateItemAgentAction: vi.fn(() => false),
        validateAppliedAgentAction: vi.fn(async () => 'valid' as const),
        undoAgentActionAtom: atom(null, () => {}),
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
    newThreadAtom,
    loadThreadAtom,
    currentThreadIdAtom,
    threadNavigationSeqAtom,
} from '../../../react/atoms/threads';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isWSChatPendingAtom } from '../../../react/atoms/agentRunAtoms';

const run = (status: string) => ({ id: 'run-1', status });

const CURRENT_IDENTITY = { zoteroUserId: '111', zoteroLocalId: 'CURKEY' };

/** Args that isolate the interrupt confirm from loadThreadAtom's other gates. */
const loadArgs = {
    user_id: 'u1',
    threadId: 'thread-1',
    threadName: 'Thread',
    threadIdentity: CURRENT_IDENTITY,
    skipInstanceMismatchConfirm: true,
};

describe('interrupt-active-run confirm', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        vi.clearAllMocks();
        store = createStore();
        getPrefMock.mockReturnValue(false);
        confirmMock.mockReturnValue(true);
        getThreadRunsMock.mockResolvedValue({ runs: [], agent_actions: [] });
        getThreadMock.mockResolvedValue({ name: 'Thread', zotero_user_id: '111', zotero_local_id: 'CURKEY' });
    });

    describe('newThreadAtom', () => {
        it('does not prompt when the active run already failed', async () => {
            store.set(activeRunAtom, run('error'));

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).not.toHaveBeenCalled();
            expect(store.get(activeRunAtom)).toBeNull();
        });

        it('does not prompt when the active run was canceled', async () => {
            store.set(activeRunAtom, run('canceled'));

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).not.toHaveBeenCalled();
        });

        it('prompts while a run is streaming', async () => {
            store.set(activeRunAtom, run('in_progress'));

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).toHaveBeenCalledTimes(1);
            expect(confirmMock.mock.calls[0][0]).toMatchObject({ title: 'Start new chat?' });
        });

        it('prompts while a run waits on a deferred approval', async () => {
            store.set(activeRunAtom, run('awaiting_deferred'));

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).toHaveBeenCalledTimes(1);
        });

        it('prompts while the send is pending with no run shell yet', async () => {
            store.set(isWSChatPendingAtom, true);

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).toHaveBeenCalledTimes(1);
        });

        it('leaves the streaming run untouched when the prompt is canceled', async () => {
            confirmMock.mockReturnValue(false);
            const streaming = run('in_progress');
            store.set(activeRunAtom, streaming);

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(store.get(activeRunAtom)).toBe(streaming);
        });
    });

    describe('loadThreadAtom', () => {
        it('does not prompt when the active run already failed', async () => {
            store.set(activeRunAtom, run('error'));

            const loaded = await store.set(loadThreadAtom, loadArgs);

            expect(loaded).toBe(true);
            expect(confirmMock).not.toHaveBeenCalled();
            expect(store.get(currentThreadIdAtom)).toBe('thread-1');
        });

        it('prompts while a run is streaming', async () => {
            store.set(activeRunAtom, run('in_progress'));

            await store.set(loadThreadAtom, loadArgs);

            expect(confirmMock).toHaveBeenCalledTimes(1);
            expect(confirmMock.mock.calls[0][0]).toMatchObject({ title: 'Switch chat?' });
        });
    });

    /**
     * Work started in one chat asks this counter whether it has been left
     * behind. The thread id cannot answer: a new chat opened from an unnamed
     * first run leaves it null on both sides, and a load writes it only after
     * its own awaits.
     */
    describe('threadNavigationSeqAtom', () => {
        it('counts a new chat even when the thread id does not change', async () => {
            store.set(currentThreadIdAtom, null);
            const before = store.get(threadNavigationSeqAtom);

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(store.get(currentThreadIdAtom)).toBeNull();
            expect(store.get(threadNavigationSeqAtom)).toBe(before + 1);
        });

        it('counts a load', async () => {
            const before = store.get(threadNavigationSeqAtom);

            await store.set(loadThreadAtom, loadArgs);

            expect(store.get(threadNavigationSeqAtom)).toBe(before + 1);
        });

        it('counts before the identity preflight, not after it', async () => {
            // The preflight is a network round trip, and the confirm the user
            // just cleared is added to it. A count taken after would leave a
            // retry that finishes inside that window free to act on the chat
            // being left.
            getPrefMock.mockImplementation((k: string) => k === 'statefulChat');
            const before = store.get(threadNavigationSeqAtom);
            let seqAtFetch: number | null = null;
            getThreadMock.mockImplementation(async () => {
                seqAtFetch = store.get(threadNavigationSeqAtom);
                return { name: 'Thread', zotero_user_id: '111', zotero_local_id: 'CURKEY' };
            });

            await store.set(loadThreadAtom, {
                user_id: 'u1',
                threadId: 'thread-1',
                skipInstanceMismatchConfirm: true,
            });

            expect(getThreadMock).toHaveBeenCalled();
            expect(seqAtFetch).toBe(before + 1);
        });

        it('still counts a load that aborts after the user committed', async () => {
            // The accepted cost of counting at the commit point: work already
            // abandoned cannot be un-abandoned when the load later fails. Safe
            // direction — see the atom's own note.
            getPrefMock.mockImplementation((k: string) => k === 'statefulChat');
            getThreadMock.mockRejectedValue(new Error('offline'));
            const before = store.get(threadNavigationSeqAtom);

            const loaded = await store.set(loadThreadAtom, {
                user_id: 'u1',
                threadId: 'thread-1',
            });

            expect(loaded).toBe(false);
            expect(store.get(threadNavigationSeqAtom)).toBe(before + 1);
        });

        it('does not count a navigation the user declined', async () => {
            confirmMock.mockReturnValue(false);
            store.set(activeRunAtom, run('in_progress'));
            const before = store.get(threadNavigationSeqAtom);

            await store.set(newThreadAtom, { skipAutoPopulate: true });
            await store.set(loadThreadAtom, loadArgs);

            expect(confirmMock).toHaveBeenCalledTimes(2);
            expect(store.get(threadNavigationSeqAtom)).toBe(before);
        });

        it('moves before the new chat state does', async () => {
            store.set(currentThreadIdAtom, 'thread-0');
            const seenWhenIdChanged: number[] = [];
            store.sub(currentThreadIdAtom, () => {
                seenWhenIdChanged.push(store.get(threadNavigationSeqAtom));
            });
            const before = store.get(threadNavigationSeqAtom);

            await store.set(loadThreadAtom, loadArgs);

            // Already incremented by the time the id is written, so nothing can
            // observe the new chat under the old count.
            expect(seenWhenIdChanged).toContain(before + 1);
        });
    });
});
