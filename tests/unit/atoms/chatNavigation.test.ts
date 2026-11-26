import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../helpers/localRunSession';
import { createThreadStore as createStore } from '../../helpers/threadRepository';

// =============================================================================
// Module mocks — react/atoms/threads drags in the WS layer, citations, and
// supabase-backed services; stub everything the thread atoms touch.
// =============================================================================

const attachCollectionsMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const leaveRunMock = vi.hoisted(() => vi.fn(() => false));
const canLeaveReconnectingRunMock = vi.hoisted(() => vi.fn(() => false));
const parkableRunIdMock = vi.hoisted(() => vi.fn((): string | null => null));
const parkRunMock = vi.hoisted(() => vi.fn(async () => 'ended'));
const getThreadRunsMock = vi.hoisted(() => vi.fn());
const getThreadMock = vi.hoisted(() => vi.fn());
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentRunService: {
        getThreadRuns: (...args: unknown[]) => getThreadRunsMock(...args),
        // Reads the tail and activity through the history mock, as the real
        // service does on a server without the activity endpoint.
        getThreadActivity: async (threadId: string) => {
            const history = await getThreadRunsMock(threadId, false);
            return { tail_run_id: history.tail_run_id, activity: history.activity };
        },
    },
    agentService: {
        cancel: (...args: unknown[]) => cancelMock(...args),
        cancelHandoff: () => null,
        canLeaveRun: () => false,
        leaveRun: (...args: unknown[]) => leaveRunMock(...(args as [])),
        isReattaching: () => false,
        parkRun: (...args: unknown[]) => parkRunMock(...(args as [])),
    },
}));

vi.mock('@beaver/agent-core/transport/threadService', () => ({
    threadService: { getThread: (...args: unknown[]) => getThreadMock(...args) },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    currentZoteroInstanceRef: vi.fn(() => ({ zoteroUserId: '111', zoteroLocalId: 'CURKEY' })),
}));

const getPrefMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (...args: unknown[]) => getPrefMock(...args),
}));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('@beaver/agent-ui/host', () => ({
    getHost: () => ({ dialogs: { confirm: confirmMock } }),
}));

vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        readerActionContextAtom: atom(null),
        currentMessageItemsAtom: atom<unknown[]>([]),
        clearComposerAtom: atom(null, () => {}),
        currentMessageCollectionsAtom: atom<unknown[]>([]),
        currentMessageViewsAtom: atom<unknown[]>([]),
        currentMessageExternalFilesAtom: atom<unknown[]>([]),
        updateMessageCollectionsFromZoteroSelectionAtom: atom(null, () => attachCollectionsMock()),
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

vi.mock('@beaver/agent-core/run-state/atoms', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resetRunSelectorCaches: () => {},
}));

vi.mock('../../../react/atoms/agentRunAtoms', async (importOriginal) => {
    const { atom } = await import('jotai');
    return {
        ...(await importOriginal<object>()),
        abandonActiveRunLocallyAtom: atom(null, () => {}),
    };
});

vi.mock('../../../src/services/agentRuns/parkedRuns', async (importOriginal) => {
    const { atom } = await import('jotai');
    return {
        ...(await importOriginal<object>()),
        clearParkedAnswersAtom: atom(null, () => {}),
        syncParkedCardsAtom: atom(null, () => {}),
    };
});

vi.mock('../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return {
        threadAgentActionsAtom: atom<unknown[]>([]),
        isCreateItemAgentAction: vi.fn(() => false),
        validateAppliedAgentAction: vi.fn(async () => 'valid' as const),
        undoAgentActionAtom: atom(null, () => {}),
        // Session state: the session's own action, which the window reaches by name.
        clearAllPendingApprovalsAtom: (await import('../../../src/services/agentRuns/pendingApprovals')).clearAllPendingApprovalsAtom,
        resetAgentActionSelectorCaches: vi.fn(),
    };
});

vi.mock('@beaver/agent-core/run-state/pendingQuestions', async (importOriginal) => {
    const { atom } = await import('jotai');
    return { ...(await importOriginal<object>()), clearAllPendingQuestionsAtom: atom(null, () => {}) };
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
import { isLibraryTabAtom } from '../../../react/atoms/ui';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isWSChatPendingAtom } from '../../../react/atoms/agentRunAtoms';
import { jobWaitAtom } from '../../../src/services/agentRuns/jobWait';
import { chatFillsAtom, recordChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { installStoreRunSession } from '../../helpers/runSession';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { getSessionPort } from '../../../src/services/agentRuns/runSession';

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

describe('chat navigation', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        vi.clearAllMocks();
        store = createStore();
        installStoreRunSession(store, { agentService });
        getPrefMock.mockReturnValue(false);
        confirmMock.mockReturnValue(true);
        getThreadRunsMock.mockResolvedValue({ runs: [], agent_actions: [] });
        getThreadMock.mockResolvedValue({ name: 'Thread', zotero_user_id: '111', zotero_local_id: 'CURKEY' });
    });

    describe('newThreadAtom', () => {
        it.each([
            [true, true, false, true],
            [false, true, false, false],
            [true, false, false, false],
            [true, true, true, false],
        ])('auto-attaches collections only when enabled in library view (preference=%s, library=%s, skip=%s)', async (enabled, library, skip, expected) => {
            getPrefMock.mockImplementation((name) => name === 'addSelectedItemsOnNewThread' ? enabled : 10);
            store.set(isLibraryTabAtom, library);
            await store.set(newThreadAtom, { skipAutoPopulate: skip });
            expect(attachCollectionsMock).toHaveBeenCalledTimes(expected ? 1 : 0);
        });

    });

    /** A live run waits on a fill whose table is not open: one question, naming the fill. */
    /**
     * Work started in one chat asks this counter whether it has been left
     * behind. The thread id cannot answer: a new chat opened from an unnamed
     * first run leaves it null on both sides, and a load writes it only after
     * its own awaits.
     */
    /**
     * A run belongs to its chat's session: leaving the chat never asks, and
     * never stops, parks or leaves the run.
     */
    describe('leaving a chat with a run going', () => {
        it.each(['in_progress', 'awaiting_deferred'])('starts a new chat without asking or stopping a run %s', async (status) => {
            store.set(activeRunAtom, run(status));
            store.set(isWSChatPendingAtom, true);

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).not.toHaveBeenCalled();
            expect(cancelMock).not.toHaveBeenCalled();
            expect(parkRunMock).not.toHaveBeenCalled();
            expect(leaveRunMock).not.toHaveBeenCalled();
        });

        it('opens another chat without asking or stopping the run', async () => {
            store.set(activeRunAtom, run('in_progress'));
            store.set(isWSChatPendingAtom, true);

            expect(await store.set(loadThreadAtom, { ...loadArgs, threadId: 'thread-2' })).toBe(true);

            expect(confirmMock).not.toHaveBeenCalled();
            expect(cancelMock).not.toHaveBeenCalled();
            expect(parkRunMock).not.toHaveBeenCalled();
        });

        it('leaves a fill the run waits on running, and the wait in place', async () => {
            store.set(activeRunAtom, run('in_progress'));
            store.set(jobWaitAtom, { threadId: 'thread-0', runId: 'run-1', toolCallId: 'call-1', jobId: 'job-1' });
            const stop = vi.fn();
            (globalThis as any).Zotero.Beaver = { ...(globalThis as any).Zotero.Beaver, tableFills: { stop, agent: { release: stop } } };

            await store.set(newThreadAtom, { skipAutoPopulate: true });

            expect(confirmMock).not.toHaveBeenCalled();
            expect(stop).not.toHaveBeenCalled();
        });
    });

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

        it('preserves the current generation during identity preflight and counts the accepted load', async () => {
            // Preflight can still produce a mismatch confirmation. Until it is
            // accepted, retries still belong to the unchanged current chat.
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
            expect(seqAtFetch).toBe(before);
            expect(store.get(threadNavigationSeqAtom)).toBe(before + 1);
        });

        it('does not count a failed identity preflight as committed navigation', async () => {
            // A failed preflight keeps the current chat, including any retry
            // whose backend truncation is still pending.
            getPrefMock.mockImplementation((k: string) => k === 'statefulChat');
            getThreadMock.mockRejectedValue(new Error('offline'));
            const before = store.get(threadNavigationSeqAtom);

            const loaded = await store.set(loadThreadAtom, {
                user_id: 'u1',
                threadId: 'thread-1',
            });

            expect(loaded).toBe(false);
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
