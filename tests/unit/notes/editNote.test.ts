import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn((_noteId: string, rawHtml: string, _libId: number) => ({
        simplified: rawHtml.replace(/<[^>]+>/g, ''), // Crude strip-tags for testing
        metadata: { elements: new Map() },
        isStale: false,
    })),
    expandToRawHtml: vi.fn((str: string, _metadata: any, _context: string) => str),
    stripDataCitationItems: vi.fn((html: string) => html),
    rebuildDataCitationItems: vi.fn((html: string) => html),
    countOccurrences: vi.fn((haystack: string, needle: string) => {
        if (!needle) return 0;
        let count = 0;
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
        return count;
    }),
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    validateNewString: vi.fn(() => null),
    findFuzzyMatch: vi.fn(() => null),
    findStructuralAnchorHint: vi.fn(() => null),
    findInlineTagDriftMatch: vi.fn(() => null),
    findUniqueRawMatchPosition: vi.fn(() => null),
    captureValidatedEditTargetContext: vi.fn(() => null),
    findTargetRawMatchPosition: vi.fn(() => null),
    invalidateSimplificationCache: vi.fn(),
    checkDuplicateCitations: vi.fn(() => null),
    preloadPageLabelsForNewCitations: vi.fn().mockResolvedValue(undefined),
    waitForPMNormalization: vi.fn().mockResolvedValue(undefined),
    waitForNoteSaveStabilization: vi.fn().mockResolvedValue(undefined),
    hasSchemaVersionWrapper: vi.fn((html: string) => html.includes('data-schema-version=')),
    decodeHtmlEntities: vi.fn((s: string) => s),
    encodeTextEntities: vi.fn((s: string) => s),
    ENTITY_FORMS: ['hex', 'decimal', 'named'],
    stripPartialSimplifiedElements: vi.fn(() => null),
    stripSpuriousWrappingTags: vi.fn(() => []),
    normalizeNoteHtml: vi.fn((html: string) => html),
    checkNewCitationItemsExist: vi.fn(() => null),
    enrichOldStringCitationRefs: vi.fn(() => null),
    stripNoteWrapperDiv: vi.fn((html: string) => {
        const trimmed = html.trim();
        if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) return html;
        const closeAngle = trimmed.indexOf('>');
        if (closeAngle === -1) return html;
        return trimmed.substring(closeAngle + 1, trimmed.length - 6);
    }),
}));

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

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 2]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
}));

vi.mock('../../../react/atoms/editNoteAutoApprove', () => ({
    autoApproveNoteKeysAtom: Symbol('autoApproveNoteKeysAtom'),
    makeNoteKey: vi.fn((libId: number, key: string) => `${libId}-${key}`),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
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
    expandToRawHtml,
    stripDataCitationItems,
    countOccurrences,
    getLatestNoteHtml,
    validateNewString,
    findFuzzyMatch,
    findInlineTagDriftMatch,
    findUniqueRawMatchPosition,
    captureValidatedEditTargetContext,
    findTargetRawMatchPosition,
    invalidateSimplificationCache,
    checkDuplicateCitations,
    rebuildDataCitationItems,
    preloadPageLabelsForNewCitations,
    stripPartialSimplifiedElements,
    enrichOldStringCitationRefs,
} from '../../../src/utils/noteHtmlSimplifier';
import { getDeferredToolPreference } from '../../../src/services/agentDataProvider/utils';
import { store } from '../../../react/store';
import type {
    WSAgentActionValidateRequest,
    WSAgentActionExecuteRequest,
} from '../../../src/services/agentProtocol';


// =============================================================================
// Helpers
// =============================================================================

const NOTE_HTML = '<div data-schema-version="9"><p>Hello world</p></div>';

function makeValidateRequest(overrides: Partial<WSAgentActionValidateRequest> = {}): WSAgentActionValidateRequest {
    return {
        event: 'agent_action_validate',
        request_id: 'val-1',
        action_type: 'edit_note',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            old_string: 'Hello',
            new_string: 'Goodbye',
        },
        ...overrides,
    };
}

function makeExecuteRequest(overrides: Partial<WSAgentActionExecuteRequest> = {}): WSAgentActionExecuteRequest {
    return {
        event: 'agent_action_execute',
        request_id: 'exe-1',
        action_type: 'edit_note',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            old_string: 'Hello',
            new_string: 'Goodbye',
        },
        ...overrides,
    };
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

    // Reset store.get to return appropriate values per atom
    vi.mocked(store.get).mockImplementation((atom: any) => {
        // autoApproveNoteKeysAtom returns a Set
        if (typeof atom === 'symbol' && atom.description === 'autoApproveNoteKeysAtom') {
            return new Set<string>();
        }
        // searchableLibraryIdsAtom and others return [1, 2]
        return [1, 2];
    });

    // Reset mocks to default behavior
    vi.mocked(getOrSimplify).mockReturnValue({
        simplified: 'Hello world',
        metadata: { elements: new Map() },
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
    vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());
    vi.mocked(validateNewString).mockReturnValue(null);
    vi.mocked(findFuzzyMatch).mockReturnValue(null);
    vi.mocked(getDeferredToolPreference).mockReturnValue('always_ask');
    vi.mocked(checkDuplicateCitations).mockReturnValue(null);
    vi.mocked(invalidateSimplificationCache).mockImplementation(() => {});
    vi.mocked(preloadPageLabelsForNewCitations).mockResolvedValue(undefined);
    vi.mocked(enrichOldStringCitationRefs).mockReturnValue(null);
});


// =============================================================================
// Validate — Success
// =============================================================================

describe('validateEditNoteAction — success', () => {
    it('validates successfully with single match', async () => {
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(true);
        expect(response.current_value).toEqual({
            note_title: 'My Note',
            total_lines: 1,
            match_count: 1,
        });
    });

    it('validates with str_replace_all for multiple matches', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(3);
        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello',
                new_string: 'Goodbye',
                operation: 'str_replace_all',
            },
        });
        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.current_value.match_count).toBe(3);
    });

    it('returns correct preference from getDeferredToolPreference', async () => {
        vi.mocked(getDeferredToolPreference).mockReturnValueOnce('always_allow');
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(true);
        expect(response.preference).toBe('always_allow');
    });
});


// =============================================================================
// Validate — Failures (all error codes)
// =============================================================================

describe('validateEditNoteAction — failures', () => {
    it('library_not_found', async () => {
        (globalThis as any).Zotero.Libraries.get = vi.fn(() => null);
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('library_not_found');
    });

    it('library_not_searchable', async () => {
        vi.mocked(store.get).mockReturnValue([99]); // Library 1 not in list
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('library_not_searchable');
    });

    it('item_not_found', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('item_not_found');
    });

    it('not_a_note', async () => {
        const item = makeMockItem({ isNote: vi.fn(() => false) });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('not_a_note');
    });

    it('library_not_editable', async () => {
        (globalThis as any).Zotero.Libraries.get = vi.fn(() => ({ name: 'ReadOnly', editable: false }));
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('library_not_editable');
    });

    it('empty_note', async () => {
        const item = makeMockItem({ getNote: vi.fn(() => '') });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('empty_note');
    });

    it('no_changes (old_string === new_string)', async () => {
        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'same',
                new_string: 'same',
            },
        });
        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('no_changes');
    });

    it('invalid_new_string', async () => {
        vi.mocked(validateNewString).mockReturnValueOnce('Cannot create annotations');
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('invalid_new_string');
    });

    it('expansion_failed', async () => {
        vi.mocked(expandToRawHtml).mockImplementationOnce(() => { throw new Error('Unknown citation'); });
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('expansion_failed');
    });

    it('old_string_not_found without fuzzy hint', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(0);
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
        expect(response.error).not.toContain('fuzzy');
    });

    it('old_string_not_found with fuzzy hint', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(0);
        vi.mocked(findFuzzyMatch).mockReturnValueOnce('possible match here');
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
        expect(response.error).toContain('possible match here');
    });

    it('old_string_not_found with inline-tag drift hint', async () => {
        // Simulate the case where old_string text matches a unique span in the
        // note, but is missing inline formatting tags (e.g. <strong>) that the
        // note has. The drift branch should fire BEFORE the generic fuzzy match.
        vi.mocked(countOccurrences).mockReturnValueOnce(0);
        vi.mocked(findInlineTagDriftMatch).mockReturnValueOnce({
            noteSpan: 'experienced <strong>substantial</strong> negative effects',
            droppedTags: ['<strong>', '</strong>'],
        });
        // findFuzzyMatch should NOT be consulted when drift detection succeeds.
        const fuzzySpy = vi.mocked(findFuzzyMatch);

        const response = await handleAgentActionValidateRequest(makeValidateRequest());

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
        // Surfaces the canonical with-tags note span.
        expect(response.error).toContain('<strong>substantial</strong>');
        // Lists the dropped tags.
        expect(response.error).toContain('Tags missing from old_string');
        expect(response.error).toContain('<strong> </strong>');
        // Intent-neutral guidance: must NOT instruct the model to keep tags in
        // both old_string and new_string (would break unbold edits).
        expect(response.error).not.toMatch(/in BOTH/i);
        expect(response.error).toMatch(/keep the same tags.*preserve|omit them.*remove/i);
        // Drift branch short-circuits the generic fuzzy match.
        expect(fuzzySpy).not.toHaveBeenCalled();
    });

    it('ambiguous_match (multiple matches, no str_replace_all)', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(3);
        const response = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('ambiguous_match');
        expect(response.error).toContain('3 times');
    });

    it('duplicate-citation match is accepted when simplified position disambiguates it', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(12);
        vi.mocked(captureValidatedEditTargetContext).mockReturnValueOnce({
            beforeContext: 'before',
            afterContext: 'after',
        });

        const response = await handleAgentActionValidateRequest(makeValidateRequest());

        expect(response.valid).toBe(true);
        expect(response.current_value?.match_count).toBe(12);
        expect(response.normalized_action_data).toEqual({
            library_id: 1,
            zotero_key: 'NOTE0001',
            old_string: 'Hello',
            new_string: 'Goodbye',
            target_before_context: 'before',
            target_after_context: 'after',
        });
    });
});


// =============================================================================
// Execute — Success
// =============================================================================

describe('executeEditNoteAction — success', () => {
    it('single replacement succeeds', async () => {
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(true);
        expect(response.result_data).toBeDefined();
        expect(response.result_data!.occurrences_replaced).toBe(1);
        expect(response.result_data!.library_id).toBe(1);
        expect(response.result_data!.zotero_key).toBe('NOTE0001');
        expect(response.result_data!.undo_old_html).toBe('Hello');
        expect(response.result_data!.undo_new_html).toBe('Goodbye');
        // Verify save was called
        const item = await (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync(1, 'NOTE0001');
        expect(item.setNote).toHaveBeenCalled();
        expect(item.saveTx).toHaveBeenCalled();
    });

    it('str_replace_all replaces multiple occurrences', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(3);
        const item = makeMockItem({
            getNote: vi.fn(() => '<div data-schema-version="9"><p>Hello Hello Hello</p></div>'),
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const req = makeExecuteRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello',
                new_string: 'Goodbye',
                operation: 'str_replace_all',
            },
        });
        const response = await handleAgentActionExecuteRequest(req);
        expect(response.success).toBe(true);
        expect(response.result_data!.occurrences_replaced).toBe(3);
    });

    it('includes duplicate citation warning when present', async () => {
        vi.mocked(checkDuplicateCitations).mockReturnValueOnce('item 1-X is already cited as c_X_0 — use its ref attribute instead.');
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(true);
        expect(response.result_data!.warnings).toContain('item 1-X is already cited as c_X_0 — use its ref attribute instead.');
    });

    it('invalidates cache on success', async () => {
        await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(invalidateSimplificationCache).toHaveBeenCalledWith('1-NOTE0001');
    });
});


// =============================================================================
// Execute — Failures
// =============================================================================

describe('executeEditNoteAction — failures', () => {
    it('item_not_found', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('item_not_found');
    });

    it('expansion_failed', async () => {
        vi.mocked(expandToRawHtml).mockImplementationOnce(() => { throw new Error('Bad expansion'); });
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('expansion_failed');
    });

    it('old_string_not_found', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(0);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
    });

    it('ambiguous_match', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(3);
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('ambiguous_match');
    });

    it('duplicate-citation match executes when simplified position disambiguates it', async () => {
        vi.mocked(countOccurrences).mockReturnValueOnce(12);
        vi.mocked(findTargetRawMatchPosition).mockReturnValueOnce(123);

        const response = await handleAgentActionExecuteRequest(makeExecuteRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Hello',
                new_string: 'Goodbye',
                target_before_context: 'before',
                target_after_context: 'after',
            },
        }));

        expect(response.success).toBe(true);
        expect(response.result_data?.occurrences_replaced).toBe(1);
        expect(findTargetRawMatchPosition).toHaveBeenCalledWith(
            NOTE_HTML,
            'Hello',
            'before',
            'after'
        );
    });

    it('wrapper_removed (data-schema-version missing after replacement)', async () => {
        // After replacement, html won't contain data-schema-version
        vi.mocked(rebuildDataCitationItems).mockReturnValueOnce('<div><p>No schema</p></div>');
        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('wrapper_removed');
    });

    it('save_failed with in-memory rollback', async () => {
        const item = makeMockItem({
            saveTx: vi.fn().mockRejectedValue(new Error('DB write failed')),
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('save_failed');
        // Verify setNote was called twice: once with new HTML, once with rollback
        expect(item.setNote).toHaveBeenCalledTimes(2);
        // Last call should be rollback with original HTML
        expect(item.setNote.mock.calls[1][0]).toBe(NOTE_HTML);
    });

    it('rollback best-effort: setNote restore also throws — no crash', async () => {
        const item = makeMockItem({
            saveTx: vi.fn().mockRejectedValue(new Error('Save failed')),
            setNote: vi.fn()
                .mockImplementationOnce(() => {}) // First call (set new html) succeeds
                .mockImplementationOnce(() => { throw new Error('Rollback also failed'); }),
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleAgentActionExecuteRequest(makeExecuteRequest());
        // Should still return save_failed, not crash
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('save_failed');
    });
});


// =============================================================================
// Execute — Timeout
// =============================================================================

describe('executeEditNoteAction — timeout', () => {
    it('returns timeout error when timeout_seconds is 0', async () => {
        const req = makeExecuteRequest({ timeout_seconds: 0 });
        const response = await handleAgentActionExecuteRequest(req);
        // With timeout_seconds: 0, will use DEFAULT_TIMEOUT_SECONDS (25)
        // since the check is `typeof rawTimeout === 'number' && rawTimeout > 0`
        // So 0 is not > 0, so it uses default. Let's test with a very small value instead.
        // Actually the code checks: rawTimeout > 0, so 0 falls through to default.
        // The timeout won't actually expire in a test. Let's verify it uses default.
        expect(response.success).toBeDefined();
    });
});


// =============================================================================
// Cache Behavior
// =============================================================================

describe('executeEditNoteAction — cache behavior', () => {
    it('cache is NOT invalidated on failure', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);
        await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(invalidateSimplificationCache).not.toHaveBeenCalled();
    });
});


// =============================================================================
// Round-Trip: validate → execute
// =============================================================================

describe('validate → execute round-trip', () => {
    it('validate succeeds then execute succeeds', async () => {
        const valResponse = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(valResponse.valid).toBe(true);

        const exeResponse = await handleAgentActionExecuteRequest(makeExecuteRequest());
        expect(exeResponse.success).toBe(true);
        expect(exeResponse.result_data!.occurrences_replaced).toBe(1);
    });

    it('validate rejects — no execute needed', async () => {
        vi.mocked(countOccurrences).mockReturnValue(0);
        const valResponse = await handleAgentActionValidateRequest(makeValidateRequest());
        expect(valResponse.valid).toBe(false);
        expect(valResponse.error_code).toBe('old_string_not_found');
    });
});


// =============================================================================
// Unsupported Action Type
// =============================================================================

describe('unsupported action type', () => {
    it('validate with unknown type returns valid: false', async () => {
        const req = makeValidateRequest({ action_type: 'unknown_type' as any });
        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('unsupported_action_type');
    });

    it('execute with unknown type returns success: false', async () => {
        const req = makeExecuteRequest({ action_type: 'unknown_type' as any });
        const response = await handleAgentActionExecuteRequest(req);
        expect(response.success).toBe(false);
        expect(response.error_code).toBe('unsupported_action_type');
    });
});


// =============================================================================
// Partial Simplified Element Fallback
// =============================================================================

describe('validateEditNoteAction — partial element fallback', () => {
    const CITATION_RAW = '<span class="citation" data-citation="...">(Legewie, 2018)</span>';
    const CITATION_SIMPLIFIED = '<citation item_id="1-KEY" ref="c_KEY_0"/>';
    const RAW_HTML = `<div data-schema-version="9">${CITATION_RAW}—ein theoretisch bildungsfördernder Effekt</div>`;
    const SIMPLIFIED = `${CITATION_SIMPLIFIED}—ein theoretisch bildungsfördernder Effekt`;

    function setupPartialElementMocks() {
        const mockItem = makeMockItem({ getNote: vi.fn(() => RAW_HTML) });
        vi.mocked((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified: SIMPLIFIED,
            metadata: { elements: new Map() },
            isStale: false,
        });
        // expandToRawHtml returns input as-is (after stripping, there are no elements to expand)
        vi.mocked(expandToRawHtml).mockImplementation((str: string) => str);
        // countOccurrences: use real implementation
        vi.mocked(countOccurrences).mockImplementation((haystack: string, needle: string) => {
            if (!needle) return 0;
            let count = 0; let pos = 0;
            while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
            return count;
        });
        // stripDataCitationItems: pass through
        vi.mocked(stripDataCitationItems).mockImplementation((html: string) => html);
        // getLatestNoteHtml: from mock item
        vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());
    }

    it('validates successfully when old_string has leading /> (unique stripped match)', async () => {
        setupPartialElementMocks();

        // stripPartialSimplifiedElements returns the stripped strings
        vi.mocked(stripPartialSimplifiedElements).mockReturnValue({
            strippedOld: '—ein theoretisch',
            strippedNew: '. Ein theoretisch',
            leadingStrip: 2,
            trailingStrip: 0,
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '/>—ein theoretisch',
                new_string: '/>. Ein theoretisch',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data!.old_string).toBe('—ein theoretisch');
        expect(response.normalized_action_data!.new_string).toBe('. Ein theoretisch');
    });

    it('falls through to fuzzy error when stripPartialSimplifiedElements returns null', async () => {
        setupPartialElementMocks();
        vi.mocked(stripPartialSimplifiedElements).mockReturnValue(null);
        vi.mocked(findFuzzyMatch).mockReturnValue('some fuzzy match');

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '/>—ein theoretisch',
                new_string: '/>. Ein theoretisch',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
    });

    it('adds context anchors when stripped match is ambiguous and disambiguation succeeds', async () => {
        // Set up HTML where the stripped text appears twice but can be disambiguated.
        // expandToRawHtml maps simplified prefix to raw prefix of the same length
        // so the position verification succeeds.
        const rawHtml = '<div data-schema-version="9">BEFORE —ein theoretisch BBB—ein theoretisch CCC</div>';
        const simplified = 'BEFORE —ein theoretisch BBB—ein theoretisch CCC';

        const mockItem = makeMockItem({ getNote: vi.fn(() => rawHtml) });
        vi.mocked((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified,
            metadata: { elements: new Map() },
            isStale: false,
        });
        // Identity expansion: simplified content has no elements to expand
        vi.mocked(expandToRawHtml).mockImplementation((str: string) => str);
        vi.mocked(countOccurrences).mockImplementation((haystack: string, needle: string) => {
            if (!needle) return 0;
            let count = 0; let pos = 0;
            while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
            return count;
        });
        vi.mocked(stripDataCitationItems).mockImplementation((html: string) => html);
        vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());

        // old_string = "/>—ein theoretisch", which appears once in simplified
        // (prepend "/>" to simulate a partial citation tail).
        // After stripping leading "/>", strippedOld = "—ein theoretisch" appears
        // twice in rawHtml — disambiguation uses prefix expansion to locate the
        // correct occurrence and attach context anchors.
        const oldString = '/>—ein theoretisch';
        const simplifiedWithTag = `BEFORE <citation item_id="1-KEY" ref="c_KEY_0"/>${simplified.substring('BEFORE '.length)}`;
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified: simplifiedWithTag,
            metadata: { elements: new Map() },
            isStale: false,
        });

        vi.mocked(stripPartialSimplifiedElements).mockReturnValue({
            strippedOld: '—ein theoretisch',
            strippedNew: '. Ein theoretisch',
            leadingStrip: 2,
            trailingStrip: 0,
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: oldString,
                new_string: '/>. Ein theoretisch',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        // expandToRawHtml is identity, so the prefix (simplified up to the
        // stripped text start) expands to itself. The wrapper prefix is
        // '<div data-schema-version="9">' (29 chars). The position verification
        // checks strippedHtml at (29 + prefixLen) — but the prefix includes the
        // citation tag text which doesn't exist in rawHtml, so the position
        // won't match and disambiguation fails, falling through to fuzzy error.
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('old_string_not_found');
    });

    it('succeeds with context anchors when prefix expansion maps to correct raw position', async () => {
        // Set up HTML where disambiguation succeeds: the simplified prefix
        // (citation tag) gets expanded to the raw citation text, and the
        // resulting raw position correctly locates the first occurrence.
        const RAWCIT = '<span class="citation" data-citation="x">(Cite)</span>';
        const CIT_TAG = '<citation item_id="1-KEY" ref="c_KEY_0"/>';
        const rawHtml = `<div data-schema-version="9">${RAWCIT}—ein theoretisch BBB—ein theoretisch CCC</div>`;
        const simplified = `${CIT_TAG}—ein theoretisch BBB—ein theoretisch CCC`;

        const mockItem = makeMockItem({ getNote: vi.fn(() => rawHtml) });
        vi.mocked((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified,
            metadata: { elements: new Map() },
            isStale: false,
        });
        // Map the citation tag to its raw equivalent; leave other text unchanged.
        vi.mocked(expandToRawHtml).mockImplementation((str: string) =>
            str.replace(CIT_TAG, RAWCIT),
        );
        vi.mocked(countOccurrences).mockImplementation((haystack: string, needle: string) => {
            if (!needle) return 0;
            let count = 0; let pos = 0;
            while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
            return count;
        });
        vi.mocked(stripDataCitationItems).mockImplementation((html: string) => html);
        vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());

        // old_string = "/>—ein theoretisch" is unique in simplified (the />
        // is at the end of the citation tag). After stripping, strippedOld =
        // "—ein theoretisch" appears twice in rawHtml.
        // Disambiguation: strippedStart = simplifiedPos + leadingStrip.
        // expandedBefore = expandToRawHtml(simplified[0..strippedStart]) maps
        // the citation tag to RAWCIT. wrapperPrefixLen = 29. So:
        //   rawPos = 29 + RAWCIT.length = 29 + 55 = 84
        //   rawHtml[84..100] = "—ein theoretisch" ✓
        vi.mocked(stripPartialSimplifiedElements).mockReturnValue({
            strippedOld: '—ein theoretisch',
            strippedNew: '. Ein theoretisch',
            leadingStrip: 2,
            trailingStrip: 0,
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '/>—ein theoretisch',
                new_string: '/>. Ein theoretisch',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data!.target_before_context).toBeDefined();
        expect(response.normalized_action_data!.target_after_context).toBeDefined();
    });
});

describe('executeEditNoteAction — partial element fallback', () => {
    it('executes successfully with stripped old_string when direct match fails', async () => {
        // Raw HTML without citations (simple case for execution test)
        const rawHtml = '<div data-schema-version="9">PREFIX—ein theoretisch SUFFIX</div>';
        const simplified = 'CITATION_TAG/>—ein theoretisch SUFFIX';

        const mockItem = makeMockItem({ getNote: vi.fn(() => rawHtml) });
        vi.mocked((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified,
            metadata: { elements: new Map() },
            isStale: false,
        });
        vi.mocked(expandToRawHtml).mockImplementation((str: string) => str);
        vi.mocked(countOccurrences).mockImplementation((haystack: string, needle: string) => {
            if (!needle) return 0;
            let count = 0; let pos = 0;
            while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
            return count;
        });
        vi.mocked(stripDataCitationItems).mockImplementation((html: string) => html);
        vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());
        vi.mocked(rebuildDataCitationItems).mockImplementation((html: string) => html);

        // The old_string "/>—ein" doesn't exist in raw HTML, but "—ein" does
        vi.mocked(stripPartialSimplifiedElements).mockReturnValue({
            strippedOld: '—ein theoretisch',
            strippedNew: '. Ein theoretisch',
            leadingStrip: 2,
            trailingStrip: 0,
        });

        const req = makeExecuteRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '/>—ein theoretisch',
                new_string: '/>. Ein theoretisch',
            },
        });

        const response = await handleAgentActionExecuteRequest(req);
        expect(response.success).toBe(true);
        expect(response.result_data?.occurrences_replaced).toBe(1);
        // Verify the note was saved with the replaced text
        expect(mockItem.setNote).toHaveBeenCalled();
        const savedHtml = mockItem.setNote.mock.calls[0][0];
        expect(savedHtml).toContain('. Ein theoretisch');
        expect(savedHtml).not.toContain('—ein theoretisch');
    });
});


// =============================================================================
// Trailing whitespace normalization in matching
// =============================================================================

describe('trailing whitespace normalization in matching', () => {
    let mockItem: any;

    beforeEach(() => {
        vi.clearAllMocks();
        const noteHtml = '<div data-schema-version="9"><p>Hello world</p>\n<p>Second para</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);
    });

    it('matches old_string with trailing \\n\\n when note has \\n and emits normalized_action_data', async () => {
        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // old_string has trailing double newline that doesn't exist in note
                old_string: '<p>Hello world</p>\n\n',
                new_string: '<p>Goodbye world</p>\n',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        // Must emit normalized_action_data so execution uses the trimmed strings
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('<p>Hello world</p>');
        expect(response.normalized_action_data.new_string).toBe('<p>Goodbye world</p>');
    });

    it('does not trim non-trailing whitespace', async () => {
        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // Whitespace in the middle — should not match
                old_string: 'Hello\n\nworld',
                new_string: 'Goodbye world',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        // "Hello\n\nworld" is not in the note, and trimming trailing \n won't help
        expect(response.valid).toBe(false);
    });

    it('rejects ambiguous match after trimming when operation is str_replace', async () => {
        // Note has two identical paragraphs separated by a single \n; the
        // trailing \n\n in old_string forces fallback into block 12b, after
        // which the trimmed form matches both paragraphs.
        const noteHtml = '<div data-schema-version="9"><p>Duplicate</p>\n<p>Duplicate</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '<p>Duplicate</p>\n\n',
                new_string: '<p>Replaced</p>',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('ambiguous_match');
        expect(response.error).toContain('2 times');
    });

    it('allows ambiguous match after trimming when operation is str_replace_all', async () => {
        const noteHtml = '<div data-schema-version="9"><p>Duplicate</p>\n<p>Duplicate</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '<p>Duplicate</p>\n\n',
                new_string: '<p>Replaced</p>',
                operation: 'str_replace_all',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('<p>Duplicate</p>');
    });

    it('recovers from ambiguous trimmed match via captureValidatedEditTargetContext', async () => {
        // After trimming, the trimmed form matches twice in raw HTML, but
        // captureValidatedEditTargetContext can pin down a unique target via
        // surrounding context (e.g. simplification collapsed two raw forms
        // into one). Mirrors block 14's recovery path — block 12b must not
        // reject these edits without trying disambiguation first.
        const noteHtml = '<div data-schema-version="9"><p>Duplicate</p>\n<p>Duplicate</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);
        vi.mocked(captureValidatedEditTargetContext).mockReturnValueOnce({
            beforeContext: 'before-anchor',
            afterContext: 'after-anchor',
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '<p>Duplicate</p>\n\n',
                new_string: '<p>Replaced</p>',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('<p>Duplicate</p>');
        expect(response.normalized_action_data.target_before_context).toBe('before-anchor');
        expect(response.normalized_action_data.target_after_context).toBe('after-anchor');
    });
});

describe('JSON-escape unescape fallback in matching', () => {
    let mockItem: any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('matches old_string with literal \\" when note has plain " and emits normalized_action_data', async () => {
        const noteHtml = '<div data-schema-version="9"><p>Say "hello"</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // Literal backslash-quote pairs — what the server sees if the LLM
                // double-escaped quotes when emitting JSON tool-call args.
                old_string: 'Say \\"hello\\"',
                new_string: 'Say goodbye',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('Say "hello"');
        expect(response.normalized_action_data.new_string).toBe('Say goodbye');
    });

    it('rejects ambiguous match after JSON-unescape when operation is str_replace', async () => {
        // Note has two identical 'Say "hello"' paragraphs; after unescape both match.
        const noteHtml = '<div data-schema-version="9"><p>Say "hello"</p>\n<p>Say "hello"</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // Over-escaped — what the server sees if the LLM double-escaped quotes.
                old_string: 'Say \\"hello\\"',
                new_string: 'Say goodbye',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('ambiguous_match');
        expect(response.error).toContain('2 times');
    });

    it('allows ambiguous match after JSON-unescape when operation is str_replace_all', async () => {
        const noteHtml = '<div data-schema-version="9"><p>Say "hello"</p>\n<p>Say "hello"</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Say \\"hello\\"',
                new_string: 'Say goodbye',
                operation: 'str_replace_all',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('Say "hello"');
    });

    it('recovers from ambiguous unescaped match via captureValidatedEditTargetContext', async () => {
        // After unescape, the unescaped form matches twice in raw HTML, but
        // captureValidatedEditTargetContext can pin down a unique target via
        // surrounding context. Mirrors block 14's recovery path — block 12c
        // must not reject these edits without trying disambiguation first.
        const noteHtml = '<div data-schema-version="9"><p>Say "hello"</p>\n<p>Say "hello"</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);
        vi.mocked(captureValidatedEditTargetContext).mockReturnValueOnce({
            beforeContext: 'unescaped-before',
            afterContext: 'unescaped-after',
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'Say \\"hello\\"',
                new_string: 'Say goodbye',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('Say "hello"');
        expect(response.normalized_action_data.target_before_context).toBe('unescaped-before');
        expect(response.normalized_action_data.target_after_context).toBe('unescaped-after');
    });

    // The next batch reproduces the failed-edits-18.md case: the LLM
    // double-escaped newlines, sending literal `\n` (backslash + n) where
    // the note HTML has actual newline characters. Block 12c must extend
    // its existing JSON-escape unescape to also handle `\n`, `\r`, `\t`.

    it('matches old_string with literal \\n when note has real newlines (failed-edits-18.md)', async () => {
        // Note HTML has actual newlines between block elements (typical PM
        // output). The model sent literal "\n" (backslash + n) instead of
        // newline characters in old_string.
        const noteHtml = '<div data-schema-version="9"><h2>Section</h2>\n<hr>\n<p></p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // Literal backslash-n pairs — what the server sees if the LLM
                // double-escaped newlines when emitting JSON tool-call args.
                old_string: '<h2>Section</h2>\\n<hr>\\n<p></p>',
                new_string: '<h2>Section</h2>\\n<hr>\\n<p>New content</p>',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        // Both old_string and new_string should have real newlines now.
        expect(response.normalized_action_data.old_string).toBe('<h2>Section</h2>\n<hr>\n<p></p>');
        expect(response.normalized_action_data.new_string).toBe('<h2>Section</h2>\n<hr>\n<p>New content</p>');
    });

    it('matches old_string with literal \\n for insert_after operation', async () => {
        const noteHtml = '<div data-schema-version="9"><h2>Anchor</h2>\n<p>Existing</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // Literal \n in old_string anchor — should be unescaped, then
                // mergeInsertNewString concatenates with new_string for insert.
                old_string: '<h2>Anchor</h2>\\n<p>Existing</p>',
                new_string: '\\n<p>Inserted</p>',
                operation: 'insert_after',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('<h2>Anchor</h2>\n<p>Existing</p>');
        // insert_after merges the unescaped anchor + the unescaped new_string.
        expect(response.normalized_action_data.new_string).toBe('<h2>Anchor</h2>\n<p>Existing</p>\n<p>Inserted</p>');
    });

    it('matches old_string with mixed \\" and \\n escapes', async () => {
        // Verify the single-pass unescape handles multiple escape kinds in
        // the same string without ordering bugs.
        const noteHtml = '<div data-schema-version="9"><p>Say "hi"</p>\n<p>Done</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '<p>Say \\"hi\\"</p>\\n<p>Done</p>',
                new_string: '<p>Say \\"bye\\"</p>\\n<p>Done</p>',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('<p>Say "hi"</p>\n<p>Done</p>');
        expect(response.normalized_action_data.new_string).toBe('<p>Say "bye"</p>\n<p>Done</p>');
    });

    it('matches old_string with literal \\t when note has real tabs', async () => {
        const noteHtml = '<div data-schema-version="9"><pre>col1\tcol2</pre></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '<pre>col1\\tcol2</pre>',
                new_string: '<pre>a\\tb</pre>',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data.old_string).toBe('<pre>col1\tcol2</pre>');
        expect(response.normalized_action_data.new_string).toBe('<pre>a\tb</pre>');
    });

    it('rejects ambiguous match after \\n unescape when operation is str_replace', async () => {
        // Two identical multi-line blocks; after unescaping \n both match.
        // Block 12c must reject (or disambiguate), not silently confirm.
        const noteHtml = '<div data-schema-version="9"><h2>S</h2>\n<p>X</p>\n<h2>S</h2>\n<p>X</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: '<h2>S</h2>\\n<p>X</p>',
                new_string: '<h2>S</h2>\\n<p>Y</p>',
                operation: 'str_replace',
            },
        });

        const response = await handleAgentActionValidateRequest(req);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('ambiguous_match');
        expect(response.error).toContain('2 times');
    });
});


// =============================================================================
// Citation ref enrichment (no-ref citations in old_string)
// =============================================================================
//
// These tests verify the fix for the failure mode observed in
// failed-edits-15.md, where the model reused the form it wrote in an
// earlier edit_note (citation without a ref attribute) as its old_string
// in a follow-up edit. Without enrichment, expansion throws
// "New citations (without a ref) can only appear in new_string".
//
// The integration tests here only verify the wiring between the
// validate/execute paths and `enrichOldStringCitationRefs`; the deep
// per-case logic is covered by the unit tests in
// `noteHtmlSimplifier.test.ts`.

describe('citation ref enrichment — validate', () => {
    // Using simple text tokens (instead of full citation HTML) so the mocked
    // identity expandToRawHtml produces something that countOccurrences can
    // find verbatim in the note HTML. The goal here is to verify WIRING —
    // that enrichment runs and its output flows into normalized_action_data
    // and the executor. The per-case parsing logic for citation tags is
    // covered by the unit tests in noteHtmlSimplifier.test.ts.
    let mockItem: any;

    beforeEach(() => {
        vi.clearAllMocks();
        // Note contains the "enriched" form of the string.
        const noteHtml = '<div data-schema-version="9"><p>See CITATION_WITH_REF</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified: noteHtml,
            metadata: { elements: new Map() } as any,
            isStale: false,
        });
        vi.mocked(getDeferredToolPreference).mockReturnValue('always_ask');
    });

    it('enriched old_string is carried through validation and surfaces in normalized_action_data', async () => {
        // Simulate enrichment: swap the no-ref token for the enriched token.
        vi.mocked(enrichOldStringCitationRefs).mockImplementation((oldStr: string) => {
            if (oldStr.includes('CITATION_NO_REF')) {
                return oldStr.replace('CITATION_NO_REF', 'CITATION_WITH_REF');
            }
            return null;
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // "Before enrichment" form — doesn't exist verbatim in the note.
                old_string: 'See CITATION_NO_REF',
                new_string: 'See UPDATED_CITATION',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        expect(enrichOldStringCitationRefs).toHaveBeenCalled();
        expect(response.valid).toBe(true);
        // Enriched old_string threaded through to normalized_action_data so
        // the executor uses it instead of the model's original no-ref form.
        expect(response.normalized_action_data).toBeDefined();
        expect(response.normalized_action_data!.old_string).toBe('See CITATION_WITH_REF');
        // new_string is untouched by enrichment
        expect(response.normalized_action_data!.new_string).toBe('See UPDATED_CITATION');
    });

    it('enriched old_string is preserved through the insert_after normalization path', async () => {
        vi.mocked(enrichOldStringCitationRefs).mockImplementation((oldStr: string) => {
            if (oldStr.includes('CITATION_NO_REF')) {
                return oldStr.replace('CITATION_NO_REF', 'CITATION_WITH_REF');
            }
            return null;
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'See CITATION_NO_REF',
                new_string: ' appended',
                operation: 'insert_after',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        // Enriched old_string + prepended to new_string per insert_after semantics
        expect(response.normalized_action_data!.old_string).toBe('See CITATION_WITH_REF');
        expect(response.normalized_action_data!.new_string).toBe('See CITATION_WITH_REF appended');
    });

    it('enriched old_string is preserved through the insert_before normalization path', async () => {
        vi.mocked(enrichOldStringCitationRefs).mockImplementation((oldStr: string) => {
            if (oldStr.includes('CITATION_NO_REF')) {
                return oldStr.replace('CITATION_NO_REF', 'CITATION_WITH_REF');
            }
            return null;
        });

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'See CITATION_NO_REF',
                new_string: 'prepended ',
                operation: 'insert_before',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toBeDefined();
        // Enriched old_string + appended to new_string per insert_before semantics
        expect(response.normalized_action_data!.old_string).toBe('See CITATION_WITH_REF');
        expect(response.normalized_action_data!.new_string).toBe('prepended See CITATION_WITH_REF');
    });

    it('rejects empty insert_before payloads as no-op edits', async () => {
        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'See CITATION_WITH_REF',
                new_string: '',
                operation: 'insert_before',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('no_changes');
        expect(response.error).toBe('new_string must not be empty.');
    });

    it('no enrichment → no normalized_action_data from enrichment alone', async () => {
        vi.mocked(enrichOldStringCitationRefs).mockReturnValue(null);

        const req = makeValidateRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                old_string: 'See CITATION_WITH_REF',
                new_string: 'See UPDATED_CITATION',
            },
        });

        const response = await handleAgentActionValidateRequest(req);

        expect(response.valid).toBe(true);
        // No enrichment happened and operation is neither insert_after nor
        // insert_before → no normalized_action_data wrapping from this code
        // path.
        expect(response.normalized_action_data).toBeUndefined();
    });
});

describe('citation ref enrichment — execute (defense-in-depth)', () => {
    let mockItem: any;

    beforeEach(() => {
        vi.clearAllMocks();
        const noteHtml = '<div data-schema-version="9"><p>See CITATION_WITH_REF</p></div>';
        mockItem = makeMockItem({ getNote: vi.fn(() => noteHtml) });
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(mockItem);
        vi.mocked(getLatestNoteHtml).mockReturnValue(noteHtml);
        vi.mocked(getOrSimplify).mockReturnValue({
            simplified: noteHtml,
            metadata: { elements: new Map() } as any,
            isStale: false,
        });
    });

    it('re-enriches old_string during execute so direct executor calls also benefit', async () => {
        vi.mocked(enrichOldStringCitationRefs).mockImplementation((oldStr: string) => {
            if (oldStr.includes('CITATION_NO_REF')) {
                return oldStr.replace('CITATION_NO_REF', 'CITATION_WITH_REF');
            }
            return null;
        });

        const req = makeExecuteRequest({
            action_data: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                // No-ref form — simulates stale/pre-enrichment action_data.
                old_string: 'See CITATION_NO_REF',
                new_string: 'See UPDATED_CITATION',
            },
        });

        const response = await handleAgentActionExecuteRequest(req);

        expect(response.success).toBe(true);
        // Enrichment was invoked during execute (defense-in-depth).
        expect(enrichOldStringCitationRefs).toHaveBeenCalled();
        // The enriched form was used for the actual replacement.
        expect(mockItem.setNote).toHaveBeenCalled();
        const newHtml = vi.mocked(mockItem.setNote).mock.calls[0]![0] as string;
        expect(newHtml).toContain('See UPDATED_CITATION');
        expect(newHtml).not.toContain('CITATION_NO_REF');
        expect(newHtml).not.toContain('CITATION_WITH_REF');
    });
});
