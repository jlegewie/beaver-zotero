/**
 * The grammar of Zotero object links in chat markdown: which hrefs are
 * recognized as object ids, and how they are written when saved into a note.
 */
import { describe, expect, it } from 'vitest';
import { hydrateItemLinkLibraryRefs, itemLinkExportHref, parseItemLinkHref } from '../../../react/utils/itemLinks';

describe('parseItemLinkHref', () => {
    it('recognizes a bare object id in every library form', () => {
        expect(parseItemLinkHref('u-ANVV522N')).toEqual({ objectId: 'u-ANVV522N', kind: 'object' });
        expect(parseItemLinkHref('g12345-ANVV522N')).toEqual({ objectId: 'g12345-ANVV522N', kind: 'object' });
        expect(parseItemLinkHref('3-ANVV522N')).toEqual({ objectId: '3-ANVV522N', kind: 'object' });
    });

    it('recognizes zotero://select item and collection URIs', () => {
        expect(parseItemLinkHref('zotero://select/library/items/ANVV522N'))
            .toEqual({ objectId: 'u-ANVV522N', kind: 'object' });
        expect(parseItemLinkHref('zotero://select/groups/42/items/ANVV522N'))
            .toEqual({ objectId: 'g42-ANVV522N', kind: 'object' });
        expect(parseItemLinkHref('zotero://select/library/collections/ANVV522N'))
            .toEqual({ objectId: 'u-ANVV522N', kind: 'collection' });
        expect(parseItemLinkHref('zotero://select/groups/42/collections/ANVV522N'))
            .toEqual({ objectId: 'g42-ANVV522N', kind: 'collection' });
    });

    it('leaves every other href alone', () => {
        for (const href of [
            undefined,
            null,
            '',
            '#section',
            'https://example.org/u-ANVV522N',
            'mailto:u-ANVV522N@example.org',
            'zotero://beaver/thread/abc',
            'zotero://open-pdf/library/items/ANVV522N',
            'zotero://select/library/items/ANVV522N?page=2',
            // Relative links that happen to start like an object id.
            'u-turn',
            'g1-notes.md',
            '2-column',
            'u-anvv522n',
            'u-ANVV522',
            'u-ANVV522N/extra',
            // Malformed library prefixes.
            '0-ANVV522N',
            'g0-ANVV522N',
            'x-ANVV522N',
            '-ANVV522N',
            'ANVV522N',
        ]) {
            expect(parseItemLinkHref(href), String(href)).toBeNull();
        }
    });
});

describe('itemLinkExportHref', () => {
    it('writes portable object ids as zotero://select URIs', () => {
        expect(itemLinkExportHref('u-ANVV522N')).toBe('zotero://select/library/items/ANVV522N');
        expect(itemLinkExportHref('g42-ANVV522N')).toBe('zotero://select/groups/42/items/ANVV522N');
    });

    it('keeps a collection URI a collection URI', () => {
        expect(itemLinkExportHref('zotero://select/groups/42/collections/ANVV522N'))
            .toBe('zotero://select/groups/42/collections/ANVV522N');
    });

    it('never resolves a legacy device-local library id itself', () => {
        // Hydration at the export boundary is responsible for legacy ids.
        expect(itemLinkExportHref('1-ANVV522N')).toBeNull();
        expect(itemLinkExportHref('3-ANVV522N')).toBeNull();
    });

    it('returns null for hrefs that are not item links', () => {
        expect(itemLinkExportHref('https://example.org')).toBeNull();
        expect(itemLinkExportHref('u-turn')).toBeNull();
    });
});

describe('hydrateItemLinkLibraryRefs', () => {
    const libraryRef = (libraryID: number) => (libraryID === 1 ? 'u' : libraryID === 3 ? 'g77' : null);

    it('rewrites legacy link targets to their portable form', () => {
        expect(hydrateItemLinkLibraryRefs('See [Smith 2004](1-ANVV522N) and [Doe](3-BBBB2222).', libraryRef))
            .toBe('See [Smith 2004](u-ANVV522N) and [Doe](g77-BBBB2222).');
    });

    it('handles link titles and raw href attributes', () => {
        expect(hydrateItemLinkLibraryRefs('[Smith](1-ANVV522N "Smith 2004")', libraryRef))
            .toBe('[Smith](u-ANVV522N "Smith 2004")');
        expect(hydrateItemLinkLibraryRefs('<a href="3-ANVV522N">Doe</a>', libraryRef))
            .toBe('<a href="g77-ANVV522N">Doe</a>');
    });

    it('leaves portable ids, prose, and unmappable libraries as written', () => {
        const content = 'Id 1-ANVV522N in prose, [ok](u-ANVV522N), [gone](9-ANVV522N), [web](https://x.org/1-ANVV522N)';
        expect(hydrateItemLinkLibraryRefs(content, libraryRef)).toBe(content);
    });
});
