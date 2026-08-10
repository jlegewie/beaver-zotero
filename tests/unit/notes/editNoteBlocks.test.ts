import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks (must precede imports)
//
// DELIBERATELY THINNER than editNoteBatch.test.ts. Block addressing is a
// property of the REAL wrapper-bounds walk, the REAL footer detectors, the REAL
// whitespace/entity projection and the REAL snapshot digest, so
// `noteWrapper`, `noteEditFooter`, `noteHtmlEntities`, `noteSnapshot`,
// `editNoteBlocksCore` and `editNoteBatchCore` are all left unmocked. Only the
// Zotero/React edges and the simplifier are stubbed.
// =============================================================================

/** Ordered log of the async/IO boundaries, for the critical-section assertion. */
const callLog: string[] = [];

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
    preloadPageLabelsForNewCitations: vi.fn(async () => {
        callLog.push('async:preloadPageLabelsForNewCitations');
        return {};
    }),
    preloadNotePageLabels: vi.fn(async () => {
        callLog.push('async:preloadNotePageLabels');
        return {};
    }),
    preloadStructuralLocatorPages: vi.fn(async () => {
        callLog.push('async:preloadStructuralLocatorPages');
        return { pages: {}, unresolved: [] };
    }),
    buildUnresolvedLocatorWarning: vi.fn(() => null),
}));

// Partial mock: everything real EXCEPT `hasSchemaVersionWrapper`, which is
// overridable so the defensive `wrapper_removed` guard can be reached. Neither
// the block engine nor the apply path can strip the wrapper through normal
// input (splices stay inside [bodyStart, bodyEnd] and `buildRewrittenNoteBody`
// re-attaches it), so forcing the predicate is the only way to cover the branch.
vi.mock('../../../src/utils/noteWrapper', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/utils/noteWrapper')>();
    return { ...actual, hasSchemaVersionWrapper: vi.fn(actual.hasSchemaVersionWrapper) };
});

vi.mock('../../../src/utils/noteEditorIO', () => ({
    getNoteHtmlForRead: vi.fn(async (item: any) => {
        callLog.push('async:getNoteHtmlForRead');
        return item.getNote();
    }),
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    getLiveNoteHtmlCandidates: vi.fn(() => []),
    isNoteInEditor: vi.fn(() => false),
    waitForPMNormalization: vi.fn(async () => { callLog.push('async:waitForPMNormalization'); }),
    waitForNoteSaveStabilization: vi.fn(async () => { callLog.push('async:waitForNoteSaveStabilization'); }),
    flushLiveEditorToDB: vi.fn(async () => { callLog.push('async:flushLiveEditorToDB'); return false; }),
}));

vi.mock('../../../react/utils/noteEditorDiffPreview', () => ({
    dismissDiffPreview: vi.fn(async () => { callLog.push('async:dismissDiffPreview'); }),
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

import { handleAgentActionValidateRequest } from '../../../src/services/agentDataProvider/handleAgentActionValidateRequest';
import { handleAgentActionExecuteRequest } from '../../../src/services/agentDataProvider/handleAgentActionExecuteRequest';
import { getNoteHtmlForRead, getLatestNoteHtml } from '../../../src/utils/noteEditorIO';
import { getDeferredToolPreference, checkLibraryExcluded } from '../../../src/services/agentDataProvider/utils';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { buildAddressSnapshot, verifyAddressSnapshot, EMPTY_READ_WINDOW } from '../../../src/utils/noteSnapshot';
import { hasSchemaVersionWrapper } from '../../../src/utils/noteWrapper';
import { undoEditNoteBatchAction } from '../../../react/utils/editNoteActions';
import { buildPreviewableEditOperations } from '../../../react/utils/editNotePreviewOperations';
import { currentThreadIdAtom } from '../../../react/atoms/threads';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { EditNoteBlocksEditItem, EditNoteBlocksResultData } from '@beaver/agent-core/types/agentActions/editNoteBlocks';
import type {
    WSAgentActionValidateRequest,
    WSAgentActionExecuteRequest,
} from '@beaver/agent-core/protocol/agentProtocol';

// =============================================================================
// Fixtures
// =============================================================================

const LINE_1 = '<p>Alpha sentence one.</p>';
const LINE_2 = '<p>Bravo passage two.</p>';
const LINE_3 = '<p>Charlie section three.</p>';
const BODY = [LINE_1, LINE_2, LINE_3].join('\n');
const NOTE_HTML = `<div data-schema-version="9">${BODY}</div>`;
const SNAPSHOT = buildAddressSnapshot(BODY, { from: 1, to: 3 });

// A note long enough for `assessNoteRewrite` to consider it worth protecting
// (its comparable text must exceed MIN_CHARS_TO_ESCALATE = 600).
const LONG_LINES = Array.from({ length: 12 }, (_, i) =>
    `<p>Paragraph ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.</p>`);
const LONG_BODY = LONG_LINES.join('\n');
const LONG_NOTE_HTML = `<div data-schema-version="9">${LONG_BODY}</div>`;
const LONG_SNAPSHOT = buildAddressSnapshot(LONG_BODY, { from: 1, to: LONG_LINES.length });

// A note with a BLANK mid-document simplified line — what an empty list item
// (`<ul><li></li></ul>`) produces once the li-flattening pass has run.
const BLANK_BODY = ['<p>Alpha sentence one.</p>', '', '<p>Charlie section three.</p>'].join('\n');
const BLANK_NOTE_HTML = `<div data-schema-version="9">${BLANK_BODY}</div>`;
const BLANK_SNAPSHOT = buildAddressSnapshot(BLANK_BODY, { from: 1, to: 3 });

// Over MAX_INLINE_NOTE_LINES (500).
const MANY_LINES = Array.from({ length: 520 }, (_, i) => `<p>Line ${i + 1}.</p>`);
const MANY_BODY = MANY_LINES.join('\n');
const MANY_NOTE_HTML = `<div data-schema-version="9">${MANY_BODY}</div>`;
const MANY_SNAPSHOT = buildAddressSnapshot(MANY_BODY, { from: 1, to: MANY_LINES.length });

// Under the line cap but over MAX_INLINE_NOTE_CHARS (50_000).
const WIDE_LINES = Array.from({ length: 60 }, (_, i) => `<p>${String(i).padStart(4, '0')} ${'x'.repeat(1000)}</p>`);
const WIDE_BODY = WIDE_LINES.join('\n');
const WIDE_NOTE_HTML = `<div data-schema-version="9">${WIDE_BODY}</div>`;
const WIDE_SNAPSHOT = buildAddressSnapshot(WIDE_BODY, { from: 1, to: WIDE_LINES.length });

let noteHtml = NOTE_HTML;
let mockItem: any;

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
        loadDataType: vi.fn(async () => { callLog.push('async:loadDataType'); }),
        getNote: vi.fn(() => { callLog.push('sync:getNote'); return noteHtml; }),
        setNote: vi.fn((html: string) => { callLog.push('sync:setNote'); noteHtml = html; }),
        getNoteTitle: vi.fn(() => 'My Note'),
        saveTx: vi.fn(async () => { callLog.push('async:saveTx'); }),
    };
}

function useNote(html: string) {
    noteHtml = html;
    return mockItem;
}

function validateRequest(
    edits: EditNoteBlocksEditItem[],
    overrides: Record<string, any> = {},
): WSAgentActionValidateRequest {
    return {
        event: 'agent_action_validate',
        request_id: 'val-1',
        action_type: 'edit_note_blocks',
        action_data: { library_id: 1, zotero_key: 'NOTE0001', snapshot: SNAPSHOT, edits, ...overrides },
    } as unknown as WSAgentActionValidateRequest;
}

function executeRequest(
    edits: EditNoteBlocksEditItem[],
    overrides: Record<string, any> = {},
): WSAgentActionExecuteRequest {
    return {
        event: 'agent_action_execute',
        request_id: 'exe-1',
        action_type: 'edit_note_blocks',
        action_data: { library_id: 1, zotero_key: 'NOTE0001', snapshot: SNAPSHOT, edits, ...overrides },
    } as unknown as WSAgentActionExecuteRequest;
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
    callLog.length = 0;
    noteHtml = NOTE_HTML;
    mockItem = makeMockItem();

    (globalThis as any).Zotero = {
        Libraries: { get: vi.fn((id: number) => ({ name: `Library ${id}`, editable: true })) },
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async (libraryId: number, key: string) => {
                callLog.push(`async:getByLibraryAndKeyAsync:${libraryId}-${key}`);
                if (key === 'NOTE0001') return mockItem;
                if (key === 'EXISTS01') return { id: 7, key, libraryID: libraryId };
                return null;
            }),
        },
    };

    vi.mocked(store.get).mockImplementation((atom: any) =>
        (atom === searchableLibraryIdsAtom ? [1, 2] : null) as any);
    vi.mocked(getDeferredToolPreference).mockReturnValue('always_ask');
    vi.mocked(checkLibraryExcluded).mockReturnValue(null);
    // Restore the real predicate; only the wrapper_removed test overrides it.
    vi.mocked(hasSchemaVersionWrapper).mockImplementation((html: string) => {
        const trimmed = html.trim();
        if (!trimmed.startsWith('<div')) return false;
        const closeAngle = trimmed.indexOf('>');
        if (closeAngle === -1) return false;
        return /data-schema-version="/.test(trimmed.substring(0, closeAngle + 1));
    });
});

// =============================================================================
// Validate
// =============================================================================

describe('validateEditNoteBlocksAction', () => {
    it('validates a single block replace and emits flat preview fields', async () => {
        const response = await handleAgentActionValidateRequest(validateRequest([replaceBlock2]));

        expect(response.valid).toBe(true);
        expect(response.error_code).toBeUndefined();
        expect(response.current_value).toMatchObject({
            note_title: 'My Note',
            total_lines: 3,
            applicable_count: 1,
            skipped_count: 0,
        });
        expect(response.current_value.snapshot).toBe(buildAddressSnapshot(BODY, EMPTY_READ_WINDOW));

        const edits = response.normalized_action_data!.edits as EditNoteBlocksEditItem[];
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({
            index: 0,
            op: 'replace',
            block: 2,
            operation: 'str_replace',
            old_string: LINE_2,
            new_string: '<p>Bravo REWRITTEN two.</p>',
        });
        // 200-char raw anchors, taken from the stripped note around the target line.
        expect(edits[0].target_before_context).toBe(`<div data-schema-version="9">${LINE_1}\n`);
        expect(edits[0].target_after_context).toBe(`\n${LINE_3}</div>`);
        // Skipped-ness is derived, never stored as a status field.
        expect(edits[0]).not.toHaveProperty('validation_status');
        expect(edits[0]).not.toHaveProperty('edits');
    });

    it('reads the note with getNoteHtmlForRead, not getLatestNoteHtml', async () => {
        await handleAgentActionValidateRequest(validateRequest([replaceBlock2]));

        expect(getNoteHtmlForRead).toHaveBeenCalledTimes(1);
        expect(getLatestNoteHtml).not.toHaveBeenCalled();
    });

    it('refuses on a stale snapshot and returns the current note for re-addressing', async () => {
        const staleSnapshot = buildAddressSnapshot('<p>Something else entirely.</p>', { from: 1, to: 1 });
        const response = await handleAgentActionValidateRequest(
            validateRequest([replaceBlock2], { snapshot: staleSnapshot }),
        );

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('snapshot_mismatch');
        expect(response.current_value).toMatchObject({
            kind: 'snapshot_mismatch',
            total_lines: 3,
            note: BODY,
        });
        // The fresh token's window matches what is actually shipped (the whole note).
        expect(response.current_value.snapshot).toBe(buildAddressSnapshot(BODY, { from: 1, to: 3 }));
    });

    it('requires a snapshot whenever an edit addresses by number', async () => {
        const response = await handleAgentActionValidateRequest(
            validateRequest([replaceBlock2], { snapshot: undefined }),
        );
        expect(response).toMatchObject({ valid: false, error_code: 'snapshot_required' });
    });

    it('applies what it can and reports the rest as advisory edit_errors', async () => {
        const response = await handleAgentActionValidateRequest(validateRequest([
            replaceBlock2,
            { index: 1, op: 'replace', block: 3, expect: '<p>Totally different text here.</p>', content: '<p>X</p>' },
        ]));

        expect(response.valid).toBe(true);
        expect(response.current_value).toMatchObject({ applicable_count: 1, skipped_count: 1 });
        expect(response.edit_errors).toHaveLength(1);
        expect(response.edit_errors![0]).toMatchObject({ index: 1, error_code: 'expect_mismatch' });
        // `actual` is the whitespace-collapsed SIMPLIFIED line, tags included.
        expect(response.edit_errors![0].actual).toBe(LINE_3);

        const edits = response.normalized_action_data!.edits as EditNoteBlocksEditItem[];
        expect(edits[1]).toMatchObject({ index: 1, skip_reason_code: 'expect_mismatch' });
        expect(edits[1].skip_reason).toContain('expect');
        // A skipped edit must carry NO preview pair, or the preview flattener
        // would render it as if it had applied.
        expect(edits[1]).not.toHaveProperty('operation');
        expect(edits[1]).not.toHaveProperty('old_string');
        expect(edits[1]).not.toHaveProperty('new_string');
    });

    it('fails the whole call when every edit is skipped', async () => {
        const response = await handleAgentActionValidateRequest(validateRequest([
            { index: 0, op: 'replace', block: 99, expect: LINE_2, content: '<p>X</p>' },
        ]));
        expect(response).toMatchObject({ valid: false, error_code: 'no_applicable_edits' });
        expect(response.edit_errors![0].error_code).toBe('block_out_of_range');
    });

    it('rejects an op:"rewrite" edit that shares the request with numbered edits', async () => {
        const response = await handleAgentActionValidateRequest(validateRequest([
            { index: 0, op: 'rewrite', content: '<p>X</p>' },
            // index 1, so the positional-index invariant (which also returns
            // `invalid_edits`) cannot be what fails first.
            { ...replaceBlock2, index: 1 },
        ]));
        expect(response).toMatchObject({ valid: false, error_code: 'invalid_edits' });
        expect(response.error).toContain('op:"rewrite"');
    });

    it('rejects an edit whose index does not match its position', async () => {
        const response = await handleAgentActionValidateRequest(validateRequest([
            replaceBlock2,
            { ...replaceBlock2, index: 5 },
        ]));
        expect(response).toMatchObject({ valid: false, error_code: 'invalid_edits' });
        expect(response.error).toContain('zero-based position');
    });

    it('rejects an empty note', async () => {
        useNote('');
        const response = await handleAgentActionValidateRequest(validateRequest([replaceBlock2]));
        expect(response).toMatchObject({ valid: false, error_code: 'empty_note' });
    });
});

// =============================================================================
// Large-note fail-closed window
// =============================================================================

describe('edit_note_blocks large-note fail-closed window', () => {
    const staleSnapshot = buildAddressSnapshot('<p>Something else entirely.</p>', { from: 1, to: 1 });

    it.each([
        ['over the line cap', () => MANY_NOTE_HTML, () => MANY_BODY],
        ['over the character cap', () => WIDE_NOTE_HTML, () => WIDE_BODY],
    ])('omits the note body and issues an empty-window token on a validate mismatch (%s)', async (_label, note, body) => {
        useNote(note());
        const response = await handleAgentActionValidateRequest(
            validateRequest([replaceBlock2], { snapshot: staleSnapshot }),
        );

        expect(response).toMatchObject({ valid: false, error_code: 'snapshot_mismatch' });
        expect(response.current_value.kind).toBe('snapshot_mismatch');
        expect(response.current_value.note).toBeUndefined();
        expect(response.current_value.truncated).toBe(true);
        // Fail closed: the token licenses NO numeric address until a re-read.
        expect(verifyAddressSnapshot(response.current_value.snapshot, body()))
            .toEqual(EMPTY_READ_WINDOW);
    });

    it.each([
        ['over the line cap', () => MANY_NOTE_HTML, () => MANY_LINES, () => MANY_SNAPSHOT],
        ['over the character cap', () => WIDE_NOTE_HTML, () => WIDE_LINES, () => WIDE_SNAPSHOT],
    ])('omits the note body and issues an empty-window token in refreshed_note (%s)', async (_label, note, lines, snapshot) => {
        useNote(note());
        const response = await handleAgentActionExecuteRequest(executeRequest(
            [{ index: 0, op: 'replace', block: 2, expect: lines()[1], content: '<p>Replaced.</p>' }],
            { snapshot: snapshot() },
        ));

        expect(response.success).toBe(true);
        expect(response.refreshed_note!.note).toBeUndefined();
        expect(response.refreshed_note!.truncated).toBe(true);

        const postBody = [...lines().slice(0, 1), '<p>Replaced.</p>', ...lines().slice(2)].join('\n');
        expect(verifyAddressSnapshot(response.refreshed_note!.snapshot, postBody))
            .toEqual(EMPTY_READ_WINDOW);
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.address_post_snapshot).toBe(response.refreshed_note!.snapshot);
    });

    it('still ships the body and a whole-note window just under the caps', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));
        expect(response.refreshed_note!.truncated).toBeUndefined();
        expect(response.refreshed_note!.note).toBeDefined();
        expect(verifyAddressSnapshot(response.refreshed_note!.snapshot, response.refreshed_note!.note!))
            .toEqual({ from: 1, to: 3 });
    });
});

// =============================================================================
// Destructive escalation
// =============================================================================

describe('edit_note_blocks destructive escalation', () => {
    it('escalates a block:"all" rewrite that guts the note', async () => {
        useNote(LONG_NOTE_HTML);
        const response = await handleAgentActionValidateRequest(validateRequest(
            [{ index: 0, op: 'rewrite', content: '<p>Tiny.</p>' }],
            { snapshot: undefined },
        ));

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data!.destructive_rewrite).toBe(true);
        expect(getDeferredToolPreference).toHaveBeenCalledWith('destructive_note_rewrite', expect.anything());
    });

    it('escalates a delete that spans the whole note — a shape edit_note_batch never sees', async () => {
        useNote(LONG_NOTE_HTML);
        const response = await handleAgentActionValidateRequest(validateRequest(
            [{
                index: 0,
                op: 'delete',
                block: 1,
                to: LONG_LINES.length,
                expect: LONG_LINES[0],
                expect_end: LONG_LINES[LONG_LINES.length - 1],
            }],
            { snapshot: LONG_SNAPSHOT },
        ));

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data!.destructive_rewrite).toBe(true);
        expect(getDeferredToolPreference).toHaveBeenCalledWith('destructive_note_rewrite', expect.anything());
    });

    it('does NOT escalate a benign block:"all" rewrite', async () => {
        useNote(LONG_NOTE_HTML);
        const benign = LONG_LINES.map((l) => l.replace('lorem', 'Lorem')).join('\n');
        const response = await handleAgentActionValidateRequest(validateRequest(
            [{ index: 0, op: 'rewrite', content: benign }],
            { snapshot: undefined },
        ));

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data!.destructive_rewrite).toBeUndefined();
        expect(getDeferredToolPreference).toHaveBeenCalledWith('edit_note_blocks', expect.anything());
    });

    it('re-checks destructiveness at execute and refuses an unapproved rewrite', async () => {
        useNote(LONG_NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(executeRequest(
            [{ index: 0, op: 'rewrite', content: '<p>Tiny.</p>' }],
            { snapshot: undefined },
        ));

        expect(response).toMatchObject({ success: false, error_code: 'note_changed' });
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });

    it('applies the same rewrite once it carries the destructive_rewrite approval flag', async () => {
        useNote(LONG_NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(executeRequest(
            [{ index: 0, op: 'rewrite', content: '<p>Tiny.</p>' }],
            { snapshot: undefined, destructive_rewrite: true },
        ));

        expect(response.success).toBe(true);
        expect(noteHtml).toBe('<div data-schema-version="9"><p>Tiny.</p></div>');
    });
});

// =============================================================================
// Execute
// =============================================================================

describe('executeEditNoteBlocksAction', () => {
    it('applies a block replace and returns result_data + refreshed_note', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));

        expect(response.success).toBe(true);
        expect(noteHtml).toBe(
            `<div data-schema-version="9">${LINE_1}\n<p>Bravo REWRITTEN two.</p>\n${LINE_3}</div>`,
        );

        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.applied).toEqual([{ index: 0, blocks: '2' }]);
        expect(result.skipped).toEqual([]);
        expect(result.address_pre_snapshot).toBe(SNAPSHOT);
        expect(result.undo).toHaveLength(1);
        expect(result.undo[0]).toMatchObject({ index: 0, op: 'replace', undo_old_html: LINE_2 });

        const newBody = `${LINE_1}\n<p>Bravo REWRITTEN two.</p>\n${LINE_3}`;
        expect(response.refreshed_note).toMatchObject({ total_lines: 3, note: newBody });
        expect(response.refreshed_note!.snapshot).toBe(buildAddressSnapshot(newBody, { from: 1, to: 3 }));
        expect(result.address_post_snapshot).toBe(response.refreshed_note!.snapshot);
        // Transport-only: the note body must not be persisted into result_data.
        expect(result).not.toHaveProperty('note');
        expect(result).not.toHaveProperty('refreshed_note');
    });

    it('returns refreshed_note on an approval-delay snapshot mismatch', async () => {
        const staleSnapshot = buildAddressSnapshot('<p>Something else entirely.</p>', { from: 1, to: 1 });
        const response = await handleAgentActionExecuteRequest(
            executeRequest([replaceBlock2], { snapshot: staleSnapshot }),
        );

        expect(response).toMatchObject({ success: false, error_code: 'snapshot_mismatch' });
        expect(response.refreshed_note).toMatchObject({ total_lines: 3, note: BODY });
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });

    it('applies a block:"all" rewrite through the wrapper-preserving path', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest(
            [{ index: 0, op: 'rewrite', content: '<p>One.</p>\n<p>Two.</p>' }],
            { snapshot: undefined },
        ));

        expect(response.success).toBe(true);
        expect(noteHtml).toBe('<div data-schema-version="9"><p>One.</p>\n<p>Two.</p></div>');

        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.applied).toEqual([{ index: 0, blocks: '1-2' }]);
        // A whole-body rewrite stores the FULL pre-edit stripped body.
        expect(result.undo[0]).toMatchObject({ index: 0, op: 'rewrite', undo_old_html: NOTE_HTML });
    });

    it('emits advisory block_hints for skipped edits using the applied line deltas', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([
            // Inserts two lines after block 1, shifting everything below by +2.
            { index: 0, op: 'insert', after: 1, expect: LINE_1, content: '<p>Inserted A.</p>\n<p>Inserted B.</p>' },
            // Skipped, but its intended target now lives two blocks lower.
            { index: 1, op: 'replace', block: 3, expect: '<p>Nothing like this at all.</p>', content: '<p>X</p>' },
        ]));

        expect(response.success).toBe(true);
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.applied).toEqual([{ index: 0, blocks: '2-3' }]);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]).toMatchObject({
            index: 1,
            reason_code: 'expect_mismatch',
            block_hint: '5',
        });
    });

    it('ships per-edit reasons in result_data when every edit is skipped', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([
            { index: 0, op: 'replace', block: 2, expect: '<p>Nothing like this at all.</p>', content: '<p>X</p>' },
            { index: 1, op: 'replace', block: 99, expect: LINE_3, content: '<p>Y</p>' },
        ]));

        expect(response).toMatchObject({ success: false, error_code: 'no_applicable_edits' });
        expect(mockItem.setNote).not.toHaveBeenCalled();

        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.skipped).toHaveLength(2);
        expect(result.skipped[0]).toMatchObject({ index: 0, reason_code: 'expect_mismatch', actual: LINE_2 });
        expect(result.skipped[0].reason).toContain('expect');
        expect(result.skipped[1]).toMatchObject({ index: 1, reason_code: 'block_out_of_range' });
        expect(result.skipped[1].reason).toBeTruthy();
        // Nothing was applied, so there is no shift to advise on.
        expect(result.skipped[0]).not.toHaveProperty('block_hint');
        expect(result.skipped[1]).not.toHaveProperty('block_hint');
    });

    it('performs the authoritative note read AFTER every preload and takes no await before setNote', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));
        expect(response.success).toBe(true);

        const setNoteAt = callLog.indexOf('sync:setNote');
        expect(setNoteAt).toBeGreaterThan(-1);
        // The authoritative read is the LAST getNote before setNote.
        const authoritativeAt = callLog.lastIndexOf('sync:getNote', setNoteAt);
        expect(authoritativeAt).toBeGreaterThan(-1);

        // 1. Every pre-write preload happened BEFORE the authoritative read.
        //    (One more preload runs AFTER the save, to re-simplify for the post
        //    snapshot; it is outside the critical section by construction.)
        const preloadsBeforeWrite = callLog
            .slice(0, setNoteAt)
            .map((entry, i) => ({ entry, i }))
            .filter(({ entry }) => entry.startsWith('async:preload'));
        expect(preloadsBeforeWrite.length).toBeGreaterThan(0);
        for (const { i } of preloadsBeforeWrite) {
            expect(i).toBeLessThan(authoritativeAt);
        }
        // Citation-identity resolution for degrade is also a preload — it must
        // never happen inside the critical section either.
        const lookupsBeforeWrite = callLog
            .slice(0, setNoteAt)
            .map((entry, i) => ({ entry, i }))
            .filter(({ entry }) => entry.startsWith('async:getByLibraryAndKeyAsync'));
        for (const { i } of lookupsBeforeWrite) {
            expect(i).toBeLessThan(authoritativeAt);
        }

        // 2. NOTHING async happened between the authoritative read and setNote.
        const between = callLog.slice(authoritativeAt + 1, setNoteAt);
        expect(between.filter((e) => e.startsWith('async:'))).toEqual([]);
    });

    it('re-runs the exclusion guard at execute time', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValue({ message: 'Library 1 is excluded from Beaver.' });
        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));
        expect(response).toMatchObject({ success: false, error_code: 'library_not_searchable' });
        expect(mockItem.setNote).not.toHaveBeenCalled();
    });

    it('gates on the RESOLVED library when it differs from the requested one', async () => {
        // The pre-resolve gate checks the library the REQUEST names (1, allowed).
        // The item actually lives in library 5, which is excluded — only the
        // post-resolve guard can catch that.
        mockItem.libraryID = 5;
        vi.mocked(checkLibraryExcluded).mockImplementation((id: number) =>
            (id === 5 ? { message: 'Library 5 is excluded from Beaver.' } : null));

        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));

        expect(response).toMatchObject({ success: false, error_code: 'library_not_searchable' });
        expect(response.error).toContain('Library 5');
        expect(mockItem.setNote).not.toHaveBeenCalled();
        // Proof the PRE-resolve gate let it through: resolution happened.
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalled();
    });

    it('refuses to save when the schema-version wrapper would be lost', async () => {
        // Unreachable through normal input — splices stay inside the wrapper —
        // so the predicate is forced to reach the defensive branch.
        vi.mocked(hasSchemaVersionWrapper)
            .mockReturnValueOnce(true)   // pre-edit stripped HTML had a wrapper
            .mockReturnValueOnce(false); // post-edit HTML no longer does

        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));

        expect(response).toMatchObject({ success: false, error_code: 'wrapper_removed' });
        expect(mockItem.setNote).not.toHaveBeenCalled();
        expect(noteHtml).toBe(NOTE_HTML);
    });

    it('stamps the Beaver edit footer when a thread is active', async () => {
        vi.mocked(store.get).mockImplementation((atom: any) => {
            if (atom === searchableLibraryIdsAtom) return [1, 2] as any;
            if (atom === currentThreadIdAtom) return 'thread-abc' as any;
            return null as any;
        });

        const response = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));

        expect(response.success).toBe(true);
        expect(noteHtml).toContain('Edited by Beaver');
        expect(noteHtml).toContain('thread-abc');
        // The footer goes inside the wrapper, after the content.
        expect(noteHtml.indexOf('Edited by Beaver')).toBeGreaterThan(noteHtml.indexOf(LINE_3));
        expect(noteHtml.endsWith('</div>')).toBe(true);
    });

    it('re-checks destructiveness on the NUMERIC path at execute time', async () => {
        // Stands in for "validation cleared this edit set, then the note changed
        // underneath": execute re-classifies its own re-selection and refuses,
        // because the action carries no destructive_rewrite approval.
        useNote(LONG_NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(executeRequest(
            [{
                index: 0,
                op: 'delete',
                block: 1,
                to: LONG_LINES.length,
                expect: LONG_LINES[0],
                expect_end: LONG_LINES[LONG_LINES.length - 1],
            }],
            { snapshot: LONG_SNAPSHOT },
        ));

        expect(response).toMatchObject({ success: false, error_code: 'note_changed' });
        expect(mockItem.setNote).not.toHaveBeenCalled();
        expect(noteHtml).toBe(LONG_NOTE_HTML);
    });

    it('applies that same delete once it carries the approval flag', async () => {
        useNote(LONG_NOTE_HTML);
        const response = await handleAgentActionExecuteRequest(executeRequest(
            [{
                index: 0,
                op: 'delete',
                block: 1,
                to: LONG_LINES.length,
                expect: LONG_LINES[0],
                expect_end: LONG_LINES[LONG_LINES.length - 1],
            }],
            { snapshot: LONG_SNAPSHOT, destructive_rewrite: true },
        ));

        expect(response.success).toBe(true);
        expect(noteHtml).toBe('<div data-schema-version="9"></div>');
    });
});

// =============================================================================
// Advisory block arithmetic
// =============================================================================

describe('edit_note_blocks advisory block ranges', () => {
    it('reports the produced range of an insert at the very start of the note', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([
            { index: 0, op: 'insert', after: 0, content: '<p>New A.</p>\n<p>New B.</p>' },
        ]));

        expect(response.success).toBe(true);
        expect(noteHtml).toBe(
            `<div data-schema-version="9"><p>New A.</p>\n<p>New B.</p>\n${LINE_1}\n${LINE_2}\n${LINE_3}</div>`,
        );
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        // The inserted content IS blocks 1-2. An edit must never fold its own
        // delta into its own reported position.
        expect(result.applied).toEqual([{ index: 0, blocks: '1-2' }]);
    });

    it('reports the produced range of an insert in the middle of the note', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([
            { index: 0, op: 'insert', after: 1, expect: LINE_1, content: '<p>New A.</p>' },
        ]));
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.applied).toEqual([{ index: 0, blocks: '2' }]);
    });

    it('reports an empty produced range for a delete', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([
            { index: 0, op: 'delete', block: 2, expect: LINE_2 },
        ]));
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.applied).toEqual([{ index: 0, blocks: '' }]);
    });
});

// =============================================================================
// Diff-preview survivability
// =============================================================================

describe('edit_note_blocks preview pair', () => {
    it('pins the anchor-merge order for insert_after and insert_before', async () => {
        const response = await handleAgentActionValidateRequest(validateRequest([
            { index: 0, op: 'insert', after: 0, content: '<p>Top.</p>' },
            { index: 1, op: 'insert', after: 2, expect: LINE_2, content: '<p>Middle.</p>' },
        ]));

        expect(response.valid).toBe(true);
        const edits = response.normalized_action_data!.edits as EditNoteBlocksEditItem[];

        // insert_before → content FIRST, then the anchor.
        expect(edits[0]).toMatchObject({
            operation: 'insert_before',
            old_string: LINE_1,
            new_string: `<p>Top.</p>\n${LINE_1}`,
        });
        // insert_after → anchor FIRST, then the content.
        expect(edits[1]).toMatchObject({
            operation: 'insert_after',
            old_string: LINE_2,
            new_string: `${LINE_2}\n<p>Middle.</p>`,
        });

        // Both must survive the real preview flattener.
        expect(buildPreviewableEditOperations([response.normalized_action_data!])).toHaveLength(2);
    });

    it('keeps a blank-anchored edit in the preview by widening its anchor', async () => {
        useNote(BLANK_NOTE_HTML);
        const response = await handleAgentActionValidateRequest(validateRequest(
            [{ index: 0, op: 'replace', block: 2, expect: '', content: '<p>Filled in.</p>' }],
            { snapshot: BLANK_SNAPSHOT },
        ));

        expect(response.valid).toBe(true);
        const edits = response.normalized_action_data!.edits as EditNoteBlocksEditItem[];
        // Widened BACKWARDS onto line 1, so the change renders in context.
        expect(edits[0].old_string).toBe('<p>Alpha sentence one.</p>\n');
        expect(edits[0].new_string).toBe('<p>Alpha sentence one.</p>\n<p>Filled in.</p>');

        // The real gate, not a re-implementation of it.
        expect(buildPreviewableEditOperations([response.normalized_action_data!])).toHaveLength(1);
    });

    it('shows every change when one edit of several is blank-anchored', async () => {
        useNote(BLANK_NOTE_HTML);
        const response = await handleAgentActionValidateRequest(validateRequest(
            [
                { index: 0, op: 'replace', block: 1, expect: '<p>Alpha sentence one.</p>', content: '<p>Alpha edited.</p>' },
                { index: 1, op: 'replace', block: 2, expect: '', content: '<p>Filled in.</p>' },
                { index: 2, op: 'replace', block: 3, expect: '<p>Charlie section three.</p>', content: '<p>Charlie edited.</p>' },
            ],
            { snapshot: BLANK_SNAPSHOT },
        ));

        expect(response.valid).toBe(true);
        expect(response.current_value.applicable_count).toBe(3);
        // The defect this guards: 3 approved, 2 rendered.
        expect(buildPreviewableEditOperations([response.normalized_action_data!])).toHaveLength(3);
    });

    it('does not widen a delete into showing borrowed context as deleted', async () => {
        useNote(BLANK_NOTE_HTML);
        const response = await handleAgentActionValidateRequest(validateRequest(
            [{ index: 0, op: 'delete', block: 2, expect: '' }],
            { snapshot: BLANK_SNAPSHOT },
        ));

        expect(response.valid).toBe(true);
        const edits = response.normalized_action_data!.edits as EditNoteBlocksEditItem[];
        expect(edits[0].old_string).toBe('<p>Alpha sentence one.</p>\n');
        // The borrowed line SURVIVES on the "after" side — only the blank goes.
        expect(edits[0].new_string).toBe('<p>Alpha sentence one.</p>');
        expect(buildPreviewableEditOperations([response.normalized_action_data!])).toHaveLength(1);
    });
});

// =============================================================================
// Undo ladder
// =============================================================================

/**
 * `edit_note_blocks` undo records reuse the batch engine's draft shape verbatim
 * (`undo_old_html`/`undo_new_html` plus the 200-char context anchors), with
 * `{index, client_item_id?, op}` identifying the edit. Until the React-side
 * blocks router lands, the batch replayer is the honest way to exercise them:
 * `applyBatchUndoRecord` defaults a record with no `operation` to `str_replace`,
 * which is exactly what every non-`all` block splice is.
 */
function asBatchUndoAction(result: EditNoteBlocksResultData): any {
    return {
        id: 'blocks-undo',
        action_type: 'edit_note_batch',
        proposed_data: { library_id: 1, zotero_key: 'NOTE0001' },
        result_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            applied: result.applied.map((a) => ({ index: a.index, occurrences_replaced: 1 })),
            undo: result.undo,
        },
    };
}

describe('edit_note_blocks undo', () => {
    it('reverts a locator-only block replace', async () => {
        const exec = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));
        expect(exec.success).toBe(true);
        expect(noteHtml).not.toBe(NOTE_HTML);

        await undoEditNoteBatchAction(asBatchUndoAction(exec.result_data as any));
        expect(noteHtml).toBe(NOTE_HTML);
    });

    it('reverts a deletion through the eagerly captured context anchors after drift', async () => {
        const exec = await handleAgentActionExecuteRequest(executeRequest([
            { index: 0, op: 'delete', block: 2, expect: LINE_2 },
        ]));
        expect(exec.success).toBe(true);
        expect(noteHtml).toBe(`<div data-schema-version="9">${LINE_1}\n${LINE_3}</div>`);

        // The user edits an UNRELATED part of the note before undoing.
        noteHtml = noteHtml.replace('Charlie section three.', 'Charlie section three, revised.');

        await undoEditNoteBatchAction(asBatchUndoAction(exec.result_data as any));
        expect(noteHtml).toContain(LINE_2);
        expect(noteHtml).toContain('Charlie section three, revised.');
    });

    it('treats a second undo of an applied replace as a no-op', async () => {
        const exec = await handleAgentActionExecuteRequest(executeRequest([replaceBlock2]));
        const action = asBatchUndoAction(exec.result_data as any);

        await undoEditNoteBatchAction(action);
        expect(noteHtml).toBe(NOTE_HTML);
        await undoEditNoteBatchAction(action);
        expect(noteHtml).toBe(NOTE_HTML);
    });
});

// =============================================================================
// Citation rejection
// =============================================================================

describe('edit_note_blocks citation rejection', () => {
    it('rejects a citation whose item does not exist instead of writing the id into the note', async () => {
        const before = noteHtml;
        const response = await handleAgentActionExecuteRequest(executeRequest([{
            index: 0,
            op: 'replace',
            block: 2,
            expect: LINE_2,
            content: '<p>Bravo, revised <citation id="1-MISSING1"/></p>',
        }]));

        // Sole edit rejected -> nothing applied, and the raw identifier never
        // reaches the note.
        expect(response.success).toBe(false);
        expect(noteHtml).toBe(before);
        expect(noteHtml).not.toContain('1-MISSING1');
        // The per-edit reason rides in result_data, not in the flat error.
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.skipped[0]).toMatchObject({ index: 0, reason_code: 'expansion_failed' });
        expect(result.skipped[0].reason).toContain('does not exist');
        expect(result.skipped[0].reason).toContain('1-MISSING1');
    });

    it('rejects only the offending edit and applies its sound sibling', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([
            {
                index: 0,
                op: 'replace',
                block: 2,
                expect: LINE_2,
                content: '<p>Bravo, revised <citation id="1-MISSING1"/></p>',
            },
            {
                index: 1,
                op: 'replace',
                block: 3,
                expect: LINE_3,
                content: '<p>Charlie, revised.</p>',
            },
        ]));

        expect(response.success).toBe(true);
        expect(noteHtml).toContain('<p>Charlie, revised.</p>');
        expect(noteHtml).not.toContain('1-MISSING1');
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.applied.map((a) => a.index)).toEqual([1]);
        expect(result.skipped.map((s) => s.index)).toEqual([0]);
        expect(result.skipped[0].reason_code).toBe('expansion_failed');
        expect(result.skipped[0].reason).toContain('does not exist');
    });

    it('leaves a resolvable citation alone', async () => {
        const response = await handleAgentActionExecuteRequest(executeRequest([{
            index: 0,
            op: 'replace',
            block: 2,
            expect: LINE_2,
            content: '<p>Bravo, revised <citation id="1-EXISTS01"/></p>',
        }]));

        expect(response.success).toBe(true);
        expect(noteHtml).toContain('<citation id="1-EXISTS01"/>');
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.warnings ?? []).toEqual([]);
    });

    it('rejects an excluded-library citation WITHOUT ever looking the item up', async () => {
        vi.mocked(checkLibraryExcluded).mockImplementation((id: number) =>
            (id === 99 ? { message: 'Library 99 is excluded from Beaver.' } : null));
        const before = noteHtml;

        const response = await handleAgentActionExecuteRequest(executeRequest([{
            index: 0,
            op: 'replace',
            block: 2,
            expect: LINE_2,
            // `EXISTS01` would resolve in library 1 — proving existence is not
            // what decides the outcome here.
            content: '<p>Bravo, revised <citation id="99-EXISTS01"/></p>',
        }]));

        expect(response.success).toBe(false);
        expect(noteHtml).toBe(before);
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.skipped[0].reason).toContain('Library 99 is excluded from Beaver.');

        // The privacy boundary: no lookup in the excluded library, at all.
        const lookups = vi.mocked((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).mock.calls;
        expect(lookups.some((args: any[]) => args[0] === 99)).toBe(false);
        expect(callLog.some((e) => e.startsWith('async:getByLibraryAndKeyAsync:99-'))).toBe(false);
    });

    it('rejects an unknown external_id (tier 3)', async () => {
        const before = noteHtml;
        const response = await handleAgentActionExecuteRequest(executeRequest([{
            index: 0,
            op: 'replace',
            block: 2,
            expect: LINE_2,
            content: '<p>Bravo, revised <citation external_id="W123456789"/></p>',
        }]));

        expect(response.success).toBe(false);
        expect(noteHtml).toBe(before);
        expect(noteHtml).not.toContain('W123456789');
        const result = response.result_data as unknown as EditNoteBlocksResultData;
        expect(result.skipped[0].reason).toContain('external_id="W123456789"');
    });
});
