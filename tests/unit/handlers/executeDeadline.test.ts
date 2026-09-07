import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const { executors, stub } = vi.hoisted(() => ({
    executors: { editMetadata: vi.fn() },
    stub: (name: string) => ({ [name]: vi.fn() }),
}));
vi.mock('../../../src/services/agentDataProvider/actions/editMetadata', () => ({
    executeEditMetadataAction: executors.editMetadata,
}));
vi.mock('../../../src/services/agentDataProvider/actions/editNote', () => stub('executeEditNoteAction'));
vi.mock('../../../src/services/agentDataProvider/actions/editNoteBatch', () => stub('executeEditNoteBatchAction'));
vi.mock('../../../src/services/agentDataProvider/actions/organizeItems', () => stub('executeOrganizeItemsAction'));
vi.mock('../../../src/services/agentDataProvider/actions/createNote', () => stub('executeCreateNoteAction'));
vi.mock('../../../src/services/agentDataProvider/actions/manageTags', () => stub('executeManageTagsAction'));
vi.mock('../../../src/services/agentDataProvider/actions/manageCollections', () => stub('executeManageCollectionsAction'));
vi.mock('../../../src/services/agentDataProvider/actions/createCollection', () => stub('executeCreateCollectionAction'));
vi.mock('../../../src/services/agentDataProvider/actions/createItems', () => stub('executeCreateItemAction'));
vi.mock('../../../src/services/agentDataProvider/actions/createHighlightAnnotations', () => stub('executeCreateHighlightAnnotationsAction'));
vi.mock('../../../src/services/agentDataProvider/actions/createNoteAnnotations', () => stub('executeCreateNoteAnnotationsAction'));
vi.mock('../../../src/services/agentDataProvider/actions/editAnnotations', () => stub('executeEditAnnotationsAction'));

import { handleAgentActionExecuteRequest } from '../../../src/services/agentDataProvider/handleAgentActionExecuteRequest';
import { checkAborted } from '../../../src/services/agentDataProvider/timeout';

const request = {
    event: 'agent_action_execute',
    request_id: 'req-1',
    action_type: 'edit_metadata',
    action_data: {},
    timeout_seconds: 10,
} as any;

describe('handleAgentActionExecuteRequest deadline', () => {
    beforeEach(() => {
        vi.useRealTimers();
        executors.editMetadata.mockReset();
    });

    it('gives the executor its full budget however long the request queued', async () => {
        // Arrived 12s ago with a 10s budget. The backend is still waiting on
        // it — acks and keepalives told it so — and the queue wait is not the
        // executor's to pay for, so the save goes ahead.
        const receivedAt = Date.now() - 12_000;
        executors.editMetadata.mockImplementation(async (_req, ctx) => {
            checkAborted(ctx, 'edit_metadata:before_save');
            return { type: 'agent_action_execute_response', request_id: 'req-1', success: true };
        });

        const response = await handleAgentActionExecuteRequest(request, { receivedAt, reportPhase: () => {} });

        expect(response.success).toBe(true);
        // The wait is still reported, just not charged.
        expect(response.timing?.queued_ms).toBeGreaterThanOrEqual(12_000);
        expect(response.timing?.total_ms).toBeGreaterThanOrEqual(12_000);
    });

    it('aborts before a write once the executor has spent its own budget', async () => {
        executors.editMetadata.mockImplementation(async (_req, ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            checkAborted(ctx, 'edit_metadata:before_save');
            return { type: 'agent_action_execute_response', request_id: 'req-1', success: true };
        });

        const response = await handleAgentActionExecuteRequest(
            { ...request, timeout_seconds: 0.02 },
            { receivedAt: Date.now(), reportPhase: () => {} },
        );

        expect(response.success).toBe(false);
        expect(response.error_code).toBe('timeout');
        expect(response.result_data?.phase).toBe('edit_metadata:before_save');
    });

    it('passes the executor its own start time and the phase reporter', async () => {
        const receivedAt = Date.now() - 2_000;
        const reportPhase = vi.fn();
        let seenCtx: any;
        executors.editMetadata.mockImplementation(async (_req, ctx) => {
            seenCtx = ctx;
            ctx.reportPhase?.('saving');
            return {
                type: 'agent_action_execute_response',
                request_id: 'req-1',
                success: true,
                timing: { save_ms: 5 },
            };
        });

        const response = await handleAgentActionExecuteRequest(request, { receivedAt, reportPhase });

        // Handler start, not socket receipt: the deadline and the elapsed time
        // reported with a timeout both have to mean the executor's own work.
        expect(seenCtx.startTime).toBeGreaterThanOrEqual(receivedAt + 2_000);
        expect(seenCtx.timeoutSeconds).toBe(10);
        expect(seenCtx.signal.aborted).toBe(false);
        expect(reportPhase).toHaveBeenCalledWith('saving');
        // Executor timing is preserved and the transport-level phases are added
        expect(response.timing?.save_ms).toBe(5);
        expect(response.timing?.queued_ms).toBeGreaterThanOrEqual(2_000);
        expect(response.timing?.total_ms).toBeGreaterThanOrEqual(2_000);
    });

    it('falls back to handler start when no context is given', async () => {
        executors.editMetadata.mockImplementation(async (_req, ctx) => {
            checkAborted(ctx, 'edit_metadata:before_save');
            return { type: 'agent_action_execute_response', request_id: 'req-1', success: true };
        });

        const response = await handleAgentActionExecuteRequest(request);

        expect(response.success).toBe(true);
        expect(response.timing?.queued_ms).toBe(0);
    });
});
