import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    uiManager,
    unwrapReaderWidthHandler,
    restoreReaderSidebarWidthHandler,
} from '../../../react/ui/UIManager';

const ORIGINAL_HANDLER_PROP = '__beaverOriginalSidebarWidthHandler';

/** Build a Beaver-style wrapper the way a previous plugin generation would. */
function makeTaggedWrapper(original: ((width: number) => void) | null): (width: number) => void {
    const wrapper = vi.fn((width: number) => {
        if (original) original(width);
    });
    (wrapper as any)[ORIGINAL_HANDLER_PROP] = original;
    return wrapper;
}

function installReaderStub(handler: unknown) {
    (globalThis as any).Zotero.Reader = {
        getSidebarWidth: vi.fn(() => 300),
        onChangeSidebarWidth: handler,
    };
    return (globalThis as any).Zotero.Reader;
}

/**
 * Mimic the wrapper shape installed by plugin versions that predate the
 * marker property: no tag, original held in instance state, and the two
 * identifying property accesses present in the source.
 */
function makeLegacyWrapper(): (width: number) => void {
    const _this: any = {
        originalOnChangeSidebarWidth: vi.fn(),
        enforceConsistentWidth: vi.fn(),
    };
    return function (width: number) {
        if (_this.originalOnChangeSidebarWidth) {
            _this.originalOnChangeSidebarWidth.call(null, width);
        }
        setTimeout(() => _this.enforceConsistentWidth(), 50);
    };
}

describe('reader sidebar width handler lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset the singleton's per-instance install state between tests.
        (uiManager as any).installedReaderWidthWrapper = null;
    });

    afterEach(() => {
        delete (globalThis as any).Zotero.Reader;
    });

    describe('unwrapReaderWidthHandler', () => {
        it('returns null for null, undefined, and non-functions', () => {
            expect(unwrapReaderWidthHandler(null)).toBeNull();
            expect(unwrapReaderWidthHandler(undefined)).toBeNull();
            expect(unwrapReaderWidthHandler({})).toBeNull();
        });

        it('returns an untagged handler unchanged', () => {
            const original = vi.fn();
            expect(unwrapReaderWidthHandler(original)).toBe(original);
        });

        it('unwinds a multi-generation wrapper chain to the base handler', () => {
            const base = vi.fn();
            const gen1 = makeTaggedWrapper(base);
            const gen2 = makeTaggedWrapper(gen1);
            const gen3 = makeTaggedWrapper(gen2);
            expect(unwrapReaderWidthHandler(gen3)).toBe(base);
        });

        it('returns null when the chain bottoms out at null', () => {
            const gen1 = makeTaggedWrapper(null);
            const gen2 = makeTaggedWrapper(gen1);
            expect(unwrapReaderWidthHandler(gen2)).toBeNull();
        });

        it('resolves a legacy (pre-marker) Beaver wrapper to null', () => {
            expect(unwrapReaderWidthHandler(makeLegacyWrapper())).toBeNull();
        });

        it('resolves a tagged chain bottoming out at a legacy wrapper to null', () => {
            const tagged = makeTaggedWrapper(makeLegacyWrapper());
            expect(unwrapReaderWidthHandler(tagged)).toBeNull();
        });
    });

    describe('restoreReaderSidebarWidthHandler', () => {
        it('no-ops when Zotero.Reader is unavailable', () => {
            expect(() => restoreReaderSidebarWidthHandler()).not.toThrow();
        });

        it('leaves a foreign (untagged) handler in place', () => {
            const foreign = vi.fn();
            const reader = installReaderStub(foreign);
            restoreReaderSidebarWidthHandler();
            expect(reader.onChangeSidebarWidth).toBe(foreign);
        });

        it('restores the base handler underneath a wrapper chain', () => {
            const base = vi.fn();
            const reader = installReaderStub(makeTaggedWrapper(makeTaggedWrapper(base)));
            restoreReaderSidebarWidthHandler();
            expect(reader.onChangeSidebarWidth).toBe(base);
        });

        it('restores null when no handler existed before the wrapper', () => {
            const reader = installReaderStub(makeTaggedWrapper(null));
            restoreReaderSidebarWidthHandler();
            expect(reader.onChangeSidebarWidth).toBeNull();
        });

        it('clears a bare legacy (pre-marker) wrapper left by an older plugin version', () => {
            const reader = installReaderStub(makeLegacyWrapper());
            restoreReaderSidebarWidthHandler();
            expect(reader.onChangeSidebarWidth).toBeNull();
        });
    });

    describe('initSidebarWidthTracking', () => {
        it('installs a tagged wrapper that chains to the pre-existing handler', () => {
            const base = vi.fn();
            const reader = installReaderStub(base);

            (uiManager as any).initSidebarWidthTracking();

            const installed = reader.onChangeSidebarWidth;
            expect(installed).not.toBe(base);
            expect((installed as any)[ORIGINAL_HANDLER_PROP]).toBe(base);

            installed(275);
            expect(base).toHaveBeenCalledWith(275);
        });

        it('does not reinstall while its own wrapper is still current', () => {
            const base = vi.fn();
            const reader = installReaderStub(base);

            (uiManager as any).initSidebarWidthTracking();
            const first = reader.onChangeSidebarWidth;
            (uiManager as any).initSidebarWidthTracking();

            expect(reader.onChangeSidebarWidth).toBe(first);
        });

        it('re-installs when another generation displaced its wrapper', () => {
            const base = vi.fn();
            const reader = installReaderStub(base);

            (uiManager as any).initSidebarWidthTracking();
            const own = reader.onChangeSidebarWidth;

            // Another window/generation wraps over us.
            const displacer = makeTaggedWrapper(own);
            reader.onChangeSidebarWidth = displacer;

            (uiManager as any).initSidebarWidthTracking();

            const reinstalled = reader.onChangeSidebarWidth;
            expect(reinstalled).not.toBe(displacer);
            expect(reinstalled).not.toBe(own);
            // The displaced chain is unwound to the true original, so neither
            // stale wrapper stays reachable from the reader slot.
            expect((reinstalled as any)[ORIGINAL_HANDLER_PROP]).toBe(base);

            reinstalled(280);
            expect(base).toHaveBeenCalledWith(280);
            expect(displacer).not.toHaveBeenCalled();
        });

        it('replaces a legacy (pre-marker) wrapper without chaining onto it', () => {
            const legacy = makeLegacyWrapper();
            const reader = installReaderStub(legacy);

            (uiManager as any).initSidebarWidthTracking();

            const installed = reader.onChangeSidebarWidth;
            expect(installed).not.toBe(legacy);
            expect((installed as any)[ORIGINAL_HANDLER_PROP]).toBeNull();
            expect(() => installed(310)).not.toThrow();
        });

        it('replaces a stale wrapper from a previous generation instead of chaining onto it', () => {
            const base = vi.fn();
            const staleWrapper = makeTaggedWrapper(base);
            const reader = installReaderStub(staleWrapper);

            (uiManager as any).initSidebarWidthTracking();

            const installed = reader.onChangeSidebarWidth;
            // The new wrapper must reference the true original, not the stale
            // wrapper — otherwise the stale generation stays reachable from
            // the long-lived Zotero.Reader and its compartment leaks.
            expect((installed as any)[ORIGINAL_HANDLER_PROP]).toBe(base);

            installed(320);
            expect(base).toHaveBeenCalledWith(320);
            expect(staleWrapper).not.toHaveBeenCalled();
        });

        it('cleanup() restores the original handler even when called on an instance that did not install the wrapper', () => {
            const base = vi.fn();
            // Simulate the other bundle copy's install: a tagged wrapper this
            // instance knows nothing about.
            const reader = installReaderStub(makeTaggedWrapper(base));

            uiManager.cleanup();

            expect(reader.onChangeSidebarWidth).toBe(base);
        });
    });
});
