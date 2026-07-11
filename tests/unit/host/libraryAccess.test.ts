import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveLocalLibraryId } from '../../../react/host/zotero/libraryAccess';

declare const Zotero: any;

describe('resolveLocalLibraryId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero.Libraries as any).userLibraryID = 1;
        (Zotero as any).Groups = {
            getLibraryIDFromGroupID: vi.fn((groupId: number) => groupId === 42 ? 7 : false),
        };
    });

    it('lets a portable group ref override a stale device-local id', () => {
        expect(resolveLocalLibraryId({ library_id: 99, library_ref: 'g42' })).toBe(7);
    });

    it('keeps a legacy local history reference available without a searchability gate', () => {
        expect(resolveLocalLibraryId({ library_id: 99 })).toBe(99);
    });

    it('returns null when the portable library is unavailable locally', () => {
        expect(resolveLocalLibraryId({ library_id: 99, library_ref: 'g404' })).toBeNull();
    });
});
