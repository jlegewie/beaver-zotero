import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils.ts', () => ({
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('../../../src/utils/libraryIdentity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/utils/libraryIdentity')>()),
    resolveItemReference: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    formatZoteroCreatorsString: vi.fn(() => null),
    getCreatorsFromItem: vi.fn(() => []),
    getYearFromItem: vi.fn(() => null),
    serializeAnnotation: vi.fn((annotation: any) => ({ annotation_id: annotation.key })),
}));

import { handleGetAnnotationsRequest } from '../../../src/services/agentDataProvider/handleGetAnnotationsRequest';
import { modelObjectId, resolveItemReference } from '../../../src/utils/libraryIdentity';
import type { WSGetAnnotationsRequest } from '@beaver/agent-core/protocol/agentProtocol';

const annotations = new Map<number, any>([
    [101, { id: 101, key: 'ANNOT101', libraryID: 1 }],
    [102, { id: 102, key: 'ANNOT102', libraryID: 1 }],
    [103, { id: 103, key: 'ANNOT103', libraryID: 1 }],
    [104, { id: 104, key: 'ANNOT104', libraryID: 1 }],
]);

// An attachment in a library whose items are not loaded yet: the
// item-returning form of getAnnotations() throws, the ID form works.
const attachment = {
    id: 10,
    key: 'ATTACH01',
    libraryID: 1,
    parentID: false,
    isFileAttachment: () => true,
    getAnnotations: vi.fn((_includeTrashed?: boolean, asIDs?: boolean) => {
        if (!asIDs) throw new Error('UnloadedDataException: Item 101 not yet loaded');
        return [101, 102, 103, 104];
    }),
};

function request(overrides: Partial<WSGetAnnotationsRequest> = {}): WSGetAnnotationsRequest {
    return {
        event: 'get_annotations_request',
        request_id: 'req-1',
        attachment_id: modelObjectId(1, 'ATTACH01'),
        offset: 0,
        limit: 10,
        ...overrides,
    } as WSGetAnnotationsRequest;
}

describe('handleGetAnnotationsRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveItemReference).mockResolvedValue({ status: 'found', item: attachment } as any);
        (globalThis as any).Zotero.Items = {
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
            // Zotero returns cached objects first and appends newly loaded
            // ones; treat 102 and 104 as cached to reorder the result.
            getAsync: vi.fn(async (ids: number[]) => {
                const cached = ids.filter(id => id === 102 || id === 104);
                const loaded = ids.filter(id => !cached.includes(id));
                return [...cached, ...loaded].map(id => annotations.get(id));
            }),
        };
    });

    it('returns annotations in document order for a library whose items are not loaded', async () => {
        const response = await handleGetAnnotationsRequest(request());

        expect(response.error).toBeUndefined();
        expect(response.total_count).toBe(4);
        expect(response.annotations.map((a: any) => a.annotation_id))
            .toEqual(['ANNOT101', 'ANNOT102', 'ANNOT103', 'ANNOT104']);
    });

    it('loads only the requested page and keeps its order', async () => {
        const response = await handleGetAnnotationsRequest(request({ offset: 1, limit: 2 }));

        expect((globalThis as any).Zotero.Items.getAsync).toHaveBeenCalledWith([102, 103]);
        expect(response.total_count).toBe(4);
        expect(response.annotations.map((a: any) => a.annotation_id)).toEqual(['ANNOT102', 'ANNOT103']);
    });
});
