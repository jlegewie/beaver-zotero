import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// The module transitively imports the Supabase client and Zotero-aware atoms,
// which require live globals at import time.
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

import {
    agentActionsForRunsAtom,
    agentActionsForToolcallAtom,
    agentActionsForToolcallsAtom,
    liveApprovalActionIdsForRunsAtom,
    pendingApprovalForToolcallAtom,
    pendingApprovalsAtom,
    pendingApprovalsCoveredByFullAccessCountAtom,
    pendingApprovalsForToolcallsAtom,
    resetAgentActionSelectorCaches,
    threadAgentActionsAtom,
    updateAgentActionsAtom,
    upsertAgentActionsAtom,
    type AgentAction,
} from '../../../react/agents/agentActions';
import type { PendingApproval } from '@beaver/agent-ui/host';

const action = (id: string, toolcallId: string, runId = 'run-1'): AgentAction => ({
    id,
    run_id: runId,
    toolcall_id: toolcallId,
    action_type: 'edit_metadata',
    status: 'pending',
    proposed_data: { zotero_key: id },
} as unknown as AgentAction);

const approval = (actionId: string, toolcallId: string, actionType = 'edit_metadata'): PendingApproval => ({
    actionId,
    toolcallId,
    actionType,
    actionData: {},
} as unknown as PendingApproval);

describe('scoped agent action selectors', () => {
    it("returns a tool call's actions in thread order, and an empty list for a call without any", () => {
        const store = createStore();
        const first = action('a1', 'call-1');
        const second = action('a2', 'call-1');
        store.set(threadAgentActionsAtom, [first, action('b1', 'call-2'), second]);

        expect(store.get(agentActionsForToolcallAtom('call-1'))).toEqual([first, second]);
        expect(store.get(agentActionsForToolcallAtom('call-missing'))).toEqual([]);
    });

    it("keeps a tool call's array, and stays silent, when another call's action changes", () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [action('a1', 'call-1'), action('b1', 'call-2')]);
        const selector = agentActionsForToolcallAtom('call-1');
        const listener = vi.fn();
        store.sub(selector, listener);
        const before = store.get(selector);

        store.set(updateAgentActionsAtom, [{ id: 'b1', status: 'applied' }]);
        store.set(upsertAgentActionsAtom, [action('c1', 'call-3')]);

        expect(store.get(selector)).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    it("notifies a tool call's readers when one of its actions changes", () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [action('a1', 'call-1')]);
        const selector = agentActionsForToolcallAtom('call-1');
        const listener = vi.fn();
        store.sub(selector, listener);

        store.set(updateAgentActionsAtom, [{ id: 'a1', status: 'applied' }]);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.get(selector)[0].status).toBe('applied');
    });

    it('returns one array per requested tool call and per run, in the order given', () => {
        const store = createStore();
        const a1 = action('a1', 'call-1', 'run-1');
        const b1 = action('b1', 'call-2', 'run-2');
        store.set(threadAgentActionsAtom, [a1, b1]);

        expect(store.get(agentActionsForToolcallsAtom(['call-2', 'call-missing', 'call-1'])))
            .toEqual([[b1], [], [a1]]);
        expect(store.get(agentActionsForRunsAtom(['run-2', 'run-1']))).toEqual([[b1], [a1]]);
    });

    it('keeps a group selection until one of its own calls changes', () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [action('a1', 'call-1'), action('b1', 'call-2'), action('c1', 'call-3')]);
        const selector = agentActionsForToolcallsAtom(['call-1', 'call-2']);
        const listener = vi.fn();
        store.sub(selector, listener);

        store.set(updateAgentActionsAtom, [{ id: 'c1', status: 'applied' }]);
        expect(listener).not.toHaveBeenCalled();

        store.set(updateAgentActionsAtom, [{ id: 'b1', status: 'applied' }]);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("finds a tool call's live approval and leaves other calls' readers alone", () => {
        const store = createStore();
        const pending = approval('a1', 'call-1');
        store.set(pendingApprovalsAtom, new Map([['a1', pending]]));
        const own = pendingApprovalForToolcallAtom('call-1');
        const other = pendingApprovalForToolcallAtom('call-2');
        const ownListener = vi.fn();
        const otherListener = vi.fn();
        store.sub(own, ownListener);
        store.sub(other, otherListener);

        expect(store.get(own)).toBe(pending);
        expect(store.get(other)).toBeNull();

        store.set(pendingApprovalsAtom, (prev) => new Map(prev).set('x1', approval('x1', 'call-3')));
        expect(ownListener).not.toHaveBeenCalled();
        expect(otherListener).not.toHaveBeenCalled();

        store.set(pendingApprovalsAtom, new Map());
        expect(ownListener).toHaveBeenCalledTimes(1);
        expect(store.get(own)).toBeNull();
    });

    it("returns a group's live approvals, one entry per call, held while unchanged", () => {
        const store = createStore();
        const pending = approval('a2', 'call-2');
        store.set(pendingApprovalsAtom, new Map([['a2', pending]]));
        const selector = pendingApprovalsForToolcallsAtom(['call-1', 'call-2']);
        const listener = vi.fn();
        store.sub(selector, listener);

        expect(store.get(selector)).toEqual([null, pending]);

        store.set(pendingApprovalsAtom, (prev) => new Map(prev).set('x1', approval('x1', 'call-3')));
        expect(listener).not.toHaveBeenCalled();
    });

    it("collects the live approvals among a run chain's actions, held while that membership is unchanged", () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [
            action('a1', 'call-1', 'run-1'),
            action('a2', 'call-2', 'run-2'),
            action('b1', 'call-3', 'run-other'),
        ]);
        store.set(pendingApprovalsAtom, new Map([['a2', approval('a2', 'call-2')]]));
        const selector = liveApprovalActionIdsForRunsAtom(['run-1', 'run-2']);
        const listener = vi.fn();
        store.sub(selector, listener);

        expect([...store.get(selector)]).toEqual(['a2']);

        store.set(pendingApprovalsAtom, (prev) => new Map(prev).set('b1', approval('b1', 'call-3')));
        expect(listener).not.toHaveBeenCalled();

        store.set(pendingApprovalsAtom, (prev) => new Map(prev).set('a1', approval('a1', 'call-1')));
        expect(listener).toHaveBeenCalledTimes(1);
        expect([...store.get(selector)].sort()).toEqual(['a1', 'a2']);
    });

    it('counts the pending approvals a switch to full access would answer', () => {
        const store = createStore();
        expect(store.get(pendingApprovalsCoveredByFullAccessCountAtom)).toBe(0);

        store.set(pendingApprovalsAtom, new Map([
            ['a1', approval('a1', 'call-1', 'edit_metadata')],
            ['a2', approval('a2', 'call-2', 'edit_metadata')],
        ]));
        expect(store.get(pendingApprovalsCoveredByFullAccessCountAtom)).toBe(2);
    });

    it('hands out new selectors after a reset, while readers of the old ones keep working', () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [action('a1', 'call-1')]);
        const before = agentActionsForToolcallAtom('call-1');

        resetAgentActionSelectorCaches();
        const after = agentActionsForToolcallAtom('call-1');
        store.set(updateAgentActionsAtom, [{ id: 'a1', status: 'applied' }]);

        expect(after).not.toBe(before);
        expect(store.get(before)[0].status).toBe('applied');
        expect(store.get(after)[0].status).toBe('applied');
    });
});
