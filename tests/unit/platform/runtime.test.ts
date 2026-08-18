/**
 * The unregistered default adapter is installed before any host registers its
 * own. `debug`/`isDevelopment` degrade silently (no host to log to is normal),
 * but `getPref`/`setPref`/`clearPref` must fail loudly rather than silently
 * returning `undefined` or discarding a write — see `runtime.ts`.
 *
 * Nothing evaluated in this file's module registry — its own imports or
 * `tests/setup.ts` — may reach `src/utils/prefs.ts`, which installs the
 * Zotero-backed adapter as a side effect (see `zoteroRuntime.test.ts` for that
 * behavior). If it does, the assertions below fail on the adapter they find
 * rather than on the default they mean to test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeAdapter, setRuntimeAdapter, type RuntimeAdapter } from '@beaver/agent-core/platform/runtime';

describe('the unregistered default runtime adapter', () => {
    it('reports not running a development build', () => {
        expect(getRuntimeAdapter().isDevelopment()).toBe(false);
    });

    it('does not throw on debug', () => {
        expect(() => getRuntimeAdapter().debug('test message')).not.toThrow();
    });

    it('throws on getPref instead of returning undefined', () => {
        expect(() => getRuntimeAdapter().getPref('some.key')).toThrow();
    });

    it('throws on setPref instead of silently discarding the write', () => {
        expect(() => getRuntimeAdapter().setPref('some.key', 'value')).toThrow();
    });

    it('throws on clearPref instead of silently no-oping', () => {
        expect(() => getRuntimeAdapter().clearPref('some.key')).toThrow();
    });

    it('omits hostVersion and getVersionHeaders (nothing to report)', () => {
        const adapter = getRuntimeAdapter();
        expect(adapter.hostVersion).toBeUndefined();
        expect(adapter.getVersionHeaders).toBeUndefined();
    });
});

describe('setRuntimeAdapter / getRuntimeAdapter', () => {
    const originalAdapter = getRuntimeAdapter();

    afterEach(() => {
        setRuntimeAdapter(originalAdapter);
    });

    it('replaces the active adapter', () => {
        const custom: RuntimeAdapter = {
            debug: () => {},
            isDevelopment: () => true,
            getPref: () => 'custom-value',
            setPref: () => {},
            clearPref: () => {},
        };

        setRuntimeAdapter(custom);

        expect(getRuntimeAdapter()).toBe(custom);
        expect(getRuntimeAdapter().getPref('any.key')).toBe('custom-value');
    });
});
