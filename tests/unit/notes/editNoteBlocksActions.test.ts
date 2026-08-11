import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks (must precede imports)
//
// Mirrors editNoteBlocks.test.ts deliberately: the engine, the wrapper-bounds
// walk, the footer detectors, the snapshot digest and the whole batch undo
// replay chain are all REAL. Only the Zotero/React edges and the simplifier are
// stubbed, so an assertion about what the note becomes is an assertion about
// production behavior.
// =============================================================================

function stripWrapper(html: string): string {
    const trimmed = html.trim();
    if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) return html;
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle === -1) return html;
    return trimmed.substring(closeAngle + 1, trimmed.length - 6);
}

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    // `simplified` is always the note BODY, so simplified line N and raw body
    // line N are the same line — the precondition block addressing rests on.
    getOrSimplify: vi.fn((_noteId: string, rawHtml: string) => ({
        simplified: stripWrapper(rawHtml),
        metadata: { elements: new Map() },
        isStale: false,
    })),
    countOccurrences: vi.fn(() => 0),
    invalidateSimplificationCache: vi.fn(),
    normalizeNoteHtml: vi.fn((html: string) => html),
    simplifyNoteHtml: vi.fn((rawHtml: string) => ({
        simplified: stripWrapper(rawHtml),
        metadata: { elements: new Map() },
    })),
}));

vi.mock('../../../src/utils/editNoteValidation', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/editNoteValidation')>(
        '../../../src/utils/editNoteValidation'
    );
    return {
        validateNewString: vi.fn(() => null),
        checkNewCitationItemsExist: vi.fn(() => null),
        checkDuplicateCitations: vi.fn(() => null),
        enrichOldStringCitationRefs: vi.fn(() => null),
        applyOldStringEnrichment: vi.fn((oldString: string | undefined) => oldString),
        detectPartialSimplifiedTag: actual.detectPartialSimplifiedTag,
        buildPartialSimplifiedTagMessage: actual.buildPartialSimplifiedTagMessage,
        buildCitationRefHint: actual.buildCitationRefHint,
        buildExpansionErrorMessage: actual.buildExpansionErrorMessage,
    };
});

vi.mock('../../../src/utils/noteCitationExpand', () => ({
    expandToRawHtml: vi.fn((str: string) => str),
    extractAttr: vi.fn((attrStr: string, name: string) => {
        const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrStr);
        return m ? m[1] : undefined;
    }),
    isCitationRefNotFoundError: vi.fn(() => false),
    normalizePageLocator: vi.fn((s: string) => s),
    translatePageNumberToLabel: vi.fn((s: string) => s),
    preloadPageLabelsForNewCitations: vi.fn(async () => ({})),
    preloadNotePageLabels: vi.fn(async () => ({})),
    preloadStructuralLocatorPages: vi.fn(async () => ({ pages: {}, unresolved: [] })),
    buildUnresolvedLocatorWarning: vi.fn(() => null),
}));

vi.mock('../../../src/utils/noteEditorIO', () => ({
    getNoteHtmlForRead: vi.fn(async (item: any) => item.getNote()),
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    getLiveNoteHtmlCandidates: vi.fn(() => []),
    isNoteInEditor: vi.fn(() => false),
    waitForPMNormalization: vi.fn(async () => {}),
    waitForNoteSaveStabilization: vi.fn(async () => {}),
    flushLiveEditorToDB: vi.fn(async () => false),
}));

vi.mock('../../../react/utils/noteEditorDiffPreview', () => ({
    dismissDiffPreview: vi.fn(async () => {}),
    isDiffPreviewActive: vi.fn(() => false),
    isDiffPreviewPending: vi.fn(() => false),
    isDiffPreviewPendingFor: vi.fn(() => false),
    isDiffPreviewSupported: vi.fn(() => false),
    isNoteInSelectedTab: vi.fn(() => false),
    isNoteOpenInEditor: vi.fn(() => false),
    getPreviewNoteKey: vi.fn(() => null),
    showDiffPreview: vi.fn(async () => false),
    setOnBannerAction: vi.fn(),
    setOnDismiss: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
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
    store: { get: vi.fn() },
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

vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
    getAttachmentFileStatus: vi.fn(),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} is excluded from Beaver.`),
    excludedLibraryUserMessage: vi.fn((id: number) => `Library ${id} is excluded from Beaver.`),
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

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

import {
    executeEditNoteBlocksAction,
    undoEditNoteBlocksAction,
} from '../../../react/utils/editNoteBlocksActions';
import {
    executeEditNoteVariantAction,
    undoEditNoteVariantAction,
} from '../../../react/utils/editNoteActions';
import { deriveEditNoteRows, getEditNoteCallVariant } from '../../../react/components/agentRuns/editNoteShared';
import { buildAddressSnapshot, snapshotNoteId } from '../../../src/utils/noteSnapshot';
import { logger } from '@beaver/agent-core/platform/logger';
import { preloadNotePageLabels } from '../../../src/utils/noteCitationExpand';
import { invalidateSimplificationCache } from '../../../src/utils/noteHtmlSimplifier';
import { stripBeaverEditFooter } from '../../../src/utils/noteEditFooter';
import { checkLibraryExcluded } from '../../../src/services/agentDataProvider/utils';
import { store } from '../../../react/store';
import { currentThreadIdAtom } from '../../../react/atoms/threads';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import type {
    EditNoteBlocksEditItem,
    EditNoteBlocksResultData,
} from '@beaver/agent-core/types/agentActions/editNoteBlocks';

/** Every fixture in this file is note 1-NOTE0001. */
const NOTE_ID = snapshotNoteId(1, 'NOTE0001');

// =============================================================================
// Fixtures
// =============================================================================

const LINE_1 = '<p>Alpha sentence one.</p>';
const LINE_2 = '<p>Bravo passage two.</p>';
const LINE_3 = '<p>Charlie section three.</p>';
const BODY = [LINE_1, LINE_2, LINE_3].join('\n');
const NOTE_HTML = `<div data-schema-version="9">${BODY}</div>`;
const SNAPSHOT = buildAddressSnapshot(NOTE_ID, BODY);

const THREAD_ID = 'thread-0001';

let noteHtml = NOTE_HTML;
let mockItem: any;
let getItemSpy: ReturnType<typeof vi.fn>;

function makeMockItem() {
    return {
        isNote: vi.fn(() => true),
        isRegularItem: vi.fn(() => false),
        isAttachment: vi.fn(() => false),
        isAnnotation: vi.fn(() => false),
        itemType: 'note',
        libraryID: 1,
        key: 'NOTE0001',
        id: 42,
        loadDataType: vi.fn(async () => {}),
        getNote: vi.fn(() => noteHtml),
        setNote: vi.fn((html: string) => { noteHtml = html; }),
        getNoteTitle: vi.fn(() => 'My Note'),
        saveTx: vi.fn(async () => {}),
    };
}

/** A persisted `edit_note_blocks` agent action, as the sidebar would hold it. */
function blocksAction(
    edits: EditNoteBlocksEditItem[],
    overrides: Record<string, any> = {},
): any {
    return {
        id: 'blocks-action-1',
        action_type: 'edit_note_blocks',
        status: 'pending',
        proposed_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            snapshot: SNAPSHOT,
            edits,
            ...overrides,
        },
    };
}

/** The same action after a successful apply, ready to be undone. */
function appliedBlocksAction(result: EditNoteBlocksResultData, edits: EditNoteBlocksEditItem[]): any {
    return { ...blocksAction(edits), status: 'applied', result_data: result };
}

/** True if undo emitted its `address_post_snapshot` drift diagnostic. */
function driftLogged(): boolean {
    return vi.mocked(logger).mock.calls.some(
        ([message]) => typeof message === 'string' && message.includes('no longer matches the address_post_snapshot'),
    );
}

const replaceBlock2: EditNoteBlocksEditItem = {
    index: 0,
    op: 'replace',
    block: 2,
    expect: LINE_2,
    content: '<p>Bravo REWRITTEN two.</p>',
};

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();
    noteHtml = NOTE_HTML;
    mockItem = makeMockItem();

    getItemSpy = vi.fn(async (_libraryId: number, key: string) => (key === 'NOTE0001' ? mockItem : null));
    (globalThis as any).Zotero = {
        Libraries: { get: vi.fn((id: number) => ({ name: `Library ${id}`, editable: true })) },
        Items: { getByLibraryAndKeyAsync: getItemSpy },
    };

    vi.mocked(store.get).mockImplementation((atom: any) => {
        if (atom === searchableLibraryIdsAtom) return [1, 2] as any;
        if (atom === currentThreadIdAtom) return THREAD_ID as any;
        return null as any;
    });
    vi.mocked(checkLibraryExcluded).mockReturnValue(null);
});

// =============================================================================
// Local re-apply
// =============================================================================

describe('executeEditNoteBlocksAction (local re-apply)', () => {
    it('applies a block replace and returns the block-addressed result envelope', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));

        expect(noteHtml).toContain('<p>Bravo REWRITTEN two.</p>');
        expect(noteHtml).not.toContain(LINE_2);
        expect(noteHtml).toContain(LINE_1);
        expect(noteHtml).toContain(LINE_3);

        expect(result.library_id).toBe(1);
        expect(result.zotero_key).toBe('NOTE0001');
        expect(result.applied).toEqual([{ index: 0, blocks: '2' }]);
        expect(result.skipped).toEqual([]);
        expect(result.undo).toHaveLength(1);
        expect(result.undo[0]).toMatchObject({ index: 0, op: 'replace' });
        // Both address tokens travel, so a consumer can tell which numbering the
        // apply ran against and which one the note now has.
        expect(result.address_pre_snapshot).toBe(SNAPSHOT);
        expect(typeof result.address_post_snapshot).toBe('string');
        expect(result.address_post_snapshot).not.toBe(SNAPSHOT);
    });

    it('writes exactly once and stamps the edit footer', async () => {
        await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));

        expect(mockItem.setNote).toHaveBeenCalledTimes(1);
        expect(mockItem.saveTx).toHaveBeenCalledTimes(1);
        expect(noteHtml).toContain('Edited by Beaver');
    });

    it('RE-RESOLVES against the live note and ignores the persisted display strings', async () => {
        // Validation's display metadata is deliberately misleading here: a stale
        // `old_string`/`new_string` pair naming text that is not in the note, and
        // bogus context anchors. Only the addressing fields (`block`/`expect`/
        // `content`) are execution input.
        //
        // `skip_reason_code` is the ONE exception and is covered separately: it is
        // not a display string but the record of what the user was shown as
        // excluded from this approval, so execute honors it.
        const staleEdit: EditNoteBlocksEditItem = {
            index: 0,
            op: 'replace',
            block: 2,
            expect: LINE_2,
            content: '<p>Bravo REWRITTEN two.</p>',
            operation: 'str_replace',
            old_string: '<p>Text that is nowhere in this note.</p>',
            new_string: '<p>A replacement nobody asked for.</p>',
            target_before_context: '<p>bogus before</p>',
            target_after_context: '<p>bogus after</p>',
        };

        const result = await executeEditNoteBlocksAction(blocksAction([staleEdit]));

        // The addressed region changed…
        expect(noteHtml).toContain('<p>Bravo REWRITTEN two.</p>');
        expect(noteHtml).not.toContain(LINE_2);
        // …and none of the persisted display strings influenced the write.
        expect(noteHtml).not.toContain('A replacement nobody asked for.');
        expect(noteHtml).not.toContain('bogus before');
        expect(result.applied).toHaveLength(1);
        expect(result.skipped).toEqual([]);
    });

    it('applies what it can and reports the rest as skipped (partial application)', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([
            replaceBlock2,
            { index: 1, op: 'replace', block: 3, expect: '<p>Not what is there.</p>', content: '<p>X</p>' },
        ]));

        expect(result.applied).toHaveLength(1);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]).toMatchObject({ index: 1, reason_code: 'expect_mismatch' });
        expect(noteHtml).toContain(LINE_3);
    });

    it('rewrites the whole body for a block:"all" edit', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction(
            [{ index: 0, op: 'rewrite', content: '<p>An entirely new body.</p>' }],
            { snapshot: undefined },
        ));

        expect(noteHtml).toContain('<p>An entirely new body.</p>');
        expect(noteHtml).not.toContain(LINE_1);
        // No bounded region to diff against: undo stores the full pre-edit body
        // and no `undo_new_html`.
        expect(result.undo).toHaveLength(1);
        // The stored body is the STRIPPED note, wrapper included.
        expect(result.undo[0].undo_old_html).toBe(NOTE_HTML);
        expect(result.undo[0].undo_new_html).toBeUndefined();
    });

    it('refuses a stale snapshot instead of editing the wrong line', async () => {
        const staleSnapshot = buildAddressSnapshot(NOTE_ID, '<p>A completely different note.</p>');
        await expect(
            executeEditNoteBlocksAction(blocksAction([replaceBlock2], { snapshot: staleSnapshot })),
        ).rejects.toThrow(/does not match the current block numbering/);
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });

    // The user reviews the card and applies it later — the longest window in which
    // citation identity or library exclusion can change. An edit the card showed
    // as "Skipped" (with no diff) must not slip into the note on that click.
    it('honors validation skips when the user applies the action later', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([
            {
                index: 0, op: 'replace', block: 2, expect: LINE_2, content: '<p>Bravo REWRITTEN.</p>',
                skip_reason_code: 'expansion_failed', skip_reason: 'Cited item does not exist.',
            },
            { index: 1, op: 'replace', block: 3, expect: LINE_3, content: '<p>Charlie, revised.</p>' },
        ]));

        expect(noteHtml).toContain('<p>Charlie, revised.</p>');
        expect(noteHtml).not.toContain('Bravo REWRITTEN.');
        expect(result.applied.map((a) => a.index)).toEqual([1]);
        expect(result.skipped[0]).toMatchObject({ index: 0, reason_code: 'expansion_failed' });
    });

    it('names the failing edit when a local re-apply skips every edit', async () => {
        // The card has only the thrown message to show, so it must not lose the
        // reason the model-facing payload carries in `skipped`.
        await expect(
            executeEditNoteBlocksAction(blocksAction([
                { index: 0, op: 'replace', block: 2, expect: '<p>Not this text at all.</p>', content: '<p>X</p>' },
            ])),
        ).rejects.toThrow(/edit 0: .*does not match block 2/);
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });

    it('enforces the library exclusion BEFORE any item lookup', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValue({ message: 'Library 1 is excluded from Beaver.' } as any);

        await expect(executeEditNoteBlocksAction(blocksAction([replaceBlock2]))).rejects.toThrow(/excluded/);
        expect(getItemSpy).not.toHaveBeenCalled();
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });
});

// =============================================================================
// Undo
// =============================================================================

describe('undoEditNoteBlocksAction', () => {
    it('round-trips: the undone body is byte-identical apart from the edit footer', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        expect(noteHtml).not.toBe(NOTE_HTML);

        await undoEditNoteBlocksAction(appliedBlocksAction(result, [replaceBlock2]));

        expect(stripBeaverEditFooter(noteHtml)).toBe(NOTE_HTML);
    });

    it('round-trips a multi-edit action, replaying records in reverse order', async () => {
        const edits: EditNoteBlocksEditItem[] = [
            { index: 0, op: 'prepend', content: '<p>Inserted line.</p>' },
            { index: 1, op: 'replace', block: 2, expect: LINE_2, content: '<p>Bravo edited.</p>' },
            { index: 2, op: 'delete', block: 3, expect: LINE_3 },
        ];
        const result = await executeEditNoteBlocksAction(blocksAction(edits));
        expect(result.applied).toHaveLength(3);
        expect(noteHtml).toContain('<p>Inserted line.</p>');
        expect(noteHtml).not.toContain(LINE_3);

        await undoEditNoteBlocksAction(appliedBlocksAction(result, edits));

        expect(stripBeaverEditFooter(noteHtml)).toBe(NOTE_HTML);
    });

    it('restores the FULL body for a block:"all" record (op/operation mapping gap)', async () => {
        const rewrite: EditNoteBlocksEditItem[] = [
            { index: 0, op: 'rewrite', content: '<p>An entirely new body.</p>' },
        ];
        const result = await executeEditNoteBlocksAction(blocksAction(rewrite, { snapshot: undefined }));
        expect(noteHtml).not.toContain(LINE_1);

        await undoEditNoteBlocksAction(
            { ...blocksAction(rewrite, { snapshot: undefined }), status: 'applied', result_data: result },
        );

        // The whole pre-edit body is back. Left to the batch replayer's default
        // (`operation ?? 'str_replace'`) this record would have taken the
        // deletion-seam path and thrown on its missing context anchors.
        expect(stripBeaverEditFooter(noteHtml)).toBe(NOTE_HTML);
    });

    // The whole-body path is selected by a POSITIVE marker, never inferred from
    // an absent optional field. result_data round-trips through the backend
    // verbatim (`toAgentAction` has no edit_note* normalization), so a dropped
    // `undo_new_html` must not be able to promote an ordinary fragment record
    // into a whole-note restore — that would replace the note with the fragment,
    // silently and with no redo.
    it('marks the block:"all" record with undo_scope and only restores wholesale on that marker', async () => {
        const rewrite: EditNoteBlocksEditItem[] = [
            { index: 0, op: 'rewrite', content: '<p>An entirely new body.</p>' },
        ];
        const result = await executeEditNoteBlocksAction(blocksAction(rewrite, { snapshot: undefined }));
        expect(result.undo[0].undo_scope).toBe('whole_body');
        expect(result.undo[0].undo_new_html).toBeUndefined();
    });

    it('does NOT whole-body restore a fragment record whose undo_new_html went missing', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        const applied = appliedBlocksAction(result, [replaceBlock2]);
        const beforeUndo = noteHtml;

        // Simulate the schema-drift case: an ordinary replace record that lost
        // its undo_new_html in transit. It carries no marker, so it must take
        // the fragment path (and fail to relocate) rather than wiping the note.
        const mangled = {
            ...applied,
            result_data: {
                ...result,
                undo: [{ ...result.undo[0], undo_new_html: undefined }],
            },
        };
        // It must NOT take the whole-body path. Whether the fragment path then
        // throws or reads the note as already-undone is immaterial; what
        // matters is that the note is never replaced by the fragment.
        await undoEditNoteBlocksAction(mangled as any).catch(() => undefined);
        expect(noteHtml).not.toBe(result.undo[0].undo_old_html);
        expect(noteHtml).toContain(LINE_1);
        expect(noteHtml).toContain(LINE_3);
        void beforeUndo;
    });

    it('refuses a record marked whole_body that does not have that shape', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        const applied = appliedBlocksAction(result, [replaceBlock2]);
        const beforeUndo = noteHtml;

        const mismarked = {
            ...applied,
            result_data: {
                ...result,
                undo: [{ ...result.undo[0], undo_scope: 'whole_body' }],
            },
        };
        await expect(undoEditNoteBlocksAction(mismarked as any)).rejects.toThrow(/whole-note restore/);
        expect(noteHtml).toBe(beforeUndo);
    });

    it('throws rather than wiping the note when a whole-body record has no pre-edit body', async () => {
        const rewrite: EditNoteBlocksEditItem[] = [
            { index: 0, op: 'rewrite', content: '<p>An entirely new body.</p>' },
        ];
        const result = await executeEditNoteBlocksAction(blocksAction(rewrite, { snapshot: undefined }));
        const afterApply = noteHtml;

        const stripped = {
            ...blocksAction(rewrite, { snapshot: undefined }),
            status: 'applied',
            result_data: {
                ...result,
                undo: [{ ...result.undo[0], undo_old_html: undefined }],
            },
        };
        await expect(undoEditNoteBlocksAction(stripped as any)).rejects.toThrow(/no pre-edit body/);
        // Nothing written — without the guard this restores the note to ''.
        expect(noteHtml).toBe(afterApply);
    });

    // Non-unique applied fragments force the replayer off its unique-search
    // fast path and onto the stored context anchors, which is the case most
    // likely to mis-locate.
    //
    // NOTE, honestly: this does NOT pin the reverse replay ORDER — reversing it
    // still passes. That is not a gap in the test so much as a property of
    // blocks: every block edit resolves to exactly one splice, so there are no
    // `str_replace_all` occurrence arrays (the thing whose stored order batch's
    // `captureUndoContexts` documents as "replay reverses them"), and the
    // restore chain locates fragments by SEARCH rather than by offset. Reverse
    // order is therefore defensive here, kept for consistency with batch rather
    // than load-bearing. If a future op ever emits more than one splice, that
    // changes and this needs a real ordering fixture.
    it('round-trips when two edits write identical text (non-unique fragments)', async () => {
        const edits: EditNoteBlocksEditItem[] = [
            { index: 0, op: 'replace', block: 1, expect: LINE_1, content: '<p>Same.</p>' },
            { index: 1, op: 'replace', block: 3, expect: LINE_3, content: '<p>Same.</p>' },
        ];
        const result = await executeEditNoteBlocksAction(blocksAction(edits));
        expect(result.applied).toHaveLength(2);
        expect(noteHtml.match(/<p>Same\.<\/p>/g)).toHaveLength(2);

        await undoEditNoteBlocksAction(appliedBlocksAction(result, edits));

        expect(stripBeaverEditFooter(noteHtml)).toBe(NOTE_HTML);
    });

    it('is a no-op on a second undo rather than an error', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        const action = appliedBlocksAction(result, [replaceBlock2]);

        await undoEditNoteBlocksAction(action);
        const afterFirst = noteHtml;
        await expect(undoEditNoteBlocksAction(action)).resolves.toBeUndefined();
        expect(noteHtml).toBe(afterFirst);
    });

    it('throws without writing anything when a record can no longer be located', async () => {
        const edits: EditNoteBlocksEditItem[] = [
            { index: 0, op: 'replace', block: 1, expect: LINE_1, content: '<p>Alpha edited.</p>' },
            { index: 1, op: 'replace', block: 3, expect: LINE_3, content: '<p>Charlie edited.</p>' },
        ];
        const result = await executeEditNoteBlocksAction(blocksAction(edits));
        const action = appliedBlocksAction(result, edits);

        // Corrupt the record that is replayed LAST (records run in reverse), so
        // the other one has already been restored in memory when this one fails.
        action.result_data.undo[0].undo_new_html = '<p>Text that was never written.</p>';
        action.result_data.undo[0].undo_before_context = undefined;
        action.result_data.undo[0].undo_after_context = undefined;

        const htmlBeforeUndo = noteHtml;
        mockItem.setNote.mockClear();

        await expect(undoEditNoteBlocksAction(action)).rejects.toThrow(/Cannot undo edit 0/);
        expect(mockItem.setNote).not.toHaveBeenCalled();
        expect(noteHtml).toBe(htmlBeforeUndo);
    });

    it('throws when there is no undo data at all', async () => {
        await expect(
            undoEditNoteBlocksAction({ ...blocksAction([replaceBlock2]), status: 'applied' }),
        ).rejects.toThrow(/No undo data available/);
    });

    // The apply path keys the simplification cache by the PORTABLE note id
    // (`snapshotNoteId`). Undo must use the same key or it invalidates nothing —
    // in a group library the device-local `${libraryID}-KEY` is a different
    // string entirely.
    it('invalidates the simplification cache under the portable note id', async () => {
        const groupItem = makeMockItem();
        groupItem.libraryID = 7;
        (globalThis as any).Zotero.Groups = {
            getGroupIDFromLibraryID: vi.fn((id: number) => (id === 7 ? 4321 : 0)),
        };
        getItemSpy.mockImplementation(
            async (libraryId: number, key: string) => (libraryId === 7 && key === 'NOTE0001' ? groupItem : null),
        );

        const groupNoteId = snapshotNoteId(7, 'NOTE0001');
        expect(groupNoteId).toBe('g4321-NOTE0001');

        const action = blocksAction([replaceBlock2], {
            library_id: 7,
            snapshot: buildAddressSnapshot(groupNoteId, BODY),
        });
        const result = await executeEditNoteBlocksAction(action);
        expect(invalidateSimplificationCache).toHaveBeenCalledWith(groupNoteId);
        vi.mocked(invalidateSimplificationCache).mockClear();

        vi.mocked(logger).mockClear();
        await undoEditNoteBlocksAction({ ...action, status: 'applied', result_data: result });

        expect(invalidateSimplificationCache).toHaveBeenCalledWith(groupNoteId);
        expect(invalidateSimplificationCache).not.toHaveBeenCalledWith('7-NOTE0001');
        // The drift check folds the same id into its recompute, and this is the
        // only fixture where the portable and device-local forms differ: a
        // device-local `7-NOTE0001` there would report drift on every
        // group-library note, on an undo that has touched nothing.
        expect(driftLogged()).toBe(false);
    });

    // `address_post_snapshot` is audit-only. Undo reports drift and proceeds:
    // the user editing the note between apply and undo is exactly what the
    // context-anchored replay exists to absorb, so a mismatch must not become a
    // refusal.
    it('reports drift when the note moved since the apply, and undoes anyway', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));

        // The user appends a paragraph of their own after the agent's edit.
        noteHtml = noteHtml.replace(/<\/div>\s*$/, '<p>User added this.</p></div>');
        vi.mocked(logger).mockClear();

        await undoEditNoteBlocksAction(appliedBlocksAction(result, [replaceBlock2]));

        expect(driftLogged()).toBe(true);
        // The undo still ran, and the user's own text survived it.
        expect(noteHtml).toContain(LINE_2);
        expect(noteHtml).not.toContain('Bravo REWRITTEN two.');
        expect(noteHtml).toContain('<p>User added this.</p>');
    });

    // The complement of the case above, and the reason the recompute mirrors the
    // apply path step for step: a diagnostic that fires on an untouched note is
    // worse than none.
    //
    // Narrow on purpose — it pins the comparison operand and direction (post,
    // not pre), and that the recompute hashes the SIMPLIFIED projection through
    // the same `buildAddressSnapshot` the apply path reaches via
    // `buildInlineNoteState`. It does not pin the note id (library 1 makes the
    // portable and device-local forms the same string — the group case above
    // covers that) nor page-label divergence (mocked away here; that property
    // belongs to `maskVolatileLocators`, and noteSnapshot.test.ts owns it).
    it('reports no drift when the note is exactly where the apply left it', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        vi.mocked(logger).mockClear();

        await undoEditNoteBlocksAction(appliedBlocksAction(result, [replaceBlock2]));

        expect(driftLogged()).toBe(false);
    });

    // The check is a diagnostic; it must not be able to fail an undo that would
    // otherwise succeed. Asserting the swallowed-error line is what makes this a
    // test of the check rather than of an undo that never ran one — and it also
    // proves the queued rejection was consumed here rather than leaking into the
    // next test (`clearAllMocks` does not drain a `…Once` queue).
    it('undoes even when the drift check itself throws', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        vi.mocked(preloadNotePageLabels).mockRejectedValueOnce(new Error('page label lookup failed'));
        vi.mocked(logger).mockClear();

        await undoEditNoteBlocksAction(appliedBlocksAction(result, [replaceBlock2]));

        expect(vi.mocked(logger).mock.calls.some(
            ([message]) => typeof message === 'string'
                && message.includes('could not check address_post_snapshot')
                && message.includes('page label lookup failed'),
        )).toBe(true);
        expect(stripBeaverEditFooter(noteHtml)).toBe(NOTE_HTML);
    });

    it('respects a library exclusion that appeared after the apply', async () => {
        const result = await executeEditNoteBlocksAction(blocksAction([replaceBlock2]));
        const appliedHtml = noteHtml;

        // The user excludes the library between apply and undo.
        vi.mocked(checkLibraryExcluded).mockReturnValue({ message: 'Library 1 is excluded from Beaver.' } as any);
        getItemSpy.mockClear();
        mockItem.setNote.mockClear();

        await expect(
            undoEditNoteBlocksAction(appliedBlocksAction(result, [replaceBlock2])),
        ).rejects.toThrow(/excluded/);
        expect(getItemSpy).not.toHaveBeenCalled();
        expect(mockItem.setNote).not.toHaveBeenCalled();
        expect(noteHtml).toBe(appliedHtml);
    });
});

// =============================================================================
// Routers
// =============================================================================

describe('executeEditNoteVariantAction', () => {
    it('dispatches edit_note_blocks to the blocks executor', async () => {
        const result = await executeEditNoteVariantAction(blocksAction([replaceBlock2]));
        expect(noteHtml).toContain('<p>Bravo REWRITTEN two.</p>');
        expect(result).toHaveProperty('address_pre_snapshot');
    });

    it('dispatches edit_note_batch to the batch executor', async () => {
        // Each variant's shape gate produces a message only that variant emits,
        // so the message identifies the branch that ran.
        await expect(executeEditNoteVariantAction({
            id: 'a', action_type: 'edit_note_batch', status: 'pending',
            proposed_data: { library_id: 1, zotero_key: 'NOTE0001', edits: [] },
        } as any)).rejects.toThrow(/edit_note_batch requires at least one edit/);
    });

    it('dispatches edit_note to the single-edit executor', async () => {
        // edit_note has no shape gate, so it reaches item resolution — which the
        // other two never do with an empty/absent edits[].
        await expect(executeEditNoteVariantAction({
            id: 'a', action_type: 'edit_note', status: 'pending',
            proposed_data: { library_id: 1, zotero_key: 'MISSING1', old_string: 'x', new_string: 'y' },
        } as any)).rejects.toThrow(/Item not found: 1-MISSING1/);
    });

    it('throws on an unregistered action type instead of silently running edit_note', async () => {
        await expect(executeEditNoteVariantAction({
            id: 'a', action_type: 'edit_note_paragraphs', status: 'pending',
            proposed_data: { library_id: 1, zotero_key: 'NOTE0001' },
        } as any)).rejects.toThrow(/Unsupported note-edit action type 'edit_note_paragraphs'/);
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });
});

describe('undoEditNoteVariantAction', () => {
    it('dispatches edit_note_blocks to the blocks undo', async () => {
        // An `op: 'rewrite'` record: the blocks undo restores the full body, while
        // the batch replayer would take the deletion-seam path and throw.
        noteHtml = '<div data-schema-version="9"><p>Replaced body.</p></div>';
        await undoEditNoteVariantAction({
            id: 'a', action_type: 'edit_note_blocks', status: 'applied',
            proposed_data: { library_id: 1, zotero_key: 'NOTE0001', edits: [] },
            result_data: {
                library_id: 1, zotero_key: 'NOTE0001', applied: [], skipped: [],
                undo: [{ index: 0, op: 'rewrite', undo_scope: 'whole_body', undo_old_html: NOTE_HTML }],
            },
        } as any);
        expect(noteHtml).toBe(NOTE_HTML);
    });

    it('dispatches edit_note_batch to the batch undo', async () => {
        // Mirror image: a batch `rewrite` record has no `op`, so the blocks undo
        // would refuse it. Success proves the batch branch ran.
        noteHtml = '<div data-schema-version="9"><p>Replaced body.</p></div>';
        await undoEditNoteVariantAction({
            id: 'a', action_type: 'edit_note_batch', status: 'applied',
            proposed_data: { library_id: 1, zotero_key: 'NOTE0001', edits: [] },
            result_data: {
                library_id: 1, zotero_key: 'NOTE0001', applied: [],
                undo: [{ index: 0, operation: 'rewrite', undo_old_html: NOTE_HTML }],
            },
        } as any);
        expect(noteHtml).toBe(NOTE_HTML);
    });

    it('dispatches edit_note to the single-edit undo', async () => {
        await expect(undoEditNoteVariantAction({
            id: 'a', action_type: 'edit_note', status: 'applied',
            proposed_data: { library_id: 1, zotero_key: 'MISSING1', new_string: 'y' },
        } as any)).rejects.toThrow(/Item not found: 1-MISSING1/);
    });

    it('throws on an unregistered action type instead of silently running edit_note', async () => {
        await expect(undoEditNoteVariantAction({
            id: 'a', action_type: 'edit_note_paragraphs', status: 'applied',
            proposed_data: { library_id: 1, zotero_key: 'NOTE0001' },
        } as any)).rejects.toThrow(/Unsupported note-edit action type 'edit_note_paragraphs'/);
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });
});

// =============================================================================
// Variant helper
// =============================================================================

describe('getEditNoteCallVariant', () => {
    it('trusts action_type when it is known', () => {
        expect(getEditNoteCallVariant({ actionType: 'edit_note' })).toBe('legacy');
        expect(getEditNoteCallVariant({ actionType: 'edit_note_batch' })).toBe('batch');
        expect(getEditNoteCallVariant({ actionType: 'edit_note_blocks' })).toBe('blocks');
    });

    // PRESENCE of the array is what makes a call multi-edit, not its length.
    // Classifying an empty one as legacy makes callers derive a blank row from
    // the absent flat fields instead of no rows at all.
    it('classifies an empty edits[] as multi-edit, not legacy', () => {
        expect(getEditNoteCallVariant({ toolArgs: { edits: [] } })).toBe('batch');
        expect(getEditNoteCallVariant({ actionData: { edits: [] } })).toBe('batch');
        // No edits key at all is still legacy.
        expect(getEditNoteCallVariant({ toolArgs: { old_string: 'a', new_string: 'b' } })).toBe('legacy');
    });

    it('classifies STREAMING block-op args as blocks, not batch', () => {
        expect(getEditNoteCallVariant({
            toolArgs: { edits: [{ op: 'replace', block: 2, content: '<p>x</p>' }] },
        })).toBe('blocks');
        expect(getEditNoteCallVariant({
            toolArgs: { edits: [{ op: 'prepend', content: '<p>x</p>' }] },
        })).toBe('blocks');
        expect(getEditNoteCallVariant({
            toolArgs: { edits: [{ op: 'delete', block: 3 }] },
        })).toBe('blocks');
    });

    it('classifies streaming batch args as batch', () => {
        expect(getEditNoteCallVariant({
            toolArgs: { edits: [{ operation: 'str_replace', old_string: 'a', new_string: 'b' }] },
        })).toBe('batch');
        // A batch edit may omit `operation` entirely (it defaults to str_replace).
        expect(getEditNoteCallVariant({
            toolArgs: { edits: [{ old_string: 'a', new_string: 'b' }] },
        })).toBe('batch');
    });

    it('classifies legacy flat args as legacy', () => {
        expect(getEditNoteCallVariant({ toolArgs: { old_string: 'a', new_string: 'b' } })).toBe('legacy');
        expect(getEditNoteCallVariant({ toolArgs: {} })).toBe('legacy');
        expect(getEditNoteCallVariant({})).toBe('legacy');
    });

    // A half-streamed `edits: []` carries no evidence of WHICH multi-edit
    // variant it is — but it is still multi-edit, and that is the part that
    // matters. main classified it multi-edit too (`isBatch` tested
    // `Array.isArray(toolArgs?.edits)`), yielding zero rows from `[].map(...)`.
    // Calling it 'legacy' instead derives one blank row from the absent flat
    // fields, which is a visible regression on the legacy path.
    it('classifies a half-streamed empty edits[] as multi-edit, matching main', () => {
        expect(getEditNoteCallVariant({ toolArgs: { edits: [] } })).toBe('batch');
        expect(deriveEditNoteRows({ toolArgs: { edits: [] } })).toEqual([]);
    });

    it('prefers actionData over toolArgs, and `op` over a display-only `operation`', () => {
        // Validation writes a display-only `operation` onto persisted BLOCK edits
        // for the diff preview, so a finalized block call carries both fields.
        expect(getEditNoteCallVariant({
            actionData: { edits: [{ op: 'replace', block: 2, operation: 'str_replace' }] },
            toolArgs: { edits: [{ operation: 'str_replace' }] },
        })).toBe('blocks');
    });
});
