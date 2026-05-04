import { describe, it, expect, vi } from 'vitest';

// =============================================================================
// Regression test for the "Created by Beaver" / "Edited by Beaver" footer
// leaking into read_note output.
//
// Root cause discovered live in Zotero (note 1-8KNLQSLD on 2026-04-11):
// Zotero's chrome HTMLDocument (created via
// `document.implementation.createHTMLDocument('')` inside
// `src/prosemirror/dom.ts`) silently DROPS `href` attributes whose scheme is
// `zotero://` when parsing via innerHTML. After normalize:
//   <a href="zotero://beaver/thread/...">Open Message</a>
// becomes
//   <a rel="noopener noreferrer nofollow">Open Message</a>
// ProseMirror's link mark requires `tag: 'a[href]'`, so the link is dropped
// entirely on re-serialization, leaving bare text "Open Message". The four
// footer-strip regexes in `src/utils/noteEditFooter.ts` all require
// `<a href="zotero://beaver/thread/...">` to be present, so none match the
// post-normalize shape — the footer leaks into the simplified view that the
// agent sees and edits.
//
// Vitest's jsdom does NOT replicate the chrome href stripping, so this
// test mocks `normalizeNoteHtml` to simulate it. The test would pass under
// the OLD implementation (strip after normalize) only because jsdom preserves
// the link — under the real chrome runtime it failed. With the simulated
// mock the OLD implementation fails (footer leaks), and the FIXED
// implementation (strip before normalize) passes.
// =============================================================================

// Mock transitive deps pulled in by noteHtmlSimplifier.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: '1', localUserKey: 'test' })),
}));

// Simulate Zotero chrome HTMLDocument: strip `zotero://` hrefs from <a> tags
// during normalization. Everything else passes through unchanged so the rest
// of the simplifier behaves as it would on raw input.
vi.mock('../../../src/prosemirror/normalize', () => ({
    normalizeNoteHtml: vi.fn((html: string) => {
        // Match `<a ... href="zotero://...">CONTENT</a>` and replace with just CONTENT.
        // Mirrors the post-PM-roundtrip shape: chrome drops href, PM drops <a>.
        return html.replace(
            /<a\b[^>]*href="zotero:\/\/[^"]*"[^>]*>([^<]*)<\/a>/g,
            '$1',
        );
    }),
}));

import { simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';

const WRAPPER_START = '<div data-schema-version="9">';
const WRAPPER_END = '</div>';

function wrap(inner: string): string {
    return `${WRAPPER_START}${inner}${WRAPPER_END}`;
}

describe('simplifyNoteHtml — footer stripping survives chrome href stripping', () => {
    it('strips "Created by Beaver" footer even when normalize drops the zotero:// link', () => {
        // Exact shape produced by `getBeaverNoteFooterHTML` after a save round-trip:
        // <strong> moved outside <span> by ProseMirror, color normalized to rgb().
        // This is what was found in the live Zotero note (1-8KNLQSLD).
        const createdFooter =
            '<p><strong><span style="color: rgb(170, 170, 170);">Created by Beaver</span></strong>'
            + '<span style="color: rgb(170, 170, 170);"> \u00b7 '
            + '<a href="zotero://beaver/thread/e09afff0-fe9d-4b69-bb5c-cb181a202d26/run/1123ee84-c39a-4450-a9f3-5529df1aefa1" rel="noopener noreferrer nofollow">Open Message</a>'
            + '</span></p>';
        const rawHtml = wrap('<p>Body content</p>' + createdFooter);

        const { simplified } = simplifyNoteHtml(rawHtml, 1);

        expect(simplified).toContain('Body content');
        expect(simplified).not.toContain('Created by Beaver');
        expect(simplified).not.toContain('Open Message');
    });

    it('strips the freshly-emitted "Created by Beaver" footer (pre-PM-roundtrip shape)', () => {
        // Exact shape `getBeaverNoteFooterHTML(threadId, runId)` writes initially,
        // before any save round-trip: <span> wraps <strong>, color is `#aaa;`.
        const createdFooter =
            '<p><span style="color: #aaa;"><strong>Created by Beaver</strong> \u00b7 '
            + '<a href="zotero://beaver/thread/abc/run/xyz">Open Message</a>'
            + '</span></p>';
        const rawHtml = wrap('<p>Body content</p>' + createdFooter);

        const { simplified } = simplifyNoteHtml(rawHtml, 1);

        expect(simplified).toContain('Body content');
        expect(simplified).not.toContain('Created by Beaver');
    });

    it('strips "Edited by Beaver" footer even when normalize drops the zotero:// links', () => {
        // Exact shape produced by `buildEditFooterHtml(['t1', 't2'])`.
        const editFooter =
            '<p><span style="color: #aaa;">Edited by Beaver \u00b7 '
            + '<a href="zotero://beaver/thread/t1">Chat 1</a> \u00b7 '
            + '<a href="zotero://beaver/thread/t2">Chat 2</a>'
            + '</span></p>';
        const rawHtml = wrap('<p>Body content</p>' + editFooter);

        const { simplified } = simplifyNoteHtml(rawHtml, 1);

        expect(simplified).toContain('Body content');
        expect(simplified).not.toContain('Edited by Beaver');
    });

    it('strips both footers when present together', () => {
        const createdFooter =
            '<p><strong><span style="color: rgb(170, 170, 170);">Created by Beaver</span></strong>'
            + '<span style="color: rgb(170, 170, 170);"> \u00b7 '
            + '<a href="zotero://beaver/thread/t0/run/r0" rel="noopener noreferrer nofollow">Open Message</a>'
            + '</span></p>';
        const editFooter =
            '<p><span style="color: #aaa;">Edited by Beaver \u00b7 '
            + '<a href="zotero://beaver/thread/t1">Chat 1</a></span></p>';
        const rawHtml = wrap('<p>Body content</p>' + createdFooter + editFooter);

        const { simplified } = simplifyNoteHtml(rawHtml, 1);

        expect(simplified).toContain('Body content');
        expect(simplified).not.toContain('Created by Beaver');
        expect(simplified).not.toContain('Edited by Beaver');
    });

    it('preserves user content that incidentally mentions "Created by Beaver"', () => {
        const userText =
            '<p>I mention Created by Beaver here as part of normal content.</p>';
        const rawHtml = wrap(userText + '<p>More content</p>');

        const { simplified } = simplifyNoteHtml(rawHtml, 1);

        expect(simplified).toContain('Created by Beaver');
        expect(simplified).toContain('More content');
    });
});
