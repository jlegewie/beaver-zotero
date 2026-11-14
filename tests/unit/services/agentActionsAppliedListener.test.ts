import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActionsService } from '@beaver/agent-core/transport/clients/agentActionsService';
import { ApiService } from '@beaver/agent-core/transport/apiService';

describe('agent actions applied-write listener', () => {
    let service: AgentActionsService;
    let listener: ReturnType<typeof vi.fn>;
    let post: ReturnType<typeof vi.spyOn>;
    let patch: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        service = new AgentActionsService('http://backend.test');
        listener = vi.fn();
        service.onAppliedWrite(listener);
        post = vi.spyOn(service as any, 'post').mockResolvedValue({ success: true, run_id: 'r', updated: 1, errors: [] });
        patch = vi.spyOn(ApiService.prototype as any, 'patch').mockResolvedValue({ success: true, updated: 1, errors: [] });
    });

    afterEach(() => {
        service.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('runs after a successful acknowledgement', async () => {
        await service.acknowledgeActions('r', [{ action_id: 'a', result_data: {} as any }]);
        expect(post).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not run when the acknowledgement fails', async () => {
        post.mockRejectedValueOnce(new Error('offline'));
        await expect(service.acknowledgeActions('r', [])).rejects.toThrow('offline');
        expect(listener).not.toHaveBeenCalled();
    });

    it('runs after a batched update that marks an action applied', async () => {
        const update = service.updateAction('a', { status: 'applied' });
        await vi.advanceTimersByTimeAsync(100);
        await update;
        expect(patch).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it.each(['rejected', 'undone', 'error'] as const)('does not run for a %s status write', async (status) => {
        const update = service.updateAction('a', { status });
        await vi.advanceTimersByTimeAsync(100);
        await update;
        expect(patch).toHaveBeenCalledTimes(1);
        expect(listener).not.toHaveBeenCalled();
    });

    it('stops running once unregistered, and a throwing listener does not fail the write', async () => {
        const remove = service.onAppliedWrite(() => {
            throw new Error('listener bug');
        });
        await service.acknowledgeActions('r', []);
        expect(listener).toHaveBeenCalledTimes(1);
        const removeListener = service.onAppliedWrite(listener);
        remove();
        removeListener();
        await service.acknowledgeActions('r', []);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
