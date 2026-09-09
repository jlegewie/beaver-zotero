import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn(() => ({})),
    },
}));

vi.mock('@beaver/agent-core/citations/atoms', () => ({
    citationDataMapAtom: Symbol('citationDataMapAtom'),
}));

vi.mock('@beaver/agent-core/citations/externalReferences', () => ({
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
    resolveExternalFileCitations,
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
                p12: {
                    id: 'p12',
                    kind: 'item',
                    pageIndex: 1,
                    pageLabel: '6',
                    itemId: 'p12',
                },
                table3: {
                    id: 'table3',
                    kind: 'item',
                    pageIndex: 4,
                    pageLabel: '12',
                    itemId: 'table3',
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
        expect(data.locations).toEqual([
            { part_id: 's25', page_idx: 2 },
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
        const existing = { citation_id: 'c1', run_id: 'r1', locations: [] } as any;
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

    it('resolves accepted locator aliases through canonical citation-index ids', async () => {
        const map = await buildLocalCitationDataMapForContent(
            [
                'Paragraph <citation id="1-ATTACH01" loc="paragraph12"/>',
                'Table <citation id="1-ATTACH01" loc="tab3"/>',
            ].join('\n')
        );

        expect(map['local:zotero:1-ATTACH01:paragraph12']?.locations).toEqual([
            { part_id: 'p12', page_idx: 1 },
        ]);
        expect(map['local:zotero:1-ATTACH01:paragraph12']?.pages).toEqual([2]);
        expect(map['local:zotero:1-ATTACH01:paragraph12']?.page_labels).toEqual({ 1: '6' });

        expect(map['local:zotero:1-ATTACH01:tab3']?.locations).toEqual([
            { part_id: 'table3', page_idx: 4 },
        ]);
        expect(map['local:zotero:1-ATTACH01:tab3']?.pages).toEqual([5]);
        expect(map['local:zotero:1-ATTACH01:tab3']?.page_labels).toEqual({ 4: '12' });
    });

    it('does not synthesize metadata for explicit page locators', async () => {
        const map = await buildLocalCitationDataMapForContent(
            'Claim <citation id="1-ATTACH01" loc="page3"/>'
        );

        expect(map).toEqual({});
        expect(cache.getResult).not.toHaveBeenCalled();
    });

    describe('resolveExternalFileCitations', () => {
        let db: any;
        const record = {
            extKey: 'AB12CD34',
            filename: 'Field notes.pdf',
            storedPath: '/beaver/external-files/AB12CD34.pdf',
            contentKind: 'pdf',
        };

        beforeEach(() => {
            db = { getExternalFileByKey: vi.fn() };
            (globalThis as any).Zotero.Beaver.db = db;
        });

        it('returns local paths for external files present on this computer', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(true);

            const { localPaths } = await resolveExternalFileCitations('See <citation id="ext-ab12cd34"/>');

            // Ext key normalized to uppercase before the DB lookup.
            expect(db.getExternalFileByKey).toHaveBeenCalledWith('AB12CD34');
            expect(localPaths).toEqual({ AB12CD34: '/beaver/external-files/AB12CD34.pdf' });
        });

        it('omits external files with no local copy on this computer', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(false);

            const { localPaths } = await resolveExternalFileCitations('See <citation id="ext-ab12cd34"/>');

            expect(localPaths).toEqual({});
        });

        it('names an external file from the registry even with no local copy', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(false);

            const { citationDataMap } = await resolveExternalFileCitations('See <citation id="ext-ab12cd34"/>');

            expect(citationDataMap['local:extfile:AB12CD34']).toMatchObject({
                citation_type: 'external_file',
                content_kind: 'pdf',
                display_name: 'Field notes.pdf',
                resolved_ref: { kind: 'external_file', ext_key: 'AB12CD34' },
            });
        });

        it('carries the cited page so the export keeps its locator', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(true);

            const { citationDataMap } = await resolveExternalFileCitations(
                'See <citation id="ext-ab12cd34" loc="page3"/>'
            );

            const citation = citationDataMap['local:extfile:AB12CD34:page3'];
            expect(citation).toBeDefined();
            expect(citation.pages).toEqual([3]);
        });

        it('keeps every page of a cited range so the export shows the full span', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(true);

            const { citationDataMap } = await resolveExternalFileCitations(
                'See <citation id="ext-ab12cd34" loc="page6-8"/>'
            );

            expect(citationDataMap['local:extfile:AB12CD34:page6-8'].pages).toEqual([6, 7, 8]);
        });

        it('keeps every page of a comma-separated locator', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(true);

            const { citationDataMap } = await resolveExternalFileCitations(
                'See <citation id="ext-ab12cd34" loc="page2,5-6"/>'
            );

            expect(citationDataMap['local:extfile:AB12CD34:page2,5-6'].pages).toEqual([2, 5, 6]);
        });

        it('keeps only the endpoints of an implausibly long range', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(true);

            const { citationDataMap } = await resolveExternalFileCitations(
                'See <citation id="ext-ab12cd34" loc="page1-999999"/>'
            );

            expect(citationDataMap['local:extfile:AB12CD34:page1-999999'].pages).toEqual([1, 999999]);
        });

        it('builds no citation for a file this device does not have', async () => {
            db.getExternalFileByKey.mockResolvedValue(null);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(false);

            const { localPaths, citationDataMap } = await resolveExternalFileCitations(
                'See <citation id="ext-ab12cd34"/>'
            );

            expect(localPaths).toEqual({});
            expect(citationDataMap).toEqual({});
        });

        it('reads each file once and ignores non-external-file citations', async () => {
            db.getExternalFileByKey.mockResolvedValue(record);
            (globalThis as any).IOUtils.exists = vi.fn().mockResolvedValue(true);

            const { localPaths, citationDataMap } = await resolveExternalFileCitations(
                'A <citation id="ext-ab12cd34"/> B <citation id="ext-ab12cd34" loc="page2"/> C <citation id="1-ATTACH01"/>'
            );

            expect(db.getExternalFileByKey).toHaveBeenCalledTimes(1);
            expect(localPaths).toEqual({ AB12CD34: '/beaver/external-files/AB12CD34.pdf' });
            expect(Object.keys(citationDataMap)).toEqual([
                'local:extfile:AB12CD34',
                'local:extfile:AB12CD34:page2',
            ]);
        });
    });
});
