import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LIBRARY_REF_PATTERN,
    UNRESOLVED_LIBRARY_ID,
    libraryRefForLibraryID,
    modelObjectId,
    modelObjectIdFromReference,
    parseLibraryRef,
    parseItemReference,
    resolveLibraryRef,
    resolveObjectId,
    resolveItemReference,
    resolveWriteTargetLibrary,
} from '../../../src/utils/libraryIdentity';

describe('libraryIdentity', () => {
    const zotero = (globalThis as any).Zotero;
    const getGroupIDFromLibraryID = vi.fn();
    const getLibraryIDFromGroupID = vi.fn();
    const getByLibraryAndKeyAsync = vi.fn();

    beforeEach(() => {
        getGroupIDFromLibraryID.mockReset();
        getLibraryIDFromGroupID.mockReset();
        getByLibraryAndKeyAsync.mockReset();
        zotero.Libraries = { ...zotero.Libraries, userLibraryID: 1 };
        zotero.Groups = { getGroupIDFromLibraryID, getLibraryIDFromGroupID };
        zotero.Items = { ...zotero.Items, getByLibraryAndKeyAsync };
    });

    describe('libraryRefForLibraryID', () => {
        it('returns "u" for the personal library', () => {
            expect(libraryRefForLibraryID(1)).toBe('u');
        });

        it('returns "g<groupID>" for a group library', () => {
            getGroupIDFromLibraryID.mockReturnValue(42);
            expect(libraryRefForLibraryID(7)).toBe('g42');
            expect(getGroupIDFromLibraryID).toHaveBeenCalledWith(7);
        });

        it('returns null for the external-file sentinel (-1)', () => {
            expect(libraryRefForLibraryID(-1)).toBeNull();
            expect(getGroupIDFromLibraryID).not.toHaveBeenCalled();
        });

        it('returns null when the group lookup throws (feed library, unknown library)', () => {
            getGroupIDFromLibraryID.mockImplementation(() => {
                throw new Error('Group not found');
            });
            expect(libraryRefForLibraryID(99)).toBeNull();
        });

        it('returns null when the group lookup returns a falsy id', () => {
            getGroupIDFromLibraryID.mockReturnValue(false);
            expect(libraryRefForLibraryID(7)).toBeNull();
        });

        it('returns null for a malformed group id rather than emit a non-grammar ref', () => {
            // A non-integer or negative id would stringify to "g1.5" / "g-3",
            // which the backend rejects wholesale; degrade to null instead.
            getGroupIDFromLibraryID.mockReturnValue(1.5);
            expect(libraryRefForLibraryID(7)).toBeNull();
            getGroupIDFromLibraryID.mockReturnValue(-3);
            expect(libraryRefForLibraryID(7)).toBeNull();
        });
    });

    describe('parseLibraryRef', () => {
        it('parses "u" as the personal library', () => {
            expect(parseLibraryRef('u')).toEqual({ type: 'user' });
        });

        it('parses "g<id>" as a group library', () => {
            expect(parseLibraryRef('g42')).toEqual({ type: 'group', groupID: 42 });
            expect(parseLibraryRef('g1')).toEqual({ type: 'group', groupID: 1 });
        });

        it('rejects "g0" (group ids start at 1)', () => {
            expect(parseLibraryRef('g0')).toBeNull();
        });

        it('rejects "user" (not the grammar)', () => {
            expect(parseLibraryRef('user')).toBeNull();
        });

        it('rejects a bare number', () => {
            expect(parseLibraryRef('1')).toBeNull();
        });

        it('rejects a leading-zero group id', () => {
            expect(parseLibraryRef('g042')).toBeNull();
        });

        it('rejects an empty string', () => {
            expect(parseLibraryRef('')).toBeNull();
        });

        it('matches the exported pattern directly', () => {
            expect(LIBRARY_REF_PATTERN.test('u')).toBe(true);
            expect(LIBRARY_REF_PATTERN.test('g5')).toBe(true);
            expect(LIBRARY_REF_PATTERN.test('g0')).toBe(false);
            expect(LIBRARY_REF_PATTERN.test('G5')).toBe(false);
        });
    });

    describe('parseItemReference', () => {
        it('parses a portable personal-library id', () => {
            expect(parseItemReference('u-ABCD1234')).toEqual({ library_ref: 'u', zotero_key: 'ABCD1234' });
        });

        it('parses a portable group-library id', () => {
            expect(parseItemReference('g12345-ABCD1234')).toEqual({ library_ref: 'g12345', zotero_key: 'ABCD1234' });
        });

        it('parses a legacy numeric id', () => {
            expect(parseItemReference('5-ABCD1234')).toEqual({ library_id: 5, zotero_key: 'ABCD1234' });
        });

        it('returns null for a leading hyphen (empty prefix)', () => {
            expect(parseItemReference('-ABCD1234')).toBeNull();
        });

        it('returns null for a trailing hyphen (empty key)', () => {
            expect(parseItemReference('u-')).toBeNull();
        });

        it('returns null for a non-numeric, non-ref prefix', () => {
            expect(parseItemReference('foo-ABCD1234')).toBeNull();
        });

        it('returns null for a mixed alphanumeric numeric prefix (parseInt would accept "5abc" as 5)', () => {
            expect(parseItemReference('5abc-ABCD1234')).toBeNull();
        });

        it('returns null when there is no hyphen', () => {
            expect(parseItemReference('ABCD1234')).toBeNull();
        });

        it('rejects a zero / negative numeric prefix', () => {
            expect(parseItemReference('0-ABCD1234')).toBeNull();
        });
    });

    describe('resolveLibraryRef', () => {
        it('resolves "u" to this device\'s personal library', () => {
            expect(resolveLibraryRef({ library_ref: 'u', library_id: 999 })).toBe(1);
        });

        it('resolves "g<id>" via the local group registry', () => {
            getLibraryIDFromGroupID.mockReturnValue(7);
            expect(resolveLibraryRef({ library_ref: 'g42', library_id: 999 })).toBe(7);
            expect(getLibraryIDFromGroupID).toHaveBeenCalledWith(42);
        });

        it('returns null when the group is not registered on this device', () => {
            getLibraryIDFromGroupID.mockReturnValue(false);
            expect(resolveLibraryRef({ library_ref: 'g42', library_id: 999 })).toBeNull();
        });

        it('returns null when the group lookup throws', () => {
            getLibraryIDFromGroupID.mockImplementation(() => {
                throw new Error('boom');
            });
            expect(resolveLibraryRef({ library_ref: 'g42', library_id: 999 })).toBeNull();
        });

        it('falls back to library_id verbatim when library_ref is absent', () => {
            expect(resolveLibraryRef({ library_id: 5 })).toBe(5);
        });

        it('falls back to library_id verbatim when library_ref is unparseable', () => {
            expect(resolveLibraryRef({ library_ref: 'not-a-ref', library_id: 5 })).toBe(5);
        });

        it('prefers library_ref when it disagrees with library_id', () => {
            // library_id says "3" (device-local, possibly stale/recycled), but
            // library_ref says "u" — the portable identity wins.
            expect(resolveLibraryRef({ library_ref: 'u', library_id: 3 })).toBe(1);
        });
    });

    describe('resolveItemReference', () => {
        it('returns found when the library resolves and the item exists', async () => {
            const item = { key: 'AAAAAAA1' };
            getByLibraryAndKeyAsync.mockResolvedValue(item);
            const result = await resolveItemReference({ library_ref: 'u', library_id: 999, zotero_key: 'AAAAAAA1' });
            expect(result).toEqual({ status: 'found', item });
            expect(getByLibraryAndKeyAsync).toHaveBeenCalledWith(1, 'AAAAAAA1');
        });

        it('returns library_unavailable when the referenced group is not on this device', async () => {
            getLibraryIDFromGroupID.mockReturnValue(false);
            const result = await resolveItemReference({ library_ref: 'g42', library_id: 5, zotero_key: 'AAAAAAA1' });
            expect(result).toEqual({ status: 'library_unavailable' });
            expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        });

        it('returns not_found when the library resolves but the key does not', async () => {
            getByLibraryAndKeyAsync.mockResolvedValue(false);
            const result = await resolveItemReference({ library_id: 1, zotero_key: 'MISSING1' });
            expect(result).toEqual({ status: 'not_found' });
        });

        it('returns library_unavailable for a falsy fallback library_id instead of throwing', async () => {
            // No library_ref, library_id 0: `getByLibraryAndKeyAsync` would throw
            // on a falsy id, so short-circuit to library_unavailable first.
            const result = await resolveItemReference({ library_id: 0, zotero_key: 'AAAAAAA1' });
            expect(result).toEqual({ status: 'library_unavailable' });
            expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        });
    });

    describe('resolveObjectId', () => {
        it('resolves a portable personal-library id to this device\'s library', () => {
            expect(resolveObjectId('u-ABCD1234')).toEqual({
                library_id: 1,
                library_ref: 'u',
                zotero_key: 'ABCD1234',
            });
        });

        it('resolves a portable group id with a local mapping', () => {
            getLibraryIDFromGroupID.mockReturnValue(7);
            expect(resolveObjectId('g42-ABCD1234')).toEqual({
                library_id: 7,
                library_ref: 'g42',
                zotero_key: 'ABCD1234',
            });
        });

        it('resolves a portable group id without a local mapping to UNRESOLVED_LIBRARY_ID, keeping library_ref', () => {
            getLibraryIDFromGroupID.mockReturnValue(false);
            expect(resolveObjectId('g42-ABCD1234')).toEqual({
                library_id: UNRESOLVED_LIBRARY_ID,
                library_ref: 'g42',
                zotero_key: 'ABCD1234',
            });
        });

        it('keeps a legacy numeric id verbatim and best-effort stamps library_ref', () => {
            getGroupIDFromLibraryID.mockReturnValue(42);
            expect(resolveObjectId('5-ABCD1234')).toEqual({
                library_id: 5,
                library_ref: 'g42',
                zotero_key: 'ABCD1234',
            });
        });

        it('omits library_ref for a legacy numeric id this device cannot stamp', () => {
            getGroupIDFromLibraryID.mockImplementation(() => {
                throw new Error('Group not found');
            });
            expect(resolveObjectId('5-ABCD1234')).toEqual({
                library_id: 5,
                zotero_key: 'ABCD1234',
            });
        });

        it('returns null for an external-file id', () => {
            expect(resolveObjectId('ext-ABCD1234')).toBeNull();
        });

        it.each([
            ['a mixed alphanumeric prefix', '5abc-ABCD1234'],
            ['a leading hyphen', '-ABCD1234'],
            ['no hyphen', 'ABCD1234'],
            ['a zero group id', 'g0-ABCD1234'],
            ['a leading-zero numeric prefix', '01-ABCD1234'],
            ['an empty string', ''],
        ])('returns null for malformed input: %s', (_label, input) => {
            expect(resolveObjectId(input)).toBeNull();
        });

        it('splits a key containing a hyphen on the first hyphen only', () => {
            expect(resolveObjectId('u-ABCD-1234')).toEqual({
                library_id: 1,
                library_ref: 'u',
                zotero_key: 'ABCD-1234',
            });
        });
    });

    describe('modelObjectId', () => {
        it('builds a portable id for the personal library', () => {
            expect(modelObjectId(1, 'ABCD1234')).toBe('u-ABCD1234');
        });

        it('builds a portable id for a mapped group library', () => {
            getGroupIDFromLibraryID.mockReturnValue(42);
            expect(modelObjectId(7, 'ABCD1234')).toBe('g42-ABCD1234');
        });

        it('falls back to the legacy numeric id when no portable ref is computable', () => {
            getGroupIDFromLibraryID.mockImplementation(() => {
                throw new Error('Group not found');
            });
            expect(modelObjectId(99, 'ABCD1234')).toBe('99-ABCD1234');
        });
    });

    describe('modelObjectIdFromReference', () => {
        it('prefers the stored library_ref over library_id', () => {
            expect(modelObjectIdFromReference({ library_id: 5, library_ref: 'g42', zotero_key: 'ABCD1234' }))
                .toBe('g42-ABCD1234');
        });

        it('falls back to library_id when library_ref is absent', () => {
            expect(modelObjectIdFromReference({ library_id: 5, zotero_key: 'ABCD1234' })).toBe('5-ABCD1234');
        });
    });

    describe('resolveWriteTargetLibrary', () => {
        it('uses legacy library_id when library_ref is absent', () => {
            expect(resolveWriteTargetLibrary({ library_id: 5 })).toEqual({ ok: true, libraryID: 5 });
        });

        it('resolves library_name when no id or ref is present', () => {
            zotero.Libraries.getAll = vi.fn(() => [{ libraryID: 7, name: 'Group Library' }]);
            expect(resolveWriteTargetLibrary({ library_name: 'group library' })).toEqual({ ok: true, libraryID: 7 });
        });

        it('defaults to the personal library when no target is provided', () => {
            expect(resolveWriteTargetLibrary({})).toEqual({ ok: true, libraryID: 1 });
        });

        it('rejects a malformed present library_ref without falling back to library_id', () => {
            const result = resolveWriteTargetLibrary({ library_ref: 'bad-ref', library_id: 5 });
            expect(result).toMatchObject({ ok: false, code: 'invalid_library_ref' });
        });

        it('rejects an unavailable group library_ref without falling back to library_id', () => {
            getLibraryIDFromGroupID.mockReturnValue(false);
            const result = resolveWriteTargetLibrary({ library_ref: 'g42', library_id: 5 });
            expect(result).toMatchObject({ ok: false, code: 'library_unavailable' });
        });

        it('resolves a present library_ref and ignores stale library_id', () => {
            getLibraryIDFromGroupID.mockReturnValue(8);
            expect(resolveWriteTargetLibrary({ library_ref: 'g42', library_id: 5 })).toEqual({ ok: true, libraryID: 8 });
        });
    });
});
