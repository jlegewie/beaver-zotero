import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils.ts', () => ({
    validateLibraryAccess: vi.fn(() => ({
        valid: true,
        library: { libraryID: 1, name: 'My Library' },
    })),
    getCollectionByIdOrName: vi.fn(() => null),
    getSearchableLibraries: vi.fn(() => [{ library_id: 1, name: 'My Library' }]),
    isLibrarySearchable: vi.fn(() => true),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeAnnotation: vi.fn((annotation: any, attachmentInfo: any, itemInfo: any) => ({
        result_type: 'annotation',
        annotation_id: `${annotation.libraryID}-${annotation.key}`,
        annotation_type: annotation.annotationType ?? null,
        text: annotation.annotationText ?? null,
        comment: annotation.annotationComment ?? null,
        color: annotation.annotationColor ?? null,
        page: 1,
        tags: [],
        author: annotation.annotationAuthorName ?? null,
        attachment_id: attachmentInfo?.item_id ?? null,
        item_id: itemInfo?.item_id ?? null,
        item_title: itemInfo?.title ?? null,
        date_added: annotation.dateAdded,
        date_modified: annotation.dateModified,
    })),
}));

import { handleFindAnnotationsRequest } from '../../../src/services/agentDataProvider/handleFindAnnotationsRequest';
import type { WSFindAnnotationsRequest } from '../../../src/services/agentProtocol';

type MockAnnotation = Zotero.Item & {
    annotationType: string;
    annotationColor: string;
    annotationAuthorName: string;
};

const attachment = {
    id: 10,
    key: 'ATTACH01',
    libraryID: 1,
    parentID: 20,
} as Zotero.Item;

const parent = {
    id: 20,
    key: 'PARENT01',
    libraryID: 1,
    getField: vi.fn(() => 'Parent Item'),
} as unknown as Zotero.Item;

function annotation(
    id: number,
    key: string,
    attrs: {
        color: string;
        type: string;
        author: string;
        dateModified: string;
    },
): MockAnnotation {
    return {
        id,
        key,
        libraryID: 1,
        parentID: attachment.id,
        dateAdded: '2026-01-01T00:00:00Z',
        dateModified: attrs.dateModified,
        annotationType: attrs.type,
        annotationText: `annotation ${key}`,
        annotationComment: '',
        annotationColor: attrs.color,
        annotationAuthorName: attrs.author,
        annotationPosition: JSON.stringify({ pageIndex: 0 }),
        annotationSortIndex: `00001|00000${id}|00000`,
        getTags: vi.fn(() => [{ tag: 'match' }]),
    } as unknown as MockAnnotation;
}

const annotations = [
    annotation(101, 'ANN101AA', {
        color: '#ff6666',
        type: 'highlight',
        author: 'Alice Smith',
        dateModified: '2026-05-01T00:00:00Z',
    }),
    annotation(102, 'ANN102AA', {
        color: '#ffd400',
        type: 'highlight',
        author: 'Alice Smith',
        dateModified: '2026-06-01T00:00:00Z',
    }),
    annotation(103, 'ANN103AA', {
        color: '#ff6666',
        type: 'highlight',
        author: 'Alice Smith',
        dateModified: '2026-06-03T00:00:00Z',
    }),
    annotation(104, 'ANN104AA', {
        color: '#ff6666',
        type: 'note',
        author: 'Alice Smith',
        dateModified: '2026-06-04T00:00:00Z',
    }),
    annotation(105, 'ANN105AA', {
        color: '#ff6666',
        type: 'highlight',
        author: 'Bob Jones',
        dateModified: '2026-06-05T00:00:00Z',
    }),
] as MockAnnotation[];

const itemByID = new Map<number, Zotero.Item>([
    [attachment.id, attachment],
    [parent.id, parent],
    ...annotations.map(item => [item.id, item] as [number, Zotero.Item]),
]);

const baseRequest: WSFindAnnotationsRequest = {
    event: 'find_annotations_request',
    request_id: 'req-1',
    recursive: true,
    sort_by: 'date_modified',
    sort_order: 'desc',
    limit: 50,
    offset: 0,
};

function matchingAnnotations() {
    return annotations
        .filter(item =>
            item.annotationColor.toLowerCase() === '#ff6666'
            && item.annotationType === 'highlight'
            && item.annotationAuthorName.toLowerCase().includes('alice')
        )
        .sort((a, b) => b.dateModified.localeCompare(a.dateModified) || b.id - a.id);
}

function installZoteroMocks(searchIDs: number[]) {
    const Zotero = (globalThis as any).Zotero;
    Zotero.Items = {
        getAsync: vi.fn(async (ids: number | number[]) => {
            if (Array.isArray(ids)) {
                return ids.map(id => itemByID.get(id) ?? false);
            }
            return itemByID.get(ids) ?? false;
        }),
        loadDataTypes: vi.fn(async () => undefined),
    };
    Zotero.Search = vi.fn(function Search(this: any) {
        this.addCondition = vi.fn();
        this.search = vi.fn(async () => searchIDs);
    });
    Zotero.DB = {
        queryAsync: vi.fn(async (sql: string, params: unknown[], options: any) => {
            const matches = matchingAnnotations();
            if (sql.includes('COUNT(*)')) {
                options.onRow({ getResultByIndex: () => matches.length });
                return;
            }
            const limit = params[params.length - 2] as number;
            const offset = params[params.length - 1] as number;
            for (const item of matches.slice(offset, offset + limit)) {
                options.onRow({ getResultByIndex: () => item.id });
            }
        }),
    };
    Zotero.Libraries = {
        ...Zotero.Libraries,
        get: vi.fn(() => ({ libraryID: 1, name: 'My Library' })),
    };
}

describe('handleFindAnnotationsRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        installZoteroMocks(annotations.map(item => item.id));
    });

    it('keeps DB and Search paths aligned for color, type, author, and sort order', async () => {
        const filters = {
            color: 'red',
            annotation_type: 'highlight',
            author: 'alice',
        };

        const dbPath = await handleFindAnnotationsRequest({
            ...baseRequest,
            ...filters,
            request_id: 'db-path',
        });
        const searchPath = await handleFindAnnotationsRequest({
            ...baseRequest,
            ...filters,
            tag: 'match',
            request_id: 'search-path',
        });

        expect(dbPath.error).toBeUndefined();
        expect(searchPath.error).toBeUndefined();
        expect(dbPath.total_count).toBe(2);
        expect(searchPath.total_count).toBe(2);
        expect(dbPath.annotations.map(a => a.annotation_id)).toEqual([
            '1-ANN103AA',
            '1-ANN101AA',
        ]);
        expect(searchPath.annotations.map(a => a.annotation_id)).toEqual(
            dbPath.annotations.map(a => a.annotation_id),
        );
    });

    it('rejects non-palette color names instead of falling back to yellow', async () => {
        const response = await handleFindAnnotationsRequest({
            ...baseRequest,
            color: 'pink',
        });

        expect(response.error_code).toBe('invalid_color');
        expect(response.annotations).toEqual([]);
        expect(response.total_count).toBe(0);
    });
});
