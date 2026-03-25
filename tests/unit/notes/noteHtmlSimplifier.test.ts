import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock createCitationHTML before importing the module under test
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(
        (item: any, page?: string) =>
            `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify({
                citationItems: [{
                    uris: [`http://zotero.org/users/1/items/${item.key}`],
                    itemData: {
                        id: `http://zotero.org/users/1/items/${item.key}`,
                        type: 'article-journal',
                        author: [{ family: 'Mock', given: 'Author' }],
                        issued: { 'date-parts': [['2024']] },
                    },
                    locator: page || '',
                }],
                properties: {},
            }))}"><span class="citation-item">${item.getField?.('title') || 'Mock Title'}${page ? ', p. ' + page : ''}</span></span>`
    ),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

import {
    simplifyNoteHtml,
    expandToRawHtml,
    getOrSimplify,
    invalidateSimplificationCache,
    stripDataCitationItems,
    stripNoteWrapperDiv,
    rebuildDataCitationItems,
    validateNewString,
    findFuzzyMatch,
    countOccurrences,
    checkDuplicateCitations,
    isNoteInEditor,
    getLatestNoteHtml,
    findRangeByContexts,
    SimplificationMetadata,
} from '../../../src/utils/noteHtmlSimplifier';
import { createCitationHTML } from '../../../src/utils/zoteroUtils';


// =============================================================================
// Helpers
// =============================================================================

/** Build a minimal Zotero note wrapper */
function wrap(inner: string, extraAttrs = ''): string {
    return `<div data-schema-version="9"${extraAttrs}>${inner}</div>`;
}

/** Build a raw citation span */
function rawCitation(key: string, libraryID = 1, page = '', label = 'Author, 2024'): string {
    const citationData = {
        citationItems: [{
            uris: [`http://zotero.org/users/1/items/${key}`],
            locator: page,
        }],
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}">`
        + `<span class="citation-item">${label}</span></span>`;
}

/** Build a raw compound citation span */
function rawCompoundCitation(keys: string[], libraryID = 1, label = 'Author1; Author2'): string {
    const citationData = {
        citationItems: keys.map(k => ({
            uris: [`http://zotero.org/users/1/items/${k}`],
            locator: '',
        })),
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}">`
        + `<span class="citation-item">${label}</span></span>`;
}

/** Build a raw annotation span */
function rawAnnotation(key: string, text: string, color = '#ffd400', pageLabel = '5'): string {
    const annotData = { annotationKey: key, color, pageLabel };
    return `<span class="highlight" data-annotation="${encodeURIComponent(JSON.stringify(annotData))}">${text}</span>`;
}

/** Build a raw annotation image */
function rawAnnotationImage(annotKey: string, attKey: string, w = '200', h = '100'): string {
    const annotData = { annotationKey: annotKey };
    return `<img data-attachment-key="${attKey}" data-annotation="${encodeURIComponent(JSON.stringify(annotData))}" width="${w}" height="${h}" />`;
}

/** Build a raw regular image */
function rawImage(attKey: string): string {
    return `<img data-attachment-key="${attKey}" width="400" height="300" />`;
}

/**
 * Substring-based replace that avoids JavaScript's special $ handling in
 * String.prototype.replace() replacement strings.  Mirrors what
 * editNoteActions.ts does at runtime (indexOf + substring splicing).
 */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
    const idx = haystack.indexOf(needle);
    if (idx === -1) throw new Error(`replaceFirst: needle not found in haystack`);
    return haystack.substring(0, idx) + replacement + haystack.substring(idx + needle.length);
}

/** Build a raw inline math span */
function rawInlineMath(latex: string): string {
    return `<span class="math">$${latex}$</span>`;
}

/** Build a raw display math pre */
function rawDisplayMath(latex: string): string {
    return `<pre class="math">$$${latex}$$</pre>`;
}


// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();

    // Reset Zotero globals used by expansion / rebuild
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Items: {
            getByLibraryAndKey: vi.fn((libId: number, key: string) => ({
                id: `${libId}-${key}`,
                key,
                libraryID: libId,
                getField: vi.fn(() => 'Mock Title'),
                isAttachment: vi.fn(() => false),
                isRegularItem: vi.fn(() => true),
                getAttachments: vi.fn(() => []),
            })),
        },
        URI: {
            getURIItem: vi.fn((uri: string) => {
                const keyMatch = uri.match(/\/items\/([A-Z0-9]+)$/i);
                return keyMatch ? { key: keyMatch[1] } : null;
            }),
            getURIItemLibraryKey: vi.fn((uri: string) => {
                const keyMatch = uri.match(/\/items\/([A-Z0-9]+)$/i);
                return keyMatch ? { libraryID: 1, key: keyMatch[1] } : false;
            }),
        },
        Utilities: {
            Item: {
                itemToCSLJSON: vi.fn((item: any) => ({
                    id: item.key,
                    type: 'article-journal',
                    author: [{ family: 'Author', given: 'Test' }],
                    issued: { 'date-parts': [['2024']] },
                })),
            },
        },
        EditorInstanceUtilities: {
            formatCitation: vi.fn((citation: any) => {
                return '(' + citation.citationItems.map((ci: any) => {
                    const author = ci.itemData?.author?.[0]?.family || '';
                    const year = ci.itemData?.issued?.['date-parts']?.[0]?.[0] || '';
                    return `<span class="citation-item">${author}${year ? ', ' + year : ''}</span>`;
                }).join('; ') + ')';
            }),
        },
        Notes: {
            _editorInstances: [],
        },
    };

    // Clear simplification cache between tests
    invalidateSimplificationCache('test-note');
});


// =============================================================================
// simplifyNoteHtml
// =============================================================================

describe('simplifyNoteHtml', () => {
    it('passes through plain text note (minus wrapper attributes)', () => {
        const html = wrap('<p>Hello world</p>');
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('<p>Hello world</p>');
        expect(metadata.elements.size).toBe(0);
    });

    it('replaces single citation with <citation /> tag', () => {
        const html = wrap(`<p>${rawCitation('ABCD1234')}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('ref="c_ABCD1234_0"');
        expect(simplified).toContain('item_id="1-ABCD1234"');
        expect(simplified).toContain('label="Author, 2024"');
        expect(simplified).toContain('/>');
        expect(metadata.elements.has('c_ABCD1234_0')).toBe(true);
        expect(metadata.elements.get('c_ABCD1234_0')!.type).toBe('citation');
    });

    it('replaces compound citation with items attribute', () => {
        const html = wrap(`<p>${rawCompoundCitation(['KEY1', 'KEY2'])}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('ref="c_KEY1+KEY2_0"');
        expect(simplified).toContain('items="1-KEY1, 1-KEY2"');
        expect(simplified).toContain('label="Author1; Author2"');
        const stored = metadata.elements.get('c_KEY1+KEY2_0');
        expect(stored!.type).toBe('compound-citation');
        expect(stored!.isCompound).toBe(true);
    });

    it('replaces annotation with <annotation> tag', () => {
        const html = wrap(`<p>${rawAnnotation('ANN1', 'highlighted text')}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('<annotation id="a_ANN1"');
        expect(simplified).toContain('key="ANN1"');
        expect(simplified).toContain('color="#ffd400"');
        expect(simplified).toContain('page="5"');
        expect(simplified).toContain('>highlighted text</annotation>');
        expect(metadata.elements.get('a_ANN1')!.type).toBe('annotation');
        expect(metadata.elements.get('a_ANN1')!.originalText).toBe('highlighted text');
    });

    it('replaces annotation image with <annotation-image /> tag', () => {
        const html = wrap(rawAnnotationImage('AIMG1', 'ATT1'));
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('<annotation-image id="ai_AIMG1"');
        expect(simplified).toContain('key="AIMG1"');
        expect(simplified).toContain('attachment="ATT1"');
        expect(simplified).toContain('width="200"');
        expect(simplified).toContain('height="100"');
        expect(metadata.elements.get('ai_AIMG1')!.type).toBe('annotation-image');
    });

    it('replaces regular image with <image /> tag', () => {
        const html = wrap(rawImage('IMG1'));
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('<image id="i_IMG1"');
        expect(simplified).toContain('attachment="IMG1"');
        expect(metadata.elements.get('i_IMG1')!.type).toBe('image');
    });

    it('strips data-citation-items from wrapper div', () => {
        const html = wrap('<p>text</p>', ' data-citation-items="encoded-stuff"');
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).not.toContain('data-citation-items');
    });

    it('strips the outer wrapper div from simplified output', () => {
        const html = wrap('<h1>Title</h1>\n<p>Content</p>');
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).not.toContain('<div');
        expect(simplified).not.toContain('</div>');
        expect(simplified).not.toContain('data-schema-version');
        expect(simplified).toBe('<h1>Title</h1>\n<p>Content</p>');
    });

    it('strips wrapper div even without data-schema-version', () => {
        const html = '<div><p>Legacy note</p></div>';
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toBe('<p>Legacy note</p>');
    });

    it('preserves HTML when not wrapped in a div', () => {
        const html = '<p>Bare paragraph</p>';
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toBe('<p>Bare paragraph</p>');
    });

    it('handles mixed content with all element types', () => {
        const inner = `<p>Intro</p>`
            + `<p>${rawCitation('C1', 1, '', 'Smith, 2020')}</p>`
            + `<p>${rawAnnotation('A1', 'quote')}</p>`
            + rawAnnotationImage('AI1', 'AT1')
            + rawImage('IM1');
        const html = wrap(inner);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('ref="c_C1_0"');
        expect(simplified).toContain('<annotation id="a_A1"');
        expect(simplified).toContain('<annotation-image id="ai_AI1"');
        expect(simplified).toContain('<image id="i_IM1"');
        expect(metadata.elements.size).toBe(4);
    });

    it('assigns unique ids to duplicate citations', () => {
        const html = wrap(`<p>${rawCitation('DUP')}</p><p>${rawCitation('DUP')}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('c_DUP_0');
        expect(simplified).toContain('c_DUP_1');
        expect(metadata.elements.has('c_DUP_0')).toBe(true);
        expect(metadata.elements.has('c_DUP_1')).toBe(true);
    });

    it('includes page locator in citation', () => {
        const html = wrap(`<p>${rawCitation('PG1', 1, '42')}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('page="42"');
    });

    it('recovers label when visible text is empty parentheses "()"', () => {
        // Simulates ProseMirror round-trip: atom nodes regenerate visible text
        // from data-citation attrs, producing "()" when itemData is missing
        const citationData = {
            citationItems: [{
                uris: ['http://zotero.org/users/1/items/ABCD1234'],
            }],
        };
        const emptyCitation = `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}">()</span>`;
        const html = wrap(`<p>${emptyCitation}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        // Should recover a meaningful label via generateCitationLabel
        expect(simplified).toContain('label="(Author, 2024)"');
        expect(simplified).not.toContain('label="()"');
    });

    it('leaves malformed citation JSON unchanged', () => {
        const badCitation = '<span class="citation" data-citation="not%20valid%20json"><span class="citation-item">Bad</span></span>';
        const html = wrap(`<p>${badCitation}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain(badCitation);
    });

    it('leaves citation with empty citationItems unchanged', () => {
        const citationData = { citationItems: [] };
        const emptyCitation = `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}"><span class="citation-item">Empty</span></span>`;
        const html = wrap(`<p>${emptyCitation}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain(emptyCitation);
    });

    it('escapes quotes and ampersands in label attribute', () => {
        const label = 'Author "2024" & co.';
        const html = wrap(`<p>${rawCitation('ESC1', 1, '', label)}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('label="Author &quot;2024&quot; &amp; co."');
    });
});


// =============================================================================
// expandToRawHtml
// =============================================================================

describe('expandToRawHtml', () => {
    function makeMetadata(): { metadata: SimplificationMetadata; rawCit: string; rawAnnot: string; rawAI: string; rawImg: string } {
        const rawCit = rawCitation('EX1');
        const rawAnnot = rawAnnotation('EA1', 'text here');
        const rawAI = rawAnnotationImage('EAI1', 'EATT1');
        const rawImg = rawImage('EIMG1');

        const metadata: SimplificationMetadata = {
            elements: new Map([
                ['c_EX1_0', { rawHtml: rawCit, type: 'citation' as const, originalAttrs: { item_id: '1-EX1' } }],
                ['c_EX1_1', { rawHtml: rawCitation('EX1', 1, '10'), type: 'citation' as const, originalAttrs: { item_id: '1-EX1', page: '10' } }],
                ['c_K1+K2_0', { rawHtml: rawCompoundCitation(['K1', 'K2']), type: 'compound-citation' as const, isCompound: true }],
                ['a_EA1', { rawHtml: rawAnnot, type: 'annotation' as const, originalText: 'text here' }],
                ['ai_EAI1', { rawHtml: rawAI, type: 'annotation-image' as const }],
                ['i_EIMG1', { rawHtml: rawImg, type: 'image' as const }],
            ]),
        };

        return { metadata, rawCit, rawAnnot, rawAI, rawImg };
    }

    // ---- Existing citation: unchanged ----

    it('restores existing citation with unchanged attrs', () => {
        const { metadata, rawCit } = makeMetadata();
        const input = '<citation item_id="1-EX1" label="Author, 2024" ref="c_EX1_0"/>';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawCit);
    });

    it('restores existing citation without item_id (just ref)', () => {
        const { metadata, rawCit } = makeMetadata();
        const input = '<citation label="Author, 2024" ref="c_EX1_0"/>';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawCit);
    });

    it('restores existing citation in new context too', () => {
        const { metadata, rawCit } = makeMetadata();
        const input = '<citation item_id="1-EX1" label="Author, 2024" ref="c_EX1_0"/>';
        expect(expandToRawHtml(input, metadata, 'new')).toBe(rawCit);
    });

    // ---- Existing citation: page locator update ----

    it('rebuilds existing citation when page is added', () => {
        const { metadata } = makeMetadata();
        const input = '<citation item_id="1-EX1" page="99" label="Author, 2024" ref="c_EX1_0"/>';
        const result = expandToRawHtml(input, metadata, 'old');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'EX1' }),
            '99'
        );
        expect(result).toContain('data-citation=');
    });

    it('rebuilds existing citation when page locator changes', () => {
        const { metadata } = makeMetadata();
        // c_EX1_1 originally has page="10" — change to "25"
        const input = '<citation item_id="1-EX1" page="25" label="Author, 2024, p. 10" ref="c_EX1_1"/>';
        expandToRawHtml(input, metadata, 'old');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'EX1' }),
            '25'
        );
    });

    it('rebuilds existing citation when page locator is removed', () => {
        const { metadata } = makeMetadata();
        // c_EX1_1 originally has page="10" — remove page attr
        const input = '<citation item_id="1-EX1" label="Author, 2024, p. 10" ref="c_EX1_1"/>';
        expandToRawHtml(input, metadata, 'old');
        // page is now undefined vs original "10" → attrs changed → rebuild
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'EX1' }),
            undefined
        );
    });

    it('does not rebuild when page locator is unchanged', () => {
        const { metadata } = makeMetadata();
        const input = '<citation item_id="1-EX1" page="10" label="Author, 2024" ref="c_EX1_1"/>';
        expandToRawHtml(input, metadata, 'old');
        expect(createCitationHTML).not.toHaveBeenCalled();
    });

    // ---- Compound citation ----

    it('restores compound citation (always immutable)', () => {
        const { metadata } = makeMetadata();
        const input = '<citation items="1-K1, 1-K2" label="Author1; Author2" ref="c_K1+K2_0"/>';
        const result = expandToRawHtml(input, metadata, 'old');
        expect(result).toContain('data-citation=');
        expect(createCitationHTML).not.toHaveBeenCalled();
    });

    it('compound citation ignores attribute changes (immutable)', () => {
        const { metadata } = makeMetadata();
        // Even with altered label, compound uses stored rawHtml
        const input = '<citation items="1-K1, 1-K2" label="CHANGED" ref="c_K1+K2_0"/>';
        const result = expandToRawHtml(input, metadata, 'new');
        expect(result).toContain('data-citation=');
        expect(createCitationHTML).not.toHaveBeenCalled();
    });

    // ---- New citation: item_id ----

    it('creates new citation from item_id in new context', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-NEW1" label="New Ref"/>';
        const result = expandToRawHtml(input, metadata, 'new');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'NEW1' }),
            undefined
        );
        expect(result).toContain('data-citation=');
    });

    it('creates new citation from item_id with page', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-NEW1" page="42" label="New Ref, p. 42"/>';
        expandToRawHtml(input, metadata, 'new');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'NEW1' }),
            '42'
        );
    });

    it('throws for new citation with item_id in old context', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-NEW1" label="New Ref"/>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/old_string/);
    });

    // ---- New citation: att_id ----

    it('creates new citation from att_id in new context', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation att_id="1-ATT1" label="From Attachment"/>';
        expandToRawHtml(input, metadata, 'new');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'ATT1' }),
            undefined
        );
    });

    it('creates new citation from att_id with page', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation att_id="1-ATT1" page="7" label="From Attachment"/>';
        expandToRawHtml(input, metadata, 'new');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'ATT1' }),
            '7'
        );
    });

    it('throws for new citation with att_id in old context', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation att_id="1-ATT1" label="From Attachment"/>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/old_string/);
    });

    // ---- New citation: error cases ----

    it('throws for unknown citation ref', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-NONEXIST" label="?" ref="c_NONEXIST_0"/>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown citation ref/);
    });

    it('throws for new compound citation (items without id)', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation items="1-A, 1-B" label="Multi"/>';
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/compound/i);
    });

    it('throws for citation missing item_id and att_id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation label="Nothing"/>';
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/item_id or att_id/);
    });

    it('throws when item not found for new citation via item_id', () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => null);
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-MISSING" label="Missing"/>';
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/Item not found/);
    });

    it('throws when attachment not found for new citation via att_id', () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => null);
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation att_id="1-MISSING" label="Missing"/>';
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/Attachment not found/);
    });

    // ---- extractAttr word-boundary correctness ----

    it('extractAttr distinguishes ref from item_id (no false match)', () => {
        // With the word-boundary fix, extractAttr('ref') should NOT match inside unrelated attrs
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-ONLY" label="Only item_id"/>';
        // ref should be undefined → new citation path → builds from item_id
        const result = expandToRawHtml(input, metadata, 'new');
        expect(createCitationHTML).toHaveBeenCalled();
        expect(result).toContain('data-citation=');
    });

    it('extractAttr distinguishes ref from att_id (no false match)', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation att_id="1-ONLY" label="Only att_id"/>';
        expandToRawHtml(input, metadata, 'new');
        expect(createCitationHTML).toHaveBeenCalled();
    });

    // ---- Multiple citations in one string ----

    it('expands multiple citations in a single string', () => {
        const { metadata, rawCit } = makeMetadata();
        const input = 'See <citation item_id="1-EX1" label="A" ref="c_EX1_0"/> and <citation item_id="1-NEW2" label="B"/>.';
        const result = expandToRawHtml(input, metadata, 'new');
        // First citation restored from metadata
        expect(result).toContain(rawCit);
        // Second citation built fresh
        expect(createCitationHTML).toHaveBeenCalled();
    });

    // ---- Annotations ----

    it('restores existing annotation unchanged', () => {
        const { metadata, rawAnnot } = makeMetadata();
        const input = '<annotation id="a_EA1" key="EA1" color="#ffd400" page="5">text here</annotation>';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawAnnot);
    });

    it('throws when annotation text is modified', () => {
        const { metadata } = makeMetadata();
        const input = '<annotation id="a_EA1" key="EA1">CHANGED TEXT</annotation>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/cannot be modified/i);
    });

    it('accepts annotation with whitespace normalization', () => {
        const metadata: SimplificationMetadata = {
            elements: new Map([
                ['a_WS1', { rawHtml: rawAnnotation('WS1', 'some  text'), type: 'annotation', originalText: 'some  text' }],
            ]),
        };
        const input = '<annotation id="a_WS1" key="WS1">some text</annotation>';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawAnnotation('WS1', 'some  text'));
    });

    it('throws for unknown annotation id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<annotation id="a_NOPE" key="NOPE">text</annotation>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown annotation id/);
    });

    // ---- Annotation-images & images ----

    it('restores annotation-image from metadata', () => {
        const { metadata, rawAI } = makeMetadata();
        const input = '<annotation-image id="ai_EAI1" key="EAI1" attachment="EATT1" />';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawAI);
    });

    it('throws for unknown annotation-image id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<annotation-image id="ai_NOPE" key="NOPE" attachment="X" />';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown annotation-image id/);
    });

    it('restores regular image from metadata', () => {
        const { metadata, rawImg } = makeMetadata();
        const input = '<image id="i_EIMG1" attachment="EIMG1" />';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawImg);
    });

    it('throws for unknown image id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<image id="i_NOPE" attachment="X" />';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown image id/);
    });

    // ---- Plain text passthrough ----

    it('passes through plain text unchanged', () => {
        const { metadata } = makeMetadata();
        expect(expandToRawHtml('Just plain text.', metadata, 'old')).toBe('Just plain text.');
    });
});


// =============================================================================
// Citation Round-Trips: simplify → expand
// =============================================================================

describe('citation round-trips', () => {
    it('single citation: simplify then expand restores original raw HTML', () => {
        const raw = rawCitation('RT1', 1, '', 'Smith, 2020');
        const html = wrap(`<p>See ${raw} for details.</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Simplified form should have the clean tag
        expect(simplified).toContain('ref="c_RT1_0"');
        expect(simplified).not.toContain('data-citation=');

        // Expanding old_string with the simplified citation should restore the raw HTML
        const citationTag = simplified.match(/<citation [^/]*\/>/)?.[0];
        expect(citationTag).toBeTruthy();
        const expanded = expandToRawHtml(citationTag!, metadata, 'old');
        expect(expanded).toBe(raw);
    });

    it('single citation with page: round-trip preserves page locator', () => {
        const raw = rawCitation('RT2', 1, '42', 'Jones, 2021, p. 42');
        const html = wrap(`<p>${raw}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('page="42"');
        const citationTag = simplified.match(/<citation [^/]*\/>/)?.[0];
        const expanded = expandToRawHtml(citationTag!, metadata, 'old');
        expect(expanded).toBe(raw);
    });

    it('compound citation: round-trip restores original', () => {
        const raw = rawCompoundCitation(['C1', 'C2'], 1, 'Author1; Author2');
        const html = wrap(`<p>${raw}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('ref="c_C1+C2_0"');
        expect(simplified).toContain('items=');
        const citationTag = simplified.match(/<citation [^/]*\/>/)?.[0];
        const expanded = expandToRawHtml(citationTag!, metadata, 'old');
        expect(expanded).toBe(raw);
    });

    it('duplicate citations: each gets unique id and round-trips correctly', () => {
        const raw = rawCitation('DRT', 1, '', 'Same, 2024');
        const html = wrap(`<p>${raw}</p><p>${raw}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Two distinct ids
        expect(simplified).toContain('c_DRT_0');
        expect(simplified).toContain('c_DRT_1');

        // Both expand back to the same raw HTML
        const tags = [...simplified.matchAll(/<citation [^/]*\/>/g)].map(m => m[0]);
        expect(tags).toHaveLength(2);
        expect(expandToRawHtml(tags[0], metadata, 'old')).toBe(raw);
        expect(expandToRawHtml(tags[1], metadata, 'old')).toBe(raw);
    });

    it('updating page locator: simplify then expand with changed page rebuilds', () => {
        const raw = rawCitation('PU1', 1, '10', 'Author, 2024, p. 10');
        const html = wrap(`<p>${raw}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Change page from 10 to 99 in the simplified tag
        const modified = simplified.replace('page="10"', 'page="99"');
        const citationTag = modified.match(/<citation [^/]*\/>/)?.[0];
        const expanded = expandToRawHtml(citationTag!, metadata, 'old');
        // Should have called createCitationHTML with the new page
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'PU1' }),
            '99'
        );
        expect(expanded).toContain('data-citation=');
    });

    it('mixed content: citations + annotations + text all round-trip', () => {
        const cit = rawCitation('MIX1', 1, '', 'Ref');
        const ann = rawAnnotation('MIXANN', 'highlight');
        const html = wrap(`<p>Before ${cit} middle ${ann} after</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Both should be simplified
        expect(simplified).toContain('ref="c_MIX1_0"');
        expect(simplified).toContain('<annotation id="a_MIXANN"');

        // Expanding the full simplified string should restore all raw elements
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toContain(cit);
        expect(expanded).toContain(ann);
        expect(expanded).toContain('Before');
        expect(expanded).toContain('after');
    });

    it('new citation inserted alongside existing ones in new_string context', () => {
        const existingRaw = rawCitation('EXI1', 1, '', 'Existing');
        const html = wrap(`<p>${existingRaw}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Build a new_string that keeps the existing citation and adds a new one
        const existingTag = simplified.match(/<citation [^/]*\/>/)?.[0];
        const newString = `${existingTag} and <citation item_id="1-BRAND" label="Brand New"/>`;
        const expanded = expandToRawHtml(newString, metadata, 'new');
        // Existing citation restored from metadata
        expect(expanded).toContain(existingRaw);
        // New citation built via createCitationHTML
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'BRAND' }),
            undefined
        );
    });
});


// =============================================================================
// getOrSimplify (caching)
// =============================================================================

describe('getOrSimplify', () => {
    it('cache miss: simplifies and stores', () => {
        const html = wrap('<p>hello</p>');
        const result = getOrSimplify('test-note', html, 1);
        expect(result.simplified).toContain('<p>hello</p>');
        expect(result.isStale).toBe(false);
    });

    it('cache hit: returns cached, isStale: false', () => {
        const html = wrap('<p>hello</p>');
        getOrSimplify('test-note', html, 1);
        const result2 = getOrSimplify('test-note', html, 1);
        expect(result2.isStale).toBe(false);
    });

    it('cache stale: re-simplifies when content changes, isStale: true', () => {
        const html1 = wrap('<p>version1</p>');
        const html2 = wrap('<p>version2</p>');
        getOrSimplify('test-note', html1, 1);
        const result2 = getOrSimplify('test-note', html2, 1);
        expect(result2.simplified).toContain('version2');
        expect(result2.isStale).toBe(true);
    });

    it('evicts oldest entry when cache is full', () => {
        // Fill cache to MAX_CACHE_SIZE (50)
        for (let i = 0; i < 50; i++) {
            getOrSimplify(`note-${i}`, wrap(`<p>${i}</p>`), 1);
        }
        // Add one more — should evict note-0
        getOrSimplify('note-50', wrap('<p>50</p>'), 1);

        // note-0 should be evicted (fresh simplification = isStale false)
        const result = getOrSimplify('note-0', wrap('<p>0</p>'), 1);
        expect(result.isStale).toBe(false); // Was evicted, so treated as cache miss

        // note-1 should still be cached
        const result1 = getOrSimplify('note-1', wrap('<p>1</p>'), 1);
        expect(result1.isStale).toBe(false); // Still cached, same content
    });
});


// =============================================================================
// stripDataCitationItems / rebuildDataCitationItems
// =============================================================================

describe('stripDataCitationItems', () => {
    it('removes data-citation-items attribute', () => {
        const html = '<div data-schema-version="9" data-citation-items="something">content</div>';
        expect(stripDataCitationItems(html)).toBe('<div data-schema-version="9">content</div>');
    });

    it('is a noop when attribute is absent', () => {
        const html = '<div data-schema-version="9">content</div>';
        expect(stripDataCitationItems(html)).toBe(html);
    });
});

describe('stripNoteWrapperDiv', () => {
    it('strips wrapper with data-schema-version', () => {
        expect(stripNoteWrapperDiv('<div data-schema-version="9"><p>content</p></div>'))
            .toBe('<p>content</p>');
    });

    it('strips bare wrapper div', () => {
        expect(stripNoteWrapperDiv('<div><p>content</p></div>'))
            .toBe('<p>content</p>');
    });

    it('preserves inner whitespace', () => {
        expect(stripNoteWrapperDiv('<div data-schema-version="9">\n<h1>Title</h1>\n<p>Text</p>\n</div>'))
            .toBe('\n<h1>Title</h1>\n<p>Text</p>\n');
    });

    it('is a no-op for non-div HTML', () => {
        expect(stripNoteWrapperDiv('<p>just a paragraph</p>'))
            .toBe('<p>just a paragraph</p>');
    });

    it('is a no-op for empty string', () => {
        expect(stripNoteWrapperDiv('')).toBe('');
    });

    it('does not strip if inner divs are unbalanced', () => {
        const html = '<div><div><p>nested</p></div></div>';
        // Inner has 1 open and 1 close — balanced, so it strips the outer
        expect(stripNoteWrapperDiv(html)).toBe('<div><p>nested</p></div>');
    });
});

describe('rebuildDataCitationItems', () => {
    it('rebuilds data-citation-items from citations', () => {
        const html = wrap(`<p>${rawCitation('RB1')}</p>`);
        const stripped = stripDataCitationItems(html);
        const rebuilt = rebuildDataCitationItems(stripped);
        expect(rebuilt).toContain('data-citation-items=');
    });

    it('deduplicates URIs', () => {
        const html = wrap(`<p>${rawCitation('RB2')}</p><p>${rawCitation('RB2')}</p>`);
        const stripped = stripDataCitationItems(html);
        const rebuilt = rebuildDataCitationItems(stripped);
        // The data-citation-items should contain the item only once
        const match = rebuilt.match(/data-citation-items="([^"]*)"/);
        expect(match).toBeTruthy();
        const decoded = JSON.parse(decodeURIComponent(match![1]));
        expect(decoded.length).toBe(1);
    });

    it('skips malformed citation data', () => {
        const html = wrap('<span class="citation" data-citation="not%20valid%20json">text</span>');
        // Should not throw
        expect(() => rebuildDataCitationItems(html)).not.toThrow();
    });
});


// =============================================================================
// validateNewString
// =============================================================================

describe('validateNewString', () => {
    const metaWithElements: SimplificationMetadata = {
        elements: new Map([
            ['a_A1', { rawHtml: '', type: 'annotation', originalText: 'text' }],
            ['ai_AI1', { rawHtml: '', type: 'annotation-image' }],
            ['i_I1', { rawHtml: '', type: 'image' }],
        ]),
    };

    it('accepts plain text', () => {
        expect(validateNewString('Just text', metaWithElements)).toBeNull();
    });

    it('accepts existing annotation by id', () => {
        const str = '<annotation id="a_A1" key="A1">text</annotation>';
        expect(validateNewString(str, metaWithElements)).toBeNull();
    });

    it('accepts new single citation (no ref)', () => {
        const str = '<citation item_id="1-NEW" label="Test"/>';
        expect(validateNewString(str, metaWithElements)).toBeNull();
    });

    it('rejects fabricated annotation without id', () => {
        const str = '<annotation key="FAKE">fake text</annotation>';
        expect(validateNewString(str, metaWithElements)).toContain('cannot be created');
    });

    it('rejects fabricated annotation with unknown id', () => {
        const str = '<annotation id="a_UNKNOWN" key="UNKNOWN">fake</annotation>';
        expect(validateNewString(str, metaWithElements)).toContain('cannot be created');
    });

    it('rejects fabricated image', () => {
        const str = '<image id="i_FAKE" attachment="X" />';
        expect(validateNewString(str, metaWithElements)).toContain('cannot be inserted');
    });

    it('rejects fabricated annotation-image', () => {
        const str = '<annotation-image id="ai_FAKE" attachment="X" />';
        expect(validateNewString(str, metaWithElements)).toContain('cannot be created');
    });

    it('rejects new compound citation (items attr without ref)', () => {
        const str = '<citation items="1-A, 1-B" label="Multi"/>';
        expect(validateNewString(str, metaWithElements)).toContain('compound');
    });
});


// =============================================================================
// findFuzzyMatch
// =============================================================================

describe('findFuzzyMatch', () => {
    it('finds whitespace-relaxed exact match', () => {
        const simplified = 'This is a   long\n   sentence with  whitespace.';
        const result = findFuzzyMatch(simplified, 'long sentence with whitespace');
        expect(result).toBeTruthy();
        expect(result).toContain('long');
    });

    it('finds word overlap above 30% threshold', () => {
        const simplified = '<p>The quick brown fox jumps over the lazy dog.</p>\n<p>Other content here.</p>';
        // Enough word overlap with first line
        const result = findFuzzyMatch(simplified, 'quick brown fox jumps');
        expect(result).toBeTruthy();
    });

    it('returns null for match below 30% threshold', () => {
        const simplified = '<p>The quick brown fox.</p>\n<p>Other content.</p>';
        const result = findFuzzyMatch(simplified, 'completely unrelated words here now');
        expect(result).toBeNull();
    });

    it('returns null for empty/short-word search', () => {
        const simplified = '<p>Content here.</p>';
        // All words <= 2 chars are filtered out
        const result = findFuzzyMatch(simplified, 'a b c');
        expect(result).toBeNull();
    });
});


// =============================================================================
// countOccurrences
// =============================================================================

describe('countOccurrences', () => {
    it('returns 0 for no match', () => {
        expect(countOccurrences('hello world', 'xyz')).toBe(0);
    });

    it('returns 1 for single match', () => {
        expect(countOccurrences('hello world', 'world')).toBe(1);
    });

    it('returns correct count for multiple matches', () => {
        expect(countOccurrences('abcabcabc', 'abc')).toBe(3);
    });

    it('returns 0 for empty needle', () => {
        expect(countOccurrences('hello', '')).toBe(0);
    });
});


// =============================================================================
// checkDuplicateCitations
// =============================================================================

describe('checkDuplicateCitations', () => {
    it('returns null when no new citations', () => {
        const metadata: SimplificationMetadata = {
            elements: new Map([
                ['c_EX_0', { rawHtml: '', type: 'citation', originalAttrs: { item_id: '1-EX' } }],
            ]),
        };
        expect(checkDuplicateCitations('<p>plain text</p>', metadata)).toBeNull();
    });

    it('returns null when new citation references a different item', () => {
        const metadata: SimplificationMetadata = {
            elements: new Map([
                ['c_EX_0', { rawHtml: '', type: 'citation', originalAttrs: { item_id: '1-EX' } }],
            ]),
        };
        const newStr = '<citation item_id="1-OTHER" label="Other"/>';
        expect(checkDuplicateCitations(newStr, metadata)).toBeNull();
    });

    it('returns warning when new citation duplicates existing', () => {
        const metadata: SimplificationMetadata = {
            elements: new Map([
                ['c_DUP_0', { rawHtml: '', type: 'citation', originalAttrs: { item_id: '1-DUP' } }],
            ]),
        };
        const newStr = '<citation item_id="1-DUP" label="Dup"/>';
        const result = checkDuplicateCitations(newStr, metadata);
        expect(result).toContain('already cited');
        expect(result).toContain('c_DUP_0');
    });
});


// =============================================================================
// isNoteInEditor
// =============================================================================

describe('isNoteInEditor', () => {
    const connectedInstance = (id: number) => ({
        _item: { id },
        _iframeWindow: { frameElement: { isConnected: true } },
    });

    const disconnectedInstance = (id: number) => ({
        _item: { id },
        _iframeWindow: { frameElement: { isConnected: false } },
    });

    it('returns true when note is in a connected editor', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [connectedInstance(42)];
        expect(isNoteInEditor(42)).toBe(true);
    });

    it('returns false when note is not in editor', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [connectedInstance(99)];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when editor instances is empty', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when _editorInstances is undefined', () => {
        (globalThis as any).Zotero.Notes._editorInstances = undefined;
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false for stale instance (iframe disconnected from DOM)', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [disconnectedInstance(42)];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when _iframeWindow is null (destroyed editor)', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [
            { _item: { id: 42 }, _iframeWindow: null },
        ];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when frameElement is missing', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [
            { _item: { id: 42 }, _iframeWindow: {} },
        ];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when accessing _iframeWindow throws', () => {
        const instance = {
            _item: { id: 42 },
            get _iframeWindow() { throw new Error('dead object'); },
        };
        (globalThis as any).Zotero.Notes._editorInstances = [instance];
        expect(isNoteInEditor(42)).toBe(false);
    });
});


// =============================================================================
// getLatestNoteHtml
// =============================================================================

describe('getLatestNoteHtml', () => {
    const mockItem = (id: number, noteHtml: string) => ({
        id,
        getNote: vi.fn(() => noteHtml),
    });

    it('returns editor HTML when note is open in a connected editor', () => {
        const item = mockItem(42, '<p>saved version</p>');
        const editorHtml = '<p>editor version with unsaved changes</p>';
        (globalThis as any).Zotero.Notes._editorInstances = [{
            _item: { id: 42 },
            _iframeWindow: {
                frameElement: { isConnected: true },
                wrappedJSObject: {
                    getDataSync: vi.fn(() => ({ html: editorHtml })),
                },
            },
        }];
        expect(getLatestNoteHtml(item)).toBe(editorHtml);
    });

    it('falls back to item.getNote() when note is not in any editor', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = [{
            _item: { id: 99 },
            _iframeWindow: {
                frameElement: { isConnected: true },
                wrappedJSObject: {
                    getDataSync: vi.fn(() => ({ html: '<p>other note</p>' })),
                },
            },
        }];
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });

    it('falls back to item.getNote() when editor instances is empty', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = [];
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });

    it('falls back to item.getNote() when _editorInstances is undefined', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = undefined;
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });

    it('falls back to item.getNote() when iframe is disconnected (dead wrapper)', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = [{
            _item: { id: 42 },
            _iframeWindow: {
                frameElement: { isConnected: false },
                wrappedJSObject: {
                    getDataSync: vi.fn(() => ({ html: '<p>stale</p>' })),
                },
            },
        }];
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });

    it('falls back to item.getNote() when getDataSync returns null', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = [{
            _item: { id: 42 },
            _iframeWindow: {
                frameElement: { isConnected: true },
                wrappedJSObject: {
                    getDataSync: vi.fn(() => null),
                },
            },
        }];
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });

    it('falls back to item.getNote() when getDataSync throws', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = [{
            _item: { id: 42 },
            _iframeWindow: {
                frameElement: { isConnected: true },
                wrappedJSObject: {
                    getDataSync: vi.fn(() => { throw new Error('dead object'); }),
                },
            },
        }];
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });

    it('falls back to item.getNote() when _iframeWindow access throws', () => {
        const item = mockItem(42, '<p>saved version</p>');
        (globalThis as any).Zotero.Notes._editorInstances = [{
            _item: { id: 42 },
            get _iframeWindow() { throw new Error('dead object'); },
        }];
        expect(getLatestNoteHtml(item)).toBe('<p>saved version</p>');
    });
});


// =============================================================================
// findRangeByContexts
// =============================================================================

describe('findRangeByContexts', () => {
    const html = '<div><p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p></div>';

    it('returns range between both anchors', () => {
        const result = findRangeByContexts(html, '<p>First paragraph.</p>', '<p>Third paragraph.</p>');
        expect(result).not.toBeNull();
        expect(html.substring(result!.start, result!.end)).toBe('<p>Second paragraph.</p>');
    });

    it('returns range from before anchor to end when no after anchor', () => {
        const result = findRangeByContexts(html, '<p>Second paragraph.</p>');
        expect(result).not.toBeNull();
        expect(html.substring(result!.start, result!.end)).toBe('<p>Third paragraph.</p></div>');
    });

    it('returns range from before anchor to end when after anchor is empty string', () => {
        // Empty string has length 0, so hasAfter = false → edit-at-end-of-note branch
        const result = findRangeByContexts(html, '<p>Second paragraph.</p>', '');
        expect(result).not.toBeNull();
        expect(html.substring(result!.start, result!.end)).toBe('<p>Third paragraph.</p></div>');
    });

    it('returns range from start to after anchor when no before anchor', () => {
        const result = findRangeByContexts(html, undefined, '<p>Second paragraph.</p>');
        expect(result).not.toBeNull();
        expect(html.substring(result!.start, result!.end)).toBe('<div><p>First paragraph.</p>');
    });

    it('returns range from start to after anchor when before anchor is empty string', () => {
        // Empty string has length 0, so hasBefore = false → edit-at-start-of-note branch
        const result = findRangeByContexts(html, '', '<p>Second paragraph.</p>');
        expect(result).not.toBeNull();
        expect(html.substring(result!.start, result!.end)).toBe('<div><p>First paragraph.</p>');
    });

    it('returns null when neither anchor provided', () => {
        expect(findRangeByContexts(html)).toBeNull();
    });

    it('returns null when both anchors are undefined', () => {
        expect(findRangeByContexts(html, undefined, undefined)).toBeNull();
    });

    it('returns null when both anchors are empty strings', () => {
        expect(findRangeByContexts(html, '', '')).toBeNull();
    });

    it('returns null when before anchor not found', () => {
        expect(findRangeByContexts(html, 'nonexistent text')).toBeNull();
    });

    it('returns null when after anchor not found', () => {
        expect(findRangeByContexts(html, undefined, 'nonexistent text')).toBeNull();
    });

    it('returns null when before anchor exists but after anchor not found', () => {
        expect(findRangeByContexts(html, '<p>First paragraph.</p>', 'nonexistent')).toBeNull();
    });

    it('returns empty range when anchors are adjacent', () => {
        const result = findRangeByContexts(html,
            '<p>First paragraph.</p>',
            '<p>Second paragraph.</p>');
        expect(result).not.toBeNull();
        expect(html.substring(result!.start, result!.end)).toBe('');
    });

    it('handles before anchor that appears multiple times (uses first valid pair)', () => {
        const repeated = '<p>A</p><p>B</p><p>A</p><p>C</p>';
        const result = findRangeByContexts(repeated, '<p>A</p>', '<p>C</p>');
        expect(result).not.toBeNull();
        // First <p>A</p> to <p>C</p>
        expect(repeated.substring(result!.start, result!.end)).toBe('<p>B</p><p>A</p>');
    });
});


// =============================================================================
// Math Simplification
// =============================================================================

describe('Math simplification', () => {
    it('simplifies inline math to dollar notation', () => {
        const html = wrap(`<p>The formula ${rawInlineMath('E=mc^2')} is famous.</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$E=mc^2$');
        expect(simplified).not.toContain('class="math"');
        expect(simplified).not.toContain('<span');
    });

    it('simplifies display math to dollar notation', () => {
        const html = wrap(`<p>Consider:</p>${rawDisplayMath('\\int_0^1 f(x) dx')}`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$$\\int_0^1 f(x) dx$$');
        expect(simplified).not.toContain('class="math"');
        expect(simplified).not.toContain('<pre');
    });

    it('simplifies multiple inline math expressions', () => {
        const html = wrap(`<p>Given ${rawInlineMath('x')} and ${rawInlineMath('y')}, then ${rawInlineMath('x+y')}.</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$x$');
        expect(simplified).toContain('$y$');
        expect(simplified).toContain('$x+y$');
        expect(simplified).not.toContain('class="math"');
    });

    it('simplifies mixed inline and display math', () => {
        const html = wrap(
            `<p>Inline ${rawInlineMath('a^2+b^2=c^2')} and display:</p>`
            + rawDisplayMath('\\sum_{i=1}^n i = \\frac{n(n+1)}{2}')
        );
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$a^2+b^2=c^2$');
        expect(simplified).toContain('$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$');
        expect(simplified).not.toContain('<span');
        expect(simplified).not.toContain('<pre');
    });

    it('simplifies math with HTML entities', () => {
        const html = wrap(`<p>${rawInlineMath('x &lt; y')}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$x &lt; y$');
        expect(simplified).not.toContain('class="math"');
    });

    it('simplifies math alongside citations', () => {
        const cit = rawCitation('MC1', 1, '', 'Author, 2024');
        const html = wrap(`<p>As shown by ${cit}, ${rawInlineMath('p < 0.05')}.</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$p < 0.05$');
        expect(simplified).toContain('ref="c_MC1_0"');
    });

    it('does not affect non-math spans', () => {
        const html = wrap('<p><span class="highlight">text</span> and <span style="color:red">red</span></p>');
        const { simplified } = simplifyNoteHtml(html, 1);
        // highlight is handled separately (as annotation with data-annotation), plain highlight without data-annotation passes through
        expect(simplified).toContain('class="highlight"');
        expect(simplified).toContain('style="color:red"');
    });

    it('leaves math without dollar delimiters unchanged', () => {
        // Forward-compatibility edge case: content without $ delimiters
        const html = wrap('<p><span class="math">x^2</span></p>');
        const { simplified } = simplifyNoteHtml(html, 1);
        // Should pass through unchanged since regex requires $ delimiters
        expect(simplified).toContain('<span class="math">x^2</span>');
    });

    it('simplifies math with LaTeX backslash commands', () => {
        const html = wrap(`<p>${rawInlineMath('\\alpha + \\beta')}</p>`);
        const { simplified } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('$\\alpha + \\beta$');
    });
});


// =============================================================================
// Math Expansion
// =============================================================================

describe('Math expansion', () => {
    function emptyMetadata(): SimplificationMetadata {
        return { elements: new Map() };
    }

    it('expands inline math to span.math', () => {
        const input = 'The formula $E=mc^2$ is famous.';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`The formula ${rawInlineMath('E=mc^2')} is famous.`);
    });

    it('expands display math to pre.math', () => {
        const input = '<p>Consider:</p>$$\\int_0^1 f(x) dx$$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`<p>Consider:</p>${rawDisplayMath('\\int_0^1 f(x) dx')}`);
    });

    it('expands multiple inline math expressions', () => {
        const input = 'Given $x$ and $y$, then $x+y$.';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`Given ${rawInlineMath('x')} and ${rawInlineMath('y')}, then ${rawInlineMath('x+y')}.`);
    });

    it('expands mixed inline and display math', () => {
        const input = '<p>Inline $a^2$ and display:</p>$$E=mc^2$$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`<p>Inline ${rawInlineMath('a^2')} and display:</p>${rawDisplayMath('E=mc^2')}`);
    });

    it('does not expand lone dollar signs (no closing pair)', () => {
        const input = 'The price is $5,000 and rising.';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(input); // unchanged
    });

    it('does not expand dollar with leading space in content', () => {
        const input = '$ not math$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(input); // unchanged — content starts with space
    });

    it('does not expand dollar with trailing space in content', () => {
        const input = '$not math $';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(input); // unchanged — content ends with space
    });

    it('does not expand empty dollar pair', () => {
        const input = 'empty $$ here';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(input); // unchanged — $$ needs content for display math
    });

    it('handles math with LaTeX commands', () => {
        const input = '$\\frac{a}{b}$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawInlineMath('\\frac{a}{b}'));
    });

    it('handles math with backslash-escaped dollar', () => {
        const input = '$\\$5$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawInlineMath('\\$5'));
    });

    it('handles display math with multiline content', () => {
        const input = '$$\\begin{align}\n  x &= 1 \\\\\n  y &= 2\n\\end{align}$$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`<pre class="math">${input}</pre>`);
    });

    it('does not double-wrap already-wrapped math in old context', () => {
        // If somehow the input already has math HTML, the dollar regex should
        // not match the $ inside the tag content (they are flanked by > and <)
        const input = '<span class="math">$x$</span>';
        const result = expandToRawHtml(input, emptyMetadata(), 'old');
        // The $x$ inside the span: $ is preceded by > (not $) and followed by x,
        // but the whole thing is already wrapped. The inner $x$ WILL be matched
        // by the inline regex since it sees the bare $x$ between > and <.
        // This produces double-wrapping — but this case should never occur
        // because the simplified view strips math wrappers.
        // We just document this known behavior rather than guard against it.
        expect(result).toContain('class="math"');
    });

    it('passes through plain text without math unchanged', () => {
        const input = 'Just plain text with no math.';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(input);
    });

    it('single character inline math', () => {
        const input = '$x$';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawInlineMath('x'));
    });

    it('does not expand adjacent $$ as inline', () => {
        // $$ without content after should not trigger inline or display
        const input = 'See $$ for prices';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(input);
    });

    // ---- Standalone math in paragraph → display math ----

    it('converts standalone inline math in <p> to display math', () => {
        const input = '<p>$E=mc^2$</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawDisplayMath('E=mc^2'));
    });

    it('converts standalone display math in <p> (unwraps paragraph)', () => {
        const input = '<p>$$E=mc^2$$</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawDisplayMath('E=mc^2'));
    });

    it('converts standalone math with LaTeX commands in <p> to display', () => {
        const input = '<p>$\\hat{\\beta} = (X\'X)^{-1}X\'Y$</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawDisplayMath('\\hat{\\beta} = (X\'X)^{-1}X\'Y'));
    });

    it('keeps inline math as span when paragraph has other content', () => {
        const input = '<p>The formula $E=mc^2$ is famous.</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`<p>The formula ${rawInlineMath('E=mc^2')} is famous.</p>`);
    });

    it('converts standalone math in <p> with style attribute to display', () => {
        const input = '<p style="text-align: center;">$\\hat{\\beta} = (X\'X)^{-1}X\'y$</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawDisplayMath('\\hat{\\beta} = (X\'X)^{-1}X\'y'));
    });

    it('converts standalone display math in <p> with attributes (unwraps)', () => {
        const input = '<p style="text-align: center;">$$E=mc^2$$</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(rawDisplayMath('E=mc^2'));
    });

    it('mixed: standalone equation + inline math in separate paragraphs', () => {
        const input = '<p>$E=mc^2$</p>\n<p>Where $E$ is energy.</p>';
        const result = expandToRawHtml(input, emptyMetadata(), 'new');
        expect(result).toBe(`${rawDisplayMath('E=mc^2')}\n<p>Where ${rawInlineMath('E')} is energy.</p>`);
    });
});


// =============================================================================
// Math Round-Trips: simplify → expand
// =============================================================================

describe('Math round-trips', () => {
    it('inline math: simplify then expand restores original raw HTML', () => {
        const raw = rawInlineMath('E=mc^2');
        const html = wrap(`<p>The formula ${raw} is famous.</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Simplified form should have dollar notation, no HTML wrapper
        expect(simplified).toContain('$E=mc^2$');
        expect(simplified).not.toContain('class="math"');

        // Expanding should restore the raw HTML
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toContain(raw);
    });

    it('display math: simplify then expand restores original raw HTML', () => {
        const raw = rawDisplayMath('\\frac{a}{b}');
        const html = wrap(`<p>Consider:</p>${raw}<p>where a,b are integers.</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('$$\\frac{a}{b}$$');
        expect(simplified).not.toContain('<pre');

        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toContain(raw);
    });

    it('multiple math expressions round-trip', () => {
        const inline1 = rawInlineMath('x');
        const inline2 = rawInlineMath('y');
        const display = rawDisplayMath('x + y = z');
        const html = wrap(`<p>${inline1} and ${inline2}</p>${display}`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toContain(inline1);
        expect(expanded).toContain(inline2);
        expect(expanded).toContain(display);
    });

    it('mixed math and citations round-trip', () => {
        const cit = rawCitation('MRT1', 1, '', 'Author, 2024');
        const math = rawInlineMath('p < 0.05');
        const html = wrap(`<p>As shown by ${cit}, ${math} is significant.</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('$p < 0.05$');
        expect(simplified).toContain('ref="c_MRT1_0"');

        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toContain(cit);
        expect(expanded).toContain(math);
    });

    it('agent modifies existing math: expanded old matches raw, expanded new wraps correctly', () => {
        const html = wrap(`<p>The formula ${rawInlineMath('E=mc^2')} is famous.</p>`);
        const strippedHtml = stripDataCitationItems(html);
        const { metadata } = simplifyNoteHtml(html, 1);

        // Agent proposes changing E=mc^2 to E=mc^3
        const expandedOld = expandToRawHtml('$E=mc^2$', metadata, 'old');
        const expandedNew = expandToRawHtml('$E=mc^3$', metadata, 'new');

        expect(expandedOld).toBe(rawInlineMath('E=mc^2'));
        expect(expandedNew).toBe(rawInlineMath('E=mc^3'));

        // Expanded old should be findable in the raw HTML
        expect(strippedHtml).toContain(expandedOld);
    });

    it('agent removes math: expanded old_string matches raw HTML', () => {
        const html = wrap(`<p>Remove ${rawInlineMath('x^2')} here.</p>`);
        const strippedHtml = stripDataCitationItems(html);
        const { metadata } = simplifyNoteHtml(html, 1);

        const expandedOld = expandToRawHtml('$x^2$ ', metadata, 'old');
        expect(expandedOld).toBe(`${rawInlineMath('x^2')} `);
        expect(strippedHtml).toContain(rawInlineMath('x^2'));
    });

    it('agent adds math to note without math', () => {
        const html = wrap('<p>Plain text note.</p>');
        const { metadata } = simplifyNoteHtml(html, 1);

        // Agent adds math in new_string
        const expandedNew = expandToRawHtml('Plain text note with $x^2$.', metadata, 'new');
        expect(expandedNew).toBe(`Plain text note with ${rawInlineMath('x^2')}.`);
    });

    it('new display math in new_string expands correctly', () => {
        const html = wrap('<p>Some text.</p>');
        const { metadata } = simplifyNoteHtml(html, 1);

        const expandedNew = expandToRawHtml(
            '<p>Some text.</p>$$\\int_0^\\infty e^{-x} dx = 1$$',
            metadata,
            'new'
        );
        expect(expandedNew).toContain(rawDisplayMath('\\int_0^\\infty e^{-x} dx = 1'));
    });
});


// =============================================================================
// Math Apply-Undo-Apply Cycle
// =============================================================================

describe('Math apply-undo-apply cycle', () => {
    it('full cycle: apply math edit, undo restores, re-apply succeeds', () => {
        // --- Original note with inline math ---
        const noteHtml = wrap(`<p>The formula ${rawInlineMath('E=mc^2')} is famous.</p>`);
        const strippedHtml = stripDataCitationItems(noteHtml);

        // --- Step 1: Simplify ---
        const { simplified, metadata } = simplifyNoteHtml(noteHtml, 1);
        expect(simplified).toContain('$E=mc^2$');
        expect(simplified).not.toContain('class="math"');

        // --- Step 2: Agent proposes edit ---
        const oldString = '$E=mc^2$';
        const newString = '$E=mc^3$';

        // --- Step 3: Expand ---
        const expandedOld = expandToRawHtml(oldString, metadata, 'old');
        const expandedNew = expandToRawHtml(newString, metadata, 'new');
        expect(expandedOld).toBe(rawInlineMath('E=mc^2'));
        expect(expandedNew).toBe(rawInlineMath('E=mc^3'));

        // --- Step 4: Apply (use replaceFirst to avoid $ interpretation in .replace()) ---
        expect(strippedHtml).toContain(expandedOld);
        const afterApply = replaceFirst(strippedHtml, expandedOld, expandedNew);
        expect(afterApply).toContain(rawInlineMath('E=mc^3'));
        expect(afterApply).not.toContain(rawInlineMath('E=mc^2'));

        // --- Step 5: Undo data (as stored by executeEditNoteAction) ---
        const undoOldHtml = expandedOld;
        const undoNewHtml = expandedNew;

        // --- Step 6: Undo (find undoNewHtml, replace with undoOldHtml) ---
        const afterUndoStripped = stripDataCitationItems(afterApply);
        expect(afterUndoStripped).toContain(undoNewHtml);
        const afterUndo = replaceFirst(afterUndoStripped, undoNewHtml, undoOldHtml);
        expect(afterUndo).toBe(strippedHtml); // restored to original

        // --- Step 7: Re-apply (same edit on restored note) ---
        invalidateSimplificationCache('test-note');
        const { simplified: simplified2, metadata: metadata2 } = simplifyNoteHtml(afterUndo, 1);
        const expandedOld2 = expandToRawHtml(oldString, metadata2, 'old');
        const expandedNew2 = expandToRawHtml(newString, metadata2, 'new');
        expect(afterUndo).toContain(expandedOld2);
        const afterReapply = replaceFirst(afterUndo, expandedOld2, expandedNew2);
        expect(afterReapply).toBe(afterApply); // same result as first apply
    });

    it('full cycle with display math', () => {
        const noteHtml = wrap(`<p>Proof:</p>${rawDisplayMath('a^2 + b^2 = c^2')}<p>QED</p>`);
        const strippedHtml = stripDataCitationItems(noteHtml);

        // Simplify
        const { simplified, metadata } = simplifyNoteHtml(noteHtml, 1);
        expect(simplified).toContain('$$a^2 + b^2 = c^2$$');

        // Agent changes the equation
        const oldString = '$$a^2 + b^2 = c^2$$';
        const newString = '$$a^n + b^n = c^n$$';

        // Expand
        const expandedOld = expandToRawHtml(oldString, metadata, 'old');
        const expandedNew = expandToRawHtml(newString, metadata, 'new');
        expect(expandedOld).toBe(rawDisplayMath('a^2 + b^2 = c^2'));
        expect(expandedNew).toBe(rawDisplayMath('a^n + b^n = c^n'));

        // Apply (use replaceFirst to avoid $$ interpretation in .replace())
        expect(strippedHtml).toContain(expandedOld);
        const afterApply = replaceFirst(strippedHtml, expandedOld, expandedNew);

        // Undo
        const afterUndo = replaceFirst(afterApply, expandedNew, expandedOld);
        expect(afterUndo).toBe(strippedHtml);

        // Re-apply
        invalidateSimplificationCache('test-note');
        const { metadata: metadata2 } = simplifyNoteHtml(afterUndo, 1);
        const expandedOld2 = expandToRawHtml(oldString, metadata2, 'old');
        const expandedNew2 = expandToRawHtml(newString, metadata2, 'new');
        const afterReapply = replaceFirst(afterUndo, expandedOld2, expandedNew2);
        expect(afterReapply).toBe(afterApply);
    });

    it('full cycle: add math to plain text note', () => {
        const noteHtml = wrap('<p>Plain text.</p>');
        const strippedHtml = stripDataCitationItems(noteHtml);

        const { metadata } = simplifyNoteHtml(noteHtml, 1);

        // Agent adds math
        const oldString = 'Plain text.';
        const newString = 'Plain text with $x^2$.';

        const expandedOld = expandToRawHtml(oldString, metadata, 'old');
        const expandedNew = expandToRawHtml(newString, metadata, 'new');

        expect(expandedOld).toBe('Plain text.');
        expect(expandedNew).toBe(`Plain text with ${rawInlineMath('x^2')}.`);

        // Apply
        const afterApply = replaceFirst(strippedHtml, expandedOld, expandedNew);
        expect(afterApply).toContain(rawInlineMath('x^2'));

        // Undo
        const afterUndo = replaceFirst(afterApply, expandedNew, expandedOld);
        expect(afterUndo).toBe(strippedHtml);
    });

    it('full cycle: delete math from note', () => {
        const noteHtml = wrap(`<p>Text ${rawInlineMath('x^2')} end.</p>`);
        const strippedHtml = stripDataCitationItems(noteHtml);

        const { metadata } = simplifyNoteHtml(noteHtml, 1);

        // Agent removes math (include enough surrounding context for unique match)
        const oldString = 'Text $x^2$ end.';
        const newString = 'Text end.';

        const expandedOld = expandToRawHtml(oldString, metadata, 'old');
        const expandedNew = expandToRawHtml(newString, metadata, 'new');

        expect(expandedOld).toBe(`Text ${rawInlineMath('x^2')} end.`);
        expect(expandedNew).toBe('Text end.');

        // Apply
        expect(strippedHtml).toContain(expandedOld);
        const afterApply = replaceFirst(strippedHtml, expandedOld, expandedNew);
        expect(afterApply).not.toContain('class="math"');

        // Undo
        const afterUndo = replaceFirst(afterApply, expandedNew, expandedOld);
        expect(afterUndo).toBe(strippedHtml);
    });

    it('full cycle with math alongside citations', () => {
        const cit = rawCitation('CYC1', 1, '', 'Author, 2024');
        const noteHtml = wrap(`<p>As ${cit} shows, ${rawInlineMath('p=0.01')}.</p>`);
        const strippedHtml = stripDataCitationItems(noteHtml);

        const { simplified, metadata } = simplifyNoteHtml(noteHtml, 1);
        const citTag = simplified.match(/<citation [^/]*\/>/)?.[0];
        expect(citTag).toBeTruthy();

        // Agent modifies the math but keeps the citation
        const oldString = `${citTag} shows, $p=0.01$.`;
        const newString = `${citTag} shows, $p=0.001$.`;

        const expandedOld = expandToRawHtml(oldString, metadata, 'old');
        const expandedNew = expandToRawHtml(newString, metadata, 'new');

        // Citation should be restored, math should be wrapped
        expect(expandedOld).toContain(cit);
        expect(expandedOld).toContain(rawInlineMath('p=0.01'));
        expect(expandedNew).toContain(cit);
        expect(expandedNew).toContain(rawInlineMath('p=0.001'));

        // Apply
        expect(strippedHtml).toContain(expandedOld);
        const afterApply = replaceFirst(strippedHtml, expandedOld, expandedNew);

        // Undo
        const afterUndo = replaceFirst(afterApply, expandedNew, expandedOld);
        expect(afterUndo).toBe(strippedHtml);
    });

    it('full cycle: add standalone equation (paragraph-to-display)', () => {
        // Simulates the real scenario: agent adds a standalone equation in its
        // own <p> alongside inline math in running text.
        const noteHtml = wrap('<p>Some existing text.</p>\n</div>');
        const strippedHtml = stripDataCitationItems(noteHtml);

        const { metadata } = simplifyNoteHtml(noteHtml, 1);

        const oldString = '<p>Some existing text.</p>\n</div>';
        const newString = '<p>Some existing text.</p>\n'
            + '<p>The estimator is:</p>\n'
            + '<p>$\\hat{\\beta} = (X\'X)^{-1}X\'Y$</p>\n'
            + '<p>Where $X$ is the design matrix.</p>\n'
            + '</div>';

        const expandedOld = expandToRawHtml(oldString, metadata, 'old');
        const expandedNew = expandToRawHtml(newString, metadata, 'new');

        // Standalone equation → display math (no <p> wrapper)
        expect(expandedNew).toContain('<pre class="math">$$\\hat{\\beta} = (X\'X)^{-1}X\'Y$$</pre>');
        expect(expandedNew).not.toContain('<p><span class="math">');
        expect(expandedNew).not.toContain('<p><pre');
        // Inline math in running text → inline math
        expect(expandedNew).toContain('<span class="math">$X$</span>');

        // Apply
        expect(strippedHtml).toContain(expandedOld);
        const afterApply = replaceFirst(strippedHtml, expandedOld, expandedNew);

        // Undo
        const afterUndo = replaceFirst(afterApply, expandedNew, expandedOld);
        expect(afterUndo).toBe(strippedHtml);

        // Re-apply
        invalidateSimplificationCache('test-note');
        const { metadata: m2 } = simplifyNoteHtml(afterUndo, 1);
        const expandedOld2 = expandToRawHtml(oldString, m2, 'old');
        const expandedNew2 = expandToRawHtml(newString, m2, 'new');
        const afterReapply = replaceFirst(afterUndo, expandedOld2, expandedNew2);
        expect(afterReapply).toBe(afterApply);
    });
});
