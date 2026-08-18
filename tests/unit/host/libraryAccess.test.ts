import { beforeEach, describe, expect, it, vi } from 'vitest';

const isLibrarySearchable = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    isLibrarySearchable,
}));

import { resolveSearchableLibraryId } from '../../../react/host/zotero/libraryAccess';

describe('resolveSearchableLibraryId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero.Libraries as any).userLibraryID = 1;
        (Zotero as any).Groups = {
            getLibraryIDFromGroupID: vi.fn((groupId: number) => groupId === 42 ? 7 : false),
        };
        isLibrarySearchable.mockReturnValue(true);
    });

    it('lets a portable group ref override a stale device-local id', () => {
        expect(resolveSearchableLibraryId({ library_id: 99, library_ref: 'g42' })).toBe(7);
        expect(isLibrarySearchable).toHaveBeenCalledWith(7);
    });

    it('returns null before lookup when the resolved library is excluded', () => {
        isLibrarySearchable.mockReturnValue(false);

        expect(resolveSearchableLibraryId({ library_id: 99, library_ref: 'g42' })).toBeNull();
    });

    it('uses a subscribed searchable-library snapshot when provided', () => {
        expect(resolveSearchableLibraryId(
            { library_id: 99, library_ref: 'g42' },
            [1, 7],
        )).toBe(7);
        expect(resolveSearchableLibraryId(
            { library_id: 99, library_ref: 'g42' },
            [1],
        )).toBeNull();
        expect(isLibrarySearchable).not.toHaveBeenCalled();
    });

    it('returns null when the portable library is unavailable locally', () => {
        expect(resolveSearchableLibraryId({ library_id: 99, library_ref: 'g404' })).toBeNull();
        expect(isLibrarySearchable).not.toHaveBeenCalled();
    });
});
