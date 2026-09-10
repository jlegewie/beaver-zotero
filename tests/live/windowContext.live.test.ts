import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { post } from '../helpers/zoteroHttpClient';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { NORMAL_PDF, SMALL_PDF } from '../helpers/fixtures';
import type { ApplicationStateInput } from '@beaver/agent-core/protocol/agentProtocol';
const path = '/beaver/test/window-runtime';
let available = false;
beforeAll(async () => { available = await isZoteroAvailable(); });

describe.runIf(process.env.BEAVER_MULTI_WINDOW_TEST === '1')('context in independent renderer bundles', () => {
    beforeEach(ctx => skipIfNoZotero(ctx, available));
    it('reveals items and snapshots selections only in the explicitly targeted window', async () => {
        const { windows } = await post<{ windows: { id: string }[] }>(path, { command: 'list' });
        expect(windows.length).toBeGreaterThanOrEqual(2);
        const [a, b] = windows;
        await post(path, { command: 'reveal', windowId: a.id, ...SMALL_PDF });
        await post(path, { command: 'reveal', windowId: b.id, ...NORMAL_PDF });
        const firstA = await post<ApplicationStateInput>(path, { command: 'context', windowId: a.id });
        const firstB = await post<ApplicationStateInput>(path, { command: 'context', windowId: b.id });
        expect(firstA.library_selection?.map(item => item.zotero_key)).toEqual([SMALL_PDF.zotero_key]);
        expect(firstB.library_selection?.map(item => item.zotero_key)).toEqual([NORMAL_PDF.zotero_key]);
        await post(path, { command: 'reveal', windowId: a.id, ...NORMAL_PDF });
        const afterB = await post<ApplicationStateInput>(path, { command: 'context', windowId: b.id });
        expect(afterB.library_selection).toEqual(firstB.library_selection);
    }, 30000);
});
