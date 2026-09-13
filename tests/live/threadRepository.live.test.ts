import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { post } from '../helpers/zoteroHttpClient';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';

// A disposable persisted chat; no messages are sent or library items changed.
const threadId = process.env.BEAVER_THREAD_TEST_ID;
const endpoint = '/beaver/test/window-runtime';
let available = false;
beforeAll(async () => { available = await isZoteroAvailable(); });
interface State { id: string; threadId: string | null; name: string | null; draft: string }
interface Entity { id: string; name: string; isPinned: boolean }
describe.runIf(!!threadId)('shared repository in independently evaluated Zotero windows', () => {
    beforeEach(ctx => skipIfNoZotero(ctx, available));
    it('hydrates one persisted chat into two local caches and preserves both drafts on refresh', async () => {
        const { windows } = await post<{ windows: { id: string }[] }>(endpoint, { command: 'list' });
        expect(windows.length).toBeGreaterThanOrEqual(2);
        const targets = windows.slice(0, 2);
        const before = await Promise.all(targets.map(target => post<State>(endpoint, { command: 'thread-state', windowId: target.id })));
        try {
            for (let i = 0; i < targets.length; i++) {
                await post(endpoint, { command: 'draft', windowId: targets[i].id, draft: `Independent draft ${i}` });
            }
            const loaded = await Promise.all(targets.map(target => post(endpoint, { command: 'thread-load', windowId: target.id, threadId })));
            expect(loaded).toEqual([true, true]);
            const states = await Promise.all(targets.map(target => post<State>(endpoint, { command: 'thread-state', windowId: target.id })));
            expect(states.map(state => state.draft)).toEqual(['Independent draft 0', 'Independent draft 1']);
            expect(states.map(state => state.threadId)).toEqual([threadId, threadId]);
            const caches = await Promise.all(targets.map(target => post<{ entities: Entity[] }>(endpoint, { command: 'thread-cache', windowId: target.id })));
            const rows = caches.map(cache => cache.entities.find(row => row.id === threadId));
            expect(rows[0]).toBeDefined();
            expect(rows[1]).toEqual(rows[0]);
            expect(states.map(state => state.name)).toEqual([rows[0]!.name, rows[0]!.name]);
        } finally {
            for (const state of before) await post(endpoint, { command: 'draft', windowId: state.id, draft: state.draft });
        }
    });
});
