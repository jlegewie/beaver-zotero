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
});
