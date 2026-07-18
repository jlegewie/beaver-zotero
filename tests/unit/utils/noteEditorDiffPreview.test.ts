import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => null) },
}));

vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../react/agents/agentActions', () => ({}));

// Partial mocks for the showDiffPreview flow tests: normalizeNoteHtml needs a
// DOM (identity is fine for already-normalized fixtures), and the preload
// helpers hit Zotero. Everything else (expandToRawHtml and countOccurrences)
// stays real so expansion behaves like production.
vi.mock('../../../src/utils/noteHtmlSimplifier', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/noteHtmlSimplifier')>(
        '../../../src/utils/noteHtmlSimplifier'
    );
    return {
        ...actual,
        normalizeNoteHtml: vi.fn((html: string) => html),
        getOrSimplify: vi.fn((_noteId: string, html: string) => ({
            simplified: html,
            metadata: { elements: new Map() },
            isStale: false,
        })),
    };
});

vi.mock('../../../src/utils/noteCitationExpand', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/noteCitationExpand')>(
        '../../../src/utils/noteCitationExpand'
    );
    return {
        ...actual,
        preloadNotePageLabels: vi.fn(async () => ({})),
        preloadPageLabelsForNewCitations: vi.fn(async () => ({})),
    };
});

import {
    constructMultiDiffHtml,
    hashPreviewContent,
    noteContentDriftedFromPreview,
    showDiffPreview,
    dismissDiffPreview,
    setOnBannerAction,
    isDiffPreviewPendingFor,
    isDiffPreviewPending,
} from '../../../react/utils/noteEditorDiffPreview';
import { preloadNotePageLabels } from '../../../src/utils/noteCitationExpand';

describe('constructMultiDiffHtml', () => {
    it('renders multiple append edits at the append point in edit order', () => {
        const footer = '<p><span style="color: #aaa;"><strong>Created by Beaver</strong> \u00b7 <a href="zotero://beaver/thread/t0/run/r0">Open Message</a></span></p>';
        const html = `<div data-schema-version="9"><p>Existing</p>${footer}</div>`;
        const result = constructMultiDiffHtml(html, [
            { expandedOld: '', expandedNew: '<p>First append</p>', operation: 'append' },
            { expandedOld: '', expandedNew: '<p>Second append</p>', operation: 'append' },
        ]);

        expect(result).not.toBeNull();
        const firstIndex = result!.indexOf('First append');
        const secondIndex = result!.indexOf('Second append');
        expect(firstIndex).toBeGreaterThan(result!.indexOf('Existing'));
        expect(secondIndex).toBeGreaterThan(firstIndex);
        expect(secondIndex).toBeLessThan(result!.indexOf('Created by Beaver'));
        expect(result!.indexOf('</div>')).toBeGreaterThan(secondIndex);
    });

    it('uses target anchors to preview the disambiguated repeated occurrence', () => {
        const html = '<div><p>Repeat</p><p>Middle</p><p>Repeat</p></div>';
        const secondStart = html.lastIndexOf('Repeat');
        const result = constructMultiDiffHtml(html, [{
            expandedOld: 'Repeat',
            expandedNew: 'Changed',
            operation: 'str_replace',
            targetBeforeContext: html.substring(0, secondStart),
            targetAfterContext: html.substring(secondStart + 'Repeat'.length),
        }]);

        expect(result).not.toBeNull();
        expect(result).toContain('<p>Repeat</p><p>Middle</p>');
        expect(result!.indexOf('Changed')).toBeGreaterThan(result!.indexOf('Middle'));
    });

    it('does not fall back to the first occurrence when target anchors are stale', () => {
        const html = '<div><p>Repeat</p><p>Repeat</p></div>';
        const result = constructMultiDiffHtml(html, [{
            expandedOld: 'Repeat',
            expandedNew: 'Changed',
            operation: 'str_replace',
            targetBeforeContext: '<p>missing context</p>',
            targetAfterContext: '<p>also missing</p>',
        }]);

        expect(result).toBeNull();
    });

    it('previews the surviving occurrence when the validated occurrence was removed', () => {
        // Validation disambiguated between two identical occurrences and
        // anchored the SECOND one; the note then lost that occurrence. The
        // survivor is now the unique match — which is exactly where execute
        // would apply (matchCount === 1 short-circuits before anchors in
        // resolveSingleTarget), so the preview must show it there rather
        // than suppress the preview and let the user approve blind.
        const originalHtml = '<div><p>Repeat</p><p>Middle</p><p>Repeat</p></div>';
        const secondStart = originalHtml.lastIndexOf('Repeat');
        const driftedHtml = '<div><p>Repeat</p><p>Middle</p><p>Changed already</p></div>';
        const result = constructMultiDiffHtml(driftedHtml, [{
            expandedOld: 'Repeat',
            expandedNew: 'Changed',
            operation: 'str_replace',
            // Anchors captured against the ORIGINAL note's second occurrence.
            targetBeforeContext: originalHtml.substring(0, secondStart),
            targetAfterContext: originalHtml.substring(secondStart + 'Repeat'.length),
        }]);

        expect(result).not.toBeNull();
        expect(result).toContain('Changed');
        // The preview lands on the surviving first occurrence.
        expect(result!.indexOf('Changed')).toBeLessThan(result!.indexOf('Middle'));
    });

    it('treats a self-overlapping needle as unique, matching executor counting', () => {
        // "aa" occurs once in "aaa" by the executor's advance-by-length
        // counting (countOccurrences); the fallback must agree or the
        // preview suppresses an edit the executor happily applies.
        const html = '<div><p>aaa</p></div>';
        const result = constructMultiDiffHtml(html, [{
            expandedOld: 'aa',
            expandedNew: 'bb',
            operation: 'str_replace',
            targetBeforeContext: '<p>missing context</p>',
            targetAfterContext: '<p>also missing</p>',
        }]);

        expect(result).not.toBeNull();
        expect(result).toContain('bb');
    });

    it('previews the only occurrence when anchors are stale but old_string is unique', () => {
        // Apply → undo round-trips re-serialize the note, so validation-time
        // anchors routinely go stale; a unique target has no ambiguity for
        // the anchors to guard against and must still preview.
        const html = '<div><p>Alpha</p><p>Repeat</p><p>Omega</p></div>';
        const result = constructMultiDiffHtml(html, [{
            expandedOld: 'Repeat',
            expandedNew: 'Changed',
            operation: 'str_replace',
            targetBeforeContext: '<p>missing context</p>',
            targetAfterContext: '<p>also missing</p>',
        }]);

        expect(result).not.toBeNull();
        expect(result).toContain('Changed');
        expect(result!.indexOf('Alpha')).toBeLessThan(result!.indexOf('Changed'));
        expect(result!.indexOf('Changed')).toBeLessThan(result!.indexOf('Omega'));
    });
});

describe('preview revision guard', () => {
    it('hashPreviewContent is stable for identical content and differs on change', () => {
        const html = '<div data-schema-version="9"><p>Alpha content here.</p></div>';
        expect(hashPreviewContent(html)).toBe(hashPreviewContent(html));
        expect(hashPreviewContent(html)).not.toBe(hashPreviewContent(html + ' '));
        expect(hashPreviewContent(html)).not.toBe(
            hashPreviewContent(html.replace('Alpha', 'Beta')),
        );
    });

    it('detects drift when the stored note no longer matches the preview snapshot', () => {
        const previewedHtml = '<div><p>Original body</p></div>';
        // No editor instances registered → getLatestNoteHtml falls back to
        // the item's saved note, which is what the guard must compare.
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Items: { get: vi.fn(() => ({ getNote: () => '<div><p>Drifted body</p></div>' })) },
            Notes: {},
        };
        const snapshot = hashPreviewContent(previewedHtml);
        expect(noteContentDriftedFromPreview(1, snapshot)).toBe(true);
    });

    it('does not report drift when the stored note is unchanged', () => {
        const previewedHtml = '<div><p>Original body</p></div>';
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Items: { get: vi.fn(() => ({ getNote: () => previewedHtml })) },
            Notes: {},
        };
        const snapshot = hashPreviewContent(previewedHtml);
        expect(noteContentDriftedFromPreview(1, snapshot)).toBe(false);
    });

    it('never blocks on read failure (missing item)', () => {
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Items: { get: vi.fn(() => null) },
            Notes: {},
        };
        expect(noteContentDriftedFromPreview(1, 'anything')).toBe(false);
    });
});

describe('showDiffPreview approveAll revision-guard flow', () => {
    const NOTE = '<div data-schema-version="9"><p>Alpha paragraph body text.</p></div>';
    const EDITS = [{
        oldString: 'Alpha paragraph body text.',
        newString: 'Alpha paragraph CHANGED text.',
    }];

    function makeHarness(initialHtml: string, opts?: { liveHtml?: string; otherEditorHtml?: string }) {
        let noteHtml = initialHtml;
        let liveHtml = opts?.liveHtml;
        let otherHtml = opts?.otherEditorHtml;
        const viewDom = { querySelector: vi.fn(() => null), contentEditable: 'true' };
        const wrapped: any = {
            _currentEditorInstance: { _editorCore: { view: { dom: viewDom } } },
        };
        const iframeWindow: any = {
            wrappedJSObject: wrapped,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        const applyIncrementalUpdate = vi.fn();
        const inst: any = {
            itemID: 42,
            _viewMode: 'tab',
            _iframeWindow: iframeWindow,
            applyIncrementalUpdate,
            _disableSaving: false,
        };
        const item = {
            id: 42,
            getNote: vi.fn(() => noteHtml),
            loadDataType: vi.fn(async () => {}),
        };
        if (liveHtml !== undefined) {
            // Register the editor as a LIVE candidate for getLatestNoteHtml:
            // unsaved editor content that differs from the stored note.
            inst._item = item;
            iframeWindow.frameElement = { isConnected: true };
            wrapped.getDataSync = vi.fn(() => ({ html: liveHtml }));
        }
        const editorInstances: any[] = [inst];
        if (otherHtml !== undefined) {
            // A SECOND, non-preview editor (e.g. the note open in a separate
            // window) holding an unsaved snapshot. It stays a live candidate
            // while the preview editor is frozen, and execute's
            // flushLiveEditorToDB would promote its content.
            editorInstances.push({
                itemID: 42,
                _item: item,
                _viewMode: 'window',
                _iframeWindow: {
                    wrappedJSObject: {
                        getDataSync: vi.fn(() => ({ html: otherHtml })),
                        _currentEditorInstance: { _editorCore: { view: { dom: {} } } },
                    },
                    frameElement: { isConnected: true },
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                },
                applyIncrementalUpdate: vi.fn(),
                _disableSaving: false,
            });
        }
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Notes: { open: vi.fn(), _editorInstances: editorInstances },
            Items: {
                getIDFromLibraryAndKey: vi.fn(() => 42),
                getAsync: vi.fn(async () => item),
                get: vi.fn(() => item),
            },
        };
        return {
            wrapped,
            applyIncrementalUpdate,
            setNoteHtml: (h: string) => { noteHtml = h; },
            setOtherEditorHtml: (h: string) => { otherHtml = h; },
            /** Renders that injected diff markup (vs. plain restores). */
            diffRenderCount: () => applyIncrementalUpdate.mock.calls
                .filter((c: any[]) => String(c[0]?.html ?? '').includes('rgba(210,40,40')).length,
        };
    }

    afterEach(async () => {
        setOnBannerAction(null);
        try {
            const p = dismissDiffPreview();
            if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(2000);
            await p;
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-renders instead of dispatching approval when the note drifted after render', async () => {
        vi.useFakeTimers();
        const h = makeHarness(NOTE);
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        expect(h.diffRenderCount()).toBe(1);

        // Drift the STORED note while the preview is up (the previewed editor
        // itself is frozen — this models sync or another window), then click
        // the banner's Apply.
        h.setNoteHtml('<div data-schema-version="9"><p>Intro. Alpha paragraph body text.</p></div>');
        h.wrapped.__beaverPreviewAction = 'approveAll';

        await vi.advanceTimersByTimeAsync(250);   // poll tick → guard trips, dismiss starts
        expect(onBanner).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1600);  // dismiss settles (fallback timer) → re-show kicks off
        await vi.advanceTimersByTimeAsync(300);   // re-show async steps + scroll timer

        // Approval was never dispatched; a fresh preview rendered against the
        // drifted content instead.
        expect(onBanner).not.toHaveBeenCalled();
        expect(h.diffRenderCount()).toBe(2);
    });

    it('dispatches approval normally when the note is unchanged', async () => {
        vi.useFakeTimers();
        const h = makeHarness(NOTE);
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);

        expect(onBanner).toHaveBeenCalledWith('approveAll');
        expect(h.diffRenderCount()).toBe(1);
    });

    it('does not report drift for unsaved live-editor content (stored baseline)', async () => {
        vi.useFakeTimers();
        // The editor holds unsaved content that differs from the stored note;
        // the preview renders from the live snapshot, but the drift baseline
        // must be the STORED note or every Apply would bounce.
        const h = makeHarness(NOTE, {
            liveHtml: '<div data-schema-version="9"><p>Alpha paragraph body text. Unsaved tail.</p></div>',
        });
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);

        expect(onBanner).toHaveBeenCalledWith('approveAll');
        expect(h.diffRenderCount()).toBe(1);
    });

    it('cancels the deferred re-render when the preview is dismissed during the bounce', async () => {
        vi.useFakeTimers();
        const h = makeHarness(NOTE);
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.setNoteHtml('<div data-schema-version="9"><p>Intro. Alpha paragraph body text.</p></div>');
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);   // guard trips, dismissal in flight

        // The deferred re-render is visible as a pending show, so
        // approval-resolution paths can find and cancel it...
        expect(isDiffPreviewPendingFor(1, 'NOTE0001')).toBe(true);
        expect(isDiffPreviewPending()).toBe(true);
        // ...which is exactly what an approval being applied/rejected
        // elsewhere does via its isDiffPreviewPendingFor -> dismiss gate.
        void dismissDiffPreview();

        await vi.advanceTimersByTimeAsync(1600);
        await vi.advanceTimersByTimeAsync(300);

        // No resurrected preview, no dispatched approval, no pending show.
        expect(h.diffRenderCount()).toBe(1);
        expect(onBanner).not.toHaveBeenCalled();
        expect(isDiffPreviewPendingFor(1, 'NOTE0001')).toBe(false);
        expect(isDiffPreviewPending()).toBe(false);
    });

    it('detects drift that lands during the async preview setup (baseline captured with the snapshot)', async () => {
        vi.useFakeTimers();
        const h = makeHarness(NOTE);
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        // The stored note changes DURING showDiffPreview's awaited page-label
        // work — after the render snapshot was taken. The baseline must
        // reflect the snapshot-time content so the first Apply reads as
        // drift; hashing at activePreview creation would silently adopt the
        // newer content under a stale preview.
        vi.mocked(preloadNotePageLabels).mockImplementationOnce(async () => {
            h.setNoteHtml('<div data-schema-version="9"><p>Intro. Alpha paragraph body text.</p></div>');
            return {};
        });

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);   // guard must trip
        expect(onBanner).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1600);  // dismiss settles -> re-render
        await vi.advanceTimersByTimeAsync(300);

        expect(onBanner).not.toHaveBeenCalled();
        expect(h.diffRenderCount()).toBe(2);
    });

    it("treats another editor's unsaved changes during the preview as drift", async () => {
        vi.useFakeTimers();
        // Second editor starts in sync with the stored note, then edits it
        // (unsaved) while the preview is up. Execute would flush that
        // snapshot to the DB before matching, so it must count as drift.
        const h = makeHarness(NOTE, { otherEditorHtml: NOTE });
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.setOtherEditorHtml('<div data-schema-version="9"><p>Intro. Alpha paragraph body text.</p></div>');
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);
        expect(onBanner).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1600);
        await vi.advanceTimersByTimeAsync(300);
        expect(onBanner).not.toHaveBeenCalled();
        expect(h.diffRenderCount()).toBe(2);
    });

    it("does not bounce on another editor's STABLE unsaved snapshot", async () => {
        vi.useFakeTimers();
        // The other editor's divergent-but-unchanged snapshot is part of the
        // baseline (symmetric reads), so Apply must dispatch — no bounce loop
        // while the other editor simply has not autosaved yet.
        const divergent = '<div data-schema-version="9"><p>Alpha paragraph body text. Other tail.</p></div>';
        const h = makeHarness(NOTE, { otherEditorHtml: divergent });
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);

        expect(onBanner).toHaveBeenCalledWith('approveAll');
        expect(h.diffRenderCount()).toBe(1);
    });

    it('serializes a dismissal call behind the in-flight teardown of a bounce', async () => {
        vi.useFakeTimers();
        const h = makeHarness(NOTE);
        const onBanner = vi.fn();
        setOnBannerAction(onBanner);

        expect(await showDiffPreview(1, 'NOTE0001', EDITS)).toBe(true);
        h.setNoteHtml('<div data-schema-version="9"><p>Intro. Alpha paragraph body text.</p></div>');
        h.wrapped.__beaverPreviewAction = 'approveAll';
        await vi.advanceTimersByTimeAsync(250);   // guard trips; teardown restore in flight

        // An execute handler canceling the pending bounce awaits
        // dismissDiffPreview() before mutating the note. Even though no
        // preview is active in this window, the promise must NOT resolve
        // until the outstanding editor restore has settled — otherwise the
        // restore could later overwrite the freshly written editor state.
        let settled = false;
        void dismissDiffPreview().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1600);  // restore fallback settles
        expect(settled).toBe(true);
    });
});
