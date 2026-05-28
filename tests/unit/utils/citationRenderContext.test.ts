import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn(() => ({})),
    },
}));

vi.mock('../../../react/atoms/citations', () => ({
    citationDataMapAtom: Symbol('citationDataMapAtom'),
}));

vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
}));

vi.mock('../../../react/utils/pageLabels', () => ({
    getCitationPreloadFilePath: vi.fn(),
    preloadPageLabelsForContent: vi.fn().mockResolvedValue({}),
}));

import {
    buildLocalCitationDataMapForContent,
    prepareCitationRenderContext,
} from '../../../react/utils/citationRenderContext';
import {
    getCitationPreloadFilePath,
    preloadPageLabelsForContent,
} from '../../../react/utils/pageLabels';

const mockGetCitationPreloadFilePath = vi.mocked(getCitationPreloadFilePath);
const mockPreloadPageLabelsForContent = vi.mocked(preloadPageLabelsForContent);

function structuredResult() {
    return {
        mode: 'structured',
        document: {
            pageCount: 5,
            pages: [],
            citationIndex: {
                s25: {
                    id: 's25',
                    kind: 'sentence',
                    pageIndex: 2,
                    pageLabel: '7',
                    itemId: 'p4',
                    sentenceId: 's25',
                },
                s26: {
                    id: 's26',
                    kind: 'sentence',
                    pageIndex: 2,
                    pageLabel: '7',
                    itemId: 'p4',
                    sentenceId: 's26',
                },
            },
        },
    };
}

describe('citation render context', () => {
    let attachment: any;
    let cache: any;

    beforeEach(() => {
        vi.clearAllMocks();

        attachment = {
            id: 42,
            key: 'ATTACH01',
            libraryID: 1,
        };
        cache = {
            getResult: vi.fn().mockResolvedValue(structuredResult()),
        };

        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Beaver: { documentCache: cache },
            Items: {
                getByLibraryAndKey: vi.fn(() => attachment),
            },
        };

        mockGetCitationPreloadFilePath.mockResolvedValue({
            item: attachment,
            filePath: '/storage/ATTACH01/file.pdf',
            isRemoteOnly: false,
        });
        mockPreloadPageLabelsForContent.mockResolvedValue({});
    });

    it('builds local page metadata for sentence locators from the structured cache', async () => {
        const map = await buildLocalCitationDataMapForContent(
            'Claim <citation id="1-ATTACH01" loc="s25-s26"/>'
        );

        const data = map['local:zotero:1-ATTACH01:s25-s26'];
        expect(data).toBeTruthy();
        expect(cache.getResult).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: 'ATTACH01' },
            'structured',
            '/storage/ATTACH01/file.pdf',
        );
        expect(data.pages).toEqual([3]);
        expect(data.parts).toEqual([
            { part_id: 's25', locations: [{ page_idx: 2 }] },
        ]);
        expect(data.page_labels).toEqual({ 2: '7' });
        expect(data.requested_ref).toMatchObject({
            kind: 'zotero',
            library_id: 1,
            zotero_key: 'ATTACH01',
            loc: { kind: 'sentence', raw: 's25-s26' },
        });
    });

    it('merges local citation metadata with explicit render context', async () => {
        const existing = { citation_id: 'c1', run_id: 'r1', parts: [] } as any;
        mockPreloadPageLabelsForContent.mockResolvedValue({ 42: { 2: '7' } });

        const context = await prepareCitationRenderContext(
            'Claim <citation id="1-ATTACH01" loc="s25-s26"/>',
            {
                citationDataMap: { c1: existing },
                pageLabelsByAttachmentId: { 9: { 0: 'i' } },
            },
        );

        expect(context?.citationDataMap?.c1).toBe(existing);
        expect(context?.citationDataMap?.['local:zotero:1-ATTACH01:s25-s26']).toBeTruthy();
        expect(context?.pageLabelsByAttachmentId).toEqual({
            9: { 0: 'i' },
            42: { 2: '7' },
        });
    });

    it('does not synthesize metadata for explicit page locators', async () => {
        const map = await buildLocalCitationDataMapForContent(
            'Claim <citation id="1-ATTACH01" loc="page3"/>'
        );

        expect(map).toEqual({});
        expect(cache.getResult).not.toHaveBeenCalled();
    });
});
