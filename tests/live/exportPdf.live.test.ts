/**
 * Live tests for PDF export (`/beaver/test/export` with `format: 'pdf'` and an
 * explicit source).
 *
 * Exports hand-written markdown citing real library items, an attachment (which
 * cites its parent item) and an external reference, in an author-date, a note
 * and a numeric style. Each export is printed by Zotero to a real PDF; the test
 * checks the file and the HTML it was printed from (`includeHtml`).
 *
 * Prerequisites: a running, logged-in dev build of Beaver with an open main
 * window, the fixture items from `helpers/fixtures.ts`, and the APA, Chicago
 * (notes) and IEEE styles.
 *
 * Run: `ZOTERO_HTTP_PORT=<port> npx vitest run --config vitest.live.config.ts tests/live/exportPdf.live.test.ts`
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { NORMAL_PDF, PARENT_ITEM } from '../helpers/fixtures';

let zoteroAvailable = false;
let dir = '';

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    dir = mkdtempSync(join(tmpdir(), 'beaver-export-pdf-'));
});

afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

const MARKDOWN = [
    `# Findings`,
    ``,
    `Networks are homophilous <citation id="u-${PARENT_ITEM.zotero_key}" loc="page2"/>. The attachment says so too <citation id="u-${NORMAL_PDF.zotero_key}"/>.`,
    ``,
    `An outside study agrees <citation external_id="W4242"/>. Again <citation id="u-${PARENT_ITEM.zotero_key}"/>. See the note[^a].`,
    ``,
    `[^a]: A remark.`,
    ``,
    `$$\\hat{\\beta} = \\frac{\\sum_i x_i y_i}{\\sum_i x_i^2}$$`,
    ``,
    `| Study | N |`,
    `|---|--:|`,
    `| Fischer | 1,426 |`,
].join('\n');

const SOURCE = {
    kind: 'response',
    title: 'Live PDF export test',
    blocks: [{ type: 'markdown', markdown: MARKDOWN }],
    citations: {
        citationsByKey: {},
        externalReferences: {
            W4242: { source: 'openalex', title: 'An Outside Study', authors: ['Ada Lovelace'], year: 1843, journal: { name: 'Notes' }, library_items: [] },
        },
        externalItemMapping: {},
        pageLabelsByAttachmentId: {},
    },
    provenance: { runIds: [] },
};

interface ExportResponse {
    status: 'saved' | 'canceled';
    path: string;
    html?: string;
    warnings: Array<{ code: string; message: string }>;
    stats: { citations: number; notes: number; equations: number; equationsAsText: number; clusters: number; bibliographyEntries: number };
    error?: string;
}

async function exportPdf(styleId: string, extra: Record<string, unknown> = {}) {
    const path = join(dir, `${styleId.split('/').pop()}-${Date.now()}.pdf`);
    const result = await post<ExportResponse>('/beaver/test/export', { source: SOURCE, path, styleId, format: 'pdf', includeHtml: true, ...extra });
    const bytes = result.path ? readFileSync(result.path) : Buffer.alloc(0);
    return { result, html: result.html ?? '', pdf: bytes.toString('latin1') };
}

/** The HTML body's visible text. */
const text = (html: string) => html
    .replace(/^[\s\S]*<body>/, '')
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * Whether the PDF has the document's text, not only the page-number footer: a
 * page printed before it loaded embeds just the footer's font.
 */
const embeddedFonts = (pdf: string) => new Set([...pdf.matchAll(/\/BaseFont\s*\/([\w+-]+)/g)].map(match => match[1]));

/** Page boxes of a PDF (`[x0 y0 x1 y1]` in points), one per page. */
const mediaBoxes = (pdf: string) => [...pdf.matchAll(/\/MediaBox\s*\[\s*([\d.\s]+)\]/g)].map(match => match[1].trim().split(/\s+/).map(Number));

describe('PDF export (live)', () => {
    it('prints an author-date export to a PDF', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, html, pdf } = await exportPdf('http://www.zotero.org/styles/apa');
        expect(result.status).toBe('saved');
        expect(pdf.startsWith('%PDF-')).toBe(true);
        // Body, bold, italic, math: more than the footer's one font.
        expect(embeddedFonts(pdf).size).toBeGreaterThan(2);
        expect(result.stats).toMatchObject({ clusters: 4, citations: 4, notes: 1, equations: 1, equationsAsText: 0 });
        expect(result.warnings).toEqual([]);
        expect(result.stats.bibliographyEntries).toBeGreaterThanOrEqual(3);

        const body = text(html);
        expect(body).toContain('Lovelace, 1843');
        expect(body).toMatch(/References/);
        expect(body).toContain('A remark.');
        // US English prints on Letter paper.
        expect(mediaBoxes(pdf)[0]).toEqual([0, 0, 612, 792]);
        // Equations are MathML; the page loads nothing.
        expect(html).toContain('<math');
        expect(html).not.toMatch(/<script|<img/);
    });

    it('collects note-style citations as endnotes before the bibliography', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, html } = await exportPdf('http://www.zotero.org/styles/chicago-note-bibliography');
        // Four citation notes plus the markdown footnote, in one sequence.
        expect(result.stats.notes).toBe(5);
        expect(html.match(/<sup class="note-ref">/g)).toHaveLength(5);
        expect(html.indexOf('class="notes"')).toBeLessThan(html.indexOf('class="bibliography"'));
        expect(text(html)).toContain('Bibliography');
    });

    it('numbers citations for a numeric style and follows the locale for paper', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { html, pdf } = await exportPdf('http://www.zotero.org/styles/ieee', { locale: 'en-GB' });
        expect(text(html)).toMatch(/\[1(?:, p\. 2)?\]/);
        expect(html).toContain('class="csl-left-margin"');
        const [box] = mediaBoxes(pdf);
        expect(box[2]).toBeCloseTo(595.28, 1);
        expect(box[3]).toBeCloseTo(841.89, 1);
    });

    it('prints the content of every export, not an empty page', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        // A short page loads fastest, so printing it too early is most likely.
        const source = { ...SOURCE, blocks: [{ type: 'markdown', markdown: 'Hello *world*.' }] };
        for (let attempt = 0; attempt < 6; attempt++) {
            const path = join(dir, `short-${attempt}-${Date.now()}.pdf`);
            await post<ExportResponse>('/beaver/test/export', { source, path, format: 'pdf' });
            expect(embeddedFonts(readFileSync(path, 'latin1')).size, `attempt ${attempt}`).toBeGreaterThan(1);
        }
    });

    it('replaces an existing file at the chosen path', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const path = join(dir, `existing-${Date.now()}.pdf`);
        writeFileSync(path, 'old contents');
        const result = await post<ExportResponse>('/beaver/test/export', { source: SOURCE, path, format: 'pdf' });
        expect(result.status).toBe('saved');
        expect(readFileSync(path, 'latin1').startsWith('%PDF-')).toBe(true);
        // The HTML is only returned on request.
        expect(result.html).toBeUndefined();
    });
});
