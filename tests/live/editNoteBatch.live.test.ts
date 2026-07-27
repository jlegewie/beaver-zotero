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
 *   6. Replay-order regression matrix: whole-batch undo through
 *      `/beaver/test/note-undo` for batches that combine a deletion with a
 *      nearby higher-index sibling edit, across distance, index order,
 *      multiple deletions, a contiguous str_replace_all deletion, and
 *      double-undo idempotency.
 *
 * Undo-path note: `/beaver/test/note-undo` dispatches
 * `undoEditNoteOrBatchAction`, which routes to the production batch undo
 * (`undoEditNoteBatchAction`) when the posted action's `action_type` is
 * `edit_note_batch`, or to the v1 single-edit undo otherwise. Section 6 below
 * exercises the batch path directly: it posts the whole batch action
 * (`proposed_data` = the executed `action_data`, `result_data` = the
 * execute response's `result_data`, which carries the per-edit undo
 * records) and lets `undoEditNoteBatchAction` replay those records itself.
 * Sections 4 and 5 instead replay the per-edit undo records one at a time
 * through the v1 undo machinery (`undoBatchViaRecords`) — that pins the
 * drift-tolerance property of the records themselves, independent of the
 * batch replay loop.
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

/**
 * Collapses whitespace runs between adjacent tags (e.g. block separators the
 * note editor's serializer inserts on save) so post-undo HTML can be compared
 * against pre-edit fragments without being sensitive to that formatting.
 */
function collapseInterTagWhitespace(html: string): string {
    return html.replace(/>\s+</g, '><');
}

/**
 * Read a note back after an undo, retrying briefly until `expected` appears.
 *
 * The undo endpoint resolves once its save resolves, but a note write can
 * still be settling when the following read lands while the instance is busy.
 * Polling keeps these assertions about undo correctness rather than read
 * timing. A genuinely unreverted edit still fails: the loop gives up after the
 * deadline and returns the last HTML it saw, so the assertion reports the real
 * document.
 */
async function readNoteAfterUndo(
    libraryId: number,
    zoteroKey: string,
    expected: string,
    { attempts = 8, delayMs = 250 }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
    let html = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
        html = collapseInterTagWhitespace((await readNote(libraryId, zoteroKey)).saved_html);
        if (html.includes(expected)) return html;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return html;
}

/**
 * Validate a batch action and apply it via the returned
 * `normalized_action_data` — required for insert_after/insert_before edits,
 * whose `new_string` is only merged with `old_string` by validate; executing
 * the raw unmerged action produces a different result.
 */
async function applyBatch(
    actionData: BatchActionData,
): Promise<{ normalized: BatchActionData; exec: BatchExecuteResponse }> {
    const validation = await validateBatch(actionData);
    expect(validation.valid, validation.error ?? undefined).toBe(true);
    const normalized = validation.normalized_action_data ?? actionData;
    const exec = await executeBatch(normalized, { timeout: 20000 });
    expect(exec.success, exec.error ?? undefined).toBe(true);
    return { normalized, exec };
}

/**
 * Undo an applied batch through the production batch-undo path
 * (`undoEditNoteOrBatchAction` → `undoEditNoteBatchAction`), dispatched by
 * `/beaver/test/note-undo` when the posted action's `action_type` is
 * `edit_note_batch`.
 */
async function undoBatch(
    normalized: BatchActionData,
    exec: BatchExecuteResponse,
): Promise<{ ok: boolean; error?: string }> {
    return undoEditNote({
        action_type: 'edit_note_batch',
        proposed_data: normalized,
        result_data: exec.result_data,
        status: 'applied',
    });
}

/** Builds a run of filler text at least `minChars` long, then truncates to exactly `minChars`. */
function fillerText(minChars: number): string {
    const words = 'filler padding buffer spacer margin gap distance words repeated to reach the requested length ';
    let text = '';
    while (text.length < minChars) text += words;
    return text.slice(0, minChars);
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
        // ONLY the failing index. The dev HTTP wrapper
        // `handleAgentActionValidateHttpRequest` (useHttpEndpoints.ts)
        // forwards `edit_errors`; this assertion pins that forwarding in
        // addition to the validator behavior itself. Do not water down.
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

        // CONTRACT: per-edit conflict diagnostics naming both indices,
        // forwarded through the dev HTTP wrapper's `edit_errors` field (see
        // the stale-edit test above) — do not water down.
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

// ---------------------------------------------------------------------------
// 6. Undo replay-order regression matrix
// ---------------------------------------------------------------------------
//
// Batch undo replays per-edit undo records in DESCENDING index order against
// one evolving document (see `undoEditNoteBatchAction`). A deletion record
// (`str_replace` with an empty `new_string`) carries no applied fragment to
// search for, so it is located purely from its stored before/after context —
// and that context must describe the document state at the exact point in
// replay where the deletion record is reverted, not the fully-applied
// snapshot the batch produced. These tests pin that property across index
// order, distance between edits, multiple deletions, a contiguous
// str_replace_all deletion, and double-undo idempotency, by posting the whole
// batch action straight to `/beaver/test/note-undo` (see file header).

describe('edit_note_batch undo — replay-order regression matrix', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    const OVERVIEW_NOTE_HTML =
        '<h2>Overview</h2>'
        + '<p>The programme ran for three years across four regions.</p>'
        + '<p>An interim review was published in year two.</p>'
        + '<h2>Key points</h2><ul>'
        + '<li>Recruitment exceeded the original target.</li>'
        + '<li>Retention varied by region.</li>'
        + '<li>Costs stayed within budget.</li></ul>';
    const DELETE_FRAGMENT = '<p>An interim review was published in year two.</p>';
    const INSERTED_LI_TEXT = 'Data sharing agreements were signed.';

    it('restores a deletion whose after-context region was edited by a higher-index insertion', async () => {
        const ref = await seedNote(OVERVIEW_NOTE_HTML);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: DELETE_FRAGMENT, new_string: '' },
                { index: 1, operation: 'insert_after', old_string: '<li>Costs stayed within budget.</li>', new_string: `<li>${INSERTED_LI_TEXT}</li>` },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const mid = await readNote(ref.library_id, ref.zotero_key);
        expect(mid.saved_html).not.toContain('An interim review was published in year two.');
        expect(mid.saved_html).toContain(INSERTED_LI_TEXT);

        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, DELETE_FRAGMENT);
        expect(after).toContain(DELETE_FRAGMENT);
        expect(after).not.toContain(INSERTED_LI_TEXT);
    }, 30000);

    it('restores identically when the insertion is given the lower index', async () => {
        const ref = await seedNote(OVERVIEW_NOTE_HTML);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'insert_after', old_string: '<li>Costs stayed within budget.</li>', new_string: `<li>${INSERTED_LI_TEXT}</li>` },
                { index: 1, operation: 'str_replace', old_string: DELETE_FRAGMENT, new_string: '' },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, DELETE_FRAGMENT);
        expect(after).toContain(DELETE_FRAGMENT);
        expect(after).not.toContain(INSERTED_LI_TEXT);
    }, 30000);

    function buildDistanceCase(gapChars: number) {
        const siblingOld = 'Retention varied by region across every measured site.';
        const siblingNew = 'RETENTION VARIED ACROSS EVERY MEASURED SITE.';
        const html =
            '<h2>Overview</h2>'
            + '<p>The programme ran for three years across four regions.</p>'
            + DELETE_FRAGMENT
            + `<p>${fillerText(gapChars)}</p>`
            + `<p>${siblingOld}</p>`;
        return { html, siblingOld, siblingNew };
    }

    it('restores a deletion whose higher-index str_replace sibling sits ~50 chars after the seam', async () => {
        const { html, siblingOld, siblingNew } = buildDistanceCase(40);
        const ref = await seedNote(html);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: DELETE_FRAGMENT, new_string: '' },
                { index: 1, operation: 'str_replace', old_string: siblingOld, new_string: siblingNew },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, DELETE_FRAGMENT);
        expect(after).toContain(DELETE_FRAGMENT);
        expect(after).toContain(siblingOld);
        expect(after).not.toContain(siblingNew);
    }, 30000);

    it('restores a deletion whose higher-index str_replace sibling sits ~400 chars after the seam', async () => {
        const { html, siblingOld, siblingNew } = buildDistanceCase(390);
        const ref = await seedNote(html);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: DELETE_FRAGMENT, new_string: '' },
                { index: 1, operation: 'str_replace', old_string: siblingOld, new_string: siblingNew },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, DELETE_FRAGMENT);
        expect(after).toContain(DELETE_FRAGMENT);
        expect(after).toContain(siblingOld);
        expect(after).not.toContain(siblingNew);
    }, 30000);

    it('restores two <p> deletions applied within the same 200-char window', async () => {
        const firstFragment = '<p>First removable paragraph included here for the test.</p>';
        const secondFragment = '<p>Second removable paragraph included immediately after it.</p>';
        const html =
            '<h2>Overview</h2>'
            + '<p>The programme ran for three years across four regions.</p>'
            + firstFragment
            + secondFragment
            + '<p>Trailing paragraph that remains in the note throughout.</p>';

        const ref = await seedNote(html);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: firstFragment, new_string: '' },
                { index: 1, operation: 'str_replace', old_string: secondFragment, new_string: '' },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, firstFragment);
        expect(after).toContain(firstFragment);
        expect(after).toContain(secondFragment);
    }, 30000);

    it('restores all occurrences of a contiguous str_replace_all deletion', async () => {
        const html = '<p>Begin redacted redacted redacted end of sentence.</p>';
        const ref = await seedNote(html);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace_all', old_string: 'redacted ', new_string: '' },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const mid = await readNote(ref.library_id, ref.zotero_key);
        expect(mid.saved_html).not.toContain('redacted');
        expect(mid.saved_html).toContain('Begin end of sentence.');

        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, 'Begin redacted redacted redacted end of sentence.');
        expect(countOccurrences(after, 'redacted')).toBe(3);
        expect(after).toContain('Begin redacted redacted redacted end of sentence.');
    }, 30000);

    it('undoing the same batch twice is idempotent — the second call no-ops without further changes', async () => {
        const deleteFragment = '<p>This paragraph will be deleted for the idempotency test scenario.</p>';
        const html =
            '<h2>Overview</h2>'
            + '<p>The programme delivers services across several sites nationally today.</p>'
            + deleteFragment
            + '<p>Investment in the region grew as the region matured and the region expanded its programs.</p>';

        const ref = await seedNote(html);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: deleteFragment, new_string: '' },
                { index: 1, operation: 'str_replace_all', old_string: 'region', new_string: 'district' },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);

        const undo1 = await undoBatch(normalized, exec);
        expect(undo1.ok, undo1.error ?? '').toBe(true);
        const afterFirst = await readNoteAfterUndo(ref.library_id, ref.zotero_key, deleteFragment);
        expect(afterFirst).toContain(deleteFragment);
        expect(countOccurrences(afterFirst, 'region')).toBe(3);
        expect(afterFirst).not.toContain('district');

        const undo2 = await undoBatch(normalized, exec);
        expect(undo2.ok, undo2.error ?? '').toBe(true);
        const afterSecond = collapseInterTagWhitespace((await readNote(ref.library_id, ref.zotero_key)).saved_html);
        expect(afterSecond).toBe(afterFirst);
    }, 45000);

    it('restores a deletion whose lower-offset before-context region was edited by a higher-index sibling', async () => {
        const siblingOld = 'Sibling target sentence that sits well before the deletion point.';
        const siblingNew = 'SIBLING TARGET SENTENCE UPDATED BEFORE THE DELETION POINT.';
        const deleteFragment = '<p>Paragraph slated for deletion in this scenario entirely.</p>';
        const html =
            '<h2>Overview</h2>'
            + `<p>${siblingOld}</p>`
            + `<p>${fillerText(150)}</p>`
            + deleteFragment
            + '<p>Trailing paragraph that remains untouched throughout.</p>';

        const ref = await seedNote(html);
        const actionData: BatchActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [
                { index: 0, operation: 'str_replace', old_string: deleteFragment, new_string: '' },
                { index: 1, operation: 'str_replace', old_string: siblingOld, new_string: siblingNew },
            ],
        };

        const { normalized, exec } = await applyBatch(actionData);
        const undo = await undoBatch(normalized, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const after = await readNoteAfterUndo(ref.library_id, ref.zotero_key, deleteFragment);
        expect(after).toContain(deleteFragment);
        expect(after).toContain(siblingOld);
        expect(after).not.toContain(siblingNew);
    }, 30000);
});
