import { beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate the plugin after the PDF schema bump: current "5", and schema 4
// still producible on demand.
vi.mock('@beaver/agent-core/extract/schema', async () => {
    const actual = await vi.importActual<typeof import('@beaver/agent-core/extract/schema')>(
        '@beaver/agent-core/extract/schema',
    );
    return { ...actual, SCHEMA_VERSION: '5' };
});
vi.mock('../../../src/beaver-extract/schema/presets', async () => {
    const actual = await vi.importActual<typeof import('../../../src/beaver-extract/schema/presets')>(
        '../../../src/beaver-extract/schema/presets',
    );
    return { ...actual, PRODUCIBLE_PDF_SCHEMA_VERSIONS: ['4', '5'] };
});
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheResolvedPdfDocument: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ createCitationHTML: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(), checkLibraryExcluded: vi.fn(() => null),
}));
vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => ({})) } }));
vi.mock('@beaver/agent-core/citations/atoms', () => ({
    citationMapAtom: Symbol('citationMapAtom'),
}));
vi.mock('@beaver/agent-core/citations/externalReferences', () => ({
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
}));
vi.mock('../../../react/utils/pageLabels', () => ({
    getCitationPreloadFilePath: vi.fn(),
    preloadPageLabelsForContent: vi.fn().mockResolvedValue({}),
}));

import { parseLoc } from '@beaver/agent-core/citations/citationGrammar';
import { extractAndCacheResolvedPdfDocument } from '../../../src/services/documentExtractionCore';
import {
    locatorSchemaVersion,
    structuredPdfResultForSchema,
} from '../../../src/services/documentExtraction/structuredPdfResult';
import { preloadStructuralLocatorPages } from '../../../src/utils/noteCitationExpand';
import { buildLocalCitationDataMapForContent } from '../../../react/utils/citationRenderContext';
import { getCitationPreloadFilePath } from '../../../react/utils/pageLabels';
import { structuredResultWithCitablePages } from '../../helpers/structuredDocuments';

const FILE_PATH = '/storage/ATTACH12/file.pdf';

/** Schema-5 document: sentence s1.2 on the first page. */
function currentResult() {
    return {
        ...structuredResultWithCitablePages(5, [{ index: 0, label: 'i', items: [{ id: 'p1.1', sentences: ['s1.1', 's1.2'] }] }]),
        schemaVersion: '5',
    };
}

/** Schema-4 document: sentence s12 on the fourth page. */
function olderResult() {
    return structuredResultWithCitablePages(5, [{ index: 3, label: 'iv', items: [{ id: 'p3', sentences: ['s12'] }] }]);
}

describe('locator resolution by id scheme', () => {
    let attachment: any;
    let getResult: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        attachment = {
            id: 42,
            key: 'ATTACH12',
            libraryID: 1,
            isAttachment: () => true,
            isPDFAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue(FILE_PATH),
        };
        getResult = vi.fn().mockResolvedValue(currentResult());
        (Zotero as any).Beaver = { documentCache: { getResult } };
        (Zotero as any).Items = { getByLibraryAndKey: vi.fn(() => attachment) };
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'ok',
            cached: false,
            result: olderResult(),
            totalPages: 5,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'ATTACH12' },
            contentType: 'application/pdf',
        });
        vi.mocked(getCitationPreloadFilePath).mockResolvedValue({
            item: attachment,
            filePath: FILE_PATH,
            isRemoteOnly: false,
        } as any);
    });

    it('maps each PDF locator to the schema version its ids name', () => {
        expect(locatorSchemaVersion(parseLoc('s12')!, true)).toBe('4');
        expect(locatorSchemaVersion(parseLoc('s1.2-s1.4')!, true)).toBe('5');
        expect(locatorSchemaVersion(parseLoc('page3')!, true)).toBe('5');
        // Non-PDF files have unversioned ids and resolve against their cached result.
        expect(locatorSchemaVersion(parseLoc('s12')!, false)).toBe('5');
    });

    it('returns nothing for a version that cannot be produced', async () => {
        const result = await structuredPdfResultForSchema({
            source: { kind: 'zotero', item: attachment },
            filePath: FILE_PATH,
            schemaVersion: '3',
        });
        expect(result).toBeNull();
        expect(getResult).not.toHaveBeenCalled();
        expect(extractAndCacheResolvedPdfDocument).not.toHaveBeenCalled();
    });

    it('resolves note locators of both schemes on save', async () => {
        const resolved = await preloadStructuralLocatorPages(
            '<citation id="1-ATTACH12" loc="s1.2"/> <citation id="1-ATTACH12" loc="s12"/>'
            + ' <citation id="1-ATTACH12" loc="s12-s12"/>',
        );

        expect(resolved.unresolved).toEqual([]);
        expect(Object.values(resolved.pages).map((page) => page.page).sort()).toEqual([1, 4, 4]);
        // The current version comes from the cache; the older one is extracted
        // once, uncached, for both schema-4 locators.
        expect(getResult).toHaveBeenCalledExactlyOnceWith(
            { libraryId: 1, zoteroKey: 'ATTACH12' }, 'structured', FILE_PATH,
        );
        expect(extractAndCacheResolvedPdfDocument).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ schemaVersion: '4', mode: 'structured', source: { kind: 'zotero', item: attachment } }),
        );
    });

    it('reports an older locator as unresolved when its extraction fails', async () => {
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'timeout', phase: 'pdf_extract', timeoutSeconds: 40, pageCount: 5, resolvedAttachment: null,
        });
        const resolved = await preloadStructuralLocatorPages('<citation id="1-ATTACH12" loc="s12"/>');
        expect(resolved.unresolved).toEqual(['id="1-ATTACH12" loc="s12"']);
    });

    it('reads non-PDF attachments from the cache whatever the id scheme', async () => {
        attachment.isPDFAttachment = () => false;
        await preloadStructuralLocatorPages('<citation id="1-ATTACH12" loc="s12"/>');
        expect(getResult).toHaveBeenCalledOnce();
        expect(extractAndCacheResolvedPdfDocument).not.toHaveBeenCalled();
    });

    it('builds note-export metadata for locators of both schemes', async () => {
        const map = await buildLocalCitationDataMapForContent(
            '<citation id="1-ATTACH12" loc="s1.2"/> <citation id="1-ATTACH12" loc="s12"/>',
        );

        expect(map['local:zotero:1-ATTACH12:s1.2'].locations).toEqual([{ part_id: 's1.2', page_idx: 0 }]);
        expect(map['local:zotero:1-ATTACH12:s12'].locations).toEqual([{ part_id: 's12', page_idx: 3 }]);
        expect(extractAndCacheResolvedPdfDocument).toHaveBeenCalledOnce();
    });
});
