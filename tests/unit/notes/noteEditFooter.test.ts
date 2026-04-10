import { describe, it, expect } from 'vitest';
import {
    parseEditFooter,
    buildEditFooterHtml,
    addOrUpdateEditFooter,
    stripBeaverEditFooter,
    stripBeaverCreatedFooter,
} from '../../../src/utils/noteEditFooter';

const WRAPPER_START = '<div data-schema-version="9">';
const WRAPPER_END = '</div>';

function wrap(content: string): string {
    return `${WRAPPER_START}${content}${WRAPPER_END}`;
}

describe('parseEditFooter', () => {
    it('returns null when no edit footer exists', () => {
        const html = wrap('<p>Hello world</p>');
        expect(parseEditFooter(html)).toBeNull();
    });

    it('returns null when only "Created by Beaver" footer exists (old format)', () => {
        const html = wrap(
            '<p>Content</p>' +
                '<p><span style="color: #aaa;"><a href="zotero://beaver/thread/t1">Created by Beaver</a></span></p>',
        );
        expect(parseEditFooter(html)).toBeNull();
    });

    it('returns null when only "Created by Beaver" footer exists (new format)', () => {
        const html = wrap(
            '<p>Content</p>' +
                '<p><span style="color: #aaa;">Created by Beaver \u00b7 <a href="zotero://beaver/thread/t1">Chat</a></span></p>',
        );
        expect(parseEditFooter(html)).toBeNull();
    });

    it('parses single-thread edit footer', () => {
        const footer =
            '<p><span style="color: #aaa;">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/abc123">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + footer);
        const result = parseEditFooter(html);
        expect(result).not.toBeNull();
        expect(result!.threadIds).toEqual(['abc123']);
        expect(result!.footerHtml).toBe(footer);
    });

    it('parses multi-thread edit footer', () => {
        const footer =
            '<p><span style="color: #aaa;">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1">Chat 1</a> \u00b7 <a href="zotero://beaver/thread/t2">Chat 2</a></span></p>';
        const html = wrap('<p>Content</p>' + footer);
        const result = parseEditFooter(html);
        expect(result).not.toBeNull();
        expect(result!.threadIds).toEqual(['t1', 't2']);
    });

    it('parses PM-normalized edit footer (rgb color + rel attribute)', () => {
        const pmFooter =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/abc123" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + pmFooter);
        const result = parseEditFooter(html);
        expect(result).not.toBeNull();
        expect(result!.threadIds).toEqual(['abc123']);
        expect(result!.footerHtml).toBe(pmFooter);
    });

    it('ignores plain-text "Edited by Beaver" in user content', () => {
        const html = wrap('<p>The note was Edited by Beaver in 2024.</p>');
        expect(parseEditFooter(html)).toBeNull();
    });

    it('ignores "Edited by Beaver" inside a <pre> block', () => {
        const html = wrap(
            '<pre>Edited by Beaver script output</pre><p>Normal content</p>',
        );
        expect(parseEditFooter(html)).toBeNull();
    });
});

describe('buildEditFooterHtml', () => {
    it('returns empty string for empty array', () => {
        expect(buildEditFooterHtml([])).toBe('');
    });

    it('builds single-thread footer', () => {
        const html = buildEditFooterHtml(['thread-1']);
        expect(html).toContain('Edited by Beaver');
        expect(html).toContain('zotero://beaver/thread/thread-1');
        expect(html).toContain('Chat 1');
        expect(html).toContain('color: #aaa');
    });

    it('builds multi-thread footer with sequential numbering', () => {
        const html = buildEditFooterHtml(['t1', 't2', 't3']);
        expect(html).toContain('Chat 1');
        expect(html).toContain('Chat 2');
        expect(html).toContain('Chat 3');
        expect(html).toContain('zotero://beaver/thread/t1');
        expect(html).toContain('zotero://beaver/thread/t2');
        expect(html).toContain('zotero://beaver/thread/t3');
    });
});

describe('addOrUpdateEditFooter', () => {
    it('adds new footer before closing wrapper div', () => {
        const html = wrap('<p>Content</p>');
        const result = addOrUpdateEditFooter(html, 'thread-1');
        expect(result).toContain('Edited by Beaver');
        expect(result).toContain('zotero://beaver/thread/thread-1');
        // Footer should be before closing </div>
        expect(result.indexOf('Edited by Beaver')).toBeLessThan(
            result.lastIndexOf('</div>'),
        );
    });

    it('adds footer to HTML without wrapper div', () => {
        const html = '<p>No wrapper</p>';
        const result = addOrUpdateEditFooter(html, 'thread-1');
        expect(result).toContain('Edited by Beaver');
        expect(result).toContain('Chat 1');
    });

    it('skips duplicate when thread already linked', () => {
        const footer = buildEditFooterHtml(['thread-1']);
        const html = wrap('<p>Content</p>' + footer);
        const result = addOrUpdateEditFooter(html, 'thread-1');
        expect(result).toBe(html);
    });

    it('updates PM-normalized footer instead of adding a duplicate', () => {
        // Simulate what ProseMirror does to the footer after a save round-trip
        const pmFooter =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + pmFooter);
        const result = addOrUpdateEditFooter(html, 't2');
        expect(result).toContain('Chat 1');
        expect(result).toContain('Chat 2');
        expect(result).toContain('zotero://beaver/thread/t1');
        expect(result).toContain('zotero://beaver/thread/t2');
        const matches = result.match(/Edited by Beaver/g);
        expect(matches).toHaveLength(1);
    });

    it('detects duplicate in PM-normalized footer', () => {
        const pmFooter =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + pmFooter);
        const result = addOrUpdateEditFooter(html, 't1');
        // Should not add a second footer
        const matches = result.match(/Edited by Beaver/g);
        expect(matches).toHaveLength(1);
        const chatMatches = result.match(/Chat 1/g);
        expect(chatMatches).toHaveLength(1);
    });

    it('appends new thread link to existing footer', () => {
        const footer = buildEditFooterHtml(['t1']);
        const html = wrap('<p>Content</p>' + footer);
        const result = addOrUpdateEditFooter(html, 't2');
        expect(result).toContain('Chat 1');
        expect(result).toContain('Chat 2');
        expect(result).toContain('zotero://beaver/thread/t1');
        expect(result).toContain('zotero://beaver/thread/t2');
        // Should still have exactly one "Edited by Beaver"
        const matches = result.match(/Edited by Beaver/g);
        expect(matches).toHaveLength(1);
    });

    it('consolidates duplicate footers into one', () => {
        // Simulate the bug where PM normalization caused 3 separate footers
        const f1 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const f2 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t2" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const f3 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t3" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + f1 + f2 + f3);
        const result = addOrUpdateEditFooter(html, 't4');
        // All four threads consolidated into one footer
        const matches = result.match(/Edited by Beaver/g);
        expect(matches).toHaveLength(1);
        expect(result).toContain('zotero://beaver/thread/t1');
        expect(result).toContain('zotero://beaver/thread/t2');
        expect(result).toContain('zotero://beaver/thread/t3');
        expect(result).toContain('zotero://beaver/thread/t4');
        expect(result).toContain('Chat 1');
        expect(result).toContain('Chat 4');
    });

    it('consolidates duplicate footers even when thread already tracked', () => {
        const f1 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const f2 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t2" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + f1 + f2);
        const result = addOrUpdateEditFooter(html, 't1');
        // Should consolidate into one footer with both threads
        const matches = result.match(/Edited by Beaver/g);
        expect(matches).toHaveLength(1);
        expect(result).toContain('zotero://beaver/thread/t1');
        expect(result).toContain('zotero://beaver/thread/t2');
    });

    it('works alongside "Created by Beaver" footer (new format)', () => {
        const createdFooter =
            '<p><span style="color: #aaa;">Created by Beaver \u00b7 <a href="zotero://beaver/thread/t0/run/r0">Chat</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = addOrUpdateEditFooter(html, 'thread-1');
        expect(result).toContain('Created by Beaver');
        expect(result).toContain('Edited by Beaver');
        expect(result.indexOf('Edited by Beaver')).toBeGreaterThan(
            result.indexOf('Created by Beaver'),
        );
    });

    it('works alongside "Created by Beaver" footer (old format)', () => {
        const createdFooter =
            '<p><span style="color: #aaa;"><a href="zotero://beaver/thread/t0/run/r0">Created by Beaver</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = addOrUpdateEditFooter(html, 'thread-1');
        expect(result).toContain('Created by Beaver');
        expect(result).toContain('Edited by Beaver');
        expect(result.indexOf('Edited by Beaver')).toBeGreaterThan(
            result.indexOf('Created by Beaver'),
        );
    });

    it('accumulates three threads correctly', () => {
        let html = wrap('<p>Content</p>');
        html = addOrUpdateEditFooter(html, 'a');
        html = addOrUpdateEditFooter(html, 'b');
        html = addOrUpdateEditFooter(html, 'c');
        expect(html).toContain('Chat 1');
        expect(html).toContain('Chat 2');
        expect(html).toContain('Chat 3');
        const matches = html.match(/Edited by Beaver/g);
        expect(matches).toHaveLength(1);
    });
});

describe('stripBeaverEditFooter', () => {
    it('returns HTML unchanged when no edit footer exists', () => {
        const html = wrap('<p>Content</p>');
        expect(stripBeaverEditFooter(html)).toBe(html);
    });

    it('strips the edit footer completely', () => {
        const footer = buildEditFooterHtml(['t1', 't2']);
        const html = wrap('<p>Content</p>' + footer);
        const result = stripBeaverEditFooter(html);
        expect(result).not.toContain('Edited by Beaver');
        expect(result).toContain('<p>Content</p>');
        expect(result).toContain(WRAPPER_START);
        expect(result).toContain(WRAPPER_END);
    });

    it('preserves "Created by Beaver" footer when stripping edit footer', () => {
        const createdFooter =
            '<p><span style="color: #aaa;">Created by Beaver \u00b7 <a href="zotero://beaver/thread/t0">Chat</a></span></p>';
        const editFooter = buildEditFooterHtml(['t1']);
        const html = wrap('<p>Content</p>' + createdFooter + editFooter);
        const result = stripBeaverEditFooter(html);
        expect(result).toContain('Created by Beaver');
        expect(result).not.toContain('Edited by Beaver');
    });

    it('strips all duplicate edit footers', () => {
        const f1 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const f2 =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t2" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + f1 + f2);
        const result = stripBeaverEditFooter(html);
        expect(result).not.toContain('Edited by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips PM-normalized edit footer', () => {
        const pmFooter =
            '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver \u00b7 <a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const html = wrap('<p>Content</p>' + pmFooter);
        const result = stripBeaverEditFooter(html);
        expect(result).not.toContain('Edited by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('does not strip user content containing "Edited by Beaver"', () => {
        const html = wrap(
            '<p>The note was Edited by Beaver in 2024.</p><p>More content</p>',
        );
        const result = stripBeaverEditFooter(html);
        expect(result).toBe(html);
    });
});

describe('stripBeaverCreatedFooter', () => {
    it('returns HTML unchanged when no created footer exists', () => {
        const html = wrap('<p>Content</p>');
        expect(stripBeaverCreatedFooter(html)).toBe(html);
    });

    it('strips old-format created footer (entire text as link)', () => {
        const createdFooter =
            '<p><span style="color: #aaa;"><a href="zotero://beaver/thread/t0">Created by Beaver</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips old-format created footer with run ID in URL', () => {
        const createdFooter =
            '<p><span style="color: #aaa;"><a href="zotero://beaver/thread/t0/run/r0">Created by Beaver</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
    });

    it('strips new-format created footer (gray prefix + Chat link)', () => {
        const createdFooter =
            '<p><span style="color: #aaa;">Created by Beaver \u00b7 <a href="zotero://beaver/thread/t0/run/r0">Chat</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips Beaver current created footer (single span + strong + Open Message link)', () => {
        const createdFooter =
            '<p><span style="color: #aaa;"><strong>Created by Beaver</strong> \u00b7 <a href="zotero://beaver/thread/t0/run/r0">Open Message</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips Beaver current created footer without run ID (single span + strong + Open Chat link)', () => {
        const createdFooter =
            '<p><span style="color: #aaa;"><strong>Created by Beaver</strong> \u00b7 <a href="zotero://beaver/thread/t0">Open Chat</a></span></p>';
        const html = wrap('<p>Content</p>' + createdFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips PM-normalized old-format created footer', () => {
        const pmCreatedFooter =
            '<p><span style="color: rgb(170, 170, 170);"><a href="zotero://beaver/thread/t0" rel="noopener noreferrer nofollow">Created by Beaver</a></span></p>';
        const html = wrap('<p>Content</p>' + pmCreatedFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips PM-normalized new-format created footer', () => {
        const pmCreatedFooter =
            '<p><span style="color: rgb(170, 170, 170);">Created by Beaver \u00b7 <a href="zotero://beaver/thread/t0/run/r0" rel="noopener noreferrer nofollow">Chat</a></span></p>';
        const html = wrap('<p>Content</p>' + pmCreatedFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('strips PM-normalized footer where <strong> moved outside <span>', () => {
        // Regression: after save round-trips, PM reorders marks so that
        // <span><strong>…</strong></span> becomes
        // <strong><span>…</span></strong>, and splits the styled span into
        // siblings. The pre-fix regex anchored on <p><span and missed this
        // shape, leaking the footer into the simplified view and confusing
        // edit_note when the agent targeted content around it.
        const pmCreatedFooter =
            '<p><strong><span style="color: rgb(170, 170, 170);">Created by Beaver</span></strong><span style="color: rgb(170, 170, 170);"> \u00b7 <a href="zotero://beaver/thread/t0/run/r0" rel="noopener noreferrer nofollow">Open Message</a></span></p>';
        const html = wrap('<p>Content</p>' + pmCreatedFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('<p>Content</p>');
    });

    it('does not strip ordinary user paragraphs that mention footer markers', () => {
        const html = wrap(
            '<p>I mention Created by Beaver here and link <a href="zotero://beaver/thread/t0">this thread</a> for context.</p>',
        );
        expect(stripBeaverCreatedFooter(html)).toBe(html);
    });

    it('does not strip partially styled user paragraphs that resemble the footer', () => {
        const html = wrap(
            '<p><span style="color:#aaa">Created by Beaver</span> \u00b7 <a href="zotero://beaver/thread/t0">Chat</a></p>',
        );
        expect(stripBeaverCreatedFooter(html)).toBe(html);
    });

    it('does not strip split-span user paragraphs without Beaver\'s reordered markup', () => {
        const html = wrap(
            '<p><span style="color:#aaa">Created by Beaver</span><span style="color:#aaa"> \u00b7 <a href="zotero://beaver/thread/t0">Chat</a></span></p>',
        );
        expect(stripBeaverCreatedFooter(html)).toBe(html);
    });

    it('does not strip split-span user paragraphs with different colors', () => {
        const html = wrap(
            '<p><span style="color:#aaa">Created by Beaver</span><span style="color:#f00"> \u00b7 <a href="zotero://beaver/thread/t0">Chat</a></span></p>',
        );
        expect(stripBeaverCreatedFooter(html)).toBe(html);
    });

    it('preserves ordinary paragraphs and strips the real footer later in the note', () => {
        const userParagraph =
            '<p>I mention Created by Beaver here and link <a href="zotero://beaver/thread/t0">this thread</a> for context.</p>';
        const pmCreatedFooter =
            '<p><strong><span style="color: rgb(170, 170, 170);">Created by Beaver</span></strong><span style="color: rgb(170, 170, 170);"> \u00b7 <a href="zotero://beaver/thread/t0/run/r0" rel="noopener noreferrer nofollow">Open Message</a></span></p>';
        const html = wrap(`${userParagraph}<p>Content</p>${pmCreatedFooter}`);
        const result = stripBeaverCreatedFooter(html);
        expect(result).toContain(userParagraph);
        expect(result).toContain('<p>Content</p>');
        expect(result).not.toContain(pmCreatedFooter);
    });

    it('preserves edit footer when stripping created footer', () => {
        const createdFooter =
            '<p><span style="color: #aaa;">Created by Beaver \u00b7 <a href="zotero://beaver/thread/t0">Chat</a></span></p>';
        const editFooter = buildEditFooterHtml(['t1']);
        const html = wrap('<p>Content</p>' + createdFooter + editFooter);
        const result = stripBeaverCreatedFooter(html);
        expect(result).not.toContain('Created by Beaver');
        expect(result).toContain('Edited by Beaver');
    });
});
