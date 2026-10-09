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

describe('plugin reload while the previous instance is still shutting down', () => {
    const ADDON_DISABLE = 4;

    function makeHost({ slowStartup = false } = {}) {
        const handles: { destruct: ReturnType<typeof vi.fn> }[] = [];
        const instances: any[] = [];
        const pendingShutdowns: (() => void)[] = [];
        const pendingStartups: (() => void)[] = [];
        const zotero: any = {
            initializationPromise: Promise.resolve(),
            Promise: { delay: () => new Promise(() => {}) },
            logError: vi.fn(),
            debug: vi.fn(),
        };
        const makeInstance = () => {
            // Like the real hook, repeated calls share one disposal.
            let disposal: Promise<void> | undefined;
            const instance = {
                hooks: {
                    onStartup: vi.fn(() => slowStartup
                        ? new Promise<void>(resolve => { pendingStartups.push(resolve); })
                        : Promise.resolve()),
                    onShutdown: vi.fn(() => disposal ??= new Promise<void>(resolve => { pendingShutdowns.push(resolve); })),
                },
            };
            instances.push(instance);
            return instance;
        };
        const context = () => ({
            Zotero: zotero,
            APP_SHUTDOWN: 2,
            Components: {
                classes: {
                    '@mozilla.org/addons/addon-manager-startup;1': {
                        getService: () => ({
                            registerChrome: () => {
                                const handle = { destruct: vi.fn() };
                                handles.push(handle);
                                return handle;
                            },
                        }),
                    },
                },
                interfaces: { amIAddonManagerStartup: {} },
            },
            Services: {
                io: { newURI: (uri: string) => uri },
                scriptloader: { loadSubScript: () => { zotero.__addonInstance__ = makeInstance(); } },
            },
        });
        return { zotero, handles, instances, context, finish: () => pendingShutdowns.splice(0).forEach(resolve => resolve()),
            finishStartup: () => pendingStartups.splice(0).forEach(resolve => resolve()) };
    }

    // Disabling and re-enabling reuses the plugin's bootstrap scope, while an
    // update loads a new one; both must wait for the previous teardown.
    it.each(['shared', 'separate'])('starts the new instance only after the old shutdown completes (%s scope)', async scopeKind => {
        const host = makeHost();
        const oldScope = host.context();
        runInNewContext(source, oldScope);
        await (oldScope as any).startup({ rootURI: 'jar:beaver/' }, 1);
        const oldInstance = host.instances[0];

        const shutdown = (oldScope as any).shutdown({}, ADDON_DISABLE);
        const newScope = scopeKind === 'shared' ? oldScope : host.context();
        if (newScope !== oldScope) runInNewContext(source, newScope);
        const startup = (newScope as any).startup({ rootURI: 'jar:beaver/' }, 3);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(host.instances).toHaveLength(1);
        host.finish();
        await shutdown;
        await startup;

        const newInstance = host.instances[1];
        expect(oldInstance.hooks.onShutdown).toHaveBeenCalledOnce();
        expect(newInstance.hooks.onStartup).toHaveBeenCalledOnce();
        expect(host.zotero.__addonInstance__).toBe(newInstance);
        expect(host.handles[0].destruct).toHaveBeenCalledOnce();
        expect(host.handles[1].destruct).not.toHaveBeenCalled();
        expect(host.zotero.__beaverBootstrapShutdown).toBeUndefined();
    });

    it('starts anyway when the previous shutdown never settles', async () => {
        const host = makeHost();
        host.zotero.Promise.delay = () => Promise.resolve();
        const oldScope = host.context();
        runInNewContext(source, oldScope);
        await (oldScope as any).startup({ rootURI: 'jar:beaver/' }, 1);

        void (oldScope as any).shutdown({}, ADDON_DISABLE);
        const newScope = host.context();
        runInNewContext(source, newScope);
        await (newScope as any).startup({ rootURI: 'jar:beaver/' }, 3);

        expect(host.instances[1].hooks.onStartup).toHaveBeenCalledOnce();
        expect(host.zotero.logError).toHaveBeenCalled();
    });

    it.each(['shared', 'separate'])('cancels a waiting startup when the plugin is disabled again (%s scope)', async scopeKind => {
        const host = makeHost();
        const oldScope = host.context();
        runInNewContext(source, oldScope);
        await (oldScope as any).startup({ rootURI: 'jar:beaver/' }, 1);

        const firstShutdown = (oldScope as any).shutdown({}, ADDON_DISABLE);
        const newScope = scopeKind === 'shared' ? oldScope : host.context();
        if (newScope !== oldScope) runInNewContext(source, newScope);
        const startup = (newScope as any).startup({ rootURI: 'jar:beaver/' }, 3);
        const secondShutdown = (newScope as any).shutdown({}, ADDON_DISABLE);
        host.finish();
        await Promise.all([firstShutdown, startup, secondShutdown]);

        expect(host.instances).toHaveLength(1);
        expect(host.handles).toHaveLength(1);
        expect(host.zotero.__addonInstance__).toBeUndefined();
        expect(host.zotero.__beaverBootstrapShutdown).toBeUndefined();
    });

    it('lets an in-flight startup finish before tearing the instance down', async () => {
        const host = makeHost({ slowStartup: true });
        const scope = host.context();
        runInNewContext(source, scope);
        const startup = (scope as any).startup({ rootURI: 'jar:beaver/' }, 1);
        await new Promise(resolve => setTimeout(resolve, 0));
        const instance = host.instances[0];
        expect(instance.hooks.onStartup).toHaveBeenCalledOnce();

        const shutdown = (scope as any).shutdown({}, ADDON_DISABLE);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(instance.hooks.onShutdown).not.toHaveBeenCalled();

        host.finishStartup();
        await startup;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(instance.hooks.onShutdown).toHaveBeenCalledOnce();
        host.finish();
        await shutdown;

        expect(host.zotero.__addonInstance__).toBeUndefined();
        expect(host.handles[0].destruct).toHaveBeenCalledOnce();
        expect(host.zotero.__beaverBootstrapStartup).toBeUndefined();
    });

    it('shuts down anyway when an in-flight startup never settles', async () => {
        const host = makeHost({ slowStartup: true });
        const scope = host.context();
        runInNewContext(source, scope);
        void (scope as any).startup({ rootURI: 'jar:beaver/' }, 1);
        await new Promise(resolve => setTimeout(resolve, 0));
        host.zotero.Promise.delay = () => Promise.resolve();

        const shutdown = (scope as any).shutdown({}, ADDON_DISABLE);
        await new Promise(resolve => setTimeout(resolve, 0));
        host.finish();
        await shutdown;

        expect(host.instances[0].hooks.onShutdown).toHaveBeenCalledOnce();
        expect(host.zotero.logError).toHaveBeenCalled();
        expect(host.zotero.__addonInstance__).toBeUndefined();
    });
});
