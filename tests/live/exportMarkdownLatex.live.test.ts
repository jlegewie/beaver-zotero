/**
 * Live tests for Markdown and LaTeX export (`/beaver/test/export` with
 * `format: 'markdown' | 'latex'` and an explicit source).
 *
 * Exports hand-written markdown citing real library items, an attachment (which
 * cites its parent item) and an external reference, in an author-date, a note
 * and a numeric style, and checks the written files. LaTeX exports are also
 * compiled when `latexmk` is installed.
 *
 * Prerequisites: a running, logged-in dev build of Beaver, the fixture items
 * from `helpers/fixtures.ts`, and the APA, Chicago (notes) and IEEE styles.
 *
 * Run: `ZOTERO_HTTP_PORT=<port> npx vitest run --config vitest.live.config.ts tests/live/exportMarkdownLatex.live.test.ts`
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { NORMAL_PDF, PARENT_ITEM } from '../helpers/fixtures';

let zoteroAvailable = false;
let dir = '';

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    dir = mkdtempSync(join(tmpdir(), 'beaver-export-text-'));
});

afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

const APA = 'http://www.zotero.org/styles/apa';
const CHICAGO_NOTES = 'http://www.zotero.org/styles/chicago-shortened-notes-bibliography';
const IEEE = 'http://www.zotero.org/styles/ieee';

const MARKDOWN = [
    `# Findings`,
    ``,
    `Networks are homophilous <citation id="u-${PARENT_ITEM.zotero_key}" loc="page2"/>. The attachment says so too <citation id="u-${NORMAL_PDF.zotero_key}"/>.`,
    ``,
    `An outside study agrees <citation external_id="W4242"/>. Again <citation id="u-${PARENT_ITEM.zotero_key}"/>. See the note[^a].`,
    ``,
    `[^a]: A remark with 50% & $5 costs.`,
    ``,
    `$$\\hat{\\beta} = \\frac{\\sum_i x_i y_i}{\\sum_i x_i^2}$$`,
    ``,
    `| Study | N |`,
    `|---|--:|`,
    `| Fischer <citation id="u-${PARENT_ITEM.zotero_key}"/> | 1,426 |`,
].join('\n');

const SOURCE = {
    kind: 'response',
    title: 'Live text export test',
    blocks: [{ type: 'markdown', markdown: MARKDOWN }],
    citations: {
        citationsByKey: {},
        externalReferences: {
            W4242: { source: 'openalex', title: 'An Outside Study', authors: ['Ada Lovelace'], year: 1843, journal: { name: 'Notes' }, library_items: [] },
        },
        externalItemMapping: {},
        pageLabelsByAttachmentId: {},
    },
    provenance: { threadId: 'THREAD1', runIds: ['RUN1'] },
};

interface ExportResponse {
    status: 'saved' | 'canceled';
    path: string;
    files: string[];
    warnings: Array<{ code: string; message: string }>;
    stats: Record<string, number>;
    error?: string;
}

async function exportFile(format: 'markdown' | 'latex', styleId: string, extra: Record<string, unknown> = {}) {
    const extension = format === 'markdown' ? 'md' : 'tex';
    const path = join(dir, `${format}-${styleId.split('/').pop()}-${Date.now()}.${extension}`);
    const result = await post<ExportResponse>('/beaver/test/export', { source: SOURCE, path, styleId, format, ...extra });
    return { result, text: result.path ? readFileSync(result.path, 'utf8') : '' };
}

const hasLatexmk = spawnSync('latexmk', ['-v']).status === 0;

/** Compile a .tex file next to its .bib; returns latexmk's exit status. */
function compile(texPath: string, engine: '-lualatex' | '-pdf'): number | null {
    const run = spawnSync('latexmk', [engine, '-interaction=nonstopmode', '-halt-on-error', basename(texPath)], {
        cwd: dirname(texPath),
        encoding: 'utf8',
        timeout: 180_000,
    });
    return run.status;
}

describe('Markdown export (live)', () => {
    it('writes formatted citations, footnotes and a deduplicated bibliography', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, text } = await exportFile('markdown', APA);
        expect(result.status).toBe('saved');
        expect(result.files).toEqual([result.path]);
        expect(result.warnings).toEqual([]);
        expect(result.stats).toMatchObject({ clusters: 5, citations: 5, footnotes: 1, equations: 1 });

        expect(text.startsWith('# Live text export test\n\n# Findings\n')).toBe(true);
        expect(text).toContain('(Lovelace, 1843)');
        expect(text).toMatch(/homophilous \([^)]*, p\. 2\)\./);
        expect(text).toContain('[^1]: A remark with 50% & \\$5 costs.');
        expect(text).toContain('$$\n\\hat{\\beta} = \\frac{\\sum_i x_i y_i}{\\sum_i x_i^2}\n$$');
        expect(text).toMatch(/\| Fischer \([^)]*\) +\| +1,426 \|/);
        // Each work once, after the body.
        const bibliography = text.slice(text.indexOf('# References'));
        expect(bibliography.match(/^Lovelace, A\. \(1843\)\. An Outside Study\. \*Notes\*\.$/m)).toHaveLength(1);
        expect(bibliography.split('\n\n').filter(Boolean)).toHaveLength(1 + result.stats.bibliographyEntries);
    });

    it('writes note-style citations as markdown footnotes', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, text } = await exportFile('markdown', CHICAGO_NOTES);
        // Five citation notes plus the markdown footnote, in one sequence.
        expect(result.stats.footnotes).toBe(6);
        expect(text).toContain('homophilous[^1]. The attachment says so too[^2].');
        expect(text).toContain('See the note[^5].');
        expect(text).toMatch(/^\[\^3\]: Lovelace, “An Outside Study\.”$/m);
        expect(text.indexOf('[^6]:')).toBeLessThan(text.indexOf('# Bibliography'));
    });

    it('writes front matter when asked', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { text } = await exportFile('markdown', APA, { frontMatter: true });
        expect(text).toMatch(/^---\ntitle: "Live text export test"\ndate: "\d{4}-\d{2}-\d{2}"\nsource: "zotero:\/\/beaver\/thread\/THREAD1\/run\/RUN1"\n---\n\n# Findings\n/);
    });
});

describe('LaTeX export (live)', () => {
    it('cites keys of a .bib file written next to the .tex file', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, text } = await exportFile('latex', APA);
        expect(result.status).toBe('saved');
        expect(result.warnings).toEqual([]);
        expect(result.files).toHaveLength(2);
        const [texPath, bibPath] = result.files;
        expect(bibPath).toBe(texPath.replace(/\.tex$/, '.bib'));
        const bib = readFileSync(bibPath, 'utf8');
        expect(bib.startsWith('% Exported by Beaver')).toBe(true);
        // No local attachment paths leave with the bibliography.
        expect(bib).not.toMatch(/^\s*file\s*=/m);

        const keys = [...bib.matchAll(/^@\w+\{([^,]+),/gm)].map(match => match[1]);
        expect(keys).toHaveLength(3);
        const cited = [...text.matchAll(/\\parencite(?:\[[^\]]*\])?\{([^}]+)\}/g)].flatMap(match => match[1].split(','));
        expect(new Set(cited)).toEqual(new Set(keys));
        expect(text).toMatch(/\\parencite\[2\]\{[^}]+\}/);
        expect(text).toContain(`\\addbibresource{${basename(bibPath)}}`);
        expect(text).toContain('\\usepackage[backend=biber,style=authoryear]{biblatex}');
        expect(text).toContain('\\footnote{A remark with 50\\% \\& \\$5 costs.}');
        expect(result.stats).toMatchObject({ citations: 5, citationsAsText: 0, equations: 1 });

        if (hasLatexmk) expect(compile(texPath, '-lualatex')).toBe(0);
    }, 240_000);

    it('uses natbib and BibTeX entries when asked, with a numeric style', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, text } = await exportFile('latex', IEEE, { citationPackage: 'natbib' });
        expect(text).toContain('\\usepackage[numbers,sort&compress]{natbib}');
        expect(text).toContain('\\bibliographystyle{unsrtnat}');
        expect(text).toMatch(/\\citep\[p\.~2\]\{[^}]+\}/);
        if (hasLatexmk) expect(compile(result.files[0], '-pdf')).toBe(0);
    }, 240_000);

    it('cites note styles with footnotes, including from table cells', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { result, text } = await exportFile('latex', CHICAGO_NOTES);
        expect(text).toContain('style=verbose,autocite=footnote');
        expect(text).toMatch(/homophilous\\autocite\[2\]\{[^}]+\}\./);
        // The table's note is a mark in the cell and a text after the table.
        expect(text).toMatch(/Fischer\\footnotemark\[6\]/);
        expect(text).toMatch(/\\setcounter\{footnote\}\{6\}\\footcitetext\{[^}]+\}/);
        expect(result.stats.footnotes).toBe(6);
        if (hasLatexmk) expect(compile(result.files[0], '-lualatex')).toBe(0);
    }, 240_000);

    it('never replaces a .bib file it did not write', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const texPath = join(dir, `own-bib-${Date.now()}.tex`);
        const ownBib = texPath.replace(/\.tex$/, '.bib');
        writeFileSync(ownBib, '@book{mine, title = {Mine}}\n');
        const result = await post<ExportResponse>('/beaver/test/export', { source: SOURCE, path: texPath, styleId: APA, format: 'latex' });
        expect(readFileSync(ownBib, 'utf8')).toBe('@book{mine, title = {Mine}}\n');
        expect(result.files[1]).toBe(texPath.replace(/\.tex$/, '-2.bib'));
        expect(readFileSync(result.files[0], 'utf8')).toContain(`\\addbibresource{${basename(result.files[1])}}`);

        // A second export to the same name replaces the file the first one wrote.
        const again = await post<ExportResponse>('/beaver/test/export', { source: SOURCE, path: texPath, styleId: APA, format: 'latex' });
        expect(again.files[1]).toBe(result.files[1]);
        expect(existsSync(texPath.replace(/\.tex$/, '-3.bib'))).toBe(false);
    });

    it('writes only the body when asked', async (ctx) => {
        skipIfNoZotero(ctx, zoteroAvailable);
        const { text } = await exportFile('latex', APA, { standalone: false });
        expect(text).not.toContain('\\documentclass');
        expect(text).toMatch(/^% Exported by Beaver: document body/);
        expect(text).toMatch(/add \\addbibresource\{[^}]+\.bib\} to the preamble/);
    });
});
