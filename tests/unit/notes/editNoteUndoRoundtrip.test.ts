/**
 * Tests for the full apply-undo-apply-undo roundtrip of edit_note actions.
 *
 * These tests call the REAL executeEditNoteAction and undoEditNoteAction
 * functions with real simplifier/expander logic (not mocked).
 *
 * ProseMirror normalization is simulated between apply and undo by mutating
 * what the mock item's getNote() returns — replicating what happens when
 * a note is open in the editor and PM re-saves after item.saveTx().
 *
 * Tests prefixed with "FAILS:" are expected to fail and document
 * known limitations (e.g., replace_all with PM normalization).
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

// Mock the store and agentActionsService used by scheduleUndoDataRefresh
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => null), set: vi.fn(), sub: vi.fn() },
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
}));

vi.mock('../../../react/agents/agentActions', () => ({
    AgentAction: class {},
    updateAgentActionsAtom: Symbol('updateAgentActionsAtom'),
}));

vi.mock('../../../src/services/agentActionsService', () => ({
    agentActionsService: {
        updateAction: vi.fn().mockResolvedValue(undefined),
    },
}));

// =============================================================================
// Imports (real simplifier functions — NOT mocked)
// =============================================================================

import {
    simplifyNoteHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    invalidateSimplificationCache,
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
 * Applies the key transforms documented in zotero-notes.md:
 * - <b> → <strong>, <i> → <em>
 * - <s>/<del>/<strike> → <span style="text-decoration: line-through;">
 * - <a> gets rel="noopener noreferrer nofollow"
 * - \n inserted before/after block elements
 * - Single-<p> in <li> unwrapped
 * - NFC normalization
 */
function simulatePMNormalization(html: string): string {
    let result = html;

    // Tag conversions
    result = result.replace(/<b>([\s\S]*?)<\/b>/g, '<strong>$1</strong>');
    result = result.replace(/<i>([\s\S]*?)<\/i>/g, '<em>$1</em>');
    result = result.replace(/<s>([\s\S]*?)<\/s>/g, '<span style="text-decoration: line-through;">$1</span>');
    result = result.replace(/<del>([\s\S]*?)<\/del>/g, '<span style="text-decoration: line-through;">$1</span>');
    result = result.replace(/<strike>([\s\S]*?)<\/strike>/g, '<span style="text-decoration: line-through;">$1</span>');

    // Inline style normalization: PM converts CSS font-weight/font-style
    // on elements to semantic wrappers (<strong>, <em>)
    // Combined color + bold (both orderings)
    result = result.replace(
        /<p style="color:\s*([^;]+);\s*font-weight:\s*bold;?">([\s\S]*?)<\/p>/g,
        '<p><strong><span style="color: $1;">$2</span></strong></p>');
    result = result.replace(
        /<p style="font-weight:\s*bold;\s*color:\s*([^;"]+);?">([\s\S]*?)<\/p>/g,
        '<p><strong><span style="color: $1;">$2</span></strong></p>');
    // Just bold on paragraph
    result = result.replace(
        /<p style="font-weight:\s*bold;?">([\s\S]*?)<\/p>/g,
        '<p><strong>$1</strong></p>');
    // Just italic on paragraph
    result = result.replace(
        /<p style="font-style:\s*italic;?">([\s\S]*?)<\/p>/g,
        '<p><em>$1</em></p>');

    // Add rel to links that don't have it
    result = result.replace(/<a\s+href="([^"]*)"(?![^>]*rel=)/g,
        '<a href="$1" rel="noopener noreferrer nofollow"');

    // Newline insertion: \n after text blocks (h1-h6, p, pre)
    result = result.replace(/(<\/(?:h[1-6]|p|pre)>)(?!\n)/g, '$1\n');

    // Newline inside + after structural blocks
    result = result.replace(/(<(?:ul|ol|li|blockquote|table|tr|td|th|thead|tbody|tfoot)(?:\s[^>]*)?>)(?!\n)/g, '$1\n');
    result = result.replace(/(<\/(?:ul|ol|li|blockquote|table|tr|td|th|thead|tbody|tfoot)>)(?!\n)/g, '$1\n');

    // Unwrap single-<p> in <li>: <li>\n<p>text</p>\n</li> → <li>\ntext\n</li>
    result = result.replace(/<li>\n?<p>([\s\S]*?)<\/p>\n?<\/li>/g, '<li>\n$1\n</li>');

    // HTML entity decoding: PM decodes numeric entities (&#x27; → ', &#39; → ')
    // and named entities (&apos; → ', &quot; → ") within text content.
    // Only decode inside text (not inside tags or attributes).
    result = result.replace(/>([^<]+)</g, (_, text) => {
        const decoded = text
            .replace(/&#x([0-9a-fA-F]+);/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_: string, dec: string) => String.fromCharCode(parseInt(dec, 10)))
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"');
        return '>' + decoded + '<';
    });

    // NFC normalization
    result = result.normalize('NFC');

    return result;
}

/**
 * Create a mock Zotero note item that tracks setNote/saveTx calls.
 * `currentHtml` is mutated by setNote so getNote returns the latest value.
 */
function createMockNoteItem(initialHtml: string, libraryID = 1, key = 'TESTKEY') {
    let currentHtml = initialHtml;

    const item = {
        id: 42,
        key,
        libraryID,
        isNote: vi.fn(() => true),
        isRegularItem: vi.fn(() => false),
        isAttachment: vi.fn(() => false),
        loadDataType: vi.fn().mockResolvedValue(undefined),
        getNote: vi.fn(() => currentHtml),
        setNote: vi.fn((html: string) => { currentHtml = html; return true; }),
        saveTx: vi.fn().mockResolvedValue(undefined),
        getField: vi.fn(() => ''),
        // Allow tests to directly set what getNote returns (simulating PM re-save)
        _setHtml: (html: string) => { currentHtml = html; },
        _getHtml: () => currentHtml,
    };

    return item;
}

/**
 * Build an AgentAction object for executeEditNoteAction / undoEditNoteAction.
 */
function makeAction(
    libraryId: number,
    zoteroKey: string,
    oldString: string,
    newString: string,
    operation: 'str_replace' | 'str_replace_all' = 'str_replace',
    resultData?: EditNoteResultData,
): AgentAction {
    return {
        id: 'test-action-' + Math.random().toString(36).slice(2),
        tool_call_id: 'tc-1',
        run_id: 'run-1',
        action_type: 'edit_note',
        status: resultData ? 'applied' : 'pending',
        proposed_data: {
            library_id: libraryId,
            zotero_key: zoteroKey,
            old_string: oldString,
            new_string: newString,
            operation,
        },
        result_data: resultData,
        created_at: new Date().toISOString(),
    } as AgentAction;
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
            getByLibraryAndKeyAsync: vi.fn(),
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

    invalidateSimplificationCache('1-TESTKEY');
});

// =============================================================================
// Fixtures
// =============================================================================

/**
 * Fixtures use PM-canonical HTML (with \n between blocks, <li> unwrapped, etc.)
 * because in production getLatestNoteHtml reads from the editor which returns
 * PM-normalized HTML. Context anchors captured at apply time are from this
 * PM-normalized HTML, and PM normalization is idempotent, so they survive re-saves.
 */
const PLAIN_NOTE = wrap(
    '<h1>Test Note</h1>\n'
    + '<p>First paragraph with some text.</p>\n'
    + '<p>Second paragraph with more text.</p>\n'
    + '<p>Third paragraph to provide context.</p>\n'
);

const NOTE_WITH_CITATION = wrap(
    '<p>According to the study '
    + rawCitation('CITE1', 1, '42', 'Smith, 2024, p. 42')
    + ', the results are significant.</p>\n'
    + '<p>Further analysis reveals important patterns.</p>\n'
);

const NOTE_MULTI_CITE = wrap(
    '<p>Introduction text ' + rawCitation('SAMEK', 1, '1', 'Doe, 2023, p. 1') + '.</p>\n'
    + '<p>Methodology section ' + rawCitation('SAMEK', 1, '5', 'Doe, 2023, p. 5') + '.</p>\n'
    + '<p>Results discussion ' + rawCitation('SAMEK', 1, '10', 'Doe, 2023, p. 10') + '.</p>\n'
);

const NOTE_WITH_LIST = wrap(
    '<h1>Notes</h1>\n'
    + '<ul>\n<li>\nFirst item\n</li>\n<li>\nSecond item\n</li>\n<li>\nThird item\n</li>\n</ul>\n'
    + '<p>After the list.</p>\n'
);


// =============================================================================
// Test Harness
// =============================================================================

/**
 * Execute an edit via the real executeEditNoteAction, optionally with
 * a mock editor that simulates ProseMirror normalization.
 *
 * When `applyPMNormalization` is true, sets up a mock editor whose
 * getDataSync returns PM-normalized HTML. This causes the inline
 * waitForPMNormalization (inside executeEditNoteAction) to detect
 * the change and update undo_new_html before the result is returned —
 * exactly like the production path.
 */
async function applyEdit(opts: {
    noteHtml: string;
    oldString: string;
    newString: string;
    operation?: 'str_replace' | 'str_replace_all';
    applyPMNormalization?: boolean;
}): Promise<{
    item: ReturnType<typeof createMockNoteItem>;
    result: EditNoteResultData;
    action: AgentAction;
    currentStripped: string;
}> {
    const item = createMockNoteItem(opts.noteHtml);
    const action = makeAction(1, 'TESTKEY', opts.oldString, opts.newString, opts.operation);

    // Set up mock editor BEFORE execute so waitForPMNormalization
    // can read PM-normalized HTML via getLatestNoteHtml during polling
    if (opts.applyPMNormalization) {
        setupPMNormalizingEditor(item);
    }

    (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);

    const result = await executeEditNoteAction(action);

    // After execute, update the item to reflect what PM would have saved
    // (for subsequent reads by undoEditNoteAction)
    if (opts.applyPMNormalization) {
        item._setHtml(simulatePMNormalization(item._getHtml()));
    }

    action.status = 'applied';
    action.result_data = result;

    invalidateSimplificationCache('1-TESTKEY');

    return {
        item,
        result,
        action,
        currentStripped: stripDataCitationItems(item._getHtml()),
    };
}

/**
 * Undo an edit via the real undoEditNoteAction.
 */
async function undoEdit(
    item: ReturnType<typeof createMockNoteItem>,
    action: AgentAction,
    applyPMNormalization = false,
): Promise<string> {
    // Wire mock so undoEditNoteAction can find the item
    (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);

    await undoEditNoteAction(action);

    if (applyPMNormalization) {
        const savedHtml = item._getHtml();
        item._setHtml(simulatePMNormalization(savedHtml));
    }

    invalidateSimplificationCache('1-TESTKEY');
    return stripDataCitationItems(item._getHtml());
}


/**
 * Set up a mock editor instance that simulates ProseMirror normalization.
 *
 * getLatestNoteHtml reads from the editor via getDataSync(). This mock
 * returns PM-normalized HTML so that waitForPMNormalization (which
 * runs inline inside executeEditNoteAction) detects the change and updates
 * undo_new_html before the result is returned.
 *
 * The mock reads item.getNote() (the pre-PM HTML saved by setNote) and
 * applies simulatePMNormalization on the fly — matching what the real
 * ProseMirror editor does after receiving the Notifier event.
 */
function setupPMNormalizingEditor(item: ReturnType<typeof createMockNoteItem>): void {
    (Zotero as any).Notes._editorInstances = [{
        _item: { id: item.id },
        _iframeWindow: {
            frameElement: { isConnected: true },
            wrappedJSObject: {
                getDataSync: () => ({
                    html: simulatePMNormalization(item.getNote()),
                }),
            },
        },
    }];
}


// =============================================================================
// Section 1: Apply-Undo Roundtrip WITHOUT PM Normalization
// =============================================================================

describe('apply-undo roundtrip (no PM normalization)', () => {
    it('simple text replacement: undo restores original', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with modified text',
        });
        expect(item._getHtml()).toContain('modified text');

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(PLAIN_NOTE));
    });

    it('deletion: undo re-inserts deleted text', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Second paragraph with more text.</p>',
            newString: '',
        });
        expect(item._getHtml()).not.toContain('Second paragraph');

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(PLAIN_NOTE));
    });

    it('text replacement near citation: undo restores original', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION,
            oldString: 'the results are significant',
            newString: 'the findings are notable',
        });

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
    });

    it('append at end of note via last paragraph anchor: undo restores original', async () => {
        // The correct pattern: agent anchors on the last content element
        // instead of the wrapper </div> (which is stripped from simplified output).
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Third paragraph to provide context.</p>',
            newString: '<p>Third paragraph to provide context.</p>\n<p>Appended at the end.</p>',
        });
        expect(item._getHtml()).toContain('Appended at the end');

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(PLAIN_NOTE));
    });

    it('append at end of note via </div> replacement: undo restores original (legacy)', async () => {
        // Legacy scenario: if agent somehow sends </div> as old_string,
        // execution still works since executeEditNoteAction operates on full HTML.
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '</div>',
            newString: '<p>This is a test addition at the end of the note.</p></div>',
        });
        expect(item._getHtml()).toContain('test addition at the end');

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(PLAIN_NOTE));
    });

    it('replace_all: undo restores all occurrences', async () => {
        const note = wrap(
            '<p>The word test appears here.</p>'
            + '<p>Another test in this paragraph.</p>'
            + '<p>Final test paragraph.</p>'
        );
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'test',
            newString: 'exam',
            operation: 'str_replace_all',
        });
        expect(item._getHtml()).not.toContain('test');

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section 2: Apply-Undo with PM Normalization + Inline Undo Data Refresh
//
// These test the production code path: executeEditNoteAction runs
// waitForPMNormalization inline, which polls getLatestNoteHtml
// (reading from a mock editor that returns PM-normalized HTML),
// detects the change, and updates undo_new_html before returning.
// Then undoEditNoteAction succeeds with the corrected data.
// =============================================================================

describe('apply-undo with PM normalization + inline refresh', () => {
    it('bold tag: undo_new_html updated to <strong>, undo restores original', async () => {
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with <b>bold</b> text',
            applyPMNormalization: true,
        });

        expect(result.undo_new_html).toContain('<strong>bold</strong>');
        expect(result.undo_new_html).not.toContain('<b>');

        await undoEdit(item, action);
        expect(stripDataCitationItems(item._getHtml())).toContain('First paragraph with some text');
        expect(stripDataCitationItems(item._getHtml())).not.toContain('bold</');
    });

    it('italic tag: undo_new_html updated after PM <i> → <em>', async () => {
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'Second paragraph with more text',
            newString: 'Second paragraph with <i>emphasized</i> text',
            applyPMNormalization: true,
        });

        expect(result.undo_new_html).toContain('<em>');
        await undoEdit(item, action);
        expect(stripDataCitationItems(item._getHtml())).toContain('Second paragraph with more text');
    });

    it('strikethrough: undo_new_html updated after PM <s> → span', async () => {
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'some text',
            newString: '<s>struck</s> text',
            applyPMNormalization: true,
        });

        expect(result.undo_new_html).toContain('text-decoration: line-through');
        await undoEdit(item, action);
        expect(stripDataCitationItems(item._getHtml())).toContain('some text');
    });

    it('link: undo_new_html updated after PM adds rel attribute', async () => {
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'some text',
            newString: '<a href="http://example.com">a link</a>',
            applyPMNormalization: true,
        });

        expect(result.undo_new_html).toContain('rel=');
        await undoEdit(item, action);
        expect(stripDataCitationItems(item._getHtml())).toContain('some text');
    });

    it('multi-block insertion: undo_new_html updated after PM adds newlines', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Second paragraph with more text.</p>\n',
            newString: '<p>Replaced paragraph.</p><p>Additional paragraph.</p>',
            applyPMNormalization: true,
        });

        await undoEdit(item, action);
        const restored = stripDataCitationItems(item._getHtml());
        expect(restored).toContain('Second paragraph with more text');
        expect(restored).not.toContain('Replaced paragraph');
    });

    it('list item: undo_new_html updated after PM normalizes bold in <li>', async () => {
        const { item, action, result } = await applyEdit({
            noteHtml: NOTE_WITH_LIST,
            oldString: 'Third item',
            newString: 'Third item and <b>extra bold</b> content',
            applyPMNormalization: true,
        });

        expect(result.undo_new_html).toContain('<strong>');
        await undoEdit(item, action);
        expect(stripDataCitationItems(item._getHtml())).toContain('Third item');
        expect(stripDataCitationItems(item._getHtml())).not.toContain('extra bold');
    });

    it('full apply-undo-apply-undo cycle with PM normalization', async () => {
        // First apply
        const { item, action: action1 } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with <b>bold</b> text',
            applyPMNormalization: true,
        });

        // Undo
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toContain('First paragraph with some text');

        // Re-apply on the same item
        setupPMNormalizingEditor(item);
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY',
            'First paragraph with some text',
            'First paragraph with <b>bold</b> text'
        );
        const result2 = await executeEditNoteAction(action2);
        item._setHtml(simulatePMNormalization(item._getHtml()));
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        // Re-undo
        await undoEdit(item, action2);
        expect(stripDataCitationItems(item._getHtml())).toContain('First paragraph with some text');
    });

    it('no-op refresh when PM does not change HTML (plain text edit)', async () => {
        const { result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'some text',
            newString: 'changed text',
            applyPMNormalization: true,
        });

        // Plain text → PM normalization is a no-op → undo_new_html unchanged
        expect(result.undo_new_html).toBe('changed text');
    });
});


// =============================================================================
// Section 3: Apply-Undo Roundtrip WITH PM Normalization (via applyEdit)
//
// These also exercise the inline refresh but use applyEdit directly
// (same production path as Section 2, different edit scenarios).
// =============================================================================

describe('apply-undo roundtrip (with PM normalization)', () => {
    it('simple text change — PM adds newlines between blocks', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>First paragraph with some text.</p>',
            newString: '<p>First paragraph with some text.</p><p>Inserted paragraph.</p>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('Inserted paragraph');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('First paragraph with some text.');
        expect(restored).not.toContain('Inserted paragraph');
    });

    it('bold tag converted — PM converts <b> to <strong>', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with <b>bold</b> text',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('<strong>bold</strong>');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('First paragraph with some text');
        expect(restored).not.toContain('bold</');
    });

    it('italic tag converted — PM converts <i> to <em>', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'Second paragraph with more text',
            newString: 'Second paragraph with <i>emphasized</i> text',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('<em>emphasized</em>');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('Second paragraph with more text');
    });

    it('strikethrough tag converted — PM converts <s> to span', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'some text',
            newString: '<s>struck</s> text',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('text-decoration: line-through');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('some text');
    });

    it('link gets rel attribute — PM adds rel to <a>', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'some text',
            newString: '<a href="http://example.com">a link</a>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('rel="noopener noreferrer nofollow"');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('some text');
    });

    it('list item unwrapping — PM unwraps single-<p> in <li>', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Second paragraph with more text.</p>',
            newString: '<ul><li><p>New list item</p></li></ul>',
            applyPMNormalization: true,
        });
        // PM unwraps <li><p>text</p></li>
        expect(item._getHtml()).not.toContain('<li><p>');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('Second paragraph with more text');
    });

    it('append at end via last paragraph anchor — PM normalization', async () => {
        // Correct pattern: agent anchors on last content element.
        // The wrapper </div> becomes part of undo_after_context, not undo_new_html.
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Third paragraph to provide context.</p>',
            newString: '<p>Third paragraph to provide context.</p>\n<p>Appended text.</p>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('Appended text');

        const restored = await undoEdit(item, action, true);
        expect(restored).toContain('Third paragraph to provide context');
        expect(restored).not.toContain('Appended text');
    });

    it('append at end via last paragraph anchor — stale undo (PM missed)', async () => {
        // Content-based anchor + editor not active (waitForPMNormalization is no-op).
        // The undo_after_context contains </div> as a stable anchor.
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Third paragraph to provide context.</p>',
            newString: '<p>Third paragraph to provide context.</p>\n<p>Stale test.</p>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('Stale test');

        // Revert undo_new_html to pre-PM version (simulating editor not active)
        result.undo_new_html = '<p>Third paragraph to provide context.</p>\n<p>Stale test.</p>';
        action.result_data = result;

        const restored = await undoEdit(item, action, true);
        expect(restored).toContain('Third paragraph to provide context');
        expect(restored).not.toContain('Stale test');
    });

    it('append at end of note via </div> — PM adds newline before closing tag (legacy)', async () => {
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '</div>',
            newString: '<p>This is a test addition at the end of the note.</p></div>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('test addition at the end');

        // PM inserts \n after </p>, so undo_new_html should be updated
        expect(result.undo_new_html).toContain('</p>\n</div>');

        const restored = await undoEdit(item, action, true);
        expect(restored).toContain('Third paragraph to provide context');
        expect(restored).not.toContain('test addition at the end');
    });

    it('append at end of note via </div> — stale undo_new_html (PM missed, legacy)', async () => {
        // Simulate the case where waitForPMNormalization did NOT update
        // undo_new_html (PM was too slow). The undo should still succeed
        // via fuzzy matching with whitespace-normalized comparison.
        const { item, action, result } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '</div>',
            newString: '<p>Test end append.</p></div>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('Test end append');

        // Deliberately revert undo_new_html to the pre-PM version
        // (simulating what happens when waitForPMNormalization times out)
        result.undo_new_html = '<p>Test end append.</p></div>';
        action.result_data = result;

        const restored = await undoEdit(item, action, true);
        expect(restored).toContain('Third paragraph to provide context');
        expect(restored).not.toContain('Test end append');
    });
});


// =============================================================================
// Section 3: Full Apply-Undo-Apply-Undo Cycle
// =============================================================================

describe('full apply-undo-apply-undo cycle (no PM normalization)', () => {
    it('simple text edit survives full cycle', async () => {
        const original = PLAIN_NOTE;
        const oldStr = 'First paragraph with some text';
        const newStr = 'First paragraph with changed text';

        // Apply
        const { item, action: action1 } = await applyEdit({
            noteHtml: original, oldString: oldStr, newString: newStr,
        });
        expect(item._getHtml()).toContain('changed text');

        // Undo
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));

        // Re-apply
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY', oldStr, newStr);
        const result2 = await executeEditNoteAction(action2);
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');
        expect(item._getHtml()).toContain('changed text');

        // Re-undo
        await undoEdit(item, action2);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));
    });

    it('deletion survives full cycle', async () => {
        const original = PLAIN_NOTE;
        const oldStr = '<p>Second paragraph with more text.</p>';
        const newStr = '';

        // Apply
        const { item, action: action1 } = await applyEdit({
            noteHtml: original, oldString: oldStr, newString: newStr,
        });
        expect(item._getHtml()).not.toContain('Second paragraph');

        // Undo
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));

        // Re-apply
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY', oldStr, newStr);
        const result2 = await executeEditNoteAction(action2);
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        // Re-undo
        await undoEdit(item, action2);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));
    });
});

describe('full apply-undo-apply-undo cycle (with PM normalization)', () => {
    it('text edit with PM normalization between each step', async () => {
        const original = PLAIN_NOTE;
        const oldStr = 'First paragraph with some text';
        const newStr = 'First paragraph with <b>bold</b> text';

        // Apply + PM normalize
        const { item, action: action1 } = await applyEdit({
            noteHtml: original, oldString: oldStr, newString: newStr,
            applyPMNormalization: true,
        });

        // Undo + PM normalize
        const restored = await undoEdit(item, action1, true);
        expect(restored).toContain('First paragraph with some text');

        // Re-apply + PM normalize
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY', oldStr, newStr);
        const result2 = await executeEditNoteAction(action2);
        item._setHtml(simulatePMNormalization(item._getHtml()));
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        // Re-undo
        const restored2 = await undoEdit(item, action2, true);
        expect(restored2).toContain('First paragraph with some text');
    });

    it('multi-block insertion with PM normalization', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Second paragraph with more text.</p>',
            newString: '<p>Replaced paragraph.</p><p>Additional paragraph.</p>',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('Replaced paragraph');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('Second paragraph with more text');
        expect(restored).not.toContain('Replaced paragraph');
    });
});


// =============================================================================
// Section 4: replace_all with PM Normalization
// =============================================================================

describe('replace_all undo with PM normalization', () => {
    it('FAILS: replace_all — PM normalizes each occurrence', async () => {
        const note = wrap(
            '<p>The word test appears here.</p>'
            + '<p>Another test in this paragraph.</p>'
        );

        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'test',
            newString: '<b>exam</b>',
            operation: 'str_replace_all',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('<strong>exam</strong>');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('test');
        expect(restored).not.toContain('exam');
    });

    it('replace_all without PM normalization works', async () => {
        const note = wrap(
            '<p>Replace this word.</p>'
            + '<p>And this word too.</p>'
        );
        const { item, action } = await applyEdit({
            noteHtml: note, oldString: 'word', newString: 'term', operation: 'str_replace_all',
        });
        expect(item._getHtml()).not.toContain('word');

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section 5: Citation-Specific Undo Edge Cases
// =============================================================================

describe('citation-related undo edge cases', () => {
    it('undo text edit near citation (no PM normalization)', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION,
            oldString: 'the results are significant',
            newString: 'the findings are remarkable',
        });

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
    });

    it('undo edit between two citations to same item', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_MULTI_CITE,
            oldString: 'Methodology section',
            newString: 'Methods overview',
        });

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_MULTI_CITE));
    });

    it('insert new citation then undo with PM normalization', async () => {
        const { simplified } = simplifyNoteHtml(NOTE_WITH_CITATION, 1);
        const refMatch = simplified.match(/ref="(c_CITE1_0)"/);
        expect(refMatch).toBeTruthy();

        const oldStr = 'the results are significant';
        const newStr = 'the results are significant <citation item_id="1-NEWCITE" label="NewRef, 2025"/>';

        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION,
            oldString: oldStr,
            newString: newStr,
            applyPMNormalization: true,
        });

        const restored = await undoEdit(item, action);
        expect(restored).toContain('the results are significant');
        expect(restored).not.toContain('NEWCITE');
    });
});


// =============================================================================
// Section 6: Deletion Undo with PM Normalization
// =============================================================================

describe('deletion undo with PM normalization', () => {
    it('delete paragraph — context anchors survive when note is PM-canonical', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: '<p>Second paragraph with more text.</p>',
            newString: '',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).not.toContain('Second paragraph');

        const restored = await undoEdit(item, action);
        expect(restored).toContain('Second paragraph with more text');
    });

    it('delete text near citation — context anchors survive PM', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION,
            oldString: ', the results are significant',
            newString: '',
            applyPMNormalization: true,
        });

        const restored = await undoEdit(item, action);
        expect(restored).toContain('the results are significant');
    });
});


// =============================================================================
// Section 7: "Already Undone" Detection
// =============================================================================

describe('already-undone detection', () => {
    it('detects already-undone state correctly', async () => {
        const { item, action } = await applyEdit({
            noteHtml: PLAIN_NOTE,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with changed text',
        });

        // Undo
        await undoEdit(item, action);
        const afterFirstUndo = item._getHtml();

        // Try to undo again — should be a no-op
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        await undoEditNoteAction(action);
        expect(item._getHtml()).toBe(afterFirstUndo);
    });
});


// =============================================================================
// Section 8: Multiple Edits on Same Note
// =============================================================================

describe('multiple edits on same note', () => {
    it('two non-overlapping edits: undo second, then first', async () => {
        const original = PLAIN_NOTE;

        // Edit 1
        const { item, action: action1 } = await applyEdit({
            noteHtml: original,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with ALPHA text',
        });

        // Edit 2 on the already-edited note
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY',
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );
        const result2 = await executeEditNoteAction(action2);
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        expect(item._getHtml()).toContain('ALPHA');
        expect(item._getHtml()).toContain('BETA');

        // Undo edit 2
        await undoEdit(item, action2);
        expect(stripDataCitationItems(item._getHtml())).toContain('ALPHA');
        expect(stripDataCitationItems(item._getHtml())).not.toContain('BETA');

        // Undo edit 1
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));
    });

    it('two non-overlapping edits: undo first, then second (out of order)', async () => {
        const original = PLAIN_NOTE;

        // Edit 1
        const { item, action: action1 } = await applyEdit({
            noteHtml: original,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with ALPHA text',
        });

        // Edit 2
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY',
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );
        const result2 = await executeEditNoteAction(action2);
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        // Undo edit 1 FIRST (out of order)
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).not.toContain('ALPHA');
        expect(stripDataCitationItems(item._getHtml())).toContain('BETA');

        // Undo edit 2
        await undoEdit(item, action2);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));
    });

    it('two edits with PM normalization — undo out of order', async () => {
        const original = PLAIN_NOTE;

        // Edit 1: insert bold text (non-canonical <b>)
        const { item, action: action1 } = await applyEdit({
            noteHtml: original,
            oldString: 'First paragraph with some text',
            newString: 'First paragraph with <b>ALPHA</b> text',
            applyPMNormalization: true,
        });

        // Edit 2: change third paragraph (plain text, no PM change)
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY',
            'Third paragraph to provide context',
            'Third paragraph with BETA context'
        );
        const result2 = await executeEditNoteAction(action2);
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        // Undo edit 1 (out of order) — undo_new_html has <b> but note has <strong>
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toContain('First paragraph with some text');
        expect(stripDataCitationItems(item._getHtml())).toContain('BETA');
    });
});


// =============================================================================
// Section 9: Whitespace and Special Characters
// =============================================================================

describe('whitespace and special character edge cases', () => {
    it('edit with HTML entities in text', async () => {
        const note = wrap('<p>Smith &amp; Jones (2024) found that x &lt; y.</p>');
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'Smith &amp; Jones (2024)',
            newString: 'Smith &amp; Wesson (2024)',
        });

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(note));
    });

    it('undo works when PM decodes HTML entities (&#x27; → apostrophe)', async () => {
        // Reproduces the bug: note contains &#x27; which PM decodes to literal '
        // Edit is applied while the editor is NOT open (entities preserved in HTML),
        // then PM normalizes the note afterward, decoding entities.
        const note = wrap(
            '<p>Sayeh Dashti&#x27;s memoir <em>You Belong</em> recounts her story.</p>'
        );
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'Sayeh Dashti&#x27;s memoir',
            newString: 'Sayeh Dashti&#x27;s MEMOIR',
            // No PM normalization during apply — editor is closed
        });

        // Verify edit applied with entities intact
        expect(item._getHtml()).toContain('Sayeh Dashti&#x27;s MEMOIR');

        // Now simulate PM normalizing the note (editor opens, or Notifier fires)
        item._setHtml(simulatePMNormalization(item._getHtml()));
        expect(item._getHtml()).toContain("Sayeh Dashti's MEMOIR");
        expect(item._getHtml()).not.toContain('&#x27;');

        // Undo should work despite entity mismatch between stored undo data and note
        invalidateSimplificationCache('1-TESTKEY');
        const restored = await undoEdit(item, action);
        expect(restored).toContain("Dashti's memoir");
        expect(restored).not.toContain('MEMOIR');
    });

    it('re-apply works after undo when PM decoded entities', async () => {
        // Full roundtrip: apply → PM normalizes → undo → re-apply
        // Re-apply fails if old_string has &#x27; but note now has ' (decoded by PM)
        const note = wrap(
            '<p>Sayeh Dashti&#x27;s memoir <em>You Belong</em> recounts her story.</p>'
        );
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'Sayeh Dashti&#x27;s memoir',
            newString: 'Sayeh Dashti&#x27;s MEMOIR',
        });

        // Simulate PM normalizing the note
        item._setHtml(simulatePMNormalization(item._getHtml()));
        invalidateSimplificationCache('1-TESTKEY');

        // Undo
        await undoEdit(item, action);
        expect(item._getHtml()).toContain("Dashti's memoir");

        // Re-apply: action still has &#x27; in proposed_data, but note has '
        action.status = 'pending';
        action.result_data = undefined;
        invalidateSimplificationCache('1-TESTKEY');
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);

        const result2 = await executeEditNoteAction(action);
        expect(result2.occurrences_replaced).toBe(1);
        expect(item._getHtml()).toContain("Dashti's MEMOIR");
    });

    it('entity decode does not corrupt structural entities (&lt; &gt; &amp;)', async () => {
        // Note contains &#x27; (decoded by PM) and &lt;b&gt; (preserved by PM)
        const note = wrap(
            '<p>Dashti&#x27;s note says &lt;b&gt;bold&lt;/b&gt; is important.</p>'
        );
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'Dashti&#x27;s note says &lt;b&gt;bold&lt;/b&gt; is important',
            newString: 'Dashti&#x27;s note says &lt;b&gt;BOLD&lt;/b&gt; is important',
        });

        // PM normalizes &#x27; → ' but keeps &lt;/&gt; intact
        item._setHtml(simulatePMNormalization(item._getHtml()));
        expect(item._getHtml()).toContain("Dashti's");
        expect(item._getHtml()).toContain('&lt;b&gt;BOLD&lt;/b&gt;');

        // Re-apply after undo should not corrupt &lt; into actual <b> tags
        invalidateSimplificationCache('1-TESTKEY');
        await undoEdit(item, action);
        expect(item._getHtml()).toContain('&lt;b&gt;bold&lt;/b&gt;');

        action.status = 'pending';
        action.result_data = undefined;
        invalidateSimplificationCache('1-TESTKEY');
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);

        const result2 = await executeEditNoteAction(action);
        expect(result2.occurrences_replaced).toBe(1);
        // Structural entities must be preserved, not decoded to actual markup
        expect(item._getHtml()).toContain('&lt;b&gt;BOLD&lt;/b&gt;');
        expect(item._getHtml()).not.toMatch(/<b>BOLD<\/b>/);
    });

    it('apply works when model uses literal apostrophe but note has &#x27; (reverse direction)', async () => {
        // The model was instructed to use literal ' but the note has &#x27;
        const note = wrap(
            '<p>Sayeh Dashti&#x27;s memoir <em>You Belong</em> recounts her story.</p>'
        );
        const { item, action } = await applyEdit({
            noteHtml: note,
            // Model uses literal ' — doesn't match &#x27; without the encode fallback
            oldString: "Sayeh Dashti's memoir",
            newString: "Sayeh Dashti's MEMOIR",
        });

        // Edit should succeed via encodeTextEntities fallback
        expect(item._getHtml()).toContain('MEMOIR');
        expect(item._getHtml()).not.toContain('memoir');
    });

    it('apply works with decimal entity &#39; (non-canonical form)', async () => {
        // Imported HTML may use &#39; instead of &#x27;
        const note = wrap(
            '<p>Sayeh Dashti&#39;s memoir <em>You Belong</em> recounts her story.</p>'
        );
        const { item } = await applyEdit({
            noteHtml: note,
            oldString: "Sayeh Dashti's memoir",
            newString: "Sayeh Dashti's MEMOIR",
        });
        expect(item._getHtml()).toContain('MEMOIR');
    });

    it('apply works with named entity &apos; (non-canonical form)', async () => {
        const note = wrap(
            '<p>Sayeh Dashti&apos;s memoir recounts her story.</p>'
        );
        const { item } = await applyEdit({
            noteHtml: note,
            oldString: "Sayeh Dashti's memoir",
            newString: "Sayeh Dashti's MEMOIR",
        });
        expect(item._getHtml()).toContain('MEMOIR');
    });

    it('edit with unicode characters', async () => {
        const note = wrap('<p>Résumé of François and naïve coöperation.</p>');
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'François',
            newString: 'Jean-François',
        });

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section 10: List-Specific Edge Cases
// =============================================================================

describe('list editing edge cases', () => {
    it('edit list item text (no PM normalization)', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_LIST,
            oldString: 'Second item',
            newString: 'Modified item',
        });

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_WITH_LIST));
    });

    it('add list item with bold — PM converts <b> to <strong>', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_LIST,
            oldString: 'Third item',
            newString: 'Third item and <b>new</b> content',
            applyPMNormalization: true,
        });
        expect(item._getHtml()).toContain('<strong>new</strong>');

        const restored = await undoEdit(item, action);
        expect(restored).not.toContain('new content');
    });
});


// =============================================================================
// Section 11: Page Locator Normalization in Apply-Undo Cycle
// =============================================================================

describe('page locator normalization in apply-undo cycle', () => {
    it('insert new citation with page range: apply + undo restores original', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION,
            oldString: 'the results are significant',
            newString: 'the results are significant <citation item_id="1-RANGECIT" page="50-55"/>',
        });

        // The citation should have been created with normalized page "50"
        const { createCitationHTML } = await import('../../../src/utils/zoteroUtils');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'RANGECIT' }),
            '50'
        );
        expect(item._getHtml()).toContain('RANGECIT');

        // Undo should restore the original
        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
        expect(restored).not.toContain('RANGECIT');
    });

    it('insert new citation with comma-separated pages: apply + undo restores original', async () => {
        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION,
            oldString: 'Further analysis reveals important patterns',
            newString: 'Further analysis reveals important patterns <citation item_id="1-COMMACIT" page="222, 237-238"/>',
        });

        const { createCitationHTML } = await import('../../../src/utils/zoteroUtils');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'COMMACIT' }),
            '222'
        );

        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
    });

    it('full apply-undo-apply-undo cycle with page-range citation', async () => {
        const original = NOTE_WITH_CITATION;
        const oldStr = 'the results are significant';
        const newStr = 'the results are significant <citation item_id="1-CYCLEREF" page="241-243"/>';

        // Apply
        const { item, action: action1 } = await applyEdit({
            noteHtml: original, oldString: oldStr, newString: newStr,
        });
        expect(item._getHtml()).toContain('CYCLEREF');

        // Undo
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));
        expect(item._getHtml()).not.toContain('CYCLEREF');

        // Re-apply
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        const action2 = makeAction(1, 'TESTKEY', oldStr, newStr);
        const result2 = await executeEditNoteAction(action2);
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');
        expect(item._getHtml()).toContain('CYCLEREF');

        // Re-undo
        await undoEdit(item, action2);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(original));
    });

    it('existing citation page changed to range: normalized, apply + undo works', async () => {
        // Note has a citation with page="42"
        const { simplified } = simplifyNoteHtml(NOTE_WITH_CITATION, 1);
        const citTag = simplified.match(/<citation [^/]*ref="c_CITE1_0"[^/]*\/>/)?.[0];
        expect(citTag).toBeTruthy();
        expect(citTag).toContain('page="42"');

        // LLM changes page to a range
        const modifiedTag = citTag!.replace('page="42"', 'page="42-48"');
        const oldStr = citTag!;
        const newStr = modifiedTag;

        const { item, action } = await applyEdit({
            noteHtml: NOTE_WITH_CITATION, oldString: oldStr, newString: newStr,
        });

        // Should have been called with normalized page "42" (same as original)
        const { createCitationHTML } = await import('../../../src/utils/zoteroUtils');
        expect(createCitationHTML).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'CITE1' }),
            '42'
        );

        // Undo should restore the original
        const restored = await undoEdit(item, action);
        expect(restored).toBe(stripDataCitationItems(NOTE_WITH_CITATION));
    });
});


// =============================================================================
// Section 12: Stale Undo Data — Server-Side Handler Bug Scenario
//
// Before the fix, the server-side handler did not call waitForPMNormalization,
// so undo_new_html stored the pre-PM HTML. When ProseMirror restructured the
// HTML (e.g., inline styles → semantic elements), undo would fail because
// the stored undo_new_html didn't match the actual note content.
//
// These tests demonstrate that:
// - Without PM refresh, undo fails (the bug)
// - With PM refresh, undo succeeds (the fix)
// =============================================================================

describe('stale undo data (server-side handler bug scenario)', () => {
    it('undo succeeds with stale undo data via text-content fallback when PM converts <b> to <strong>', async () => {
        const note = wrap(
            '<p>Some existing text.</p>\n'
            + '<p>More text here.</p>\n'
        );

        // Apply edit WITHOUT PM normalization during execute — simulates
        // case where waitForPMNormalization missed the change
        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'More text here.',
            newString: '<b>Important:</b> Modified text.',
            applyPMNormalization: false,
        });

        // undo_new_html has pre-PM format (with <b>)
        expect(action.result_data!.undo_new_html).toContain('<b>');
        expect(action.result_data!.undo_new_html).not.toContain('<strong>');

        // Manually apply PM normalization (as if PM processed the note after save)
        item._setHtml(simulatePMNormalization(item._getHtml()));
        invalidateSimplificationCache('1-TESTKEY');

        // Undo succeeds via text-content fallback: PM changed <b> to <strong>
        // but the visible text is the same, so context anchors are trusted.
        const restored = await undoEdit(item, action);
        expect(restored).toContain('More text here.');
        expect(restored).not.toContain('Important');
    });

    it('undo succeeds with PM-refreshed undo data (the fix)', async () => {
        const note = wrap(
            '<p>Some existing text.</p>\n'
            + '<p>More text here.</p>\n'
        );

        // Same edit but WITH PM normalization during execute — simulates
        // fixed server-side handler that calls waitForPMNormalization
        const { item, action, result } = await applyEdit({
            noteHtml: note,
            oldString: 'More text here.',
            newString: '<b>Important:</b> Modified text.',
            applyPMNormalization: true,
        });

        // undo_new_html was updated to PM-normalized format
        expect(result.undo_new_html).toContain('<strong>');
        expect(result.undo_new_html).not.toContain('<b>');

        // Undo should succeed
        const restored = await undoEdit(item, action);
        expect(restored).toContain('More text here.');
        expect(restored).not.toContain('Modified text');
    });

    it('inline style "font-weight: bold" → PM converts to <strong> wrapper', async () => {
        const note = wrap(
            '<p>Existing content.</p>\n'
            + '<p>Final paragraph.</p>\n'
        );

        // Without PM refresh: stale undo data, but text-content fallback handles it
        const { item: item1, action: action1 } = await applyEdit({
            noteHtml: note,
            oldString: 'Final paragraph.',
            newString: '<p style="font-weight: bold;">Bold via style.</p>',
            applyPMNormalization: false,
        });
        item1._setHtml(simulatePMNormalization(item1._getHtml()));
        invalidateSimplificationCache('1-TESTKEY');
        const restored1 = await undoEdit(item1, action1);
        expect(restored1).toContain('Final paragraph.');

        // With PM refresh: undo also succeeds (via exact match)
        const { item: item2, action: action2, result } = await applyEdit({
            noteHtml: note,
            oldString: 'Final paragraph.',
            newString: '<p style="font-weight: bold;">Bold via style.</p>',
            applyPMNormalization: true,
        });
        expect(result.undo_new_html).toContain('<strong>');
        expect(result.undo_new_html).not.toContain('font-weight');

        const restored = await undoEdit(item2, action2);
        expect(restored).toContain('Final paragraph.');
    });

    it('exact bug report: color+bold style at end of note → PM restructures', async () => {
        // Reproduces the exact pattern from the bug report:
        // <p style="color: blue; font-weight: bold;">[text]</p>
        // → PM converts to <p><strong><span style="color: blue;">[text]</span></strong></p>
        const note = wrap(
            '<p>Some content.</p>\n'
            + '<p><strong>Note:</strong> Important info.</p>\n'
        );

        // Without PM refresh: stale undo data, but text-content fallback handles it
        const { item: item1, action: action1 } = await applyEdit({
            noteHtml: note,
            oldString: '</div>',
            newString: '<p style="color: blue; font-weight: bold;">[Test Edit #3]</p>\n</div>',
            applyPMNormalization: false,
        });
        // undo_new_html still has the inline style
        expect(action1.result_data!.undo_new_html).toContain('style="color: blue; font-weight: bold;"');

        item1._setHtml(simulatePMNormalization(item1._getHtml()));
        invalidateSimplificationCache('1-TESTKEY');
        const restored1 = await undoEdit(item1, action1);
        expect(restored1).toContain('Some content.');
        expect(restored1).not.toContain('Test Edit #3');

        // With PM refresh: undo data is updated → undo also succeeds
        const { item: item2, action: action2, result } = await applyEdit({
            noteHtml: note,
            oldString: '</div>',
            newString: '<p style="color: blue; font-weight: bold;">[Test Edit #3]</p>\n</div>',
            applyPMNormalization: true,
        });

        // undo_new_html should now have PM-normalized structure
        expect(result.undo_new_html).toContain('<strong>');
        expect(result.undo_new_html).toContain('style="color: blue;"');
        expect(result.undo_new_html).not.toContain('style="color: blue; font-weight: bold;"');

        const restored = await undoEdit(item2, action2);
        expect(restored).not.toContain('Test Edit');
        expect(restored).toBe(stripDataCitationItems(note));
    });

    it('multiple sequential edits: each undo works with PM refresh', async () => {
        // Simulates multiple edits in one agent run — each with PM refresh
        const note = wrap(
            '<p>First paragraph.</p>\n'
            + '<p>Second paragraph.</p>\n'
        );

        // Edit 1: simple text change
        const { item, action: action1, result: result1 } = await applyEdit({
            noteHtml: note,
            oldString: 'First paragraph.',
            newString: 'First paragraph. <i>Added italic.</i>',
            applyPMNormalization: true,
        });
        expect(result1.undo_new_html).toContain('<em>');

        // Edit 2: add styled paragraph at end (like the bug report)
        const action2 = makeAction(1, 'TESTKEY', '</div>',
            '<p style="color: blue; font-weight: bold;">[New paragraph]</p>\n</div>');
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        // Set up PM editor for this edit too
        setupPMNormalizingEditor(item);
        const result2 = await executeEditNoteAction(action2);
        item._setHtml(simulatePMNormalization(item._getHtml()));
        action2.status = 'applied';
        action2.result_data = result2;
        invalidateSimplificationCache('1-TESTKEY');

        expect(result2.undo_new_html).toContain('<strong>');

        // Undo edit 2 first
        (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(item);
        await undoEditNoteAction(action2);
        invalidateSimplificationCache('1-TESTKEY');

        // Note should still have edit 1's changes
        expect(item._getHtml()).toContain('<em>');
        expect(item._getHtml()).not.toContain('New paragraph');

        // Undo edit 1
        await undoEdit(item, action1);
        expect(stripDataCitationItems(item._getHtml())).toBe(stripDataCitationItems(note));
    });
});


// =============================================================================
// Section: Text-Content Fallback for PM Structural Changes
// =============================================================================

describe('text-content fallback for PM structural changes', () => {
    it('undo succeeds when PM restructures inline styles to semantic wrappers', async () => {
        // PM converts <p style="font-weight: bold; color: blue;">text</p>
        // into <p><strong><span style="color: blue;">text</span></strong></p>
        // The text content is the same but HTML structure is completely different.
        const note = wrap(
            '<h1>Title</h1>\n'
            + '<p>Some paragraph.</p>\n'
        );

        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: '<p>Some paragraph.</p>',
            newString: '<p>Some paragraph.</p>\n<p style="font-weight: bold; color: blue;">Styled addition</p>',
            applyPMNormalization: false,
        });

        // Simulate PM normalization (restructures style to semantic tags)
        item._setHtml(simulatePMNormalization(item._getHtml()));
        invalidateSimplificationCache('1-TESTKEY');

        // The undo_new_html still has the inline style version
        expect(action.result_data!.undo_new_html).toContain('font-weight: bold');

        // Undo succeeds via text-content fallback
        const restored = await undoEdit(item, action);
        expect(restored).toContain('Some paragraph.');
        expect(restored).not.toContain('Styled addition');
    });

    it('undo still fails when text content genuinely differs (manual edit)', async () => {
        const note = wrap(
            '<p>Original paragraph.</p>\n'
            + '<p>Second paragraph.</p>\n'
        );

        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'Second paragraph.',
            newString: 'Modified text here.',
            applyPMNormalization: false,
        });

        // Simulate user manually editing the note (different text content)
        item._setHtml(item._getHtml().replace('Modified text here.', 'User changed this completely.'));
        invalidateSimplificationCache('1-TESTKEY');

        // Undo should fail — text content is genuinely different
        await expect(undoEdit(item, action)).rejects.toThrow('Cannot undo');
    });

    it('text-content fallback requires context anchors (not just raw anchors)', async () => {
        const note = wrap(
            '<p>First section.</p>\n'
            + '<p>Unique context before the edit.</p>\n'
            + '<p>Target text.</p>\n'
            + '<p>Unique context after the edit.</p>\n'
        );

        const { item, action } = await applyEdit({
            noteHtml: note,
            oldString: 'Target text.',
            newString: '<b>Target text.</b>',
            applyPMNormalization: false,
        });

        // PM converts <b> to <strong> — same text, different structure
        item._setHtml(simulatePMNormalization(item._getHtml()));
        invalidateSimplificationCache('1-TESTKEY');

        // Context anchors are present → text-content fallback works
        expect(action.result_data!.undo_before_context).toBeTruthy();
        expect(action.result_data!.undo_after_context).toBeTruthy();

        const restored = await undoEdit(item, action);
        expect(restored).toContain('Target text.');
        expect(restored).not.toContain('<strong>');
    });
});
