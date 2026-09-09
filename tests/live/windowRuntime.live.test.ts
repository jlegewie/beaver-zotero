import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { post } from '../helpers/zoteroHttpClient';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';

const path = '/beaver/test/window-runtime';
interface RuntimeState { id: string; draft: string; visible: boolean; roots: number }
let available = false;
beforeAll(async () => { available = await isZoteroAvailable(); });

async function list() {
    return (await post<{ windows: { id: string; status: string }[] }>(path, { command: 'list' })).windows;
}

describe('window runtime diagnostics', () => {
    beforeEach(ctx => skipIfNoZotero(ctx, available));

    it('enumerates stable ready ids and resolves a command to that renderer', async () => {
        const windows = await list();
        expect(windows.length).toBeGreaterThan(0);
        expect(new Set(windows.map(w => w.id)).size).toBe(windows.length);
        for (const win of windows) {
            expect(win.status).toBe('ready');
            const state = await post<RuntimeState>(path, { windowId: win.id });
            expect(state.id).toBe(win.id);
            expect(state.roots).toBeGreaterThanOrEqual(4);
        }
        expect(await list()).toEqual(windows);
    });

    it('rejects a missing target rather than falling back to the focused window', async () => {
        expect(await post(path, { windowId: 'missing-runtime' })).toEqual({ error: 'window_unavailable' });
    });

    it.runIf(process.env.BEAVER_MULTI_WINDOW_TEST === '1')('keeps drafts independent in two evaluated main-window bundles', async () => {
        const windows = await list();
        expect(windows.length).toBeGreaterThanOrEqual(2);
        const [a, b] = windows;
        const beforeA = await post<RuntimeState>(path, { windowId: a.id });
        const beforeB = await post<RuntimeState>(path, { windowId: b.id });
        try {
            await post(path, { command: 'draft', windowId: a.id, draft: 'Runtime A validation draft' });
            await post(path, { command: 'draft', windowId: b.id, draft: 'Runtime B validation draft' });
            expect((await post<RuntimeState>(path, { windowId: a.id })).draft).toBe('Runtime A validation draft');
            expect((await post<RuntimeState>(path, { windowId: b.id })).draft).toBe('Runtime B validation draft');
        } finally {
            await post(path, { command: 'draft', windowId: a.id, draft: beforeA.draft });
            await post(path, { command: 'draft', windowId: b.id, draft: beforeB.draft });
        }
    });
});
