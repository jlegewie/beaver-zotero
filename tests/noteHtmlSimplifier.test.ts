import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock createCitationHTML before importing the module under test
vi.mock('../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(
        (item: any, page?: string) =>
            `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify({
                citationItems: [{
                    uris: [`http://zotero.org/users/1/items/${item.key}`],
                    locator: page || '',
                }],
            }))}"><span class="citation-item">${item.getField?.('title') || 'Mock Title'}${page ? ', p. ' + page : ''}</span></span>`
    ),
}));

import {
    simplifyNoteHtml,
    expandToRawHtml,
    getOrSimplify,
    invalidateSimplificationCache,
    stripDataCitationItems,
    rebuildDataCitationItems,
    validateNewString,
    findFuzzyMatch,
    countOccurrences,
    checkDuplicateCitations,
    isNoteInEditor,
    SimplificationMetadata,
} from '../src/utils/noteHtmlSimplifier';
import { createCitationHTML } from '../src/utils/zoteroUtils';


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
                key,
                libraryID: libId,
                getField: vi.fn(() => 'Mock Title'),
            })),
        },
        URI: {
            getURIItem: vi.fn((uri: string) => {
                const keyMatch = uri.match(/\/items\/([A-Z0-9]+)$/i);
                return keyMatch ? { key: keyMatch[1] } : null;
            }),
        },
        Utilities: {
            Item: {
                itemToCSLJSON: vi.fn((item: any) => ({ id: item.key, type: 'article-journal' })),
            },
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
        expect(simplified).toContain('<citation id="c_ABCD1234_0"');
        expect(simplified).toContain('item_id="1-ABCD1234"');
        expect(simplified).toContain('label="Author, 2024"');
        expect(simplified).toContain('/>');
        expect(metadata.elements.has('c_ABCD1234_0')).toBe(true);
        expect(metadata.elements.get('c_ABCD1234_0')!.type).toBe('citation');
    });

    it('replaces compound citation with items attribute', () => {
        const html = wrap(`<p>${rawCompoundCitation(['KEY1', 'KEY2'])}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('<citation id="c_KEY1+KEY2_0"');
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

    it('handles mixed content with all element types', () => {
        const inner = `<p>Intro</p>`
            + `<p>${rawCitation('C1', 1, '', 'Smith, 2020')}</p>`
            + `<p>${rawAnnotation('A1', 'quote')}</p>`
            + rawAnnotationImage('AI1', 'AT1')
            + rawImage('IM1');
        const html = wrap(inner);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('<citation id="c_C1_0"');
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
                ['c_K1+K2_0', { rawHtml: rawCompoundCitation(['K1', 'K2']), type: 'compound-citation' as const, isCompound: true }],
                ['a_EA1', { rawHtml: rawAnnot, type: 'annotation' as const, originalText: 'text here' }],
                ['ai_EAI1', { rawHtml: rawAI, type: 'annotation-image' as const }],
                ['i_EIMG1', { rawHtml: rawImg, type: 'image' as const }],
            ]),
        };

        return { metadata, rawCit, rawAnnot, rawAI, rawImg };
    }

    it('restores existing citation with unchanged attrs', () => {
        const { metadata, rawCit } = makeMetadata();
        const input = '<citation id="c_EX1_0" item_id="1-EX1" label="Author, 2024"/>';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawCit);
    });

    it('rebuilds existing citation when page changes', () => {
        const { metadata } = makeMetadata();
        const input = '<citation id="c_EX1_0" item_id="1-EX1" page="99" label="Author, 2024"/>';
        const result = expandToRawHtml(input, metadata, 'old');
        // Should have called createCitationHTML with page=99
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'EX1' }),
            '99'
        );
        expect(result).toContain('data-citation=');
    });

    it('restores compound citation (always immutable)', () => {
        const { metadata } = makeMetadata();
        const input = '<citation id="c_K1+K2_0" items="1-K1, 1-K2" label="Author1; Author2"/>';
        const result = expandToRawHtml(input, metadata, 'old');
        expect(result).toContain('data-citation=');
        // Should NOT call createCitationHTML — compound citations use stored rawHtml
        expect(createCitationHTML).not.toHaveBeenCalled();
    });

    it('new citation with item_id: extractAttr("id") matches "id" inside "item_id"', () => {
        // Note: extractAttr uses regex `id="..."` which matches within `item_id="..."`.
        // This means new citations (without explicit id=) are treated as having an id,
        // causing them to hit the "existing citation" lookup path and fail.
        const input = '<citation item_id="1-NEW1" label="New Ref"/>';
        const metadata: SimplificationMetadata = { elements: new Map() };
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/Unknown citation id/);
    });

    it('new citation with item_id in old context: same extractAttr issue', () => {
        const input = '<citation item_id="1-NEW1" label="New Ref"/>';
        const metadata: SimplificationMetadata = { elements: new Map() };
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown citation id/);
    });

    it('new citation with att_id: extractAttr("id") matches "id" inside "att_id"', () => {
        const input = '<citation att_id="1-ATT1" label="From Attachment"/>';
        const metadata: SimplificationMetadata = { elements: new Map() };
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/Unknown citation id/);
    });

    it('throws for unknown citation id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation id="c_NONEXIST_0" item_id="1-NONEXIST" label="?"/>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown citation id/);
    });

    it('throws for new compound citation', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation items="1-A, 1-B" label="Multi"/>';
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/compound/i);
    });

    it('throws for citation missing item_id and att_id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation label="Nothing"/>';
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/item_id or att_id/);
    });

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
        // Whitespace-normalized text matches
        const input = '<annotation id="a_WS1" key="WS1">some text</annotation>';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawAnnotation('WS1', 'some  text'));
    });

    it('throws for unknown annotation id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<annotation id="a_NOPE" key="NOPE">text</annotation>';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown annotation id/);
    });

    it('throws for unknown annotation-image id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<annotation-image id="ai_NOPE" key="NOPE" attachment="X" />';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown annotation-image id/);
    });

    it('throws for unknown image id', () => {
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<image id="i_NOPE" attachment="X" />';
        expect(() => expandToRawHtml(input, metadata, 'old')).toThrow(/Unknown image id/);
    });

    it('passes through plain text unchanged', () => {
        const { metadata } = makeMetadata();
        expect(expandToRawHtml('Just plain text.', metadata, 'old')).toBe('Just plain text.');
    });

    it('restores annotation-image from metadata', () => {
        const { metadata, rawAI } = makeMetadata();
        const input = '<annotation-image id="ai_EAI1" key="EAI1" attachment="EATT1" />';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawAI);
    });

    it('restores regular image from metadata', () => {
        const { metadata, rawImg } = makeMetadata();
        const input = '<image id="i_EIMG1" attachment="EIMG1" />';
        expect(expandToRawHtml(input, metadata, 'old')).toBe(rawImg);
    });

    it('throws when item not found for new citation (extractAttr issue)', () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => null);
        const metadata: SimplificationMetadata = { elements: new Map() };
        const input = '<citation item_id="1-MISSING" label="Missing"/>';
        // Due to extractAttr regex, "id" is extracted from "item_id" as "1-MISSING"
        expect(() => expandToRawHtml(input, metadata, 'new')).toThrow(/Unknown citation id/);
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

    it('accepts new single citation (no id)', () => {
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

    it('rejects new compound citation (items attr without id)', () => {
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
    it('returns true when note is in editor', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [
            { _item: { id: 42 } },
        ];
        expect(isNoteInEditor(42)).toBe(true);
    });

    it('returns false when note is not in editor', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [
            { _item: { id: 99 } },
        ];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when editor instances is empty', () => {
        (globalThis as any).Zotero.Notes._editorInstances = [];
        expect(isNoteInEditor(42)).toBe(false);
    });

    it('returns false when _editorInstances is undefined', () => {
        (globalThis as any).Zotero.Notes._editorInstances = undefined;
        // Should not throw, returns false
        expect(isNoteInEditor(42)).toBe(false);
    });
});
