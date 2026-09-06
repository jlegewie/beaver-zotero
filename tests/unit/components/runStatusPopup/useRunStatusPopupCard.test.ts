// @vitest-environment jsdom

/**
 * Which card the closed-sidebar status popup shows for the open thread, and
 * what its controls do.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, atom, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    dispatch: vi.fn(),
    answerPendingApprovals: vi.fn(),
    setRunPermissionMode: vi.fn(),
    sendCreditConfirmation: vi.fn(),
    dismissPreview: vi.fn(async () => {}),
    openNoteByKey: vi.fn(),
    artifactRows: [] as any[],
    changesRows: [] as any[],
    prefs: {} as Record<string, unknown>,
}));

vi.mock('../../../../src/utils/prefs', () => ({
    getPref: (key: string) => mocks.prefs[key],
    setPref: (key: string, value: unknown) => { mocks.prefs[key] = value; },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../../react/events/eventManager', () => ({
    eventManager: { dispatch: mocks.dispatch },
}));
vi.mock('../../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { isSidebarVisibleAtom: atom(false) };
});
vi.mock('../../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return { pendingApprovalsAtom: atom(new Map()) };
});
vi.mock('../../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    const inFlight = atom(false);
    return {
        autoReplacementPendingRunIdsAtom: atom(new Set<string>()),
        approvalVerdictInFlightAtom: inFlight,
        beginApprovalVerdictAtom: atom(null, (get, set) => {
            if (get(inFlight)) return false;
            set(inFlight, true);
            return true;
        }),
        releaseApprovalVerdictAtom: atom(null, (_get, set) => set(inFlight, false)),
        answerPendingApprovalsAtom: atom(null, (_get, _set, args: unknown) => mocks.answerPendingApprovals(args)),
        setRunPermissionModeAtom: atom(null, (_get, _set, args: unknown) => mocks.setRunPermissionMode(args)),
        sendCreditConfirmationResponseAtom: atom(null, (_get, _set, args: unknown) => mocks.sendCreditConfirmation(args)),
    };
});
vi.mock('../../../../react/host/zotero/editNotePreviewLifecycle', () => ({
    dismissActiveEditNotePreview: mocks.dismissPreview,
}));
vi.mock('../../../../react/utils/sourceUtils', () => ({ openNoteByKey: mocks.openNoteByKey }));
vi.mock('../../../../react/utils/toolCallLabelEnrich', () => ({
    resolveToolCallLabelEnrich: vi.fn(async () => null),
}));
vi.mock('../../../../src/utils/libraryIdentity', () => ({
    resolveItemReference: vi.fn(async () => ({ status: 'not_found' })),
    resolveLibraryRef: (ref: { library_id?: number | null }) => ref.library_id ?? null,
}));
vi.mock('../../../../src/utils/zoteroUtils', () => ({ shortItemTitle: vi.fn(async () => 'Smith 2014') }));
vi.mock('../../../../react/host/zotero/components/reviewChanges/useRunActionRows', () => ({
    useArtifactRows: () => mocks.artifactRows,
    useChangesRows: () => mocks.changesRows,
}));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    activeRunAtom,
    currentThreadNameAtom,
    threadRunsAtom,
} from '@beaver/agent-core/run-state/atoms';
import { pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingApprovalsAtom } from '../../../../react/agents/agentActions';
import { autoReplacementPendingRunIdsAtom } from '../../../../react/atoms/agentRunAtoms';
import { isSidebarVisibleAtom } from '../../../../react/atoms/ui';
import { runStatusPopupCompletionAtom, runStatusPopupPreviewAtom } from '../../../../react/atoms/runStatusPopup';
import { useRunStatusPopupCard } from '../../../../react/components/runStatusPopup/useRunStatusPopupCard';
import type { RunStatusPopupCard } from '../../../../react/components/runStatusPopup/runStatusPopupModel';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id: 'run-1',
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: 'Summarize the neighborhood effects literature', attachments: [] } as any,
        status: 'in_progress',
        model_messages: [],
        model_name: 'test',
        created_at: '2026-09-06T10:00:00.000Z',
        consent_to_share: false,
        ...overrides,
    };
}

let store = createStore();
let latest: RunStatusPopupCard | null = null;
const roots: { root: Root; container: HTMLDivElement }[] = [];

function mount() {
    const Harness: React.FC = () => {
        latest = useRunStatusPopupCard();
        return null;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => {
        root.render(React.createElement(Provider, { store }, React.createElement(Harness)));
    });
}

function set<T>(target: any, value: T) {
    act(() => { store.set(target, value); });
}

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    store = createStore();
    latest = null;
    mocks.artifactRows = [];
    mocks.changesRows = [];
    mocks.prefs = {};
});

afterEach(() => {
    act(() => { roots.forEach(({ root }) => root.unmount()); });
    roots.forEach(({ container }) => container.remove());
    roots.length = 0;
});

describe('with no run', () => {
    it('shows nothing', () => {
        mount();
        expect(latest).toBeNull();
    });
});

describe('while a run works', () => {
    it('names the thread by its prompt until the backend names it', () => {
        store.set(activeRunAtom, run());
        mount();
        expect(latest).toMatchObject({ kind: 'running', threadName: 'Summarize the neighborhood effects literature', statusLine: 'Thinking' });

        set(currentThreadNameAtom, 'Neighborhood effects');
        expect(latest?.threadName).toBe('Neighborhood effects');
    });

    it('says what the run is doing', () => {
        store.set(activeRunAtom, run({
            model_messages: [{ kind: 'response', run_id: 'run-1', parts: [{ part_kind: 'text', content: 'The literature' }] }],
        }));
        mount();
        expect(latest).toMatchObject({ kind: 'running', statusLine: 'Generating' });

        set(activeRunAtom, run({
            model_messages: [{
                kind: 'response',
                run_id: 'run-1',
                parts: [{ part_kind: 'tool-call', tool_name: 'fulltext_search', args: { query: 'social capital' }, tool_call_id: 'tc-1' }],
            }],
        }));
        expect(latest).toMatchObject({ kind: 'running', statusLine: expect.stringContaining('Fulltext search') });
    });

    it('opens Beaver from the card', () => {
        store.set(activeRunAtom, run());
        mount();
        latest!.onOpen();
        expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith('toggleChat', { forceOpen: true });
    });
});

describe('while a run waits on the user', () => {
    const approval = (actionId: string, actionType = 'edit_metadata') => ({
        actionId, toolcallId: `tc-${actionId}`, actionType, actionData: {},
    });

    it('offers the pending change with its controls', async () => {
        store.set(activeRunAtom, run({ status: 'awaiting_deferred' }));
        store.set(pendingApprovalsAtom as any, new Map([['a', approval('a')]]));
        mount();

        expect(latest).toMatchObject({ kind: 'approval', label: 'Edit', count: 1, approveLabel: 'Approve', rejectLabel: 'Reject' });
        expect((latest as any).permission).toMatchObject({ mode: 'ask', pendingCoveredCount: 1 });

        await act(async () => { (latest as any).onDecide(true); });
        expect(mocks.dismissPreview).toHaveBeenCalledOnce();
        expect(mocks.answerPendingApprovals).toHaveBeenCalledExactlyOnceWith({ actionIds: ['a'], approved: true });
    });

    it('aggregates several changes behind Approve All', () => {
        store.set(activeRunAtom, run({ status: 'awaiting_deferred' }));
        store.set(pendingApprovalsAtom as any, new Map([
            ['a', approval('a')],
            ['b', approval('b')],
            ['c', approval('c', 'create_note')],
        ]));
        mount();
        expect(latest).toMatchObject({
            kind: 'approval',
            label: '3 changes · Edit ×2, Create Note',
            approveLabel: 'Approve All',
            rejectLabel: 'Reject All',
        });
    });

    it('offers no permission grant for a confirmation', () => {
        store.set(activeRunAtom, run({ status: 'awaiting_deferred' }));
        store.set(pendingApprovalsAtom as any, new Map([['a', approval('a', 'confirm_extraction')]]));
        mount();
        expect(latest).toMatchObject({ kind: 'approval', permission: null, approveLabel: 'Confirm' });
    });

    it('grants full access for the run through the menu', async () => {
        store.set(activeRunAtom, run({ status: 'awaiting_deferred' }));
        store.set(pendingApprovalsAtom as any, new Map([['a', approval('a')]]));
        mount();
        await act(async () => { await (latest as any).permission.onChange('full_access'); });
        expect(mocks.dismissPreview).toHaveBeenCalledOnce();
        expect(mocks.setRunPermissionMode).toHaveBeenCalledExactlyOnceWith({ runId: 'run-1', fullAccess: true });
    });

    it('ranks the blocking requests the way the composer does', () => {
        store.set(activeRunAtom, run({ status: 'awaiting_deferred' }));
        store.set(pendingQuestionsAtom, new Map([['tc-q', { questionId: 'q', toolcallId: 'tc-q', title: 'Which years?', questions: [] }]]));
        mount();
        expect(latest).toMatchObject({ kind: 'question', title: 'Which years?' });

        set(pendingCreditConfirmationsAtom, new Map([['c', {
            confirmationId: 'c', runId: 'run-1', title: 'Continue past 50 credits?', message: 'Body',
            approveLabel: 'Continue', declineLabel: 'Wrap up', pendingCredits: 30, projectedTotalCredits: 80,
            threshold: 50, timeoutSeconds: 300, expiresAt: Date.now() + 300_000,
        }]]));
        expect(latest).toMatchObject({ kind: 'credit', title: 'Continue past 50 credits?', approveLabel: 'Continue', declineLabel: 'Wrap up' });

        set(pendingBatchApprovalsAtom, new Map([['b', {
            approvalId: 'b', runId: 'run-1', toolcallId: 'tc-b', batchId: 'batch', title: 'Summarize each paper',
            scopePrimary: '184 items', scopeSecondary: 'in Methods', message: '', destructiveWarning: '', costWarning: '',
            creditChip: '', creditTooltip: '', defaultMode: 'ask', approveLabel: 'Start', declineLabel: 'Cancel',
            declineWithInstructionsLabel: 'Cancel', userInstructionsPrefill: '', readOnly: false, timeoutSeconds: 300,
        }]]));
        expect(latest).toMatchObject({ kind: 'batch', title: 'Summarize each paper', scope: '184 items in Methods' });

        set(pendingApprovalsAtom as any, new Map([['a', approval('a')]]));
        expect(latest?.kind).toBe('approval');
    });

    it('sends a credit decision once', () => {
        store.set(activeRunAtom, run({ status: 'awaiting_deferred' }));
        store.set(pendingCreditConfirmationsAtom, new Map([['c', {
            confirmationId: 'c', runId: 'run-1', title: 'T', message: 'M', approveLabel: 'Continue', declineLabel: 'Wrap up',
            pendingCredits: 1, projectedTotalCredits: 2, threshold: 1, timeoutSeconds: 300, expiresAt: Date.now() + 300_000,
        }]]));
        mount();
        act(() => { (latest as any).onDecide(false); });
        act(() => { (latest as any).onDecide(true); });
        expect(mocks.sendCreditConfirmation).toHaveBeenCalledExactlyOnceWith({ confirmationId: 'c', approved: false });
        expect((latest as any).decideDisabled).toBe(true);
    });
});

describe('when a run finishes', () => {
    it('reports a run that finished while the sidebar was closed, until Beaver opens', () => {
        store.set(activeRunAtom, run());
        mount();
        expect(latest?.kind).toBe('running');

        set(activeRunAtom, run({ status: 'completed' }));
        expect(latest).toMatchObject({ kind: 'completed', outcome: 'completed', detail: null, artifacts: [], changes: null });

        set(isSidebarVisibleAtom, true);
        expect(store.get(runStatusPopupCompletionAtom)).toBeNull();
        expect(latest).toBeNull();
    });

    it('lists what the run produced and changed', () => {
        mocks.artifactRows = [{
            runId: 'run-1', toolcallId: 'tc-n', actionType: 'create_note', bulkApplicable: true, resolved: true,
            actions: [{ id: 'n', run_id: 'run-1', action_type: 'create_note', status: 'applied',
                proposed_data: { title: 'Summary: Smith 2014' }, result_data: { library_id: 1, zotero_key: 'ABCD1234' } }],
        }];
        mocks.changesRows = [{
            runId: 'run-1', toolcallId: 'tc-e', actionType: 'edit_metadata', bulkApplicable: true, resolved: false,
            actions: [{ id: 'e', run_id: 'run-1', action_type: 'edit_metadata', status: 'pending', proposed_data: {} }],
        }];
        store.set(activeRunAtom, run());
        mount();
        set(activeRunAtom, run({ status: 'completed' }));

        expect(latest).toMatchObject({ kind: 'completed', changes: '1 pending' });
        expect((latest as any).artifacts).toHaveLength(1);
        expect((latest as any).artifacts[0].title).toBe('Summary: Smith 2014');
        (latest as any).artifacts[0].open();
        expect(mocks.openNoteByKey).toHaveBeenCalledExactlyOnceWith(1, 'ABCD1234');
    });

    it('does not report a run that finished in front of the user', () => {
        store.set(isSidebarVisibleAtom, true);
        store.set(activeRunAtom, run());
        mount();
        set(activeRunAtom, run({ status: 'completed' }));
        set(isSidebarVisibleAtom, false);
        expect(latest).toBeNull();
    });

    it('drops the report when the user dismisses it or starts another run', () => {
        store.set(activeRunAtom, run());
        mount();
        set(activeRunAtom, run({ status: 'error', error: { type: 'usage_limit_exceeded', message: 'x' } }));
        expect(latest).toMatchObject({ kind: 'completed', outcome: 'error', detail: expect.any(String) });
        expect((latest as any).detail).not.toBe('An error occurred');

        act(() => { (latest as any).onDismiss(); });
        expect(latest).toBeNull();

        act(() => {
            store.set(threadRunsAtom, [run({ id: 'run-1', status: 'error' })]);
            store.set(activeRunAtom, run({ id: 'run-2' }));
        });
        expect(latest?.kind).toBe('running');
        set(activeRunAtom, run({ id: 'run-2', status: 'completed' }));
        expect(latest?.kind).toBe('completed');

        act(() => {
            store.set(threadRunsAtom, [run({ id: 'run-1', status: 'error' }), run({ id: 'run-2', status: 'completed' })]);
            store.set(activeRunAtom, run({ id: 'run-3' }));
        });
        expect(latest?.kind).toBe('running');
        expect(latest?.threadName).toBe('Summarize the neighborhood effects literature');
    });
});

describe('closing a card', () => {
    it('hides the working card but not the decision the same run asks for next', () => {
        store.set(activeRunAtom, run());
        mount();
        act(() => { latest!.onDismiss(); });
        expect(latest).toBeNull();

        set(pendingApprovalsAtom as any, new Map([['a', { actionId: 'a', toolcallId: 'tc-a', actionType: 'edit_metadata', actionData: {} }]]));
        expect(latest?.kind).toBe('approval');

        act(() => { latest!.onDismiss(); });
        expect(latest).toBeNull();

        // Answered elsewhere; the run goes back to work, still closed.
        set(pendingApprovalsAtom as any, new Map());
        expect(latest).toBeNull();

        // And its finish is a new card.
        set(activeRunAtom, run({ status: 'completed' }));
        expect(latest?.kind).toBe('completed');
    });

    it('shows again for the next run', () => {
        store.set(activeRunAtom, run());
        mount();
        act(() => { latest!.onDismiss(); });
        act(() => {
            store.set(threadRunsAtom, [run({ status: 'completed' })]);
            store.set(activeRunAtom, run({ id: 'run-2' }));
        });
        expect(latest?.kind).toBe('running');
    });
});

describe('the preference', () => {
    it('turns the popup off entirely', () => {
        mocks.prefs.enableRunStatusPopup = false;
        store.set(activeRunAtom, run());
        mount();
        expect(latest).toBeNull();
    });
});

describe('while the client retries a failed run', () => {
    it('keeps the working card up, saying so', () => {
        store.set(activeRunAtom, run());
        mount();
        act(() => {
            store.set(autoReplacementPendingRunIdsAtom as any, new Set(['run-1']));
            store.set(activeRunAtom, run({ status: 'error', error: { type: 'x', message: 'x' } }));
        });
        expect(latest).toMatchObject({ kind: 'running', statusLine: 'Retrying' });
    });
});

describe('the dev preview', () => {
    it('replaces the live card and clears itself on a decision', () => {
        store.set(activeRunAtom, run());
        store.set(runStatusPopupPreviewAtom, { kind: 'approval', count: 2, stackDepth: 5 });
        mount();
        expect(latest).toMatchObject({ kind: 'approval', approveLabel: 'Approve All', stackDepth: 2 });

        act(() => { (latest as any).onDecide(true); });
        expect(store.get(runStatusPopupPreviewAtom)).toBeNull();
        expect(latest?.kind).toBe('running');
    });
});
