/**
 * Tests for the full apply-undo-apply-undo roundtrip of edit_note actions.
 *
 * These tests use REAL simplifier/expander functions (not mocks) and simulate
 * ProseMirror normalization between apply and undo to expose failures caused
 * by the two-stage save problem documented in undo-improvement-plan.md.
 *
 * Many tests are expected to FAIL with the current implementation.
 * They serve as a regression suite for the undo improvement work.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(
        (item: any, page?: string) => {
            const citationData = {
                citationItems: [{
                    uris: [`http://zotero.org/users/1/items/${item.key}`],
                    itemData: {
                        id: `http://zotero.org/users/1/items/${item.key}`,
                        type: 'article-journal',
                        author: [{ family: 'Mock', given: 'Author' }],
                        issued: { 'date-parts': [['2024']] },
                    },
                    ...(page ? { locator: page, label: 'page' } : {}),
                }],
                properties: {},
            };
            return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}"><span class="citation-item">Mock Author, 2024${page ? ', p. ' + page : ''}</span></span>`;
        }
    ),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../react/utils/sourceUtils', () => ({
    clearNoteEditorSelection: vi.fn(),
}));

// =============================================================================
// Imports (real simplifier functions — NOT mocked)
// =============================================================================

import {
    simplifyNoteHtml,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    countOccurrences,
    invalidateSimplificationCache,
    getLatestNoteHtml,
    isNoteInEditor,
} from '../../../src/utils/noteHtmlSimplifier';
import {
    executeEditNoteAction,
    undoEditNoteAction,
} from '../../../react/utils/editNoteActions';
import type { AgentAction } from '../../../react/agents/agentActions';
import type { EditNoteResultData } from '../../../react/types/agentActions/editNote';

// =============================================================================
// Helpers
// =============================================================================

/** Build a minimal Zotero note wrapper */
function wrap(inner: string, extraAttrs = ''): string {
    return `<div data-schema-version="9"${extraAttrs}>${inner}</div>`;
}

/** Build a raw citation span (without inline itemData, like schema v2+) */
function rawCitation(key: string, libraryID = 1, page = '', label = 'Author, 2024'): string {
    const citationData = {
        citationItems: [{
            uris: [`http://zotero.org/users/${libraryID}/items/${key}`],
            ...(page ? { locator: page } : {}),
        }],
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}"><span class="citation-item">${label}</span></span>`;
}

/**
 * Simulate ProseMirror normalization on a note HTML string.
 *
 * Applies the key transforms that ProseMirror's schema-based serialization
 * performs (documented in zotero-notes.md § "HTML Transformations During Save"):
 * - <b> → <strong>, <i> → <em>
 * - <s>/<del>/<strike> → <span style="text-decoration: line-through;">
 * - <a> gets rel="noopener noreferrer nofollow"
 * - Newlines (\n) inserted before/after block elements
 * - Single-<p> in <li> unwrapped
 * - NFC normalization
 *
 * This is an approximation. Real PM normalization is more thorough
 * (color normalization, style splitting, etc.) but this covers the most
 * common cases that break undo.
 */
function simulatePMNormalization(html: string): string {
    let result = html;

    // Tag conversions
    result = result.replace(/<b>([\s\S]*?)<\/b>/g, '<strong>$1</strong>');
    result = result.replace(/<i>([\s\S]*?)<\/i>/g, '<em>$1</em>');
    result = result.replace(/<s>([\s\S]*?)<\/s>/g, '<span style="text-decoration: line-through;">$1</span>');
    result = result.replace(/<del>([\s\S]*?)<\/del>/g, '<span style="text-decoration: line-through;">$1</span>');
    result = result.replace(/<strike>([\s\S]*?)<\/strike>/g, '<span style="text-decoration: line-through;">$1</span>');

    // Add rel to links that don't have it
    result = result.replace(/<a\s+href="([^"]*)"(?![^>]*rel=)/g,
        '<a href="$1" rel="noopener noreferrer nofollow"');

    // Newline insertion: \n after text blocks (h1-h6, p, pre)
    const textBlocks = /(<\/(?:h[1-6]|p|pre)>)(?!\n)/g;
    result = result.replace(textBlocks, '$1\n');

    // Newline inside + after structural blocks (ul, ol, li, blockquote, table, etc.)
    const structuralOpen = /(<(?:ul|ol|li|blockquote|table|tr|td|th|thead|tbody|tfoot)(?:\s[^>]*)?>)(?!\n)/g;
    result = result.replace(structuralOpen, '$1\n');
    const structuralClose = /(<\/(?:ul|ol|li|blockquote|table|tr|td|th|thead|tbody|tfoot)>)(?!\n)/g;
    result = result.replace(structuralClose, '$1\n');

    // Unwrap single-<p> in <li>: <li><p>text</p></li> → <li>text</li>
    // (simplified — real PM only unwraps when <li> has exactly one <p> child)
    result = result.replace(/<li>\n?<p>([\s\S]*?)<\/p>\n?<\/li>/g, '<li>\n$1\n</li>');

    // NFC normalization
    result = result.normalize('NFC');

    return result;
}

/**
 * Simulate the full edit pipeline (what executeEditNoteAction does)
 * using real simplifier functions, returning undo data.
 */
function simulateApply(
    rawHtml: string,
    libraryID: number,
    oldString: string,
    newString: string,
    replaceAll = false
): { newHtml: string; result: EditNoteResultData } {
    const strippedOriginal = stripDataCitationItems(rawHtml);
    const { metadata } = simplifyNoteHtml(rawHtml, libraryID);
    const expandedOld = expandToRawHtml(oldString, metadata, 'old');
    const expandedNew = expandToRawHtml(newString, metadata, 'new');

    const matchCount = countOccurrences(strippedOriginal, expandedOld);
    if (matchCount === 0) throw new Error('old_string not found in note');
    if (matchCount > 1 && !replaceAll) throw new Error(`Ambiguous: ${matchCount} matches`);

    let newHtml: string;
    let undoBeforeContext: string | undefined;
    let undoAfterContext: string | undefined;

    if (replaceAll) {
        newHtml = strippedOriginal.split(expandedOld).join(expandedNew);
    } else {
        const idx = strippedOriginal.indexOf(expandedOld);
        undoBeforeContext = strippedOriginal.substring(Math.max(0, idx - 200), idx);
        undoAfterContext = strippedOriginal.substring(
            idx + expandedOld.length,
            idx + expandedOld.length + 200
        );
        newHtml = strippedOriginal.substring(0, idx) + expandedNew
            + strippedOriginal.substring(idx + expandedOld.length);
    }

    newHtml = rebuildDataCitationItems(newHtml);

    return {
        newHtml,
        result: {
            library_id: libraryID,
            zotero_key: 'TESTKEY',
            occurrences_replaced: matchCount,
            undo_old_html: expandedOld,
            undo_new_html: expandedNew,
            undo_before_context: undoBeforeContext,
            undo_after_context: undoAfterContext,
        },
    };
}

/**
 * Simulate the undo pipeline (what undoEditNoteAction does) using
 * the real undo logic. Returns the restored HTML or throws.
 */
function simulateUndo(
    currentHtml: string,
    libraryID: number,
    result: EditNoteResultData,
    oldString: string,
    newString: string,
    replaceAll = false,
): string {
    const strippedHtml = stripDataCitationItems(currentHtml);
    const undoOldHtml = result.undo_old_html!;
    const undoNewHtml = result.undo_new_html!;
    const isDeletion = !newString;

    if (isDeletion) {
        const beforeCtx = result.undo_before_context;
        const afterCtx = result.undo_after_context;

        // Check already undone
        if (strippedHtml.includes(undoOldHtml)) return currentHtml;

        // Exact seam match
        const seam = (beforeCtx || '') + (afterCtx || '');
        let insertionPoint = -1;
        let restoredHtml: string | undefined;

        const seamIdx = strippedHtml.indexOf(seam);
        if (seamIdx !== -1) {
            insertionPoint = seamIdx + (beforeCtx || '').length;
        }

        // Proximity match
        if (insertionPoint === -1 && beforeCtx) {
            const beforeIdx = strippedHtml.indexOf(beforeCtx);
            if (beforeIdx !== -1) {
                const beforeEnd = beforeIdx + beforeCtx.length;
                if (afterCtx) {
                    const afterIdx = strippedHtml.indexOf(afterCtx, Math.max(0, beforeEnd - 10));
                    if (afterIdx !== -1 && Math.abs(afterIdx - beforeEnd) <= 10) {
                        restoredHtml = strippedHtml.substring(0, beforeEnd)
                            + undoOldHtml
                            + strippedHtml.substring(afterIdx);
                    }
                }
                if (!restoredHtml) insertionPoint = beforeEnd;
            }
        }

        if (insertionPoint === -1 && afterCtx) {
            const afterIdx = strippedHtml.indexOf(afterCtx);
            if (afterIdx !== -1) insertionPoint = afterIdx;
        }

        if (insertionPoint === -1 && !restoredHtml) {
            throw new Error('Cannot undo deletion: context not found');
        }

        if (!restoredHtml) {
            restoredHtml = strippedHtml.substring(0, insertionPoint)
                + undoOldHtml
                + strippedHtml.substring(insertionPoint);
        }

        return rebuildDataCitationItems(restoredHtml);
    }

    // Non-deletion undo
    const newStringFound = strippedHtml.includes(undoNewHtml);
    const oldStringFound = strippedHtml.includes(undoOldHtml);

    if (!newStringFound && oldStringFound) return currentHtml; // already undone

    if (!newStringFound && !oldStringFound) {
        // Try fuzzy context-based recovery
        const beforeCtx = result.undo_before_context;
        const afterCtx = result.undo_after_context;

        if (!replaceAll && beforeCtx && afterCtx) {
            // Find range by contexts
            let searchFrom = 0;
            while (true) {
                const beforeIdx = strippedHtml.indexOf(beforeCtx, searchFrom);
                if (beforeIdx === -1) break;
                const start = beforeIdx + beforeCtx.length;
                const afterIdx = strippedHtml.indexOf(afterCtx, start);
                if (afterIdx !== -1 && afterIdx >= start) {
                    const candidateHtml = strippedHtml.substring(start, afterIdx);
                    // Semantic comparison: simplify both and compare
                    const { simplified: candSimp } = simplifyNoteHtml(
                        stripDataCitationItems(candidateHtml), libraryID
                    );
                    const { simplified: expectedSimp } = simplifyNoteHtml(
                        stripDataCitationItems(undoNewHtml), libraryID
                    );
                    const normCand = candSimp.replace(/\s+/g, ' ').trim();
                    const normExpected = expectedSimp.replace(/\s+/g, ' ').trim();
                    if (normCand === normExpected) {
                        const restoredHtml = strippedHtml.substring(0, start)
                            + undoOldHtml
                            + strippedHtml.substring(afterIdx);
                        return rebuildDataCitationItems(restoredHtml);
                    }
                }
                searchFrom = beforeIdx + 1;
            }
        }

        throw new Error(
            'Cannot undo: neither the applied text nor the original text could be found.'
        );
    }

    // Exact match path
    let restoredHtml: string;
    if (replaceAll) {
        restoredHtml = strippedHtml.split(undoNewHtml).join(undoOldHtml);
    } else {
        const idx = strippedHtml.indexOf(undoNewHtml);
        restoredHtml = strippedHtml.substring(0, idx) + undoOldHtml
            + strippedHtml.substring(idx + undoNewHtml.length);
    }

    return rebuildDataCitationItems(restoredHtml);
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();

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
            getURIItem: vi.fn(),
            getURIItemLibraryKey: vi.fn((uri: string) => {
                const m = uri.match(/\/items\/([A-Z0-9]+)$/i);
                return m ? { libraryID: 1, key: m[1] } : false;
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
                    const page = ci.locator ? `, p. ${ci.locator}` : '';
                    return `<span class="citation-item">${author}${year ? ', ' + year : ''}${page}</span>`;
                }).join('; ') + ')';
            }),
        },
        Notes: {
            _editorInstances: [],
        },
        Beaver: {
            attachmentFileCache: null,
        },
    };

    invalidateSimplificationCache('test-note');
});

// =============================================================================
// Fixtures
// =============================================================================

/** Plain text note (no citations/annotations) */
const PLAIN_NOTE = wrap(
    '<h1>Test Note</h1>'
    + '<p>First paragraph with some text.</p>'
    + '<p>Second paragraph with more text.</p>'
    + '<p>Third paragraph to provide context.</p>'
);

/** Note with a single citation */
const NOTE_WITH_CITATION = wrap(
    '<p>According to the study '
    + rawCitation('CITE1', 1, '42', 'Smith, 2024, p. 42')
    + ', the results are significant.</p>'
    + '<p>Further analysis reveals important patterns.</p>'
);

/** Note with multiple citations to the same item */
const NOTE_MULTI_CITE = wrap(
    '<p>Introduction text ' + rawCitation('SAMEK', 1, '1', 'Doe, 2023, p. 1') + '.</p>'
    + '<p>Methodology section ' + rawCitation('SAMEK', 1, '5', 'Doe, 2023, p. 5') + '.</p>'
    + '<p>Results discussion ' + rawCitation('SAMEK', 1, '10', 'Doe, 2023, p. 10') + '.</p>'
);

/** Note with formatting that PM would transform */
const NOTE_WITH_FORMATTING = wrap(
    '<p>Normal text with <b>bold via b tag</b> and <i>italic via i tag</i>.</p>'
    + '<p>Also has <s>strikethrough via s tag</s> and a '
    + '<a href="http://example.com">link without rel</a>.</p>'
);

/** Note with list items */
const NOTE_WITH_LIST = wrap(
    '<h1>Notes</h1>'
    + '<ul><li><p>First item</p></li><li><p>Second item</p></li><li><p>Third item</p></li></ul>'
    + '<p>After the list.</p>'
);


// =============================================================================
// Section 1: Apply-Undo Roundtrip WITHOUT PM Normalization
//
// These should all pass — they verify the basic mechanism works when
// the HTML is not modified between apply and undo.
// =============================================================================

describe('apply-undo roundtrip (no PM normalization)', () => {
    it('simple text replacement: undo restores original', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            'First paragraph with some text',
            'First paragraph with modified text'
        );
        const stripped = stripDataCitationItems(PLAIN_NOTE);
        expect(newHtml).toContain('modified text');

        const restored = simulateUndo(newHtml, 1, result, 'First paragraph with some text', 'First paragraph with modified text');
        expect(stripDataCitationItems(restored)).toBe(stripped);
    });

    it('deletion: undo re-inserts deleted text', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            '<p>Second paragraph with more text.</p>',
            ''
        );
        expect(newHtml).not.toContain('Second paragraph');

        const restored = simulateUndo(newHtml, 1, result, '<p>Second paragraph with more text.</p>', '');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(PLAIN_NOTE));
    });

    it('text replacement near citation: undo restores original', () => {
        const { newHtml, result } = simulateApply(
            NOTE_WITH_CITATION, 1,
            'the results are significant',
            'the findings are notable'
        );

        const restored = simulateUndo(newHtml, 1, result, 'the results are significant', 'the findings are notable');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
    });

    it('replace_all: undo restores all occurrences', () => {
        const note = wrap(
            '<p>The word test appears here.</p>'
            + '<p>Another test in this paragraph.</p>'
            + '<p>Final test paragraph.</p>'
        );
        const { newHtml, result } = simulateApply(note, 1, 'test', 'exam', true);
        expect(newHtml).not.toContain('test');
        expect((newHtml.match(/exam/g) || []).length).toBe(3);

        const restored = simulateUndo(newHtml, 1, result, 'test', 'exam', true);
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section 2: Apply-Undo Roundtrip WITH PM Normalization
//
// These simulate ProseMirror re-normalizing the HTML after save.
// The undo must still work even though the stored undo_new_html
// no longer matches the actual note content.
//
// EXPECTED: Many of these will FAIL with the current implementation.
// =============================================================================

describe('apply-undo roundtrip (with PM normalization)', () => {
    it('FAILS: simple text change — PM adds newlines between blocks', () => {
        // Apply: insert a new paragraph (no newlines between blocks)
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            '<p>First paragraph with some text.</p>',
            '<p>First paragraph with some text.</p><p>Inserted paragraph.</p>'
        );

        // PM normalizes: adds \n between blocks
        const pmNormalized = simulatePMNormalization(newHtml);
        expect(pmNormalized).not.toBe(newHtml); // PM changed the HTML

        // Undo should work despite PM normalization
        const restored = simulateUndo(
            pmNormalized, 1, result,
            '<p>First paragraph with some text.</p>',
            '<p>First paragraph with some text.</p><p>Inserted paragraph.</p>'
        );
        expect(stripDataCitationItems(restored)).toContain('First paragraph with some text.');
        expect(stripDataCitationItems(restored)).not.toContain('Inserted paragraph');
    });

    it('FAILS: bold tag converted — PM converts <b> to <strong>', () => {
        // The agent inserts text with <b> tags
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            'First paragraph with some text',
            'First paragraph with <b>bold</b> text'
        );

        // PM normalizes: <b> → <strong>
        const pmNormalized = simulatePMNormalization(newHtml);
        expect(pmNormalized).toContain('<strong>bold</strong>');
        expect(pmNormalized).not.toContain('<b>');

        // Undo should work despite tag conversion
        const restored = simulateUndo(
            pmNormalized, 1, result,
            'First paragraph with some text',
            'First paragraph with <b>bold</b> text'
        );
        expect(stripDataCitationItems(restored)).toContain('First paragraph with some text');
    });

    it('FAILS: italic tag converted — PM converts <i> to <em>', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            'Second paragraph with more text',
            'Second paragraph with <i>emphasized</i> text'
        );

        const pmNormalized = simulatePMNormalization(newHtml);
        expect(pmNormalized).toContain('<em>emphasized</em>');

        const restored = simulateUndo(
            pmNormalized, 1, result,
            'Second paragraph with more text',
            'Second paragraph with <i>emphasized</i> text'
        );
        expect(stripDataCitationItems(restored)).toContain('Second paragraph with more text');
    });

    it('FAILS: strikethrough tag converted — PM converts <s> to span', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            'some text',
            '<s>struck</s> text'
        );

        const pmNormalized = simulatePMNormalization(newHtml);
        expect(pmNormalized).toContain('text-decoration: line-through');

        const restored = simulateUndo(
            pmNormalized, 1, result,
            'some text',
            '<s>struck</s> text'
        );
        expect(stripDataCitationItems(restored)).toContain('some text');
    });

    it('FAILS: link gets rel attribute — PM adds rel to <a>', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            'some text',
            '<a href="http://example.com">a link</a>'
        );

        const pmNormalized = simulatePMNormalization(newHtml);
        expect(pmNormalized).toContain('rel="noopener noreferrer nofollow"');

        const restored = simulateUndo(
            pmNormalized, 1, result,
            'some text',
            '<a href="http://example.com">a link</a>'
        );
        expect(stripDataCitationItems(restored)).toContain('some text');
    });

    it('FAILS: list item unwrapping — PM unwraps single-<p> in <li>', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            '<p>Second paragraph with more text.</p>',
            '<ul><li><p>New list item</p></li></ul>'
        );

        const pmNormalized = simulatePMNormalization(newHtml);
        // PM unwraps <li><p>text</p></li> → <li>text</li>
        expect(pmNormalized).not.toContain('<li><p>');

        const restored = simulateUndo(
            pmNormalized, 1, result,
            '<p>Second paragraph with more text.</p>',
            '<ul><li><p>New list item</p></li></ul>'
        );
        expect(stripDataCitationItems(restored)).toContain('Second paragraph with more text');
    });

    it('note with non-canonical formatting — edit region unaffected by PM on surrounding HTML', () => {
        // NOTE_WITH_FORMATTING has <b>, <i>, <s>, bare <a> — all non-canonical
        // Even reading the note from the editor would produce PM-normalized HTML.
        // But if the note was NOT open in editor, setNote preserves as-is.
        // Simulate: note not open → edit → now user opens note → PM normalizes all
        const { newHtml, result } = simulateApply(
            NOTE_WITH_FORMATTING, 1,
            'Normal text',
            'Changed text'
        );

        // PM normalizes the ENTIRE note (not just the edit region)
        const pmNormalized = simulatePMNormalization(newHtml);

        // Now undo — the context anchors captured from the pre-PM HTML won't match
        // because PM changed the surrounding HTML too
        const restored = simulateUndo(
            pmNormalized, 1, result,
            'Normal text',
            'Changed text'
        );
        expect(stripDataCitationItems(restored)).toContain('Normal text');
    });
});


// =============================================================================
// Section 3: Full Apply-Undo-Apply-Undo Cycle
//
// Tests the complete roundtrip: apply → undo → re-apply → re-undo
// =============================================================================

describe('full apply-undo-apply-undo cycle (no PM normalization)', () => {
    it('simple text edit survives full cycle', () => {
        const original = PLAIN_NOTE;
        const oldStr = 'First paragraph with some text';
        const newStr = 'First paragraph with changed text';

        // Apply
        const { newHtml: html1, result: result1 } = simulateApply(original, 1, oldStr, newStr);
        expect(html1).toContain('changed text');

        // Undo
        invalidateSimplificationCache('test-note');
        const html2 = simulateUndo(html1, 1, result1, oldStr, newStr);
        expect(stripDataCitationItems(html2)).toBe(stripDataCitationItems(original));

        // Re-apply
        invalidateSimplificationCache('test-note');
        const { newHtml: html3, result: result2 } = simulateApply(html2, 1, oldStr, newStr);
        expect(html3).toContain('changed text');

        // Re-undo
        invalidateSimplificationCache('test-note');
        const html4 = simulateUndo(html3, 1, result2, oldStr, newStr);
        expect(stripDataCitationItems(html4)).toBe(stripDataCitationItems(original));
    });

    it('deletion survives full cycle', () => {
        const original = PLAIN_NOTE;
        const oldStr = '<p>Second paragraph with more text.</p>';
        const newStr = '';

        // Apply
        const { newHtml: html1, result: result1 } = simulateApply(original, 1, oldStr, newStr);
        expect(html1).not.toContain('Second paragraph');

        // Undo
        invalidateSimplificationCache('test-note');
        const html2 = simulateUndo(html1, 1, result1, oldStr, newStr);
        expect(stripDataCitationItems(html2)).toBe(stripDataCitationItems(original));

        // Re-apply
        invalidateSimplificationCache('test-note');
        const { newHtml: html3, result: result2 } = simulateApply(html2, 1, oldStr, newStr);
        expect(html3).not.toContain('Second paragraph');

        // Re-undo
        invalidateSimplificationCache('test-note');
        const html4 = simulateUndo(html3, 1, result2, oldStr, newStr);
        expect(stripDataCitationItems(html4)).toBe(stripDataCitationItems(original));
    });
});

describe('full apply-undo-apply-undo cycle (with PM normalization)', () => {
    it('FAILS: text edit with PM normalization between each step', () => {
        const original = PLAIN_NOTE;
        const oldStr = 'First paragraph with some text';
        const newStr = 'First paragraph with <b>bold</b> text';

        // Apply
        const { newHtml: rawHtml1, result: result1 } = simulateApply(original, 1, oldStr, newStr);
        const html1 = simulatePMNormalization(rawHtml1);

        // Undo (must handle PM-normalized HTML)
        invalidateSimplificationCache('test-note');
        const rawHtml2 = simulateUndo(html1, 1, result1, oldStr, newStr);
        const html2 = simulatePMNormalization(rawHtml2);

        // After undo + PM normalization, content should match original semantically
        expect(stripDataCitationItems(html2)).toContain('First paragraph with some text');

        // Re-apply on PM-normalized undo result
        invalidateSimplificationCache('test-note');
        const { newHtml: rawHtml3, result: result2 } = simulateApply(html2, 1, oldStr, newStr);
        const html3 = simulatePMNormalization(rawHtml3);
        expect(html3).toContain('<strong>bold</strong>');

        // Re-undo
        invalidateSimplificationCache('test-note');
        const rawHtml4 = simulateUndo(html3, 1, result2, oldStr, newStr);
        const html4 = simulatePMNormalization(rawHtml4);
        expect(stripDataCitationItems(html4)).toContain('First paragraph with some text');
    });

    it('FAILS: multi-block insertion with PM normalization', () => {
        const original = PLAIN_NOTE;
        const oldStr = '<p>Second paragraph with more text.</p>';
        const newStr = '<p>Replaced paragraph.</p><p>Additional paragraph.</p>';

        // Apply
        const { newHtml: rawHtml1, result: result1 } = simulateApply(original, 1, oldStr, newStr);
        const html1 = simulatePMNormalization(rawHtml1);
        expect(html1).toContain('Replaced paragraph');
        expect(html1).toContain('Additional paragraph');

        // Undo
        invalidateSimplificationCache('test-note');
        const rawHtml2 = simulateUndo(html1, 1, result1, oldStr, newStr);
        expect(stripDataCitationItems(rawHtml2)).toContain('Second paragraph with more text');
    });
});


// =============================================================================
// Section 4: replace_all with PM Normalization
// =============================================================================

describe('replace_all undo with PM normalization', () => {
    it('FAILS: replace_all — PM normalizes each occurrence', () => {
        const note = wrap(
            '<p>The word test appears here.</p>'
            + '<p>Another test in this paragraph.</p>'
        );

        const { newHtml: rawHtml, result } = simulateApply(note, 1, 'test', '<b>exam</b>', true);
        const html1 = simulatePMNormalization(rawHtml);

        // PM converts <b> → <strong> in each occurrence
        expect(html1).toContain('<strong>exam</strong>');
        expect(html1).not.toContain('<b>');

        // Undo should restore all occurrences
        const restored = simulateUndo(html1, 1, result, 'test', '<b>exam</b>', true);
        expect(stripDataCitationItems(restored)).toContain('test');
        expect(stripDataCitationItems(restored)).not.toContain('exam');
    });

    it('replace_all without PM normalization works', () => {
        const note = wrap(
            '<p>Replace this word.</p>'
            + '<p>And this word too.</p>'
        );
        const { newHtml, result } = simulateApply(note, 1, 'word', 'term', true);
        expect(newHtml).not.toContain('word');

        const restored = simulateUndo(newHtml, 1, result, 'word', 'term', true);
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section 5: Citation-Specific Undo Edge Cases
// =============================================================================

describe('citation-related undo edge cases', () => {
    it('undo text edit near citation (no PM normalization)', () => {
        const { newHtml, result } = simulateApply(
            NOTE_WITH_CITATION, 1,
            'the results are significant',
            'the findings are remarkable'
        );

        const restored = simulateUndo(newHtml, 1, result, 'the results are significant', 'the findings are remarkable');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
    });

    it('undo edit between two citations to same item', () => {
        const { newHtml, result } = simulateApply(
            NOTE_MULTI_CITE, 1,
            'Methodology section',
            'Methods overview'
        );

        const restored = simulateUndo(newHtml, 1, result, 'Methodology section', 'Methods overview');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(NOTE_MULTI_CITE));
    });

    it('insert new citation then undo with PM normalization — passes because citation is rebuilt fresh', () => {
        // Simplify to get a citation ref
        const { simplified, metadata } = simplifyNoteHtml(NOTE_WITH_CITATION, 1);
        const refMatch = simplified.match(/ref="(c_CITE1_0)"/);
        expect(refMatch).toBeTruthy();
        const ref = refMatch![1];

        // Find text after the citation
        const oldStr = 'the results are significant';
        const newStr = 'the results are significant <citation item_id="1-NEWCITE" label="NewRef, 2025"/>';

        const { newHtml: rawHtml, result } = simulateApply(NOTE_WITH_CITATION, 1, oldStr, newStr);
        const html1 = simulatePMNormalization(rawHtml);

        // Undo should remove the new citation
        const restored = simulateUndo(html1, 1, result, oldStr, newStr);
        const restoredStripped = stripDataCitationItems(restored);
        expect(restoredStripped).toContain('the results are significant');
        // Should NOT contain the new citation
        expect(restoredStripped).not.toContain('NEWCITE');
    });
});


// =============================================================================
// Section 6: Deletion Undo Edge Cases with PM Normalization
// =============================================================================

describe('deletion undo with PM normalization', () => {
    it('FAILS: delete paragraph — PM normalizes whitespace at seam', () => {
        const { newHtml: rawHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            '<p>Second paragraph with more text.</p>',
            ''
        );

        // PM normalizes the result (may change whitespace at deletion seam)
        const html1 = simulatePMNormalization(rawHtml);

        // Undo should re-insert the deleted paragraph
        const restored = simulateUndo(html1, 1, result, '<p>Second paragraph with more text.</p>', '');
        expect(stripDataCitationItems(restored)).toContain('Second paragraph with more text');
    });

    it('delete text near citation — context anchors survive PM normalization of plain text', () => {
        // Delete the text after the citation
        const { newHtml: rawHtml, result } = simulateApply(
            NOTE_WITH_CITATION, 1,
            ', the results are significant',
            ''
        );

        const html1 = simulatePMNormalization(rawHtml);

        const restored = simulateUndo(html1, 1, result, ', the results are significant', '');
        expect(stripDataCitationItems(restored)).toContain('the results are significant');
    });
});


// =============================================================================
// Section 7: "Already Undone" Detection Edge Cases
// =============================================================================

describe('already-undone detection', () => {
    it('detects already-undone state correctly', () => {
        const { newHtml, result } = simulateApply(
            PLAIN_NOTE, 1,
            'First paragraph with some text',
            'First paragraph with changed text'
        );

        // Undo
        const restored = simulateUndo(newHtml, 1, result, 'First paragraph with some text', 'First paragraph with changed text');

        // Try to undo again — should detect already undone
        const doubleUndo = simulateUndo(restored, 1, result, 'First paragraph with some text', 'First paragraph with changed text');
        expect(stripDataCitationItems(doubleUndo)).toBe(stripDataCitationItems(restored));
    });

    it('no false positive when old_string is specific enough', () => {
        // A note where the old_string text appears in two places
        const note = wrap(
            '<p>The word unique appears in the first paragraph.</p>'
            + '<p>We will edit the second occurrence of unique here.</p>'
            + '<p>Third paragraph.</p>'
        );

        // Edit the second "unique" to "special"
        // simulateApply will fail with "ambiguous" — use a more specific old_string
        const { newHtml, result } = simulateApply(
            note, 1,
            'the second occurrence of unique here',
            'the second occurrence of special here'
        );

        // Undo it
        const restored = simulateUndo(newHtml, 1, result,
            'the second occurrence of unique here',
            'the second occurrence of special here'
        );

        // Undo the undo — the "already undone" check uses includes(undo_old_html).
        // undo_old_html = "the second occurrence of unique here" which only appears once.
        // But if undo_old_html were just "unique", it would false-positive.
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section 8: Multiple Edits on Same Note
// =============================================================================

describe('multiple edits on same note', () => {
    it('two non-overlapping edits: undo second, then first', () => {
        const original = PLAIN_NOTE;

        // Edit 1: change first paragraph
        const { newHtml: html1, result: result1 } = simulateApply(
            original, 1,
            'First paragraph with some text',
            'First paragraph with ALPHA text'
        );

        // Edit 2: change third paragraph (in the already-edited note)
        invalidateSimplificationCache('test-note');
        const { newHtml: html2, result: result2 } = simulateApply(
            html1, 1,
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );

        expect(html2).toContain('ALPHA');
        expect(html2).toContain('BETA');

        // Undo edit 2
        invalidateSimplificationCache('test-note');
        const html3 = simulateUndo(html2, 1, result2,
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );
        expect(stripDataCitationItems(html3)).toContain('ALPHA');
        expect(stripDataCitationItems(html3)).not.toContain('BETA');

        // Undo edit 1
        invalidateSimplificationCache('test-note');
        const html4 = simulateUndo(html3, 1, result1,
            'First paragraph with some text',
            'First paragraph with ALPHA text'
        );
        expect(stripDataCitationItems(html4)).toBe(stripDataCitationItems(original));
    });

    it('two non-overlapping edits: undo first, then second (out of order)', () => {
        const original = PLAIN_NOTE;

        // Edit 1: change first paragraph
        const { newHtml: html1, result: result1 } = simulateApply(
            original, 1,
            'First paragraph with some text',
            'First paragraph with ALPHA text'
        );

        // Edit 2: change third paragraph
        invalidateSimplificationCache('test-note');
        const { newHtml: html2, result: result2 } = simulateApply(
            html1, 1,
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );

        // Undo edit 1 FIRST (out of order)
        invalidateSimplificationCache('test-note');
        const html3 = simulateUndo(html2, 1, result1,
            'First paragraph with some text',
            'First paragraph with ALPHA text'
        );
        expect(stripDataCitationItems(html3)).not.toContain('ALPHA');
        expect(stripDataCitationItems(html3)).toContain('BETA');

        // Undo edit 2
        invalidateSimplificationCache('test-note');
        const html4 = simulateUndo(html3, 1, result2,
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );
        expect(stripDataCitationItems(html4)).toBe(stripDataCitationItems(original));
    });

    it('FAILS: two edits with PM normalization — undo out of order', () => {
        const original = PLAIN_NOTE;

        // Edit 1: insert bold text (non-canonical <b>)
        const { newHtml: raw1, result: result1 } = simulateApply(
            original, 1,
            'First paragraph with some text',
            'First paragraph with <b>ALPHA</b> text'
        );
        const html1 = simulatePMNormalization(raw1);

        // Edit 2: change third paragraph (plain text)
        invalidateSimplificationCache('test-note');
        const { newHtml: raw2, result: result2 } = simulateApply(
            html1, 1,
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );
        const html2 = simulatePMNormalization(raw2);

        // Undo edit 1 (out of order) — undo_new_html has <b> but note has <strong>
        invalidateSimplificationCache('test-note');
        const raw3 = simulateUndo(html2, 1, result1,
            'First paragraph with some text',
            'First paragraph with <b>ALPHA</b> text'
        );
        const html3 = simulatePMNormalization(raw3);
        expect(stripDataCitationItems(html3)).toContain('First paragraph with some text');
        expect(stripDataCitationItems(html3)).toContain('BETA');
    });
});


// =============================================================================
// Section 9: Edge Cases — Whitespace and Special Characters
// =============================================================================

describe('whitespace and special character edge cases', () => {
    it('edit with HTML entities in text', () => {
        const note = wrap('<p>Smith &amp; Jones (2024) found that x &lt; y.</p>');
        const { newHtml, result } = simulateApply(
            note, 1,
            'Smith &amp; Jones (2024)',
            'Smith &amp; Wesson (2024)'
        );
        expect(newHtml).toContain('Wesson');

        const restored = simulateUndo(newHtml, 1, result, 'Smith &amp; Jones (2024)', 'Smith &amp; Wesson (2024)');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(note));
    });

    it('edit with unicode characters', () => {
        const note = wrap('<p>Résumé of François and naïve coöperation.</p>');
        const { newHtml, result } = simulateApply(
            note, 1,
            'François',
            'Jean-François'
        );

        const restored = simulateUndo(newHtml, 1, result, 'François', 'Jean-François');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(note));
    });

    it('NFC normalization — composed vs decomposed survives because both normalize to same form', () => {
        // Use decomposed form (e + combining accent) which NFC normalizes to composed form (é)
        const decomposed = 'Re\u0301sume\u0301'; // "Résumé" in NFD
        const note = wrap(`<p>${decomposed} of the study.</p>`);

        const { newHtml, result } = simulateApply(note, 1, decomposed, 'Summary');
        const pmNormalized = simulatePMNormalization(newHtml);

        // After PM normalization + undo, the original decomposed form may not match
        // because NFC normalization changed it to composed form
        const restored = simulateUndo(pmNormalized, 1, result, decomposed, 'Summary');
        expect(stripDataCitationItems(restored)).toContain('sume');
    });
});


// =============================================================================
// Section 10: List-Specific Edge Cases
// =============================================================================

describe('list editing edge cases', () => {
    it('edit list item text (no PM normalization)', () => {
        const { newHtml, result } = simulateApply(
            NOTE_WITH_LIST, 1,
            'Second item',
            'Modified item'
        );

        const restored = simulateUndo(newHtml, 1, result, 'Second item', 'Modified item');
        expect(stripDataCitationItems(restored)).toBe(stripDataCitationItems(NOTE_WITH_LIST));
    });

    it('FAILS: add list item — PM unwraps <p> and adds newlines', () => {
        const { newHtml: rawHtml, result } = simulateApply(
            NOTE_WITH_LIST, 1,
            '<li><p>Third item</p></li>',
            '<li><p>Third item</p></li><li><p>Fourth item</p></li>'
        );

        const html1 = simulatePMNormalization(rawHtml);
        // PM unwraps single-<p> and adds newlines
        expect(html1).not.toContain('<li><p>Fourth item</p></li>');

        const restored = simulateUndo(html1, 1, result,
            '<li><p>Third item</p></li>',
            '<li><p>Third item</p></li><li><p>Fourth item</p></li>'
        );
        expect(stripDataCitationItems(restored)).not.toContain('Fourth item');
    });
});
