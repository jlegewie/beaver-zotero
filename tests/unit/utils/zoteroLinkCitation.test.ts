import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildZoteroCitationLinkHTML,
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
            '(<a href="zotero://select/library/items/NOTE1234" rel="noopener noreferrer">Note: Project note</a>)'
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
            '(<a href="zotero://open-pdf/groups/42/items/ATTACH12?annotation=ANNOT123" rel="noopener noreferrer">Annotation in Smith 2019, page 12</a>)'
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
    });

    it('rejects Beaver and unrelated Zotero links', () => {
        expect(parseZoteroCitationLinkHref('zotero://beaver/thread/abc')).toBeNull();
        expect(parseZoteroCitationLinkHref('zotero://select/library/collections/COLL123')).toBeNull();
    });
});
