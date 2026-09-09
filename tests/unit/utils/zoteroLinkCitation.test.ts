import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildZoteroCitationLinkHTML,
    isLinkCitationItem,
    preloadStandaloneAttachmentLinks,
    buildZoteroCitationLinkLabel,
    buildZoteroCitationLinkURI,
    parseZoteroCitationLinkHref,
} from '../../../src/utils/zoteroLinkCitation';

describe('zoteroLinkCitation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Libraries: {
                userLibraryID: 1,
                get: vi.fn((libraryID: number) => ({
                    libraryID,
                    isGroup: libraryID === 7,
                })),
            },
            Groups: {
                getGroupIDFromLibraryID: vi.fn((libraryID: number) => libraryID === 7 ? 42 : null),
                getLibraryIDFromGroupID: vi.fn((groupID: number) => groupID === 42 ? 7 : null),
            },
        };
    });

    it('builds select links for notes', () => {
        const note = {
            libraryID: 1,
            key: 'NOTE1234',
            isNote: vi.fn(() => true),
            getNoteTitle: vi.fn(() => 'Project note'),
        };

        expect(buildZoteroCitationLinkURI(note)).toBe('zotero://select/library/items/NOTE1234');
        expect(buildZoteroCitationLinkLabel(note)).toBe('Note: Project note');
        expect(buildZoteroCitationLinkHTML(note)).toBe(
            '(<a href="zotero://select/library/items/NOTE1234" rel="noopener noreferrer nofollow">Note: Project note</a>)'
        );
    });

    it('uses a compact parent source label for child notes', () => {
        const note = {
            libraryID: 1,
            key: 'NOTE1234',
            isNote: vi.fn(() => true),
            getNoteTitle: vi.fn(() => 'Project note'),
            parentItem: {
                firstCreator: 'Smith',
                getField: vi.fn((field: string) => field === 'date' ? '2019-04-01' : ''),
            },
        };

        expect(buildZoteroCitationLinkLabel(note)).toBe('Note in Smith 2019: Project note');
    });

    it('falls back when note title data is not loaded', () => {
        const note = {
            libraryID: 1,
            key: 'NOTE1234',
            isNote: vi.fn(() => true),
            getNoteTitle: vi.fn(() => {
                throw new Error('Item data not loaded');
            }),
        };

        expect(buildZoteroCitationLinkLabel(note)).toBe('Note: Note');
        expect(buildZoteroCitationLinkHTML(note)).toBe(
            '(<a href="zotero://select/library/items/NOTE1234" rel="noopener noreferrer nofollow">Note: Note</a>)'
        );
    });

    it('builds open-pdf links with compact source labels for annotations in group libraries', () => {
        const annotation = {
            libraryID: 7,
            key: 'ANNOT123',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
            annotationText: 'Important highlighted passage',
            annotationPageLabel: '12',
            parentItem: {
                key: 'ATTACH12',
                isFileAttachment: vi.fn(() => true),
                parentItem: {
                    firstCreator: 'Smith',
                    getField: vi.fn((field: string) => field === 'date' ? '2019-04-01' : ''),
                },
            },
        };

        expect(buildZoteroCitationLinkURI(annotation)).toBe(
            'zotero://open-pdf/groups/42/items/ATTACH12?annotation=ANNOT123'
        );
        expect(buildZoteroCitationLinkLabel(annotation)).toBe('Annotation in Smith 2019, page 12');
        expect(buildZoteroCitationLinkHTML(annotation)).toBe(
            '(<a href="zotero://open-pdf/groups/42/items/ATTACH12?annotation=ANNOT123" rel="noopener noreferrer nofollow">Annotation in Smith 2019, page 12</a>)'
        );
    });

    it('falls back to the attachment title when an annotation has no parent item', () => {
        const annotation = {
            libraryID: 1,
            key: 'ANNOT123',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
            annotationPageLabel: '3',
            parentItem: {
                key: 'ATTACH12',
                isFileAttachment: vi.fn(() => true),
                isAttachment: vi.fn(() => true),
                getField: vi.fn((field: string) => field === 'title' ? 'Standalone PDF' : ''),
            },
        };

        expect(buildZoteroCitationLinkLabel(annotation)).toBe('Annotation in Standalone PDF, page 3');
    });

    it('falls back when annotation page label data is not loaded', () => {
        const annotation: any = {
            libraryID: 1,
            key: 'ANNOT123',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
            parentItem: {
                key: 'ATTACH12',
                isFileAttachment: vi.fn(() => true),
                parentItem: {
                    firstCreator: 'Smith',
                    getField: vi.fn((field: string) => field === 'date' ? '2019-04-01' : ''),
                },
            },
        };
        Object.defineProperty(annotation, 'annotationPageLabel', {
            get: () => {
                throw new Error('Annotation data not loaded');
            },
        });

        expect(buildZoteroCitationLinkLabel(annotation)).toBe('Annotation in Smith 2019');
        expect(buildZoteroCitationLinkHTML(annotation)).toBe(
            '(<a href="zotero://open-pdf/library/items/ATTACH12?annotation=ANNOT123" rel="noopener noreferrer nofollow">Annotation in Smith 2019</a>)'
        );
    });

    it('parses note and annotation citation hrefs', () => {
        expect(parseZoteroCitationLinkHref('zotero://select/library/items/NOTE1234')).toEqual({
            libraryId: 1,
            itemKey: 'NOTE1234',
        });
        expect(parseZoteroCitationLinkHref('zotero://open-pdf/groups/42/items/ATTACH12?annotation=ANNOT123')).toEqual({
            libraryId: 7,
            itemKey: 'ANNOT123',
        });
        expect(parseZoteroCitationLinkHref('zotero://open-pdf/library/items/ATTACH12?foo=1&amp;annotation=ANNOT123')).toEqual({
            libraryId: 1,
            itemKey: 'ANNOT123',
        });
        // Without an annotation the link names the attachment itself.
        expect(parseZoteroCitationLinkHref('zotero://open/groups/42/items/ATTACH12?page=6')).toEqual({
            libraryId: 7,
            itemKey: 'ATTACH12',
        });
        expect(parseZoteroCitationLinkHref('zotero://open-pdf/library/items/ATTACH12')).toEqual({
            libraryId: 1,
            itemKey: 'ATTACH12',
        });
    });

    it.each([1, 7])('opens standalone PDFs in library %s at the cited page, without accessing their files', (libraryID) => {
        const item = { libraryID, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true,
            getField: () => 'Report <draft>',
            getFilePathAsync: vi.fn(() => { throw new Error('Missing file'); }),
        };
        const scope = libraryID === 7 ? 'groups/42' : 'library';
        expect(isLinkCitationItem(item)).toBe(true);
        const uri = buildZoteroCitationLinkURI(item, 6)!;
        expect(uri).toBe(`zotero://open/${scope}/items/ATTACH12?page=6`);
        expect(parseZoteroCitationLinkHref(uri)).toEqual({ libraryId: libraryID, itemKey: 'ATTACH12' });
        expect(buildZoteroCitationLinkHTML(item, { kind: 'page', value: '6-8', raw: 'page6-8' }, 6))
            .toBe(`(<a href="zotero://open/${scope}/items/ATTACH12?page=6" rel="noopener noreferrer nofollow">`
                + 'Report &lt;draft&gt;</a>, p. 6-8)');
        expect(item.getFilePathAsync).not.toHaveBeenCalled();
        expect(isLinkCitationItem({ ...item, parentID: 42 })).toBe(false);
    });

    it('opens a standalone PDF without a page when none was cited', () => {
        const item = { libraryID: 1, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true,
            getField: () => 'Report.pdf',
        };
        expect(buildZoteroCitationLinkURI(item)).toBe('zotero://open/library/items/ATTACH12');
    });

    it('omits the page for a non-PDF file attachment, whose reader pages it differently', () => {
        // Zotero reads `?page=` as a physical page index; the EPUB view resolves
        // it through its own page mapping, where a cited PDF-style page is wrong.
        const item = { libraryID: 1, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => false,
            getField: () => 'Book.epub',
        };
        expect(buildZoteroCitationLinkURI(item, 6)).toBe('zotero://open/library/items/ATTACH12');
    });

    it('selects a PDF whose file this computer does not have', () => {
        // A synced file that was never downloaded: Zotero's open handler cannot
        // resolve a path and returns without doing anything.
        const item = { libraryID: 1, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true,
            fileExistsCached: () => false,
            getField: () => 'Report.pdf',
        };
        expect(buildZoteroCitationLinkURI(item, 6)).toBe('zotero://select/library/items/ATTACH12');
    });

    it('opens a PDF whose file has been checked and is present', () => {
        const item = { libraryID: 1, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true,
            fileExistsCached: () => true,
            getField: () => 'Report.pdf',
        };
        expect(buildZoteroCitationLinkURI(item, 6)).toBe('zotero://open/library/items/ATTACH12?page=6');
    });

    it('selects an attachment with no file, which zotero://open cannot open', () => {
        const item = { libraryID: 1, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => false, isPDFAttachment: () => false,
            getField: () => 'Linked page',
        };
        const uri = buildZoteroCitationLinkURI(item, 6)!;
        expect(uri).toBe('zotero://select/library/items/ATTACH12');
        expect(parseZoteroCitationLinkHref(uri)).toEqual({ libraryId: 1, itemKey: 'ATTACH12' });
    });

    it('uses a filename when attachment title data is unavailable', () => {
        expect(buildZoteroCitationLinkLabel({ isAttachment: () => true, parentID: false,
            getField: () => { throw new Error('Not loaded'); }, attachmentFilename: 'Report.pdf',
        })).toBe('Report.pdf');
    });

    it('batch loads unique standalone attachments while skipping excluded and child items', async () => {
        const item = { isAttachment: () => true, parentID: false, getFilePathAsync: vi.fn().mockResolvedValue('/a.pdf') };
        const second = { ...item, getFilePathAsync: vi.fn().mockResolvedValue('/b.pdf') };
        const child = { ...item, parentID: 42, getFilePathAsync: vi.fn().mockResolvedValue('/c.pdf') };
        (Zotero as any).Items = {
            getByLibraryAndKey: vi.fn((_libraryID, key) =>
                key === 'ATTACH12' ? item : key === 'ATTACH34' ? second : child),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
        await preloadStandaloneAttachmentLinks(
            '<citation id="u-ATTACH12"/><citation att_id="1-ATTACH12"/>'
                + '<citation id="u-ATTACH34"/><citation id="u-CHILDPDF"/><citation id="g42-BLOCKED1"/>',
            libraryID => libraryID === 1,
        );
        expect(Zotero.Items.getByLibraryAndKey).toHaveBeenCalledTimes(3);
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledExactlyOnceWith([item, second], ['itemData']);
        // Resolving each path is what populates the file state the link builder reads.
        expect(item.getFilePathAsync).toHaveBeenCalledOnce();
        expect(second.getFilePathAsync).toHaveBeenCalledOnce();
        expect(child.getFilePathAsync).not.toHaveBeenCalled();
    });

    it('renders a link for an attachment whose file could not be checked', async () => {
        const item = { libraryID: 1, key: 'ATTACH12', parentID: false,
            isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true,
            fileExistsCached: () => null, getField: () => 'Report.pdf',
            getFilePathAsync: vi.fn().mockRejectedValue(new Error('Volume unavailable')),
        };
        (Zotero as any).Items = {
            getByLibraryAndKey: vi.fn(() => item),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
        await expect(preloadStandaloneAttachmentLinks('<citation id="u-ATTACH12"/>')).resolves.toBeUndefined();
        expect(buildZoteroCitationLinkURI(item, 6)).toBe('zotero://open/library/items/ATTACH12?page=6');
    });

    it('keeps filename fallback available when batch title loading fails', async () => {
        const item = { isAttachment: () => true, parentID: false, attachmentFilename: 'Report.pdf' };
        (Zotero as any).Items = {
            getByLibraryAndKey: vi.fn(() => item),
            loadDataTypes: vi.fn().mockRejectedValue(new Error('Unavailable')),
        };
        await expect(preloadStandaloneAttachmentLinks('<citation id="u-ATTACH12"/>')).resolves.toBeUndefined();
        expect(buildZoteroCitationLinkLabel(item)).toBe('Report.pdf');
    });

    it('rejects Beaver and unrelated Zotero links', () => {
        expect(parseZoteroCitationLinkHref('zotero://beaver/thread/abc')).toBeNull();
        expect(parseZoteroCitationLinkHref('zotero://select/library/collections/COLL123')).toBeNull();
    });
});
