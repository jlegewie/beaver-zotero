import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
}));
vi.mock('../../../src/utils/externalFileCitation', () => ({
    preloadExternalFileCitations: vi.fn(async () => ({ files: {}, warnings: [] })),
}));
vi.mock('../../../src/utils/zoteroLinkCitation', () => ({
    preloadStandaloneAttachmentLinks: vi.fn(async () => undefined),
}));
vi.mock('../../../src/utils/noteCitationExpand', () => ({
    buildUnresolvedLocatorWarning: vi.fn((unresolved: string[]) =>
        unresolved.length > 0 ? `unresolved: ${unresolved.join('; ')}` : null),
    ensureCitedLibrariesLoaded: vi.fn(async () => []),
    expandNoteCitationTags: vi.fn((tag: string) => `<span class="citation">${tag.match(/id="([^"]+)"/)?.[1]}</span>`),
    preloadPageLabelsForNewCitations: vi.fn(async () => ({ 11: { 0: 'i' } })),
    preloadStructuralLocatorPages: vi.fn(async () => ({ pages: { 'zotero:u-AAAA1111:s4': { label: '3', page: 3 } }, unresolved: [], unavailable: [] })),
}));

import {
    checkNoteMarkdownCitations,
    INVALID_NOTE_CITATION_CODE,
    renderNoteMarkdown,
    wrapNewNoteHtml,
} from '../../../src/services/agentDataProvider/actions/noteCitationRendering';
import {
    ensureCitedLibrariesLoaded,
    expandNoteCitationTags,
    preloadPageLabelsForNewCitations,
    preloadStructuralLocatorPages,
} from '../../../src/utils/noteCitationExpand';
import { preloadExternalFileCitations } from '../../../src/utils/externalFileCitation';

/**
 * Stand-in for the note render seam: paragraphs and bold only, with citation
 * tags left in place as the real seam returns them.
 */
const renderMarkdown = vi.fn(async (content: string) =>
    content.split('\n\n').map(block => `<p>${block.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`).join(''));

describe('renderNoteMarkdown', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('expands the citation tags the renderer returns with the note citation builder', async () => {
        const { html, warnings } = await renderNoteMarkdown(
            '**Claim** <citation id="u-AAAA1111" loc="page5"/>\n\nMore <citation id="u-BBBB2222"/>.',
            { renderMarkdown },
        );

        expect(renderMarkdown).toHaveBeenCalledTimes(1);
        expect(html).toBe(
            '<p><strong>Claim</strong> <span class="citation">u-AAAA1111</span></p>'
            + '<p>More <span class="citation">u-BBBB2222</span>.</p>',
        );
        expect(warnings).toEqual([]);
    });

    it('expands each tag as a new citation with the preloaded labels and structural pages', async () => {
        await renderNoteMarkdown('Text <citation id="u-AAAA1111" loc="s4"/>', { renderMarkdown });

        expect(ensureCitedLibrariesLoaded).toHaveBeenCalledWith(['<citation id="u-AAAA1111" loc="s4"/>']);
        expect(expandNoteCitationTags).toHaveBeenCalledWith(
            '<citation id="u-AAAA1111" loc="s4"/>',
            { elements: new Map() },
            'new',
            expect.objectContaining({ externalRefs: {}, externalItemMapping: {} }),
            { 11: { 0: 'i' } },
            { 'zotero:u-AAAA1111:s4': { label: '3', page: 3 } },
        );
    });

    it('cites the mapped item of an external reference, so its locator is preloaded like any other', async () => {
        const externalItemMapping = {
            W1: { library_id: 8, zotero_key: 'MAPPED01' },
            W2: { library_id: 7, library_ref: 'g12345', zotero_key: 'MAPPED02' },
            W3: null,
        };
        const content = '<citation external_id="W1" loc="s4"/> <citation external_id="W2" loc="page5"/> <citation external_id="W3"/>';
        const resolved = '<citation id="8-MAPPED01" loc="s4"/>\n<citation id="g12345-MAPPED02" loc="page5"/>\n<citation external_id="W3"/>';

        await renderNoteMarkdown(content, { renderMarkdown, externalItemMapping });

        expect(ensureCitedLibrariesLoaded).toHaveBeenCalledWith([resolved]);
        expect(preloadPageLabelsForNewCitations).toHaveBeenCalledWith(resolved);
        expect(preloadStructuralLocatorPages).toHaveBeenCalledWith(resolved);
        expect(vi.mocked(expandNoteCitationTags).mock.calls.map(([tag]) => tag)).toEqual(resolved.split('\n'));
    });

    it('validates the mapped item of an external reference', async () => {
        await checkNoteMarkdownCitations('<citation external_id="W1"/>', {
            renderMarkdown,
            externalItemMapping: { W1: { library_id: 8, zotero_key: 'MAPPED01' } },
        });

        expect(ensureCitedLibrariesLoaded).toHaveBeenCalledWith(['<citation id="8-MAPPED01"/>']);
        expect(vi.mocked(expandNoteCitationTags).mock.calls[0][0]).toBe('<citation id="8-MAPPED01"/>');
    });

    it('passes the operation’s external-reference snapshot to expansion', async () => {
        const externalRefs = { W1: { source_id: 'W1' } } as any;
        const externalItemMapping = { W1: null };

        await renderNoteMarkdown('<citation external_id="W1"/>', { renderMarkdown, externalRefs, externalItemMapping });

        expect(vi.mocked(expandNoteCitationTags).mock.calls[0][3]).toMatchObject({ externalRefs, externalItemMapping });
    });

    it('reports locator and file warnings', async () => {
        vi.mocked(preloadStructuralLocatorPages).mockResolvedValueOnce({ pages: {}, unresolved: ['u-AAAA1111 s4'], unavailable: [] });
        vi.mocked(preloadExternalFileCitations).mockResolvedValueOnce({ files: {}, warnings: ['file link unavailable'] });

        const { warnings } = await renderNoteMarkdown('<citation id="u-AAAA1111" loc="s4"/>', { renderMarkdown });

        expect(warnings).toEqual(['file link unavailable', 'unresolved: u-AAAA1111 s4']);
    });

    it('fails with a coded error when a citation cannot be stored', async () => {
        vi.mocked(expandNoteCitationTags).mockImplementationOnce(() => {
            throw new Error('Cannot cite id="u-AAAA1111": library excluded');
        });

        await expect(renderNoteMarkdown('<citation id="u-AAAA1111"/>', { renderMarkdown }))
            .rejects.toMatchObject({ message: 'Cannot cite id="u-AAAA1111": library excluded', code: INVALID_NOTE_CITATION_CODE });
    });

    it('leaves code examples the renderer escaped alone', async () => {
        const code = '<pre><code>&lt;citation id=&quot;u-EXAMPLE1&quot;/&gt;</code></pre>';
        const renderCode = vi.fn(async () => `<p>Real <citation id="u-AAAA1111"/></p>${code}`);

        const { html } = await renderNoteMarkdown('ignored', { renderMarkdown: renderCode });

        expect(expandNoteCitationTags).toHaveBeenCalledTimes(1);
        expect(html).toBe(`<p>Real <span class="citation">u-AAAA1111</span></p>${code}`);
    });

    it('does no citation work for content without citations', async () => {
        const { html } = await renderNoteMarkdown('Plain **text**', { renderMarkdown });

        expect(html).toBe('<p>Plain <strong>text</strong></p>');
        expect(ensureCitedLibrariesLoaded).not.toHaveBeenCalled();
        expect(preloadPageLabelsForNewCitations).not.toHaveBeenCalled();
    });

    it('requires a Markdown renderer', async () => {
        await expect(renderNoteMarkdown('Text', {})).rejects.toMatchObject({ code: 'capability_unavailable' });
    });
});

describe('checkNoteMarkdownCitations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('accepts content whose citations all expand', async () => {
        await expect(checkNoteMarkdownCitations('A <citation id="u-AAAA1111"/>', { renderMarkdown }))
            .resolves.toEqual({ error: null, warnings: [] });
        expect(expandNoteCitationTags).toHaveBeenCalledTimes(1);
    });

    it('returns the first citation failure', async () => {
        vi.mocked(expandNoteCitationTags)
            .mockImplementationOnce(() => 'ok')
            .mockImplementationOnce(() => { throw new Error('Item not found: u-BBBB2222'); });

        const result = await checkNoteMarkdownCitations('<citation id="u-AAAA1111"/> <citation id="u-BBBB2222"/>', { renderMarkdown });

        expect(result.error).toBe('Item not found: u-BBBB2222');
    });

    it('finds citations by rendering, so a tag the renderer returned as code text is not checked', async () => {
        const renderCode = vi.fn(async () => '<p><code>&lt;citation id=&quot;u-EXAMPLE1&quot;/&gt;</code></p>');

        await expect(checkNoteMarkdownCitations('`x <citation id="u-EXAMPLE1"/>`', { renderMarkdown: renderCode }))
            .resolves.toEqual({ error: null, warnings: [] });
        expect(renderCode).toHaveBeenCalledWith('`x <citation id="u-EXAMPLE1"/>`');
        expect(expandNoteCitationTags).not.toHaveBeenCalled();
    });

    it('renders nothing, and needs no renderer, for content without a citation tag', async () => {
        await expect(checkNoteMarkdownCitations('No citations', {})).resolves.toEqual({ error: null, warnings: [] });
        expect(ensureCitedLibrariesLoaded).not.toHaveBeenCalled();
    });

    it('requires a renderer for content with citation tags', async () => {
        await expect(checkNoteMarkdownCitations('A <citation id="u-AAAA1111"/>', {}))
            .rejects.toMatchObject({ code: 'capability_unavailable' });
    });
});

describe('wrapNewNoteHtml', () => {
    const zotero = (globalThis as any).Zotero;
    const saved = { URI: zotero.URI, Items: zotero.Items, Utilities: zotero.Utilities };

    beforeEach(() => {
        zotero.URI = { getURIItemLibraryKey: () => ({ libraryID: 1, key: 'AAAA1111' }) };
        zotero.Items = { getByLibraryAndKey: () => ({ key: 'AAAA1111' }) };
        zotero.Utilities = { ...saved.Utilities, Item: { itemToCSLJSON: () => ({ title: 'Cited' }) } };
    });

    afterEach(() => {
        Object.assign(zotero, saved);
    });

    it('stores cited item data in the wrapper cache, as edited notes do', () => {
        const citation = encodeURIComponent(JSON.stringify({
            citationItems: [{ uris: ['http://zotero.org/users/1/items/AAAA1111'], locator: '5' }],
            properties: {},
        }));

        const html = wrapNewNoteHtml(`<p>Claim <span class="citation" data-citation="${citation}">(A, 2020)</span></p>`);

        const cache = JSON.parse(decodeURIComponent(html.match(/data-citation-items="([^"]*)"/)![1]));
        expect(html).toMatch(/^<div data-schema-version="\d+" data-citation-items="/);
        expect(cache).toEqual([{ uris: ['http://zotero.org/users/1/items/AAAA1111'], itemData: { title: 'Cited' } }]);
    });

    it('only adds the schema wrapper to a note without citations', () => {
        expect(wrapNewNoteHtml('<p>Plain</p>')).toMatch(/^<div data-schema-version="\d+"><p>Plain<\/p><\/div>$/);
    });
});
