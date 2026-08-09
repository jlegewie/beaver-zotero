/**
 * Live tests for the edit_note_blocks agent action.
 *
 * These tests run against a live Zotero instance with the Beaver plugin
 * loaded (dev build — test-only endpoints are only registered when
 * `NODE_ENV === 'development'`).
 *
 * Coverage:
 *   0. Dispatch smoke — edit_note_blocks reaches its validator (a bogus note
 *      returns a structured validation error, not unsupported_action_type).
 *      This is the canary for a missing dispatch registration.
 *   1. read_note snapshot → numeric replace: the token issued by
 *      `/beaver/note/read` verifies, the edit applies, and EXACTLY the
 *      addressed block changed (line-by-line byte comparison of the
 *      simplified projection).
 *   2. Snapshot mismatch: read → out-of-band drift → edit with the stale
 *      token. Validate AND execute refuse with `snapshot_mismatch`, the note
 *      is unchanged, and validate's `current_value` carries a fresh note +
 *      fresh token that is then used to re-address the same edit successfully.
 *   3. apply → undo → re-apply: after undo the stored body equals the pre-edit
 *      body byte-for-byte apart from the Beaver edit footer, the ORIGINAL
 *      snapshot still verifies, and re-applying the same action reproduces the
 *      first application's bytes.
 *   4. Locator-only edit: an edit that changes nothing but a citation's `loc`
 *      applies and undoes byte-exactly. The address snapshot is UNCHANGED
 *      across the edit (locators are masked out of the digest), which is
 *      exactly the shape that can fool a normalizing "already undone" check.
 *   5. Partial application against real ProseMirror normalization: one edit of
 *      three carries a stale `expect`; the other two apply, and the stale one
 *      comes back skipped with `expect_mismatch` and the real block text in
 *      `actual`.
 *   6. Real annotation HTML: a whole-annotation delete undoes byte-exactly,
 *      while an edit that alters the annotation's inner text is SKIPPED with
 *      `annotation_immutable` while its sibling edit still applies.
 *   7. `after: 'end'` insert lands ABOVE the Beaver footers (regression guard
 *      for a defect found in review) and the advisory renumbering round-trips
 *      against a fresh read.
 *   8. Citation degrade: content citing a nonexistent id degrades to plain
 *      text with a warning instead of failing the edit.
 *   9. `block: 'all'` rewrite + undo restores the original body and the
 *      `data-schema-version` wrapper survives both directions.
 *  10. Destructive escalation: `delete from_block:1 to_block:<last>` over a
 *      long note sets `destructive_rewrite: true` on the normalized action,
 *      and executing it WITHOUT that approval flag is refused.
 *
 * ── Harness notes (read before extending this file) ─────────────────────────
 *
 * SNAPSHOT SOURCE. The address snapshot is produced by `read_note`, reachable
 * over HTTP at `/beaver/note/read` (a production endpoint, registered in
 * `react/hooks/useHttpEndpoints.ts` for dev/staging builds). Its response is
 * `WSReadNoteResponse` verbatim, so `snapshot`, `content` and `total_lines`
 * are all available. Every numeric test here derives its block numbers from
 * that response rather than hard-coding them — the simplified projection is
 * exactly what the model would see, and hard-coded numbers would silently
 * decay when the simplifier changes.
 *
 * UNDO PATH. `/beaver/test/note-undo` dispatches `undoEditNoteVariantAction`,
 * which routes on the posted action's `action_type`; `edit_note_blocks` reaches
 * `undoEditNoteBlocksAction` (react/utils/editNoteBlocksActions.ts), which
 * replays `result_data.undo` in reverse through the shared batch replay chain.
 * So every undo here posts the WHOLE action — `action_type` included, since
 * omitting it would silently route to the v1 single-edit undo.
 *
 * FOOTERS. `addOrUpdateEditFooter` only stamps a footer when a chat thread is
 * current. A headless HTTP run usually has none, so section 7 SEEDS both Beaver
 * footers into the note instead of relying on one being stamped. Body
 * comparisons strip the edit footer (see `stripEditFooter`) so they hold either
 * way.
 *
 * KNOWN HARNESS GAPS (not worked around, not invented over):
 *   - `handleAgentActionExecuteHttpRequest` forwards only
 *     `{ success, error, error_code, error_candidates, result_data }`. The
 *     execute-side `refreshed_note` (the recovery payload carrying the fresh
 *     note + token on an execute-time `snapshot_mismatch`) is DROPPED by the
 *     HTTP wrapper, so section 2 asserts the fresh-content contract on the
 *     validate path, where `current_value` IS forwarded.
 *   - The `preference` field carries the RESOLVED user preference value
 *     ('always_ask' | 'always_apply' | 'continue_without_applying'), not the
 *     preference GROUP the action was classified into. Section 10 therefore
 *     pins the observable signal — `destructive_rewrite: true` on the
 *     normalized action, plus the execute-time refusal it gates — and leaves
 *     "which group was consulted" to the unit tests.
 *
 * Run: `ZOTERO_HTTP_PORT=<port> npx vitest run --config vitest.live.config.ts tests/live/editNoteBlocks.live.test.ts`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { PARENT_ITEM } from '../helpers/fixtures';
import {
    createNote,
    deleteNote,
    readNote,
    undoEditNote,
    executeEditNote,
} from './helpers/noteTestClient';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

// ---------------------------------------------------------------------------
// Block action wire types + HTTP wrappers
// ---------------------------------------------------------------------------

type BlockOp = 'replace' | 'insert' | 'delete';

interface BlockEdit {
    index: number;
    client_item_id?: string;
    op: BlockOp;
    block?: number | 'all';
    after?: number | 'end';
    from_block?: number;
    to_block?: number;
    expect?: string;
    expect_end?: string;
    content?: string;
    // Persisted display metadata, written by validate onto normalized edits.
    skip_reason_code?: string;
    skip_reason?: string;
    operation?: string;
    old_string?: string;
    new_string?: string;
}

interface BlocksActionData {
    library_id: number;
    zotero_key: string;
    library_ref?: string;
    snapshot?: string;
    destructive_rewrite?: boolean;
    edits: BlockEdit[];
}

interface BlockEditError {
    index: number;
    error: string;
    error_code: string;
    actual?: string;
}

interface BlocksCurrentValue {
    kind?: string;
    note_title?: string;
    total_lines?: number;
    snapshot?: string;
    applicable_count?: number;
    skipped_count?: number;
    old_content?: string;
    note?: string;
    truncated?: boolean;
}

interface BlocksValidateResponse {
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
    edit_errors?: BlockEditError[];
    current_value?: BlocksCurrentValue;
    normalized_action_data?: BlocksActionData;
    preference?: string;
    warnings?: string[];
}

interface BlocksUndoRecord {
    index: number;
    client_item_id?: string;
    op: BlockOp;
    undo_scope?: 'whole_body';
    undo_old_html?: string;
    undo_new_html?: string;
    undo_before_context?: string;
    undo_after_context?: string;
}

interface BlocksExecuteResponse {
    success: boolean;
    error?: string | null;
    error_code?: string | null;
    result_data?: {
        library_id: number;
        zotero_key: string;
        library_ref?: string;
        address_pre_snapshot?: string;
        address_post_snapshot?: string;
        applied: Array<{ index: number; client_item_id?: string; blocks: string }>;
        skipped: Array<{
            index: number;
            client_item_id?: string;
            reason_code: string;
            reason: string;
            actual?: string;
            block_hint?: string;
        }>;
        warnings?: string[];
        undo: BlocksUndoRecord[];
    };
}

function validateBlocks(actionData: BlocksActionData): Promise<BlocksValidateResponse> {
    return post<BlocksValidateResponse>('/beaver/agent-action/validate', {
        action_type: 'edit_note_blocks',
        action_data: actionData,
    });
}

function executeBlocks(
    actionData: BlocksActionData,
    opts?: { timeout?: number },
): Promise<BlocksExecuteResponse> {
    return post<BlocksExecuteResponse>(
        '/beaver/agent-action/execute',
        { action_type: 'edit_note_blocks', action_data: actionData },
        { timeout: opts?.timeout ?? 20000 },
    );
}

/**
 * Undo an applied block action through the production block-undo path
 * (`undoEditNoteVariantAction` → `undoEditNoteBlocksAction`). `action_type`
 * is what dispatches; without it the v1 single-edit undo would run instead.
 */
function undoBlocks(
    actionData: BlocksActionData,
    exec: BlocksExecuteResponse,
): Promise<{ ok: boolean; error?: string }> {
    return undoEditNote({
        action_type: 'edit_note_blocks',
        proposed_data: actionData as unknown as Record<string, any>,
        result_data: exec.result_data as unknown as Record<string, any>,
        status: 'applied',
    });
}

// ---------------------------------------------------------------------------
// read_note (the snapshot source)
// ---------------------------------------------------------------------------

interface ReadNoteResponse {
    success: boolean;
    error?: string;
    content?: string;
    total_lines?: number;
    snapshot?: string;
    title?: string;
}

interface NoteView {
    /** The simplified projection, exactly as the model would see it. */
    content: string;
    /** `content.split('\n')` — block N is `lines[N - 1]`. */
    lines: string[];
    total_lines: number;
    snapshot: string;
}

/** Full (unpaginated) read_note, which is what mints a whole-note read window. */
async function readBlocks(ref: { library_id: number; zotero_key: string }): Promise<NoteView> {
    const res = await post<ReadNoteResponse>('/beaver/note/read', {
        note_id: `${ref.library_id}-${ref.zotero_key}`,
    });
    if (!res.success || res.content === undefined || !res.snapshot) {
        throw new Error(`read_note failed: ${res.error ?? 'no content/snapshot'}`);
    }
    return {
        content: res.content,
        lines: res.content.split('\n'),
        total_lines: res.total_lines ?? res.content.split('\n').length,
        snapshot: res.snapshot,
    };
}

/** 1-based block number of the first line containing `needle`. Fails loudly. */
function blockOf(lines: string[], needle: string): number {
    const idx = lines.findIndex((line) => line.includes(needle));
    if (idx === -1) {
        throw new Error(`No simplified block contains ${JSON.stringify(needle)}. Lines:\n${lines.join('\n')}`);
    }
    return idx + 1;
}

/** 1-based number of the last block that is not the trailing empty line. */
function lastContentBlock(lines: string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() !== '') return i + 1;
    }
    throw new Error('Simplified projection has no content lines.');
}

// ---------------------------------------------------------------------------
// Raw-HTML comparison helpers
// ---------------------------------------------------------------------------

/**
 * Collapses whitespace runs between adjacent tags (block separators the note
 * editor's serializer inserts on save), matching editNoteBatch.live.test.ts.
 * Everything else — attribute bytes, text bytes, entity encoding — is compared
 * verbatim, so "byte-for-byte" assertions below are byte-for-byte modulo this
 * one documented, pre-existing normalization.
 */
function collapseInterTagWhitespace(html: string): string {
    return html.replace(/>\s+</g, '><');
}

/**
 * Remove the "Edited by Beaver" footer. Mirrors `EDIT_FOOTER_REGEX` in
 * `src/utils/noteEditFooter.ts`; kept local so a change there shows up here as
 * a failing comparison rather than as a silently different definition.
 */
function stripEditFooter(html: string): string {
    return html.replace(/<p><span style="color:[^"]*">Edited by Beaver[\s\S]*?<\/span><\/p>/g, '');
}

/** The comparable form used by every "unchanged / restored" assertion. */
function comparableBody(html: string): string {
    return stripEditFooter(collapseInterTagWhitespace(html));
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
    return count;
}

/**
 * Read a note back after an undo, retrying briefly until `expected` appears.
 * Same rationale as the batch suite: the undo endpoint resolves once its save
 * resolves, but a busy instance can still be settling when the next read lands.
 * A genuinely unreverted edit still fails — the loop gives up and returns the
 * last HTML it saw.
 */
async function readSavedAfterUndo(
    ref: { library_id: number; zotero_key: string },
    expected: string,
    { attempts = 8, delayMs = 250 }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
    let html = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
        html = collapseInterTagWhitespace((await readNote(ref.library_id, ref.zotero_key)).saved_html);
        if (html.includes(expected)) return html;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return html;
}

async function readSaved(ref: { library_id: number; zotero_key: string }): Promise<string> {
    return (await readNote(ref.library_id, ref.zotero_key)).saved_html;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** A native Zotero citation span, for seeding a pre-existing citation. */
function rawCitation(opts: { key: string; locator?: string; label?: string }): string {
    const data = {
        citationItems: [{
            uris: [`http://zotero.org/users/1/items/${opts.key}`],
            locator: opts.locator ?? '',
        }],
        properties: {},
    };
    const encoded = encodeURIComponent(JSON.stringify(data));
    const inner = opts.label ?? '(Author, 2024)';
    return `<span class="citation" data-citation="${encoded}"><span class="citation-item">${inner}</span></span>`;
}

/** A native Zotero highlight-annotation span, for seeding a real annotation. */
function rawAnnotation(key: string, text: string): string {
    const data = { annotationKey: key, color: '#ffd400', pageLabel: '3' };
    return `<span class="highlight" data-annotation="${encodeURIComponent(JSON.stringify(data))}">${text}</span>`;
}

// Beaver footers in ProseMirror-canonical form — byte-identical to what
// `buildEditFooterHtml` emits and to what `parseCreatedFooter` recognizes.
const CREATED_FOOTER =
    '<p><span style="color: rgb(170, 170, 170);">Created by Beaver · '
    + '<a href="zotero://beaver/thread/live-blocks-thread" rel="noopener noreferrer nofollow">Chat</a></span></p>';
const EDIT_FOOTER =
    '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver · '
    + '<a href="zotero://beaver/thread/live-blocks-thread" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';

/**
 * Build filler prose of at least `minChars`, truncated to exactly `minChars`.
 * Used to push a note past `MIN_CHARS_TO_ESCALATE` (600 comparable characters)
 * in section 10 — below that threshold `assessNoteRewrite` never escalates, so
 * every other note in this file is deliberately kept SHORT to stay out of the
 * destructive-rewrite path.
 */
function fillerText(minChars: number): string {
    const words = 'programme evaluation cohort retention funding regional delivery outcomes measured across sites ';
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
            '\nZotero not available — edit_note_blocks live tests will be skipped.\n'
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
    '<p>Alpha paragraph about block addressing.</p>'
    + '<p>Bravo paragraph about numbered edits.</p>'
    + '<p>Charlie paragraph about snapshot tokens.</p>';

// ---------------------------------------------------------------------------
// 0. Dispatch smoke
// ---------------------------------------------------------------------------

describe('edit_note_blocks dispatch', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('routes edit_note_blocks to its validator (structured error, not unsupported_action_type)', async () => {
        const res = await validateBlocks({
            library_id: LIBRARY_ID,
            zotero_key: 'ZZZZZZZZ',
            // Structurally well-formed token: the shape gate only requires a
            // non-empty string, so validation gets past it and fails on the
            // note lookup — which is the dispatch signal we want.
            snapshot: 'h:0000000000000000:0:1-1',
            edits: [{
                index: 0,
                op: 'replace',
                block: 1,
                expect: '<p>anything at all here</p>',
                content: '<p>replacement</p>',
            }],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).not.toBe('unsupported_action_type');
        expect(res.error_code).toBe('item_not_found');
    });

    it('routes edit_note_blocks to its executor as well', async () => {
        const res = await executeBlocks({
            library_id: LIBRARY_ID,
            zotero_key: 'ZZZZZZZZ',
            snapshot: 'h:0000000000000000:0:1-1',
            edits: [{
                index: 0,
                op: 'replace',
                block: 1,
                expect: '<p>anything at all here</p>',
                content: '<p>replacement</p>',
            }],
        });
        expect(res.success).toBe(false);
        expect(res.error_code).not.toBe('unsupported_action_type');
        expect(res.error_code).toBe('item_not_found');
    });
});

// ---------------------------------------------------------------------------
// 1. read_note snapshot → numeric edit applies
// ---------------------------------------------------------------------------

describe('edit_note_blocks numeric replace from a read_note snapshot', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('verifies the read_note token and changes exactly the addressed block', async () => {
        const ref = await seedNote(THREE_PARA_HTML);

        const view = await readBlocks(ref);
        // The token read_note issues for a full read carries the whole-note
        // window `1-<total_lines>`.
        expect(view.snapshot).toMatch(/^h:[0-9a-f]{16}:\d+:1-\d+$/);
        expect(view.snapshot.endsWith(`:1-${view.total_lines}`)).toBe(true);

        const block = blockOf(view.lines, 'Bravo paragraph about numbered edits.');
        const newLine = '<p>BRAVO rewritten by block number.</p>';

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                client_item_id: 'b-0',
                op: 'replace',
                block,
                expect: view.lines[block - 1],
                content: newLine,
            }],
        };

        const validation = await validateBlocks(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        expect(validation.edit_errors).toBeUndefined();
        expect(validation.current_value?.note_title).toBeTruthy();
        expect(validation.current_value?.total_lines).toBe(view.total_lines);
        expect(validation.current_value?.applicable_count).toBe(1);
        expect(validation.current_value?.skipped_count).toBe(0);
        // The success-path token deliberately carries the EMPTY window: no note
        // body travels with it, so it must not license a blind numeric address.
        expect(validation.current_value?.snapshot?.endsWith(':0-0')).toBe(true);

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, client_item_id: 'b-0', blocks: String(block) }),
        ]);
        expect(exec.result_data?.skipped).toEqual([]);
        expect(exec.result_data?.undo).toHaveLength(1);
        expect(exec.result_data?.undo[0].op).toBe('replace');
        expect(exec.result_data?.address_pre_snapshot).toBe(view.snapshot);

        // EXACTLY one line differs, and it is the addressed one. Comparing the
        // whole line array rather than `toContain` is the point of the live
        // tier: it pins the real ProseMirror round trip, not a substring.
        const after = await readBlocks(ref);
        const expectedLines = [...view.lines];
        expectedLines[block - 1] = newLine;
        expect(after.lines).toEqual(expectedLines);
        expect(after.total_lines).toBe(view.total_lines);
    }, 30000);
});

// ---------------------------------------------------------------------------
// 2. Stale snapshot → snapshot_mismatch + recovery payload
// ---------------------------------------------------------------------------

describe('edit_note_blocks snapshot mismatch', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('refuses a stale-token edit, leaves the note untouched, and hands back fresh content to re-address', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const view = await readBlocks(ref);
        const block = blockOf(view.lines, 'Bravo paragraph about numbered edits.');
        const staleLine = view.lines[block - 1];

        // Drift the note out of band: the v1 edit_note append is the
        // HTTP-reachable stand-in for a user edit landing between read and edit.
        const drift = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'append',
            old_string: '',
            new_string: '<p>OUT OF BAND PARAGRAPH QXZV.</p>',
        }, { timeout: 20000 });
        expect(drift.success, drift.error ?? undefined).toBe(true);

        const driftedHtml = await readSaved(ref);

        const staleAction: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                op: 'replace',
                block,
                expect: staleLine,
                content: '<p>BRAVO rewritten against a stale numbering.</p>',
            }],
        };

        const validation = await validateBlocks(staleAction);
        expect(validation.valid).toBe(false);
        expect(validation.error_code).toBe('snapshot_mismatch');

        // CONTRACT: the refusal carries the CURRENT note so the model can
        // re-address without another read_note round trip.
        expect(validation.current_value?.kind).toBe('snapshot_mismatch');
        expect(validation.current_value?.note).toContain('OUT OF BAND PARAGRAPH QXZV.');
        expect(validation.current_value?.total_lines).toBeGreaterThan(view.total_lines);
        expect(validation.current_value?.snapshot).toBeTruthy();
        expect(validation.current_value?.snapshot).not.toBe(view.snapshot);
        // Body travelled with it, so the fresh token carries the whole-note window.
        expect(validation.current_value?.snapshot?.endsWith(`:1-${validation.current_value?.total_lines}`)).toBe(true);

        // Execute is fail-closed on the same token.
        //
        // NOTE: execute's own recovery payload (`refreshed_note`) is NOT
        // observable here — `handleAgentActionExecuteHttpRequest` does not
        // forward that field. The fresh-content contract is asserted on the
        // validate path above; see the harness-gap note in the file header.
        const exec = await executeBlocks(staleAction);
        expect(exec.success).toBe(false);
        expect(exec.error_code).toBe('snapshot_mismatch');

        const afterRefusal = await readSaved(ref);
        expect(afterRefusal).toBe(driftedHtml);

        // RECOVERY: the returned note + token re-address the same edit.
        const freshLines = (validation.current_value!.note as string).split('\n');
        const freshBlock = blockOf(freshLines, 'Bravo paragraph about numbered edits.');
        const recovered: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: validation.current_value!.snapshot as string,
            edits: [{
                index: 0,
                op: 'replace',
                block: freshBlock,
                expect: freshLines[freshBlock - 1],
                content: '<p>BRAVO rewritten after recovery.</p>',
            }],
        };
        const recoveredExec = await executeBlocks(recovered);
        expect(recoveredExec.success, recoveredExec.error ?? undefined).toBe(true);

        const finalView = await readBlocks(ref);
        expect(finalView.lines[freshBlock - 1]).toBe('<p>BRAVO rewritten after recovery.</p>');
        expect(finalView.content).toContain('OUT OF BAND PARAGRAPH QXZV.');
    }, 45000);
});

// ---------------------------------------------------------------------------
// 3. apply → undo → re-apply idempotency
// ---------------------------------------------------------------------------

describe('edit_note_blocks undo + re-apply', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('restores the pre-edit body byte-for-byte (modulo the edit footer) and re-applies identically', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const beforeHtml = await readSaved(ref);

        const view = await readBlocks(ref);
        const block = blockOf(view.lines, 'Bravo paragraph about numbered edits.');
        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                op: 'replace',
                block,
                expect: view.lines[block - 1],
                content: '<p>BRAVO replaced for the undo round trip.</p>',
            }],
        };

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        const appliedHtml = await readSaved(ref);
        expect(appliedHtml).toContain('BRAVO replaced for the undo round trip.');

        const undo = await undoBlocks(actionData, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const restored = await readSavedAfterUndo(ref, 'Bravo paragraph about numbered edits.');
        // BYTE-FOR-BYTE against the pre-edit body, with only the Beaver edit
        // footer excluded (it is appended by the apply and left behind by undo
        // when a chat thread is current; headless runs stamp none at all).
        expect(stripEditFooter(restored)).toBe(comparableBody(beforeHtml));

        // The ORIGINAL token still verifies: undo restored the exact projection
        // the block numbers were written against.
        const afterUndoView = await readBlocks(ref);
        expect(afterUndoView.snapshot).toBe(view.snapshot);
        expect(afterUndoView.lines).toEqual(view.lines);

        // Re-applying the same action resolves identically.
        const reExec = await executeBlocks(actionData);
        expect(reExec.success, reExec.error ?? undefined).toBe(true);
        expect(reExec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, blocks: String(block) }),
        ]);
        const reAppliedHtml = await readSaved(ref);
        expect(comparableBody(reAppliedHtml)).toBe(comparableBody(appliedHtml));
    }, 60000);
});

// ---------------------------------------------------------------------------
// 4. Locator-only edit
// ---------------------------------------------------------------------------
//
// A citation locator is masked out of the address digest (page-label caches
// drift asynchronously), so an edit that changes NOTHING but a locator leaves
// the snapshot token bit-identical while genuinely changing the note. That is
// precisely the shape a normalizing "already undone" check can mistake for a
// no-op, so undo has to revert it anyway.

describe('edit_note_blocks locator-only edit', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('applies a locator-only change and undoes it byte-exactly, with the snapshot unchanged throughout', async () => {
        const citation = rawCitation({ key: PARENT_ITEM.zotero_key, locator: '3' });
        const ref = await seedNote(
            `<p>Prose before the citation ${citation} and prose after it.</p>`
            + '<p>Second paragraph left untouched.</p>',
        );
        const beforeHtml = await readSaved(ref);

        const view = await readBlocks(ref);
        const block = blockOf(view.lines, '<citation ');
        const line = view.lines[block - 1];
        const locMatch = /loc="page(\d+)"/.exec(line);
        if (!locMatch) {
            throw new Error(`Seeded citation lost its locator in the simplified projection: ${line}`);
        }
        const originalLoc = Number(locMatch[1]);
        // Far from the original so a page-label translation cannot coincidentally
        // map the two values onto the same label.
        const newLoc = originalLoc + 41;
        const newLine = line.replace(/loc="page\d+"/, `loc="page${newLoc}"`);
        expect(newLine).not.toBe(line);

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                op: 'replace',
                block,
                expect: line,
                content: newLine,
            }],
        };

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);

        const appliedHtml = await readSaved(ref);
        // The stored note really changed…
        expect(comparableBody(appliedHtml)).not.toBe(comparableBody(beforeHtml));
        const appliedView = await readBlocks(ref);
        expect(appliedView.lines[block - 1]).toContain(`loc="page${newLoc}"`);
        // …while the address snapshot did NOT: locators are masked out of the
        // digest, which is the whole reason this case needs its own guard.
        expect(appliedView.snapshot).toBe(view.snapshot);

        const undo = await undoBlocks(actionData, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const restored = await readSavedAfterUndo(ref, 'Second paragraph left untouched.');
        expect(stripEditFooter(restored)).toBe(comparableBody(beforeHtml));

        const restoredView = await readBlocks(ref);
        expect(restoredView.lines[block - 1]).toBe(line);
        expect(restoredView.lines[block - 1]).toContain(`loc="page${originalLoc}"`);
    }, 60000);
});

// ---------------------------------------------------------------------------
// 5. Partial application with a stale expect
// ---------------------------------------------------------------------------

describe('edit_note_blocks partial application', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('applies the sound edits and skips the stale one with expect_mismatch + actual', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const view = await readBlocks(ref);

        const alpha = blockOf(view.lines, 'Alpha paragraph about block addressing.');
        const bravo = blockOf(view.lines, 'Bravo paragraph about numbered edits.');
        const charlie = blockOf(view.lines, 'Charlie paragraph about snapshot tokens.');

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [
                {
                    index: 0, client_item_id: 'p-0', op: 'replace', block: alpha,
                    expect: view.lines[alpha - 1],
                    content: '<p>ALPHA rewritten.</p>',
                },
                {
                    index: 1, client_item_id: 'p-1', op: 'replace', block: bravo,
                    // Stale: this text was never at this block.
                    expect: '<p>THIS TEXT WAS NEVER IN THE NOTE.</p>',
                    content: '<p>BRAVO must not be written.</p>',
                },
                {
                    index: 2, client_item_id: 'p-2', op: 'replace', block: charlie,
                    expect: view.lines[charlie - 1],
                    content: '<p>CHARLIE rewritten.</p>',
                },
            ],
        };

        const validation = await validateBlocks(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        expect(validation.current_value?.applicable_count).toBe(2);
        expect(validation.current_value?.skipped_count).toBe(1);
        // CONTRACT: per-edit diagnostics naming ONLY the failing index, carried
        // through the dev HTTP wrapper's `edit_errors` field. `actual` is the
        // whitespace-collapsed text really at that block — byte-compared here
        // against the projection read_note produced. Do not water down.
        expect(validation.edit_errors).toHaveLength(1);
        expect(validation.edit_errors![0].index).toBe(1);
        expect(validation.edit_errors![0].error_code).toBe('expect_mismatch');
        expect(validation.edit_errors![0].actual).toBe(view.lines[bravo - 1]);
        // The persisted per-edit display metadata marks the same edit skipped.
        const normalizedEdits = validation.normalized_action_data?.edits ?? [];
        expect(normalizedEdits[1]?.skip_reason_code).toBe('expect_mismatch');
        expect(normalizedEdits[0]?.skip_reason_code).toBeUndefined();
        expect(normalizedEdits[2]?.skip_reason_code).toBeUndefined();

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, client_item_id: 'p-0', blocks: String(alpha) }),
            expect.objectContaining({ index: 2, client_item_id: 'p-2', blocks: String(charlie) }),
        ]);
        expect(exec.result_data?.skipped).toHaveLength(1);
        expect(exec.result_data?.skipped[0]).toEqual(expect.objectContaining({
            index: 1,
            client_item_id: 'p-1',
            reason_code: 'expect_mismatch',
            actual: view.lines[bravo - 1],
        }));

        const after = await readBlocks(ref);
        const expectedLines = [...view.lines];
        expectedLines[alpha - 1] = '<p>ALPHA rewritten.</p>';
        expectedLines[charlie - 1] = '<p>CHARLIE rewritten.</p>';
        expect(after.lines).toEqual(expectedLines);
    }, 45000);
});

// ---------------------------------------------------------------------------
// 6. Real annotation HTML
// ---------------------------------------------------------------------------

describe('edit_note_blocks annotations', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    const ANNOTATION_TEXT = 'Annotated highlight sentence from the source.';
    const annotationNoteHtml = () =>
        '<p>Intro paragraph before the highlight.</p>'
        + `<p>${rawAnnotation('LIVEANN1', ANNOTATION_TEXT)}</p>`
        + '<p>Closing paragraph after the highlight.</p>';

    /** The stored annotation span, taken from the note's own bytes. */
    function storedAnnotationSpan(savedHtml: string): string {
        const m = /<span class="highlight" data-annotation="[^"]*">[\s\S]*?<\/span>/.exec(savedHtml);
        if (!m) throw new Error(`No stored annotation span found in:\n${savedHtml}`);
        return m[0];
    }

    it('deletes a whole annotation block and undo restores the annotation bytes exactly', async () => {
        const ref = await seedNote(annotationNoteHtml());
        const beforeHtml = await readSaved(ref);
        const storedSpan = storedAnnotationSpan(beforeHtml);

        const view = await readBlocks(ref);
        const block = blockOf(view.lines, '<annotation ');

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                op: 'delete',
                from_block: block,
                expect: view.lines[block - 1],
            }],
        };

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, blocks: '' }),
        ]);
        expect(exec.result_data?.undo[0].op).toBe('delete');

        const applied = await readSaved(ref);
        expect(applied).not.toContain('data-annotation');
        expect(applied).not.toContain(ANNOTATION_TEXT);

        const undo = await undoBlocks(actionData, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const restored = await readSavedAfterUndo(ref, ANNOTATION_TEXT);
        // Byte-exact restoration of the annotation span — its `data-annotation`
        // payload is URI-encoded JSON, so anything less than byte equality is a
        // corrupted annotation.
        expect(restored).toContain(collapseInterTagWhitespace(storedSpan));
        expect(stripEditFooter(restored)).toBe(comparableBody(beforeHtml));
    }, 45000);

    it('skips an edit that alters annotation text (annotation_immutable) while its sibling applies', async () => {
        const ref = await seedNote(annotationNoteHtml());
        const view = await readBlocks(ref);

        const intro = blockOf(view.lines, 'Intro paragraph before the highlight.');
        const annotationBlock = blockOf(view.lines, '<annotation ');
        const annotationLine = view.lines[annotationBlock - 1];
        // Same block, same annotation tag — only the inner TEXT changes.
        const tamperedLine = annotationLine.replace(ANNOTATION_TEXT, 'Annotated highlight sentence REWRITTEN.');
        expect(tamperedLine).not.toBe(annotationLine);

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [
                {
                    index: 0, op: 'replace', block: intro,
                    expect: view.lines[intro - 1],
                    content: '<p>Intro paragraph rewritten.</p>',
                },
                {
                    index: 1, op: 'replace', block: annotationBlock,
                    expect: annotationLine,
                    content: tamperedLine,
                },
            ],
        };

        const validation = await validateBlocks(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        expect(validation.edit_errors).toHaveLength(1);
        expect(validation.edit_errors![0].index).toBe(1);
        expect(validation.edit_errors![0].error_code).toBe('annotation_immutable');

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, blocks: String(intro) }),
        ]);
        expect(exec.result_data?.skipped).toHaveLength(1);
        expect(exec.result_data?.skipped[0]).toEqual(expect.objectContaining({
            index: 1,
            reason_code: 'annotation_immutable',
        }));

        const after = await readBlocks(ref);
        const expectedLines = [...view.lines];
        expectedLines[intro - 1] = '<p>Intro paragraph rewritten.</p>';
        expect(after.lines).toEqual(expectedLines);
        // The annotation survived untouched, bytes included.
        expect(after.lines[annotationBlock - 1]).toBe(annotationLine);
    }, 45000);
});

// ---------------------------------------------------------------------------
// 7. `after: 'end'` lands ABOVE the Beaver footers
// ---------------------------------------------------------------------------
//
// REGRESSION GUARD (defect found in review). Beaver footers are metadata: they
// are stripped from the simplified projection, so they occupy no block number,
// and an append at the end of the body must land ABOVE them rather than after
// them. Both footers are SEEDED here — a headless run has no current chat
// thread, so relying on one being stamped would make this test vacuous.

describe('edit_note_blocks insert after "end"', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    const MARKER = 'APPENDED ABOVE THE FOOTERS.';

    it('inserts above both Beaver footers, leaves their bytes intact, and renumbers consistently', async () => {
        const ref = await seedNote(THREE_PARA_HTML + CREATED_FOOTER + EDIT_FOOTER);

        const view = await readBlocks(ref);
        // Footers are invisible to the model — they are not addressable blocks.
        expect(view.content).not.toContain('Edited by Beaver');
        expect(view.content).not.toContain('Created by Beaver');

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                client_item_id: 'e-0',
                op: 'insert',
                after: 'end',
                content: `<p>${MARKER}</p>`,
            }],
        };

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.applied).toHaveLength(1);
        const advisoryBlocks = exec.result_data!.applied[0].blocks;

        const saved = collapseInterTagWhitespace(await readSaved(ref));
        // FOOTER BYTES SURVIVE. The created footer is compared verbatim; the
        // edit footer is compared by marker + multiplicity, because
        // `addOrUpdateEditFooter` legitimately rewrites its link list when a
        // chat thread happens to be current in the running instance.
        expect(saved).toContain(collapseInterTagWhitespace(CREATED_FOOTER));
        expect(countOccurrences(saved, 'Edited by Beaver')).toBe(1);
        expect(countOccurrences(saved, 'Created by Beaver')).toBe(1);

        // ORDERING: the inserted content precedes BOTH footers in the stored note.
        const markerAt = saved.indexOf(MARKER);
        expect(markerAt).toBeGreaterThan(-1);
        expect(markerAt).toBeLessThan(saved.indexOf('Created by Beaver'));
        expect(markerAt).toBeLessThan(saved.indexOf('Edited by Beaver'));

        // RENUMBERING ROUND-TRIP: the advisory address the action reported is
        // where a fresh read actually finds the inserted block.
        const after = await readBlocks(ref);
        expect(after.total_lines).toBe(view.total_lines + 1);
        expect(String(blockOf(after.lines, MARKER))).toBe(advisoryBlocks);
        const expectedLines = [...view.lines];
        // The trailing empty line stays last; the append lands just above it.
        expectedLines.splice(lastContentBlock(view.lines), 0, `<p>${MARKER}</p>`);
        expect(after.lines).toEqual(expectedLines);

        // And undo removes it again without disturbing the footers.
        const undo = await undoBlocks(actionData, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);
        const restored = await readSavedAfterUndo(ref, 'Charlie paragraph about snapshot tokens.');
        expect(restored).not.toContain(MARKER);
        expect(restored).toContain(collapseInterTagWhitespace(CREATED_FOOTER));
    }, 45000);
});

// ---------------------------------------------------------------------------
// 8. Citation degrade
// ---------------------------------------------------------------------------

describe('edit_note_blocks citation degrade', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('degrades a citation to a nonexistent item into plain text with a warning, and still applies the edit', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const view = await readBlocks(ref);
        const block = blockOf(view.lines, 'Bravo paragraph about numbered edits.');

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                op: 'replace',
                block,
                expect: view.lines[block - 1],
                content: `<p>Bravo now cites <citation id="${LIBRARY_ID}-ZZZZZZZZ"/> as evidence.</p>`,
            }],
        };

        const validation = await validateBlocks(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        expect(validation.warnings?.some((w) => /not found .* inserted as plain text/.test(w))).toBe(true);

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.warnings?.some((w) => /not found .* inserted as plain text/.test(w))).toBe(true);
        expect(exec.result_data?.skipped).toEqual([]);

        // The citation became plain text; no citation markup was written.
        const saved = await readSaved(ref);
        expect(saved).toContain('Bravo now cites (see: ');
        expect(saved).toContain('ZZZZZZZZ)');
        expect(saved).not.toContain('data-citation');

        const after = await readBlocks(ref);
        expect(after.lines[block - 1]).not.toContain('<citation');
        expect(after.lines[block - 1]).toContain('as evidence.');
    }, 45000);
});

// ---------------------------------------------------------------------------
// 9. block:'all' rewrite + undo
// ---------------------------------------------------------------------------

describe('edit_note_blocks whole-body rewrite', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('rewrites the whole body without a snapshot and undo restores the original, wrapper included', async () => {
        const ref = await seedNote(THREE_PARA_HTML);
        const beforeHtml = await readSaved(ref);
        expect(beforeHtml).toContain('data-schema-version');
        const view = await readBlocks(ref);

        // A sole `block: 'all'` edit needs NO snapshot: it addresses no numbers.
        // Sent deliberately without one to pin that rule.
        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            edits: [{
                index: 0,
                client_item_id: 'w-0',
                op: 'replace',
                block: 'all',
                content: '<p>Wholesale block rewrite body.</p><p>Second rewritten paragraph.</p>',
            }],
        };

        const validation = await validateBlocks(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        // A rewrite surfaces the pre-edit content for diffing…
        expect(validation.current_value?.old_content).toBe(view.content);
        // …and this note is far too short to escalate (see MIN_CHARS_TO_ESCALATE).
        expect(validation.normalized_action_data?.destructive_rewrite).toBeUndefined();

        const exec = await executeBlocks(actionData);
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.undo).toHaveLength(1);
        // The one record undo must restore wholesale carries the POSITIVE marker.
        expect(exec.result_data?.undo[0].undo_scope).toBe('whole_body');
        expect(exec.result_data?.undo[0].undo_old_html).toContain('Alpha paragraph about block addressing.');
        expect(exec.result_data?.undo[0].undo_new_html).toBeUndefined();

        const mid = await readBlocks(ref);
        expect(mid.content).toContain('Wholesale block rewrite body.');
        expect(mid.content).not.toContain('Bravo paragraph about numbered edits.');
        // The advisory range for a rewrite is the whole post-edit note.
        expect(exec.result_data?.applied).toEqual([
            expect.objectContaining({ index: 0, client_item_id: 'w-0', blocks: `1-${mid.total_lines}` }),
        ]);
        expect((await readSaved(ref))).toContain('data-schema-version');

        const undo = await undoBlocks(actionData, exec);
        expect(undo.ok, undo.error ?? '').toBe(true);

        const restored = await readSavedAfterUndo(ref, 'Alpha paragraph about block addressing.');
        expect(stripEditFooter(restored)).toBe(comparableBody(beforeHtml));
        expect(restored).toContain('data-schema-version');
        const restoredView = await readBlocks(ref);
        expect(restoredView.lines).toEqual(view.lines);
    }, 60000);
});

// ---------------------------------------------------------------------------
// 10. Destructive escalation
// ---------------------------------------------------------------------------

describe('edit_note_blocks destructive escalation', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('flags a delete of the entire body as a destructive rewrite and refuses to execute it unapproved', async () => {
        // `assessNoteRewrite` only escalates notes with >= 600 comparable
        // characters, so this fixture is deliberately long.
        const html = Array.from({ length: 6 }, (_v, i) => `<p>Paragraph ${i + 1}. ${fillerText(140)}</p>`).join('');
        const ref = await seedNote(html);
        const beforeHtml = await readSaved(ref);

        const view = await readBlocks(ref);
        const last = lastContentBlock(view.lines);
        expect(last).toBeGreaterThan(1);

        const actionData: BlocksActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            snapshot: view.snapshot,
            edits: [{
                index: 0,
                op: 'delete',
                from_block: 1,
                to_block: last,
                expect: view.lines[0],
                expect_end: view.lines[last - 1],
            }],
        };

        const validation = await validateBlocks(actionData);
        expect(validation.valid, validation.error ?? undefined).toBe(true);
        expect(validation.current_value?.applicable_count).toBe(1);
        // THE ESCALATION SIGNAL: the classification travels ON the action, so an
        // ordinary note-edit run grant cannot authorize this shape.
        expect(validation.normalized_action_data?.destructive_rewrite).toBe(true);
        // Only the RESOLVED preference value is observable over the wire (the
        // group it was read from is not) — see the harness note in the header.
        expect(['always_ask', 'always_apply', 'continue_without_applying'])
            .toContain(validation.preference);

        // Executing WITHOUT the approval flag is refused by the TOCTOU
        // destructiveness re-check, and the note is left intact.
        const exec = await executeBlocks(actionData);
        expect(exec.success).toBe(false);
        expect(exec.error_code).toBe('note_changed');
        expect(await readSaved(ref)).toBe(beforeHtml);
    }, 45000);
});
