import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../addon/bootstrap.js', import.meta.url), 'utf8');

describe('application shutdown without main windows', () => {
    it('runs service disposal before the database fallback', async () => {
        const order: string[] = [];
        const closeDatabase = vi.fn(async () => { order.push('database'); });
        const onAppShutdown = vi.fn(async () => { order.push('services'); });
        const onShutdown = vi.fn();
        const addon = { hooks: { onAppShutdown, onShutdown }, db: { closeDatabase } };
        const context = { Zotero: { __addonInstance__: addon }, APP_SHUTDOWN: 2 };
        runInNewContext(source, context);
        await (context as any).shutdown({}, 2);
        expect(order).toEqual(['services', 'database']);
        expect(onShutdown).not.toHaveBeenCalled();
        expect(addon.db).toBeUndefined();
    });

    it('closes the database even when service disposal fails', async () => {
        const closeDatabase = vi.fn().mockResolvedValue(undefined);
        const addon = {
            hooks: { onAppShutdown: vi.fn().mockRejectedValue(new Error('service failure')) },
            db: { closeDatabase },
        };
        const context = { Zotero: { __addonInstance__: addon }, APP_SHUTDOWN: 2 };
        runInNewContext(source, context);
        await (context as any).shutdown({}, 2);
        expect(closeDatabase).toHaveBeenCalledOnce();
        expect(addon.db).toBeUndefined();
    });
});
