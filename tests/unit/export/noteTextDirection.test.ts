/**
 * Text direction of the notes Beaver writes. Zotero's note editor never
 * detects a direction: a note takes its reader's interface direction, except
 * for blocks with an explicit `dir`. A note with right-to-left text (or written
 * by a user who reads both directions) therefore gets a `dir` on every block
 * the note schema keeps one on, both ways. Any other note is written exactly as
 * before.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'test' })),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { codeRanges } from '@beaver/agent-export/parse/markdown';
import { renderNoteMarkdownHtml } from '@beaver/agent-export/render/noteHtml';
import type { TextDirectionOptions } from '@beaver/agent-export/render/textDirection';
import { renderNoteMarkdown } from '../../../src/services/export/noteMarkdown';
import { normalizeNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import pinnedRenders from './fixtures/noteMarkdownRender.json';

const PERSIAN = 'این پژوهش نشان می‌دهد که روش پیشنهادی دقیق‌تر است.';
const ARABIC = 'تظهر النتائج تحسنا ملحوظا في الأداء.';
const HEBREW = 'המחקר מראה שהשיטה המוצעת מדויקת יותר.';
const ENGLISH = 'The method is more accurate than the baseline.';

const RTL = { all: false };
const ALL = { all: true };

function render(content: string, textDirection?: TextDirectionOptions): string {
    return renderNoteMarkdown({ codeRanges, renderNoteMarkdownHtml }, content, textDirection);
}

/** Load and save in Zotero's note schema, as the note editor does. */
function roundTrip(html: string): string {
    return normalizeNoteHtml(`<div data-schema-version="9">${html}</div>`);
}

const ENGLISH_NOTE = [
    '<h1>Results</h1>',
    `${ENGLISH} With **bold**, \`code()\`, $x^2$ and a footnote[^1].`,
    '- first item\n- second item',
    '1. one\n2. two',
    '> a quote',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '```\ncode block\n```',
    '$$\n\\frac{a}{b}\n$$',
    'Arabic-Indic digits alone ١٢٣ are not letters.',
    '[^1]: The note.',
].join('\n\n');

describe('note text direction', () => {
    it('writes a note without right-to-left letters exactly as before', () => {
        expect(render(ENGLISH_NOTE, RTL)).toBe(render(ENGLISH_NOTE));
        expect(render(ENGLISH_NOTE, RTL)).not.toContain('dir=');
        for (const { markdown, html } of pinnedRenders as Array<{ markdown: string; html: string }>) {
            expect(render(markdown, RTL)).toBe(html);
        }
    });

    it('never directs a render without the option, which edit fragments use', () => {
        expect(render(`${PERSIAN}\n\n- ${ARABIC}`)).not.toContain('dir=');
    });

    it('directs Persian, Arabic and Hebrew paragraphs, headings and lists right to left', () => {
        for (const text of [PERSIAN, ARABIC, HEBREW]) {
            const html = render(`<h1>${text}</h1>\n\n${text}\n\n- ${text}\n- ${text}\n\n1. ${text}`, RTL);
            expect(html).toContain(`<h1 dir="rtl">${text}</h1>`);
            expect(html).toContain(`<p dir="rtl">${text}</p>`);
            expect(html).toContain('<ul dir="rtl">');
            expect(html).toContain('<ol dir="rtl">');
            expect(html).not.toContain('<li dir=');
        }
    });

    it('directs the English blocks of a note with right-to-left text left to right', () => {
        const html = render(`## ${PERSIAN}\n\n${ENGLISH}\n\n- an English item`, RTL);
        expect(html).toContain(`<h2 dir="rtl">${PERSIAN}</h2>`);
        expect(html).toContain(`<p dir="ltr">${ENGLISH}</p>`);
        expect(html).toContain('<ul dir="ltr">');
    });

    it('follows the majority of a block\'s letters', () => {
        expect(render(`Smith (2020) ${PERSIAN}`, RTL)).toContain('<p dir="rtl">Smith (2020)');
        expect(render('The term «استبداد» means tyranny in this context.', RTL)).toContain('<p dir="ltr">');
    });

    it('gives a block without letters the direction of the whole note', () => {
        const html = render(`${PERSIAN}\n\n2019–2021\n\n${ARABIC}`, RTL);
        expect(html).toContain('<p dir="rtl">2019–2021</p>');
    });

    it('keeps code blocks left to right, and leaves inline code and math as they are', () => {
        const html = render(`${PERSIAN} \`foo(bar)\` و $x^2$ و $شکل$\n\n\`\`\`\nconst a = 1;\n\`\`\`\n\n$$\nx^2\n$$`, RTL);
        expect(html).toContain('<pre dir="ltr"><code>const a = 1;');
        expect(html).toContain('<code>foo(bar)</code>');
        expect(html).toContain('<span class="math">$x^2$</span>');
        expect(html).toContain('<pre class="math">$$x^2$$</pre>');
    });

    it('does not let code, math or citations decide a direction', () => {
        expect(render(`\`someFunction()\` and $\\alpha + \\beta$ ${PERSIAN}`, RTL)).toContain('<p dir="rtl">');
        // Math alone with right-to-left letters does not direct an English note.
        expect(render(`${ENGLISH} $شکل$`, RTL)).not.toContain('dir=');
        expect(render(`${ENGLISH} <citation id="u-AAAA1111" label="کتاب"/>`, RTL)).not.toContain('dir=');
    });

    it('directs the paragraphs of a quote, which keeps no direction itself', () => {
        const html = render(`> ${PERSIAN}\n>\n> ${ENGLISH}`, RTL);
        expect(html).toContain('<blockquote>');
        expect(html).toContain(`<p dir="rtl">${PERSIAN}</p>`);
        expect(html).toContain(`<p dir="ltr">${ENGLISH}</p>`);
    });

    it('directs table cells through a paragraph, the form the note stores', () => {
        const html = render(`| ستون | Value |\n|---|---|\n| سال | 2020 |\n| |  |`, RTL);
        expect(html).toContain('<table>');
        expect(html).toContain('<th><p dir="rtl">ستون</p></th>');
        expect(html).toContain('<th><p dir="ltr">Value</p></th>');
        expect(html).toContain('<td><p dir="rtl">2020</p></td>');
        expect(html).toContain('<td></td>');
    });

    it('leaves the paragraphs of list items to their list, as the note saves an item\'s only paragraph inline', () => {
        const html = render(`- ${PERSIAN}\n\n- ${ENGLISH}\n\n- ${ARABIC}`, RTL);
        expect(html).toContain('<ul dir="rtl">');
        expect(html).toContain(`<li>\n<p>${PERSIAN}</p>`);
        expect(html).not.toMatch(/<li>\s*<p dir=/);
    });

    it('directs the paragraphs of a list item with several, which the note keeps', () => {
        const html = render(`- ${ENGLISH}\n\n  ${PERSIAN}\n\n- ${ENGLISH}`, RTL);
        expect(html).toContain(`<p dir="ltr">${ENGLISH}</p>\n<p dir="rtl">${PERSIAN}</p>`);
        expect(roundTrip(html)).toContain(`<p dir="rtl">${PERSIAN}</p>`);
    });

    it('ignores options other than `all` in the cached note pipeline', () => {
        const options = { all: false, labels: ['User'] } as unknown as { all: boolean };
        expect(renderNoteMarkdownHtml(`## User\n\n${ARABIC}`, (text) => text, { textDirection: options }))
            .toContain('<h2 dir="ltr">User</h2>');
        expect(render(`## User\n\n${ARABIC}`, RTL)).toContain('<h2 dir="ltr">User</h2>');
    });

    it('directs a heading named like a chat section label, which in a note is content', () => {
        expect(render(`## User\n\n${ARABIC}`, RTL)).toContain('<h2 dir="ltr">User</h2>');
    });

    it('keeps the endnotes heading Beaver adds in the reader\'s direction', () => {
        const html = render(`${PERSIAN}[^1]\n\n[^1]: ${ARABIC}`, RTL);
        expect(html).toContain('<h2>Notes</h2>');
        expect(html).toMatch(/<ol dir="rtl">\s*<li>\s*<p>/);
    });

    it('keeps a direction written in the source', () => {
        expect(render(`<p dir="ltr">${PERSIAN}</p>`, RTL)).toContain(`<p dir="ltr">${PERSIAN}</p>`);
    });

    describe('for a writer who reads both directions', () => {
        it('directs an English note left to right', () => {
            const html = render(`# Title\n\n${ENGLISH}\n\n- item\n\n\`\`\`\ncode\n\`\`\``, ALL);
            expect(html).toContain('<h1 dir="ltr">Title</h1>');
            expect(html).toContain(`<p dir="ltr">${ENGLISH}</p>`);
            expect(html).toContain('<ul dir="ltr">');
            expect(html).toContain('<pre dir="ltr">');
        });

        it('directs a note without letters left to right', () => {
            expect(render('2019–2021\n\n- `npm test`', ALL)).toContain('<p dir="ltr">2019–2021</p>');
        });

        it('still directs right-to-left blocks by their letters', () => {
            expect(render(`${PERSIAN}\n\n${ENGLISH}`, ALL)).toContain(`<p dir="rtl">${PERSIAN}</p>`);
        });
    });

    it('writes only directions that survive loading and saving the note', () => {
        const html = render([
            `# ${PERSIAN}`,
            `${PERSIAN} \`code\` $x$`,
            ENGLISH,
            `- ${ARABIC}\n- ${ENGLISH}`,
            `- ${PERSIAN}\n\n- ${ENGLISH}\n\n- ${ARABIC}`,
            `1. ${HEBREW}`,
            `> ${PERSIAN}`,
            `| ستون | Value |\n|---|---|\n| سال | 2020 |`,
            '```\nconst a = 1;\n```',
            '$$\nx^2\n$$',
        ].join('\n\n'), RTL);
        const saved = roundTrip(html);
        const directions = (markup: string) => markup.match(/<\w+ dir="(?:ltr|rtl)"/g) ?? [];
        expect(directions(html).length).toBeGreaterThan(10);
        expect(directions(saved)).toEqual(directions(html));
        // A saved note loads into the same markup.
        expect(roundTrip(saved)).toBe(saved);
    });
});
