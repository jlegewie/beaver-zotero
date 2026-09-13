import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/zoteroUtils', () => ({ createCitationHTML: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(), checkLibraryExcluded: vi.fn(() => null),
}));

import { preloadExternalFileCitations } from '../../../src/utils/externalFileCitation';
import { expandToRawHtml, preloadStructuralLocatorPages } from '../../../src/utils/noteCitationExpand';
import { simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';

const tag = '<citation id="ext-MRDTFYHP" loc="page6"/>';
const metadata = () => ({ elements: new Map() } as any);
const context = (files: any) => ({ externalRefs: {}, externalItemMapping: {}, externalFiles: files });
const lookup = vi.fn();

describe('external file citations in notes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero as any).Beaver = { db: { getExternalFileByKey: lookup } };
        (Zotero as any).File = { pathToFileURI: vi.fn(() => 'file:///stored/Report.pdf') };
        vi.mocked(IOUtils.exists).mockResolvedValue(true);
        lookup.mockResolvedValue({ filename: 'Report.pdf', storedPath: '/stored/Report.pdf' });
    });

    it.each([undefined, { externalRefs: {}, externalItemMapping: {} }, context({})])(
        'rejects external-file expansion without a completed preload', (ctx) => {
            expect(() => expandToRawHtml(tag, metadata(), 'new', ctx)).toThrow('was not preloaded');
        },
    );

    it('scans and expands a citation with a slash in its locator', async () => {
        const input = tag.replace('page6', '1/2');
        const { files } = await preloadExternalFileCitations(input);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(expandToRawHtml(input, metadata(), 'new', context(files)))
            .toBe('(<a href="file:///stored/Report.pdf">Report.pdf</a>, 1/2)');
    });

    it('preloads each file once and expands to a link with a page', async () => {
        const { files, warnings } = await preloadExternalFileCitations(tag + tag.toLowerCase());
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledWith('MRDTFYHP');
        expect(warnings).toEqual([]);
        expect(expandToRawHtml(tag, metadata(), 'new', context(files)))
            .toBe('(<a href="file:///stored/Report.pdf">Report.pdf</a>, p. 6)');
    });

    it.each(['page6-8', 's4', 'paragraph2', 'custom-location'])('preserves locator %s', (loc) => {
        const expected = {
            'page6-8': 'p. 6-8', s4: 'sentence 4', paragraph2: 'paragraph 2',
            'custom-location': 'custom-location',
        }[loc];
        expect(expandToRawHtml(`<citation id="ext-MRDTFYHP" loc="${loc}"/>`, metadata(), 'new',
            context({ MRDTFYHP: { filename: 'Report.pdf' } }))).toBe(`(Report.pdf, ${expected})`);
    });

    it.each([
        ['s5', 'iv'],
        ['s5-s6', 'iv-v'],
    ])('resolves external locator %s to cached page labels', async (loc, label) => {
        const getResult = vi.fn().mockResolvedValue({ mode: 'structured', document: { citationIndex: {
            s5: { pageIndex: 5, pageLabel: 'iv' },
            s6: { pageIndex: 6, pageLabel: 'v' },
        } } });
        (Zotero as any).Beaver.documentCache = { getResult };
        const input = `<citation id="ext-MRDTFYHP" loc="${loc}"/>`;
        const { files } = await preloadExternalFileCitations(input);
        const resolved = await preloadStructuralLocatorPages(input + input);
        expect(getResult).toHaveBeenCalledExactlyOnceWith(
            { libraryId: -1, zoteroKey: 'MRDTFYHP' }, 'structured', '/stored/Report.pdf',
        );
        expect(resolved.unresolved).toEqual([]);
        expect(expandToRawHtml(input, metadata(), 'new', context(files), undefined, resolved.pages))
            .toBe(`(<a href="file:///stored/Report.pdf">Report.pdf</a>, p. ${label})`);
    });

    it('retains the structural locator when cached extraction is missing', async () => {
        (Zotero as any).Beaver.documentCache = { getResult: vi.fn().mockResolvedValue(null) };
        const input = '<citation id="ext-MRDTFYHP" loc="s5"/>';
        const { files } = await preloadExternalFileCitations(input);
        const resolved = await preloadStructuralLocatorPages(input);
        expect(resolved.unresolved).toEqual([]);
        expect(expandToRawHtml(input, metadata(), 'new', context(files), undefined, resolved.pages))
            .toBe('(<a href="file:///stored/Report.pdf">Report.pdf</a>, sentence 5)');
    });

    it('escapes filenames, locators and link attributes', () => {
        const result = expandToRawHtml('<citation id="ext-MRDTFYHP" loc="page6&amp;7"/>', metadata(), 'new',
            context({ MRDTFYHP: { filename: 'A <B> & "C".pdf', href: 'file:///x?y="&z' } }));
        expect(result).toContain('A &lt;B&gt; &amp; &quot;C&quot;.pdf');
        expect(result).toContain('href="file:///x?y=&quot;&amp;z"');
        expect(result).toContain('p. 6&amp;7');
    });

    it('uses the filename and warns when the managed copy is missing', async () => {
        vi.mocked(IOUtils.exists).mockResolvedValue(false);
        const { files, warnings } = await preloadExternalFileCitations(tag);
        expect(expandToRawHtml(tag, metadata(), 'new', context(files))).toBe('(Report.pdf, p. 6)');
        expect(warnings).toHaveLength(1);
        expect(Zotero.File.pathToFileURI).not.toHaveBeenCalled();
    });

    it('retains the filename when checking the file fails', async () => {
        vi.mocked(IOUtils.exists).mockRejectedValue(new Error('unavailable'));
        const { files } = await preloadExternalFileCitations(tag);
        expect(expandToRawHtml(tag, metadata(), 'new', context(files))).toBe('(Report.pdf, p. 6)');
    });

    it('preserves the file identity when metadata is unavailable', async () => {
        lookup.mockResolvedValue(null);
        const { files, warnings } = await preloadExternalFileCitations(tag);
        expect(expandToRawHtml(tag, metadata(), 'new', context(files)))
            .toBe('(Attached file ext-MRDTFYHP, p. 6)');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('no available filename metadata');
    });

    it('can replace an existing citation with a file reference', () => {
        const meta = metadata();
        meta.elements.set('c_existing', { rawHtml: 'old citation', originalAttrs: { item_id: 'u-ABCD1234' } });
        expect(expandToRawHtml(tag.replace('id=', 'ref="c_existing" id='), meta, 'new',
            context({ MRDTFYHP: { filename: 'Report.pdf' } }))).toBe('(Report.pdf, p. 6)');
        expect(() => expandToRawHtml(tag.replace('id=', 'ref="c_existing" id='), meta, 'old'))
            .toThrow('Copy the existing link or text from read_note');
    });

    it('keeps existing compound citations immutable', () => {
        const meta = metadata();
        meta.elements.set('c_existing', { rawHtml: 'compound citation', isCompound: true });
        expect(expandToRawHtml(tag.replace('id=', 'ref="c_existing" id='), meta, 'new'))
            .toBe('compound citation');
    });

    it('requires old_string to use the stored link, and round-trips that link', () => {
        expect(() => expandToRawHtml(tag, metadata(), 'old')).toThrow('was not found in the note');
        const raw = '<p>' + expandToRawHtml(tag, metadata(), 'new',
            context({ MRDTFYHP: { filename: 'Report.pdf', href: 'file:///Report.pdf' } })) + '</p>';
        const simplified = simplifyNoteHtml(raw, 1);
        expect(simplified.simplified).toContain('href="file:///Report.pdf"');
        expect(expandToRawHtml(simplified.simplified, simplified.metadata, 'old')).toContain('Report.pdf</a>');
    });
});
