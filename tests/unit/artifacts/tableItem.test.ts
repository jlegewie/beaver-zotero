import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkLibraryExcluded = vi.hoisted(() => vi.fn());
const getPref = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded,
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref,
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

import {
    buildTableUrl,
    isTableItem,
    resolveTableLibrary,
    TABLE_TAG,
} from '../../../src/services/artifacts/tableItem';

interface FakeLibrary {
    libraryID: number;
    libraryType: string;
    editable: boolean;
}

const USER_LIBRARY: FakeLibrary = { libraryID: 1, libraryType: 'user', editable: true };
const EDITABLE_GROUP: FakeLibrary = { libraryID: 7, libraryType: 'group', editable: true };
const READ_ONLY_GROUP: FakeLibrary = { libraryID: 9, libraryType: 'group', editable: false };

function stubLibraries(libraries: FakeLibrary[]): void {
    const byId = new Map(libraries.map((library) => [library.libraryID, library]));
    (Zotero as any).Libraries = {
        userLibraryID: 1,
        get: vi.fn((id: number) => byId.get(id) ?? false),
        getAll: vi.fn(() => libraries),
    };
}

describe('resolveTableLibrary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubLibraries([USER_LIBRARY, EDITABLE_GROUP, READ_ONLY_GROUP]);
        checkLibraryExcluded.mockReturnValue(null);
        getPref.mockReturnValue(0);
    });

    it('refuses an explicit library it cannot write to, rather than substituting another', () => {
        getPref.mockReturnValue(USER_LIBRARY.libraryID);

        // Not substituted with the user library, which would have worked.
        expect(resolveTableLibrary(READ_ONLY_GROUP.libraryID)).toEqual({
            error: 'no_writable_library',
        });
    });

    it('refuses an explicit group library instead of silently filing elsewhere', () => {
        // Creation can only file a table in the personal library, so a caller
        // that names a group is told so rather than handed a table in a
        // library it did not ask for.
        expect(resolveTableLibrary(EDITABLE_GROUP.libraryID)).toEqual({
            error: 'unsupported_library',
        });
    });

    it('refuses an explicit library the user excluded, rather than substituting another', () => {
        checkLibraryExcluded.mockImplementation((id: number) =>
            id === EDITABLE_GROUP.libraryID ? { message: 'excluded' } : null
        );

        expect(resolveTableLibrary(EDITABLE_GROUP.libraryID)).toEqual({
            error: 'library_excluded',
        });
    });

    it('refuses an explicit library that does not exist', () => {
        expect(resolveTableLibrary(404)).toEqual({ error: 'no_writable_library' });
    });

    it('falls through a group default to the user library', () => {
        // The preference can name any library, but only the personal one can
        // hold a table. A group there must not break table creation — there is
        // no UI to undo it — so it is skipped like any other unusable default.
        getPref.mockReturnValue(EDITABLE_GROUP.libraryID);

        expect(resolveTableLibrary()).toEqual({ libraryID: USER_LIBRARY.libraryID });
        expect(getPref).toHaveBeenCalled();
    });

    it('falls back to the user library when no default is configured', () => {
        expect(resolveTableLibrary()).toEqual({ libraryID: USER_LIBRARY.libraryID });
    });

    it('falls through an excluded default to the user library', () => {
        getPref.mockReturnValue(EDITABLE_GROUP.libraryID);
        checkLibraryExcluded.mockImplementation((id: number) =>
            id === EDITABLE_GROUP.libraryID ? { message: 'excluded' } : null
        );

        expect(resolveTableLibrary()).toEqual({ libraryID: USER_LIBRARY.libraryID });
    });

    it('falls through a read-only default to the user library', () => {
        getPref.mockReturnValue(READ_ONLY_GROUP.libraryID);

        expect(resolveTableLibrary()).toEqual({ libraryID: USER_LIBRARY.libraryID });
    });

    it('refuses when every candidate is excluded', () => {
        getPref.mockReturnValue(EDITABLE_GROUP.libraryID);
        checkLibraryExcluded.mockReturnValue({ message: 'excluded' });

        expect(resolveTableLibrary()).toEqual({ error: 'library_excluded' });
    });

    it('reports no writable library when nothing usable exists', () => {
        stubLibraries([READ_ONLY_GROUP]);

        expect(resolveTableLibrary()).toEqual({ error: 'no_writable_library' });
    });
});

interface FakeItemOptions {
    attachment?: boolean;
    topLevel?: boolean;
    linkMode?: number;
    contentType?: string;
    tags?: string[];
    url?: string | null;
    /** Simulates `itemData` not being loaded, which makes `getField` throw. */
    fieldsLoaded?: boolean;
}

function fakeItem(options: FakeItemOptions = {}): Zotero.Item {
    const {
        attachment = true,
        topLevel = true,
        linkMode = Zotero.Attachments.LINK_MODE_IMPORTED_URL,
        contentType = 'text/html',
        tags = [TABLE_TAG, '📊'],
        url = 'beaver://table/effects-of-caffeine',
        fieldsLoaded = true,
    } = options;

    return {
        isAttachment: () => attachment,
        isTopLevelItem: () => topLevel,
        attachmentLinkMode: linkMode,
        attachmentContentType: contentType,
        hasTag: (name: string) => tags.includes(name),
        getField: (field: string) => {
            if (!fieldsLoaded) throw new Error('Item data not loaded');
            return field === 'url' ? (url ?? '') : '';
        },
    } as unknown as Zotero.Item;
}

describe('isTableItem', () => {
    it('recognises a stored table', () => {
        expect(isTableItem(fakeItem())).toBe(true);
    });

    it('needs both marks: a tag alone is not enough', () => {
        // A user can put `beaver-table` on any item they like.
        expect(isTableItem(fakeItem({ url: 'https://example.org/page' }))).toBe(false);
    });

    it('needs both marks: a beaver:// url alone is not enough', () => {
        expect(isTableItem(fakeItem({ tags: [] }))).toBe(false);
    });

    it('rejects a url under another beaver:// scheme', () => {
        expect(isTableItem(fakeItem({ url: 'beaver://report/summary' }))).toBe(false);
    });

    it('rejects a child attachment, a non-html file and a link', () => {
        expect(isTableItem(fakeItem({ topLevel: false }))).toBe(false);
        expect(isTableItem(fakeItem({ contentType: 'application/pdf' }))).toBe(false);
        expect(
            isTableItem(fakeItem({ linkMode: Zotero.Attachments.LINK_MODE_LINKED_URL }))
        ).toBe(false);
        expect(isTableItem(fakeItem({ attachment: false }))).toBe(false);
    });

    it('does not claim an item whose field data has not been loaded', () => {
        expect(isTableItem(fakeItem({ fieldsLoaded: false }))).toBe(false);
    });

    it('tolerates a missing item', () => {
        expect(isTableItem(null)).toBe(false);
        expect(isTableItem(undefined)).toBe(false);
    });
});

describe('buildTableUrl', () => {
    it('slugifies the title into the last path segment, which Zotero uses as the filename', () => {
        expect(buildTableUrl('Effects of Caffeine')).toBe(
            'beaver://table/effects-of-caffeine'
        );
    });

    it('collapses punctuation and trims the separators it leaves behind', () => {
        expect(buildTableUrl('  RCTs: sample & setting!  ')).toBe(
            'beaver://table/rcts-sample-setting'
        );
    });

    it('falls back to a usable name when the title slugifies to nothing', () => {
        expect(buildTableUrl('—— ??')).toBe('beaver://table/table');
        expect(buildTableUrl('')).toBe('beaver://table/table');
    });

    it('caps the slug and leaves no trailing separator', () => {
        const url = buildTableUrl(`${'a'.repeat(58)} tail`);
        const slug = url.slice('beaver://table/'.length);

        expect(slug.length).toBeLessThanOrEqual(60);
        expect(slug.endsWith('-')).toBe(false);
    });
});
