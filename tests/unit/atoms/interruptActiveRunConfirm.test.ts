import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module mocks — react/atoms/threads drags in the WS layer, citations, and
// supabase-backed services; stub everything the thread atoms touch.
// =============================================================================

const cancelMock = vi.fn();
const getThreadRunsMock = vi.fn();
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentRunService: { getThreadRuns: (...args: unknown[]) => getThreadRunsMock(...args) },
    agentService: { cancel: (...args: unknown[]) => cancelMock(...args) },
}));

vi.mock('@beaver/agent-core/transport/threadService', () => ({
    threadService: { getThread: vi.fn() },
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
        uncommittedRunIdAtom: atom<string | null>(null),
        // threads.ts re-exports these three from the run state, so the stub must
        // provide them
        currentThreadIdAtom: atom<string | null>(null),
        currentThreadNameAtom: atom<string | null>(null),
        isLoadingThreadAtom: atom<boolean>(false),
    };
});

vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return {
        isWSChatPendingAtom: atom(false),
        isWSConnectedAtom: atom(false),
        isWSReadyAtom: atom(false),
        pendingRetryAtom: atom<unknown | null>(null),
        cancellingRunIdAtom: atom<string | null>(null),
        // No pending retry in these fixtures, so the canceled run is appended
        // to the thread as usual.
        abortPendingRetryAtom: atom(null, () => ({ aborted: false, popupId: null })),
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

import { newThreadAtom, loadThreadAtom, currentThreadIdAtom } from '../../../react/atoms/threads';
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
});
