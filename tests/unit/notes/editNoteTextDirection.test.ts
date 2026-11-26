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

/** The note renderer, as `Zotero.Beaver.exporter.renderNoteMarkdown` runs it in Zotero (writer reads one direction). */
function renderMarkdownSync(content: string, options: NoteRenderOptions = {}): string {
    const textDirection = options.directions === 'all' ? { all: true } : options.directions === 'note' ? { all: false } : undefined;
    return renderNoteMarkdown({ codeRanges, renderNoteMarkdownHtml }, content, textDirection);
}

async function renderMarkdown(content: string, options: NoteRenderOptions = {}): Promise<string> {
    return renderMarkdownSync(content, options);
}

// Note writes render through the plugin's exporter.
(globalThis as any).Zotero.Beaver = {
    ...(globalThis as any).Zotero.Beaver,
    exporter: { renderNoteMarkdown: renderMarkdownSync },
};

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
    const renderMarkdownFallback = () => buildMarkdownRenderFields(oldString, newString, operation, 1);
    const result = resolveBatchEdits(ctx, [{ index: 0, oldString, newString, operation, renderMarkdownFallback }]);
    expect(result.failures).toEqual([]);
    const body = (html: string) => html.replace(/^<div data-schema-version="9">|<\/div>$/g, '').replace(/\n/g, '');
    return {
        strategy: result.resolved[0].strategy,
        html: body(applyResolvedEdits(ctx.strippedHtml, result.resolved).newStrippedHtml),
    };
}

/**
 * Validate an edit, execute it with the normalized strings validation returns
 * (as the action does after approval), and save the result in the note schema.
 */
function insertRoundTrip(html: string, oldString: string, newString: string, operation: BatchEditSpec['operation']) {
    const ctx = context(html);
    const validated = resolveBatchEdits(ctx, [{ index: 0, oldString, newString, operation }]);
    if (validated.failures.length) return { failure: validated.failures[0].errorCode };
    const target = validated.resolved[0];
    const executed = resolveBatchEdits({ ...ctx, mode: 'execute' }, [{
        index: 0, operation,
        oldString: target.normalizedOldString!,
        newString: target.normalizedNewString!,
        targetBeforeContext: target.targetBeforeContext,
        targetAfterContext: target.targetAfterContext,
    }]);
    expect(executed.failures).toEqual([]);
    expect(executed.resolved[0].applyOps).toEqual(target.applyOps);
    const saved = normalizeNoteHtml(applyResolvedEdits(ctx.strippedHtml, executed.resolved).newStrippedHtml);
    return {
        strategy: target.strategy,
        html: saved.replace(/^<div data-schema-version="9">|<\/div>$/g, '').replace(/\n/g, ''),
        warnings: target.warnings,
    };
}

const copiedAnchorWarning = (warnings: string[] = []) => warnings.some((warning) => warning.includes('started with a copy') || warning.includes('ended with a copy'));

describe('edit_note inserts next to a block whose direction the anchor leaves out', () => {
    const NOTE = `<p dir="rtl">${P1}</p><p dir="ltr">English text here.</p><h2 dir="rtl">روش</h2>`;

    it('inserts after the stored block, keeping its direction and adding no empty paragraph', () => {
        const { strategy, html } = insertRoundTrip(NOTE, '<p>English text here.</p>', '<p>Added.</p>', 'insert_after');
        expect(strategy).toBe('spurious_wrap_strip');
        expect(html).toBe(`<p dir="rtl">${P1}</p><p dir="ltr">English text here.</p><p>Added.</p><h2 dir="rtl">روش</h2>`);
    });

    it('inserts before the stored block, which keeps its direction', () => {
        const { strategy, html } = insertRoundTrip(NOTE, '<p>English text here.</p>', '<p>Added.</p>', 'insert_before');
        expect(strategy).toBe('spurious_wrap_strip');
        expect(html).toBe(`<p dir="rtl">${P1}</p><p>Added.</p><p dir="ltr">English text here.</p><h2 dir="rtl">روش</h2>`);
    });

    it('handles headings and a merged new_string the same way', () => {
        expect(insertRoundTrip(NOTE, '<h2>روش</h2>', '<h2>روش</h2><p>پاراگراف تازه</p>', 'insert_after').html)
            .toBe(`<p dir="rtl">${P1}</p><p dir="ltr">English text here.</p><h2 dir="rtl">روش</h2><p>پاراگراف تازه</p>`);
        expect(insertRoundTrip(NOTE, '<h2>روش</h2>', '<p>پیش</p><h2>روش</h2>', 'insert_before').html)
            .toBe(`<p dir="rtl">${P1}</p><p dir="ltr">English text here.</p><p>پیش</p><h2 dir="rtl">روش</h2>`);
    });

    it('finds the stored block for an anchor with legacy math', () => {
        const note = '<p dir="ltr">The formula is <span class="math">$x$</span>.</p>';
        const stored = '<p dir="ltr">The formula is <span class="math">$x$</span>.</p>';
        expect(insertRoundTrip(note, '<p>The formula is $x$.</p>', '<p>Before.</p>', 'insert_before').html)
            .toBe(`<p>Before.</p>${stored}`);
        expect(insertRoundTrip(note, '<p>The formula is $x$.</p>', '<p>After.</p>', 'insert_after').html)
            .toBe(`${stored}<p>After.</p>`);
    });

    it('warns about a copied anchor only when the model copied it', () => {
        expect(copiedAnchorWarning(insertRoundTrip(NOTE, '<p>English text here.</p>', '<p>Added.</p>', 'insert_after').warnings)).toBe(false);
        expect(copiedAnchorWarning(insertRoundTrip(NOTE, '<p>English text here.</p>', '<p>English text here.</p><p>Added.</p>', 'insert_after').warnings)).toBe(true);
        expect(copiedAnchorWarning(insertRoundTrip(NOTE, '<p>English text here.</p>', '<p>Added.</p>', 'insert_before').warnings)).toBe(false);
    });

    it('treats a payload that copies the anchor as stored as a copied anchor', () => {
        const stored = '<p dir="ltr">English text here.</p>';
        const after = insertRoundTrip(NOTE, '<p>English text here.</p>', `${stored}<p>Added.</p>`, 'insert_after');
        expect(after.html).toBe(`<p dir="rtl">${P1}</p>${stored}<p>Added.</p><h2 dir="rtl">روش</h2>`);
        expect(copiedAnchorWarning(after.warnings)).toBe(true);
        const before = insertRoundTrip(NOTE, '<p>English text here.</p>', `<p>Added.</p>${stored}`, 'insert_before');
        expect(before.html).toBe(`<p dir="rtl">${P1}</p><p>Added.</p>${stored}<h2 dir="rtl">روش</h2>`);
        expect(copiedAnchorWarning(before.warnings)).toBe(true);
    });

    it('does not split a paragraph for an insert_after anchor without a closing tag', () => {
        const result = insertRoundTrip('<p dir="ltr">Alpha beta gamma.</p>', '<p>Alpha beta', '<h2>New.</h2>', 'insert_after');
        expect(result.failure).toBeDefined();
    });

    it('never inserts inside a paragraph when the anchor closes it too early', () => {
        const result = insertRoundTrip('<p dir="ltr">Alpha beta gamma.</p>', '<p>Alpha beta</p>', '<p>New.</p>', 'insert_after');
        expect(result.html ?? '').not.toContain('Alpha beta</p><p>New.');
        expect(result.html ?? '').not.toMatch(/<p>\s*<\/p>/);
    });

    it('refuses an anchor that stands for blocks stored with different directions', () => {
        const note = '<p dir="ltr">Same text.</p><p dir="rtl">Same text.</p>';
        for (const operation of ['insert_after', 'insert_before'] as const) {
            const result = insertRoundTrip(note, '<p>Same text.</p>', '<p>Added.</p>', operation);
            expect(result.failure).toBeDefined();
        }
    });

    it('leaves inserts into undirected notes as they were', () => {
        const note = '<p>English text here.</p><p>Other.</p>';
        const after = insertRoundTrip(note, '<p>English text here.</p>', '<p>Added.</p>', 'insert_after');
        expect(after).toMatchObject({ strategy: 'exact', html: '<p>English text here.</p><p>Added.</p><p>Other.</p>' });
        const before = insertRoundTrip(note, '<p>Other.</p>', '<p>Added.</p>', 'insert_before');
        expect(before).toMatchObject({ strategy: 'exact', html: '<p>English text here.</p><p>Added.</p><p>Other.</p>' });
    });
});

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
