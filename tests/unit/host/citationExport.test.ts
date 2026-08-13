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

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { zoteroDocumentExport } from '../../../react/host/zotero/citationExport';
import { isLinkCitationItem } from '../../../src/utils/zoteroLinkCitation';

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

/**
 * The locator token a note citation is written with.
 *
 * `create_note` renders through this function rather than `createCitationHTML`,
 * so without the key here a structural locator is flattened to the page it
 * resolved to and `s56-s59` becomes indistinguishable from `page2` the moment
 * it lands in a note.
 */
describe('zoteroDocumentExport.renderCitation — Beaver locator key', () => {
    const attachment = { key: 'ATT99999', attachmentContentType: 'application/pdf' };
    const item = {
        key: 'ABCD1234',
        parentItem: null,
        isAttachment: () => false,
        getAttachments: () => [1],
    };

    function firstItem(result: any) {
        return JSON.parse(decodeURIComponent(result.citationData)).citationItems[0];
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries = { userLibraryID: 1 };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => item),
            get: vi.fn(() => attachment),
        };
        (globalThis as any).Zotero.URI = { getItemURI: vi.fn(() => 'http://zotero.org/users/1/items/ABCD1234') };
        (globalThis as any).Zotero.Utilities = { Item: { itemToCSLJSON: vi.fn(() => ({ id: 'x' })) } };
        (globalThis as any).Zotero.EditorInstanceUtilities = { formatCitation: vi.fn(() => '(Author, 2024)') };
        // The file-level mock makes every item a link citation, which returns
        // before any citation object is built.
        (isLinkCitationItem as any).mockReturnValue(false);
    });

    it('records a structural token and pins the attachment it addresses', () => {
        const result: any = zoteroDocumentExport.renderCitation(citationRequest({
            requestedRef: { kind: 'zotero', loc: { kind: 'sentence', value: '56-59', raw: 's56-s59' } },
            pages: [2],
        }));

        expect(firstItem(result).beaver).toEqual({ v: 1, loc: 's56-s59', att: 'ATT99999' });
    });

    it('keeps Zotero\'s printed label next to the token, not instead of it', () => {
        const result: any = zoteroDocumentExport.renderCitation(citationRequest({
            requestedRef: { kind: 'zotero', loc: { kind: 'page', value: '2', raw: 'page2' } },
            pages: [2],
        }));

        const ci = firstItem(result);
        expect(ci.locator).toBe('2');
        expect(ci.beaver).toEqual({ v: 1, loc: 'page2', att: 'ATT99999' });
    });

    it('omits the key entirely when the tag carried no locator', () => {
        const result: any = zoteroDocumentExport.renderCitation(citationRequest({
            requestedRef: { kind: 'zotero' },
        }));

        expect(firstItem(result)).not.toHaveProperty('beaver');
    });
});

/**
 * Which attachment the pin names.
 *
 * A citation the run made against a document resolves to the ATTACHMENT, and
 * that identity travels in the citation metadata — so the pin is read off the
 * citation rather than inferred from whichever attachment the item prefers at
 * export time.
 */
describe('zoteroDocumentExport.renderCitation — which attachment is pinned', () => {
    const attachmentRequest = {
        requestedRef: { kind: 'zotero', loc: { kind: 'sentence', value: '56', raw: 's56' } },
        pages: [2],
    };

    function firstItem(result: any) {
        return JSON.parse(decodeURIComponent(result.citationData)).citationItems[0];
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries = { userLibraryID: 1 };
        (globalThis as any).Zotero.URI = { getItemURI: vi.fn(() => 'http://zotero.org/users/1/items/PARENT01') };
        (globalThis as any).Zotero.Utilities = { Item: { itemToCSLJSON: vi.fn(() => ({ id: 'x' })) } };
        (globalThis as any).Zotero.EditorInstanceUtilities = { formatCitation: vi.fn(() => '(A, 2024)') };
        (isLinkCitationItem as any).mockReturnValue(false);
    });

    it('pins the attachment the citation resolved to, not the parent\'s current best', () => {
        // The citation resolved to ATT_SOURCE; the parent now prefers ATT_BEST.
        const source = {
            key: 'ATT_SOURCE',
            isAttachment: () => true,
            parentItem: { key: 'PARENT01' },
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => source),
            get: vi.fn(() => ({ key: 'ATT_BEST', attachmentContentType: 'application/pdf' })),
        };

        const result: any = zoteroDocumentExport.renderCitation(citationRequest(attachmentRequest));
        expect(firstItem(result).beaver).toEqual({ v: 1, loc: 's56', att: 'ATT_SOURCE' });
    });

    it('writes NO pin when a parent item has several attachments to choose between', () => {
        // Parent with several files: do not pin today's "best" as if it were the source.
        const parent = {
            key: 'PARENT01',
            parentItem: null,
            isAttachment: () => false,
            getAttachments: () => [7, 8],
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => parent),
            get: vi.fn(() => ({ key: 'ATT_BEST', attachmentContentType: 'application/pdf' })),
        };

        const result: any = zoteroDocumentExport.renderCitation(citationRequest(attachmentRequest));
        expect(firstItem(result).beaver).toEqual({ v: 1, loc: 's56' });
    });

    it('pins the sole attachment of a single-attachment item, where there is nothing to guess', () => {
        const parent = {
            key: 'PARENT01',
            parentItem: null,
            isAttachment: () => false,
            getAttachments: () => [7],
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => parent),
            get: vi.fn(() => ({ key: 'ATT_ONLY', attachmentContentType: 'application/pdf' })),
        };

        const result: any = zoteroDocumentExport.renderCitation(citationRequest(attachmentRequest));
        expect(firstItem(result).beaver).toEqual({ v: 1, loc: 's56', att: 'ATT_ONLY' });
    });
});
