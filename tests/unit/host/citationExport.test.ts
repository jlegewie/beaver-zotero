import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/host/zotero/itemData', () => ({
    getPageLabelsForItem: vi.fn(() => null),
}));

vi.mock('../../../react/utils/pageLabels', () => ({
    translatePageNumberToLabelFromLabels: vi.fn((_labels, page: string) => page),
}));

vi.mock('@beaver/agent-ui/utils/pageLabels', () => ({
    resolvePageLabelFromLabels: vi.fn((_labels, page: number) => String(page)),
}));

vi.mock('../../../src/utils/zoteroLinkCitation', () => ({
    isLinkCitationItem: vi.fn(() => true),
    buildZoteroCitationLinkHTML: vi.fn(() => '<a href="https://example.com">Example</a>'),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { buildZoteroCitationLinkHTML, isLinkCitationItem } from '../../../src/utils/zoteroLinkCitation';
import { zoteroDocumentExport } from '../../../react/host/zotero/citationExport';

function citationRequest(overrides: Record<string, unknown> = {}) {
    return {
        effectiveLibraryID: 7,
        effectiveLibraryRef: undefined,
        effectiveItemKey: 'ABCD1234',
        requestedRef: null,
        pages: [],
        pageLabelsByAttachmentId: {},
        ...overrides,
    } as any;
}

describe('zoteroDocumentExport.renderCitation', () => {
    const item = { key: 'ABCD1234' };

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries = { userLibraryID: 1 };
        (globalThis as any).Zotero.Groups = {
            getLibraryIDFromGroupID: vi.fn((groupID: number) => groupID === 123 ? 42 : false),
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
        };
    });

    it('lets a portable library ref override a stale device-local library id', () => {
        const result = zoteroDocumentExport.renderCitation(citationRequest({
            effectiveLibraryID: 7,
            effectiveLibraryRef: 'g123',
        }));

        expect(result).toEqual({
            kind: 'html',
            html: '<a href="https://example.com">Example</a>',
        });
        expect(Zotero.Items.getByLibraryAndKey).toHaveBeenCalledWith(42, 'ABCD1234');
    });

    it('uses resolved pages for structural locators', () => {
        const loc = { kind: 'sentence', value: '4', raw: 's4' };
        zoteroDocumentExport.renderCitation(citationRequest({ requestedRef: { loc }, pages: [6] }));
        expect(buildZoteroCitationLinkHTML).toHaveBeenCalledWith(item, { kind: 'page', value: '6', raw: 'page6' }, 6);
    });

    it('retains all metadata pages when no requested locator exists', () => {
        zoteroDocumentExport.renderCitation(citationRequest({ pages: [6, 7] }));
        expect(buildZoteroCitationLinkHTML).toHaveBeenCalledWith(item,
            { kind: 'page', value: '6-7', raw: 'page6-7' }, 6);
    });

    it.each([
        { pages: [2, 4], labels: undefined, expected: '2-4' },
        { pages: [2, 4, 2], labels: { 1: 'iv', 3: 'vi' }, expected: 'iv-vi' },
        { pages: [2, 2], labels: { 1: 'iv' }, expected: 'iv' },
    ])('formats structural spans as inclusive page ranges: $expected', ({ pages, labels, expected }) => {
        zoteroDocumentExport.renderCitation(citationRequest({
            requestedRef: { loc: { kind: 'sentence', value: '1-5', raw: 's1-s5' } },
            pages, metadata: { page_labels: labels },
        }));
        expect(buildZoteroCitationLinkHTML).toHaveBeenCalledWith(item,
            { kind: 'page', value: expected, raw: `page${expected}` }, 2);
    });

    it.each([null, { loc: { kind: 'page', value: '2, 4', raw: 'page2, 4' } }])(
        'preserves separate cited pages without a structural span (%j)', (requestedRef) => {
            zoteroDocumentExport.renderCitation(citationRequest({ requestedRef, pages: [2, 4] }));
            expect(buildZoteroCitationLinkHTML).toHaveBeenCalledWith(item,
                { kind: 'page', value: '2, 4', raw: 'page2, 4' }, 2);
        },
    );

    it('omits unresolved structural locators rather than displaying sentence numbers', () => {
        zoteroDocumentExport.renderCitation(citationRequest({
            requestedRef: { loc: { kind: 'sentence', value: '1-5', raw: 's1-s5' } },
        }));
        expect(buildZoteroCitationLinkHTML).toHaveBeenCalledWith(item, undefined, undefined);
    });

    it('falls back to the legacy local library id when no portable ref exists', () => {
        zoteroDocumentExport.renderCitation(citationRequest());

        expect(Zotero.Items.getByLibraryAndKey).toHaveBeenCalledWith(7, 'ABCD1234');
    });
});

describe('zoteroDocumentExport.renderCitation for native citations', () => {
    const zotero = (globalThis as any).Zotero;
    const regular = { key: 'ABCD1234', isAttachment: () => false, isRegularItem: () => true };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(isLinkCitationItem).mockReturnValue(false);
        zotero.Libraries = { userLibraryID: 1 };
        zotero.Items = { getByLibraryAndKey: vi.fn(() => regular) };
        zotero.URI = { getItemURI: (i: any) => `http://zotero.org/users/1/items/${i.key}` };
        zotero.Utilities = { ...zotero.Utilities, Item: { itemToCSLJSON: () => ({ title: 'T' }) } };
        zotero.EditorInstanceUtilities = { formatCitation: vi.fn(() => '(<span class="citation-item">Smith, 2020</span>)') };
    });

    afterEach(() => {
        vi.mocked(isLinkCitationItem).mockReturnValue(true);
    });

    function citationItem(request: Record<string, unknown>) {
        const result = zoteroDocumentExport.renderCitation(citationRequest(request));
        if (result?.kind !== 'citation') throw new Error('expected a native citation');
        return JSON.parse(decodeURIComponent(result.citationData)).citationItems[0];
    }

    it('stores the first page of a requested range, so the citation navigates', () => {
        const ci = citationItem({ requestedRef: { loc: { kind: 'page', value: '12-14', raw: 'page12-14' } } });

        expect(ci.locator).toBe('12');
        expect(ci).not.toHaveProperty('label');
    });

    it('stores the first metadata page', () => {
        expect(citationItem({ pages: [7, 5, 6] }).locator).toBe('5');
    });

    it('stores no locator when nothing is cited by page', () => {
        expect(citationItem({})).not.toHaveProperty('locator');
    });
});

describe('zoteroDocumentExport.renderExternalFileCitation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero as any).File = { pathToFileURI: vi.fn(() => 'file:///Report%20%26%20findings.pdf') };
    });

    it('uses the shared escaped file-link format', () => {
        expect(zoteroDocumentExport.renderExternalFileCitation!({
            externalFileKey: 'MRDTFYHP', displayName: 'Report & findings.pdf',
            locatorSuffix: ', p. 6', localPathsByExtKey: { MRDTFYHP: '/Report & findings.pdf' },
        })).toEqual({
            kind: 'html',
            html: '(<a href="file:///Report%20%26%20findings.pdf">Report &amp; findings.pdf</a>, p. 6)',
        });
    });

    it('lets the render layer fall back to text when no local file is available', () => {
        expect(zoteroDocumentExport.renderExternalFileCitation!({
            externalFileKey: 'MRDTFYHP', displayName: 'Report.pdf',
            locatorSuffix: ', p. 6', localPathsByExtKey: {},
        })).toBeNull();
    });
});
