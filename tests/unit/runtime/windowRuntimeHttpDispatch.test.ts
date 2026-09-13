import { expect, it, vi } from 'vitest';
import { handleTestWindowRuntimeHttpRequest } from '../../../src/services/localEndpoints/handlers/testUiHandlers';

it('forwards thread commands to the resolved renderer through the instance dispatcher', async () => {
    const runtime = { id: 'window-A', status: 'ready', hostWindow: { closed: false } };
    const dispatchWindowCommand = vi.fn().mockResolvedValue({ ok: true });
    (Zotero as any).Beaver = { runtime: {
        resolveWindow: vi.fn().mockReturnValue(runtime),
        dispatchWindowCommand,
    } };

    expect(await handleTestWindowRuntimeHttpRequest({
        windowId: 'window-A', command: 'load-thread', threadId: 'thread-A', text: 'draft text',
    })).toEqual({ ok: true });
    expect(dispatchWindowCommand).toHaveBeenCalledWith('inspect-runtime', expect.objectContaining({
        windowId: 'window-A', command: 'load-thread', threadId: 'thread-A', text: 'draft text',
    }));
});
