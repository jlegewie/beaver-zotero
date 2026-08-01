/**
 * Registry contract for the object-id resolver seam used by citation and
 * note-reference parsing (citationGrammar.ts).
 *
 * `tests/setup.ts` registers the real Zotero resolver globally so the rest of
 * the suite sees production behavior, so every test here resets the module
 * registry before importing — a plain static import would already be
 * registered by the time the test body runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryRef';

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
        const { resolveObjectIdReference } = await import('../../../src/utils/libraryRef');

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
        const { resolveObjectIdReference } = await import('../../../src/utils/libraryRef');

        expect(resolveObjectIdReference('1-ABCD1234')).toEqual({ library_id: 1, zotero_key: 'ABCD1234' });
    });

    it('returns null on malformed input when nothing is registered', async () => {
        const { resolveObjectIdReference } = await import('../../../src/utils/libraryRef');

        expect(resolveObjectIdReference('ABC')).toBeNull();
        expect(resolveObjectIdReference('0-ABC')).toBeNull();
        expect(resolveObjectIdReference('1-')).toBeNull();
    });

    it('uses the registered resolver instead of the pure parse', async () => {
        const { setObjectIdResolver, resolveObjectIdReference } = await import('../../../src/utils/libraryRef');
        const resolved = { library_id: 7, library_ref: 'g42', zotero_key: 'ABCD1234' };
        const resolver = vi.fn(() => resolved);

        setObjectIdResolver(resolver);

        expect(resolveObjectIdReference('g42-ABCD1234')).toBe(resolved);
        expect(resolver).toHaveBeenCalledWith('g42-ABCD1234');
    });
});
