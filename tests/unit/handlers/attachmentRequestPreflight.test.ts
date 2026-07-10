import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    searchableLibraryIds: [42] as number[],
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => mocks.searchableLibraryIds), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

import { preflightZoteroAttachmentRequest } from '../../../src/services/agentDataProvider/utils';

describe('preflightZoteroAttachmentRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.searchableLibraryIds = [42];
        (globalThis as any).Zotero.Libraries = {
            userLibraryID: 1,
            get: vi.fn((libraryId: number) =>
                libraryId === 42 ? { libraryID: 42, name: 'Research Group' } : null,
            ),
        };
        (globalThis as any).Zotero.Groups = {
            getLibraryIDFromGroupID: vi.fn((groupId: number) =>
                groupId === 123 ? 42 : false,
            ),
            getGroupIDFromLibraryID: vi.fn(() => false),
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(),
        };
    });

    it('resolves a portable reference and returns the shared routing metadata', () => {
        const result = preflightZoteroAttachmentRequest(
            { library_id: 999, library_ref: 'g123', zotero_key: 'ABCD1234' },
            () => null,
        );

        expect(result).toEqual({
            ok: true,
            responseAttachment: {
                library_id: 999,
                library_ref: 'g123',
                zotero_key: 'ABCD1234',
            },
            requestKey: 'g123-ABCD1234',
            resolvedLibraryId: 42,
        });
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('rejects an invalid reference before library resolution', () => {
        const result = preflightZoteroAttachmentRequest(
            { library_id: 999, library_ref: 'g123', zotero_key: 'bad' },
            () => 'Invalid zotero_key',
        );

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'invalid_format',
            requestKey: 'g123-bad',
        });
        expect(Zotero.Groups.getLibraryIDFromGroupID).not.toHaveBeenCalled();
        expect(Zotero.Libraries.get).not.toHaveBeenCalled();
    });

    it('distinguishes unavailable and excluded libraries without item lookup', () => {
        const unavailable = preflightZoteroAttachmentRequest(
            { library_id: 0, library_ref: 'g404', zotero_key: 'ABCD1234' },
            () => null,
        );
        expect(unavailable).toMatchObject({
            ok: false,
            errorCode: 'library_unavailable',
        });

        mocks.searchableLibraryIds = [];
        const excluded = preflightZoteroAttachmentRequest(
            { library_id: 0, library_ref: 'g123', zotero_key: 'ABCD1234' },
            () => null,
        );
        expect(excluded).toMatchObject({
            ok: false,
            errorCode: 'library_excluded',
        });
        expect(excluded.ok ? '' : excluded.error).toContain('Research Group');
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });
});
