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
    recordAttachmentResolutionAtom,
    threadAgentActionsAtom,
    upsertAgentActionsAtom,
    type AgentAction,
} from '../../../react/agents/agentActions';

const created = (id: string, attachmentStatus: string, status = 'applied'): AgentAction => ({
    id,
    run_id: 'run-1',
    toolcall_id: 'call-1',
    action_type: 'import_item',
    status,
    proposed_data: { item: { title: id } },
    result_data: { library_id: 1, zotero_key: `KEY-${id}`, attachment_status: attachmentStatus },
} as unknown as AgentAction);

describe('recordAttachmentResolutionAtom', () => {
    it("records a fetch's outcome on its pending action", () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [created('a', 'pending'), created('b', 'pending')]);

        store.set(recordAttachmentResolutionAtom, { actionId: 'a', attachmentStatus: 'available', attachmentKey: '1-PDFKEY' });

        const [a, b] = store.get(threadAgentActionsAtom);
        expect(a.result_data).toMatchObject({ attachment_status: 'available', attachment_key: '1-PDFKEY', zotero_key: 'KEY-a' });
        expect(a.result_data?.attachment_resolved_at).toEqual(expect.any(String));
        expect(b.result_data?.attachment_status).toBe('pending');
    });

    it('leaves the list alone for an action outside the thread, without an id, or already resolved', () => {
        const store = createStore();
        const actions = [created('a', 'failed'), created('b', 'pending', 'undone')];
        store.set(threadAgentActionsAtom, actions);

        store.set(recordAttachmentResolutionAtom, { actionId: 'other', attachmentStatus: 'available' });
        store.set(recordAttachmentResolutionAtom, { attachmentStatus: 'available' });
        store.set(recordAttachmentResolutionAtom, { actionId: 'a', attachmentStatus: 'available' });
        store.set(recordAttachmentResolutionAtom, { actionId: 'b', attachmentStatus: 'available' });

        expect(store.get(threadAgentActionsAtom)).toBe(actions);
    });
});

describe('upsertAgentActionsAtom and attachment outcomes', () => {
    it('keeps a recorded outcome when an update still reports the fetch as pending', () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [created('a', 'pending')]);
        store.set(recordAttachmentResolutionAtom, { actionId: 'a', attachmentStatus: 'available', attachmentKey: '1-PDFKEY' });

        store.set(upsertAgentActionsAtom, [created('a', 'pending')]);

        expect(store.get(threadAgentActionsAtom)[0].result_data)
            .toMatchObject({ attachment_status: 'available', attachment_key: '1-PDFKEY' });
    });

    it('takes a resolved outcome from an update', () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [created('a', 'pending')]);

        store.set(upsertAgentActionsAtom, [created('a', 'failed')]);

        expect(store.get(threadAgentActionsAtom)[0].result_data?.attachment_status).toBe('failed');
    });
});
