import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/host/zotero/itemData', () => ({
    getPageLabelsForItem: vi.fn(() => null),
}));

vi.mock('../../../react/utils/pageLabels', () => ({
    resolvePageLabelFromLabels: vi.fn((_labels, page: number) => String(page)),
    translatePageNumberToLabelFromLabels: vi.fn((_labels, page: string) => page),
}));

vi.mock('../../../src/utils/zoteroLinkCitation', () => ({
    isLinkCitationItem: vi.fn(() => true),
    buildZoteroCitationLinkHTML: vi.fn(() => '<a href="https://example.com">Example</a>'),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

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

    it('falls back to the legacy local library id when no portable ref exists', () => {
        zoteroDocumentExport.renderCitation(citationRequest());

        expect(Zotero.Items.getByLibraryAndKey).toHaveBeenCalledWith(7, 'ABCD1234');
    });
});
