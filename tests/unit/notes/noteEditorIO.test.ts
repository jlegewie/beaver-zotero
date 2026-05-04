import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger to silence the diagnostic message getLatestNoteHtml emits when
// it sees multiple distinct snapshots.
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// `noteEditorIO` transitively imports `editNoteRawPosition` →
// `noteCitationExpand` → `zoteroUtils` → `agentDataProvider/*` → `apiService`
// → `supabaseClient`. Stub the bottom layers so the module loads in a unit
// harness without a Supabase env.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(() => 'unavailable'),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

import {
    getLatestNoteHtml,
    getLiveNoteHtmlCandidates,
    getNoteHtmlForRead,
} from '../../../src/utils/noteEditorIO';

// =============================================================================
// Helpers
// =============================================================================

interface InstanceShape {
    html: string | (() => string);
    itemId: number;
    disabled?: boolean;
    connected?: boolean;
    tabId?: string;
    viewMode?: string;
}

function makeInstance(shape: InstanceShape): any {
    const { html, itemId, disabled = false, connected = true, tabId, viewMode } = shape;
    return {
        _item: { id: itemId },
        _disableSaving: disabled,
        tabID: tabId,
        viewMode,
        _iframeWindow: {
            frameElement: { isConnected: connected },
            wrappedJSObject: {
                getDataSync: () => {
                    const value = typeof html === 'function' ? html() : html;
                    return { html: value };
                },
            },
        },
    };
}

function setEditors(instances: any[], selectedTabId?: string): void {
    const z = (globalThis as any).Zotero;
    z.Notes = { _editorInstances: instances };
    z.getMainWindow = () => ({ Zotero_Tabs: { selectedID: selectedTabId } });
}

function makeItem(opts: { id?: number; getNote?: () => string; setNote?: any } = {}): any {
    return {
        id: opts.id ?? 1,
        getNote: opts.getNote ?? (() => ''),
        setNote: opts.setNote ?? vi.fn(),
    };
}

beforeEach(() => {
    setEditors([]);
});

// =============================================================================
// getLiveNoteHtmlCandidates
// =============================================================================

describe('getLiveNoteHtmlCandidates', () => {
    it('returns empty array when no live editor exists', () => {
        const result = getLiveNoteHtmlCandidates(makeItem());
        expect(result).toEqual([]);
    });

    it('returns html for connected, non-disabled instances only', () => {
        setEditors([
            makeInstance({ html: '<p>a</p>', itemId: 1 }),
            makeInstance({ html: '<p>b</p>', itemId: 1, disabled: true }),    // skipped (saving disabled)
            makeInstance({ html: '<p>c</p>', itemId: 1, connected: false }),  // skipped (iframe detached)
            makeInstance({ html: '<p>d</p>', itemId: 2 }),                    // skipped (different item)
        ]);
        const result = getLiveNoteHtmlCandidates(makeItem({ id: 1 }));
        expect(result).toEqual(['<p>a</p>']);
    });

    it('orders candidates by selected-tab > viewMode=tab > savedHtml-matching > rest', () => {
        setEditors(
            [
                makeInstance({ html: '<p>plain</p>', itemId: 1 }),
                makeInstance({ html: '<p>matches saved</p>', itemId: 1 }),
                makeInstance({ html: '<p>tab view</p>', itemId: 1, viewMode: 'tab' }),
                makeInstance({ html: '<p>selected</p>', itemId: 1, tabId: 'tab-A' }),
            ],
            'tab-A',
        );
        const result = getLiveNoteHtmlCandidates(
            makeItem({ id: 1, getNote: () => '<p>matches saved</p>' }),
        );
        expect(result).toEqual([
            '<p>selected</p>',
            '<p>tab view</p>',
            '<p>matches saved</p>',
            '<p>plain</p>',
        ]);
    });

    it('includes empty/whitespace snapshots so callers can decide', () => {
        setEditors([
            makeInstance({ html: '', itemId: 1 }),
            makeInstance({ html: '   ', itemId: 1 }),
            makeInstance({ html: '<p>real</p>', itemId: 1 }),
        ]);
        const result = getLiveNoteHtmlCandidates(makeItem({ id: 1 }));
        expect(result).toContain('');
        expect(result).toContain('   ');
        expect(result).toContain('<p>real</p>');
    });

    it('survives a throwing instance and continues with the rest', () => {
        const exploding: any = {
            _item: { id: 1 },
            _disableSaving: false,
            _iframeWindow: {
                frameElement: { isConnected: true },
                wrappedJSObject: {
                    getDataSync: () => { throw new Error('xpcom blew up'); },
                },
            },
        };
        setEditors([exploding, makeInstance({ html: '<p>survivor</p>', itemId: 1 })]);
        const result = getLiveNoteHtmlCandidates(makeItem({ id: 1 }));
        expect(result).toEqual(['<p>survivor</p>']);
    });
});

// =============================================================================
// getNoteHtmlForRead
// =============================================================================

describe('getNoteHtmlForRead', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the first non-empty live candidate (skipping empty preferred)', async () => {
        // Multi-editor blind-spot regression guard: the preferred (selected
        // tab) candidate is empty, but another connected editor still has
        // content. The read path must surface the non-empty content rather
        // than fall back to potentially-stale saved HTML.
        setEditors(
            [
                makeInstance({ html: '', itemId: 1, tabId: 'tab-A' }),  // preferred but empty
                makeInstance({ html: '<p>fallback live content</p>', itemId: 1 }),
            ],
            'tab-A',
        );
        const item = makeItem({ id: 1, getNote: () => '<p>saved (stale)</p>' });
        const result = await getNoteHtmlForRead(item);
        expect(result).toBe('<p>fallback live content</p>');
    });

    it('returns the live candidate immediately when it is non-empty (no retry sleeps)', async () => {
        setEditors([makeInstance({ html: '<p>live</p>', itemId: 1 })]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved</p>' });
        // No timer advance — promise must resolve without waiting on retries.
        const result = await getNoteHtmlForRead(item);
        expect(result).toBe('<p>live</p>');
    });

    it('retries when all live candidates are transiently empty, then succeeds on the recovery', async () => {
        let calls = 0;
        setEditors([
            makeInstance({
                itemId: 1,
                // First read returns empty; second and beyond return content.
                html: () => (++calls >= 2 ? '<p>recovered</p>' : ''),
            }),
        ]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved</p>' });

        const promise = getNoteHtmlForRead(item);
        // First retry tick (50ms) — recovery happens here.
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toBe('<p>recovered</p>');
    });

    it('falls back to saved HTML when all retries exhaust without recovery', async () => {
        setEditors([makeInstance({ html: '', itemId: 1 })]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved fallback</p>' });

        const promise = getNoteHtmlForRead(item);
        // 3 retries × 50ms = 150ms. Advance past that.
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;
        expect(result).toBe('<p>saved fallback</p>');
    });

    it('returns empty when both live candidates and saved HTML are empty', async () => {
        setEditors([makeInstance({ html: '', itemId: 1 })]);
        const item = makeItem({ id: 1, getNote: () => '' });

        const promise = getNoteHtmlForRead(item);
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;
        expect(result).toBe('');
    });

    it('NEVER calls item.setNote (regression guard for the data-loss path)', async () => {
        const setNote = vi.fn();
        setEditors([makeInstance({ html: '', itemId: 1 })]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved</p>', setNote });

        const promise = getNoteHtmlForRead(item);
        await vi.advanceTimersByTimeAsync(200);
        await promise;
        expect(setNote).not.toHaveBeenCalled();
    });

    it('falls back to saved HTML when there is no live editor at all', async () => {
        // No editor instances. Helper should return saved HTML without
        // running any retry sleeps (closed-note common case).
        setEditors([]);
        const item = makeItem({ id: 1, getNote: () => '<p>only saved</p>' });

        const promise = getNoteHtmlForRead(item);
        // Don't advance any timers — promise must resolve immediately.
        const result = await promise;
        expect(result).toBe('<p>only saved</p>');
    });

    it('closed-note read pays NO retry latency (regression: P3)', async () => {
        // Regression guard for the closed-note latency bug: when there are no
        // live editor instances, retries cannot recover anything (there's no
        // PM to wait on). The helper must return the saved HTML immediately
        // instead of burning ~150ms on three 50ms timers.
        setEditors([]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved</p>' });

        const promise = getNoteHtmlForRead(item);
        // Resolve the microtask queue without advancing any fake timers.
        // If the helper waited on setTimeout this would never resolve.
        await Promise.resolve();
        const result = await Promise.race([
            promise,
            new Promise<string>((_, reject) =>
                queueMicrotask(() => reject(new Error('helper waited on timer'))),
            ),
        ]);
        expect(result).toBe('<p>saved</p>');
    });

    it('abandons retry loop early if every live editor closes during the retry window', async () => {
        // Start with one empty live editor so the retry loop is entered.
        // After the first 50ms tick, all editors are gone — the loop must
        // bail out immediately rather than burn the remaining 100ms on
        // candidates that no longer exist.
        const liveInstance = makeInstance({ html: '', itemId: 1 });
        setEditors([liveInstance]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved fallback</p>' });

        const promise = getNoteHtmlForRead(item);
        // Tear down editors right before the first retry tick fires.
        setEditors([]);
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toBe('<p>saved fallback</p>');
    });
});

// =============================================================================
// getLatestNoteHtml regression
// =============================================================================
//
// Refactored alongside the new helpers — pin its existing preference behavior
// so the extraction of collectLiveCandidates / orderLiveCandidates didn't drift.

describe('getLatestNoteHtml regression', () => {
    it('returns saved HTML when no live editor exists', () => {
        setEditors([]);
        const item = makeItem({ id: 1, getNote: () => '<p>saved</p>' });
        expect(getLatestNoteHtml(item)).toBe('<p>saved</p>');
    });

    it('returns the only candidate when exactly one is connected', () => {
        setEditors([makeInstance({ html: '<p>only</p>', itemId: 1 })]);
        expect(getLatestNoteHtml(makeItem({ id: 1 }))).toBe('<p>only</p>');
    });

    it('prefers the candidate matching the selected tab when multiple are open', () => {
        setEditors(
            [
                makeInstance({ html: '<p>other</p>', itemId: 1 }),
                makeInstance({ html: '<p>selected</p>', itemId: 1, tabId: 'tab-X' }),
            ],
            'tab-X',
        );
        expect(getLatestNoteHtml(makeItem({ id: 1, getNote: () => '' }))).toBe('<p>selected</p>');
    });
});
