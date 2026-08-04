/**
 * The Zotero-backed runtime adapter (`registerZoteroRuntime`) and the guarantee
 * that `src/utils/prefs.ts` installs it merely by being imported — the seam
 * this module registers is read at MODULE SCOPE by some preference-backed
 * atoms (`react/atoms/ui.ts`, `react/atoms/models.ts`), so it cannot rely on
 * an explicit call ordered correctly among a bundle entry's other imports.
 * See the comment on the `registerZoteroRuntime()` call in `prefs.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeAdapter, type RuntimeAdapter } from '@beaver/agent-core/platform/runtime';
import { registerZoteroRuntime } from '../../../src/platform/zoteroRuntime';

describe('the Zotero runtime adapter', () => {
    let zoteroAdapter: RuntimeAdapter;

    beforeAll(() => {
        registerZoteroRuntime();
        zoteroAdapter = getRuntimeAdapter();
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('getPref / setPref / clearPref', () => {
        it('routes getPref through Zotero.Prefs with the global-pref flag', () => {
            zoteroAdapter.getPref('extensions.beaver.mcpServerEnabled');
            expect(Zotero.Prefs.get).toHaveBeenCalledWith('extensions.beaver.mcpServerEnabled', true);
        });

        it('routes setPref through Zotero.Prefs with the global-pref flag', () => {
            zoteroAdapter.setPref('extensions.beaver.mcpServerEnabled', true);
            expect(Zotero.Prefs.set).toHaveBeenCalledWith('extensions.beaver.mcpServerEnabled', true, true);
        });

        it('routes clearPref through Zotero.Prefs with the global-pref flag', () => {
            zoteroAdapter.clearPref('extensions.beaver.mcpServerEnabled');
            expect(Zotero.Prefs.clear).toHaveBeenCalledWith('extensions.beaver.mcpServerEnabled', true);
        });
    });

    describe('hostVersion', () => {
        it('reports the Zotero version', () => {
            vi.stubGlobal('Zotero', { version: '7.0.99' });

            expect(zoteroAdapter.hostVersion?.()).toBe('7.0.99');
        });

        it('reports nothing when the version is not a string', () => {
            vi.stubGlobal('Zotero', { version: 7 });

            expect(zoteroAdapter.hostVersion?.()).toBe('');
        });
    });

    describe('getVersionHeaders', () => {
        it('sources the host header from the reported host version', () => {
            vi.stubGlobal('Zotero', { version: '7.0.99', Beaver: { pluginVersion: '0.22.5' } });

            expect(zoteroAdapter.getVersionHeaders?.()).toEqual({
                'X-Zotero-Version': '7.0.99',
                'X-Beaver-Version': '0.22.5',
            });
        });

        it('omits each header the host cannot report', () => {
            vi.stubGlobal('Zotero', { Beaver: {} });

            expect(zoteroAdapter.getVersionHeaders?.()).toEqual({});
        });
    });
});

describe('registration ordering guarantee', () => {
    it('is installed as a side effect of importing src/utils/prefs.ts', async () => {
        vi.resetModules();

        const runtimeModule = await import('@beaver/agent-core/platform/runtime');
        // Sanity check: a fresh runtime module starts unregistered.
        expect(() => runtimeModule.getRuntimeAdapter().getPref('sanity.key')).toThrow();

        // Importing prefs.ts for its exports must register the Zotero adapter
        // as a side effect — this is the invariant every module-scope
        // `getPref()` caller (e.g. react/atoms/ui.ts) depends on.
        await import('../../../src/utils/prefs');

        expect(() => runtimeModule.getRuntimeAdapter().getPref('sanity.key')).not.toThrow();
    });

    it('leaves an adapter a host already registered in place', async () => {
        vi.resetModules();

        const runtimeModule = await import('@beaver/agent-core/platform/runtime');
        const hostAdapter = {
            debug: () => {},
            isDevelopment: () => false,
            getPref: () => 'host',
            setPref: () => {},
            clearPref: () => {},
        };
        runtimeModule.setRuntimeAdapter(hostAdapter);

        // Reaching prefs.ts indirectly must not cost a non-Zotero host its own
        // adapter, whichever order the two installs happen in.
        await import('../../../src/utils/prefs');

        expect(runtimeModule.getRuntimeAdapter()).toBe(hostAdapter);
    });

    it('still installs after an adapter was set and then restored', async () => {
        vi.resetModules();

        const runtimeModule = await import('@beaver/agent-core/platform/runtime');
        const original = runtimeModule.getRuntimeAdapter();
        runtimeModule.setRuntimeAdapter({
            debug: () => {},
            isDevelopment: () => false,
            getPref: () => 'swapped',
            setPref: () => {},
            clearPref: () => {},
        });
        runtimeModule.setRuntimeAdapter(original);

        // "Already installed" is derived from the active adapter, not latched
        // on the first call, so restoring the default re-arms the install.
        const prefs = await import('../../../src/utils/prefs');

        expect(() => prefs.getPref('mcpServerEnabled')).not.toThrow();
    });
});
