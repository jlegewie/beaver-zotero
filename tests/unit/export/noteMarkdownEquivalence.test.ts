// @vitest-environment jsdom

/**
 * The note renderer in the plugin realm writes exactly the HTML the chat's
 * React renderer writes for the same Markdown in export mode. Note edits match
 * rendered Markdown against note HTML as text, so even a serialization
 * difference (`<br/>` against `<br>`, `&#x27;` against `'`) would stop an edit
 * from finding text in a note Beaver wrote earlier.
 *
 * Both renderers share the Markdown pipeline, so a change to that pipeline
 * would pass the comparison. `fixtures/noteMarkdownRender.json` pins the HTML
 * that note writes produced when they rendered with React, before the
 * renderer moved to the plugin realm; a change to it is a change to how notes
 * are written. The renders were made under Node, where library 1 has no
 * portable id, so a legacy `1-KEY` link stays as written; in Zotero it becomes
 * a `zotero://select` link, in both renderers.
 */
import { describe, expect, it, vi } from 'vitest';

// The React path's export citation renders nothing for a tag without an
// identity, the only kind left after masking.
vi.mock('@beaver/agent-ui/chat/Citation', () => ({ default: () => null }));
vi.mock('../../../react/utils/citationRenderContext', () => ({ loadCitedLibraries: vi.fn(async () => {}) }));

import { codeRanges } from '@beaver/agent-export/parse/markdown';
import { renderNoteMarkdownHtml } from '@beaver/agent-export/render/noteHtml';
import { renderToHTML } from '../../../react/utils/citationRenderers';
import { maskNoteCitationTags, unmaskNoteCitationTags } from '../../../src/utils/noteCitationMask';
import { renderNoteMarkdown } from '../../../src/services/export/noteMarkdown';
import type { TextDirectionOptions } from '@beaver/agent-export/render/textDirection';
import { setHost } from '@beaver/agent-ui/host';
import pinnedRenders from './fixtures/noteMarkdownRender.json';

/** The chat's React renderer, as note writes used it. */
function renderWithReact(content: string): string {
    const masked = maskNoteCitationTags(content, codeRanges);
    return unmaskNoteCitationTags(renderToHTML(masked.text, 'markdown', {}), masked);
}

function renderInstance(content: string, textDirection?: TextDirectionOptions): string {
    return renderNoteMarkdown({ codeRanges, renderNoteMarkdownHtml }, content, textDirection);
}

const SNIPPETS = [
    '# Heading 1', '## Heading *2* with `code`', '###### h6', 'Setext\n===',
    'Plain text with & ampersand, <less> and "quotes" and \'apostrophes\' and > greater.',
    '**bold** __bold__ *em* _em_ ***both*** ~~strike~~ ~not strike~ P~lac~',
    '- item 1\n- item 2\n  - nested\n    1. deep',
    '1. one\n2. two\n\n3. loose',
    '5. starts at five\n6. six',
    '- [ ] todo\n- [x] done',
    '| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| x & y | `c` | **b** |',
    '| a |\n|---|\n| only |',
    '```js\nconst a = "<b>" && 1 < 2;\n```', '```\n\nstarts with blank line\n```', '    indented code <x>',
    '```plaintext\nplain fence\n```',
    'Inline `a < b` code', '> quote\n> > nested quote', '---', '***',
    '[link](https://example.com "Title \'q\'") and <https://auto.link> and www.example.com',
    '[zotero](zotero://select/library/items/ABCD1234) [item](u-ABCD1234) [legacy](1-ABCD1234) [js](javascript:alert(1))',
    '![image](https://example.com/x.png "t") [![nested](https://e.com/i.png)](https://e.com)',
    'Footnote ref[^1] and[^n].\n\n[^1]: The note.\n[^n]: Other *note*.',
    'Math $E=mc^2$ and $$\\int_0^1 x dx$$ and \\(a<b\\) and \\[c>d\\]',
    '$$\nx = \\frac{1}{2}\n$$',
    'Line with two spaces  \nbreak', 'Backslash\\\nbreak',
    '<span style="color:red" onclick="x()">raw span</span> <b>bold</b> <kbd>Ctrl</kbd> <sub>2</sub><sup>3</sup>',
    '<details open><summary>Sum</summary>Body text</details>',
    '<div align="center" class="x" id="anchor">div html</div>',
    '<table><tr><td colspan="2" rowspan="1" valign="top" nowrap>cell</td></tr></table>',
    '<input type="checkbox" checked disabled> raw input', '<br> <br/> <hr>',
    '<img src="https://e.com/a.png" alt="alt text" width="10">',
    '<a href="https://x.com" title="t" target="_blank" rel="noopener">raw a</a>',
    '<ol start="3" reversed><li>three</li></ol>',
    '<abbr title="HyperText">HTML</abbr> <q cite="https://e.com">q</q> <del datetime="2020">del</del> <ins>ins</ins>',
    '<!-- comment --> after comment', '<script>alert(1)</script> after script', '<style>p{}</style>',
    '&copy; &amp; &#x27; &#39; &nbsp; &lt;tag&gt; &unknown;',
    'Unicode: é, ü, 中文, emoji 🎉, zero\u200Bwidth, soft\u00ADhyphen, NFC é',
    '<note title="Legacy">legacy *body*</note>',
    'Cite <citation id="u-AAAA1111" loc="page5"/> and `<citation id="u-B"/>` and \\<citation id="u-C"/>',
    '<citation item_id="1-ABCD1234" page="3"/> legacy cite', '<CITATION id="u-UP"/> upper',
    'Claim <cita\u200Btion id="u-AAAA1111"/> tail, <cita\u00ADtion/> more.',
    '**e\u200B\u0301** and `co\u200Bde <citation id="u-B\u200BX"/>`',
    'Trailing **unclosed bold', 'Partial <span', 'html <span class="language-js">x</span>',
    'Term<br>with<br/>breaks', '<p align="right">para</p>', '<h2 class="sr-only">sr</h2>', '<section data-footnotes class="footnotes">s</section>',
    '<pre>\nleading newline pre</pre>', '<code class="language-math">raw math code</code>',
    '<a name="anchor" id="x">named</a>', '<td>orphan td</td>', '<li class="task-list-item">li</li>',
    '<font color="red" size="3">font</font> <center>c</center> <u>u</u> <s>s</s> <mark>m</mark>',
    'Tab\tseparated\ttext', '\\* escaped star \\_ \\` \\#',
    '1) paren list\n2) two', '+ plus list', '* star list\n\n* loose',
    '<textarea>\nta</textarea> <select><option selected>o</option></select> <svg><circle r="1"/></svg> <math><mi>x</mi></math>',
    '<td align="left" style="color:red">aligned raw td</td>',
    '<span data-x="1" aria-label="l" tabindex="0" dir="rtl" lang="en" hidden>attrs</span>',
    '<ol start="x"><li>bad start</li></ol> <table><col span="0"><tr><td rowspan="x">r</td></tr></table>',
    '<a href="javascript:alert(1)">js raw</a> <a href="zotero://open/library/items/ABC">z</a> <a href="u-ABCD1234">obj</a>',
    '<input type="text" value="v" disabled> <input type="checkbox" value="v" checked>',
    '<div itemscope itemtype="t" itemprop="p">micro</div> <bdo dir="ltr">b</bdo> <dl><dt>t</dt><dd>d</dd></dl> <ruby>r<rt>t</rt></ruby>',
];

const SEPARATORS = ['\n\n', '\n', ' ', '\n- ', '\n> ', '\n| x |\n|---|\n| '];

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function random(seed: number): () => number {
    let state = seed;
    return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

describe('note Markdown rendering without React', () => {
    it.each((pinnedRenders as Array<{ markdown: string; html: string }>).map((render, index) => [index, render]))(
        'writes the HTML note writes produced with React (pinned render %i)',
        (_index, render) => {
            const { markdown, html } = render as { markdown: string; html: string };
            expect(renderInstance(markdown)).toBe(html);
        },
    );

    it.each(SNIPPETS.map((snippet, index) => [index, snippet]))('matches the React render byte for byte (snippet %i)', (_index, snippet) => {
        expect(renderInstance(snippet as string)).toBe(renderWithReact(snippet as string));
    });

    it('matches the React render on combined snippets', () => {
        const next = random(42);
        const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
        const mismatches: string[] = [];
        for (let n = 0; n < 400; n++) {
            const parts: string[] = [];
            const count = 1 + Math.floor(next() * 6);
            for (let k = 0; k < count; k++) parts.push(pick(SNIPPETS), pick(SEPARATORS));
            const markdown = parts.join('');
            if (renderInstance(markdown) !== renderWithReact(markdown)) mismatches.push(markdown);
        }
        expect(mismatches.slice(0, 3)).toEqual([]);
    }, 60_000);
});

/**
 * A note being written gets block directions in both renderers: "Save as
 * note" renders with React, `create_note` in the plugin realm.
 */
describe('note Markdown rendering with text direction', () => {
    const RTL_SNIPPETS = [
        '# عنوان پژوهش', 'این پژوهش نشان می\u200Cدهد که روش **پیشنهادی** دقیق\u200Cتر است.',
        'The term «استبداد» means tyranny.', '- یک\n- دو\n  - سه', '1. אחד\n2. שתיים',
        '> نقل قول\n>\n> English in a quote', '| ستون | Value |\n|---|---|\n| سال | 2020 |',
        'متن `code()` و $x^2$', '```\nconst a = 1;\n```', '$$\nx^2\n$$', 'فوت[^1]\n\n[^1]: یادداشت.',
        '2019–2021', 'Plain English paragraph.', '<p dir="ltr">متن</p>',
    ];

    it('matches the React render for right-to-left and mixed notes', () => {
        const next = random(7);
        const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
        const mismatches: string[] = [];
        for (let n = 0; n < 100; n++) {
            const parts: string[] = [];
            for (let k = 0; k < 1 + Math.floor(next() * 5); k++) parts.push(pick(RTL_SNIPPETS), '\n\n');
            const markdown = parts.join('');
            if (renderInstance(markdown, { all: false }) !== renderWithReact(markdown)) mismatches.push(markdown);
        }
        expect(mismatches.slice(0, 3)).toEqual([]);
        expect(renderWithReact(RTL_SNIPPETS[1])).toContain('dir="rtl"');
    });

    it('matches the React render when the writer reads both directions', () => {
        setHost({ config: { directsAllText: () => true } } as never);
        try {
            for (const snippet of [...RTL_SNIPPETS, ...SNIPPETS]) {
                expect(renderInstance(snippet, { all: true })).toBe(renderWithReact(snippet));
            }
            expect(renderWithReact('Plain English paragraph.')).toContain('<p dir="ltr">');
        } finally {
            setHost({});
        }
    });
});
