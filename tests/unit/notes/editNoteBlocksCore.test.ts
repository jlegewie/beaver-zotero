// @vitest-environment jsdom

/**
 * Tests for the pure `edit_note_blocks` addressing engine.
 *
 * These are a MERGE GATE, not a nice-to-have: the live tier gives this code
 * essentially zero coverage (the whole dev library has 1 note with annotations —
 * 0 multiline — 6 with math — 2 multiline — 1 with `<pre>` — 1 multiline, and 26
 * with tables). Fixtures are therefore built by running the REAL
 * `normalizeNoteHtml` + `simplifyNoteHtml` wherever possible, rather than by
 * hand-writing simplified strings the real pipeline would never produce. The
 * handful of hand-built fixtures are marked and exist only for latent cases the
 * real pipeline cannot currently emit (multiline annotations, footer-detector
 * disagreement, leading whitespace).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module mocks (must precede imports)
// =============================================================================

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: '1', localUserKey: 'test-user' })),
}));

// noteCitationExpand gates citation targets on the library-exclusion check,
// which reads the Jotai store; stub it so unit tests treat every library as
// searchable.
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
    checkLibraryExcluded: vi.fn(() => null),
}));

const loggerMock = vi.fn();
vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: (...args: any[]) => loggerMock(...args),
}));

// Wire Zotero.getMainWindow() to jsdom's window for ProseMirror DOM access.
beforeAll(() => {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        getMainWindow: () => globalThis.window,
    };
});

import { normalizeNoteHtml, simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import type { SimplificationMetadata } from '../../../src/utils/noteHtmlSimplifier';
import { stripDataCitationItems } from '../../../src/utils/noteWrapper';
import { applyResolvedEdits } from '../../../src/utils/editNoteBatchCore';
import type { ResolvedBatchEdit } from '../../../src/utils/editNoteBatchCore';
import {
    buildBlockRawIndex,
    isContainerTag,
    isRangeBalanced,
    matchExpect,
    projectVisibleText,
    seamIsStructural,
    selectBlockEdits,
    verifyLineProjection,
    type BlockEditSpec,
    type BlockRawIndex,
    type SelectBlockEditsResult,
} from '../../../src/utils/editNoteBlocksCore';

/** Boolean view of {@link matchExpect}'s prefix regime, for readable asserts. */
function matchesExpect(expect: string, line: string): boolean {
    return matchExpect(expect, line) === 'match';
}

// =============================================================================
// Fixture helpers — the REAL pipeline
// =============================================================================

const WRAPPER_OPEN = '<div data-schema-version="9">';

interface Fixture {
    raw: string;
    strippedHtml: string;
    simplified: string;
    metadata: SimplificationMetadata;
}

/** Run the real normalize + simplify pipeline over one note body. */
function fixture(innerHtml: string): Fixture {
    const raw = `${WRAPPER_OPEN}${innerHtml}</div>`;
    const strippedHtml = stripDataCitationItems(normalizeNoteHtml(raw));
    const { simplified, metadata } = simplifyNoteHtml(raw, 1);
    return { raw, strippedHtml, simplified, metadata };
}

function buildIndex(f: Fixture): BlockRawIndex {
    const result = buildBlockRawIndex(f.simplified, f.strippedHtml, f.metadata);
    if (!result.ok) throw new Error(`buildBlockRawIndex refused: ${result.error}`);
    return result.index;
}

function refusalOf(f: Fixture | { simplified: string; strippedHtml: string; metadata: SimplificationMetadata }) {
    const result = buildBlockRawIndex(f.simplified, f.strippedHtml, f.metadata);
    expect(result.ok).toBe(false);
    return result as { ok: false; error: string; errorCode: string };
}

/** A raw Zotero citation span, with itemData so PM regenerates visible text. */
function rawCitation(
    items: Array<{ key: string; locator?: string; family?: string; year?: string }>,
): string {
    const data = {
        citationItems: items.map((it) => ({
            uris: [`http://zotero.org/users/1/items/${it.key}`],
            ...(it.locator ? { locator: it.locator } : {}),
            itemData: {
                id: `http://zotero.org/users/1/items/${it.key}`,
                type: 'article-journal',
                author: [{ family: it.family ?? 'Smith', given: 'J' }],
                issued: { 'date-parts': [[it.year ?? '2019']] },
            },
        })),
        properties: {},
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(data))}">()</span>`;
}

function rawAnnotation(key: string, text: string): string {
    const data = { annotationKey: key, color: '#ffd400', pageLabel: '3' };
    return `<span class="highlight" data-annotation="${encodeURIComponent(JSON.stringify(data))}">${text}</span>`;
}

const EDIT_FOOTER = '<p><span style="color: rgb(170, 170, 170);">Edited by Beaver · '
    + '<a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
const CREATED_FOOTER = '<p><span style="color: rgb(170, 170, 170);">Created by Beaver · '
    + '<a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat</a></span></p>';

// =============================================================================
// Edit builders — `expect` is filled from the fixture so tests stay readable
// =============================================================================

function replaceEdit(index: BlockRawIndex, block: number, content: string, i = 0): BlockEditSpec {
    return { index: i, op: 'replace', block, content, expect: index.simplifiedLines[block - 1] };
}

function insertEdit(after: number | 'end', content: string, i = 0): BlockEditSpec {
    return { index: i, op: 'insert', after, content };
}

function deleteEdit(index: BlockRawIndex, from: number, to?: number, i = 0): BlockEditSpec {
    const spec: BlockEditSpec = {
        index: i,
        op: 'delete',
        block: from,
        expect: index.simplifiedLines[from - 1],
    };
    if (to !== undefined && to !== from) {
        spec.to = to;
        spec.expect_end = index.simplifiedLines[to - 1];
    }
    return spec;
}

function select(index: BlockRawIndex, edits: BlockEditSpec[], extra: Record<string, unknown> = {}) {
    // A numbered insert anchor requires `expect`; fill it from the fixture so
    // the many tests that target OTHER gates stay readable. Tests exercising
    // the requirement itself call selectBlockEdits directly.
    const filled = edits.map((e) => (
        e.op === 'insert' && typeof e.after === 'number' && e.after >= 1 && e.expect === undefined
            ? { ...e, expect: index.simplifiedLines[e.after - 1] ?? '' }
            : e
    ));
    return selectBlockEdits({ index, ...extra } as any, filled);
}

function expectOk(result: SelectBlockEditsResult) {
    if (!result.ok) throw new Error(`unexpected refusal: ${result.error}`);
    return result;
}

/** Skip codes for a selection, in request order. */
function skipCodes(result: SelectBlockEditsResult): string[] {
    return expectOk(result).skipped.map((s) => s.reason_code);
}

function applyAll(index: BlockRawIndex, result: SelectBlockEditsResult): string {
    const ok = expectOk(result);
    const resolved: ResolvedBatchEdit[] = ok.applied.map((a) => a.resolved);
    return applyResolvedEdits(index.strippedHtml, resolved).newStrippedHtml;
}

// =============================================================================
// The kitchen-sink fixture
// =============================================================================

const KITCHEN_INNER =
    `<p>Intro paragraph with ${rawCitation([{ key: 'K1', locator: '5' }])} inline.</p>`
    + '<ul><li><p>first item</p></li><li><p>second item</p></li></ul>'
    + '<table><tr><td><p>cell a</p></td><td><p>cell b</p></td></tr></table>'
    + '<blockquote><p>quoted material here</p></blockquote>'
    + '<pre class="math">$$E = mc^2$$</pre>'
    + '<pre>const x = 1;</pre>'
    + '<hr>'
    + '<p>Picture <img data-attachment-key="ATT1" width="10" height="10"></p>'
    + `<p>${rawAnnotation('A1', 'highlighted words')} plus my own comment.</p>`
    + '<p><a href="https://example.com/x" rel="noopener noreferrer nofollow">https://example.com/x</a></p>'
    + '<p><a href="zotero://open-pdf/library/items/ZZZ?page=2" rel="noopener noreferrer nofollow">open the pdf</a></p>'
    + '<p><a href="mailto:someone@example.com" rel="noopener noreferrer nofollow">someone@example.com</a></p>';

/** Block number of the first simplified line matching `pattern`. */
function blockOf(index: BlockRawIndex, pattern: string | RegExp): number {
    const at = index.simplifiedLines.findIndex((l) =>
        typeof pattern === 'string' ? l.includes(pattern) : pattern.test(l));
    if (at === -1) throw new Error(`no simplified line matching ${String(pattern)}`);
    return at + 1;
}

// =============================================================================
// PART 1 — index construction
// =============================================================================

describe('buildBlockRawIndex — alignment round-trip', () => {
    it('maps every simplified block to a raw line across the full element zoo', () => {
        const f = fixture(KITCHEN_INNER);
        const index = buildIndex(f);

        // Same-space count postcondition.
        expect(index.rawLineRanges.length).toBe(f.simplified.split('\n').length);

        // The walk consumed every line up to `</div>`: ranges are contiguous and
        // the last one ends exactly at bodyEnd.
        expect(index.rawLineRanges[0].start).toBe(index.bodyStart);
        expect(index.rawLineRanges[index.rawLineRanges.length - 1].end).toBe(index.bodyEnd);
        for (let i = 1; i < index.rawLineRanges.length; i++) {
            expect(index.rawLineRanges[i].start).toBe(index.rawLineRanges[i - 1].end + 1);
            expect(f.strippedHtml[index.rawLineRanges[i - 1].end]).toBe('\n');
        }

        // Every addressed line projects consistently (or is exempt).
        for (let n = 1; n <= index.rawLineRanges.length; n++) {
            const check = verifyLineProjection(index, n);
            expect(check.status).not.toBe('mismatch');
        }
    });

    it('lines up citation, image, list, table, blockquote, math, pre and hr lines byte-for-byte where they are verbatim', () => {
        const f = fixture(KITCHEN_INNER);
        const index = buildIndex(f);
        const rawLine = (n: number) =>
            f.strippedHtml.slice(index.rawLineRanges[n - 1].start, index.rawLineRanges[n - 1].end);

        // Lines the simplifier does not rewrite are byte-identical on both sides.
        for (const marker of ['<ul>', '</ul>', '<li>', '</li>', '<table>', '<tr>', '<td>',
            '<blockquote>', '</blockquote>', '<hr>', 'first item', 'quoted material here']) {
            const n = blockOf(index, marker);
            expect(rawLine(n)).toBe(index.simplifiedLines[n - 1]);
        }

        // Lines the simplifier DOES rewrite differ, but occupy the same block.
        const citationBlock = blockOf(index, '<citation ');
        expect(rawLine(citationBlock)).toContain('data-citation=');
        expect(index.simplifiedLines[citationBlock - 1]).toContain('ref="c_K1_0"');

        const imageBlock = blockOf(index, '<image ');
        expect(rawLine(imageBlock)).toContain('data-attachment-key="ATT1"');

        const mathBlock = blockOf(index, '$$E = mc^2$$');
        expect(rawLine(mathBlock)).toBe('<pre class="math">$$E = mc^2$$</pre>');
    });

    it('records opaque spans in SIMPLIFIED coordinates only — no raw-side extent, no pairing', () => {
        const f = fixture(KITCHEN_INNER);
        const index = buildIndex(f);
        expect(index.spans.length).toBeGreaterThan(0);
        for (const span of index.spans) {
            expect(Object.keys(span).sort()).toEqual(['end', 'endLine', 'kind', 'start', 'startLine']);
            // The recorded offsets index `simplified`, never `strippedHtml`.
            expect(f.simplified.slice(span.start, span.end)).not.toBe('');
            expect(span.end).toBeLessThanOrEqual(f.simplified.length);
        }
        // The index itself exposes no raw-side span structure.
        expect(Object.keys(index)).not.toContain('rawSpans');
        expect(Object.keys(index)).not.toContain('spanPairs');
    });
});

describe('buildBlockRawIndex — the walk postcondition', () => {
    it('refuses when the simplified view has one line MORE than the note (drift +1)', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const refusal = refusalOf({ ...f, simplified: `${f.simplified}\n<p>Ghost</p>` });
        expect(refusal.errorCode).toBe('address_resolution_failed');
        expect(refusal.error).toMatch(/op:"rewrite"/);
    });

    it('refuses when the simplified view has one line FEWER than the note (drift -1)', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const shortened = f.simplified.split('\n').slice(0, -1).join('\n');
        expect(refusalOf({ ...f, simplified: shortened }).errorCode).toBe('address_resolution_failed');
    });

    it('accepts a REAL footered note — pre-normalize strip is 0 lines while raw-vs-simplified differs by 2', () => {
        // This is the regression guard for the defect that would otherwise have
        // refused every note Beaver has ever touched: a walk conditioned on a
        // PRE-normalize strip count would see 0 and skip nothing.
        const f = fixture(`<p>Alpha</p><p>Beta</p>${CREATED_FOOTER}${EDIT_FOOTER}`);
        const rawLineTotal = f.strippedHtml.split('\n').length;
        const simplifiedLineTotal = f.simplified.split('\n').length;
        expect(rawLineTotal - simplifiedLineTotal).toBe(2);

        const index = buildIndex(f);
        expect(index.footerRanges.length).toBe(2);
        expect(index.rawLineRanges.length).toBe(simplifiedLineTotal);
        // No footer byte is inside any addressable range.
        for (const range of index.rawLineRanges) {
            for (const footer of index.footerRanges) {
                expect(range.start < footer.end && footer.start < range.end).toBe(false);
            }
        }
    });

    it('refuses unmodelled displacement: a newline-eating simplification', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const eaten = f.simplified.replace('<p>Alpha</p>\n<p>Beta</p>', '<p>Alpha</p><p>Beta</p>');
        expect(refusalOf({ ...f, simplified: eaten }).errorCode).toBe('address_resolution_failed');
    });

    it('refuses stray non-footer content sitting before </div>', () => {
        const f = fixture('<p>Alpha</p>');
        const withStray = f.strippedHtml.replace('</div>', '<p>stray</p>\n</div>');
        expect(refusalOf({ ...f, strippedHtml: withStray }).errorCode).toBe('address_resolution_failed');
    });

    it('refuses a footer shape the POST-normalize detectors miss (one extra kept line)', () => {
        // A footer-looking paragraph that `parseEditFooter` does NOT recognise
        // (no styled span), but which the simplified view does not contain.
        const f = fixture('<p>Alpha</p>');
        const unrecognised = f.strippedHtml.replace(
            '</div>',
            '<p>Edited by Beaver</p>\n</div>',
        );
        expect(refusalOf({ ...f, strippedHtml: unrecognised }).errorCode).toBe('address_resolution_failed');
    });

    it('refuses a footer only the POST-normalize side recognises (one range short)', () => {
        // The note carries a real footer, but the simplified view still shows it
        // (as if the pre-normalize strip had missed it).
        const f = fixture(`<p>Alpha</p>${EDIT_FOOTER}`);
        const leaked = f.simplified.replace('<p>Alpha</p>\n', `<p>Alpha</p>\n${EDIT_FOOTER}\n`);
        expect(refusalOf({ ...f, simplified: leaked }).errorCode).toBe('address_resolution_failed');
    });

    it('never falls back to a zero-skip walk', () => {
        // With the footer present but the simplified view one line short of the
        // zero-skip count AND one line off the skip count, both readings fail —
        // and the engine refuses rather than picking one.
        const f = fixture(`<p>Alpha</p>${EDIT_FOOTER}`);
        const badBoth = `${f.simplified}\nextra`;
        expect(refusalOf({ ...f, simplified: badBoth }).errorCode).toBe('address_resolution_failed');
    });
});

describe('buildBlockRawIndex — the newline precondition', () => {
    it('refuses when a rewritten inline element spans a newline', () => {
        // Hand-built: the real pipeline cannot currently emit this, which is
        // exactly why the guard has to be explicit.
        const strippedHtml = `${WRAPPER_OPEN}<p>Before <span class="citation"\ndata-citation="x">(A)</span></p>\n</div>`;
        const simplified = '<p>Before <citation id="1-K" ref="c_K_0"/></p>\n';
        const metadata: SimplificationMetadata = {
            elements: new Map([
                ['c_K_0', { rawHtml: '<span class="citation"\ndata-citation="x">(A)</span>', type: 'citation' as const }],
            ]),
        };
        const refusal = refusalOf({ simplified, strippedHtml, metadata });
        expect(refusal.errorCode).toBe('address_resolution_failed');
        expect(refusal.error).toMatch(/spans a line break/);
    });

    it('does NOT refuse a multiline annotation — its inner text is preserved verbatim', () => {
        const fx = multilineAnnotationFixture();
        expect(buildBlockRawIndex(fx.simplified, fx.strippedHtml, fx.metadata).ok).toBe(true);
    });
});

describe('buildBlockRawIndex — body boundaries', () => {
    it('detects the wrapper prefix and starts block 1 just past it', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        expect(index.bodyStart).toBe(WRAPPER_OPEN.length);
        expect(index.rawLineRanges[0].start).toBe(index.bodyStart);
        expect(f.strippedHtml.slice(index.rawLineRanges[0].start, index.rawLineRanges[0].end))
            .toBe('<p>Alpha</p>');
    });

    it('uses strippedHtml coordinates, NOT trim()ed coordinates', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const padded = { ...f, strippedHtml: `\n   ${f.strippedHtml}` };
        const index = buildIndex(padded);
        expect(index.bodyStart).toBe(4 + WRAPPER_OPEN.length);
        // A splice on the padded note lands on the same text as on the unpadded one.
        const result = select(index, [replaceEdit(index, 2, '<p>Beta 2</p>')]);
        const applied = applyAll(index, result);
        expect(applied).toBe(`\n   ${f.strippedHtml.replace('<p>Beta</p>', '<p>Beta 2</p>')}`);
    });

    it('refuses (whole call) when the wrapper cannot be stripped', () => {
        const strippedHtml = `${WRAPPER_OPEN}<div><p>a</p>\n</div>`;
        const refusal = refusalOf({
            simplified: '<div><p>a</p>\n',
            strippedHtml,
            metadata: { elements: new Map() },
        });
        expect(refusal.errorCode).toBe('address_resolution_failed');
        expect(refusal.error).toMatch(/op:"rewrite"/);
    });
});

describe('buildBlockRawIndex — footer matrix', () => {
    const cases: Array<[string, string]> = [
        ['neither', '<p>Alpha</p><p>Beta</p>'],
        ['created only', `<p>Alpha</p><p>Beta</p>${CREATED_FOOTER}`],
        ['edit only', `<p>Alpha</p><p>Beta</p>${EDIT_FOOTER}`],
        ['both', `<p>Alpha</p><p>Beta</p>${CREATED_FOOTER}${EDIT_FOOTER}`],
    ];
    for (const [name, inner] of cases) {
        it(`satisfies the count postcondition: ${name}`, () => {
            const f = fixture(inner);
            const index = buildIndex(f);
            expect(index.rawLineRanges.length).toBe(f.simplified.split('\n').length);
            expect(index.simplifiedLines[0]).toBe('<p>Alpha</p>');
            expect(index.simplifiedLines[1]).toBe('<p>Beta</p>');
        });
    }

    it('satisfies the count postcondition when a footer is matched by simplify but not byte-identical post-normalize', () => {
        // ProseMirror rewrites `color: #aaa` to `color: rgb(170, 170, 170)`, so
        // the footer in the stored note is NOT the bytes the simplifier stripped.
        const hexFooter = '<p><span style="color: #aaa;">Edited by Beaver · '
            + '<a href="zotero://beaver/thread/t1" rel="noopener noreferrer nofollow">Chat 1</a></span></p>';
        const f = fixture(`<p>Alpha</p>${hexFooter}`);
        expect(f.strippedHtml).toContain('rgb(170, 170, 170)');
        expect(f.strippedHtml).not.toContain('#aaa');
        const index = buildIndex(f);
        expect(index.rawLineRanges.length).toBe(f.simplified.split('\n').length);
        expect(index.footerRanges.length).toBe(1);
    });

    // ONLY footer-claimed lines may be skipped. A walk that also skipped blank
    // or whitespace-only lines would trade a loud refusal for a silent
    // misalignment, so the rule needs its own pin.
    it('does NOT skip blank or whitespace-only lines', () => {
        const f = fixture('<p>Alpha</p><p> </p><p></p><p>Beta</p>');
        const index = buildIndex(f);
        expect(index.rawLineRanges.length).toBe(f.simplified.split('\n').length);
        expect(index.footerRanges.length).toBe(0);
        // Every kept line is addressable, including the empty-projection ones.
        for (let n = 1; n <= index.rawLineRanges.length; n++) {
            expect(verifyLineProjection(index, n).status).not.toBe('mismatch');
        }
    });

    // `insert after: 0` anchors on the first KEPT line, not on `bodyStart`;
    // the two differ only when a footer leads the body.
    it('anchors insert after:0 on the first kept line, below a leading footer', () => {
        const f = fixture(`${CREATED_FOOTER}<p>Alpha</p>`);
        const index = buildIndex(f);
        expect(index.footerRanges.length).toBe(1);
        expect(index.rawLineRanges[0].start).toBeGreaterThan(index.bodyStart);
        const applied = applyAll(index, select(index, [insertEdit(0, '<p>Head</p>')]));
        expect(applied.indexOf('Created by Beaver')).toBeLessThan(applied.indexOf('<p>Head</p>'));
        expect(applied).toContain(CREATED_FOOTER);
        expect(applied).toContain('<p>Head</p>\n<p>Alpha</p>');
    });
});

// =============================================================================
// PART 1d — token-aware projection
// =============================================================================

describe('verifyLineProjection', () => {
    it('passes on a citation-bearing line (the 48%-of-notes guard)', () => {
        const f = fixture(`<p>Intro with ${rawCitation([{ key: 'K1', locator: '5' }])} inline.</p>`);
        const index = buildIndex(f);
        // Raw and simplified genuinely differ here: the raw citation projects to
        // visible text, the simplified token projects to nothing.
        const rawLine = f.strippedHtml.slice(index.rawLineRanges[0].start, index.rawLineRanges[0].end);
        expect(projectVisibleText(rawLine)).not.toBe(projectVisibleText(index.simplifiedLines[0]));
        expect(verifyLineProjection(index, 1).status).toBe('match');
    });

    it('passes on a <link/> line', () => {
        const f = fixture('<p><a href="https://example.com/x" rel="noopener noreferrer nofollow">https://example.com/x</a></p>');
        const index = buildIndex(f);
        expect(index.simplifiedLines[0]).toContain('<link href=');
        expect(verifyLineProjection(index, 1).status).toBe('match');
    });

    it('passes on ordinary anchors the simplifier leaves VERBATIM (the 21%-of-notes guard)', () => {
        // Metadata-driven masking must mask NEITHER of these: a blanket
        // "mask raw <a> wherever simplified has a token" rule would false-fail
        // 21% of notes.
        const f = fixture(
            '<p><a href="zotero://open-pdf/library/items/ZZZ?page=2" rel="noopener noreferrer nofollow">open the pdf</a></p>'
            + '<p><a href="mailto:someone@example.com" rel="noopener noreferrer nofollow">someone@example.com</a></p>',
        );
        const index = buildIndex(f);
        expect(index.simplifiedLines[0]).toContain('zotero://open-pdf');
        expect(index.simplifiedLines[1]).toContain('mailto:');
        expect(verifyLineProjection(index, 1).status).toBe('match');
        expect(verifyLineProjection(index, 2).status).toBe('match');
    });

    it('fails on a genuinely misaligned line', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const swapped = { ...f, simplified: f.simplified.replace('<p>Beta</p>', '<p>Totally different</p>') };
        const index = buildIndex(swapped);
        const check = verifyLineProjection(index, 2);
        expect(check.status).toBe('mismatch');
    });

    it('degrades a mask miss to "unverified", never to a refusal', () => {
        const f = fixture(`<p>Intro with ${rawCitation([{ key: 'K1', locator: '5' }])} inline.</p>`);
        // Simulate the latent key-collision case: the stored rawHtml no longer
        // matches this occurrence's raw line.
        const stored = f.metadata.elements.get('c_K1_0')!;
        f.metadata.elements.set('c_K1_0', { ...stored, rawHtml: '<span class="citation" data-citation="OTHER">()</span>' });
        const index = buildIndex(f);

        const check = verifyLineProjection(index, 1);
        expect(check.status).toBe('unverified');

        // And the whole call still succeeds.
        const result = select(index, [replaceEdit(index, 1, '<p>Replaced.</p>')]);
        const ok = expectOk(result);
        expect(ok.applied).toHaveLength(1);
        expect(ok.unverifiedBlocks).toEqual([1]);
    });

    // Citations are the ONE element class that cannot actually hit the
    // key-collision case (`c_${key}_${occurrence}` is occurrence-counted).
    // Images, annotations, annotation-images and links are keyed WITHOUT an
    // occurrence counter, so they are the classes that really collide — cover
    // one of those too, or the hardening is only tested where it can't fire.
    it('degrades a mask miss on a non-citation element (image) to "unverified"', () => {
        const f = fixture('<p>Picture <img data-attachment-key="ATT1" width="10" height="10"></p>');
        const stored = f.metadata.elements.get('i_ATT1')!;
        // Second occurrence of the same attachment with different attributes
        // overwrites the first entry — what the real collision looks like.
        f.metadata.elements.set('i_ATT1', {
            ...stored,
            rawHtml: '<img data-attachment-key="ATT1" width="640" height="480">',
        });
        const index = buildIndex(f);

        const check = verifyLineProjection(index, 1);
        expect(check.status).toBe('unverified');

        const result = select(index, [replaceEdit(index, 1, '<p>Replaced.</p>')]);
        const ok = expectOk(result);
        expect(ok.applied).toHaveLength(1);
        expect(ok.unverifiedBlocks).toEqual([1]);
    });

    it('escalates a real projection mismatch on an ADDRESSED line to a whole-call refusal', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const swapped = { ...f, simplified: f.simplified.replace('<p>Beta</p>', '<p>Totally different</p>') };
        const index = buildIndex(swapped);
        const result = select(index, [replaceEdit(index, 2, '<p>New</p>')]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errorCode).toBe('address_resolution_failed');
    });

    // A delete verifies EVERY line in its range, not just `block` — a guard
    // that only checked the first line would splice a misaligned tail away.
    it('verifies every line of a multi-block delete, not just the first', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const drifted = { ...f, simplified: f.simplified.replace('<p>Gamma</p>', '<p>Totally different</p>') };
        const index = buildIndex(drifted);
        const result = select(index, [deleteEdit(index, 1, 3)]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errorCode).toBe('address_resolution_failed');
    });

    it("verifies an insert's anchor block", () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const drifted = { ...f, simplified: f.simplified.replace('<p>Beta</p>', '<p>Totally different</p>') };
        const index = buildIndex(drifted);
        const result = select(index, [insertEdit(2, '<p>New</p>')]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errorCode).toBe('address_resolution_failed');
    });
});

// =============================================================================
// PART 2 — classifiers
// =============================================================================

describe('container classification (default-deny)', () => {
    it('treats unknown paired elements as containers', () => {
        expect(isContainerTag('figure', false)).toBe(true);
        expect(isContainerTag('some-future-container', false)).toBe(true);
        expect(isContainerTag('section', false)).toBe(true);
    });

    it('excludes void elements, self-closing tags and inline elements', () => {
        for (const voidTag of ['hr', 'img', 'col', 'br', 'wbr']) {
            expect(isContainerTag(voidTag, false)).toBe(false);
        }
        expect(isContainerTag('citation', true)).toBe(false);
        expect(isContainerTag('link', true)).toBe(false);
        for (const inline of ['a', 'span', 'em', 'strong', 'code']) {
            expect(isContainerTag(inline, false)).toBe(false);
        }
    });

    it('excludes `annotation` explicitly so span rules own it', () => {
        expect(isContainerTag('annotation', false)).toBe(false);
        expect(isRangeBalanced('<annotation id="a_X">only the opening half')).toBe(true);
    });
});

describe('isRangeBalanced — a STACK check, not opens === closes', () => {
    it('rejects the count-balanced `</li>` + `<li>` seam', () => {
        expect(isRangeBalanced('</li>\n<li>')).toBe(false);
    });

    it('accepts whole structures', () => {
        expect(isRangeBalanced('<li>\ncontent\n</li>')).toBe(true);
        expect(isRangeBalanced('<ul>\n<li>\na\n</li>\n</ul>')).toBe(true);
        expect(isRangeBalanced('<blockquote>\n<p>q</p>\n</blockquote>')).toBe(true);
    });

    it('is not confused by void elements or simplified tokens', () => {
        expect(isRangeBalanced('<hr>')).toBe(true);
        expect(isRangeBalanced('<p>x <img alt="" data-attachment-key="A"> y</p>')).toBe(true);
        expect(isRangeBalanced('<colgroup>\n<col>\n<col>\n</colgroup>')).toBe(true);
        expect(isRangeBalanced('<p><citation id="1-K" ref="c_K_0"/></p>')).toBe(true);
        expect(isRangeBalanced('<p><link href="https://a.b/c"/></p>')).toBe(true);
    });

    it('rejects mismatched nesting', () => {
        expect(isRangeBalanced('<ul>\n<li>\n</ul>')).toBe(false);
        expect(isRangeBalanced('</ul>')).toBe(false);
        expect(isRangeBalanced('<blockquote>\n<p>q</p>')).toBe(false);
    });
});

describe('seamIsStructural', () => {
    const lines = ['<ul>', '<li>', 'a', '</li>', '</ul>', '<p>after</p>'];
    it('flags a seam inside a structural-only container', () => {
        expect(seamIsStructural(lines, 1)).toBe(true); // between <ul> and <li>
        expect(seamIsStructural(lines, 4)).toBe(true); // after </li>, still inside <ul>
    });
    it('allows seams at container boundaries', () => {
        expect(seamIsStructural(lines, 5)).toBe(false); // after </ul>
        expect(seamIsStructural(lines, 6)).toBe(false); // top level
        expect(seamIsStructural(lines, 2)).toBe(false); // inside <li>, which admits text
    });
});

// =============================================================================
// PART 2e — the expect contract
// =============================================================================

describe('matchExpect', () => {
    describe('outcome classification', () => {
        const line = '<p>Alpha paragraph opens the note.</p>';

        it('reports a correctly-placed but under-floor prefix as too_short', () => {
            expect(matchExpect('Alpha', line)).toBe('too_short');
        });
        it('reports a wrongly-placed expect as mismatch, not too_short', () => {
            expect(matchExpect('Omega', line)).toBe('mismatch');
        });
        it('reports an expect with NO visible text against a text line as mismatch', () => {
            // startsWith('') is vacuously true; too_short would claim a match
            // that was never established.
            expect(matchExpect('', line)).toBe('mismatch');
            expect(matchExpect('<p>', line)).toBe('mismatch');
        });
        it('accepts a suffix only when allowSuffix is set', () => {
            expect(matchExpect('opens the note.', line, { allowSuffix: true })).toBe('match');
            expect(matchExpect('opens the note.', line)).toBe('mismatch');
        });
        it('applies the floor to suffix matches too', () => {
            expect(matchExpect('note.', line, { allowSuffix: true })).toBe('too_short');
        });
        it('accepts the whole projection of a block shorter than the floor', () => {
            // The floor never demands more text than the block has: the full
            // (short) projection is a match, a partial prefix of it is not.
            expect(matchExpect('Hi.', '<p>Hi.</p>')).toBe('match');
            expect(matchExpect('Hi', '<p>Hi.</p>')).toBe('too_short');
        });
    });

    describe('lines with visible text — prefix with a floor', () => {
        const line = '<p>Intro paragraph with <citation id="1-K1" loc="page5" ref="c_K1_0"/> inline.</p>';

        it('accepts the full line', () => {
            expect(matchesExpect(line, line)).toBe(true);
        });
        it('accepts a short-but-sufficient prefix', () => {
            expect(matchesExpect('Intro par', line)).toBe(true);
        });
        it('rejects a sub-floor prefix', () => {
            expect(matchesExpect('Intro', line)).toBe(false);
        });
        it('is independent of any truncation boundary', () => {
            for (const cut of [9, 12, 17, 20]) {
                expect(matchesExpect(projectVisibleText(line).slice(0, cut), line)).toBe(true);
            }
        });
        it('rejects a wrong prefix', () => {
            expect(matchesExpect('Outro paragraph', line)).toBe(false);
        });
        it('accepts the full projection even when it is shorter than the floor', () => {
            expect(matchesExpect('<p>hi</p>', '<p>hi</p>')).toBe(true);
            expect(matchesExpect('hi', '<p>hi</p>')).toBe(true);
            expect(matchesExpect('h', '<p>hi</p>')).toBe(false);
        });
    });

    describe('lines with no visible text — outermost tag, attribute-stripped', () => {
        it('accepts <p> for <p><citation/></p>', () => {
            expect(matchesExpect('<p>', '<p><citation id="1-K" loc="page5" ref="c_K_0"/></p>')).toBe(true);
        });
        it('accepts <citation/> for a bare citation line', () => {
            expect(matchesExpect('<citation/>', '<citation id="1-K" loc="page5" ref="c_K_0"/>')).toBe(true);
        });
        it('accepts the verbatim line', () => {
            expect(matchesExpect('<ul>', '<ul>')).toBe(true);
            expect(matchesExpect('</li>', '</li>')).toBe(true);
            expect(matchesExpect('<hr>', '<hr>')).toBe(true);
        });
        it('forgives a stray self-closing slash', () => {
            expect(matchesExpect('<hr/>', '<hr>')).toBe(true);
        });
        it('still distinguishes <ul> from </ul>', () => {
            expect(matchesExpect('<ul>', '</ul>')).toBe(false);
            expect(matchesExpect('</ul>', '<ul>')).toBe(false);
        });
        it('still distinguishes different tag names', () => {
            expect(matchesExpect('<td>', '<li>')).toBe(false);
        });
        it('rejects an empty expect on a tag line', () => {
            expect(matchesExpect('', '<ul>')).toBe(false);
        });
        // An `expect` carrying visible text cannot be confirming a line that has
        // none. Without this, a stale block number pointing at a token-only
        // paragraph passes purely because the outermost tags agree — and on a
        // `replace`, `expect` is the ONLY content guard.
        it('rejects an expect with visible text against a token-only line', () => {
            const tokenLine = '<p><citation id="1-K" loc="page5" ref="c_K_0"/></p>';
            expect(matchesExpect('<p>some prose I remember</p>', tokenLine)).toBe(false);
            expect(matchesExpect('some prose I remember', tokenLine)).toBe(false);
            // …while the correct outermost-tag form still matches.
            expect(matchesExpect('<p>', tokenLine)).toBe(true);
        });
    });

    describe('empty expect', () => {
        it('matches only genuinely empty lines', () => {
            expect(matchesExpect('', '')).toBe(true);
            expect(matchesExpect('', '   ')).toBe(true);
            expect(matchesExpect('', '<p>text</p>')).toBe(false);
        });
    });

    describe('comparison folds', () => {
        it('bridges &amp; drift so a model-written & confirms a note-stored &amp;', () => {
            const line = '<p>Drift &amp; Selection in small populations here.</p>';
            expect(matchesExpect('<p>Drift & Selection in small populations here.</p>', line)).toBe(true);
            expect(matchesExpect(line, line)).toBe(true);
        });

        it('bridges CJK full-width punctuation drift', () => {
            expect(matchesExpect(
                '<p>本文提出了一种框架（LLM），以解决问题</p>',
                '<p>本文提出了一种框架(LLM),以解决问题</p>',
            )).toBe(true);
        });

        it('bridges Pangu spacing at CJK boundaries in both directions', () => {
            const packed = '<p>研究共识[14]表明该方法有效并且稳定可靠</p>';
            const spaced = '<p>研究共识 [14] 表明该方法有效并且稳定可靠</p>';
            expect(matchesExpect(spaced, packed)).toBe(true);
            expect(matchesExpect(packed, spaced)).toBe(true);
        });

        // Entity decoding must peel exactly ONE layer. A note DISPLAYING the text
        // `&lt;div&gt;` is stored as `&amp;lt;div&amp;gt;`; a note displaying
        // `<div>` is stored as `&lt;div&gt;`. Those are different visible texts,
        // so an `expect` for one must never confirm the other — a sequential
        // chain of per-entity replacements would collapse both to `<div>`.
        it('decodes only one entity layer, so escaped-entity text stays distinct', () => {
            const displaysEscapedEntity = '<p>Escape the tag as &amp;lt;div&amp;gt; when writing markup.</p>';
            const displaysRealAngleBrackets = '<p>Escape the tag as &lt;div&gt; when writing markup.</p>';
            expect(matchesExpect(displaysRealAngleBrackets, displaysEscapedEntity)).toBe(false);
            expect(matchesExpect(displaysEscapedEntity, displaysRealAngleBrackets)).toBe(false);
            // Each still confirms itself.
            expect(matchesExpect(displaysEscapedEntity, displaysEscapedEntity)).toBe(true);
            expect(matchesExpect(displaysRealAngleBrackets, displaysRealAngleBrackets)).toBe(true);
        });

        it('does not fold genuinely different prose', () => {
            expect(matchesExpect(
                '<p>Bravo paragraph about numbered edits entirely.</p>',
                '<p>Alpha paragraph about block addressing works.</p>',
            )).toBe(false);
        });
    });

    describe('projection order: strip tags, THEN decode entities', () => {
        it('keeps an escaped angle bracket inside code out of the tag stripper', () => {
            const line = '<pre>if (a &lt;p&gt; b) return;</pre>';
            expect(projectVisibleText(line)).toBe('if (a &lt;p&gt; b) return;');
            expect(matchesExpect('if (a &lt;p&gt; b) return;', line)).toBe(true);
            // NOTE: `decodeHtmlEntities` deliberately never yields a live `<`,
            // so the two orders are not observably different today. The order is
            // asserted here as an invariant for whatever decoder comes next.
        });
        it('decodes numeric entities and collapses &nbsp;', () => {
            expect(projectVisibleText('<p>a&nbsp;&nbsp;b&#x27;c</p>')).toBe("a b'c");
        });
    });
});

// =============================================================================
// PART 3 — selection: splices
// =============================================================================

describe('selectBlockEdits — splices', () => {
    it('replace block N swaps exactly that line', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const index = buildIndex(f);
        const result = select(index, [replaceEdit(index, 2, '<p>Beta prime</p>')]);
        expect(applyAll(index, result)).toBe(
            `${WRAPPER_OPEN}<p>Alpha</p>\n<p>Beta prime</p>\n<p>Gamma</p>\n</div>`,
        );
        const applied = expectOk(result).applied[0];
        expect(applied.resolved.applyOps).toHaveLength(1);
        expect(applied.anchorBlock).toBe(2);
        expect(applied.consumedBlocks).toBe(1);
        expect(applied.producedBlocks).toBe(1);
    });

    it('replace accepts multi-line content and reports the produced block count', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [replaceEdit(index, 1, '<p>One</p>\n<p>Two</p>')]);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>One</p>\n<p>Two</p>\n<p>Beta</p>\n</div>`);
        expect(expectOk(result).applied[0].producedBlocks).toBe(2);
    });

    it('insert after N lands between N and N+1', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [insertEdit(1, '<p>Inserted</p>')]);
        expect(applyAll(index, result)).toBe(
            `${WRAPPER_OPEN}<p>Alpha</p>\n<p>Inserted</p>\n<p>Beta</p>\n</div>`,
        );
        const applied = expectOk(result).applied[0];
        expect(applied.consumedBlocks).toBe(0);
        expect(applied.anchorBlock).toBe(1);
    });

    it('insert after 0 lands at the very start, never touching the wrapper', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const result = select(index, [insertEdit(0, '<p>First</p>')]);
        const applied = applyAll(index, result);
        expect(applied).toBe(`${WRAPPER_OPEN}<p>First</p>\n<p>Alpha</p>\n</div>`);
        expect(applied.startsWith(WRAPPER_OPEN)).toBe(true);
        expect(expectOk(result).applied[0].anchorBlock).toBe(0);
    });

    it("insert after 'end' appends at the body append point", () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [insertEdit('end', '<p>Last</p>')]);
        expect(applyAll(index, result)).toBe(
            `${WRAPPER_OPEN}<p>Alpha</p>\n<p>Beta</p>\n<p>Last</p>\n</div>`,
        );
        // The splice targets `bodyAppendPoint`, NOT the trailing empty line's
        // range. On a footerless note the two produce the same document — which
        // the byte assertion above pins — but they are different OFFSETS, and
        // only the append point stays above a trailing Beaver footer.
        expect(expectOk(result).applied[0].resolved.applyOps[0].start)
            .toBe(index.bodyAppendPoint);
        expect(index.bodyAppendPoint).toBe(index.rawLineRanges[index.rawLineRanges.length - 2].end);
    });

    it('delete consumes the range and its trailing newline', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const index = buildIndex(f);
        const result = select(index, [deleteEdit(index, 2)]);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>Alpha</p>\n<p>Gamma</p>\n</div>`);
        const applied = expectOk(result).applied[0];
        expect(applied.consumedBlocks).toBe(1);
        expect(applied.producedBlocks).toBe(0);
        expect(applied.resolved.undoOldHtml).toBe('<p>Beta</p>\n');
    });

    // The extend-left branch fires only when the deleted range reaches the very
    // end of the body with no trailing newline to consume. The real pipeline
    // always leaves a trailing empty line (whose own delete is `invalid_edit`),
    // so this needs a hand-built body — but the branch carries the `bodyStart`
    // clamp that stops a splice from reaching back into the wrapper tag, which
    // is worth pinning rather than leaving to inspection.
    describe('delete extend-left (body with no trailing newline)', () => {
        const handBuilt = () => {
            const simplified = '<p>A</p>\n<p>B</p>';
            const strippedHtml = `${WRAPPER_OPEN}<p>A</p>\n<p>B</p></div>`;
            const result = buildBlockRawIndex(simplified, strippedHtml, { elements: new Map() });
            if (!result.ok) throw new Error(`refused: ${result.error}`);
            return result.index;
        };

        it('extends LEFT instead of consuming a newline that is not there', () => {
            const index = handBuilt();
            const result = select(index, [deleteEdit(index, 2)]);
            expect(skipCodes(result)).toEqual([]);
            expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>A</p></div>`);
        });

        it('clamps to bodyStart so the splice never reaches into the wrapper tag', () => {
            const index = handBuilt();
            const result = select(index, [deleteEdit(index, 1, 2)]);
            expect(skipCodes(result)).toEqual([]);
            expect(expectOk(result).applied[0].resolved.applyOps[0].start).toBe(index.bodyStart);
            expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}</div>`);
        });
    });

    it('delete of a multi-block range consumes exactly those lines', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p><p>Delta</p>');
        const index = buildIndex(f);
        const result = select(index, [deleteEdit(index, 2, 3)]);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>Alpha</p>\n<p>Delta</p>\n</div>`);
        expect(expectOk(result).applied[0].consumedBlocks).toBe(2);
    });

    it('rejects op:"rewrite" — the action layer routes it elsewhere', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const result = select(index, [{ index: 0, op: 'rewrite', content: 'x' }]);
        expect(skipCodes(result)).toEqual(['invalid_edit']);
        expect(expectOk(result).skipped[0].reason).toMatch(/whole-body rewrite/);
    });
});

describe('selectBlockEdits — the trailing empty line', () => {
    it('replace of the trailing empty line behaves as an append at body end', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const last = index.rawLineRanges.length;
        expect(index.simplifiedLines[last - 1]).toBe('');
        const result = select(index, [replaceEdit(index, last, '<p>Appended</p>')]);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>Alpha</p>\n<p>Appended</p>\n</div>`);
    });

    it('delete of the trailing empty line is invalid_edit', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const last = index.rawLineRanges.length;
        const result = select(index, [deleteEdit(index, last)]);
        expect(skipCodes(result)).toEqual(['invalid_edit']);
        expect(expectOk(result).skipped[0].reason).toMatch(/trailing empty line/);
    });

    it("insert after the trailing empty line is treated as after:'end'", () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const last = index.rawLineRanges.length;
        const viaNumber = applyAll(index, select(index, [insertEdit(last, '<p>Tail</p>')]));
        const viaEnd = applyAll(index, select(index, [insertEdit('end', '<p>Tail</p>')]));
        expect(viaNumber).toBe(viaEnd);
        expect(viaEnd).toBe(`${WRAPPER_OPEN}<p>Alpha</p>\n<p>Tail</p>\n</div>`);
    });

    it('replace block 1 never touches the wrapper div', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const applied = applyAll(index, select(index, [replaceEdit(index, 1, '<p>New</p>')]));
        expect(applied.startsWith(WRAPPER_OPEN)).toBe(true);
        expect(applied.endsWith('</div>')).toBe(true);
    });
});

// =============================================================================
// PART 3 — structural rules through the selector
// =============================================================================

describe('selectBlockEdits — structural rules (lists AND tables, one code path)', () => {
    const listAndTable = '<ul><li><p>first item</p></li><li><p>second item</p></li></ul>'
        + '<table><tr><td><p>cell a</p></td><td><p>cell b</p></td></tr></table>'
        + '<blockquote><p>quoted material here</p></blockquote>';

    it('applies content replaces inside cells and list items', () => {
        const f = fixture(listAndTable);
        const index = buildIndex(f);
        const itemBlock = blockOf(index, 'first item');
        const cellBlock = blockOf(index, '<p>cell a</p>');
        const result = select(index, [
            replaceEdit(index, itemBlock, 'FIRST ITEM', 0),
            replaceEdit(index, cellBlock, '<p>CELL A</p>', 1),
        ]);
        expect(expectOk(result).skipped).toEqual([]);
        const applied = applyAll(index, result);
        expect(applied).toContain('FIRST ITEM');
        expect(applied).toContain('<p>CELL A</p>');
    });

    it('skips unbalanced deletes and replaces with unbalanced_range', () => {
        const f = fixture(listAndTable);
        const index = buildIndex(f);
        const ul = blockOf(index, '<ul>');
        const closeUl = blockOf(index, '</ul>');
        const firstTd = blockOf(index, '<td>');
        const bq = blockOf(index, '<blockquote>');

        // `</ul>` without its opener
        expect(skipCodes(select(index, [deleteEdit(index, closeUl - 1, closeUl)]))).toEqual(['unbalanced_range']);
        // crossing a cell boundary: <p>cell a</p>, </td>, <td>
        expect(skipCodes(select(index, [deleteEdit(index, firstTd + 1, firstTd + 3)]))).toEqual(['unbalanced_range']);
        // a <blockquote> opener without its closer
        expect(skipCodes(select(index, [deleteEdit(index, bq, bq + 1)]))).toEqual(['unbalanced_range']);
        // a lone replace of a structural line
        expect(skipCodes(select(index, [replaceEdit(index, firstTd, '<td>')]))).toEqual(['unbalanced_range']);
        expect(skipCodes(select(index, [replaceEdit(index, ul, '<ul>')]))).toEqual(['unbalanced_range']);
    });

    it('REQUIRED: a delete of exactly </li> + <li> skips unbalanced_range', () => {
        const f = fixture(listAndTable);
        const index = buildIndex(f);
        const closeLi = index.simplifiedLines.indexOf('</li>') + 1;
        expect(index.simplifiedLines[closeLi]).toBe('<li>');
        const result = select(index, [deleteEdit(index, closeLi, closeLi + 1)]);
        expect(skipCodes(result)).toEqual(['unbalanced_range']);
    });

    it('applies deletes that fully cover whole structures', () => {
        const f = fixture(listAndTable);
        const index = buildIndex(f);

        // A whole 3-line <li>
        const li = index.simplifiedLines.indexOf('<li>') + 1;
        expect(skipCodes(select(index, [deleteEdit(index, li, li + 2)]))).toEqual([]);

        // The whole list
        const ul = blockOf(index, '<ul>');
        const closeUl = blockOf(index, '</ul>');
        expect(skipCodes(select(index, [deleteEdit(index, ul, closeUl)]))).toEqual([]);

        // The whole table
        const table = blockOf(index, '<table>');
        const closeTable = blockOf(index, '</table>');
        expect(skipCodes(select(index, [deleteEdit(index, table, closeTable)]))).toEqual([]);

        // The whole blockquote
        const bq = blockOf(index, '<blockquote>');
        const closeBq = blockOf(index, '</blockquote>');
        expect(skipCodes(select(index, [deleteEdit(index, bq, closeBq)]))).toEqual([]);
    });

    it('does not flag a range containing void elements or simplified tokens', () => {
        const f = fixture(
            '<hr>'
            + '<p>Picture <img data-attachment-key="ATT1" width="10" height="10"></p>'
            + `<p>See ${rawCitation([{ key: 'K9' }])}</p>`
            + '<p><a href="https://example.com/y" rel="noopener noreferrer nofollow">https://example.com/y</a></p>',
        );
        const index = buildIndex(f);
        const result = select(index, [deleteEdit(index, 1, 4)]);
        expect(skipCodes(result)).toEqual([]);
    });

    it('skips structural insert seams with structural_seam (never span_partial_edit)', () => {
        const f = fixture(listAndTable);
        const index = buildIndex(f);
        const tr = blockOf(index, '<tr>');
        const ul = blockOf(index, '<ul>');
        expect(skipCodes(select(index, [insertEdit(tr, '<td>\n<p>c</p>\n</td>')]))).toEqual(['structural_seam']);
        expect(skipCodes(select(index, [insertEdit(ul, '<li>\nx\n</li>')]))).toEqual(['structural_seam']);
    });

    it('applies inserts at container boundaries', () => {
        const f = fixture(listAndTable);
        const index = buildIndex(f);
        const closeUl = blockOf(index, '</ul>');
        expect(skipCodes(select(index, [insertEdit(closeUl, '<p>after the list</p>')]))).toEqual([]);
        expect(skipCodes(select(index, [insertEdit(0, '<p>before everything</p>')]))).toEqual([]);
        expect(skipCodes(select(index, [insertEdit('end', '<p>at the end</p>')]))).toEqual([]);
    });
});

// =============================================================================
// PART 3 — span matrix
// =============================================================================

/**
 * HAND-BUILT fixture: ProseMirror collapses newlines inside a highlight span,
 * so the real pipeline cannot currently emit a multiline annotation. The case is
 * latent, not impossible, and the rules that cover it are exactly the ones an
 * implementer is most likely to get wrong.
 */
function multilineAnnotationFixture() {
    const encoded = encodeURIComponent(JSON.stringify({ annotationKey: 'M1', color: '#ffd400', pageLabel: '3' }));
    const innerText = 'line one\nline two\nline three';
    const rawSpan = `<span class="highlight" data-annotation="${encoded}">${innerText}</span>`;
    const strippedHtml = `${WRAPPER_OPEN}<p>Before</p>\n<p>${rawSpan}</p>\n<p>After</p>\n</div>`;
    const simplified =
        '<p>Before</p>\n'
        + `<p><annotation id="a_M1" key="M1" color="#ffd400" page="3">${innerText}</annotation></p>\n`
        + '<p>After</p>\n';
    const metadata: SimplificationMetadata = {
        elements: new Map([
            ['a_M1', { rawHtml: rawSpan, type: 'annotation' as const, originalText: innerText }],
        ]),
    };
    return { strippedHtml, simplified, metadata };
}

describe('selectBlockEdits — opaque spans', () => {
    const mathAndPre = '<p>Alpha</p>'
        + '<pre class="math">$$x = 1\ny = 2\nz = 3$$</pre>'
        + '<p>Beta</p>'
        + '<pre>code one\ncode two\ncode three</pre>'
        + '<p>Gamma</p>';

    it('locks EVERY line of multiline display math — first, middle and last', () => {
        const f = fixture(mathAndPre);
        const index = buildIndex(f);
        const first = blockOf(index, '$$x = 1');
        for (const n of [first, first + 1, first + 2]) {
            const result = select(index, [replaceEdit(index, n, 'whatever')]);
            expect(skipCodes(result)).toEqual(['span_partial_edit']);
        }
    });

    it('locks EVERY line of a multiline <pre> — first, middle and last', () => {
        const f = fixture(mathAndPre);
        const index = buildIndex(f);
        const first = blockOf(index, '<pre>code one');
        for (const n of [first, first + 1, first + 2]) {
            expect(skipCodes(select(index, [replaceEdit(index, n, 'whatever')]))).toEqual(['span_partial_edit']);
        }
    });

    // `<pre>` is scanned BEFORE math and math skips anything already covered,
    // so literal `$$` inside a code block is code, not a math span. Without the
    // precedence the `$$` pair inside the <pre> would also register as math.
    it('scans <pre> before math, so literal $$ inside code is not a math span', () => {
        const f = fixture('<p>Alpha</p><pre>cost $$5\nand $$3</pre><p>Beta</p>');
        const index = buildIndex(f);
        const preSpans = index.spans.filter((s) => s.kind === 'pre');
        const mathSpans = index.spans.filter((s) => s.kind === 'math');
        expect(preSpans).toHaveLength(1);
        expect(mathSpans).toHaveLength(0);
    });

    // Prose containing two `$$` on different lines must NOT become one math
    // span — that would refuse every edit to the blocks between them.
    it('does not pair $$ across ordinary prose lines', () => {
        const f = fixture('<p>costs $$5 today</p><p>and $$3 tomorrow</p>');
        const index = buildIndex(f);
        expect(index.spans.filter((s) => s.kind === 'math')).toHaveLength(0);
        expect(skipCodes(select(index, [replaceEdit(index, 1, '<p>costs less</p>')]))).toEqual([]);
    });

    it('locks every line of a multiline annotation with annotation_immutable', () => {
        const fx = multilineAnnotationFixture();
        const index = buildIndex(fx as any);
        for (const n of [2, 3, 4]) {
            expect(skipCodes(select(index, [replaceEdit(index, n, 'whatever')]))).toEqual(['annotation_immutable']);
        }
    });

    it('GATE ORDER: a partial range over a multiline annotation is a span code, NOT unbalanced_range', () => {
        const fx = multilineAnnotationFixture();
        const index = buildIndex(fx as any);
        // Blocks 2..3 open a <p> that is not closed inside the range, so the
        // structural rule WOULD fire — the span rule must win.
        expect(isRangeBalanced(index.simplifiedLines.slice(1, 3).join('\n'))).toBe(false);
        expect(skipCodes(select(index, [deleteEdit(index, 2, 3)]))).toEqual(['span_partial_edit']);
    });

    it('still reports unbalanced_range for a partial <blockquote> (no span involved)', () => {
        const f = fixture('<blockquote><p>q1</p><p>q2</p></blockquote>');
        const index = buildIndex(f);
        expect(skipCodes(select(index, [deleteEdit(index, 1, 2)]))).toEqual(['unbalanced_range']);
    });

    it('skips a delete that bisects an opaque span', () => {
        const f = fixture(mathAndPre);
        const index = buildIndex(f);
        const first = blockOf(index, '$$x = 1');
        expect(skipCodes(select(index, [deleteEdit(index, first, first + 1)]))).toEqual(['span_partial_edit']);
        expect(skipCodes(select(index, [deleteEdit(index, first - 1, first)]))).toEqual(['span_partial_edit']);
    });

    it('allows a delete that fully covers a span', () => {
        const f = fixture(mathAndPre);
        const index = buildIndex(f);
        const first = blockOf(index, '$$x = 1');
        expect(skipCodes(select(index, [deleteEdit(index, first, first + 2)]))).toEqual([]);
    });

    it('skips an insert whose seam falls strictly inside a span, allows seams at its boundaries', () => {
        const f = fixture(mathAndPre);
        const index = buildIndex(f);
        const first = blockOf(index, '$$x = 1');
        expect(skipCodes(select(index, [insertEdit(first, '<p>x</p>')]))).toEqual(['span_partial_edit']);
        expect(skipCodes(select(index, [insertEdit(first + 1, '<p>x</p>')]))).toEqual(['span_partial_edit']);
        expect(skipCodes(select(index, [insertEdit(first - 1, '<p>x</p>')]))).toEqual([]);
        expect(skipCodes(select(index, [insertEdit(first + 2, '<p>x</p>')]))).toEqual([]);
    });

    it('deletes a whole multiline annotation (the supported removal path)', () => {
        const fx = multilineAnnotationFixture();
        const index = buildIndex(fx as any);
        const result = select(index, [deleteEdit(index, 2, 4)]);
        expect(skipCodes(result)).toEqual([]);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>Before</p>\n<p>After</p>\n</div>`);
    });

    it('skips a delete of PART of a multiline annotation', () => {
        const fx = multilineAnnotationFixture();
        const index = buildIndex(fx as any);
        expect(skipCodes(select(index, [deleteEdit(index, 3, 4)]))).toEqual(['span_partial_edit']);
    });
});

describe('selectBlockEdits — single-line annotations stay editable', () => {
    const annotationInner = `<p>${rawAnnotation('A1', 'highlighted words')} plus my own comment.</p>`;

    it('replaces the line and restores the annotation BYTE-EXACTLY from the map', () => {
        const f = fixture(annotationInner);
        const index = buildIndex(f);
        const rawSpan = f.metadata.elements.get('a_A1')!.rawHtml;
        const token = /<annotation [^>]*>.*?<\/annotation>/.exec(index.simplifiedLines[0])![0];

        const result = select(index, [replaceEdit(index, 1, `<p>${token} plus a REVISED comment.</p>`)]);
        expect(skipCodes(result)).toEqual([]);
        const applied = applyAll(index, result);
        expect(applied).toContain(rawSpan);
        expect(applied).toContain('plus a REVISED comment.');
    });

    it('accepts a model copy that differs from the annotation only in whitespace, and discards the variant', () => {
        const f = fixture(annotationInner);
        const index = buildIndex(f);
        const rawSpan = f.metadata.elements.get('a_A1')!.rawHtml;
        const token = /<annotation [^>]*>.*?<\/annotation>/.exec(index.simplifiedLines[0])![0];
        const whitespaceVariant = token.replace('highlighted words', 'highlighted   words');
        expect(whitespaceVariant).not.toBe(token);

        const result = select(index, [replaceEdit(index, 1, `<p>${whitespaceVariant} plus my own comment.</p>`)]);
        expect(skipCodes(result)).toEqual([]);
        const applied = applyAll(index, result);
        expect(applied).toContain(rawSpan);
        expect(applied).not.toContain('highlighted   words');
    });

    it('skips a real text change with annotation_immutable', () => {
        const f = fixture(annotationInner);
        const index = buildIndex(f);
        const token = /<annotation [^>]*>.*?<\/annotation>/.exec(index.simplifiedLines[0])![0];
        const edited = token.replace('highlighted words', 'rewritten words');
        const result = select(index, [replaceEdit(index, 1, `<p>${edited} plus my own comment.</p>`)]);
        expect(skipCodes(result)).toEqual(['annotation_immutable']);
    });

    it('deletes a whole single-line annotation by omitting it from the content', () => {
        const f = fixture(annotationInner);
        const index = buildIndex(f);
        const result = select(index, [replaceEdit(index, 1, '<p>just my own comment.</p>')]);
        expect(skipCodes(result)).toEqual([]);
        expect(applyAll(index, result)).not.toContain('data-annotation');
    });
});

describe('selectBlockEdits — compound citations', () => {
    it('round-trips an items= compound citation byte-exactly through a line replace', () => {
        const f = fixture(`<p>See ${rawCitation([{ key: 'K1', locator: '3' }, { key: 'K2', locator: '9', family: 'Jones', year: '2020' }])} for details.</p>`);
        const index = buildIndex(f);
        const compoundRef = [...f.metadata.elements.keys()].find((k) => k.startsWith('c_K1+K2_'))!;
        const rawSpan = f.metadata.elements.get(compoundRef)!.rawHtml;
        const token = /<citation items="[^"]*" ref="[^"]*"\/>/.exec(index.simplifiedLines[0])![0];

        const result = select(index, [replaceEdit(index, 1, `<p>Compare ${token} closely.</p>`)]);
        expect(skipCodes(result)).toEqual([]);
        const applied = applyAll(index, result);
        expect(applied).toContain(rawSpan);
        expect(applied).toContain('<p>Compare ');
    });
});

// =============================================================================
// PART 3 — mid-document footers
// =============================================================================

describe('selectBlockEdits — mid-document footers', () => {
    it('addresses correctly on both sides of ONE interior footer pair', () => {
        const f = fixture(`<p>Alpha</p>${CREATED_FOOTER}${EDIT_FOOTER}<p>Later user content</p>`);
        const index = buildIndex(f);
        expect(index.simplifiedLines).toEqual(['<p>Alpha</p>', '<p>Later user content</p>', '']);
        expect(index.footerRanges).toHaveLength(2);
        // The seam between block 1 and block 2 crosses the skipped lines.
        expect(index.seamCrossesSkippedLine[0]).toBe(true);
        expect(index.seamCrossesSkippedLine[1]).toBe(false);

        const both = select(index, [
            replaceEdit(index, 1, '<p>ALPHA</p>', 0),
            replaceEdit(index, 2, '<p>LATER</p>', 1),
        ]);
        expect(skipCodes(both)).toEqual([]);
        const applied = applyAll(index, both);
        expect(applied).toContain('<p>ALPHA</p>');
        expect(applied).toContain('<p>LATER</p>');
        expect(applied).toContain(CREATED_FOOTER);
        expect(applied).toContain(EDIT_FOOTER);
    });

    it('refuses a range CROSSING a skipped line with unaddressable_range (never a multi-run splice)', () => {
        const f = fixture(`<p>Alpha</p>${CREATED_FOOTER}${EDIT_FOOTER}<p>Later user content</p>`);
        const index = buildIndex(f);
        const result = select(index, [deleteEdit(index, 1, 2)]);
        expect(skipCodes(result)).toEqual(['unaddressable_range']);
        expect(expectOk(result).skipped[0].reason).toMatch(/one range per side/);
        expect(expectOk(result).applied).toHaveLength(0);
    });

    it('handles TWO non-adjacent interior footers with user content between them', () => {
        const f = fixture(
            `<p>Alpha</p>${CREATED_FOOTER}<p>Middle one</p><p>Middle two</p>${EDIT_FOOTER}<p>Omega</p>`,
        );
        const index = buildIndex(f);
        expect(index.simplifiedLines).toEqual([
            '<p>Alpha</p>', '<p>Middle one</p>', '<p>Middle two</p>', '<p>Omega</p>', '',
        ]);
        expect(index.seamCrossesSkippedLine).toEqual([true, false, true, false]);

        // A range crossing either skipped line is refused.
        expect(skipCodes(select(index, [deleteEdit(index, 1, 2)]))).toEqual(['unaddressable_range']);
        expect(skipCodes(select(index, [deleteEdit(index, 3, 4)]))).toEqual(['unaddressable_range']);
        expect(skipCodes(select(index, [deleteEdit(index, 2, 4)]))).toEqual(['unaddressable_range']);

        // The half-ranges either side both apply, and BOTH footers survive intact.
        const halves = select(index, [
            replaceEdit(index, 1, '<p>ALPHA</p>', 0),
            deleteEdit(index, 2, 3, 1),
            replaceEdit(index, 4, '<p>OMEGA</p>', 2),
        ]);
        expect(skipCodes(halves)).toEqual([]);
        const applied = applyAll(index, halves);
        expect(applied).toContain(CREATED_FOOTER);
        expect(applied).toContain(EDIT_FOOTER);
        expect(applied).toContain('<p>ALPHA</p>');
        expect(applied).toContain('<p>OMEGA</p>');
        expect(applied).not.toContain('Middle one');
        expect(applied).not.toContain('Middle two');
    });

    it('insert after a block whose seam crosses a footer lands ABOVE the footer', () => {
        const f = fixture(`<p>Alpha</p>${EDIT_FOOTER}<p>Later user content</p>`);
        const index = buildIndex(f);
        const applied = applyAll(index, select(index, [insertEdit(1, '<p>Wedged</p>')]));
        expect(applied.indexOf('<p>Wedged</p>')).toBeLessThan(applied.indexOf('Edited by Beaver'));
        expect(applied).toContain(EDIT_FOOTER);
    });

    it("after:'end' lands at the end of the last content line, above nothing (no trailing footer)", () => {
        const f = fixture(
            `<p>Alpha</p>${CREATED_FOOTER}<p>Middle</p>${EDIT_FOOTER}<p>Omega</p>`,
        );
        const index = buildIndex(f);
        const result = select(index, [insertEdit('end', '<p>Tail</p>')]);
        const op = expectOk(result).applied[0].resolved.applyOps[0];
        // The last body line is the trailing empty line; the append point is the
        // end of the last CONTENT line above it.
        expect(op.start).toBe(index.rawLineRanges[index.rawLineRanges.length - 2].end);
        expect(applyAll(index, result)).toContain('<p>Omega</p>\n<p>Tail</p>\n</div>');
    });

    // The TRAILING-footer case is the one the append point exists for. The
    // trailing empty line's own range is `bodyEnd`, which sits BELOW the footer
    // paragraphs, so appending there would put user content under "Created by
    // Beaver". `addOrUpdateEditFooter` re-appends the EDIT footer at save time
    // so that one self-heals, but the CREATED footer never moves.
    it("after:'end' lands ABOVE a trailing created footer", () => {
        const f = fixture(`<p>Alpha</p>${CREATED_FOOTER}`);
        const index = buildIndex(f);
        const applied = applyAll(index, select(index, [insertEdit('end', '<p>Tail</p>')]));
        expect(applied.indexOf('<p>Tail</p>')).toBeLessThan(applied.indexOf('Created by Beaver'));
        expect(applied).toContain(CREATED_FOOTER);
        expect(applied).toContain('<p>Alpha</p>\n<p>Tail</p>\n');
    });

    it("after:'end' lands ABOVE BOTH trailing footers, leaving each byte-intact", () => {
        const f = fixture(`<p>Alpha</p>${CREATED_FOOTER}${EDIT_FOOTER}`);
        const index = buildIndex(f);
        const applied = applyAll(index, select(index, [insertEdit('end', '<p>Tail</p>')]));
        expect(applied.indexOf('<p>Tail</p>')).toBeLessThan(applied.indexOf('Created by Beaver'));
        expect(applied.indexOf('<p>Tail</p>')).toBeLessThan(applied.indexOf('Edited by Beaver'));
        expect(applied).toContain(CREATED_FOOTER);
        expect(applied).toContain(EDIT_FOOTER);
    });

    it('replace of the trailing empty line also lands above a trailing footer', () => {
        const f = fixture(`<p>Alpha</p>${CREATED_FOOTER}`);
        const index = buildIndex(f);
        const last = index.rawLineRanges.length;
        expect(index.simplifiedLines[last - 1]).toBe('');
        const applied = applyAll(index, select(index, [replaceEdit(index, last, '<p>Tail</p>')]));
        // Same conceptual operation as after:'end', so it must not diverge.
        expect(applied.indexOf('<p>Tail</p>')).toBeLessThan(applied.indexOf('Created by Beaver'));
        expect(applied).toContain(CREATED_FOOTER);
    });

    it("after:'end' falls back to bodyStart when the body holds nothing but a footer", () => {
        const f = fixture(`${CREATED_FOOTER}`);
        const index = buildIndex(f);
        const result = select(index, [insertEdit('end', '<p>Tail</p>')]);
        expect(skipCodes(result)).toEqual([]);
        expect(expectOk(result).applied[0].resolved.applyOps[0].start).toBe(index.bodyStart);
        const applied = applyAll(index, result);
        expect(applied.indexOf('<p>Tail</p>')).toBeLessThan(applied.indexOf('Created by Beaver'));
        expect(applied).toContain(CREATED_FOOTER);
        // Assert the BYTES, not just the ordering: this is the one append branch
        // that emits `content + '\n'` rather than `'\n' + content`, and an
        // ordering-only assertion passes even when the newline is on the wrong
        // side (which merges Tail onto the footer's line).
        expect(applied).toBe(`${WRAPPER_OPEN}<p>Tail</p>\n${CREATED_FOOTER}\n</div>`);
    });

    it('a MID-document footer does not move the append point', () => {
        const f = fixture(`<p>Alpha</p>${CREATED_FOOTER}<p>Omega</p>`);
        const index = buildIndex(f);
        // The backward scan stops at the first non-footer line, so the interior
        // footer is irrelevant: the append point is still the last content line.
        expect(index.bodyAppendPoint)
            .toBe(index.rawLineRanges[index.rawLineRanges.length - 2].end);
        const applied = applyAll(index, select(index, [insertEdit('end', '<p>Tail</p>')]));
        expect(applied).toContain('<p>Omega</p>\n<p>Tail</p>\n');
        expect(applied.indexOf('Created by Beaver')).toBeLessThan(applied.indexOf('<p>Tail</p>'));
    });
});

// =============================================================================
// PART 3 — read-window binding
// =============================================================================

describe('selectBlockEdits — read window', () => {
    const f = () => fixture('<p>A</p><p>B</p><p>C</p><p>D</p><p>E</p>');

    it('rejects an address outside the window it was issued for', () => {
        const index = buildIndex(f());
        const result = select(index, [replaceEdit(index, 5, '<p>E2</p>')], {
            readWindow: { from: 1, to: 3 },
        });
        expect(skipCodes(result)).toEqual(['address_outside_read_window']);
        expect(expectOk(result).skipped[0].reason).toMatch(/outside the range you last read \(1–3\)/);
        expect(expectOk(result).skipped[0].reason).toMatch(/read_note/);
    });

    it('accepts an address inside the window', () => {
        const index = buildIndex(f());
        expect(skipCodes(select(index, [replaceEdit(index, 2, '<p>B2</p>')], {
            readWindow: { from: 1, to: 3 },
        }))).toEqual([]);
    });

    it('imposes no restriction for a whole-note window', () => {
        const index = buildIndex(f());
        const total = index.rawLineRanges.length;
        const window = { from: 1, to: total };
        expect(skipCodes(select(index, [replaceEdit(index, total - 1, '<p>E2</p>')], { readWindow: window }))).toEqual([]);
        expect(skipCodes(select(index, [insertEdit(0, '<p>x</p>')], { readWindow: window }))).toEqual([]);
        expect(skipCodes(select(index, [insertEdit('end', '<p>x</p>')], { readWindow: window }))).toEqual([]);
    });

    it('fails closed against the canonical empty window', () => {
        const index = buildIndex(f());
        const window = { from: 0, to: 0 };
        expect(skipCodes(select(index, [replaceEdit(index, 1, '<p>x</p>')], { readWindow: window })))
            .toEqual(['address_outside_read_window']);
        expect(skipCodes(select(index, [insertEdit(0, '<p>x</p>')], { readWindow: window })))
            .toEqual(['address_outside_read_window']);
        expect(skipCodes(select(index, [insertEdit('end', '<p>x</p>')], { readWindow: window })))
            .toEqual(['address_outside_read_window']);
    });

    it('reports out-of-range before out-of-window', () => {
        const index = buildIndex(f());
        expect(skipCodes(select(index, [replaceEdit(index, 1, 'x')].map((e) => ({ ...e, block: 999 })), {
            readWindow: { from: 1, to: 3 },
        }))).toEqual(['block_out_of_range']);
    });
});

// =============================================================================
// PART 3 — shape, expect, overlap
// =============================================================================

describe('selectBlockEdits — shape validation', () => {
    const index = () => buildIndex(fixture('<p>A</p><p>B</p><p>C</p>'));

    it('requires the right fields per op', () => {
        const i = index();
        const cases: BlockEditSpec[] = [
            { index: 0, op: 'replace', content: 'x', expect: 'y' },                       // no block
            { index: 1, op: 'replace', block: 1, expect: 'y' },                           // no content
            { index: 2, op: 'replace', block: 1, content: 'x' },                          // no expect
            { index: 3, op: 'insert', content: 'x' },                                     // no after
            { index: 4, op: 'insert', after: 1 },                                         // no content
            { index: 5, op: 'delete' },                                                   // no block
            { index: 6, op: 'delete', block: 2, to: 1, expect: 'y' },          // inverted
            { index: 7, op: 'delete', block: 1, to: 2, expect: 'y' },          // no expect_end
            { index: 8, op: 'delete', block: 1, expect: 'y', expect_end: 'z' },      // stray expect_end
            { index: 9, op: 'replace', block: 1.5 as any, content: 'x', expect: 'y' },    // non-integer
            { index: 10, op: 'insert', after: -1, expect: 'y', content: 'x' },            // negative
            { index: 11, op: 'insert', after: 0, expect: 'y', content: 'x' },             // expect on a seam
            { index: 12, op: 'insert', after: 'end', expect: 'y', content: 'x' },         // expect on a seam
        ];
        expect(skipCodes(select(i, cases))).toEqual(cases.map(() => 'invalid_edit'));
    });

    it('requires `expect` on a numbered insert anchor', () => {
        const i = index();
        // Direct call: the select() helper auto-fills insert expects.
        const result = selectBlockEdits(
            { index: i } as any,
            [{ index: 0, op: 'insert', after: 1, content: '<p>x</p>' }],
        );
        expect(skipCodes(result)).toEqual(['invalid_edit']);
        expect(expectOk(result).skipped[0].reason).toMatch(/insert requires `expect`/);
    });

    it('checks an insert anchor `expect` against block `after`, either end', () => {
        const f = fixture('<p>Alpha paragraph opens</p><p>Beta paragraph closes</p>');
        const index = buildIndex(f);
        const at = (expectValue: string) => skipCodes(select(index, [
            { index: 0, op: 'insert', after: 2, expect: expectValue, content: '<p>x</p>' },
        ]));
        expect(at('Beta paragraph')).toEqual([]);            // prefix
        expect(at('paragraph closes')).toEqual([]);          // suffix
        expect(at('Something else entirely')).toEqual(['expect_mismatch']);
    });

    it('reports a correctly-placed but too-short expect as such', () => {
        const f = fixture('<p>Alpha paragraph opens the note</p>');
        const index = buildIndex(f);
        const result = select(index, [
            { index: 0, op: 'replace', block: 1, expect: 'Alpha', content: '<p>x</p>' },
        ]);
        expect(skipCodes(result)).toEqual(['expect_mismatch']);
        expect(expectOk(result).skipped[0].reason).toMatch(/too short/);
    });

    it('reports block_out_of_range with the note size', () => {
        const i = index();
        const result = select(i, [{ index: 0, op: 'replace', block: 99, content: 'x', expect: 'y' }]);
        expect(skipCodes(result)).toEqual(['block_out_of_range']);
        expect(expectOk(result).skipped[0].reason).toMatch(/this note has 4 block\(s\)/);
    });

    // Without the bounds gate these index past `rawLineRanges` and throw a
    // TypeError instead of skipping, so the gate needs its own pin per op.
    it('bounds-checks insert `after` and delete `to`, not just replace', () => {
        const i = index();
        expect(skipCodes(select(i, [{ index: 0, op: 'insert', after: 99, content: 'x' }])))
            .toEqual(['block_out_of_range']);
        expect(skipCodes(select(i, [{ index: 0, op: 'delete', block: 1, to: 99, expect: '<p>A</p>', expect_end: 'z' }])))
            .toEqual(['block_out_of_range']);
        expect(skipCodes(select(i, [{ index: 0, op: 'delete', block: 99, expect: 'z' }])))
            .toEqual(['block_out_of_range']);
    });
});

describe('selectBlockEdits — expect gate', () => {
    it('skips with expect_mismatch and reports the actual block', () => {
        const f = fixture('<p>Alpha paragraph</p><p>Beta paragraph</p>');
        const index = buildIndex(f);
        const result = select(index, [{ index: 0, op: 'replace', block: 1, content: 'x', expect: 'Gamma paragraph' }]);
        expect(skipCodes(result)).toEqual(['expect_mismatch']);
        expect(expectOk(result).skipped[0].actual).toBe('<p>Alpha paragraph</p>');
    });

    it('skips with expect_end_mismatch on the far end of a delete', () => {
        const f = fixture('<p>Alpha paragraph</p><p>Beta paragraph</p><p>Gamma paragraph</p>');
        const index = buildIndex(f);
        const result = select(index, [{
            index: 0, op: 'delete', block: 1, to: 2,
            expect: '<p>Alpha paragraph</p>', expect_end: '<p>Wrong end</p>',
        }]);
        expect(skipCodes(result)).toEqual(['expect_end_mismatch']);
        expect(expectOk(result).skipped[0].actual).toBe('<p>Beta paragraph</p>');
    });

    it('truncates `actual` to ~80 characters', () => {
        const long = `<p>${'x'.repeat(200)}</p>`;
        const f = fixture(long);
        const index = buildIndex(f);
        const result = select(index, [{ index: 0, op: 'replace', block: 1, content: 'y', expect: 'nope nope nope' }]);
        const actual = expectOk(result).skipped[0].actual!;
        expect(actual.length).toBeLessThanOrEqual(80);
        expect(actual.endsWith('…')).toBe(true);
    });
});

describe('selectBlockEdits — overlap determinism', () => {
    it('keeps the first applicable edit and skips the later conflicting one', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const index = buildIndex(f);
        const result = select(index, [
            deleteEdit(index, 1, 2, 0),
            replaceEdit(index, 2, '<p>Beta 2</p>', 1),
        ]);
        expect(expectOk(result).applied.map((a) => a.resolved.index)).toEqual([0]);
        expect(skipCodes(result)).toEqual(['overlapping_edits']);
    });

    it('processes edits ascending by index regardless of array order', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const index = buildIndex(f);
        const result = select(index, [
            replaceEdit(index, 2, '<p>Beta 2</p>', 1),
            deleteEdit(index, 1, 2, 0),
        ]);
        expect(expectOk(result).applied.map((a) => a.resolved.index)).toEqual([0]);
        expect(expectOk(result).skipped.map((s) => s.index)).toEqual([1]);
    });

    it('REQUIRED: two inserts at the same anchor — the second skips overlapping_edits', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [
            insertEdit(1, '<p>One</p>', 0),
            insertEdit(1, '<p>Two</p>', 1),
        ]);
        expect(expectOk(result).applied).toHaveLength(1);
        expect(skipCodes(result)).toEqual(['overlapping_edits']);
    });

    it('treats adjacency as legal', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
        const index = buildIndex(f);
        const result = select(index, [
            replaceEdit(index, 1, '<p>A2</p>', 0),
            replaceEdit(index, 2, '<p>B2</p>', 1),
        ]);
        expect(skipCodes(result)).toEqual([]);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>A2</p>\n<p>B2</p>\n<p>Gamma</p>\n</div>`);
    });

    // `insert after: 0` resolves to `rawLineRanges[0].start` — exactly where a
    // replace/delete of block 1 begins. Strict intersection says "no conflict"
    // (the insert is zero-width), but `applyResolvedEdits` breaks same-offset
    // ties by DESCENDING edit index, so the insert is spliced FIRST and the
    // sibling splice — still holding pre-edit offsets — eats the inserted text.
    // Before the fix this produced `<p>ALPHA</p><p>Alpha</p>` with no skip and
    // no warning: the reverse-replay self-check does not fire because the two
    // length deltas cancel.
    it('REQUIRED: insert after:0 conflicts with a replace of block 1', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [
            replaceEdit(index, 1, '<p>ALPHA</p>', 0),
            insertEdit(0, '<p>Head</p>', 1),
        ]);
        expect(skipCodes(result)).toEqual(['overlapping_edits']);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>ALPHA</p>\n<p>Beta</p>\n</div>`);
    });

    it('REQUIRED: insert after:0 conflicts with a delete of block 1', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [
            deleteEdit(index, 1, 1, 0),
            insertEdit(0, '<p>Head</p>', 1),
        ]);
        expect(skipCodes(result)).toEqual(['overlapping_edits']);
        // Before the fix this emitted malformed HTML: `p>Alpha</p>`.
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>Beta</p>\n</div>`);
    });

    it('conflict detection is order-independent for the same pair', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [
            insertEdit(0, '<p>Head</p>', 0),
            replaceEdit(index, 1, '<p>ALPHA</p>', 1),
        ]);
        // Keep-first: the insert wins here, the replace is the one skipped.
        expect(skipCodes(result)).toEqual(['overlapping_edits']);
        expect(applyAll(index, result)).toBe(`${WRAPPER_OPEN}<p>Head</p>\n<p>Alpha</p>\n<p>Beta</p>\n</div>`);
    });

    // Coincidence with a range's END must stay legal — `insert after N` resolves
    // strictly past `replace N`'s end, so the descending splice order is right.
    it('an insert after N does NOT conflict with a replace of N', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [
            replaceEdit(index, 1, '<p>ALPHA</p>', 0),
            insertEdit(1, '<p>Mid</p>', 1),
        ]);
        expect(skipCodes(result)).toEqual([]);
        expect(applyAll(index, result)).toBe(
            `${WRAPPER_OPEN}<p>ALPHA</p>\n<p>Mid</p>\n<p>Beta</p>\n</div>`,
        );
    });
});

describe('selectBlockEdits — content balance (gate 5b)', () => {
    it('refuses a dangling container opener in insert content', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        const result = select(index, [insertEdit(1, '<ul><li>')]);
        expect(skipCodes(result)).toEqual(['unbalanced_range']);
        expect(expectOk(result).skipped[0].reason).toMatch(/`content` is not tag-balanced/);
    });

    it('refuses a dangling closer in replace content', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        expect(skipCodes(select(index, [replaceEdit(index, 1, '</p>')]))).toEqual(['unbalanced_range']);
    });

    it('accepts balanced content, plain text, and simplified tokens', () => {
        const f = fixture('<p>Alpha</p><p>Beta</p>');
        const index = buildIndex(f);
        expect(skipCodes(select(index, [replaceEdit(index, 1, '<ul><li>x</li></ul>')]))).toEqual([]);
        expect(skipCodes(select(index, [replaceEdit(index, 1, 'just text')]))).toEqual([]);
        // Self-closing tokens and inline <annotation> are not stack participants.
        expect(skipCodes(select(index, [insertEdit(1, '<p>See <link href="https://x.test/"/> and $x$</p>')]))).toEqual([]);
    });
});

describe('selectBlockEdits — expansion failures', () => {
    it('maps a general expansion throw to expansion_failed', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const result = select(index, [replaceEdit(index, 1, '<p><citation items="1-A, 1-B"/></p>')]);
        expect(skipCodes(result)).toEqual(['expansion_failed']);
    });

    it('runs preprocessContent before expansion and keeps its warnings', () => {
        const f = fixture('<p>Alpha</p>');
        const index = buildIndex(f);
        const result = select(index, [replaceEdit(index, 1, '<p>PLACEHOLDER</p>')], {
            preprocessContent: (content: string) => ({
                content: content.replace('PLACEHOLDER', 'substituted'),
                warnings: ['degraded one citation'],
            }),
        });
        const applied = expectOk(result).applied[0];
        expect(applied.resolved.warnings).toEqual(['degraded one citation']);
        expect(applyAll(index, result)).toContain('<p>substituted</p>');
    });
});

// =============================================================================
// Property test — the batch engine's own reverse-splice replay
// =============================================================================

/**
 * Replay the undo drafts the way `react/utils/editNoteActions.ts` does: records
 * in DESCENDING index order, each fragment located by its stored before-context,
 * each reverted before the next is located.
 */
function replayUndo(appliedHtml: string, drafts: ReturnType<typeof applyResolvedEdits>['undoDrafts']): string {
    let state = appliedHtml;
    for (let i = drafts.length - 1; i >= 0; i--) {
        const draft = drafts[i];
        const before = draft.undo_before_context ?? '';
        const anchor = before + draft.undo_new_html;
        const at = state.indexOf(anchor);
        if (at === -1) throw new Error(`replayUndo: could not locate fragment for edit ${draft.index}`);
        const start = at + before.length;
        const end = start + draft.undo_new_html.length;
        state = state.slice(0, start) + draft.undo_old_html + state.slice(end);
    }
    return state;
}

describe('property: apply → reverse replay reconstructs the pre-edit note byte-exactly', () => {
    const scenarios: Array<[string, string, (i: BlockRawIndex) => BlockEditSpec[]]> = [
        ['single replace', '<p>Alpha</p><p>Beta</p><p>Gamma</p>',
            (i) => [replaceEdit(i, 2, '<p>Beta prime</p>')]],
        ['replace + insert + delete', '<p>Alpha</p><p>Beta</p><p>Gamma</p><p>Delta</p><p>Epsilon</p>',
            (i) => [
                replaceEdit(i, 1, '<p>ALPHA</p>', 0),
                insertEdit(2, '<p>Inserted</p>', 1),
                deleteEdit(i, 4, 5, 2),
            ]],
        ['adjacent deletions collapsing to one seam', '<p>Alpha</p><p>Beta</p><p>Gamma</p><p>Delta</p>',
            (i) => [deleteEdit(i, 1, 1, 0), deleteEdit(i, 2, 2, 1)]],
        ['repeated fragments', '<p>same</p><p>same</p><p>same</p><p>same</p>',
            (i) => [replaceEdit(i, 1, '<p>one</p>', 0), replaceEdit(i, 3, '<p>three</p>', 1)]],
        ['insert at both ends', '<p>Alpha</p><p>Beta</p>',
            () => [insertEdit(0, '<p>Head</p>', 0), insertEdit('end', '<p>Tail</p>', 1)]],
        ['multi-line content', '<p>Alpha</p><p>Beta</p>',
            (i) => [replaceEdit(i, 2, '<p>B1</p>\n<p>B2</p>\n<p>B3</p>')]],
    ];

    for (const [name, inner, build] of scenarios) {
        it(name, () => {
            loggerMock.mockClear();
            const f = fixture(inner);
            const index = buildIndex(f);
            const result = expectOk(select(index, build(index)));
            expect(result.skipped).toEqual([]);
            const resolved = result.applied.map((a) => a.resolved);
            const { newStrippedHtml, undoDrafts } = applyResolvedEdits(f.strippedHtml, resolved);
            expect(newStrippedHtml).not.toBe(f.strippedHtml);

            // The batch engine's own internal reverse simulation must have
            // reconstructed the pre-edit HTML (it logs when it does not).
            expect(loggerMock).not.toHaveBeenCalled();

            // And an explicit context-anchored replay reconstructs it too.
            expect(replayUndo(newStrippedHtml, undoDrafts)).toBe(f.strippedHtml);
        });
    }
});

