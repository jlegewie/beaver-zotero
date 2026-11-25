/**
 * Text direction of rendered chat markdown. Markdown in left-to-right scripts
 * must render exactly as before; blocks of right-to-left text (Persian, Arabic,
 * Hebrew) get an explicit `dir`, with code and math kept left to right.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/chat/Citation', () => ({
    default: () => React.createElement('span', { className: 'zotero-citation' }, '1'),
}));

import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';
import { setHost } from '@beaver/agent-ui/host';

function render(content: string, exportRendering = false): string {
    return renderToStaticMarkup(
        React.createElement(MarkdownRenderer, { content, exportRendering }),
    );
}

const PERSIAN = 'این پژوهش نشان می\u200Cدهد که روش پیشنهادی دقیق\u200Cتر است.';
const HEBREW = 'המחקר מראה שהשיטה המוצעת מדויקת יותר.';
const ARABIC = 'تظهر النتائج تحسنا ملحوظا في الأداء.';

describe('MarkdownRenderer text direction', () => {
    it('adds no direction to markdown without right-to-left text', () => {
        const content = [
            '# Results',
            'The method is **more accurate** than `baseline()` with $x^2$.',
            '- first item\n- second item',
            '> a quote',
            '| a | b |\n|---|---|\n| 1 | 2 |',
            '```\ncode block\n```',
            '$$\n\\frac{a}{b}\n$$',
            'Arabic-Indic digits alone ١٢٣ do not count as letters.',
        ].join('\n\n');
        expect(render(content)).not.toContain('dir=');
    });

    it('sets right to left on a Persian, Arabic or Hebrew paragraph', () => {
        for (const text of [PERSIAN, ARABIC, HEBREW]) {
            expect(render(text)).toContain('<p dir="rtl">');
        }
    });

    it('follows the majority of letters, not the first one', () => {
        // A Persian sentence opening with an English name reads right to left.
        expect(render(`Smith (2020) ${PERSIAN}`)).toContain('<p dir="rtl">Smith (2020)');
        // An English sentence quoting one Persian word reads left to right.
        expect(render('The term «استبداد» means tyranny in this context.'))
            .toContain('<p dir="ltr">');
    });

    it('gives each block its own direction in mixed replies', () => {
        const html = render(`${PERSIAN}\n\nThis paragraph is English.`);
        expect(html).toContain(`<p dir="rtl">${PERSIAN}</p>`);
        expect(html).toContain('<p dir="ltr">This paragraph is English.</p>');
    });

    it('directs a list as a whole and leaves its items to inherit', () => {
        const html = render(`- ${PERSIAN}\n- ${ARABIC}`);
        expect(html).toContain('<ul dir="rtl">');
        expect(html).not.toContain('<li dir=');
    });

    it('directs headings, quotes and tables', () => {
        const html = render(`## ${PERSIAN}\n\n> ${HEBREW}\n\n| ستون | مقدار |\n|---|---|\n| سال | 2020 |`);
        expect(html).toContain('<h2 dir="rtl">');
        expect(html).toContain('<blockquote dir="rtl">');
        expect(html).toContain('<table dir="rtl">');
        expect(html).toContain('<th dir="rtl">ستون</th>');
        // A cell without letters inherits the table's direction.
        expect(html).toContain('<td>2020</td>');
    });

    it('keeps code and math left to right inside right-to-left text', () => {
        const html = render(`${PERSIAN} \`foo(bar)\` و $x^2$\n\n\`\`\`\nconst a = 1;\n\`\`\``);
        expect(html).toContain('<code dir="ltr">foo(bar)</code>');
        expect(html).toMatch(/<span class="katex" dir="ltr">/);
        // A top-level code block lives in the UI's own direction.
        expect(html).toContain('<pre><code>const a = 1;');
    });

    it('does not let code or math decide a paragraph direction', () => {
        expect(render(`\`someFunction()\` ${PERSIAN}`)).toContain('<p dir="rtl">');
        expect(render(`$\\alpha + \\beta$ ${PERSIAN}`)).toContain('<p dir="rtl">');
    });

    it('gives a block without letters the direction of the whole reply', () => {
        const html = render(`${PERSIAN}\n\n$x^2 + 1$\n\n${ARABIC}`);
        expect(html).toMatch(/<p dir="rtl"><span class="katex" dir="ltr">/);
        expect(html).not.toContain('<p>');
    });

    it('keeps a direction written in the source and directs the blocks below it', () => {
        const html = render(`<blockquote dir="rtl">\n\nEnglish inside a right-to-left quote.\n\n${HEBREW}\n\n</blockquote>`);
        expect(html).toContain('<blockquote dir="rtl">');
        expect(html).toContain('<p dir="ltr">English inside a right-to-left quote.</p>');
        expect(html).toContain(`<p dir="rtl">${HEBREW}</p>`);
    });

    it('never adds a direction to an export render, which is saved into a note', () => {
        expect(render(`${PERSIAN}\n\n- ${HEBREW}`, true)).not.toContain('dir=');
    });
});

describe('MarkdownRenderer text direction when the host directs all text', () => {
    afterEach(() => setHost({}));

    const directAllText = () => setHost({ config: { directsAllText: () => true } } as never);

    it('directs English blocks, so they read left to right in a right-to-left interface', () => {
        directAllText();
        const html = render('An English paragraph.\n\n- item one\n- item two');
        expect(html).toContain('<p dir="ltr">An English paragraph.</p>');
        expect(html).toContain('<ul dir="ltr">');
    });

    it('keeps code and math left to right below no directed block', () => {
        directAllText();
        const html = render('```\nconst a = 1;\n```\n\n$$\nx^2\n$$');
        expect(html).toContain('<pre dir="ltr">');
        expect(html).toMatch(/<span class="katex-display" dir="ltr">/);
    });

    it('directs a reply without letters left to right', () => {
        directAllText();
        const html = render('- `npm test`\n- `npm run build`\n\n2019–2021');
        expect(html).toContain('<ul dir="ltr">');
        expect(html).toContain('<p dir="ltr">2019–2021</p>');
    });

    it('still directs right-to-left blocks by their letters', () => {
        directAllText();
        expect(render(PERSIAN)).toContain('<p dir="rtl">');
    });

    it('leaves the export render alone', () => {
        directAllText();
        expect(render('An English paragraph.', true)).not.toContain('dir=');
    });
});
