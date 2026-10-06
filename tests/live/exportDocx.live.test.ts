/**
 * Live tests for Word export (`/beaver/test/export` with an explicit source).
 *
 * Exports hand-written markdown citing real library items, an attachment (which
 * cites its parent item) and an external reference, in an author-date, a note
 * and a numeric style, then reads the .docx back from disk.
 *
 * Prerequisites: a running, logged-in dev build of Beaver with the fixture items
 * from `helpers/fixtures.ts` and the APA, Chicago (notes) and IEEE styles.
 *
 * Run: `ZOTERO_HTTP_PORT=<port> npx vitest run --config vitest.live.config.ts tests/live/exportDocx.live.test.ts`
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { NORMAL_PDF, PARENT_ITEM } from '../helpers/fixtures';

let zoteroAvailable = false;
let dir = '';

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    dir = mkdtempSync(join(tmpdir(), 'beaver-export-'));
});

afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

const MARKDOWN = [
    `# Findings`,
    ``,
    `Networks are homophilous <citation id="u-${PARENT_ITEM.zotero_key}" loc="page2"/>. The attachment says so too <citation id="u-${NORMAL_PDF.zotero_key}"/>.`,
    ``,
    `An outside study agrees <citation external_id="W4242"/>. Again <citation id="u-${PARENT_ITEM.zotero_key}"/>.`,
    ``,
    `$$\\hat{\\beta} = \\frac{\\sum_i x_i y_i}{\\sum_i x_i^2}$$`,
].join('\n');

const SOURCE = {
    kind: 'response',
    title: 'Live export test',
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
    warnings: Array<{ code: string; message: string }>;
    stats: { citationFields: number; footnotes: number; equations: number; equationsAsText: number; clusters: number; bibliographyEntries: number };
    error?: string;
}

async function exportWith(styleId: string, extra: Record<string, unknown> = {}) {
    const path = join(dir, `${styleId.split('/').pop()}-${Date.now()}.docx`);
    const result = await post<ExportResponse>('/beaver/test/export', { source: SOURCE, path, styleId, ...extra });
    const zip = await JSZip.loadAsync(readFileSync(result.path));
    const read = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
    return { result, document: await read('word/document.xml'), footnotes: await read('word/footnotes.xml'), custom: await read('docProps/custom.xml') };
}

const text = (xml: string) => xml
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const fieldJson = (xml: string) => [...xml.matchAll(/ADDIN ZOTERO_ITEM CSL_CITATION ([\s\S]*?) <\/w:instrText>/g)]
    .map(match => JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')));

describe('Word export (live)', () => {
    it('exports an author-date style with live fields, a bibliography and document preferences', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, document, custom } = await exportWith('http://www.zotero.org/styles/apa');
        expect(result.status).toBe('saved');
        expect(result.stats).toMatchObject({ clusters: 4, citationFields: 4, footnotes: 0, equations: 1, equationsAsText: 0 });
        expect(result.warnings).toEqual([]);

        const fields = fieldJson(document);
        expect(fields).toHaveLength(4);
        const [first, second, external] = fields;
        expect(first.citationItems[0].uris[0]).toMatch(new RegExp(`/items/${PARENT_ITEM.zotero_key}$`));
        expect(first.citationItems[0].locator).toBeTruthy();
        // A citation of an attachment cites its parent item.
        expect(second.citationItems[0].uris[0]).not.toMatch(new RegExp(`/items/${NORMAL_PDF.zotero_key}$`));
        // One stable URI per external work, so a refresh keeps repeated citations as one work.
        expect(external.citationItems[0].uris).toEqual(['https://openalex.org/W4242']);
        expect(external.citationItems[0].itemData.title).toBe('An Outside Study');
        for (const field of fields) {
            // The visible field text is the plain citation Zotero compares on refresh.
            expect(text(document)).toContain(field.properties.plainCitation);
        }
        expect(text(document)).toContain('Lovelace, 1843');
        expect(document).toContain('ZOTERO_BIBL');
        expect(result.stats.bibliographyEntries).toBeGreaterThanOrEqual(3);
        expect(custom).toContain('ZOTERO_PREF_1');
        expect(custom).toContain('http://www.zotero.org/styles/apa');
        expect(document).toContain('<m:acc>');
    });

    it('puts citations in footnotes for a note style', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, document, footnotes, custom } = await exportWith('http://www.zotero.org/styles/chicago-note-bibliography');
        expect(result.stats.footnotes).toBe(4);
        expect(document.match(/<w:footnoteReference /g)).toHaveLength(4);
        const fields = fieldJson(footnotes);
        expect(fields.map(field => field.properties.noteIndex)).toEqual([1, 2, 3, 4]);
        expect(custom).toContain('noteType');
        expect(text(document)).toContain('Bibliography');
    });

    it('numbers citations for a numeric style and can export static text', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const live = await exportWith('http://www.zotero.org/styles/ieee');
        expect(text(live.document)).toMatch(/\[1(?:, p\. 2)?\]/);
        const statics = await exportWith('http://www.zotero.org/styles/ieee', { liveCitations: false });
        expect(statics.document).not.toContain('ZOTERO_');
        expect(statics.custom).not.toContain('ZOTERO_PREF');
        expect(text(statics.document)).toMatch(/\[1(?:, p\. 2)?\]/);
    });

    it('resolves legacy library-id citations the same way the renderer keyed their metadata', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        // A legacy tag (`1-KEY`) whose metadata the renderer keyed portably (`u-KEY`).
        const source = {
            ...SOURCE,
            blocks: [{ type: 'markdown', markdown: `Old <citation id="1-${PARENT_ITEM.zotero_key}" loc="s5"/>.` }],
            citations: {
                ...SOURCE.citations,
                citationsByKey: {
                    [`zotero:u-${PARENT_ITEM.zotero_key}:s5`]: {
                        citation_id: 'legacy',
                        resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: PARENT_ITEM.zotero_key },
                        pages: [7],
                    },
                },
            },
        };
        const path = join(dir, `legacy-${Date.now()}.docx`);
        const result = await post<ExportResponse>('/beaver/test/export', { source, path, styleId: 'http://www.zotero.org/styles/apa' });
        const zip = await JSZip.loadAsync(readFileSync(result.path));
        const [field] = fieldJson((await zip.file('word/document.xml')?.async('string')) ?? '');
        expect(field.citationItems[0].locator).toBe('7');
    });

    it('rejects a request without a path', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const result = await post<ExportResponse>('/beaver/test/export', { source: SOURCE });
        expect(result.error).toBe('path is required');
    });
});
