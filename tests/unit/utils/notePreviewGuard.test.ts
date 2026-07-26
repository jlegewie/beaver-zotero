/**
 * Unit tests for notePreviewGuard.ts — last-chance safety net that refuses
 * to save note HTML containing diff-preview markers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import {
    containsPreviewMarkers,
    assertNoPreviewMarkers,
    stripPreviewMarkers,
} from '../../../src/utils/notePreviewGuard';
import { logger } from '../../../src/utils/logger';

const CLEAN_NOTES = [
    '<div data-schema-version="9"><p>Hello world.</p></div>',
    '<div data-schema-version="9"><h1>Title</h1><p>Paragraph with <strong>bold</strong> text.</p></div>',
    '<div data-schema-version="9"><ul><li>one</li><li>two</li></ul></div>',
    '<div data-schema-version="9"><p><span class="citation" data-citation="%7B%7D">(Smith 2020)</span></p></div>',
    // Other colored spans that are not diff markers — e.g. a highlight.
    '<div data-schema-version="9"><p><span style="background-color:rgba(255,235,59,0.4)">highlight</span></p></div>',
    '',
];

describe('notePreviewGuard', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    describe('containsPreviewMarkers', () => {
        it('returns false for empty input', () => {
            expect(containsPreviewMarkers('')).toBe(false);
        });

        it('returns false for plain note HTML', () => {
            for (const html of CLEAN_NOTES) {
                expect(containsPreviewMarkers(html)).toBe(false);
            }
        });

        it('detects the preview banner id', () => {
            const html = '<div id="beaver-preview-banner"><span>Preview of Note Edits</span></div><p>body</p>';
            expect(containsPreviewMarkers(html)).toBe(true);
        });

        it('detects the preview banner id with single quotes', () => {
            const html = "<div id='beaver-preview-banner'></div>";
            expect(containsPreviewMarkers(html)).toBe(true);
        });

        it('detects the preview style tag id', () => {
            const html = '<style id="beaver-diff-preview-style">.foo{}</style><p>body</p>';
            expect(containsPreviewMarkers(html)).toBe(true);
        });

        it('detects the deletion rgba signature (unspaced source form)', () => {
            const html = '<p><span style="background-color:rgba(210,40,40,0.28);text-decoration:line-through">removed</span></p>';
            expect(containsPreviewMarkers(html)).toBe(true);
        });

        it('detects the deletion rgba signature (browser-normalized spaced form)', () => {
            const html = '<p><span style="background-color: rgba(210, 40, 40, 0.28); text-decoration: line-through">removed</span></p>';
            expect(containsPreviewMarkers(html)).toBe(true);
        });

        it('detects the addition rgba signature (unspaced source form)', () => {
            const html = '<p><span style="background-color:rgba(16,150,72,0.28)">added</span></p>';
            expect(containsPreviewMarkers(html)).toBe(true);
        });

        it('detects the addition rgba signature (browser-normalized spaced form)', () => {
            const html = '<p><span style="background-color: rgba(16, 150, 72, 0.28)">added</span></p>';
            expect(containsPreviewMarkers(html)).toBe(true);
        });
    });

    describe('assertNoPreviewMarkers', () => {
        it('is a no-op for clean HTML', () => {
            for (const html of CLEAN_NOTES) {
                expect(() => assertNoPreviewMarkers(html, 'test')).not.toThrow();
            }
            expect(logger).not.toHaveBeenCalled();
        });

        it('throws and logs when the banner is present', () => {
            const html = '<div id="beaver-preview-banner"></div>';
            expect(() => assertNoPreviewMarkers(html, 'editNote:rewrite:apply'))
                .toThrow(/refusing to save note containing diff-preview markers \(editNote:rewrite:apply\)/);
            expect(logger).toHaveBeenCalledOnce();
            expect((logger as any).mock.calls[0][0]).toContain('editNote:rewrite:apply');
        });

        it('throws when a deletion diff span is present', () => {
            const html = '<p><span style="background-color: rgba(210, 40, 40, 0.28)">x</span></p>';
            expect(() => assertNoPreviewMarkers(html, 'flushLiveEditorToDB')).toThrow();
        });

        it('throws when an addition diff span is present', () => {
            const html = '<p><span style="background-color:rgba(16,150,72,0.28)">y</span></p>';
            expect(() => assertNoPreviewMarkers(html, 'flushLiveEditorToDB')).toThrow();
        });

        it('throws when the preview style block is present', () => {
            const html = '<style id="beaver-diff-preview-style">.x{}</style>';
            expect(() => assertNoPreviewMarkers(html, 'ctx')).toThrow();
        });

        it('includes the context label in the thrown message', () => {
            const html = '<div id="beaver-preview-banner"></div>';
            try {
                assertNoPreviewMarkers(html, 'my-custom-label');
                throw new Error('should have thrown');
            } catch (e: any) {
                expect(e.message).toContain('my-custom-label');
            }
        });
    });

    describe('stripPreviewMarkers', () => {
        it('returns clean HTML unchanged (same reference)', () => {
            for (const html of CLEAN_NOTES) {
                expect(stripPreviewMarkers(html)).toBe(html);
            }
        });

        it('removes the banner element with its content', () => {
            const html = '<div id="beaver-preview-banner"><span class="banner-title">Preview of Note Edits</span><button>Apply</button></div><p>body</p>';
            expect(stripPreviewMarkers(html)).toBe('<p>body</p>');
        });

        it('removes the preview style element with its content', () => {
            const html = '<style id="beaver-diff-preview-style">.beaver-preview-banner { background: rgba(16,150,72,0.32); }</style><p>body</p>';
            expect(stripPreviewMarkers(html)).toBe('<p>body</p>');
        });

        it('unwraps deletion spans, keeping the original text', () => {
            const html = '<p>before <span style="background-color:rgba(210,40,40,0.28);text-decoration:line-through;border-radius:2px;padding:0 1px">old text</span> after</p>';
            expect(stripPreviewMarkers(html)).toBe('<p>before old text after</p>');
        });

        it('removes addition spans together with their text', () => {
            const html = '<p>before <span style="background-color:rgba(16,150,72,0.28);border-radius:2px;padding:0 1px">proposed text</span> after</p>';
            expect(stripPreviewMarkers(html)).toBe('<p>before  after</p>');
        });

        it('restores the pre-preview content of a full str_replace diff', () => {
            const html = '<div data-schema-version="9"><p>The '
                + '<span style="background-color:rgba(210,40,40,0.28);text-decoration:line-through;border-radius:2px;padding:0 1px">quick</span>'
                + '<span style="background-color:rgba(16,150,72,0.28);border-radius:2px;padding:0 1px">fast</span>'
                + ' brown fox.</p></div>';
            expect(stripPreviewMarkers(html)).toBe('<div data-schema-version="9"><p>The quick brown fox.</p></div>');
        });

        it('handles the browser/ProseMirror-normalized spaced rgba form', () => {
            const html = '<p><span style="background-color: rgba(210, 40, 40, 0.28); text-decoration: line-through">kept</span>'
                + '<span style="background-color: rgba(16, 150, 72, 0.28)">dropped</span></p>';
            expect(stripPreviewMarkers(html)).toBe('<p>kept</p>');
        });

        it('handles marker spans spread across interleaved tags', () => {
            // wrapTextNodesWithStyle wraps each text run separately, leaving
            // structural tags between the marker spans.
            const html = '<p><span style="background-color:rgba(210,40,40,0.28);text-decoration:line-through">a </span>'
                + '<strong><span style="background-color:rgba(210,40,40,0.28);text-decoration:line-through">bold</span></strong>'
                + '<span style="background-color:rgba(16,150,72,0.28)">b </span>'
                + '<em><span style="background-color:rgba(16,150,72,0.28)">it</span></em></p>';
            expect(stripPreviewMarkers(html)).toBe('<p>a <strong>bold</strong><em></em></p>');
        });

        it('handles nested inline markup inside marker spans', () => {
            const html = '<p><span style="background-color: rgba(210, 40, 40, 0.28)">old <span style="color: red">colored</span> text</span>'
                + '<span style="background-color: rgba(16, 150, 72, 0.28)">new <span style="color: blue">colored</span> text</span></p>';
            expect(stripPreviewMarkers(html)).toBe('<p>old <span style="color: red">colored</span> text</p>');
        });

        it('leaves non-marker colored spans untouched', () => {
            const html = '<p><span style="background-color:rgba(255,235,59,0.4)">highlight</span></p>';
            expect(stripPreviewMarkers(html)).toBe(html);
        });

        it('produces output that passes the write-side guard', () => {
            const html = '<div id="beaver-preview-banner"><button>Apply</button></div>'
                + '<style id="beaver-diff-preview-style">.x { color: rgba(210,40,40,0.28); }</style>'
                + '<div data-schema-version="9"><p>'
                + '<span style="background-color:rgba(210,40,40,0.28);text-decoration:line-through">old</span>'
                + '<span style="background-color:rgba(16,150,72,0.28)">new</span>'
                + '</p></div>';
            const stripped = stripPreviewMarkers(html);
            expect(containsPreviewMarkers(stripped)).toBe(false);
            expect(() => assertNoPreviewMarkers(stripped, 'test')).not.toThrow();
            expect(stripped).toContain('<p>old</p>');
        });

        it('drops an unbalanced marker open tag without losing following content', () => {
            const html = '<p><span style="background-color:rgba(210,40,40,0.28)">unclosed text</p>';
            expect(stripPreviewMarkers(html)).toBe('<p>unclosed text</p>');
        });

        // The persisted corruption is ProseMirror's re-serialization, not the
        // injected source form: the deletion style splits into a strike mark
        // and a backgroundColor mark, serialized as nested spans with the
        // line-through OUTSIDE the background span (schema mark order), and
        // border-radius/padding are dropped.
        describe('ProseMirror-serialized (persisted) corruption shape', () => {
            const PM_DEL = (text: string) =>
                `<span style="text-decoration: line-through"><span style="background-color: rgba(210, 40, 40, 0.28)">${text}</span></span>`;
            const PM_ADD = (text: string) =>
                `<span style="background-color: rgba(16, 150, 72, 0.28)">${text}</span>`;

            it('recovers a str_replace diff without leaving strikethrough remnants', () => {
                const html = `<div data-schema-version="9"><p>The ${PM_DEL('quick')}${PM_ADD('fast')} brown fox.</p></div>`;
                expect(stripPreviewMarkers(html)).toBe('<div data-schema-version="9"><p>The quick brown fox.</p></div>');
            });

            it('recovers a rewrite diff (whole body struck through) to plain text', () => {
                const html = `<div data-schema-version="9">${PM_DEL('First para.')}${PM_DEL('Second para.')}${PM_ADD('Proposed body.')}</div>`;
                expect(stripPreviewMarkers(html)).toBe('<div data-schema-version="9">First para.Second para.</div>');
            });

            it('keeps a user strike span that does not wrap a deletion marker', () => {
                const html = `<p><span style="text-decoration: line-through">user struck</span> and ${PM_DEL('old')}</p>`;
                expect(stripPreviewMarkers(html)).toBe('<p><span style="text-decoration: line-through">user struck</span> and old</p>');
            });

            it('keeps a strike wrapper that contains more than the deletion span', () => {
                const html = `<p><span style="text-decoration: line-through">prefix ${PM_DEL('old')}</span></p>`;
                const stripped = stripPreviewMarkers(html);
                expect(stripped).toBe('<p><span style="text-decoration: line-through">prefix old</span></p>');
                expect(containsPreviewMarkers(stripped)).toBe(false);
            });

            it('output passes the write-side guard', () => {
                const html = `<div data-schema-version="9"><p>${PM_DEL('a')}${PM_ADD('b')} rest</p></div>`;
                const stripped = stripPreviewMarkers(html);
                expect(containsPreviewMarkers(stripped)).toBe(false);
                expect(() => assertNoPreviewMarkers(stripped, 'test')).not.toThrow();
            });
        });
    });
});
