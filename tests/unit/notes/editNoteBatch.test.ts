import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports) — mirrors editNote.test.ts so the full
// handler import graph (all action modules) loads under test.
// =============================================================================

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn((_noteId: string, rawHtml: string, _libId: number) => ({
        simplified: rawHtml.replace(/<[^>]+>/g, ''), // Crude strip-tags for testing
        metadata: { elements: new Map() },
        isStale: false,
    })),
    countOccurrences: vi.fn((haystack: string, needle: string) => {
        if (!needle) return 0;
        let count = 0;
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
        return count;
    }),
    invalidateSimplificationCache: vi.fn(),
    normalizeNoteHtml: vi.fn((html: string) => html),
    simplifyNoteHtml: vi.fn((rawHtml: string) => ({
        simplified: rawHtml,
        metadata: { elements: new Map() },
    })),
}));

vi.mock('../../../src/utils/editNoteValidation', async () => {
    const enrichMock = vi.fn((_oldString: string, _metadata: any) => null as string | null);
    const actual = await vi.importActual<typeof import('../../../src/utils/editNoteValidation')>(
        '../../../src/utils/editNoteValidation'
    );
    return {
        validateNewString: vi.fn(() => null),
        checkNewCitationItemsExist: vi.fn(() => null),
        checkDuplicateCitations: vi.fn(() => null),
        enrichOldStringCitationRefs: enrichMock,
        applyOldStringEnrichment: vi.fn((oldString: string | undefined, metadata: any) => {
            if (!oldString) return oldString;
            const enriched = enrichMock(oldString, metadata);
            return enriched ?? oldString;
        }),
        detectPartialSimplifiedTag: actual.detectPartialSimplifiedTag,
        buildPartialSimplifiedTagMessage: actual.buildPartialSimplifiedTagMessage,
    };
});

vi.mock('../../../src/utils/noteHtmlEntities', () => {
    const CJK_RE = new RegExp(
        '[\\u3000-\\u303F'
        + '\\u3040-\\u30FF'
        + '\\u31F0-\\u31FF'
        + '\\u3400-\\u4DBF'
        + '\\u4E00-\\u9FFF'
        + '\\uA960-\\uA97F'
        + '\\uAC00-\\uD7AF'
        + '\\uF900-\\uFAFF'
        + '\\uFF00-\\uFFEF]',
    );
    const isCjkChar = (ch: string) => !!ch && CJK_RE.test(ch);
    return {
        decodeHtmlEntities: vi.fn((s: string) => s),
        encodeTextEntities: vi.fn((s: string) => s),
        ENTITY_FORMS: ['hex', 'decimal', 'named'],
        foldTypographicQuotes: vi.fn((s: string) => s),
        normalizeWS: vi.fn((s: string) =>
            s.replace(/(?:\s|&nbsp;)+/g, ' ').trim()),
        hasWhitespaceOrNbsp: vi.fn((s: string) => /(?:\s|&nbsp;)/.test(s)),
        isCjkChar: vi.fn(isCjkChar),
        hasCjkAsciiBoundary: vi.fn((s: string) => {
            for (let i = 1; i < s.length; i++) {
                const a = s.charAt(i - 1);
                const b = s.charAt(i);
                if (/\s/.test(a) || /\s/.test(b)) continue;
                if (isCjkChar(a) !== isCjkChar(b)) return true;
            }
            return false;
        }),
        normalizeCjkSpacing: vi.fn((s: string) => {
            const isHtmlDelim = (ch: string) => /[<>="'/]/.test(ch);
            const collapsed = s.replace(/(?:\s|&nbsp;)+/g, ' ').trim();
            let out = '';
            let inTag = false;
            for (let i = 0; i < collapsed.length; i++) {
                const ch = collapsed.charAt(i);
                if (ch === '<') inTag = true;
                if (ch === ' ' && !inTag) {
                    const prev = i > 0 ? collapsed.charAt(i - 1) : '';
                    const next = i + 1 < collapsed.length ? collapsed.charAt(i + 1) : '';
                    if (
                        prev && next
                        && !isHtmlDelim(prev) && !isHtmlDelim(next)
                        && isCjkChar(prev) !== isCjkChar(next)
                    ) continue;
                }
                out += ch;
                if (ch === '>') inTag = false;
            }
            return out;
        }),
        normalizeCjkSpacingMapped: vi.fn((s: string) => ({
            text: s,
            indexMap: Array.from({ length: s.length + 1 }, (_, k) => k),
        })),
        WS_OR_NBSP_CLASS: '(?:\\s|&nbsp;)',
    };
});

vi.mock('../../../src/utils/noteWrapper', () => ({
    stripDataCitationItems: vi.fn((html: string) => html),
    extractDataCitationItems: vi.fn(() => null),
    rebuildDataCitationItems: vi.fn((html: string) => html),
    hasSchemaVersionWrapper: vi.fn((html: string) => html.includes('data-schema-version=')),
    stripNoteWrapperDiv: vi.fn((html: string) => {
        const trimmed = html.trim();
        if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) return html;
        const closeAngle = trimmed.indexOf('>');
        if (closeAngle === -1) return html;
        return trimmed.substring(closeAngle + 1, trimmed.length - 6);
    }),
}));

vi.mock('../../../src/utils/noteEditorIO', () => ({
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    isNoteInEditor: vi.fn(() => false),
    waitForPMNormalization: vi.fn().mockResolvedValue(undefined),
    waitForNoteSaveStabilization: vi.fn().mockResolvedValue(undefined),
    flushLiveEditorToDB: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../src/utils/noteCitationExpand', () => ({
    expandToRawHtml: vi.fn((str: string, _metadata: any, _context: string) => str),
    preloadPageLabelsForNewCitations: vi.fn().mockResolvedValue({}),
    preloadNotePageLabels: vi.fn().mockResolvedValue({}),
    preloadStructuralLocatorPages: vi.fn().mockResolvedValue({ pages: {}, unresolved: [] }),
    buildUnresolvedLocatorWarning: vi.fn(() => null),
}));

vi.mock('../../../src/utils/editNoteStrippers', () => ({
    stripPartialSimplifiedElements: vi.fn(() => null),
    stripSpuriousWrappingTags: vi.fn(() => []),
}));

vi.mock('../../../src/utils/editNoteHints', () => ({
    findCandidateSnippets: vi.fn(() => []),
    findStructuralAnchorHint: vi.fn(() => null),
    findInlineTagDriftMatch: vi.fn(() => null),
    findWindowCandidates: vi.fn(() => []),
    centerTruncate: vi.fn((text: string) => ({ snippet: text, truncated: false })),
    DEFAULT_MAX_SNIPPET_LENGTH: 200,
}));

vi.mock('../../../src/utils/editNoteRawPosition', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/editNoteRawPosition')>(
        '../../../src/utils/editNoteRawPosition'
    );
    return {
        ...actual,
        findUniqueRawMatchPosition: vi.fn(() => null),
        captureValidatedEditTargetContext: vi.fn(() => null),
        findTargetRawMatchPosition: vi.fn(() => null),
    };
});

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

vi.mock('../../../react/utils/sourceUtils', () => ({
    clearNoteEditorSelection: vi.fn(),
}));

vi.mock('../../../react/utils/citationRenderers', () => ({
    renderToHTML: vi.fn((content: string) => content),
}));

vi.mock('../../../react/utils/citationRenderContext', () => ({
    prepareCitationRenderContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 2]) },
}));

vi.mock('../../../react/atoms/citations', () => ({
    citationMapAtom: Symbol('citationMapAtom'),
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} is excluded from Beaver.`),
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    canSetField: vi.fn(() => true),
    SETTABLE_PRIMARY_FIELDS: [],
    sanitizeCreators: vi.fn((c: any) => c),
    createCitationHTML: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: vi.fn().mockResolvedValue([]),
    BatchReferenceCheckItem: {},
}));

vi.mock('../../../react/utils/addItemActions', () => ({
    applyCreateItemData: vi.fn(),
}));

// =============================================================================
// Imports
// =============================================================================

import { handleAgentActionValidateRequest } from '../../../src/services/agentDataProvider/handleAgentActionValidateRequest';
import { handleAgentActionExecuteRequest } from '../../../src/services/agentDataProvider/handleAgentActionExecuteRequest';
import {
    getOrSimplify,
    countOccurrences,
    invalidateSimplificationCache,
    simplifyNoteHtml,
} from '../../../src/utils/noteHtmlSimplifier';
import { validateNewString } from '../../../src/utils/editNoteValidation';
import { findCandidateSnippets } from '../../../src/utils/editNoteHints';
import {
    stripDataCitationItems,
    rebuildDataCitationItems,
} from '../../../src/utils/noteWrapper';
import { getLatestNoteHtml } from '../../../src/utils/noteEditorIO';
import { expandToRawHtml, preloadPageLabelsForNewCitations } from '../../../src/utils/noteCitationExpand';
import { getDeferredToolPreference, checkLibraryExcluded } from '../../../src/services/agentDataProvider/utils';
import { store } from '../../../react/store';
import { renderToHTML } from '../../../react/utils/citationRenderers';
import {
    executeEditNoteBatchAction as executeLocalEditNoteBatchAction,
    undoEditNoteBatchAction as undoLocalEditNoteBatchAction,
} from '../../../react/utils/editNoteActions';
import type {
    WSAgentActionValidateRequest,
    WSAgentActionExecuteRequest,
} from '../../../src/services/agentProtocol';
import type { EditNoteBatchEditItem } from '../../../react/types/agentActions/editNoteBatch';


// =============================================================================
// Helpers
// =============================================================================

// Three distinct sentences so multi-edit batches are realistic.
const NOTE_HTML = '<div data-schema-version="9"><p>Alpha sentence one.</p><p>Bravo passage two.</p><p>Charlie section three.</p></div>';

function makeValidateRequest(
    edits: EditNoteBatchEditItem[],
    actionDataOverrides: Record<string, any> = {},
): WSAgentActionValidateRequest {
    return {
        event: 'agent_action_validate',
        request_id: 'val-1',
        action_type: 'edit_note_batch',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            edits,
            ...actionDataOverrides,
        },
    } as unknown as WSAgentActionValidateRequest;
}

function makeExecuteRequest(
    edits: EditNoteBatchEditItem[],
    actionDataOverrides: Record<string, any> = {},
): WSAgentActionExecuteRequest {
    return {
        event: 'agent_action_execute',
        request_id: 'exe-1',
        action_type: 'edit_note_batch',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            edits,
            ...actionDataOverrides,
        },
    } as unknown as WSAgentActionExecuteRequest;
}

function makeMockItem(overrides: any = {}) {
    return {
        isNote: vi.fn(() => true),
        isRegularItem: vi.fn(() => false),
        isAttachment: vi.fn(() => false),
        isAnnotation: vi.fn(() => false),
        itemType: 'note',
        libraryID: 1,
        key: 'NOTE0001',
        id: 42,
        loadDataType: vi.fn().mockResolvedValue(undefined),
        getNote: vi.fn(() => NOTE_HTML),
        setNote: vi.fn(),
        getNoteTitle: vi.fn(() => 'My Note'),
        saveTx: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

/**
 * Wire a note into the mocked Zotero + simplifier. The mocked pipeline is
 * identity end-to-end (normalize/strip/expand), so `simplified` and the match
 * haystack both equal the raw note HTML — matching runs on plain text.
 */
function useNote(noteHtml: string) {
    const item = makeMockItem({ getNote: vi.fn(() => noteHtml) });
    (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
    vi.mocked(getOrSimplify).mockReturnValue({
        simplified: noteHtml,
        metadata: { elements: new Map() } as any,
        isStale: false,
    });
    vi.mocked(getLatestNoteHtml).mockImplementation((it: any) => it.getNote());
    return item;
}


// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();

    const mockItem = makeMockItem();

    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Libraries: {
            get: vi.fn((id: number) => ({
                name: `Library ${id}`,
                editable: true,
            })),
        },
        Items: {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(mockItem),
        },
    };

    vi.mocked(store.get).mockReturnValue([1, 2]);

    vi.mocked(getOrSimplify).mockReturnValue({
        simplified: NOTE_HTML,
        metadata: { elements: new Map() } as any,
        isStale: false,
    });
    vi.mocked(expandToRawHtml).mockImplementation((str: string) => str);
    vi.mocked(stripDataCitationItems).mockImplementation((html: string) => html);
    vi.mocked(rebuildDataCitationItems).mockImplementation((html: string) => html);
    vi.mocked(countOccurrences).mockImplementation((haystack: string, needle: string) => {
        if (!needle) return 0;
        let count = 0;
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
        return count;
    });
    vi.mocked(simplifyNoteHtml).mockImplementation((rawHtml: string) => ({
        simplified: rawHtml,
        metadata: { elements: new Map() } as any,
    }));
    vi.mocked(renderToHTML).mockImplementation((content: string) => content);
    vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());
    vi.mocked(validateNewString).mockReturnValue(null);
    vi.mocked(findCandidateSnippets).mockReturnValue([]);
    vi.mocked(getDeferredToolPreference).mockReturnValue('always_ask');
    vi.mocked(invalidateSimplificationCache).mockImplementation(() => {});
    vi.mocked(preloadPageLabelsForNewCitations).mockResolvedValue({});
    vi.mocked(checkLibraryExcluded).mockReturnValue(null);
});


// =============================================================================
// Local UI mutation path — exclusion + targeted undo guards
// =============================================================================

describe('local edit_note_batch mutation guards', () => {
    const proposedData = {
        library_id: 1,
        zotero_key: 'NOTE0001',
        edits: [{
            index: 0,
            operation: 'str_replace' as const,
            old_string: 'Alpha',
            new_string: 'ALPHA',
        }],
    };

    it('rejects re-apply before looking up an item in a newly excluded library', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValueOnce({
            message: 'Library 1 is excluded from Beaver.',
        });
        const action = {
            id: 'batch-local-apply',
            action_type: 'edit_note_batch',
            proposed_data: proposedData,
        } as any;

        await expect(executeLocalEditNoteBatchAction(action)).rejects.toThrow(
            'Library 1 is excluded from Beaver.',
        );
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('rejects undo before looking up an item in a newly excluded library', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValueOnce({
            message: 'Library 1 is excluded from Beaver.',
        });
        const action = {
            id: 'batch-local-undo',
            action_type: 'edit_note_batch',
            proposed_data: proposedData,
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                applied: [{ index: 0, occurrences_replaced: 1 }],
                undo: [{
                    index: 0,
                    operation: 'str_replace',
                    undo_old_html: 'Alpha',
                    undo_new_html: 'ALPHA',
                }],
            },
        } as any;

        await expect(undoLocalEditNoteBatchAction(action)).rejects.toThrow(
            'Library 1 is excluded from Beaver.',
        );
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('replace-all undo changes only the occurrences recorded by this action', async () => {
        const editedHtml = '<div><p>bar targeted</p><p>bar unrelated</p></div>';
        const item = makeMockItem({ getNote: vi.fn(() => editedHtml) });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn()
            .mockResolvedValue(item);
        const action = {
            id: 'batch-local-replace-all-undo',
            action_type: 'edit_note_batch',
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                edits: [{
                    index: 0,
                    operation: 'str_replace_all',
                    old_string: 'foo',
                    new_string: 'bar',
                }],
            },
            result_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                applied: [{ index: 0, occurrences_replaced: 1 }],
                undo: [{
                    index: 0,
                    operation: 'str_replace_all',
                    undo_old_html: 'foo',
                    undo_new_html: 'bar',
                    undo_occurrence_contexts: [{
                        before: '<div><p>',
                        after: ' targeted</p><p>bar unrelated</p></div>',
                    }],
                }],
            },
        } as any;

        await undoLocalEditNoteBatchAction(action);

        expect(item.setNote).toHaveBeenCalledWith(
            '<div><p>foo targeted</p><p>bar unrelated</p></div>',
        );
        expect(item.saveTx).toHaveBeenCalledTimes(1);
    });
});


// =============================================================================
// Validate — Success
// =============================================================================

describe('validateEditNoteBatchAction — success', () => {
    it('validates a happy-path batch of 3 str_replace edits with current_value and no edit_errors', async () => {
        useNote(NOTE_HTML);
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, client_item_id: 'c-0', operation: 'str_replace', old_string: 'Alpha sentence one.', new_string: 'ALPHA SENTENCE 1.' },
            { index: 1, client_item_id: 'c-1', operation: 'str_replace', old_string: 'Bravo passage two.', new_string: 'BRAVO PASSAGE 2.' },
            { index: 2, client_item_id: 'c-2', operation: 'str_replace', old_string: 'Charlie section three.', new_string: 'CHARLIE SECTION 3.' },
        ]));

        expect(response.valid).toBe(true);
        expect((response as any).edit_errors).toBeUndefined();
        expect(response.current_value).toEqual({
            note_title: 'My Note',
            total_lines: 1,
        });
        expect(response.preference).toBe('always_ask');
        // Exact matches → nothing normalized → no normalized_action_data.
        expect(response.normalized_action_data).toBeUndefined();
    });

    it('resolves preference the same way as v1 edit_note (getDeferredToolPreference passthrough)', async () => {
        useNote(NOTE_HTML);
        vi.mocked(getDeferredToolPreference).mockReturnValueOnce('always_apply');
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence one.', new_string: 'X.' },
        ]));
        expect(response.valid).toBe(true);
        expect(response.preference).toBe('always_apply');
    });

    it('accepts adjacent edits on consecutive spans (a.end === b.start)', async () => {
        useNote(NOTE_HTML);
        // 'Alpha ' ends exactly where 'sentence one.' begins.
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha ', new_string: 'ALPHA ' },
            { index: 1, operation: 'str_replace', old_string: 'sentence one.', new_string: 'sentence 1.' },
        ]));
        expect(response.valid).toBe(true);
        expect((response as any).edit_errors).toBeUndefined();
    });

    it('emits normalized_action_data preserving index/client_item_id and length/order when the matcher rewrites an old_string', async () => {
        // Trailing-whitespace fixture (mirrors editNote.test.ts): old_string has
        // a trailing \n\n the note lacks, forcing the trim strategy to rewrite it.
        const noteHtml = '<div data-schema-version="9"><p>Hello world</p>\n<p>Second para</p></div>';
        useNote(noteHtml);

        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, client_item_id: 'c-0', operation: 'str_replace', old_string: '<p>Hello world</p>\n\n', new_string: '<p>Goodbye world</p>\n' },
            { index: 1, client_item_id: 'c-1', operation: 'str_replace', old_string: '<p>Second para</p>', new_string: '<p>Second paragraph</p>' },
        ]));

        expect(response.valid).toBe(true);
        const norm = response.normalized_action_data as any;
        expect(norm).toBeDefined();
        // Full action_data envelope carried through.
        expect(norm.library_id).toBe(1);
        expect(norm.zotero_key).toBe('NOTE0001');
        // Same length and order as the request; index/client_item_id preserved.
        expect(norm.edits).toHaveLength(2);
        expect(norm.edits[0].index).toBe(0);
        expect(norm.edits[0].client_item_id).toBe('c-0');
        expect(norm.edits[0].old_string).toBe('<p>Hello world</p>');
        expect(norm.edits[0].new_string).toBe('<p>Goodbye world</p>');
        expect(norm.edits[1].index).toBe(1);
        expect(norm.edits[1].client_item_id).toBe('c-1');
        // The un-rewritten edit is carried through unchanged.
        expect(norm.edits[1].old_string).toBe('<p>Second para</p>');
        expect(norm.edits[1].new_string).toBe('<p>Second paragraph</p>');
    });

    it('validates a single-rewrite batch and includes old_content in current_value', async () => {
        useNote(NOTE_HTML);
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'rewrite', new_string: '<p>Brand new body.</p>' },
        ]));
        expect(response.valid).toBe(true);
        expect(response.current_value).toEqual({
            note_title: 'My Note',
            total_lines: 1,
            old_content: NOTE_HTML,
        });
    });
});


// =============================================================================
// Validate — Per-edit failures (fail-closed)
// =============================================================================

describe('validateEditNoteBatchAction — per-edit failures', () => {
    it('fails closed when one old_string is missing: edit_errors names ONLY that index, top-level old_string_not_found', async () => {
        const item = useNote(NOTE_HTML);
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence one.', new_string: 'X.' },
            { index: 1, operation: 'str_replace', old_string: 'THIS TEXT DOES NOT EXIST', new_string: 'Y.' },
            { index: 2, operation: 'str_replace', old_string: 'Charlie section three.', new_string: 'Z.' },
        ]));

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
        expect(response.error).toContain('1 of 3');
        const editErrors = (response as any).edit_errors;
        expect(editErrors).toHaveLength(1);
        expect(editErrors[0].index).toBe(1);
        expect(editErrors[0].error_code).toBe('old_string_not_found');
        // Fail-closed: nothing was written anywhere.
        expect(item.setNote).not.toHaveBeenCalled();
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('rejects two overlapping edits with overlapping_edits naming both indices in the message', async () => {
        useNote(NOTE_HTML);
        // 'Alpha sentence' and 'sentence one.' intersect inside the first <p>.
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence', new_string: 'ALPHA SENTENCE' },
            { index: 1, operation: 'str_replace', old_string: 'sentence one.', new_string: 'sentence 1.' },
        ]));

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('overlapping_edits');
        const editErrors = (response as any).edit_errors;
        expect(editErrors).toHaveLength(1);
        expect(editErrors[0].index).toBe(1);
        expect(editErrors[0].error_code).toBe('overlapping_edits');
        // The message names both indices.
        expect(editErrors[0].error).toMatch(/Edit 1 overlaps edit\D*0/);
    });

    it('flags a str_replace_all whose occurrences hit another edit\'s anchor as a conflict', async () => {
        const noteHtml = '<div data-schema-version="9"><p>foo alpha</p><p>foo beta</p></div>';
        useNote(noteHtml);
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace_all', old_string: 'foo', new_string: 'FOO' },
            // Unique target that contains the SECOND 'foo' occurrence.
            { index: 1, operation: 'str_replace', old_string: 'foo beta', new_string: 'bar beta' },
        ]));

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('overlapping_edits');
        const editErrors = (response as any).edit_errors;
        expect(editErrors).toHaveLength(1);
        expect(editErrors[0].error_code).toBe('overlapping_edits');
        expect(editErrors[0].index).toBe(1);
    });

    it('rejects two inserts resolving to the same anchor as a conflict', async () => {
        useNote(NOTE_HTML);
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'insert_after', old_string: 'Alpha sentence one.', new_string: ' Tail A.' },
            { index: 1, operation: 'insert_after', old_string: 'Alpha sentence one.', new_string: ' Tail B.' },
        ]));

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('overlapping_edits');
        const editErrors = (response as any).edit_errors;
        expect(editErrors).toHaveLength(1);
        expect(editErrors[0].index).toBe(1);
        expect(editErrors[0].error).toMatch(/Edit 1 overlaps edit\D*0/);
    });

    it('old_string_not_found wins as top-level error_code when both a miss and an overlap are present', async () => {
        useNote(NOTE_HTML);
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence', new_string: 'A' },
            { index: 1, operation: 'str_replace', old_string: 'sentence one.', new_string: 'B' },
            { index: 2, operation: 'str_replace', old_string: 'NOT PRESENT ANYWHERE', new_string: 'C' },
        ]));

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
        const editErrors = (response as any).edit_errors;
        // One not-found + one overlap pair report.
        expect(editErrors).toHaveLength(2);
        const codes = editErrors.map((e: any) => e.error_code).sort();
        expect(codes).toEqual(['old_string_not_found', 'overlapping_edits']);
        // Sorted by index.
        expect(editErrors[0].index).toBeLessThan(editErrors[1].index);
    });
});


// =============================================================================
// Validate — Backstop guards + exclusion gate
// =============================================================================

describe('validateEditNoteBatchAction — backstop guards', () => {
    it('rejects an empty edits array', async () => {
        const response = await handleAgentActionValidateRequest(makeValidateRequest([]));
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('no_edits');
    });

    it('rejects a rewrite edit accompanied by a sibling edit', async () => {
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'rewrite', new_string: '<p>whole new body</p>' },
            { index: 1, operation: 'str_replace', old_string: 'Alpha', new_string: 'ALPHA' },
        ]));
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('invalid_batch');
    });

    it.each([
        {
            label: 'duplicate',
            edits: [
                { index: 0, operation: 'append', new_string: '<p>First</p>' },
                { index: 0, operation: 'append', new_string: '<p>Second</p>' },
            ],
        },
        {
            label: 'out-of-order',
            edits: [
                { index: 1, operation: 'append', new_string: '<p>First</p>' },
                { index: 0, operation: 'append', new_string: '<p>Second</p>' },
            ],
        },
    ])('rejects $label edit indices before resolving the note', async ({ edits }) => {
        const response = await handleAgentActionValidateRequest(
            makeValidateRequest(edits as EditNoteBatchEditItem[]),
        );

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('invalid_batch');
        expect(response.error).toContain('index must match its zero-based position');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('gates on library exclusion BEFORE the item lookup', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValueOnce({ message: 'The library is excluded from Beaver' });
        const response = await handleAgentActionValidateRequest(makeValidateRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha', new_string: 'ALPHA' },
        ]));

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('library_not_searchable');
        expect(response.error).toBe('The library is excluded from Beaver');
        // No item lookup happened.
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });
});


// =============================================================================
// Execute — Success
// =============================================================================

describe('executeEditNoteBatchAction — success', () => {
    it('applies 3 str_replace edits with exactly ONE setNote and ONE saveTx', async () => {
        const item = useNote(NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, client_item_id: 'c-0', operation: 'str_replace', old_string: 'Alpha sentence one.', new_string: 'ALPHA SENTENCE 1.' },
            { index: 1, client_item_id: 'c-1', operation: 'str_replace', old_string: 'Bravo passage two.', new_string: 'BRAVO PASSAGE 2.' },
            { index: 2, client_item_id: 'c-2', operation: 'str_replace', old_string: 'Charlie section three.', new_string: 'CHARLIE SECTION 3.' },
        ]));

        expect(response.success).toBe(true);

        // The whole point of the batch: one write for N edits.
        expect(item.setNote).toHaveBeenCalledTimes(1);
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        const savedHtml = item.setNote.mock.calls[0][0] as string;
        expect(savedHtml).toContain('ALPHA SENTENCE 1.');
        expect(savedHtml).toContain('BRAVO PASSAGE 2.');
        expect(savedHtml).toContain('CHARLIE SECTION 3.');
        expect(savedHtml).not.toContain('Alpha sentence one.');

        const rd = response.result_data as any;
        expect(rd.library_id).toBe(1);
        expect(rd.zotero_key).toBe('NOTE0001');
        expect(rd.applied).toEqual([
            { index: 0, client_item_id: 'c-0', occurrences_replaced: 1 },
            { index: 1, client_item_id: 'c-1', occurrences_replaced: 1 },
            { index: 2, client_item_id: 'c-2', occurrences_replaced: 1 },
        ]);
        expect(rd.undo).toHaveLength(3);
        expect(rd.undo[0]).toMatchObject({
            index: 0,
            client_item_id: 'c-0',
            operation: 'str_replace',
            undo_old_html: 'Alpha sentence one.',
            undo_new_html: 'ALPHA SENTENCE 1.',
        });
        expect(rd.undo[1]).toMatchObject({
            index: 1,
            undo_old_html: 'Bravo passage two.',
            undo_new_html: 'BRAVO PASSAGE 2.',
        });
        expect(rd.undo[2]).toMatchObject({
            index: 2,
            undo_old_html: 'Charlie section three.',
            undo_new_html: 'CHARLIE SECTION 3.',
        });
        // Single-occurrence edits carry before/after context anchors.
        expect(typeof rd.undo[0].undo_before_context).toBe('string');
        expect(typeof rd.undo[0].undo_after_context).toBe('string');

        expect(invalidateSimplificationCache).toHaveBeenCalledWith('1-NOTE0001');
    });

    it('reports occurrences_replaced and per-occurrence undo contexts for a str_replace_all edit in the batch', async () => {
        const noteHtml = '<div data-schema-version="9"><p>widget a</p><p>widget b</p><p>tail c</p></div>';
        const item = useNote(noteHtml);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, operation: 'str_replace_all', old_string: 'widget', new_string: 'gadget' },
            { index: 1, operation: 'str_replace', old_string: 'tail c', new_string: 'TAIL C' },
        ]));

        expect(response.success).toBe(true);
        expect(item.setNote).toHaveBeenCalledTimes(1);
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        const savedHtml = item.setNote.mock.calls[0][0] as string;
        expect(savedHtml).toContain('<p>gadget a</p><p>gadget b</p>');
        expect(savedHtml).toContain('TAIL C');

        const rd = response.result_data as any;
        expect(rd.applied).toEqual([
            { index: 0, client_item_id: undefined, occurrences_replaced: 2 },
            { index: 1, client_item_id: undefined, occurrences_replaced: 1 },
        ]);
        const allUndo = rd.undo.find((u: any) => u.index === 0);
        expect(allUndo.undo_occurrence_contexts).toHaveLength(2);
        expect(allUndo.undo_old_html).toBe('widget');
        expect(allUndo.undo_new_html).toBe('gadget');
    });

    it('single-rewrite batch: undo[0].undo_old_html carries the FULL pre-edit stripped body', async () => {
        const item = useNote(NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, client_item_id: 'c-rw', operation: 'rewrite', new_string: '<p>Brand new body.</p>' },
        ]));

        expect(response.success).toBe(true);
        expect(item.setNote).toHaveBeenCalledTimes(1);
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        const savedHtml = item.setNote.mock.calls[0][0] as string;
        expect(savedHtml).toContain('<p>Brand new body.</p>');
        expect(savedHtml).toContain('data-schema-version="9"');
        expect(savedHtml).not.toContain('Alpha sentence one.');

        const rd = response.result_data as any;
        expect(rd.applied).toEqual([
            { index: 0, client_item_id: 'c-rw', occurrences_replaced: 1 },
        ]);
        expect(rd.undo).toHaveLength(1);
        expect(rd.undo[0].operation).toBe('rewrite');
        expect(rd.undo[0].undo_old_html).toBe(NOTE_HTML);
    });

    it('executes with normalized_action_data from validate (matcher-rewritten edits round-trip)', async () => {
        const noteHtml = '<div data-schema-version="9"><p>Hello world</p>\n<p>Second para</p></div>';
        const item = useNote(noteHtml);

        const valReq = makeValidateRequest([
            { index: 0, client_item_id: 'c-0', operation: 'str_replace', old_string: '<p>Hello world</p>\n\n', new_string: '<p>Goodbye world</p>\n' },
            { index: 1, client_item_id: 'c-1', operation: 'str_replace', old_string: '<p>Second para</p>', new_string: '<p>Second paragraph</p>' },
        ]);
        const valResponse = await handleAgentActionValidateRequest(valReq);
        expect(valResponse.valid).toBe(true);
        const norm = valResponse.normalized_action_data as any;
        expect(norm).toBeDefined();

        // Mirrors the backend merge: action_data replaced by normalized form.
        const exeResponse = await handleAgentActionExecuteRequest(makeExecuteRequest(
            norm.edits,
            { library_id: norm.library_id, zotero_key: norm.zotero_key },
        ));

        expect(exeResponse.success).toBe(true);
        expect(item.setNote).toHaveBeenCalledTimes(1);
        const savedHtml = item.setNote.mock.calls[0][0] as string;
        expect(savedHtml).toContain('<p>Goodbye world</p>');
        expect(savedHtml).toContain('<p>Second paragraph</p>');
        expect(savedHtml).not.toContain('<p>Hello world</p>');
    });
});


// =============================================================================
// Execute — Atomicity + failures
// =============================================================================

describe('executeEditNoteBatchAction — atomicity and failures', () => {
    it('fails the WHOLE batch with no setNote/saveTx when one edit no longer resolves (stale edit)', async () => {
        const item = useNote(NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence one.', new_string: 'X.' },
            { index: 1, operation: 'str_replace', old_string: 'DRIFTED AWAY TEXT', new_string: 'Y.' },
        ]));

        expect(response.success).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
        expect(response.error).toContain('edit 1');
        // Atomicity: NOTHING was written.
        expect(item.setNote).not.toHaveBeenCalled();
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('fails the WHOLE batch before writing when edits overlap at execute time', async () => {
        const item = useNote(NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence', new_string: 'A' },
            { index: 1, operation: 'str_replace', old_string: 'sentence one.', new_string: 'B' },
        ]));

        expect(response.success).toBe(false);
        expect(response.error_code).toBe('overlapping_edits');
        expect(item.setNote).not.toHaveBeenCalled();
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('rolls back with setNote(oldHtml) and reports save_failed when saveTx throws', async () => {
        const item = makeMockItem({
            saveTx: vi.fn().mockRejectedValue(new Error('DB write failed')),
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified: NOTE_HTML,
            metadata: { elements: new Map() } as any,
            isStale: false,
        });

        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, operation: 'str_replace', old_string: 'Alpha sentence one.', new_string: 'X.' },
            { index: 1, operation: 'str_replace', old_string: 'Bravo passage two.', new_string: 'Y.' },
        ]));

        expect(response.success).toBe(false);
        expect(response.error_code).toBe('save_failed');
        // setNote called twice: once with the new HTML, once rolling back to oldHtml.
        expect(item.setNote).toHaveBeenCalledTimes(2);
        expect(item.setNote.mock.calls[1][0]).toBe(NOTE_HTML);
        // Cache is NOT invalidated on failure.
        expect(invalidateSimplificationCache).not.toHaveBeenCalled();
    });

    it('rejects an empty edits array at execute (backstop guard)', async () => {
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([]));
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('no_edits');
    });

    it('rejects a rewrite with a sibling edit at execute (backstop guard)', async () => {
        const item = useNote(NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, operation: 'rewrite', new_string: '<p>whole new body</p>' },
            { index: 1, operation: 'str_replace', old_string: 'Alpha', new_string: 'ALPHA' },
        ]));
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('invalid_batch');
        expect(item.setNote).not.toHaveBeenCalled();
    });

    it('rejects malformed positional indices at execute before resolving or writing', async () => {
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest([
            { index: 0, operation: 'append', new_string: '<p>First</p>' },
            { index: 0, operation: 'append', new_string: '<p>Second</p>' },
        ]));

        expect(response.success).toBe(false);
        expect(response.error_code).toBe('invalid_batch');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });
});
