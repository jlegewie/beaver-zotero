/**
 * Registry contract for the library-identity resolver seams: the object-id
 * resolver used by citation and note-reference parsing (citationGrammar.ts),
 * and the library-ref resolver that stamps a device-local library id with its
 * portable ref.
 *
 * `tests/setup.ts` registers the real Zotero resolvers globally so the rest of
 * the suite sees production behavior, so every test here resets the module
 * registry before importing — a plain static import would already be
 * registered by the time the test body runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNRESOLVED_LIBRARY_ID } from '@beaver/agent-core/identity/libraryRef';

describe('object-id resolver registry', () => {
    let originalLibraries: unknown;

    beforeEach(() => {
        vi.resetModules();
        // Give the personal library a real id, so a portable ref resolves to 1
        // through the Zotero resolver and to UNRESOLVED_LIBRARY_ID without it.
        // The two paths are indistinguishable otherwise, and these tests would
        // pass whether or not the module registry was actually reset.
        originalLibraries = (globalThis as any).Zotero?.Libraries;
        (globalThis as any).Zotero.Libraries = {
            ...(originalLibraries as object),
            userLibraryID: 1,
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero.Libraries = originalLibraries;
    });

    it('falls back to a pure parse of a portable ref when nothing is registered', async () => {
        const { resolveObjectIdReference } = await import('@beaver/agent-core/identity/libraryRef');

        expect(resolveObjectIdReference('u-ABCD1234')).toEqual({
            library_id: UNRESOLVED_LIBRARY_ID,
            library_ref: 'u',
            zotero_key: 'ABCD1234',
        });
        expect(resolveObjectIdReference('g42-ABCD1234')).toEqual({
            library_id: UNRESOLVED_LIBRARY_ID,
            library_ref: 'g42',
            zotero_key: 'ABCD1234',
        });
    });

    it('falls back to a pure parse of a legacy numeric ref when nothing is registered', async () => {
        const { resolveObjectIdReference } = await import('@beaver/agent-core/identity/libraryRef');

        expect(resolveObjectIdReference('1-ABCD1234')).toEqual({ library_id: 1, zotero_key: 'ABCD1234' });
    });

    it('returns null on malformed input when nothing is registered', async () => {
        const { resolveObjectIdReference } = await import('@beaver/agent-core/identity/libraryRef');

        expect(resolveObjectIdReference('ABC')).toBeNull();
        expect(resolveObjectIdReference('0-ABC')).toBeNull();
        expect(resolveObjectIdReference('1-')).toBeNull();
    });

    it('uses the registered resolver instead of the pure parse', async () => {
        const { setObjectIdResolver, resolveObjectIdReference } = await import('@beaver/agent-core/identity/libraryRef');
        const resolved = { library_id: 7, library_ref: 'g42', zotero_key: 'ABCD1234' };
        const resolver = vi.fn(() => resolved);

        setObjectIdResolver(resolver);

        expect(resolveObjectIdReference('g42-ABCD1234')).toBe(resolved);
        expect(resolver).toHaveBeenCalledWith('g42-ABCD1234');
    });
});

describe('library-ref resolver registry', () => {
    let originalLibraries: unknown;

    beforeEach(() => {
        vi.resetModules();
        // Give the personal library a real id, so library 1 resolves to 'u'
        // through the Zotero resolver and to null without it. The two paths are
        // indistinguishable otherwise, and the unregistered test would pass
        // whether or not the module registry was actually reset.
        originalLibraries = (globalThis as any).Zotero?.Libraries;
        (globalThis as any).Zotero.Libraries = {
            ...(originalLibraries as object),
            userLibraryID: 1,
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero.Libraries = originalLibraries;
    });

    // Both states are asserted against one module instance: the unregistered
    // null is only meaningful because the same instance answers 'u' once the
    // Zotero resolver is registered.
    it('returns null until the Zotero resolver is registered', async () => {
        const { resolveLibraryRefForLibraryID } = await import('@beaver/agent-core/identity/libraryRef');
        const { registerZoteroLibraryIdentity } = await import('../../../src/utils/libraryIdentity');

        expect(resolveLibraryRefForLibraryID(1)).toBeNull();

        registerZoteroLibraryIdentity();

        expect(resolveLibraryRefForLibraryID(1)).toBe('u');
    });

    it('uses the registered resolver', async () => {
        const { setLibraryRefResolver, resolveLibraryRefForLibraryID } = await import(
            '@beaver/agent-core/identity/libraryRef'
        );
        const resolver = vi.fn((libraryID: number) => (libraryID === 1 ? 'u' : null));

        setLibraryRefResolver(resolver);

        expect(resolveLibraryRefForLibraryID(1)).toBe('u');
        expect(resolveLibraryRefForLibraryID(7)).toBeNull();
        expect(resolver).toHaveBeenCalledWith(1);
    });
});
