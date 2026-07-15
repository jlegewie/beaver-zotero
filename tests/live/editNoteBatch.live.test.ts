/**
 * Live tests for the edit_note_batch agent action.
 *
 * These tests run against a live Zotero instance with the Beaver plugin
 * loaded (dev build — test-only endpoints are only registered when
 * `NODE_ENV === 'development'`).
 *
 * Coverage:
 *   0. Dispatch smoke — edit_note_batch reaches its validator (a bogus note
 *      returns a structured validation error, not unsupported_action_type).
 *   1. Multi-edit batch: validate → execute → all replacements land in one
 *      write (single result envelope, single "Edited by Beaver" footer).
 *   2. Stale edit: per-edit diagnostics name the failing index; the batch is
 *      fail-closed (note unchanged after validate AND execute).
 *   3. Overlapping pair: overlapping_edits on validate and execute; unchanged.
 *   4. Undo via the batch's per-edit undo records after a manual drift edit —
 *      both batch edits revert, the manual edit survives.
 *   5. Single-rewrite batch: apply + undo restores the original body.
 *
 * Undo-path note: the production batch undo (`undoEditNoteBatchAction`) is
 * only dispatched from `/beaver/test/undo-action`, which requires a real
 * thread action produced by a live agent run (real credits, nondeterministic).
 * `/beaver/test/note-undo` is hardcoded to the v1 `undoEditNoteAction`. The
 * batch's per-edit undo RECORDS carry exactly the v1 undo field shape
 * (undo_old_html / undo_new_html / contexts), so these tests replay them
 * record-by-record in reverse request order — the same order the batch undo
 * uses — through the v1 undo machinery. That pins the drift-tolerance
 * property of the records themselves (the reason batch undo is per-edit);
 * the batch replay loop + single-save behavior is covered by unit tests.
 *
 * Run: `ZOTERO_HTTP_PORT=<port> npx vitest run --config vitest.live.config.ts tests/live/editNoteBatch.live.test.ts`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import {
    createNote,
    deleteNote,
    readNote,
    undoEditNote,
    executeEditNote,
} from './helpers/noteTestClient';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

// ---------------------------------------------------------------------------
// Batch action wire types + HTTP wrappers
// ---------------------------------------------------------------------------

interface BatchEdit {
    index: number;
    client_item_id?: string;
    operation?: 'str_replace' | 'str_replace_all' | 'insert_after' | 'insert_before' | 'rewrite' | 'append';
    old_string?: string;
    new_string: string;
    target_before_context?: string;
    target_after_context?: string;
}

interface BatchActionData {
    library_id: number;
    zotero_key: string;
    library_ref?: string;
    edits: BatchEdit[];
}

interface BatchEditError {
    index: number;
    error: string;
    error_code: string;
    error_candidates?: unknown[];
}

interface BatchValidateResponse {
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
    edit_errors?: BatchEditError[];
    current_value?: { note_title?: string; total_lines?: number; old_content?: string };
    normalized_action_data?: BatchActionData;
    preference?: string;
    warnings?: string[];
}

interface BatchUndoRecord {
    index: number;
    client_item_id?: string;
    operation?: string;
    undo_old_html?: string;
    undo_new_html?: string;
    undo_before_context?: string;
    undo_after_context?: string;
    undo_occurrence_contexts?: Array<{ before: string; after: string }>;
}

interface BatchExecuteResponse {
    success: boolean;
    error?: string | null;
    error_code?: string | null;
    result_data?: {
        library_id: number;
        zotero_key: string;
        library_ref?: string;
        applied: Array<{ index: number; client_item_id?: string; occurrences_replaced: number }>;
        warnings?: string[];
        undo: BatchUndoRecord[];
    };
}

function validateBatch(actionData: BatchActionData): Promise<BatchValidateResponse> {
    return post<BatchValidateResponse>('/beaver/agent-action/validate', {
        action_type: 'edit_note_batch',
        action_data: actionData,
    });
}

function executeBatch(
    actionData: BatchActionData,
    opts?: { timeout?: number },
): Promise<BatchExecuteResponse> {
    return post<BatchExecuteResponse>(
        '/beaver/agent-action/execute',
        { action_type: 'edit_note_batch', action_data: actionData },
        { timeout: opts?.timeout ?? 20000 },
    );
}

/**
 * Undo an applied batch through its per-edit undo records, replayed in
 * reverse request order via `/beaver/test/note-undo` (see file header for why
 * the v1 machinery is the reachable path). Each record is wrapped in a
 * v1-shaped action: the record's undo fields ARE the v1 undo field shape; a
 * rewrite record's full-body `undo_old_html` maps to v1's `undo_full_html`.
 */
async function undoBatchViaRecords(
    actionData: BatchActionData,
    exec: BatchExecuteResponse,
): Promise<void> {
    const undoRecords = exec.result_data?.undo ?? [];
    expect(undoRecords.length).toBeGreaterThan(0);
    const editsByIndex = new Map(actionData.edits.map((e) => [e.index, e]));

    for (const record of [...undoRecords].reverse()) {
        const edit = editsByIndex.get(record.index);
        const operation = record.operation ?? edit?.operation ?? 'str_replace';
        const applied = exec.result_data!.applied.find((a) => a.index === record.index);

        const proposed_data: Record<string, any> = {
            library_id: actionData.library_id,
            zotero_key: actionData.zotero_key,
            operation,
            old_string: edit?.old_string ?? '',
            new_string: edit?.new_string ?? '',
        };

        const result_data: Record<string, any> = operation === 'rewrite'
            ? {
                library_id: actionData.library_id,
                zotero_key: actionData.zotero_key,
                occurrences_replaced: 1,
                undo_full_html: record.undo_old_html,
            }
            : {
                library_id: actionData.library_id,
                zotero_key: actionData.zotero_key,
                occurrences_replaced: applied?.occurrences_replaced ?? 1,
                undo_old_html: record.undo_old_html,
                undo_new_html: record.undo_new_html,
                undo_before_context: record.undo_before_context,
                undo_after_context: record.undo_after_context,
                undo_occurrence_contexts: record.undo_occurrence_contexts,
            };

        const res = await undoEditNote({ proposed_data, result_data });
        expect(res.ok, `undo of edit ${record.index}: ${res.error ?? ''}`).toBe(true);
    }
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
    return count;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — edit_note_batch live tests will be skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    for (const { library_id, zotero_key } of createdNotes) {
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
});

async function seedNote(html: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

const THREE_PARA_HTML =
    '<p>Alpha sentence about batch normalization.</p>'
    + '<p>Bravo passage about learning rates.</p>'
    + '<p>Charlie section about gradient flow.</p>';

// ---------------------------------------------------------------------------
// 0. Dispatch smoke
// ---------------------------------------------------------------------------

describe('edit_note_batch dispatch', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('routes edit_note_batch to its validator (structured error, not unsupported_action_type)', async () => {
        const res = await validateBatch({
            library_id: LIBRARY_ID,
            zotero_key: 'ZZZZZZZZ',
            edits: [{ index: 0, operation: 'str_replace', old_string: 'a', new_string: 'b' }],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).not.toBe('unsupported_action_type');
        expect(res.error_code).toBe('item_not_found');
    });
});

// ---------------------------------------------------------------------------
// 1. Multi-edit batch happy path
// ---------------------------------------------------------------------------

describe('edit_note_batch multi-edit apply', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('validates and applies 3 str_replace edits in one action; all replacements land', async () => {
        const ref = await seedNote(THREE_PARA_HTML);

        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, client_item_id: 'c-0', operation: 'str_replace', old_string: 'Alpha sentence about batch normalization.', new_string: 'ALPHA sentence about BATCH NORMALIZATION.' },
                { index: 1, client_item_id: 'c-1', operation: 'str_replace', old_string: 'Bravo passage about learning rates.', new_string: 'BRAVO passage about LEARNING RATES.' },
                { index: 2, client_item_id: 'c-2', operation: 'str_replace', old_string: 'Charlie section about gradient flow.', new_string: 'CHARLIE section about GRADIENT FLOW.' },
            ],
        };

        const validation = await validateBatch(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        expect(validation.edit_errors).toBeUndefined();
        expect(validation.current_value?.note_title).toBeTruthy();
        expect(validation.current_value?.total_lines).toBeGreaterThan(0);

        const exec = await executeBatch(actionData, { timeout: 20000 });
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, client_item_id: 'c-0', occurrences_replaced: 1 }),
            expect.objectContaining({ index: 1, client_item_id: 'c-1', occurrences_replaced: 1 }),
            expect.objectContaining({ index: 2, client_item_id: 'c-2', occurrences_replaced: 1 }),
        ]);
        expect(exec.result_data?.undo).toHaveLength(3);

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('ALPHA sentence about BATCH NORMALIZATION.');
        expect(after.saved_html).toContain('BRAVO passage about LEARNING RATES.');
        expect(after.saved_html).toContain('CHARLIE section about GRADIENT FLOW.');
        expect(after.saved_html).not.toContain('Alpha sentence about batch normalization.');

        // The single-write (one setNote/one saveTx → one version bump)
        // contract is pinned by the unit tests; neither item.version nor a
        // footer proxy is observable over HTTP (headless runs have no active
        // thread, so no "Edited by Beaver" footer is stamped).
        expect(countOccurrences(after.saved_html, 'Edited by Beaver')).toBeLessThanOrEqual(1);
    }, 30000);
});

// ---------------------------------------------------------------------------
// 2. Stale edit — fail-closed with per-edit diagnostics
// ---------------------------------------------------------------------------

describe('edit_note_batch stale edit', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('names the failing index in edit_errors and leaves the note unchanged (validate + execute)', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const before = await readNote(ref.library_id, ref.zotero_key);

        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: 'Alpha sentence about batch normalization.', new_string: 'X.' },
                { index: 1, operation: 'str_replace', old_string: 'THIS TEXT WAS NEVER IN THE NOTE.', new_string: 'Y.' },
                { index: 2, operation: 'str_replace', old_string: 'Charlie section about gradient flow.', new_string: 'Z.' },
            ],
        };

        const validation = await validateBatch(actionData);
        expect(validation.valid).toBe(false);
        expect(validation.error_code).toBe('old_string_not_found');
        expect(validation.error).toContain('1 of 3');

        // Fail-closed at execute too: the whole batch is rejected, nothing lands.
        const exec = await executeBatch(actionData, { timeout: 20000 });
        expect(exec.success).toBe(false);
        expect(exec.error_code).toBe('old_string_not_found');
        expect(exec.error).toContain('edit 1');

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toBe(before.saved_html);
        expect(after.saved_html).toContain('Alpha sentence about batch normalization.');
        expect(after.saved_html).not.toContain('X.');

        // CONTRACT: the validate response carries per-edit diagnostics naming
        // ONLY the failing index. The validator produces edit_errors (pinned
        // by unit tests through the same dispatch), but the dev HTTP wrapper
        // `handleAgentActionValidateHttpRequest` (useHttpEndpoints.ts) omits
        // the field from its whitelist — this assertion fails until the
        // wrapper forwards `edit_errors`. Do not water down: the production
        // WS path sends the full response, and live tests should see it too.
        expect(validation.edit_errors).toHaveLength(1);
        expect(validation.edit_errors![0].index).toBe(1);
        expect(validation.edit_errors![0].error_code).toBe('old_string_not_found');
    }, 30000);
});

// ---------------------------------------------------------------------------
// 3. Overlapping pair
// ---------------------------------------------------------------------------

describe('edit_note_batch overlapping edits', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('rejects two edits with intersecting target ranges and leaves the note unchanged', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const before = await readNote(ref.library_id, ref.zotero_key);

        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                // Both target the first paragraph and their ranges intersect
                // on "about batch".
                { index: 0, operation: 'str_replace', old_string: 'Alpha sentence about batch', new_string: 'ALPHA SENTENCE ABOUT BATCH' },
                { index: 1, operation: 'str_replace', old_string: 'about batch normalization.', new_string: 'about BATCH NORM.' },
            ],
        };

        const validation = await validateBatch(actionData);
        expect(validation.valid).toBe(false);
        expect(validation.error_code).toBe('overlapping_edits');

        const exec = await executeBatch(actionData, { timeout: 20000 });
        expect(exec.success).toBe(false);
        expect(exec.error_code).toBe('overlapping_edits');

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toBe(before.saved_html);

        // CONTRACT: per-edit conflict diagnostics naming both indices. Fails
        // until the dev HTTP wrapper forwards `edit_errors` (see the stale-
        // edit test above for details) — do not water down.
        expect(validation.edit_errors).toHaveLength(1);
        expect(validation.edit_errors![0].error_code).toBe('overlapping_edits');
        expect(validation.edit_errors![0].error).toMatch(/Edit 1 overlaps edit\D*0/);
    }, 30000);
});

// ---------------------------------------------------------------------------
// 4. Undo via per-edit records with drift tolerance
// ---------------------------------------------------------------------------

describe('edit_note_batch undo via per-edit records', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('reverts both batch edits after a subsequent manual edit; the manual edit survives', async () => {
        const ref = await seedNote(THREE_PARA_HTML);

        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: 'Alpha sentence about batch normalization.', new_string: 'ALPHA EDIT ONE APPLIED.' },
                { index: 1, operation: 'str_replace', old_string: 'Bravo passage about learning rates.', new_string: 'BRAVO EDIT TWO APPLIED.' },
            ],
        };

        const exec = await executeBatch(actionData, { timeout: 20000 });
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.undo).toHaveLength(2);

        // Drift the note AFTER the batch: append a marker paragraph through
        // the v1 edit_note append operation (the HTTP-reachable stand-in for a
        // manual user edit).
        const marker = '<p>MANUAL MARKER PARAGRAPH QXZV.</p>';
        const drift = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'append',
            old_string: '',
            new_string: marker,
        }, { timeout: 20000 });
        expect(drift.success, drift.error ?? undefined).toBe(true);

        const mid = await readNote(ref.library_id, ref.zotero_key);
        expect(mid.saved_html).toContain('ALPHA EDIT ONE APPLIED.');
        expect(mid.saved_html).toContain('MANUAL MARKER PARAGRAPH QXZV.');

        // Undo the batch through its per-edit undo records (reverse order).
        await undoBatchViaRecords(actionData, exec);

        const after = await readNote(ref.library_id, ref.zotero_key);
        // Both batch edits reverted…
        expect(after.saved_html).toContain('Alpha sentence about batch normalization.');
        expect(after.saved_html).toContain('Bravo passage about learning rates.');
        expect(after.saved_html).not.toContain('ALPHA EDIT ONE APPLIED.');
        expect(after.saved_html).not.toContain('BRAVO EDIT TWO APPLIED.');
        // …and the manual drift edit SURVIVES (the point of per-edit undo).
        expect(after.saved_html).toContain('MANUAL MARKER PARAGRAPH QXZV.');
    }, 45000);
});

// ---------------------------------------------------------------------------
// 5. Single-rewrite batch apply + undo
// ---------------------------------------------------------------------------

describe('edit_note_batch single-rewrite', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('applies a rewrite batch and undo restores the original body from the full-body undo record', async () => {
        const ref = await seedNote(THREE_PARA_HTML);

        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'rewrite', new_string: '<p>Wholesale batch replacement body.</p>' },
            ],
        };

        const validation = await validateBatch(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        // Single-rewrite batches surface the pre-edit content for diffing.
        expect(validation.current_value?.old_content).toBeTruthy();

        const exec = await executeBatch(actionData, { timeout: 20000 });
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.undo).toHaveLength(1);
        expect(exec.result_data?.undo[0].operation).toBe('rewrite');
        // Rewrite undo record carries the FULL pre-edit stripped body.
        expect(exec.result_data?.undo[0].undo_old_html).toContain('Alpha sentence about batch normalization.');
        expect(exec.result_data?.undo[0].undo_old_html).toContain('Charlie section about gradient flow.');

        const mid = await readNote(ref.library_id, ref.zotero_key);
        expect(mid.saved_html).toContain('Wholesale batch replacement body.');
        expect(mid.saved_html).not.toContain('Bravo passage about learning rates.');

        await undoBatchViaRecords(actionData, exec);

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('Alpha sentence about batch normalization.');
        expect(after.saved_html).toContain('Bravo passage about learning rates.');
        expect(after.saved_html).toContain('Charlie section about gradient flow.');
        expect(after.saved_html).not.toContain('Wholesale batch replacement body.');
    }, 45000);
});
