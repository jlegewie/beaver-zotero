/**
 * `handleItemDisplayRequest` — the bulk display lookup a batch job issues when
 * its population is minted.
 *
 * What these pin: one row per id this device can resolve, loaded in ONE pass
 * rather than one per item; an id it cannot resolve (unknown library, excluded
 * library, missing key) has no row and is not an error; and the rows use the
 * same formatters every other surface uses, so the receipt calls an item what
 * search results call it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    resolveLibraryRef: vi.fn(),
    checkLibraryExcluded: vi.fn(() => null),
    loadQuickSearchHitData: vi.fn(async () => {}),
    getItemDisplayName: vi.fn((item: any) => `${item.firstCreator} ${item.year}`),
    getItemDescription: vi.fn((item: any) => `Title ${item.key}`),
    getContentKind: vi.fn(() => 'pdf'),
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveLibraryRef: mocks.resolveLibraryRef,
    modelObjectId: vi.fn((libraryID: number, key: string) => `${libraryID === 1 ? 'u' : `g${libraryID}`}-${key}`),
}));

vi.mock('../../../src/utils/itemDisplayName', () => ({
    getItemDisplayName: mocks.getItemDisplayName,
}));

vi.mock('../../../src/utils/itemDescription', () => ({
    getItemDescription: mocks.getItemDescription,
}));

vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getContentKind: mocks.getContentKind,
}));

vi.mock('../../../src/services/agentDataProvider/itemSearchSerialization', () => ({
    loadQuickSearchHitData: mocks.loadQuickSearchHitData,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: mocks.checkLibraryExcluded,
}));

import {
    MAX_ITEM_DISPLAY_IDS,
    handleItemDisplayRequest,
} from '../../../src/services/agentDataProvider/handleItemDisplayRequest';

function regularItem(key: string, libraryID = 1, overrides: Record<string, any> = {}) {
    return {
        key,
        libraryID,
        itemType: 'journalArticle',
        firstCreator: 'Legewie and DiPrete',
        year: 2014,
        isAttachment: () => false,
        ...overrides,
    };
}

/** The items this device holds, keyed `<libraryID>-<key>`. */
let library: Record<string, any>;
const getByLibraryAndKeyAsync = vi.fn(async (libraryID: number, key: string) => library[`${libraryID}-${key}`] ?? false);

function request(itemIds: string[]) {
    return { event: 'item_display_request', request_id: 'r1', item_ids: itemIds } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    library = {};
    // `u` and the legacy `1-` both name the personal library; a group is on
    // this device only when it says so.
    mocks.resolveLibraryRef.mockImplementation((ref: any) => {
        if (ref.library_ref === 'u' || ref.library_id === 1) return 1;
        if (ref.library_ref === 'g5') return 5;
        return null;
    });
    mocks.checkLibraryExcluded.mockReturnValue(null);
    const zotero = (globalThis as any).Zotero;
    zotero.Items = { ...(zotero.Items ?? {}), getByLibraryAndKeyAsync };
});

describe('handleItemDisplayRequest', () => {
    it('returns one row per item, in the shape a list draws', async () => {
        library['1-AAAAAAAA'] = regularItem('AAAAAAAA');

        const res = await handleItemDisplayRequest(request(['u-AAAAAAAA']));

        expect(res).toEqual({
            type: 'item_display',
            request_id: 'r1',
            items: [
                {
                    item_id: 'u-AAAAAAAA',
                    item_type: 'journalArticle',
                    display_name: 'Legewie and DiPrete 2014',
                    subtitle: 'Title AAAAAAAA',
                },
            ],
        });
    });

    it('loads every item in one pass rather than one per item', async () => {
        library['1-AAAAAAAA'] = regularItem('AAAAAAAA');
        library['1-BBBBBBBB'] = regularItem('BBBBBBBB');
        library['5-CCCCCCCC'] = regularItem('CCCCCCCC', 5);

        const res = await handleItemDisplayRequest(request(['u-AAAAAAAA', '1-BBBBBBBB', 'g5-CCCCCCCC']));

        expect(mocks.loadQuickSearchHitData).toHaveBeenCalledTimes(1);
        expect(mocks.loadQuickSearchHitData.mock.calls[0][0]).toHaveLength(3);
        expect(res.items.map((row) => row.item_id)).toEqual(['u-AAAAAAAA', 'u-BBBBBBBB', 'g5-CCCCCCCC']);
    });

    it('answers nothing, and no error, for an id this device cannot resolve', async () => {
        library['1-AAAAAAAA'] = regularItem('AAAAAAAA');

        const res = await handleItemDisplayRequest(
            request(['u-AAAAAAAA', 'u-GONE0000', 'g99-ELSEWHER', 'nonsense']),
        );

        expect(res.error).toBeUndefined();
        expect(res.items.map((row) => row.item_id)).toEqual(['u-AAAAAAAA']);
    });

    it('never looks inside an excluded library', async () => {
        library['5-CCCCCCCC'] = regularItem('CCCCCCCC', 5);
        mocks.checkLibraryExcluded.mockImplementation((libraryID: number) =>
            libraryID === 5 ? { message: 'excluded' } : null,
        );

        const res = await handleItemDisplayRequest(request(['g5-CCCCCCCC']));

        expect(res.items).toEqual([]);
        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('describes an item once however many ways the request spells it', async () => {
        library['1-AAAAAAAA'] = regularItem('AAAAAAAA');

        const res = await handleItemDisplayRequest(request(['u-AAAAAAAA', '1-AAAAAAAA', 'u-AAAAAAAA']));

        expect(res.items).toHaveLength(1);
        expect(getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);
    });

    it('gives an attachment its content kind, for the icon', async () => {
        library['1-PDFPDFPD'] = regularItem('PDFPDFPD', 1, {
            itemType: 'attachment',
            isAttachment: () => true,
        });

        const res = await handleItemDisplayRequest(request(['u-PDFPDFPD']));

        expect(res.items[0]).toMatchObject({ item_type: 'attachment', content_kind: 'pdf' });
    });

    it('lets one unreadable item cost only its own row', async () => {
        library['1-AAAAAAAA'] = regularItem('AAAAAAAA');
        library['1-BBBBBBBB'] = regularItem('BBBBBBBB');
        mocks.getItemDisplayName.mockImplementation((item: any) => {
            if (item.key === 'AAAAAAAA') throw new Error('Item data not loaded');
            return `${item.firstCreator} ${item.year}`;
        });

        const res = await handleItemDisplayRequest(request(['u-AAAAAAAA', 'u-BBBBBBBB']));

        expect(res.items.map((row) => row.item_id)).toEqual(['u-BBBBBBBB']);
    });

    it('describes at most the population cap', async () => {
        const ids = Array.from({ length: MAX_ITEM_DISPLAY_IDS + 1 }, (_, i) => `K${String(i).padStart(7, '0')}`);
        for (const key of ids) library[`1-${key}`] = regularItem(key);

        const res = await handleItemDisplayRequest(request(ids.map((key) => `u-${key}`)));

        expect(res.items).toHaveLength(MAX_ITEM_DISPLAY_IDS);
    });

    it('reports a failure it cannot recover from as an error response', async () => {
        mocks.loadQuickSearchHitData.mockRejectedValueOnce(new Error('database closed'));
        library['1-AAAAAAAA'] = regularItem('AAAAAAAA');

        const res = await handleItemDisplayRequest(request(['u-AAAAAAAA']));

        expect(res.items).toEqual([]);
        expect(res.error_code).toBe('internal_error');
    });
});
