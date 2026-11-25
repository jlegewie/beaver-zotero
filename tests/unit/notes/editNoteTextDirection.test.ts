/**
 * `edit_note` on notes whose blocks carry a text direction: Persian notes a
 * user directed by hand with the note editor's RTL toggle, and notes Beaver
 * writes with block directions. The model reads the `dir` attributes, an edit
 * inside a block keeps its block's direction, and a Markdown-shaped anchor is
 * found in a note with or without directions.
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
import { renderNoteMarkdown, type NoteRenderOptions } from '../../../src/services/export/noteMarkdown';
import { buildMarkdownRenderFields } from '../../../src/services/agentDataProvider/actions/editNote';
import { normalizeNoteHtml, simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import {
    applyResolvedEdits,
    resolveBatchEdits,
    type BatchEditSpec,
    type ResolveBatchContext,
} from '../../../src/utils/editNoteBatchCore';

const P1 = 'این پژوهش نشان می‌دهد که روش پیشنهادی دقیق‌تر است.';
const P2 = 'نتایج در جدول زیر آمده است.';

/** A Persian note directed by hand, block by block. */
const HAND_DIRECTED = `<h1 dir="rtl">گزارش</h1><p dir="rtl">${P1}</p><ul dir="rtl"><li>یک</li><li>دو</li></ul><p dir="rtl">${P2}</p>`;

/** The note renderer, as `OperationContext.renderMarkdown` runs it in Zotero (writer reads one direction). */
async function renderMarkdown(content: string, options: NoteRenderOptions = {}): Promise<string> {
    const textDirection = options.directions === 'all' ? { all: true } : options.directions === 'note' ? { all: false } : undefined;
    return renderNoteMarkdown({ codeRanges, renderNoteMarkdownHtml }, content, textDirection);
}

function context(html: string): ResolveBatchContext {
    const strippedHtml = normalizeNoteHtml(`<div data-schema-version="9">${html}</div>`);
    const { simplified, metadata } = simplifyNoteHtml(strippedHtml, 1);
    return {
        strippedHtml, simplified, metadata,
        externalRefContext: { externalRefs: {}, externalItemMapping: {} },
        pageLabels: {}, appendPoint: 0, mode: 'validate',
    };
}

async function edit(ctx: ResolveBatchContext, oldString: string, newString: string, operation: BatchEditSpec['operation'] = 'str_replace') {
    const rendered = await buildMarkdownRenderFields(oldString, newString, operation, 1, { renderMarkdown });
    const result = resolveBatchEdits(ctx, [{ index: 0, oldString, newString, operation, ...rendered }]);
    expect(result.failures).toEqual([]);
    const body = (html: string) => html.replace(/^<div data-schema-version="9">|<\/div>$/g, '').replace(/\n/g, '');
    return {
        strategy: result.resolved[0].strategy,
        html: body(applyResolvedEdits(ctx.strippedHtml, result.resolved).newStrippedHtml),
    };
}

describe('edit_note on a note directed by hand', () => {
    it('shows the block directions to the model', () => {
        expect(context(HAND_DIRECTED).simplified).toContain(`<p dir="rtl">${P1}</p>`);
    });

    it('keeps the block direction when text inside a block changes', async () => {
        const { strategy, html } = await edit(context(HAND_DIRECTED), 'روش پیشنهادی', 'روش جدید');
        expect(strategy).toBe('exact');
        expect(html).toContain('<p dir="rtl">این پژوهش نشان می‌دهد که روش جدید دقیق‌تر است.</p>');
    });

    it('matches a block copied with its direction', async () => {
        const { strategy, html } = await edit(context(HAND_DIRECTED), `<p dir="rtl">${P2}</p>`, '<p dir="rtl">جدید</p>');
        expect(strategy).toBe('exact');
        expect(html).toContain('<p dir="rtl">جدید</p>');
    });

    it('keeps the stored direction when the model drops it from a copied block', async () => {
        const { strategy, html } = await edit(context(HAND_DIRECTED), `<p>${P2}</p>`, '<p>جدید</p>');
        expect(strategy).toBe('spurious_wrap_strip');
        expect(html).toContain('<p dir="rtl">جدید</p>');
    });

    it('inserts an HTML block as the model wrote it', async () => {
        const { html } = await edit(context(HAND_DIRECTED), `<p dir="rtl">${P2}</p>`, '<p>پاراگراف تازه</p>', 'insert_after');
        expect(html).toContain(`<p dir="rtl">${P2}</p><p>پاراگراف تازه</p>`);
    });
});

describe('edit_note with a Markdown anchor', () => {
    const MARKDOWN = `# گزارش\n\n## روش\n\n${P1}\n\n- یک\n- دو`;

    it.each([
        ['a Persian note written without directions', undefined],
        ['a Persian note written with block directions', { directions: 'note' }],
    ] as const)('finds a heading and paragraph in %s', async (_case, options) => {
        const ctx = context(await renderMarkdown(MARKDOWN, options));
        const { strategy, html } = await edit(ctx, `## روش\n\n${P1}`, `## روش تازه\n\n${P2}`);
        expect(strategy).toBe('markdown_render');
        const dir = options ? ' dir="rtl"' : '';
        expect(html).toContain(`<h2${dir}>روش تازه</h2><p${dir}>${P2}</p>`);
    });

    it.each([
        ['without directions', undefined],
        ['with block directions', { directions: 'note' }],
    ] as const)('finds a list in a Persian note written %s', async (_case, options) => {
        const ctx = context(await renderMarkdown(MARKDOWN, options));
        const { strategy, html } = await edit(ctx, '- یک\n- دو', '- یک\n- دو\n- سه');
        expect(strategy).toBe('markdown_render');
        expect(html).toContain(`<ul${options ? ' dir="rtl"' : ''}><li>یک</li><li>دو</li><li>سه</li></ul>`);
    });

    it('finds English blocks of a note with right-to-left text, which are directed left to right', async () => {
        const ctx = context(await renderMarkdown(`${P1}\n\n## Methods\n\nEnglish text.`, { directions: 'note' }));
        const { strategy, html } = await edit(ctx, '## Methods\n\nEnglish text.', '## Methods\n\nNew text.');
        expect(strategy).toBe('markdown_render');
        expect(html).toContain('<h2 dir="ltr">Methods</h2><p dir="ltr">New text.</p>');
    });

    it('finds the same anchor in an English note without directions', async () => {
        const ctx = context(await renderMarkdown('# Report\n\n## Methods\n\nEnglish text.', { directions: 'note' }));
        const { strategy, html } = await edit(ctx, '## Methods\n\nEnglish text.', '## Methods\n\nNew text.');
        expect(strategy).toBe('markdown_render');
        expect(html).toContain('<h2>Methods</h2><p>New text.</p>');
    });
});
