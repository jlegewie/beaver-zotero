/**
 * `navigation.revealObject`: an object link carries a key but not a type, so
 * the host decides what the key names and how to show it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

declare const Zotero: any;

const { resolveLibraryRef, revealSource, selectCollection, navigateToAnnotation, notifyReferenceUnavailable } =
    vi.hoisted(() => ({
        resolveLibraryRef: vi.fn(),
        revealSource: vi.fn(),
        selectCollection: vi.fn(),
        navigateToAnnotation: vi.fn(),
        notifyReferenceUnavailable: vi.fn(),
    }));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveLibraryRef,
    resolveItemReference: vi.fn(),
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    revealSource,
    openSource: vi.fn(),
}));
vi.mock('../../../src/utils/selectItem', () => ({
    selectCollection,
    selectLibrary: vi.fn(),
    selectTagFilter: vi.fn(),
}));
vi.mock('../../../react/host/zotero/citationActivation', () => ({
    activateCitation: vi.fn(),
}));
vi.mock('../../../react/host/zotero/sourceActions', () => ({
    launchExternalFile: vi.fn(),
    notifyReferenceUnavailable,
    notifyTagAmbiguous: vi.fn(),
}));
vi.mock('../../../react/utils/readerUtils', () => ({
    navigateToAnnotation,
}));
vi.mock('../../../react/utils/attachmentMatchNavigation', () => ({
    navigateToAttachmentMatch: vi.fn(),
}));
vi.mock('../../../src/ui/openPreferencesWindow', () => ({
    openPreferencesWindow: vi.fn(),
}));
vi.mock('../../../react/types/actionStorage', () => ({
    getMergedActions: vi.fn(() => []),
}));

import { zoteroNavigation } from '../../../react/host/zotero/navigation';

const ref = { library_id: 0, library_ref: 'u', zotero_key: 'ANVV522N' };

describe('zoteroNavigation.revealObject', () => {
    const getByLibraryAndKeyAsync = vi.fn();
    const getByLibraryAndKey = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        Zotero.Items = { getByLibraryAndKeyAsync };
        Zotero.Collections = { getByLibraryAndKey };
        resolveLibraryRef.mockReturnValue(1);
        getByLibraryAndKeyAsync.mockResolvedValue(false);
        getByLibraryAndKey.mockReturnValue(false);
        selectCollection.mockResolvedValue(true);
    });

    it('reveals a library item in the library view', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => false });

        await zoteroNavigation.revealObject!(ref);

        expect(getByLibraryAndKeyAsync).toHaveBeenCalledWith(1, 'ANVV522N');
        expect(revealSource).toHaveBeenCalledWith({ ...ref, library_id: 1 });
        expect(notifyReferenceUnavailable).not.toHaveBeenCalled();
    });

    it('opens an annotation in the reader instead of the library view', async () => {
        const annotation = { isAnnotation: () => true };
        getByLibraryAndKeyAsync.mockResolvedValue(annotation);

        await zoteroNavigation.revealObject!(ref);

        expect(navigateToAnnotation).toHaveBeenCalledWith(annotation);
        expect(revealSource).not.toHaveBeenCalled();
    });

    it('falls back to a collection with that key', async () => {
        const collection = { id: 7 };
        getByLibraryAndKey.mockReturnValue(collection);

        await zoteroNavigation.revealObject!(ref);

        expect(getByLibraryAndKey).toHaveBeenCalledWith(1, 'ANVV522N');
        expect(selectCollection).toHaveBeenCalledWith(collection);
        expect(notifyReferenceUnavailable).not.toHaveBeenCalled();
    });

    it('tells the user when the key names nothing in the library', async () => {
        await zoteroNavigation.revealObject!(ref);

        expect(revealSource).not.toHaveBeenCalled();
        expect(selectCollection).not.toHaveBeenCalled();
        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('link');
    });

    it('treats a collection that cannot be selected as unavailable', async () => {
        getByLibraryAndKey.mockReturnValue({ id: 7 });
        selectCollection.mockResolvedValue(false);

        await zoteroNavigation.revealObject!(ref);

        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('link');
    });

    it('tells the user when the library is not on this computer', async () => {
        resolveLibraryRef.mockReturnValue(null);

        await zoteroNavigation.revealObject!({ ...ref, library_ref: 'g99' });

        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('link', 'library_unavailable');
    });

    it('never lets a lookup failure turn into a dead link', async () => {
        getByLibraryAndKeyAsync.mockRejectedValue(new Error('boom'));

        await zoteroNavigation.revealObject!(ref);

        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('link');
    });
});
