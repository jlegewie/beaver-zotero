/**
 * The default runtime adapter is the only thing standing between shared code
 * and the `Zotero` global, so it has to degrade rather than throw when a host
 * reports nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeAdapter } from '../../../src/platform/runtime';

const zoteroAdapter = getRuntimeAdapter();

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the Zotero runtime adapter', () => {
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
