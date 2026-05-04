/**
 * Live tests for the edit_note agent action.
 *
 * These tests run against a live Zotero instance with the Beaver plugin
 * loaded (dev build — test-only endpoints are only registered when
 * `NODE_ENV === 'development'`).
 *
 * Coverage:
 *   1. Concurrent edits to the same note — serialization behavior + state
 *      consistency when two execute requests race.
 *   2. Live editor state — edits while the note is open in Zotero's editor,
 *      exercising `flushLiveEditorToDB`, `waitForNoteSaveStabilization`, and
 *      PM re-normalization.
 *   3. Undo after PM re-normalization — context-anchor round-trip after the
 *      editor rewrites HTML.
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver loaded and authenticated.
 *   - library_id 1 (the user library) must be marked "searchable" in Beaver
 *     preferences so the edit_note validator accepts it.
 *   - Run: `npm run test:live -- tests/live/editNote.live.test.ts`
 *
 * Known gap: we cannot programmatically type into ProseMirror's contenteditable
 * iframe from a Node-side test, so "user is typing while the agent edits"
 * cannot be simulated exactly. Tests exercise the adjacent code paths: an edit
 * issued against a note that is *open* in the editor, which triggers the same
 * `flushLiveEditorToDB` / `waitForNoteSaveStabilization` / `waitForPMNormalization`
 * flow.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    createNote,
    deleteNote,
    readNote,
    openNoteEditor,
    closeNoteEditor,
    undoEditNote,
    validateEditNote,
    executeEditNote,
    buildUndoAction,
    type EditNoteActionData,
} from './helpers/noteTestClient';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — edit_note live tests will be skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    // Close any editors that may have been opened by a test
    for (const { library_id, zotero_key } of createdNotes) {
        try { await closeNoteEditor(library_id, zotero_key); } catch { /* ignore */ }
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
});

async function seedNote(html: string, title?: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html, title });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

function normalizeWhitespace(html: string): string {
    return html.replace(/\s+/g, ' ').trim();
}

// ==========================================================================
// Scenario (a): concurrent edits to the same note
// ==========================================================================

describe('edit_note concurrent edits', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('two str_replace edits fired in parallel both apply and final HTML contains both replacements', async () => {
        const ref = await seedNote('<p>Alpha Bravo Charlie Delta</p>');

        const editA: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Alpha',
            new_string: 'ALPHA',
        };
        const editB: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Delta',
            new_string: 'DELTA',
        };

        const [resA, resB] = await Promise.all([
            executeEditNote(editA, { timeout: 20000 }),
            executeEditNote(editB, { timeout: 20000 }),
        ]);

        // Both should succeed — if they don't, the serialization / stabilization
        // logic is letting a second edit clobber the first.
        expect(resA.error_code, `editA: ${resA.error}`).toBeFalsy();
        expect(resB.error_code, `editB: ${resB.error}`).toBeFalsy();
        expect(resA.success).toBe(true);
        expect(resB.success).toBe(true);

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('ALPHA');
        expect(after.saved_html).toContain('DELTA');
        expect(after.saved_html).not.toContain('Alpha Bravo Charlie Delta');
    });

    it('parallel rewrite + str_replace: final state is one of the two, not corrupted', async () => {
        const ref = await seedNote('<p>Original sentence one.</p><p>Original sentence two.</p>');

        const rewrite: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'rewrite',
            new_string: '<p>Rewritten content.</p>',
        };
        const replace: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Original sentence one.',
            new_string: 'REPLACED sentence one.',
        };

        const results = await Promise.all([
            executeEditNote(rewrite, { timeout: 20000 }),
            executeEditNote(replace, { timeout: 20000 }),
        ]);

        // One edit may race-lose (e.g., str_replace can hit `old_string_not_found`
        // if rewrite landed first). Whichever resolution we get, the final note
        // must never be half-applied / corrupted.
        const succeeded = results.filter((r) => r.success).length;
        expect(succeeded).toBeGreaterThanOrEqual(1);

        const after = await readNote(ref.library_id, ref.zotero_key);
        const saved = after.saved_html;

        // Must not contain diff-preview markers
        expect(saved).not.toMatch(/data-beaver-diff-preview/);
        expect(saved).not.toMatch(/rgba\(\s*34,\s*197,\s*94/); // green preview bg
        expect(saved).not.toMatch(/rgba\(\s*239,\s*68,\s*68/);  // red preview bg

        // Must be in one of the two consistent end states (never a mix)
        const looksLikeRewrite = saved.includes('Rewritten content.') && !saved.includes('Original sentence two.');
        const looksLikeReplace = saved.includes('REPLACED sentence one.') && saved.includes('Original sentence two.');
        expect(looksLikeRewrite || looksLikeReplace).toBe(true);
    });

    it('parallel str_replace_all on overlapping targets: both apply without losing occurrences', async () => {
        const ref = await seedNote(
            '<p>foo bar foo bar foo</p><p>bar foo bar</p>',
        );

        const editA: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace_all',
            old_string: 'foo',
            new_string: 'FOO',
        };
        const editB: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace_all',
            old_string: 'bar',
            new_string: 'BAR',
        };

        const [resA, resB] = await Promise.all([
            executeEditNote(editA, { timeout: 20000 }),
            executeEditNote(editB, { timeout: 20000 }),
        ]);

        expect(resA.success, `editA: ${resA.error}`).toBe(true);
        expect(resB.success, `editB: ${resB.error}`).toBe(true);

        const after = await readNote(ref.library_id, ref.zotero_key);
        // No lowercase "foo" or "bar" should remain if both edits applied.
        // (Allow surrounding HTML tags to differ — just check the tokens.)
        const lowerFoo = (after.saved_html.match(/\bfoo\b/g) ?? []).length;
        const lowerBar = (after.saved_html.match(/\bbar\b/g) ?? []).length;
        expect(lowerFoo).toBe(0);
        expect(lowerBar).toBe(0);
        expect((after.saved_html.match(/\bFOO\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
        expect((after.saved_html.match(/\bBAR\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it('five serial edits in rapid succession: none are lost', async () => {
        // Not strictly "concurrent" but exercises the PM stabilization path
        // across multiple back-to-back saves. A bug in stabilization causes
        // PM's save-back to overwrite a later edit.
        const ref = await seedNote('<p>one two three four five</p>');

        const words = ['one', 'two', 'three', 'four', 'five'] as const;
        for (const w of words) {
            const res = await executeEditNote({
                library_id: ref.library_id,
                zotero_key: ref.zotero_key,
                operation: 'str_replace',
                old_string: w,
                new_string: w.toUpperCase(),
            }, { timeout: 20000 });
            expect(res.success, `edit "${w}": ${res.error}`).toBe(true);
        }

        const after = await readNote(ref.library_id, ref.zotero_key);
        for (const w of words) {
            expect(after.saved_html).toContain(w.toUpperCase());
            // The lowercase form must not remain as a standalone word
            expect(new RegExp(`\\b${w}\\b`).test(after.saved_html)).toBe(false);
        }
    });
});

// ==========================================================================
// Scenario (b): edits while the note is open in the editor
// ==========================================================================

describe('edit_note with live editor open', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('str_replace while note is open in a separate editor window: saved + live HTML converge', async () => {
        const ref = await seedNote('<p>hello world</p>');

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) {
            // Zotero may refuse to open editor windows in some headless setups —
            // skip the scenario rather than asserting a known-flaky path.
            return;
        }

        const res = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'hello',
            new_string: 'HELLO',
        }, { timeout: 20000 });
        expect(res.success, res.error ?? '').toBe(true);

        // Allow PM's async save-back to complete
        await new Promise((r) => setTimeout(r, 800));

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.in_editor).toBe(true);
        expect(after.saved_html).toContain('HELLO');
        expect(after.saved_html).not.toContain('hello world');

        // Live HTML (read from editor) must match saved HTML after stabilization —
        // if they differ, PM's save-back is out of sync.
        if (after.live_html !== null) {
            expect(normalizeWhitespace(after.live_html)).toBe(normalizeWhitespace(after.saved_html));
        }
    });

    it('rewrite while note is open: full-note replacement persists and editor shows new content', async () => {
        const ref = await seedNote('<p>original body</p>');

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        const res = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'rewrite',
            new_string: '<p>completely new body</p>',
        }, { timeout: 20000 });
        expect(res.success, res.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('completely new body');
        expect(after.saved_html).not.toContain('original body');
        if (after.live_html !== null) {
            expect(after.live_html).toContain('completely new body');
            expect(after.live_html).not.toContain('original body');
        }
    });

    it('two str_replace edits while note is open: both apply without PM save-back clobbering', async () => {
        const ref = await seedNote('<p>keep RED and BLUE</p>');

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        // Sequential (not parallel) to specifically test the PM stabilization
        // window between consecutive saves with the editor open.
        const r1 = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'RED',
            new_string: 'CRIMSON',
        }, { timeout: 20000 });
        expect(r1.success, r1.error ?? '').toBe(true);

        const r2 = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'BLUE',
            new_string: 'AZURE',
        }, { timeout: 20000 });
        expect(r2.success, r2.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('CRIMSON');
        expect(after.saved_html).toContain('AZURE');
        expect(after.saved_html).not.toContain('RED');
        expect(after.saved_html).not.toContain('BLUE');
    });

    it('validate while editor open returns matching current_value (flushLiveEditorToDB / getLatestNoteHtml path)', async () => {
        const ref = await seedNote('<p>validate me with the editor open</p>');

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'validate me',
            new_string: 'VALIDATED',
        });
        expect(res.valid, res.error ?? '').toBe(true);
        expect(res.current_value?.match_count).toBe(1);
    });
});

// ==========================================================================
// Scenario (c): undo after PM re-normalization
// ==========================================================================

describe('edit_note undo after PM normalization', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('str_replace undo round-trip with editor open: reverses the edit', async () => {
        const original = '<p>reversible edit target</p>';
        const ref = await seedNote(original);

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'reversible edit target',
            new_string: 'EDITED TARGET',
        };
        const applied = await executeEditNote(actionData, { timeout: 20000 });
        expect(applied.success, applied.error ?? '').toBe(true);
        expect(applied.result_data?.undo_new_html).toBeDefined();

        // Let PM re-normalize before we try to undo
        await new Promise((r) => setTimeout(r, 800));

        const afterEdit = await readNote(ref.library_id, ref.zotero_key);
        expect(afterEdit.saved_html).toContain('EDITED TARGET');

        const undoRes = await undoEditNote(buildUndoAction(actionData, applied));
        expect(undoRes.ok, undoRes.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));

        const afterUndo = await readNote(ref.library_id, ref.zotero_key);
        expect(afterUndo.saved_html).toContain('reversible edit target');
        expect(afterUndo.saved_html).not.toContain('EDITED TARGET');
    });

    it('str_replace_all undo with editor open: all occurrences restored', async () => {
        const ref = await seedNote(
            '<p>widget one widget two widget three</p>',
        );

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace_all',
            old_string: 'widget',
            new_string: 'gadget',
        };
        const applied = await executeEditNote(actionData, { timeout: 20000 });
        expect(applied.success, applied.error ?? '').toBe(true);
        expect(applied.result_data?.occurrences_replaced).toBe(3);

        await new Promise((r) => setTimeout(r, 800));
        let mid = await readNote(ref.library_id, ref.zotero_key);
        expect((mid.saved_html.match(/gadget/g) ?? []).length).toBe(3);
        expect(mid.saved_html.includes('widget')).toBe(false);

        const undoRes = await undoEditNote(buildUndoAction(actionData, applied));
        expect(undoRes.ok, undoRes.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));
        const afterUndo = await readNote(ref.library_id, ref.zotero_key);
        expect((afterUndo.saved_html.match(/widget/g) ?? []).length).toBe(3);
        expect(afterUndo.saved_html.includes('gadget')).toBe(false);
    });

    it('rewrite undo restores original body even after PM normalization', async () => {
        const ref = await seedNote('<p>Before.</p><p>Middle.</p><p>After.</p>');

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        const before = await readNote(ref.library_id, ref.zotero_key);

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'rewrite',
            new_string: '<p>wholesale replacement</p>',
        };
        const applied = await executeEditNote(actionData, { timeout: 20000 });
        expect(applied.success, applied.error ?? '').toBe(true);
        expect(applied.result_data?.undo_full_html).toBeDefined();

        await new Promise((r) => setTimeout(r, 800));
        const mid = await readNote(ref.library_id, ref.zotero_key);
        expect(mid.saved_html).toContain('wholesale replacement');
        expect(mid.saved_html).not.toContain('Middle.');

        const undoRes = await undoEditNote(buildUndoAction(actionData, applied));
        expect(undoRes.ok, undoRes.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));
        const afterUndo = await readNote(ref.library_id, ref.zotero_key);
        expect(afterUndo.saved_html).toContain('Before.');
        expect(afterUndo.saved_html).toContain('Middle.');
        expect(afterUndo.saved_html).toContain('After.');
        expect(afterUndo.saved_html).not.toContain('wholesale replacement');
        // Reasonable proxy for "restored to original": contains the same
        // paragraph markers (modulo PM whitespace / entity normalization).
        expect(normalizeWhitespace(afterUndo.saved_html).length).toBeGreaterThan(
            normalizeWhitespace(before.saved_html).length / 2,
        );
    });

    it('undo of edit that PM normalized (inline style → semantic tag) still succeeds', async () => {
        // PM rewrites inline `style="font-weight:bold"` into `<strong>`.
        // The applied result_data must capture the PM-normalized fragment so
        // undo can find it.
        const ref = await seedNote(
            '<p>plain text before</p><p><span style="font-weight: bold;">bolded text</span></p>',
        );

        const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
        if (!opened.in_editor) return;

        // Let PM normalize the seeded HTML first
        await new Promise((r) => setTimeout(r, 800));

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'plain text before',
            new_string: 'MODIFIED',
        };
        const applied = await executeEditNote(actionData, { timeout: 20000 });
        expect(applied.success, applied.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));

        const undoRes = await undoEditNote(buildUndoAction(actionData, applied));
        expect(undoRes.ok, undoRes.error ?? '').toBe(true);

        await new Promise((r) => setTimeout(r, 800));
        const afterUndo = await readNote(ref.library_id, ref.zotero_key);
        expect(afterUndo.saved_html).toContain('plain text before');
        expect(afterUndo.saved_html).not.toContain('MODIFIED');
    });

    it('already-undone guard: calling undo twice is a safe no-op on the second call', async () => {
        const ref = await seedNote('<p>idempotent undo check</p>');

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'idempotent',
            new_string: 'IDEMPOTENT',
        };
        const applied = await executeEditNote(actionData, { timeout: 20000 });
        expect(applied.success).toBe(true);

        const first = await undoEditNote(buildUndoAction(actionData, applied));
        expect(first.ok).toBe(true);

        const second = await undoEditNote(buildUndoAction(actionData, applied));
        // Should either report ok:true (no-op) or a recognizable "already undone"
        // path; it must not throw an uncaught exception.
        expect(second).toBeDefined();

        const afterUndo = await readNote(ref.library_id, ref.zotero_key);
        expect(afterUndo.saved_html).toContain('idempotent undo check');
        expect(afterUndo.saved_html).not.toContain('IDEMPOTENT undo check');
    });
});
