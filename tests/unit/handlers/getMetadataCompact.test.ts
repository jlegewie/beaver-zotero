/**
 * `handleGetMetadataRequest` — the `compact` projection.
 *
 * Thread history stores bare refs, so a client without a local Zotero needs a
 * key → display lookup to render an old message; what it does not need is the
 * whole item. These tests pin that `compact` serves the same chip projection
 * quick search does (so one item has one name everywhere), that it costs less
 * than `full`, and that omitting `detail` still serves `full`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    resolveObjectId: vi.fn(),
    resolveItemReference: vi.fn(),
    checkLibraryExcluded: vi.fn(() => null),
    getAttachmentInfoForItem: vi.fn(),
    getCreatorTypeInfo: vi.fn(() => null),
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveObjectId: mocks.resolveObjectId,
    resolveItemReference: mocks.resolveItemReference,
    libraryRefForLibraryID: vi.fn(() => 'u'),
    modelObjectId: vi.fn((libraryId: number, key: string) => `u-${key}`),
    UNRESOLVED_LIBRARY_ID: -1,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: mocks.checkLibraryExcluded,
    getAttachmentInfoForItem: mocks.getAttachmentInfoForItem,
    degradedAttachmentInfo: vi.fn(),
    formatCreatorsString: vi.fn(() => null),
    extractYear: vi.fn(() => null),
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeNote: vi.fn(),
    serializeAnnotation: vi.fn(),
    serializeItemStub: vi.fn(),
    serializeItem: vi.fn(),
    getYearFromItem: vi.fn((item: any) => item.year),
}));

// `getItemDisplayName` is deliberately NOT mocked: the point of the compact
// projection is that the label comes from Zotero's own formatter, so a test
// that stubbed it could not tell whether an item type gets a usable name.

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getCreatorTypeInfo: mocks.getCreatorTypeInfo,
}));

import { handleGetMetadataRequest } from '../../../src/services/agentDataProvider/handleGetMetadataRequest';

function regularItem(key: string, overrides: Record<string, any> = {}) {
    return {
        key,
        libraryID: 1,
        itemType: 'journalArticle',
        firstCreator: 'Legewie and DiPrete',
        year: 2014,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
        isRegularItem: () => true,
        getField: (field: string) => {
            if (field === 'title') return `Title ${key}`;
            if (field === 'date') return '2014-05-01';
            return '';
        },
        getDisplayTitle: () => `Title ${key}`,
        getAttachments: () => [42],
        getCollections: () => [],
        getNotes: () => [],
        toJSON: () => ({ itemType: 'journalArticle', title: `Title ${key}` }),
        ...overrides,
    };
}

/** An annotation, which has neither creators nor a title of its own. */
function annotationItem(key: string) {
    return regularItem(key, {
        itemType: 'annotation',
        firstCreator: '',
        year: undefined,
        isAnnotation: () => true,
        isRegularItem: () => false,
        getField: () => '',
        getDisplayTitle: () => '“outcomes are across the categories…”',
        getAttachments: () => [],
    });
}

const loadDataTypes = vi.fn(async () => {});

function request(overrides: Record<string, any> = {}) {
    return {
        event: 'get_metadata_request',
        request_id: 'r1',
        item_ids: ['u-AAAAAAAA'],
        include_attachments: false,
        include_notes: false,
        ...overrides,
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveObjectId.mockReturnValue({ library_id: 1, zotero_key: 'AAAAAAAA' });
    mocks.resolveItemReference.mockResolvedValue({ status: 'found', item: regularItem('AAAAAAAA') });
    mocks.checkLibraryExcluded.mockReturnValue(null);

    const zotero = (globalThis as any).Zotero;
    zotero.Items = { ...(zotero.Items ?? {}), loadDataTypes, getAsync: vi.fn() };
    zotero.Beaver = { citationService: { formatBibliography: vi.fn(() => 'Legewie, J. (2014).') } };
});

describe('handleGetMetadataRequest compact projection', () => {
    it('returns one chip-sized row per item, keyed back to the requested id', async () => {
        const res = await handleGetMetadataRequest(request({ detail: 'compact' }));

        expect(res.detail).toBe('compact');
        expect(res.items).toEqual([
            {
                item_id: 'u-AAAAAAAA',
                library_id: 1,
                library_ref: 'u',
                zotero_key: 'AAAAAAAA',
                item_type: 'journalArticle',
                // Zotero's own et-al-aware creator string plus the year, which
                // is why a client must render this rather than rebuild it.
                display_name: 'Legewie and DiPrete 2014',
                title: 'Title AAAAAAAA',
                year: 2014,
                formatted_citation: 'Legewie, J. (2014).',
                has_attachment: true,
                score: undefined,
            },
        ]);
    });

    it('skips the child payloads the projection has no place for', async () => {
        const res = await handleGetMetadataRequest(
            request({ detail: 'compact', include_attachments: true, include_notes: true })
        );

        expect(res.items[0]).not.toHaveProperty('attachments');
        expect(res.items[0]).not.toHaveProperty('notes');
        expect(mocks.getAttachmentInfoForItem).not.toHaveBeenCalled();
    });

    it('loads only the data the compact row reads', async () => {
        await handleGetMetadataRequest(request({ detail: 'compact' }));

        expect(loadDataTypes).toHaveBeenCalledWith(expect.anything(), [
            'itemData', 'creators', 'childItems',
        ]);
    });

    it('serves the full row when detail is omitted', async () => {
        const res = await handleGetMetadataRequest(request());

        expect(res.detail).toBe('full');
        expect(res.items[0]).toMatchObject({
            item_id: 'u-AAAAAAAA',
            itemType: 'journalArticle',
            title: 'Title AAAAAAAA',
        });
    });

    it('names an annotation by its text rather than "Unknown Author"', async () => {
        mocks.resolveItemReference.mockResolvedValue({
            status: 'found',
            item: annotationItem('BBBBBBBB'),
        });

        const res = await handleGetMetadataRequest(request({ detail: 'compact' }));

        expect(res.items[0].display_name).toContain('outcomes are across');
        // No bibliography entry for something that is not a work: an
        // annotation would format as a citation of nothing.
        expect(res.items[0].formatted_citation).toBeUndefined();
    });

    it('still reports ids it could not resolve', async () => {
        mocks.resolveItemReference.mockResolvedValue({ status: 'not_found' });

        const res = await handleGetMetadataRequest(request({ detail: 'compact' }));

        expect(res.items).toEqual([]);
        expect(res.not_found).toEqual(['u-AAAAAAAA']);
    });
});
