import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    unwrapReaderWidthHandler,
    restoreReaderSidebarWidthHandler,
} from '../../../src/runtime/readerWidth';

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

});
