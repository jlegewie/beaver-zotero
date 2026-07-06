import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LIBRARY_REF_PATTERN,
    libraryRefForLibraryID,
    parseLibraryRef,
    resolveLibraryRef,
    resolveItemReference,
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
    });
});
