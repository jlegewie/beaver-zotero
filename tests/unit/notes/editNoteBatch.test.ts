import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ensure Zotero.getMainWindow exists before any transitive imports touch it.
// vi.hoisted runs before vi.mock factories, which is when module-level code
// like useIsomorphicLayoutEffect.ts evaluates Zotero.getMainWindow().
vi.hoisted(() => {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        getMainWindow: () => ({
            document: { createElement: () => ({}) },
        }),
    };
});

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn((_noteId: string, rawHtml: string, _libId: number) => ({
        simplified: rawHtml,
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
    stripNoteWrapperDiv: vi.fn((html: string) => {
        const trimmed = html.trim();
        if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) return html;
        const closeAngle = trimmed.indexOf('>');
        if (closeAngle === -1) return html;
        return trimmed.substring(closeAngle + 1, trimmed.length - 6);
    }),
    findRangeByContexts: vi.fn((html: string, before?: string, after?: string) => {
        const hasBefore = before != null && before.length > 0;
        const hasAfter = after != null && after.length > 0;
        if (hasBefore && hasAfter) {
            const beforeIdx = html.indexOf(before!);
            if (beforeIdx === -1) return null;
            const start = beforeIdx + before!.length;
            const afterIdx = html.indexOf(after!, start);
            if (afterIdx === -1) return null;
            return { start, end: afterIdx };
        } else if (hasBefore) {
            const beforeIdx = html.indexOf(before!);
            if (beforeIdx === -1) return null;
            return { start: beforeIdx + before!.length, end: html.length };
        } else if (hasAfter) {
            const afterIdx = html.indexOf(after!);
            if (afterIdx === -1) return null;
            return { start: 0, end: afterIdx };
        }
        return null;
    }),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: { getSession: vi.fn() },
    },
}));

vi.mock('../../../react/utils/sourceUtils', () => ({
    clearNoteEditorSelection: vi.fn(),
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => 'thread-123') },
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

vi.mock('../../../src/utils/noteEditFooter', () => ({
    addOrUpdateEditFooter: vi.fn((html: string) => html),
}));

// =============================================================================
// Imports
// =============================================================================

import { handleBatchEditNoteExecuteRequests } from '../../../src/services/agentDataProvider/handleAgentActionExecuteRequest';
import {
    getLatestNoteHtml,
    invalidateSimplificationCache,
    waitForNoteSaveStabilization,
    waitForPMNormalization,
    preloadPageLabelsForNewCitations,
    findRangeByContexts,
    stripDataCitationItems,
} from '../../../src/utils/noteHtmlSimplifier';
import { clearNoteEditorSelection } from '../../../react/utils/sourceUtils';
import type { WSAgentActionExecuteRequest } from '../../../src/services/agentProtocol';


// =============================================================================
// Helpers
// =============================================================================

/**
 * Template note HTML simulating the Chinese research note template from the
 * real failure cases.  Each section heading is followed by content that the
 * model wants to fill in via separate edit_note calls.
 */
const TEMPLATE_HTML = [
    '<div data-schema-version="9">',
    '<h1>Template Note</h1>',
    '<h2>Section A</h2>',
    '<p>placeholder-a</p>',
    '<h2>Section B</h2>',
    '<p>placeholder-b</p>',
    '<h2>Section C</h2>',
    '<p>placeholder-c</p>',
    '</div>',
].join('');

function makeExecuteRequest(
    overrides: Partial<WSAgentActionExecuteRequest & { action_data: Record<string, any> }> = {},
): WSAgentActionExecuteRequest {
    const base: WSAgentActionExecuteRequest = {
        event: 'agent_action_execute',
        request_id: 'exe-1',
        action_type: 'edit_note',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            old_string: 'placeholder-a',
            new_string: 'filled-a',
        },
    };
    if (overrides.action_data) {
        return {
            ...base,
            ...overrides,
            action_data: { ...base.action_data, ...overrides.action_data },
        };
    }
    return { ...base, ...overrides };
}

function makeMockItem(noteHtml: string = TEMPLATE_HTML) {
    let currentHtml = noteHtml;
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
        getNote: vi.fn(() => currentHtml),
        setNote: vi.fn((html: string) => { currentHtml = html; }),
        getNoteTitle: vi.fn(() => 'Template Note'),
        saveTx: vi.fn().mockResolvedValue(undefined),
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

    // getLatestNoteHtml returns the item's current note
    vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());
    vi.mocked(stripDataCitationItems).mockImplementation((html: string) => html);
});


// =============================================================================
// executeBatchEditNoteActions via handleBatchEditNoteExecuteRequests
// =============================================================================

describe('handleBatchEditNoteExecuteRequests', () => {

    // ─── Basic batch success ──────────────────────────────────────────

    describe('basic batch of independent edits', () => {
        it('applies all edits and saves once', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-3',
                    action_data: { old_string: 'placeholder-c', new_string: 'filled-c' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(3);
            for (const { response } of results) {
                expect(response.success).toBe(true);
                expect(response.result_data?.occurrences_replaced).toBe(1);
            }

            // saveTx called exactly once (not 3 times)
            const item = await (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync(1, 'NOTE0001');
            expect(item.saveTx).toHaveBeenCalledTimes(1);

            // The final HTML contains all replacements
            const finalHtml = item.getNote();
            expect(finalHtml).toContain('filled-a');
            expect(finalHtml).toContain('filled-b');
            expect(finalHtml).toContain('filled-c');
            expect(finalHtml).not.toContain('placeholder-a');
            expect(finalHtml).not.toContain('placeholder-b');
            expect(finalHtml).not.toContain('placeholder-c');
        });

        it('invalidates simplification cache between edits', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
            ];

            await handleBatchEditNoteExecuteRequests(requests);

            // Cache invalidated once per edit + once after save = 3 times
            expect(invalidateSimplificationCache).toHaveBeenCalledTimes(3);
        });

        it('waits for PM stabilization exactly once', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
            ];

            await handleBatchEditNoteExecuteRequests(requests);

            expect(waitForNoteSaveStabilization).toHaveBeenCalledTimes(1);
        });

        it('pre-loads page labels for all edits before processing', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
            ];

            await handleBatchEditNoteExecuteRequests(requests);

            expect(preloadPageLabelsForNewCitations).toHaveBeenCalledTimes(2);
        });
    });


    // ─── Single-edit batch (passthrough to normal path) ───────────────

    describe('single edit in batch', () => {
        it('succeeds like a normal edit', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(1);
            expect(results[0].response.success).toBe(true);
        });
    });


    // ─── Partial failure — some edits fail, others succeed ───────────

    describe('partial failure', () => {
        it('skips failed edits and applies remaining ones', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'NONEXISTENT', new_string: 'whatever' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-3',
                    action_data: { old_string: 'placeholder-c', new_string: 'filled-c' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(3);
            expect(results[0].response.success).toBe(true);
            expect(results[1].response.success).toBe(false);
            expect(results[1].response.error_code).toBe('old_string_not_found');
            expect(results[2].response.success).toBe(true);

            // Only the successful edits are in the final HTML
            const item = await (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync(1, 'NOTE0001');
            const finalHtml = item.getNote();
            expect(finalHtml).toContain('filled-a');
            expect(finalHtml).toContain('filled-c');
            expect(finalHtml).toContain('placeholder-b');

            // Still saves once for the successful edits
            expect(item.saveTx).toHaveBeenCalledTimes(1);
        });

        it('does not save when all edits fail', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'NONEXISTENT1', new_string: 'whatever' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'NONEXISTENT2', new_string: 'whatever' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(2);
            for (const { response } of results) {
                expect(response.success).toBe(false);
            }

            const item = await (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync(1, 'NOTE0001');
            expect(item.saveTx).not.toHaveBeenCalled();
            expect(waitForNoteSaveStabilization).not.toHaveBeenCalled();
        });
    });


    // ─── Response ordering ────────────────────────────────────────────

    describe('response ordering', () => {
        it('returns results in the same order as requests', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'first',
                    action_data: { old_string: 'placeholder-c', new_string: 'filled-c' },
                }),
                makeExecuteRequest({
                    request_id: 'second',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.request_id).toBe('first');
            expect(results[1].response.request_id).toBe('second');
        });
    });


    // ─── Rewrite in batch (defensive guard) ──────────────────────────

    describe('rewrite operation in batch', () => {
        it('rejects rewrite with batch_rewrite_conflict error', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-rewrite',
                    action_data: {
                        operation: 'rewrite',
                        old_string: '',
                        new_string: '<p>Completely new content</p>',
                    },
                }),
                makeExecuteRequest({
                    request_id: 'exe-3',
                    action_data: { old_string: 'placeholder-c', new_string: 'filled-c' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(3);
            // First and third edit succeed
            expect(results[0].response.success).toBe(true);
            expect(results[2].response.success).toBe(true);
            // Rewrite is rejected
            expect(results[1].response.success).toBe(false);
            expect(results[1].response.error_code).toBe('batch_rewrite_conflict');
        });
    });


    // ─── Item not found ──────────────────────────────────────────────

    describe('item not found', () => {
        it('returns error for all requests when item does not exist', async () => {
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);

            const requests = [
                makeExecuteRequest({ request_id: 'exe-1' }),
                makeExecuteRequest({ request_id: 'exe-2' }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(2);
            for (const { response } of results) {
                expect(response.success).toBe(false);
                expect(response.error_code).toBe('item_not_found');
            }
        });
    });


    // ─── Save failure rollback ───────────────────────────────────────

    describe('save failure', () => {
        it('rolls back and marks successful edits as save_failed', async () => {
            const mockItem = makeMockItem();
            mockItem.saveTx = vi.fn().mockRejectedValue(new Error('disk full'));
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(2);
            for (const { response } of results) {
                expect(response.success).toBe(false);
                expect(response.error_code).toBe('save_failed');
                expect(response.error).toContain('disk full');
            }

            // Rollback: setNote called with original HTML
            expect(mockItem.setNote).toHaveBeenLastCalledWith(TEMPLATE_HTML);
        });

        it('preserves original error for already-failed edits on save failure', async () => {
            const mockItem = makeMockItem();
            mockItem.saveTx = vi.fn().mockRejectedValue(new Error('disk full'));
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-ok',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-notfound',
                    action_data: { old_string: 'NONEXISTENT', new_string: 'whatever' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-ok2',
                    action_data: { old_string: 'placeholder-c', new_string: 'filled-c' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results).toHaveLength(3);

            // Edits that matched get save_failed
            expect(results[0].response.success).toBe(false);
            expect(results[0].response.error_code).toBe('save_failed');

            // Edit that failed matching keeps its original error
            expect(results[1].response.success).toBe(false);
            expect(results[1].response.error_code).toBe('old_string_not_found');

            // Third edit also gets save_failed
            expect(results[2].response.success).toBe(false);
            expect(results[2].response.error_code).toBe('save_failed');
        });
    });


    // ─── Undo metadata ──────────────────────────────────────────────

    describe('undo metadata', () => {
        it('captures undo context for each successful edit', async () => {
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            for (const { response } of results) {
                expect(response.success).toBe(true);
                expect(response.result_data).toBeDefined();
                expect(response.result_data?.undo_old_html).toBeDefined();
                expect(response.result_data?.undo_new_html).toBeDefined();
                // Context anchors should be present
                expect(typeof response.result_data?.undo_before_context).toBe('string');
                expect(typeof response.result_data?.undo_after_context).toBe('string');
            }
        });

        it('updates all edits undo data after PM normalization', async () => {
            // Simulate PM changing the HTML after save.
            // The batch saves HTML with "filled-a" and "filled-b", but PM
            // normalizes them to "PM-normalized-a" and "PM-normalized-b".
            const pmNormalizedHtml = TEMPLATE_HTML
                .replace('placeholder-a', 'PM-normalized-a')
                .replace('placeholder-b', 'PM-normalized-b');

            const mockItem = makeMockItem();
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            // After the batch saves and calls waitForNoteSaveStabilization,
            // the next call to getLatestNoteHtml should return PM-normalized HTML.
            // The batch code calls getLatestNoteHtml once after stabilization
            // to check if PM changed anything.
            vi.mocked(getLatestNoteHtml)
                .mockImplementation((item: any) => item.getNote());
            vi.mocked(waitForNoteSaveStabilization).mockImplementation(async () => {
                // After stabilization, PM has rewritten the note
                mockItem.setNote(pmNormalizedHtml);
            });

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            // waitForPMNormalization should be called once (polling phase)
            expect(waitForPMNormalization).toHaveBeenCalledTimes(1);

            // Both edits should succeed
            expect(results[0].response.success).toBe(true);
            expect(results[1].response.success).toBe(true);

            // findRangeByContexts should have been called for BOTH successful
            // edits (not just the last one) to update their undo data
            expect(findRangeByContexts).toHaveBeenCalled();
            const calls = vi.mocked(findRangeByContexts).mock.calls;
            // At least 2 calls — one per successful edit
            expect(calls.length).toBeGreaterThanOrEqual(2);
        });
    });


    // ─── PM polling with str_replace_all first (P2 regression test) ──

    describe('PM polling when first success is str_replace_all', () => {
        it('uses an anchored edit for PM polling instead of str_replace_all', async () => {
            // str_replace_all has no undo context anchors. If we used it for
            // the PM polling phase, waitForPMNormalization would return
            // immediately and leave stale undo data.
            const html = '<div data-schema-version="9"><p>AAA BBB AAA CCC</p></div>';
            const mockItem = makeMockItem(html);
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            // Simulate PM changing the HTML after save
            const pmNormalized = html
                .replace('AAA', 'YYY').replace('AAA', 'YYY')
                .replace('CCC', 'PM-CCC');
            vi.mocked(waitForNoteSaveStabilization).mockImplementation(async () => {
                mockItem.setNote(pmNormalized);
            });

            const requests = [
                // First edit is str_replace_all (no anchors)
                makeExecuteRequest({
                    request_id: 'exe-all',
                    action_data: {
                        old_string: 'AAA',
                        new_string: 'YYY',
                        operation: 'str_replace_all',
                    },
                }),
                // Second edit is str_replace (has anchors)
                makeExecuteRequest({
                    request_id: 'exe-single',
                    action_data: {
                        old_string: 'CCC',
                        new_string: 'ZZZ',
                    },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.success).toBe(true);
            expect(results[1].response.success).toBe(true);

            // waitForPMNormalization should be called with the ANCHORED edit's
            // undo data, not the str_replace_all edit
            expect(waitForPMNormalization).toHaveBeenCalledTimes(1);
            const pmCall = vi.mocked(waitForPMNormalization).mock.calls[0];
            const pollUndoData = pmCall[2];
            // The anchored edit's undo data should have context strings
            expect(pollUndoData.undo_before_context).toBeDefined();
            expect(pollUndoData.undo_after_context).toBeDefined();
        });
    });


    // ─── str_replace_all in batch ────────────────────────────────────

    describe('str_replace_all operation in batch', () => {
        it('replaces all occurrences of a pattern', async () => {
            const repeatingHtml = '<div data-schema-version="9"><p>foo bar foo baz foo</p></div>';
            const mockItem = makeMockItem(repeatingHtml);
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: {
                        old_string: 'foo',
                        new_string: 'qux',
                        operation: 'str_replace_all',
                    },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.success).toBe(true);
            expect(results[0].response.result_data?.occurrences_replaced).toBe(3);

            const finalHtml = mockItem.getNote();
            expect(finalHtml).not.toContain('foo');
            expect(finalHtml.match(/qux/g)).toHaveLength(3);
        });
    });


    // ─── Mixed operations in batch ───────────────────────────────────

    describe('mixed operations', () => {
        it('handles str_replace and str_replace_all in the same batch', async () => {
            const html = '<div data-schema-version="9"><p>AAA BBB AAA CCC</p></div>';
            const mockItem = makeMockItem(html);
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: {
                        old_string: 'BBB',
                        new_string: 'XXX',
                        operation: 'str_replace',
                    },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: {
                        old_string: 'AAA',
                        new_string: 'YYY',
                        operation: 'str_replace_all',
                    },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.success).toBe(true);
            expect(results[0].response.result_data?.occurrences_replaced).toBe(1);
            expect(results[1].response.success).toBe(true);
            expect(results[1].response.result_data?.occurrences_replaced).toBe(2);

            const finalHtml = mockItem.getNote();
            expect(finalHtml).toContain('XXX');
            expect(finalHtml).toContain('YYY');
            expect(finalHtml).not.toContain('BBB');
            expect(finalHtml).not.toContain('AAA');
        });
    });


    // ─── Ambiguous match in batch ────────────────────────────────────

    describe('ambiguous match', () => {
        it('returns ambiguous_match error for str_replace with multiple matches', async () => {
            const html = '<div data-schema-version="9"><p>dup content dup content</p></div>';
            const mockItem = makeMockItem(html);
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: {
                        old_string: 'dup content',
                        new_string: 'unique content',
                    },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.success).toBe(false);
            expect(results[0].response.error_code).toBe('ambiguous_match');
        });
    });


    // ─── Edit ordering matters ───────────────────────────────────────

    describe('edit ordering', () => {
        it('applies edits in request order so later edits see earlier changes', async () => {
            // Edit 1 changes "placeholder-a" to "intermediate"
            // Edit 2 changes "intermediate" to "final" — only works if edit 1 applied first
            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: { old_string: 'placeholder-a', new_string: 'intermediate' },
                }),
                makeExecuteRequest({
                    request_id: 'exe-2',
                    action_data: { old_string: 'intermediate', new_string: 'final' },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.success).toBe(true);
            expect(results[1].response.success).toBe(true);

            const item = await (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync(1, 'NOTE0001');
            expect(item.getNote()).toContain('final');
            expect(item.getNote()).not.toContain('intermediate');
        });
    });


    // ─── Wrapper div protection ──────────────────────────────────────

    describe('wrapper div protection', () => {
        it('rejects edit that would remove schema-version wrapper', async () => {
            const html = '<div data-schema-version="9"><p>content</p></div>';
            const mockItem = makeMockItem(html);
            (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(mockItem);

            const requests = [
                makeExecuteRequest({
                    request_id: 'exe-1',
                    action_data: {
                        old_string: html,
                        new_string: '<p>content without wrapper</p>',
                    },
                }),
            ];

            const results = await handleBatchEditNoteExecuteRequests(requests);

            expect(results[0].response.success).toBe(false);
            expect(results[0].response.error_code).toBe('wrapper_removed');
        });
    });
});


// =============================================================================
// AgentService batch debounce — barrier semantics
// =============================================================================

describe('AgentService edit_note batch debounce (barrier semantics)', () => {
    // These tests verify the ordering contract using the AgentService class
    // directly. We mock the WebSocket and the handler functions.

    // We need to import AgentService but it has heavy dependencies.
    // Instead, we test the contract through the handleBatchEditNoteExecuteRequests
    // function which is the core of the batch path. The barrier semantics
    // (rewrite flushes buffered edits first) is tested at the integration level
    // in the agentService, but we can verify the batch handler correctly
    // processes mixed edits.

    it('processes non-rewrite edits in a batch while rejecting rewrite', async () => {
        // This simulates what would happen if somehow a rewrite slipped
        // past the barrier and into the batch — the defensive guard catches it.
        const requests = [
            makeExecuteRequest({
                request_id: 'str-replace-1',
                action_data: { old_string: 'placeholder-a', new_string: 'filled-a' },
            }),
            makeExecuteRequest({
                request_id: 'rewrite-1',
                action_data: {
                    operation: 'rewrite',
                    old_string: '',
                    new_string: '<p>Full rewrite</p>',
                },
            }),
            makeExecuteRequest({
                request_id: 'str-replace-2',
                action_data: { old_string: 'placeholder-b', new_string: 'filled-b' },
            }),
        ];

        const results = await handleBatchEditNoteExecuteRequests(requests);

        // str_replace edits succeed
        expect(results[0].response.success).toBe(true);
        expect(results[0].response.request_id).toBe('str-replace-1');
        expect(results[2].response.success).toBe(true);
        expect(results[2].response.request_id).toBe('str-replace-2');

        // Rewrite rejected
        expect(results[1].response.success).toBe(false);
        expect(results[1].response.error_code).toBe('batch_rewrite_conflict');
        expect(results[1].response.request_id).toBe('rewrite-1');

        // Final HTML has the str_replace changes but not the rewrite
        const item = await (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync(1, 'NOTE0001');
        expect(item.getNote()).toContain('filled-a');
        expect(item.getNote()).toContain('filled-b');
    });
});
