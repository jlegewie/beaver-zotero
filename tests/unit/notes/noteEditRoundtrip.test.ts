import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

// Mock createCitationHTML — same pattern as noteHtmlSimplifier.test.ts
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

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// Mock supabaseClient to avoid "Missing Supabase URL or Anon Key" error.
// editNoteActions → agentActions → agentActionsService → apiService → supabaseClient
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

// Mock sourceUtils to avoid pulling in Jotai store / atom dependencies
vi.mock('../../../react/utils/sourceUtils', () => ({
    clearNoteEditorSelection: vi.fn(),
}));

// =============================================================================
// Imports
// =============================================================================

import {
    simplifyNoteHtml,
    expandToRawHtml,
    stripDataCitationItems,
    stripNoteWrapperDiv,
    rebuildDataCitationItems,
    getOrSimplify,
    invalidateSimplificationCache,
    countOccurrences,
    findFuzzyMatch,
    checkDuplicateCitations,
    validateNewString,
    getLatestNoteHtml,
    normalizePageLocator,
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
            uris: [`http://zotero.org/users/${libraryID}/items/${key}`],
            locator: page,
        }],
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}">`
        + `<span class="citation-item">${label}</span></span>`;
}

/**
 * Expected result of a simplify → expand roundtrip.
 * Strips both data-citation-items and the wrapper div (since simplifyNoteHtml
 * now strips the wrapper from its output, expandToRawHtml can't restore it).
 */
function roundtripExpected(html: string): string {
    return stripNoteWrapperDiv(stripDataCitationItems(html));
}

function stripInlineItemDataFromDataCitationsForTest(html: string): string {
    return html.replace(/data-citation="([^"]*)"/g, (match, encodedCitation) => {
        try {
            const citation = JSON.parse(decodeURIComponent(encodedCitation));
            if (!Array.isArray(citation?.citationItems)) {
                return match;
            }

            const citationItems = citation.citationItems.map((ci: any) => {
                if (!ci || typeof ci !== 'object') {
                    return ci;
                }
                const { itemData: _itemData, ...rest } = ci;
                return rest;
            });

            return `data-citation="${encodeURIComponent(JSON.stringify({
                ...citation,
                citationItems,
            }))}"`;
        } catch {
            return match;
        }
    });
}

function addInlineItemDataToDataCitationsForTest(html: string): string {
    return html.replace(/data-citation="([^"]*)"/g, (match, encodedCitation) => {
        try {
            const citation = JSON.parse(decodeURIComponent(encodedCitation));
            if (!Array.isArray(citation?.citationItems)) {
                return match;
            }

            const citationItems = citation.citationItems.map((ci: any) => {
                const uri = ci?.uris?.[0] || '';
                const keyMatch = uri.match(/\/items\/([A-Z0-9]+)$/i);
                const key = keyMatch ? keyMatch[1] : 'UNKNOWN';
                return {
                    ...ci,
                    itemData: {
                        id: uri || `http://zotero.org/users/1/items/${key}`,
                        type: 'article-journal',
                        author: [{ family: 'Mock', given: 'Author' }],
                        issued: { 'date-parts': [['2024']] },
                        title: key,
                    },
                };
            });

            return `data-citation="${encodeURIComponent(JSON.stringify({
                ...citation,
                citationItems,
            }))}"`;
        } catch {
            return match;
        }
    });
}

/** Build a raw compound citation span */
function rawCompoundCitation(keys: string[], libraryID = 1, label = 'Author1; Author2'): string {
    const citationData = {
        citationItems: keys.map(k => ({
            uris: [`http://zotero.org/users/${libraryID}/items/${k}`],
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
// Real Note Fixtures
// =============================================================================

/**
 * Fixture A — Rich note with ~25 citations to the same item (6QKY56PJ) with
 * different page locators, headings, formatting, lists, adjacent citations,
 * and a large data-citation-items block.
 */
const FIXTURE_A_CITATION_DATA = {
    citationItems: [{
        uris: ['http://zotero.org/users/17517181/items/6QKY56PJ'],
        locator: '',
    }],
};

function fixtureACitation(page: string, label: string): string {
    const data = {
        citationItems: [{
            uris: ['http://zotero.org/users/17517181/items/6QKY56PJ'],
            locator: page,
        }],
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(data))}"><span class="citation-item">${label}</span></span>`;
}

const FIXTURE_A_DATA_CITATION_ITEMS = encodeURIComponent(JSON.stringify([{
    uris: ['http://zotero.org/users/17517181/items/6QKY56PJ'],
    itemData: {
        id: '6QKY56PJ',
        type: 'article-journal',
        title: 'The Effectiveness of Middle School Interventions',
        author: [{ family: 'Rodriguez', given: 'Maria' }],
        issued: { 'date-parts': [['2023']] },
    },
}]));

const FIXTURE_A = `<div data-schema-version="9" data-citation-items="${FIXTURE_A_DATA_CITATION_ITEMS}">`
    + `<h1>Literature Review: Middle School Interventions</h1>`
    + `<p>This review examines the effectiveness of various interventions in middle school settings. `
    + `According to ${fixtureACitation('1', '(Rodriguez, 2023, p. 1)')}, the field has grown significantly `
    + `over the past decade.</p>`
    + `<h3>Background</h3>`
    + `<p>Early studies ${fixtureACitation('5', '(Rodriguez, 2023, p. 5)')} established the foundation `
    + `for understanding student outcomes. The theoretical framework ${fixtureACitation('8', '(Rodriguez, 2023, p. 8)')} `
    + `draws on social learning theory.</p>`
    + `<h4>Key Findings</h4>`
    + `<p><strong>Academic outcomes</strong> were measured across multiple dimensions `
    + `${fixtureACitation('12', '(Rodriguez, 2023, p. 12)')}. Results showed significant improvements `
    + `${fixtureACitation('15', '(Rodriguez, 2023, p. 15)')} in reading comprehension.</p>`
    + `<p><em>Social-emotional outcomes</em> were equally important `
    + `${fixtureACitation('18', '(Rodriguez, 2023, p. 18)')}${fixtureACitation('19', '(Rodriguez, 2023, p. 19)')}, `
    + `with students reporting higher self-efficacy.</p>`
    + `<ul>`
    + `<li>Intervention A: Showed 20% improvement ${fixtureACitation('22', '(Rodriguez, 2023, p. 22)')}</li>`
    + `<li>Intervention B: Showed 15% improvement ${fixtureACitation('25', '(Rodriguez, 2023, p. 25)')}</li>`
    + `<li>Intervention C: Mixed results ${fixtureACitation('28', '(Rodriguez, 2023, p. 28)')}</li>`
    + `</ul>`
    + `<p>In summary, the evidence suggests ${fixtureACitation('30', '(Rodriguez, 2023, p. 30)')} `
    + `that targeted interventions are effective ${fixtureACitation('31', '(Rodriguez, 2023, p. 31)')} `
    + `for improving academic outcomes ${fixtureACitation('32', '(Rodriguez, 2023, p. 32)')} `
    + `among middle school students ${fixtureACitation('33', '(Rodriguez, 2023, p. 33)')}.</p>`
    + `</div>`;

/**
 * Fixture B — Smaller note with 2 citations to a different item (HPDPU3J5),
 * numeric locator (integer vs string).
 */
function fixtureBCitation(page: number | string, label: string): string {
    const data = {
        citationItems: [{
            uris: ['http://zotero.org/users/17517181/items/HPDPU3J5'],
            locator: page,
        }],
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(data))}"><span class="citation-item">${label}</span></span>`;
}

const FIXTURE_B = wrap(
    `<p>The concept of institutional logics ${fixtureBCitation(2, '(Smith, 2022, p. 2)')} `
    + `has been widely studied. Further analysis ${fixtureBCitation(15, '(Smith, 2022, p. 15)')} `
    + `reveals important patterns.</p>`
);

/**
 * Fixture C — Synthetic note with all element types: citations (single + compound),
 * annotations, annotation-images, regular images, table, pre code blocks,
 * blockquote, special characters.
 */
const FIXTURE_C_CIT1 = rawCitation('CKEY1', 1, '', 'Alpha, 2020');
const FIXTURE_C_CIT2 = rawCitation('CKEY2', 1, '42', 'Beta, 2021, p. 42');
const FIXTURE_C_COMPOUND = rawCompoundCitation(['CKEY1', 'CKEY2'], 1, 'Alpha, 2020; Beta, 2021');
const FIXTURE_C_ANNOT = rawAnnotation('ANNOT1', 'This is a highlighted passage from the PDF');
const FIXTURE_C_ANNOT_IMG = rawAnnotationImage('AIMGKEY', 'ATTKEY1');
const FIXTURE_C_IMG = rawImage('IMGKEY1');

const FIXTURE_C = wrap(
    `<h1>Comprehensive Test Note</h1>`
    + `<p>Introduction with a citation ${FIXTURE_C_CIT1} and another ${FIXTURE_C_CIT2}.</p>`
    + `<p>A compound citation: ${FIXTURE_C_COMPOUND}</p>`
    + `<p>An annotation: ${FIXTURE_C_ANNOT}</p>`
    + `<p>${FIXTURE_C_ANNOT_IMG}</p>`
    + `<p>${FIXTURE_C_IMG}</p>`
    + `<table><tr><td>Column A</td><td>Column B</td></tr><tr><td>Data 1</td><td>Data 2</td></tr></table>`
    + `<pre><code>function example() { return 42; }</code></pre>`
    + `<blockquote><p>A quoted passage with special chars: &amp; &lt; &gt; &quot; and unicode: \u00e9\u00e0\u00fc\u00f1</p></blockquote>`
    + `<p>Special characters in text: Smith &amp; Jones (2024) found that x &lt; y when &quot;conditions&quot; are met.</p>`
);


// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();

    // Reset Zotero globals for expansion / rebuild
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
            getByLibraryAndKeyAsync: vi.fn(async (libId: number, key: string) => ({
                key,
                libraryID: libId,
                id: 42,
                getField: vi.fn(() => 'Mock Title'),
                isAttachment: vi.fn(() => false),
                isRegularItem: vi.fn(() => true),
                getAttachments: vi.fn(() => []),
                loadDataType: vi.fn().mockResolvedValue(undefined),
                getNote: vi.fn(() => ''),
                setNote: vi.fn(),
                saveTx: vi.fn().mockResolvedValue(undefined),
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
    invalidateSimplificationCache('fixture-a');
    invalidateSimplificationCache('fixture-b');
    invalidateSimplificationCache('fixture-c');
});


// =============================================================================
// Section 1: Simplification Roundtrip Invariant
//
// Core invariant: simplify → expand('old') ≡ roundtripExpected(original)
// (stripDataCitationItems + stripNoteWrapperDiv, since both are removed
//  during simplification and not restored by expandToRawHtml)
// =============================================================================

describe('simplification roundtrip invariant', () => {
    it('fixture A: simplify → expand produces roundtripExpected(original)', () => {
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_A, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(FIXTURE_A));
    });

    it('fixture B: simplify → expand produces roundtripExpected(original)', () => {
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_B, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(FIXTURE_B));
    });

    it('fixture C (all element types): simplify → expand produces roundtripExpected(original)', () => {
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_C, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(FIXTURE_C));
    });

    it('plain text note: simplify → expand is identity (minus wrapper)', () => {
        const html = wrap('<p>Hello world, this is a plain note.</p><p>No citations here.</p>');
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('note with only headings and formatting: simplify → expand is identity (minus wrapper)', () => {
        const html = wrap(
            '<h1>Main Title</h1>'
            + '<h3>Subsection</h3>'
            + '<p><strong>Bold text</strong> and <em>italic text</em> and <u>underline</u>.</p>'
        );
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });
});


// =============================================================================
// Section 2: Edit + Undo Roundtrip (String Replacement)
//
// Tests: simplify → edit simplified text → expand both old/new → replace in
// stripped HTML → verify undo restores original
// =============================================================================

describe('edit + undo roundtrip', () => {
    /**
     * Simulate the full edit pipeline:
     * 1. Strip data-citation-items from raw HTML
     * 2. Simplify → get simplified + metadata
     * 3. Expand old_string and new_string
     * 4. Replace in stripped HTML
     * 5. Return both old (stripped) and new HTML
     */
    function simulateEdit(rawHtml: string, libraryID: number, oldStr: string, newStr: string, replaceAll = false) {
        const strippedOriginal = stripDataCitationItems(rawHtml);
        const { simplified, metadata } = simplifyNoteHtml(rawHtml, libraryID);
        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        const matchCount = countOccurrences(strippedOriginal, expandedOld);
        if (matchCount === 0) throw new Error('old_string not found');
        if (matchCount > 1 && !replaceAll) throw new Error(`Ambiguous: found ${matchCount} times`);

        let newHtml: string;
        if (replaceAll) {
            newHtml = strippedOriginal.split(expandedOld).join(expandedNew);
        } else {
            const idx = strippedOriginal.indexOf(expandedOld);
            newHtml = strippedOriginal.substring(0, idx) + expandedNew
                + strippedOriginal.substring(idx + expandedOld.length);
        }

        return {
            strippedOriginal,
            newHtml,
            simplified,
            metadata,
            matchCount,
        };
    }

    it('simple text replacement preserves surrounding citations', () => {
        const { strippedOriginal, newHtml } = simulateEdit(
            FIXTURE_A, 1,
            'middle school settings',
            'elementary school settings'
        );

        // Verify the replacement happened
        expect(newHtml).toContain('elementary school settings');
        expect(newHtml).not.toContain('middle school settings');

        // Verify citations are intact (check raw citation spans)
        const citationCount = (newHtml.match(/class="citation"/g) || []).length;
        const originalCitationCount = (strippedOriginal.match(/class="citation"/g) || []).length;
        expect(citationCount).toBe(originalCitationCount);

        // Undo: replacing back should restore original
        const { simplified: newSimplified, metadata: newMetadata } = simplifyNoteHtml(
            wrap(newHtml.replace(/<div data-schema-version="9"[^>]*>/, '').replace(/<\/div>$/, '')),
            1
        );
        // Actually, we can just do a direct string replacement for undo
        const undone = newHtml.replace('elementary school settings', 'middle school settings');
        expect(undone).toBe(strippedOriginal);
    });

    it('replace text between adjacent citations', () => {
        // Fixture A has adjacent citations: p.18 and p.19 with no text between them
        // The paragraph looks like: ...important (Rodriguez, 2023, p. 18)(Rodriguez, 2023, p. 19), with...
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_A, 1);

        // The simplified text should have two adjacent citation tags
        const adjacentMatch = simplified.match(
            /<citation [^/]*ref="[^"]*"\/><citation [^/]*ref="[^"]*"\/>/
        );
        expect(adjacentMatch).toBeTruthy();

        // Now replace text around them — replace "equally important" with "very significant"
        const oldStr = 'equally important';
        const newStr = 'very significant';

        const { strippedOriginal, newHtml } = simulateEdit(FIXTURE_A, 1, oldStr, newStr);
        expect(newHtml).toContain('very significant');

        // Both adjacent citations should still be present
        const cit18 = fixtureACitation('18', '(Rodriguez, 2023, p. 18)');
        const cit19 = fixtureACitation('19', '(Rodriguez, 2023, p. 19)');
        expect(newHtml).toContain(cit18);
        expect(newHtml).toContain(cit19);
    });

    it('delete a paragraph (empty new_string)', () => {
        // Delete the "Key Findings" heading
        const { simplified } = simplifyNoteHtml(FIXTURE_A, 1);
        expect(simplified).toContain('<h4>Key Findings</h4>');

        const { strippedOriginal, newHtml } = simulateEdit(
            FIXTURE_A, 1,
            '<h4>Key Findings</h4>',
            ''
        );

        expect(newHtml).not.toContain('<h4>Key Findings</h4>');
        // The rest of the note should be intact
        expect(newHtml).toContain('<h1>Literature Review');
        expect(newHtml).toContain('<h3>Background</h3>');
        // Citations still present
        expect(newHtml).toContain('class="citation"');
    });

    it('replace text inside a list item with citation', () => {
        const { simplified } = simplifyNoteHtml(FIXTURE_A, 1);

        // Find a list item text in the simplified version
        expect(simplified).toContain('Intervention A: Showed 20% improvement');

        const { strippedOriginal, newHtml } = simulateEdit(
            FIXTURE_A, 1,
            'Showed 20% improvement',
            'Demonstrated 25% improvement'
        );

        expect(newHtml).toContain('Demonstrated 25% improvement');
        // The citation in the list item should still be there
        const citInLi = fixtureACitation('22', '(Rodriguez, 2023, p. 22)');
        expect(newHtml).toContain(citInLi);
    });

    it('replace_all: replace a word that appears multiple times', () => {
        // "improvement" appears in multiple list items
        const { strippedOriginal, newHtml, matchCount } = simulateEdit(
            FIXTURE_A, 1,
            'improvement',
            'gain',
            true
        );

        expect(matchCount).toBeGreaterThanOrEqual(2);
        expect(newHtml).not.toContain('improvement');
        expect(newHtml).toContain('gain');

        // All citations should still be intact
        const citationCount = (newHtml.match(/class="citation"/g) || []).length;
        const originalCitationCount = (strippedOriginal.match(/class="citation"/g) || []).length;
        expect(citationCount).toBe(originalCitationCount);
    });

    it('add new citation alongside existing in new_string', () => {
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_A, 1);

        // Find a citation tag in the simplified text
        const existingTag = simplified.match(/<citation [^/]*ref="c_6QKY56PJ_0"[^/]*\/>/)?.[0];
        expect(existingTag).toBeTruthy();

        // Replace old_string with itself + a new citation
        const oldStr = existingTag!;
        const newStr = `${existingTag} <citation item_id="1-NEWKEY" label="New Ref, 2025"/>`;

        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        // The new citation should have been built
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'NEWKEY' }),
            undefined
        );

        // expandedOld should be raw HTML of existing citation
        expect(expandedOld).toContain('data-citation=');
        // expandedNew should contain both the existing citation and the new one
        expect(expandedNew).toContain(expandedOld);
    });

    it('replace heading text preserves wrapper', () => {
        const { strippedOriginal, newHtml } = simulateEdit(
            FIXTURE_A, 1,
            '<h1>Literature Review: Middle School Interventions</h1>',
            '<h1>Literature Review: Elementary School Programs</h1>'
        );

        expect(newHtml).toContain('data-schema-version="9"');
        expect(newHtml).toContain('<h1>Literature Review: Elementary School Programs</h1>');
    });
});


// =============================================================================
// Section 3: Citation-Specific Roundtrips
// =============================================================================

describe('citation-specific roundtrips', () => {
    it('same item cited 13+ times with different pages each gets unique ref', () => {
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_A, 1);

        // Count unique citation refs for 6QKY56PJ
        const citationRefs = [...metadata.elements.keys()].filter(k => k.startsWith('c_6QKY56PJ_'));
        expect(citationRefs.length).toBeGreaterThanOrEqual(13);

        // Each ref should be unique
        const uniqueRefs = new Set(citationRefs);
        expect(uniqueRefs.size).toBe(citationRefs.length);

        // Each round-trips independently
        for (const ref of citationRefs) {
            const tag = simplified.match(new RegExp(`<citation [^/]*ref="${ref}"[^/]*/>`));
            expect(tag).toBeTruthy();
            const expanded = expandToRawHtml(tag![0], metadata, 'old');
            expect(expanded).toContain('data-citation=');
            expect(expanded).toContain('class="citation"');
        }
    });

    it('adjacent citations (no whitespace) simplify → expand preserves exact HTML', () => {
        // Build two citations right next to each other
        const cit1 = rawCitation('ADJ1', 1, '10', 'Ref A, p. 10');
        const cit2 = rawCitation('ADJ2', 1, '20', 'Ref B, p. 20');
        const html = wrap(`<p>Text ${cit1}${cit2} more text</p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Both citations should be simplified
        expect(simplified).toContain('c_ADJ1_0');
        expect(simplified).toContain('c_ADJ2_0');

        // Full roundtrip
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('citation with numeric locator (integer) round-trips correctly', () => {
        // Fixture B has numeric locators (2 and 15 as integers in JSON).
        // The simplifier coerces them to strings via String().
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_B, 1);

        // Numeric locators should be coerced to strings and appear as page attributes
        expect(simplified).toContain('page="2"');
        expect(simplified).toContain('page="15"');

        // Full roundtrip
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(FIXTURE_B));
    });

    it('citation within bold text: simplify → replace → expand preserves formatting', () => {
        const cit = rawCitation('BOLD1', 1, '', 'Author, 2024');
        const html = wrap(`<p><strong>Important finding ${cit} confirmed</strong></p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Replace text around the citation
        const citTag = simplified.match(/<citation [^/]*\/>/)?.[0];
        expect(citTag).toBeTruthy();
        const oldStr = `Important finding ${citTag} confirmed`;
        const newStr = `Key finding ${citTag} validated`;

        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        // Perform replacement
        const stripped = stripDataCitationItems(html);
        const result = stripped.replace(expandedOld, expandedNew);

        // Verify
        expect(result).toContain('<strong>');
        expect(result).toContain('Key finding');
        expect(result).toContain('validated');
        expect(result).toContain('data-citation=');
    });

    it('moving a citation: old_string has citation, new_string reorders it', () => {
        const cit1 = rawCitation('MOV1', 1, '', 'First, 2020');
        const cit2 = rawCitation('MOV2', 1, '', 'Second, 2021');
        const html = wrap(`<p>See ${cit1} and ${cit2} for details.</p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const tags = [...simplified.matchAll(/<citation [^/]*\/>/g)].map(m => m[0]);
        expect(tags).toHaveLength(2);

        // old_string: "See <cit1> and <cit2>"
        // new_string: "See <cit2> and <cit1>" (reordered)
        const oldStr = `See ${tags[0]} and ${tags[1]}`;
        const newStr = `See ${tags[1]} and ${tags[0]}`;

        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        const stripped = stripDataCitationItems(html);
        const result = stripped.replace(expandedOld, expandedNew);

        // Both citations should still be present
        expect(result).toContain(cit1);
        expect(result).toContain(cit2);
        // Order should be reversed
        const idx1 = result.indexOf(cit1);
        const idx2 = result.indexOf(cit2);
        expect(idx2).toBeLessThan(idx1); // cit2 now comes first
    });

    it('deleting text that contains a citation: rest of note is correct', () => {
        const cit1 = rawCitation('DEL1', 1, '', 'Keep, 2020');
        const cit2 = rawCitation('DEL2', 1, '', 'Remove, 2021');
        const html = wrap(
            `<p>First paragraph with ${cit1} citation.</p>`
            + `<p>Second paragraph with ${cit2} citation.</p>`
        );

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const tags = [...simplified.matchAll(/<citation [^/]*\/>/g)].map(m => m[0]);

        // Delete the second paragraph (which contains cit2)
        const oldStr = `<p>Second paragraph with ${tags[1]} citation.</p>`;
        const newStr = '';

        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        const stripped = stripDataCitationItems(html);
        const result = stripped.replace(expandedOld, expandedNew);

        // First paragraph and its citation should be intact
        expect(result).toContain(cit1);
        expect(result).toContain('First paragraph');
        // Second paragraph and its citation should be gone
        expect(result).not.toContain('Second paragraph');
        expect(result).not.toContain(cit2);
    });
});


// =============================================================================
// Section 4: data-citation-items Pipeline
// =============================================================================

describe('data-citation-items through edit pipeline', () => {
    it('strip before matching, rebuild after replacement', () => {
        const cit = rawCitation('DCI1', 1, '', 'Author, 2024');
        const html = wrap(`<p>Text ${cit} more</p>`, ` data-citation-items="${encodeURIComponent('[]')}"`);

        // Strip → simplify → edit → expand → rebuild
        const stripped = stripDataCitationItems(html);
        expect(stripped).not.toContain('data-citation-items');

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expandedOld = expandToRawHtml('Text', metadata, 'old');
        const expandedNew = expandToRawHtml('Modified text', metadata, 'new');

        let result = stripped.replace(expandedOld, expandedNew);
        result = rebuildDataCitationItems(result);

        expect(result).toContain('data-citation-items=');
        // Should contain valid encoded JSON
        const match = result.match(/data-citation-items="([^"]*)"/);
        expect(match).toBeTruthy();
        expect(() => JSON.parse(decodeURIComponent(match![1]))).not.toThrow();
    });

    it('fixture A: edit preserves data-citation-items with valid JSON', () => {
        const stripped = stripDataCitationItems(FIXTURE_A);
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_A, 1);

        // Make a simple text edit
        const expandedOld = expandToRawHtml('Literature Review', metadata, 'old');
        const expandedNew = expandToRawHtml('Research Summary', metadata, 'new');

        let result = stripped.replace(expandedOld, expandedNew);
        result = rebuildDataCitationItems(result);

        expect(result).toContain('data-citation-items=');
        const match = result.match(/data-citation-items="([^"]*)"/);
        expect(match).toBeTruthy();
        const decoded = JSON.parse(decodeURIComponent(match![1]));
        expect(Array.isArray(decoded)).toBe(true);
        expect(decoded.length).toBeGreaterThan(0);
        // Each entry should have uris and itemData
        for (const entry of decoded) {
            expect(entry.uris).toBeDefined();
            expect(entry.itemData).toBeDefined();
        }
    });

    it('adding a new citation updates data-citation-items', () => {
        const html = wrap('<p>Plain text note</p>');
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        const newStr = 'Plain text note <citation item_id="1-NEWITEM" label="New, 2025"/>';
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        // The expanded result should contain a citation with data-citation
        expect(expandedNew).toContain('data-citation=');

        // Build the full HTML with the new citation
        let result = wrap(`<p>${expandedNew}</p>`);
        result = rebuildDataCitationItems(result);

        expect(result).toContain('data-citation-items=');
        const match = result.match(/data-citation-items="([^"]*)"/);
        expect(match).toBeTruthy();
        const decoded = JSON.parse(decodeURIComponent(match![1]));
        expect(decoded.length).toBe(1);
        expect(decoded[0].uris[0]).toContain('NEWITEM');
    });
});


// =============================================================================
// Section 5: Sequential Edits and Undo
// =============================================================================

describe('sequential edits and undo', () => {
    function simulateEditOnHtml(html: string, oldStr: string, newStr: string, replaceAll = false) {
        const stripped = stripDataCitationItems(html);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        const matchCount = countOccurrences(stripped, expandedOld);
        if (matchCount === 0) throw new Error('old_string not found');

        let result: string;
        if (replaceAll) {
            result = stripped.split(expandedOld).join(expandedNew);
        } else {
            const idx = stripped.indexOf(expandedOld);
            result = stripped.substring(0, idx) + expandedNew
                + stripped.substring(idx + expandedOld.length);
        }

        result = rebuildDataCitationItems(result);
        return { oldHtml: html, newHtml: result };
    }

    it('edit1 → edit2 → undo2 → undo1 = original', () => {
        const original = wrap(
            `<p>First sentence. Second sentence. Third sentence.</p>`
        );

        // Edit 1: Replace "First" with "Modified"
        const edit1 = simulateEditOnHtml(original, 'First sentence', 'Modified sentence');

        // Edit 2: Replace "Second" with "Changed"
        const edit2 = simulateEditOnHtml(edit1.newHtml, 'Second sentence', 'Changed sentence');

        // Undo edit2: restore to edit1 state
        expect(edit1.newHtml).toContain('Modified sentence');
        expect(edit1.newHtml).toContain('Second sentence');

        // Undo edit1: restore to original
        expect(original).toContain('First sentence');
        expect(original).toContain('Second sentence');

        // Verify the chain
        expect(edit2.newHtml).toContain('Modified sentence');
        expect(edit2.newHtml).toContain('Changed sentence');
        expect(edit2.oldHtml).toBe(edit1.newHtml);
        expect(edit1.oldHtml).toBe(original);
    });

    it('edit1 → edit2 → edit3 → undo3 = state after edit2', () => {
        const original = wrap(
            `<p>Apple Banana Cherry</p>`
        );

        const edit1 = simulateEditOnHtml(original, 'Apple', 'Apricot');
        const edit2 = simulateEditOnHtml(edit1.newHtml, 'Banana', 'Blueberry');
        const edit3 = simulateEditOnHtml(edit2.newHtml, 'Cherry', 'Cranberry');

        // After edit3
        expect(edit3.newHtml).toContain('Apricot');
        expect(edit3.newHtml).toContain('Blueberry');
        expect(edit3.newHtml).toContain('Cranberry');

        // Undo edit3 = edit2's result
        expect(edit3.oldHtml).toBe(edit2.newHtml);
        expect(edit2.newHtml).toContain('Apricot');
        expect(edit2.newHtml).toContain('Blueberry');
        expect(edit2.newHtml).not.toContain('Cranberry');
    });

    it('edit text → add citation → undo citation → undo text = original', () => {
        const cit = rawCitation('SEQ1', 1, '', 'Existing, 2020');
        const original = wrap(`<p>Intro text ${cit} and conclusion.</p>`);

        // Edit 1: Replace "Intro text" with "Opening text"
        const edit1 = simulateEditOnHtml(original, 'Intro text', 'Opening text');
        expect(edit1.newHtml).toContain('Opening text');
        expect(edit1.newHtml).toContain('class="citation"');

        // Edit 2: Add a new citation next to "conclusion"
        const { simplified: s2, metadata: m2 } = simplifyNoteHtml(edit1.newHtml, 1);
        const expandedOld2 = expandToRawHtml('and conclusion', m2, 'old');
        const expandedNew2 = expandToRawHtml(
            'and conclusion <citation item_id="1-NEWSEQ" label="New, 2025"/>',
            m2, 'new'
        );
        const stripped2 = stripDataCitationItems(edit1.newHtml);
        let edit2Html = stripped2.replace(expandedOld2, expandedNew2);
        edit2Html = rebuildDataCitationItems(edit2Html);

        // edit2 should have both citations
        expect((edit2Html.match(/class="citation"/g) || []).length).toBe(2);

        // Undo edit2 → back to edit1 state
        // (In real code, oldHtml from edit2's result_data restores edit1 state)
        expect(edit1.newHtml).toContain('Opening text');
        expect((edit1.newHtml.match(/class="citation"/g) || []).length).toBe(1);

        // Undo edit1 → back to original
        const strippedOriginal = stripDataCitationItems(original);
        expect(strippedOriginal).toContain('Intro text');
    });
});


// =============================================================================
// Section 6: executeEditNoteAction + undoEditNoteAction
//
// Tests the actual exported functions from react/utils/editNoteActions.ts
// with mocked Zotero globals.
// =============================================================================

describe('executeEditNoteAction + undoEditNoteAction', () => {
    // We need to import these dynamically after mocks are set up
    // The module imports noteHtmlSimplifier which we're using real implementations of
    // But it also imports logger which we've mocked

    function makeAction(overrides: any = {}): any {
        return {
            id: 'action-1',
            run_id: 'run-1',
            action_type: 'edit_note',
            status: 'pending',
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello',
                new_string: 'Goodbye',
            },
            ...overrides,
        };
    }

    function makeMockItem(noteHtml: string, overrides: any = {}) {
        let currentHtml = noteHtml;
        return {
            key: 'NOTE0001',
            libraryID: 1,
            id: 42,
            loadDataType: vi.fn().mockResolvedValue(undefined),
            getNote: vi.fn(() => currentHtml),
            setNote: vi.fn((html: string) => { currentHtml = html; return true; }),
            saveTx: vi.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    // We'll import the module lazily within tests to ensure mocks are active
    async function importEditNoteActions() {
        return await import('../../../react/utils/editNoteActions');
    }

    function buildSameItemRefShiftScenario() {
        const firstCitation = rawCitation('SAMEKEY', 1, '1', 'Same Item, p. 1');
        const secondCitation = rawCitation('SAMEKEY', 1, '2', 'Same Item, p. 2');
        const originalHtml = wrap(
            `<p>Lead ${firstCitation}</p>`
            + `<p>Target text ${secondCitation} end.</p>`
        );

        const { simplified } = simplifyNoteHtml(originalHtml, 1);
        const targetCitationTag = simplified.match(/<citation [^>]*ref="c_SAMEKEY_1"[^>]*\/>/)?.[0];
        if (!targetCitationTag) {
            throw new Error('Expected second SAMEKEY citation to simplify to ref c_SAMEKEY_1');
        }

        return {
            originalHtml,
            action: makeAction({
                proposed_data: {
                    library_id: 1,
                    zotero_key: 'NOTE0001',
                    old_string: `Target text ${targetCitationTag} end.`,
                    new_string:
                        `Target text <citation item_id="1-SAMEKEY" page="9" label="Inserted, 2024"/> `
                        + `${targetCitationTag} end.`,
                },
            }),
        };
    }

    async function applySameItemRefShiftEdit() {
        const scenario = buildSameItemRefShiftScenario();
        const item = makeMockItem(scenario.originalHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction } = await importEditNoteActions();
        const result = await executeEditNoteAction(scenario.action);
        const editedHtml = item.setNote.mock.calls[0][0];

        return { ...scenario, result, editedHtml };
    }

    it('successful execute returns correct result_data', async () => {
        const noteHtml = wrap('<p>Hello world</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction } = await importEditNoteActions();
        const result = await executeEditNoteAction(makeAction());

        expect(result.library_id).toBe(1);
        expect(result.zotero_key).toBe('NOTE0001');
        expect(result.occurrences_replaced).toBe(1);
        expect(result.undo_old_html).toBe('Hello');
        expect(result.undo_new_html).toBe('Goodbye');
        // Result should not contain full-note HTML snapshots
        expect(result).not.toHaveProperty('old_html');
        expect(result).not.toHaveProperty('new_html');
    });

    it('undo via reverse str-replace restores note', async () => {
        const editedHtml = wrap('<p>Goodbye world</p>');
        const item = makeMockItem(editedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                occurrences_replaced: 1,
            },
        });

        await undoEditNoteAction(action);

        // Should reverse the replacement: Goodbye → Hello
        const savedHtml = item.setNote.mock.calls[0][0];
        expect(savedHtml).toContain('Hello');
        expect(savedHtml).not.toContain('Goodbye');
        expect(item.saveTx).toHaveBeenCalled();
    });

    it('undo is no-op when old_string already present (already undone)', async () => {
        // Note already has old_string, meaning it was already undone
        const noteHtml = wrap('<p>Hello world</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                occurrences_replaced: 1,
            },
        });

        // Should not throw, just skip
        await undoEditNoteAction(action);
        expect(item.setNote).not.toHaveBeenCalled();
    });

    it('undo throws when note was modified externally', async () => {
        // Note has neither old_string nor new_string
        const noteHtml = wrap('<p>Completely different content</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                occurrences_replaced: 1,
            },
        });

        await expect(undoEditNoteAction(action)).rejects.toThrow('note has been modified');
    });

    it('undo prefers stored applied HTML over proposed_data when they diverge', async () => {
        const editedHtml = wrap('<p>Goodbye world</p>');
        const item = makeMockItem(editedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello',
                new_string: 'Goodbye with typo',
            },
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                occurrences_replaced: 1,
                undo_old_html: 'Hello',
                undo_new_html: 'Goodbye',
            },
        });

        await undoEditNoteAction(action);

        const savedHtml = item.setNote.mock.calls[0][0];
        expect(savedHtml).toContain('Hello world');
        expect(savedHtml).not.toContain('Goodbye world');
    });

    it('undo fails gracefully when proposed_data strings missing', async () => {
        const { undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '',
                new_string: '',
            },
            result_data: undefined,
        });

        await expect(undoEditNoteAction(action)).rejects.toThrow('No undo data available: proposed_data.old_string is required');
    });

    it('execute throws for item not found', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);

        const { executeEditNoteAction } = await importEditNoteActions();
        await expect(executeEditNoteAction(makeAction())).rejects.toThrow('Item not found');
    });

    it('execute throws for zero matches (with fuzzy hint if available)', async () => {
        const noteHtml = wrap('<p>Different content entirely</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction } = await importEditNoteActions();
        await expect(executeEditNoteAction(makeAction())).rejects.toThrow('not found');
    });

    it('execute throws for ambiguous match without replace_all', async () => {
        const noteHtml = wrap('<p>Hello Hello Hello</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction } = await importEditNoteActions();
        await expect(executeEditNoteAction(makeAction())).rejects.toThrow(/found 3 times/);
    });

    it('execute with replace_all succeeds for multiple matches', async () => {
        const noteHtml = wrap('<p>Hello Hello Hello</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction } = await importEditNoteActions();
        const result = await executeEditNoteAction(makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello',
                new_string: 'Goodbye',
                replace_all: true,
            },
        }));

        expect(result.occurrences_replaced).toBe(3);
        // Verify the edit was applied by checking what was saved
        const savedHtml = item.setNote.mock.calls[0][0];
        expect(savedHtml).toContain('Goodbye Goodbye Goodbye');
    });

    it('execute rolls back in-memory on save failure', async () => {
        const noteHtml = wrap('<p>Hello world</p>');
        const item = makeMockItem(noteHtml, {
            saveTx: vi.fn().mockRejectedValue(new Error('DB write failed')),
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction } = await importEditNoteActions();
        await expect(executeEditNoteAction(makeAction())).rejects.toThrow('Failed to save note');

        // setNote called twice: once with new HTML, once with rollback
        expect(item.setNote).toHaveBeenCalledTimes(2);
        // Last call should be rollback with original HTML
        expect(item.setNote.mock.calls[1][0]).toBe(noteHtml);
    });

    it('full apply → undo cycle with real fixture HTML', async () => {
        const noteHtml = FIXTURE_A;
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction, undoEditNoteAction } = await importEditNoteActions();

        // Execute: replace "middle school" with "elementary school"
        const action = makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'middle school settings',
                new_string: 'elementary school settings',
            },
        });

        const result = await executeEditNoteAction(action);

        // Verify the edit
        expect(result.occurrences_replaced).toBe(1);
        const editedHtml = item.setNote.mock.calls[0][0];
        expect(editedHtml).toContain('elementary school settings');
        expect(item.saveTx).toHaveBeenCalled();

        // Now undo — create a new mock item with the edited HTML
        vi.clearAllMocks();
        const undoItem = makeMockItem(editedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(undoItem);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const undoAction = {
            ...action,
            result_data: result,
        };

        await undoEditNoteAction(undoAction);

        // Verify the undo reversed the replacement
        const restoredHtml = undoItem.setNote.mock.calls[0][0];
        expect(restoredHtml).toContain('middle school settings');
        expect(restoredHtml).not.toContain('elementary school settings');
        expect(undoItem.saveTx).toHaveBeenCalled();
    });

    it('legacy undo path fails when same-item citation refs shift after apply', async () => {
        const { action, editedHtml } = await applySameItemRefShiftEdit();
        const { simplified: editedSimplified } = simplifyNoteHtml(editedHtml, 1);

        const shiftedRefs = [...editedSimplified.matchAll(
            /<citation [^>]*item_id="1-SAMEKEY"[^>]*page="([^"]*)"[^>]*ref="([^"]+)"[^>]*\/>/g
        )].map(match => ({ page: match[1], ref: match[2] }));

        expect(shiftedRefs).toEqual([
            { page: '1', ref: 'c_SAMEKEY_0' },
            { page: '9', ref: 'c_SAMEKEY_1' },
            { page: '2', ref: 'c_SAMEKEY_2' },
        ]);

        vi.clearAllMocks();
        const undoItem = makeMockItem(editedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(undoItem);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { undoEditNoteAction } = await importEditNoteActions();
        await expect(undoEditNoteAction({
            ...action,
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                occurrences_replaced: 1,
            },
        })).rejects.toThrow('note has been modified');
    });

    it('full apply → undo cycle succeeds when same-item citation refs shift after apply', async () => {
        const { action, originalHtml, result, editedHtml } = await applySameItemRefShiftEdit();

        vi.clearAllMocks();
        const undoItem = makeMockItem(editedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(undoItem);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { undoEditNoteAction } = await importEditNoteActions();
        await undoEditNoteAction({
            ...action,
            result_data: result,
        });

        const restoredHtml = undoItem.setNote.mock.calls[0][0];
        expect(stripDataCitationItems(restoredHtml)).toBe(stripDataCitationItems(originalHtml));
        expect((restoredHtml.match(/class="citation"/g) || []).length).toBe(2);
        expect(undoItem.saveTx).toHaveBeenCalled();
    });

    it('undo succeeds when saved note strips inline itemData from new citations', async () => {
        const noteHtml = wrap('<p>Hello world</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction, undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello world',
                new_string: 'Hello world <citation item_id="1-NEW1" page="4" label="Mock Title, p. 4"/>',
            },
        });

        const result = await executeEditNoteAction(action);
        expect(result.undo_new_html).not.toContain('itemData');

        const editedHtml = item.setNote.mock.calls[0][0];
        const normalizedEditedHtml = stripInlineItemDataFromDataCitationsForTest(editedHtml);

        vi.clearAllMocks();
        const undoItem = makeMockItem(normalizedEditedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(undoItem);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        await undoEditNoteAction({
            ...action,
            result_data: result,
        });

        const restoredHtml = undoItem.setNote.mock.calls[0][0];
        expect(stripDataCitationItems(restoredHtml)).toBe(stripDataCitationItems(noteHtml));
        expect(undoItem.saveTx).toHaveBeenCalled();
    });

    it('undo falls back to semantic match when citation payloads are normalized differently', async () => {
        const noteHtml = wrap('<p>Original sentence.</p>');
        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction, undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Original sentence.',
                new_string: 'Revised sentence with support <citation item_id="1-NEW1" page="4" label="Mock Title, p. 4"/>.',
            },
        });

        const result = await executeEditNoteAction(action);
        const editedHtml = item.setNote.mock.calls[0][0];
        const normalizedEditedHtml = addInlineItemDataToDataCitationsForTest(editedHtml);

        vi.clearAllMocks();
        const undoItem = makeMockItem(normalizedEditedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(undoItem);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const legacyLikeResult = {
            ...result,
            undo_before_context: undefined,
            undo_after_context: undefined,
        };

        await undoEditNoteAction({
            ...action,
            result_data: legacyLikeResult,
        });

        const restoredHtml = undoItem.setNote.mock.calls[0][0];
        expect(stripDataCitationItems(restoredHtml)).toBe(stripDataCitationItems(noteHtml));
        expect(undoItem.saveTx).toHaveBeenCalled();
    });

    it('undo tries multiple raw anchor candidates for legacy multi-paragraph edits without stored context', async () => {
        const sharedLead = '<strong>Legewie, Farley, and Stewart (2019)</strong> provide a policy-focused '
            + 'research brief that extends the findings from Legewie and Fagan\'s (2018) study on '
            + 'Operation Impact. Their analysis draws on the same staggered implementation of police '
            + 'surges in impact zones but emphasizes practical implications for educators and policymakers. ';
        const decoyParagraph = `<p>${sharedLead}This earlier paragraph is a decoy with a different ending.</p>`;
        const noteHtml = wrap(
            `${decoyParagraph}`
            + `<p><strong>Góldenberg</strong> has a related paper exploring the same NYC police surge policy `
            + `and its academic impacts on students in affected neighborhoods. `
            + `${rawCitation('OLD1', 1, '5', 'Mock Title, p. 5')}</p>`
            + '<p>Trailing material that should remain unchanged.</p>'
        );

        const { simplified } = simplifyNoteHtml(noteHtml, 1);
        const oldCitationTag = simplified.match(/<citation [^>]*ref="c_OLD1_0"[^>]*\/>/)?.[0];
        expect(oldCitationTag).toBeTruthy();

        const item = makeMockItem(noteHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const { executeEditNoteAction, undoEditNoteAction } = await importEditNoteActions();
        const action = makeAction({
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string:
                    `<p><strong>Góldenberg</strong> has a related paper exploring the same NYC police surge `
                    + `policy and its academic impacts on students in affected neighborhoods. `
                    + `${oldCitationTag}</p>`,
                new_string:
                    `<p>${sharedLead}The brief documents that Black, Latino, and White students were `
                    + `exposed to Operation Impact at very different rates <citation item_id="1-OLD1" `
                    + `page="3" label="Mock Title, p. 3"/>.</p>\n\n`
                    + '<p>The brief also argues that the modest crime reduction did not offset the '
                    + 'educational harms and recommends restorative rather than punitive approaches to '
                    + 'discipline <citation item_id="1-OLD1" page="7-8" '
                    + 'label="Mock Title, p. 7-8"/>.</p>',
            },
        });

        const result = await executeEditNoteAction(action);
        const editedHtml = item.setNote.mock.calls[0][0];
        const normalizedEditedHtml = addInlineItemDataToDataCitationsForTest(editedHtml);

        vi.clearAllMocks();
        const undoItem = makeMockItem(normalizedEditedHtml);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(undoItem);
        (globalThis as any).Zotero.Notes._editorInstances = [];

        const legacyLikeResult = {
            ...result,
            undo_before_context: undefined,
            undo_after_context: undefined,
        };

        await undoEditNoteAction({
            ...action,
            result_data: legacyLikeResult,
        });

        const restoredHtml = undoItem.setNote.mock.calls[0][0];
        expect(stripDataCitationItems(restoredHtml)).toBe(stripDataCitationItems(noteHtml));
        expect(undoItem.saveTx).toHaveBeenCalled();
    });
});


// =============================================================================
// Section 7: Edge Cases
// =============================================================================

describe('edge cases', () => {
    it('special characters in text near citations survive roundtrip', () => {
        const cit = rawCitation('SPEC1', 1, '', 'Author, 2024');
        const html = wrap(
            `<p>Smith &amp; Jones (2024) found ${cit} that x &lt; y when &quot;conditions&quot; are met.</p>`
        );

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('empty note body (just wrapper div)', () => {
        const html = wrap('');
        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toBe('');
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe('');
    });

    it('note with only citations (no plain text) round-trips each', () => {
        const cit1 = rawCitation('ONLY1', 1, '', 'A, 2020');
        const cit2 = rawCitation('ONLY2', 1, '', 'B, 2021');
        const cit3 = rawCitation('ONLY3', 1, '', 'C, 2022');
        const html = wrap(`<p>${cit1}${cit2}${cit3}</p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // All 3 citations should be simplified
        expect(metadata.elements.size).toBe(3);

        // Full roundtrip
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('very long note with many citations: correctness maintained', () => {
        // Build a note with 50 paragraphs, each with a citation
        let inner = '<h1>Long Note</h1>';
        for (let i = 0; i < 50; i++) {
            const cit = rawCitation(`LONG${i}`, 1, String(i + 1), `Author ${i}, 2024, p. ${i + 1}`);
            inner += `<p>Paragraph ${i} with content about topic ${i}. ${cit}</p>`;
        }
        const html = wrap(inner);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(metadata.elements.size).toBe(50);

        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('locator with special characters: page range, section symbol, footnote', () => {
        const cit1 = rawCitation('LOC1', 1, '10-12', 'Ref, pp. 10-12');
        const cit2 = rawCitation('LOC2', 1, '§3.2', 'Ref, §3.2');
        const cit3 = rawCitation('LOC3', 1, 'fn. 5', 'Ref, fn. 5');
        const html = wrap(`<p>${cit1} ${cit2} ${cit3}</p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        expect(simplified).toContain('page="10-12"');
        expect(simplified).toContain('page="§3.2"');
        expect(simplified).toContain('page="fn. 5"');

        // Full roundtrip
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('citation label with quotes and ampersands: attribute escaping roundtrips', () => {
        const label = 'Smith &amp; Jones, 2024';
        const cit = rawCitation('ESCLBL', 1, '', label);
        const html = wrap(`<p>${cit}</p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // The label should be escaped in the attribute
        expect(simplified).toContain('label="Smith &amp;amp; Jones, 2024"');

        // Full roundtrip
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('note with table, code block, blockquote: structure preserved in roundtrip', () => {
        const html = wrap(
            '<table><tr><td>A</td><td>B</td></tr></table>'
            + '<pre><code>const x = 42;</code></pre>'
            + '<blockquote><p>A famous quote</p></blockquote>'
        );

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('unicode characters in note text survive roundtrip', () => {
        const cit = rawCitation('UNI1', 1, '', 'Müller, 2024');
        const html = wrap(
            `<p>Résumé of the étude by ${cit} on naïve Bayesian methods (über-analysis).</p>`
        );

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('Résumé');
        expect(simplified).toContain('étude');
        expect(simplified).toContain('naïve');
        expect(simplified).toContain('über-analysis');

        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('annotation + citation in same paragraph roundtrip', () => {
        const ann = rawAnnotation('MIX_ANN', 'highlighted text');
        const cit = rawCitation('MIX_CIT', 1, '', 'Author, 2024');
        const html = wrap(`<p>${ann} supports the claim ${cit}.</p>`);

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        expect(simplified).toContain('<annotation ');
        expect(simplified).toContain('<citation ');

        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(html));
    });

    it('annotation-image + regular image + citation in same note roundtrip', () => {
        const { simplified, metadata } = simplifyNoteHtml(FIXTURE_C, 1);

        // Check all element types were simplified
        expect(simplified).toContain('<citation ');
        expect(simplified).toContain('<annotation ');
        expect(simplified).toContain('<annotation-image ');
        expect(simplified).toContain('<image ');

        // Count elements
        const citationCount = (simplified.match(/<citation /g) || []).length;
        expect(citationCount).toBe(3); // 2 single + 1 compound

        // Full roundtrip
        const expanded = expandToRawHtml(simplified, metadata, 'old');
        expect(expanded).toBe(roundtripExpected(FIXTURE_C));
    });

    it('replacing text does not affect unrelated paragraphs', () => {
        const cit1 = rawCitation('ISO1', 1, '', 'First, 2020');
        const cit2 = rawCitation('ISO2', 1, '', 'Second, 2021');
        const html = wrap(
            `<p>First paragraph ${cit1} here.</p>`
            + `<p>Second paragraph ${cit2} here.</p>`
            + `<p>Third paragraph with no citations.</p>`
        );

        const { simplified, metadata } = simplifyNoteHtml(html, 1);
        const expandedOld = expandToRawHtml('First paragraph', metadata, 'old');
        const expandedNew = expandToRawHtml('Modified paragraph', metadata, 'new');

        const stripped = stripDataCitationItems(html);
        const result = stripped.replace(expandedOld, expandedNew);

        // Second and third paragraphs should be completely untouched
        expect(result).toContain(`<p>Second paragraph ${cit2} here.</p>`);
        expect(result).toContain('<p>Third paragraph with no citations.</p>');
    });
});


// =============================================================================
// Section 7: Page Locator Normalization
// =============================================================================

describe('normalizePageLocator', () => {
    it('single page number passes through unchanged', () => {
        expect(normalizePageLocator('42')).toBe('42');
    });

    it('page range extracts first page', () => {
        expect(normalizePageLocator('241-243')).toBe('241');
    });

    it('en-dash range extracts first page', () => {
        expect(normalizePageLocator('241–243')).toBe('241');
    });

    it('comma-separated pages extracts first page', () => {
        expect(normalizePageLocator('222, 237-238')).toBe('222');
    });

    it('comma-separated single pages extracts first', () => {
        expect(normalizePageLocator('10, 15, 20')).toBe('10');
    });

    it('non-numeric locator without separators passes through', () => {
        expect(normalizePageLocator('§3.2')).toBe('§3.2');
        expect(normalizePageLocator('fn. 5')).toBe('fn. 5');
        expect(normalizePageLocator('xii')).toBe('xii');
    });

    it('non-numeric locator with dash passes through (no leading digits)', () => {
        // "xii-xv" has a dash but no leading digits → pass through
        expect(normalizePageLocator('xii-xv')).toBe('xii-xv');
    });

    it('leading whitespace is handled', () => {
        expect(normalizePageLocator(' 42-45')).toBe('42');
    });

    it('empty string passes through', () => {
        expect(normalizePageLocator('')).toBe('');
    });
});


describe('page locator normalization in citation expansion', () => {
    it('new citation with page range: locator is normalized to first page', () => {
        const html = wrap(`<p>Some text ${rawCitation('EX1', 1, '10', 'Author, 2024, p. 10')}</p>`);
        const { metadata } = simplifyNoteHtml(html, 1);

        // Insert a new citation (no ref) with a page range
        const input = '<citation item_id="1-NEWITEM" page="222, 237-238"/>';
        const expanded = expandToRawHtml(input, metadata, 'new');

        // createCitationHTML should have been called with the normalized single page
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'NEWITEM' }),
            '222'
        );
        expect(expanded).toContain('data-citation=');
    });

    it('new citation with en-dash range: locator is normalized to first page', () => {
        const html = wrap(`<p>Text ${rawCitation('EX1', 1, '', 'Author, 2024')}</p>`);
        const { metadata } = simplifyNoteHtml(html, 1);

        const input = '<citation item_id="1-RANGEITEM" page="100–105"/>';
        expandToRawHtml(input, metadata, 'new');

        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'RANGEITEM' }),
            '100'
        );
    });

    it('new citation with single page: locator passes through unchanged', () => {
        const html = wrap(`<p>Text ${rawCitation('EX1', 1, '', 'Author, 2024')}</p>`);
        const { metadata } = simplifyNoteHtml(html, 1);

        const input = '<citation item_id="1-SINGLEITEM" page="42"/>';
        expandToRawHtml(input, metadata, 'new');

        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'SINGLEITEM' }),
            '42'
        );
    });

    it('new citation with non-numeric locator: passes through unchanged', () => {
        const html = wrap(`<p>Text ${rawCitation('EX1', 1, '', 'Author, 2024')}</p>`);
        const { metadata } = simplifyNoteHtml(html, 1);

        const input = '<citation item_id="1-SECITEM" page="§3.2"/>';
        expandToRawHtml(input, metadata, 'new');

        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'SECITEM' }),
            '§3.2'
        );
    });

    it('existing citation with changed page range: normalized to first page', () => {
        // Citation originally has page="10"
        const cit = rawCitation('PGCHG', 1, '10', 'Author, 2024, p. 10');
        const html = wrap(`<p>Text ${cit}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // LLM changes page to a range
        const tag = simplified.match(/<citation [^/]*ref="c_PGCHG_0"[^/]*\/>/)?.[0];
        expect(tag).toBeTruthy();
        const modified = tag!.replace('page="10"', 'page="10, 15-18"');
        const expanded = expandToRawHtml(modified, metadata, 'new');

        // Should have been called with normalized page
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'PGCHG' }),
            '10'
        );
        expect(expanded).toContain('data-citation=');
    });

    it('existing citation with unchanged page: returns stored raw HTML (no normalization)', () => {
        const cit = rawCitation('UNCHG', 1, '42', 'Author, 2024, p. 42');
        const html = wrap(`<p>Text ${cit}</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        // Expand with the same page — should return original raw HTML
        const tag = simplified.match(/<citation [^/]*ref="c_UNCHG_0"[^/]*\/>/)?.[0];
        expect(tag).toBeTruthy();
        const expanded = expandToRawHtml(tag!, metadata, 'old');

        // Should return stored raw HTML, not call createCitationHTML
        expect(expanded).toBe(cit);
    });

    it('edit + undo roundtrip: new citation with page range normalizes then undoes correctly', () => {
        const existingCit = rawCitation('EXIST', 1, '', 'Author, 2024');
        const html = wrap(`<p>Text ${existingCit} here.</p>`);
        const { simplified, metadata } = simplifyNoteHtml(html, 1);

        const existingTag = simplified.match(/<citation [^/]*ref="c_EXIST_0"[^/]*\/>/)?.[0];
        expect(existingTag).toBeTruthy();

        // old_string: just the existing citation
        // new_string: existing citation + new citation with page range
        const oldStr = existingTag!;
        const newStr = `${existingTag} <citation item_id="1-NEWCIT" page="50-55"/>`;

        const expandedOld = expandToRawHtml(oldStr, metadata, 'old');
        const expandedNew = expandToRawHtml(newStr, metadata, 'new');

        // Verify normalization happened
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'NEWCIT' }),
            '50' // normalized from "50-55"
        );

        // Apply the edit
        const stripped = stripDataCitationItems(html);
        const edited = stripped.replace(expandedOld, expandedNew);
        expect(edited).toContain('class="citation"');

        // Undo: replacing expandedNew with expandedOld should restore original
        const undone = edited.replace(expandedNew, expandedOld);
        expect(undone).toBe(stripped);
    });

    it('new citation via att_id with page range: normalized to first page', () => {
        const html = wrap(`<p>Text ${rawCitation('EX1', 1, '', 'Author, 2024')}</p>`);
        const { metadata } = simplifyNoteHtml(html, 1);

        // Mock the item as an attachment
        const mockAttItem = {
            id: 'att-123',
            key: 'ATTKEY',
            libraryID: 1,
            isAttachment: vi.fn(() => true),
            isRegularItem: vi.fn(() => false),
            parentID: 999,
            getField: vi.fn(() => ''),
        };
        const mockParentItem = {
            id: 999,
            key: 'PARENTKEY',
            libraryID: 1,
            isAttachment: vi.fn(() => false),
            isRegularItem: vi.fn(() => true),
            getField: vi.fn(() => 'Parent Title'),
            getAttachments: vi.fn(() => []),
        };
        (Zotero.Items.getByLibraryAndKey as any).mockImplementation(
            (libId: number, key: string) => {
                if (key === 'ATTKEY') return mockAttItem;
                if (key === 'PARENTKEY') return mockParentItem;
                return {
                    id: `${libId}-${key}`,
                    key,
                    libraryID: libId,
                    getField: vi.fn(() => 'Mock Title'),
                    isAttachment: vi.fn(() => false),
                    isRegularItem: vi.fn(() => true),
                    getAttachments: vi.fn(() => []),
                };
            }
        );

        const input = '<citation att_id="1-ATTKEY" page="30-35"/>';
        expandToRawHtml(input, metadata, 'new');

        // createCitationHTML should have been called with normalized page
        expect(createCitationHTML).toHaveBeenCalledWith(
            mockAttItem,
            '30' // normalized from "30-35"
        );
    });
});
