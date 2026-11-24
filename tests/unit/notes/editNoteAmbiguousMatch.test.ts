import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real simplifier, citation expansion, matcher, and position lookup: only the
// leaf modules that reach Zotero, Supabase, or the store are stubbed.
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'test' })),
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
    checkLibraryExcluded: vi.fn(() => null),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { normalizeNoteHtml, simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import { stripDataCitationItems } from '../../../src/utils/noteWrapper';
import { stripSpuriousWrappingTags } from '../../../src/utils/editNoteStrippers';
import { findTargetRawMatchPosition } from '../../../src/utils/editNoteRawPosition';
import { buildAmbiguousMatchHint } from '../../../src/utils/editNotePositionLookup';
import {
    applyResolvedEdits,
    resolveBatchEdits,
    type BatchEditSpec,
    type ResolveBatchContext,
} from '../../../src/utils/editNoteBatchCore';
import type { EditNoteOperation } from '@beaver/agent-core/types/agentActions/editNote';

// =============================================================================
// Fixtures
// =============================================================================

/** A native citation carrying Beaver's private metadata (sentence locators). */
function metaCitation(key: string, beaver: Record<string, unknown>): string {
    const citation = {
        citationItems: [{ uris: [`http://zotero.org/users/1/items/${key}`], locator: '12', beaver }],
        properties: {},
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citation))}">`
        + '(<span class="citation-item">Author, 2024, p. 12</span>)</span>';
}

/** A plain native citation, optionally with a page locator. */
function plainCitation(key: string, page?: string): string {
    const citation = {
        citationItems: [{ uris: [`http://zotero.org/users/1/items/${key}`], ...(page ? { locator: page } : {}) }],
        properties: {},
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citation))}">`
        + `(<span class="citation-item">Giddens${page ? `, p. ${page}` : ''}</span>)</span>`;
}

const NA_CELLS = Array.from({ length: 10 }, () => '<td>\n<p>NA</p>\n</td>').join('\n');

/** A table row whose first cell is `cell`, followed by ten identical `NA` cells. */
function row(cell: string): string {
    return `<tr>\n<td>\n<p>${cell}</p>\n</td>\n${NA_CELLS}\n</tr>`;
}

function table(...cells: string[]): string {
    return `<table>\n<tbody>\n${cells.map(row).join('\n')}\n</tbody>\n</table>`;
}

function context(inner: string): ResolveBatchContext {
    const raw = `<div data-schema-version="9">${inner}</div>`;
    const strippedHtml = stripDataCitationItems(normalizeNoteHtml(raw));
    const { simplified, metadata } = simplifyNoteHtml(raw, 1);
    return {
        strippedHtml, simplified, metadata,
        externalRefContext: { externalRefs: {}, externalItemMapping: {} } as any,
        pageLabels: {}, appendPoint: 0, mode: 'validate',
    };
}

function edit(oldString: string, newString: string, operation: EditNoteOperation = 'str_replace'): BatchEditSpec {
    return { index: 0, operation, oldString, newString };
}

/** Validate, then execute with the normalized data validation produced. */
function validateAndExecute(ctx: ResolveBatchContext, spec: BatchEditSpec) {
    const validated = resolveBatchEdits(ctx, [spec]);
    expect(validated.failures).toEqual([]);
    const target = validated.resolved[0];
    const executed = resolveBatchEdits({ ...ctx, mode: 'execute' }, [{
        ...spec,
        oldString: target.normalizedOldString!,
        newString: target.normalizedNewString!,
        targetBeforeContext: target.targetBeforeContext,
        targetAfterContext: target.targetAfterContext,
    }]);
    expect(executed.failures).toEqual([]);
    expect(executed.resolved[0].applyOps).toEqual(target.applyOps);
    return applyResolvedEdits(ctx.strippedHtml, executed.resolved).newStrippedHtml;
}

/** Simplified text of the edited note, so assertions read in model space. */
function simplifiedAfter(html: string): string {
    return simplifyNoteHtml(html, 1).simplified;
}

beforeEach(() => {
    (globalThis as any).Zotero.Items = {
        getByLibraryAndKey: vi.fn((libraryID: number, key: string) => ({
            id: 1, key, libraryID, isAttachment: () => false,
        })),
    };
});

// =============================================================================
// Ref-aware disambiguation of identical raw HTML
// =============================================================================

describe('old_string pinned to one occurrence by its citation ref', () => {
    it('edits the table row named by its ref when two rows differ only in the ref', () => {
        const giddens = `Anthony Giddens, <em>O mundo</em> ${plainCitation('7AFSW92F')}`;
        const ctx = context(table('Header', giddens, 'Other', giddens));
        const target = '<p>Anthony Giddens, <em>O mundo</em> <citation id="1-7AFSW92F" ref="c_7AFSW92F_1"/></p>';
        expect(ctx.simplified.split(target)).toHaveLength(2);

        const html = validateAndExecute(ctx, edit(target, '<p>O. Shenkar</p>'));
        const rows = simplifiedAfter(html).split('<tr>');
        expect(rows[2]).toContain('Anthony Giddens');
        expect(rows[3]).toContain('Other');
        expect(rows[4]).toContain('O. Shenkar');
        expect(rows[4]).not.toContain('Giddens');
    });

    it.each([
        ['sentence locator read back from Beaver metadata', () => metaCitation('PARENT1', { v: 1, loc: 's8.6-s8.8', att: 'ATTACH01' }),
            '<citation id="1-ATTACH01" loc="s8.6-s8.8" ref="c_ATTACH01_2"/>'],
        ['page locator', () => plainCitation('PARENT1', '12'),
            '<citation id="1-PARENT1" loc="page12" ref="c_PARENT1_2"/>'],
    ])('edits the citation named by its ref among many identical ones (%s)', (_label, cite, tag) => {
        const ctx = context(table(...Array.from({ length: 6 }, () => `Claim ${cite()}`)));
        const target = `<p>Claim ${tag}</p>`;
        expect(ctx.simplified.split(target)).toHaveLength(2);

        const html = validateAndExecute(ctx, edit(target, '<p>Revised</p>'));
        const rows = simplifiedAfter(html).split('<tr>').slice(1);
        expect(rows.map((r) => r.includes('Revised'))).toEqual([false, false, true, false, false, false]);
    });

    it('widens the stored anchors until they alone pick the row, without trusting refs at execute', () => {
        const giddens = `Anthony Giddens ${plainCitation('7AFSW92F')}`;
        const ctx = context(table('Header', giddens, 'Other', giddens));
        const target = '<p>Anthony Giddens <citation id="1-7AFSW92F" ref="c_7AFSW92F_1"/></p>';
        const { resolved, failures } = resolveBatchEdits(ctx, [edit(target, '<p>Shenkar</p>')]);
        expect(failures).toEqual([]);
        const { targetBeforeContext, targetAfterContext, expandedOld, ranges } = resolved[0];
        expect(targetBeforeContext!.length + targetAfterContext!.length).toBeGreaterThan(400);
        expect(findTargetRawMatchPosition(ctx.strippedHtml, expandedOld, targetBeforeContext, targetAfterContext))
            .toBe(ranges[0].start);

        // Fixed 200-char anchors bracket both rows; the executor then refuses
        // rather than choosing by ref, which may have shifted since validation.
        const pos = ranges[0].start;
        const executed = resolveBatchEdits({ ...ctx, mode: 'execute' }, [{
            ...edit(target, '<p>Shenkar</p>'),
            targetBeforeContext: ctx.strippedHtml.substring(pos - 200, pos),
            targetAfterContext: ctx.strippedHtml.substring(pos + expandedOld.length, pos + expandedOld.length + 200),
        }]);
        expect(executed.failures[0]?.errorCode).toBe('ambiguous_match');
    });
});

describe('findTargetRawMatchPosition', () => {
    it('prefers the occurrence both anchors bracket over one matched by a single shared anchor', () => {
        const html = '<p>A x tail</p><p>B x tail</p>';
        // The after-anchor ` tail` sits after both `x`s; only the first is
        // preceded by `<p>A `.
        expect(findTargetRawMatchPosition(html, 'x', '<p>A ', ' tail')).toBe(5);
    });

    it('stays ambiguous when both anchors bracket several occurrences', () => {
        const html = '<p>x</p><p>x</p>';
        expect(findTargetRawMatchPosition(html, 'x', '<p>', '</p>')).toBeNull();
    });
});

// =============================================================================
// Spurious-wrap stripping must not drop self-closing tags
// =============================================================================

describe('self-closing tags are never stripped as wrappers', () => {
    it('keeps a leading citation tag that old_string and new_string share', () => {
        const cite = '<citation id="1-A" loc="s8.6-s8.8" ref="c_A_2"/>';
        const candidates = stripSpuriousWrappingTags(`${cite}</p>`, `${cite} More text.</p>`);
        expect(candidates.map((c) => c.strippedOld)).toEqual([cite]);
    });

    it.each([
        '<image id="i_X" attachment="X" />',
        '<annotation-image id="ai_X" attachment="X" />',
        '<link href="https://example.org"/>',
    ])('does not strip a leading %s', (tag) => {
        const candidates = stripSpuriousWrappingTags(`${tag}text`, `${tag}new`);
        expect(candidates).toEqual([]);
    });

    it('does not reduce a citation-plus-paragraph-end anchor to a bare </p>', () => {
        // The note reads `…<citation …/>.</p>`; old_string drops the period.
        const paragraphs = Array.from({ length: 4 }, (_, i) =>
            `<p>Claim ${i} ${metaCitation('PARENT1', { v: 1, loc: `s8.${i}`, att: 'ATTACH01' })}.</p>`).join('\n');
        const ctx = context(paragraphs);
        const cite = '<citation id="1-ATTACH01" loc="s8.2" ref="c_ATTACH01_2"/>';
        const { resolved, failures } = resolveBatchEdits(ctx, [edit(`${cite}</p>`, `${cite} More.</p>`)]);
        expect(failures).toEqual([]);
        expect(resolved[0].normalizedOldString).toBe(cite);
        expect(resolved[0].matchCount).toBe(1);
    });
});

// =============================================================================
// Actionable ambiguous_match
// =============================================================================

describe('ambiguous_match candidates', () => {
    /** Every candidate must be pasteable: unique, and resolving to its own occurrence. */
    function expectPasteable(ctx: ResolveBatchContext, snippets: string[]) {
        const ranges = snippets.map((snippet) => {
            expect(ctx.simplified.split(snippet)).toHaveLength(2);
            const { resolved, failures } = resolveBatchEdits(ctx, [edit(snippet, snippet.replace('NA', 'Yes'))]);
            expect(failures).toEqual([]);
            const { start, end } = resolved[0].ranges[0];
            return `${start}:${end}`;
        });
        expect(new Set(ranges).size).toBe(ranges.length);
    }

    it('lists each occurrence widened until unique, and each snippet resolves', () => {
        const ctx = context(table('First', 'Second'));
        const { failures } = resolveBatchEdits(ctx, [edit('<p>NA</p>', '<p>Yes</p>')]);
        expect(failures).toHaveLength(1);
        const failure = failures[0];
        expect(failure.errorCode).toBe('ambiguous_match');
        expect(failure.error).toContain('found 20 times');
        expect(failure.error).toContain('str_replace_all');
        expect(failure.error).toContain('Showing 5 of 20 occurrences.');
        expect(failure.candidates).toHaveLength(5);
        for (const c of failure.candidates!) {
            expect(c).toMatchObject({ truncated: false, via: 'ambiguous_occurrence', score: 1 });
            expect(failure.error).toContain(c.snippet);
        }
        expectPasteable(ctx, failure.candidates!.map((c) => c.snippet));
    });

    it('gives two occurrences on one line their own snippets', () => {
        const ctx = context('<p>The NA value and the other NA value differ.</p>');
        const hint = buildAmbiguousMatchHint({ simplified: ctx.simplified, oldString: 'NA value', matchCount: 2, operation: 'str_replace' });
        expect(hint.candidates.map((c) => c.snippet)).toEqual(['<p>The NA value', 'other NA value']);
    });

    it.each([
        ['insert_after', (snippet: string) => snippet.endsWith('NA')],
        ['insert_before', (snippet: string) => snippet.startsWith('NA')],
    ] as const)('keeps the insertion edge of each %s candidate on the occurrence', (operation, keepsEdge) => {
        const ctx = context('<p>Row A NA here</p>\n<p>Row B NA there</p>');
        const { failures } = resolveBatchEdits(ctx, [edit('NA', ' (x)', operation)]);
        expect(failures[0].errorCode).toBe('ambiguous_match');
        const snippets = failures[0].candidates!.map((c) => c.snippet);
        expect(snippets).toHaveLength(2);
        for (const snippet of snippets) {
            expect(keepsEdge(snippet)).toBe(true);
            const html = validateAndExecute(ctx, edit(snippet, ' (x)', operation));
            const at = simplifiedAfter(html).indexOf(operation === 'insert_after' ? 'NA (x)' : ' (x)NA');
            expect(at).toBeGreaterThan(-1);
        }
    });

    it('omits str_replace_all for insert operations', () => {
        const ctx = context(table('First', 'Second'));
        const { failures } = resolveBatchEdits(ctx, [edit('<p>NA</p>', '<p>New</p>', 'insert_after')]);
        expect(failures[0].errorCode).toBe('ambiguous_match');
        expect(failures[0].error).toContain('insertion anchor was found 20 times');
        expect(failures[0].error).not.toContain('str_replace_all');
        expect(failures[0].candidates!.length).toBeGreaterThan(0);
    });

    describe('old_string whose text occurs only next to citations with other refs', () => {
        // Rows _0/_1 and paragraph _2 cite the same item, so all three citations
        // share their raw HTML; only the simplified view tells them apart.
        const giddens = `Anthony Giddens ${plainCitation('7AFSW92F')}`;
        const NOTE = `${table(giddens, giddens)}\n<p>Elsewhere ${plainCitation('7AFSW92F')}.</p>`;

        it.each([
            ['the ref is current but the text around it differs', '<citation id="1-7AFSW92F" ref="c_7AFSW92F_2"/></p>'],
            ['the text matches but the ref is not one of its citations', '<p>Anthony Giddens <citation id="1-7AFSW92F" ref="c_7AFSW92F_2"/></p>'],
        ])('reports not-found, not ambiguous (%s)', (_label, oldString) => {
            const ctx = context(NOTE);
            const { failures } = resolveBatchEdits(ctx, [edit(oldString, '<p>Shenkar</p>')]);
            expect(failures).toHaveLength(1);
            expect(failures[0].errorCode).toBe('old_string_not_found');
            // The explanation is on the first line, which the backend keeps.
            expect(failures[0].error.split('\n')[0]).toContain(
                'not found in the note as written. Its text appears in the note only next to citations with other refs',
            );
            expect(failures[0].error.split('\n')[0]).toContain('Snippet [1] shows where ref="c_7AFSW92F_2" is now');
            expect(failures[0].error).not.toContain('found 2 times');
            // First where the named citation is, then where the text occurs.
            const snippets = failures[0].candidates!.map((c) => c.snippet);
            expect(snippets).toEqual([
                '<p>Elsewhere <citation id="1-7AFSW92F" ref="c_7AFSW92F_2"/>.</p>',
                '<p>Anthony Giddens <citation id="1-7AFSW92F" ref="c_7AFSW92F_0"/></p>',
                '<p>Anthony Giddens <citation id="1-7AFSW92F" ref="c_7AFSW92F_1"/></p>',
            ]);
            for (const snippet of snippets) {
                const { failures: retry } = resolveBatchEdits(ctx, [edit(snippet, '<p>Shenkar</p>')]);
                expect(retry).toEqual([]);
            }
        });
    });

    it('falls back to the count-only message when no occurrence is found in the simplified note', () => {
        const hint = buildAmbiguousMatchHint({ simplified: '<p>Nothing here</p>', oldString: 'absent', matchCount: 3, operation: 'str_replace' });
        expect(hint.candidates).toEqual([]);
        expect(hint.message).toBe(
            'The string to replace was found 3 times in the note. Use operation str_replace_all to '
            + 'replace all occurrences, or include more context to make the match unique.',
        );
    });
});

// =============================================================================
// Errors describe the model's old_string, not a fallback's rewrite
// =============================================================================

describe('fallbacks that drop part of old_string', () => {
    // `<p>Shared</p>` is not in the note. Without its leading `<p>` it matches
    // two paragraph ends; without its trailing `</p>` it matches once.
    const NOTE = '<p>Shared one</p>\n<p>Two Shared</p>\n<p>Three Shared</p>';

    it('skip a wrapper strip that matches several places for one that pins a single target', () => {
        const ctx = context(NOTE);
        const { resolved, failures } = resolveBatchEdits(ctx, [edit('<p>Shared</p>', '<p>Changed</p>')]);
        expect(failures).toEqual([]);
        expect(resolved[0].strategy).toBe('spurious_wrap_strip');
        expect(resolved[0].normalizedOldString).toBe('<p>Shared');
        expect(resolved[0].matchCount).toBe(1);
    });

    it('warn when an edit applied only after dropping part of old_string', () => {
        const ctx = context(NOTE);
        const { resolved } = resolveBatchEdits(ctx, [edit('<p>Shared</p>', '<p>Changed</p>')]);
        expect(resolved[0].warnings).toEqual([
            'old_string "<p>Shared</p>" was not found exactly as written; it matched after removing '
            + '`</p>` from its end, and new_string was adjusted the same way. Check that the edited '
            + 'text reads as intended.',
        ]);
    });

    it('do not warn for an exact match', () => {
        const ctx = context(NOTE);
        const { resolved } = resolveBatchEdits(ctx, [edit('<p>Shared one</p>', '<p>Changed</p>')]);
        expect(resolved[0].warnings).toEqual([]);
    });

    it('report not-found, naming the refused match, when every strip matches several places', () => {
        const ctx = context('<p>Two Shared</p>\n<p>Three Shared</p>');
        const { failures } = resolveBatchEdits(ctx, [edit('<p>Shared</p>', '<p>Changed</p>')]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ errorCode: 'old_string_not_found', strategy: 'spurious_wrap_strip' });
        // The explanation stays on the first line, which the backend keeps as
        // the summary when it renders candidates itself.
        expect(failures[0].error.split('\n')[0]).toContain(
            'The string to replace was not found in the note as written. After removing `<p>` '
            + 'from its start, it would match 2 places, too many to tell which one you meant, '
            + 'so that match was not used.',
        );
        expect(failures[0].error).not.toContain('found 2 times');
    });

    it('never let str_replace_all replace every hit of a stripped needle', () => {
        const ctx = context('<p>Two Shared</p>\n<p>Three Shared</p>');
        const { resolved, failures } = resolveBatchEdits(ctx, [
            edit('<p>Shared</p>', '<p>Changed</p>', 'str_replace_all'),
        ]);
        expect(resolved).toEqual([]);
        expect(failures[0].errorCode).toBe('old_string_not_found');
    });

    it('keep a single-hit strip available to str_replace_all', () => {
        const ctx = context(NOTE);
        const { resolved, failures } = resolveBatchEdits(ctx, [
            edit('<p>Shared</p>', '<p>Changed</p>', 'str_replace_all'),
        ]);
        expect(failures).toEqual([]);
        expect(resolved[0].occurrencesReplaced).toBe(1);
    });
});

describe('ambiguous_match after a re-spelling fallback', () => {
    it('says the count is for the rewritten old_string and names the rewrite', () => {
        const ctx = context('<p>Bob said “yes” twice.</p>\n<p>Then Bob said “yes” again.</p>');
        const { failures } = resolveBatchEdits(ctx, [edit('said "yes"', 'said "no"')]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ errorCode: 'ambiguous_match' });
        expect(failures[0].error).toContain(
            'The string to replace was not found exactly as written; after treating curly and '
            + 'straight quotation marks as equal, it was found 2 times in the note.',
        );
        // Candidates are verbatim note text (curly quotes), each resolving alone.
        const snippets = failures[0].candidates!.map((c) => c.snippet);
        expect(snippets).toEqual(['<p>Bob said “yes” twice.</p>', '<p>Then Bob said “yes” again.</p>']);
        for (const snippet of snippets) {
            const { failures: retry } = resolveBatchEdits(ctx, [edit(snippet, snippet.replace('yes', 'no'))]);
            expect(retry).toEqual([]);
        }
    });

    it('keeps the plain count when old_string itself matched several times', () => {
        const ctx = context('<p>NA</p>\n<p>NA</p>');
        const { failures } = resolveBatchEdits(ctx, [edit('NA', 'Yes')]);
        expect(failures[0]).toMatchObject({ errorCode: 'ambiguous_match', strategy: 'exact' });
        expect(failures[0].error).toMatch(/^The string to replace was found 2 times in the note\./);
    });
});
