/**
 * Unit tests for line-break de-hyphenation in the sentence pipeline.
 *
 * A word split across a physical line break ("con-" / "sequences") must be
 * rejoined in the extracted sentence text. The default is to drop the hyphen
 * and join ("consequences"); a genuine compound attested elsewhere in the
 * document (e.g. "broken-windows") keeps its hyphen. Suspended hyphens within
 * a single line ("individual- and") and non-letter neighbours are untouched.
 *
 * The pipeline reconstructs sentence text from the source map in
 * `sentenceToBoxes` (not from the de-hyphenated paragraph string), so the
 * `extractPageSentences` integration cases below are the ones that actually
 * exercise the end-to-end behaviour — `buildParagraphText` alone is necessary
 * but not sufficient.
 */

import { describe, it, expect } from 'vitest';
import {
    buildParagraphText,
    collectHyphenatedCompounds,
    decideLineBreakHyphen,
    extractPageSentences,
} from '../../../src/beaver-extract/ParagraphSentenceMapper';
import {
    bboxFromXYWH,
    type RawChar,
    type RawLineDetailed,
    type RawBlockDetailed,
    type RawPageDataDetailed,
    type QuadPoint,
} from '../../../src/beaver-extract/types';

// ---------------------------------------------------------------------------
// Synthetic line/page builders (same grid as paragraphSentenceMapper tests)
// ---------------------------------------------------------------------------

function makeLine(text: string, yTop: number, xStart = 50): RawLineDetailed {
    const chars: RawChar[] = [];
    const charH = 12;
    for (let i = 0; i < text.length; i++) {
        const x = xStart + i * 10;
        const quad: QuadPoint = [x, yTop, x + 10, yTop, x, yTop + charH, x + 10, yTop + charH];
        chars.push({ c: text[i], quad, bbox: bboxFromXYWH(x, yTop, 10, charH, 'top-left') });
    }
    return {
        wmode: 0,
        bbox: bboxFromXYWH(xStart, yTop, text.length * 10, charH, 'top-left'),
        font: { name: 'Body', family: 'Body', weight: 'normal', style: 'normal', size: 12 },
        x: xStart,
        y: yTop,
        text,
        chars,
    };
}

/** One text block holding `lines`, sized to its content. */
function makeSingleBlockPage(lines: RawLineDetailed[]): RawPageDataDetailed {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of lines) {
        minX = Math.min(minX, l.bbox.l);
        minY = Math.min(minY, l.bbox.t);
        maxX = Math.max(maxX, l.bbox.r);
        maxY = Math.max(maxY, l.bbox.b);
    }
    const block: RawBlockDetailed = {
        type: 'text',
        bbox: bboxFromXYWH(minX, minY, maxX - minX, maxY - minY, 'top-left'),
        lines,
    };
    const width = maxX + 50;
    const height = maxY + 50;
    return {
        pageIndex: 0,
        pageNumber: 1,
        width,
        height,
        viewBox: [0, 0, width, height],
        rotation: 0,
        blocks: [block],
    };
}

/** Concatenate every sentence's text on the page, in item order. */
function allSentenceText(page: RawPageDataDetailed, vocab?: ReadonlySet<string>): string {
    const result = extractPageSentences(page, { compoundVocabulary: vocab });
    return result.sentences.map((s) => s.text).join(' ');
}

// ---------------------------------------------------------------------------
// decideLineBreakHyphen
// ---------------------------------------------------------------------------

describe('decideLineBreakHyphen', () => {
    it('joins a soft hyphen when no vocabulary is supplied', () => {
        expect(decideLineBreakHyphen('a focus on strict enforcement of con-', 'sequences here'))
            .toBe('join');
    });

    it('keeps the hyphen when the compound is attested in the vocabulary', () => {
        const vocab = new Set(['neighborhood-level']);
        expect(decideLineBreakHyphen('Both individual- and neighborhood-', 'level exposure', vocab))
            .toBe('keep');
    });

    it('defaults to join when the compound is not in the vocabulary', () => {
        expect(decideLineBreakHyphen('Both individual- and neighborhood-', 'level exposure', new Set()))
            .toBe('join');
    });

    it('is case-insensitive against the vocabulary', () => {
        const vocab = new Set(['kohler-hausmann']);
        expect(decideLineBreakHyphen('disorderly behavior (Kohler-', 'Hausmann 2013)', vocab))
            .toBe('keep');
    });

    it('keeps a break at the inner hyphen of a multi-hyphen compound', () => {
        // The probe key is the two parts adjacent to the break: "in-differences".
        const vocab = collectHyphenatedCompounds(['a difference-in-differences design']);
        expect(decideLineBreakHyphen('uses a difference-in-', 'differences design', vocab)).toBe('keep');
        expect(decideLineBreakHyphen('uses a difference-', 'in-differences design', vocab)).toBe('keep');
    });

    it('matches even when the previous line has trailing whitespace after the hyphen', () => {
        const vocab = new Set(['broken-windows']);
        expect(decideLineBreakHyphen('proactive or broken- ', 'windows policing', vocab)).toBe('keep');
        expect(decideLineBreakHyphen('proactive or broken- ', 'windows policing')).toBe('join');
    });

    it('returns none when the previous line does not end in <letter>-', () => {
        expect(decideLineBreakHyphen('a complete word', 'next line')).toBe('none');
    });

    it('returns none when the next line does not start with a letter', () => {
        // A hyphen before a number (e.g. "covering 4.6 million time-" / "2010") is not a split word.
        expect(decideLineBreakHyphen('covering the years 2004 to 2007 time-', '2010 onward')).toBe('none');
    });

    it('does not treat an em dash at line end as a word-continuation hyphen', () => {
        expect(decideLineBreakHyphen('a hard break—', 'next clause')).toBe('none');
    });

    // Rule: a hyphen inside a URL / email / DOI / path token is literal — keep
    // it (and drop the line-break space) so the link reconstructs intact.
    it('keeps the literal hyphen of a URL / DOI / path token', () => {
        expect(decideLineBreakHyphen('see https://example.com/some-', 'article here')).toBe('keep');
        expect(decideLineBreakHyphen('doi:10.1234/abcd-', 'efgh')).toBe('keep');
        expect(decideLineBreakHyphen('/usr/local/some-', 'bin path')).toBe('keep');
    });

    it('keeps the literal hyphen of an email or scheme-less www token', () => {
        expect(decideLineBreakHyphen('contact first-', 'last@example.com')).toBe('keep');
        expect(decideLineBreakHyphen('visit www.broken-', 'windows.org')).toBe('keep');
    });

    it('still joins an ordinary hyphen when a URL appears elsewhere on the line', () => {
        // The URL token is not adjacent to the break, so the guard must not fire.
        expect(decideLineBreakHyphen('see http://x.org and con-', 'sequences')).toBe('join');
    });

    it('joins a soft hyphen when a bare slash is a conjunction, not a path', () => {
        // "inequality/stratification" and "evaluation/optimisation" contain a
        // slash but are not URLs/paths — the soft hyphen must still fuse.
        expect(decideLineBreakHyphen('social inequality/stratifica-', 'tion and class')).toBe('join');
        expect(decideLineBreakHyphen('decision evaluation/optimisa-', 'tion problems')).toBe('join');
        expect(decideLineBreakHyphen('the and/or oper-', 'ator combines')).toBe('join');
    });

    it('treats a host.tld, file extension, or bare DOI as a real path signal', () => {
        expect(decideLineBreakHyphen('at example.com/some-', 'article today')).toBe('keep');
        expect(decideLineBreakHyphen('the report-', 'final.pdf attachment')).toBe('keep');
        expect(decideLineBreakHyphen('cited as 10.1234/abc-', 'def hereafter')).toBe('keep');
    });

    // Rule: never fuse across a hyphen adjacent to a digit. Already enforced by
    // the letter-anchored regexes (a digit is not `\p{L}`); locked in here.
    it('never fuses a hyphen adjacent to a digit', () => {
        expect(decideLineBreakHyphen('the COVID-', '19 pandemic')).toBe('none');   // digit after
        expect(decideLineBreakHyphen('roughly 15-', 'trillion dollars')).toBe('none'); // digit before
        expect(decideLineBreakHyphen('from 2004-', '2007 inclusive')).toBe('none'); // year range
        expect(decideLineBreakHyphen('Section 3-', 'b discusses')).toBe('none');
    });
});

// ---------------------------------------------------------------------------
// collectHyphenatedCompounds
// ---------------------------------------------------------------------------

describe('collectHyphenatedCompounds', () => {
    it('collects an in-line hyphenated compound, lowercased', () => {
        const vocab = collectHyphenatedCompounds(['proactive or broken-windows policing,']);
        expect(vocab.has('broken-windows')).toBe(true);
    });

    it('ignores a hyphen at the end of a line (no following letter in the same string)', () => {
        // A line-break hyphen never enters the vocabulary — the continuation is on the next line.
        const vocab = collectHyphenatedCompounds(['enforcement of broken-']);
        expect(vocab.size).toBe(0);
    });

    it('collects multiple compounds and accumulates into a provided set', () => {
        const into = new Set<string>(['existing-term']);
        collectHyphenatedCompounds(['high-crime areas and low-level offenses'], into);
        expect(into.has('high-crime')).toBe(true);
        expect(into.has('low-level')).toBe(true);
        expect(into.has('existing-term')).toBe(true);
    });

    it('records every consecutive pair of a multi-hyphen compound', () => {
        const vocab = collectHyphenatedCompounds(['the difference-in-differences estimator']);
        expect(vocab.has('difference-in')).toBe(true);
        expect(vocab.has('in-differences')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// buildParagraphText (paragraph string + source map)
// ---------------------------------------------------------------------------

describe('buildParagraphText line-break de-hyphenation', () => {
    it('joins a soft hyphen, dropping the hyphen and the inter-line space', () => {
        const pt = buildParagraphText([makeLine('focus on con-', 100), makeLine('sequences here.', 115)]);
        expect(pt.text).toBe('focus on consequences here.');
        // Lockstep preserved and the dropped hyphen has no source entry.
        expect(pt.source.length).toBe(pt.text.length);
        const hyphenSourced = pt.source.some(
            (s) => s !== null && s.lineIndex === 0 && s.charIndex === 12,
        );
        expect(hyphenSourced).toBe(false);
    });

    it('keeps the hyphen for a genuine compound but still drops the space', () => {
        const vocab = new Set(['neighborhood-level']);
        const pt = buildParagraphText(
            [makeLine('exposure at the neighborhood-', 100), makeLine('level is stratified.', 115)],
            vocab,
        );
        expect(pt.text).toBe('exposure at the neighborhood-level is stratified.');
        expect(pt.source.length).toBe(pt.text.length);
    });

    it('defaults to joining a compound that is not in the vocabulary', () => {
        const pt = buildParagraphText(
            [makeLine('exposure at the neighborhood-', 100), makeLine('level is stratified.', 115)],
            new Set(),
        );
        expect(pt.text).toBe('exposure at the neighborhoodlevel is stratified.');
    });

    it('keeps a compound when the previous line ends in hyphen + trailing space', () => {
        const vocab = new Set(['broken-windows']);
        const pt = buildParagraphText(
            [makeLine('proactive or broken- ', 100), makeLine('windows policing.', 115)],
            vocab,
        );
        expect(pt.text).toBe('proactive or broken-windows policing.');
        expect(pt.source.length).toBe(pt.text.length);
    });

    it('leaves a hyphen before a non-letter untouched', () => {
        const pt = buildParagraphText([makeLine('the years 2004 time-', 100), makeLine('2010 onward.', 115)]);
        expect(pt.text).toBe('the years 2004 time- 2010 onward.');
    });

    it('does not join across an em dash at the line break', () => {
        const pt = buildParagraphText([makeLine('a hard break—', 100), makeLine('next clause.', 115)]);
        expect(pt.text).toBe('a hard break— next clause.');
    });

    it('leaves a suspended hyphen within a single line untouched', () => {
        const pt = buildParagraphText([makeLine('individual- and neighborhood effects.', 100)]);
        expect(pt.text).toBe('individual- and neighborhood effects.');
    });

    it('preserves the inter-line space for an ordinary (non-hyphenated) line break', () => {
        const pt = buildParagraphText([makeLine('Alpha beta.', 100), makeLine('Gamma delta.', 115)]);
        expect(pt.text).toBe('Alpha beta. Gamma delta.');
    });

    it('reconstructs a URL split at a hyphen without fusing or spacing it', () => {
        // The hyphen is literal (keep it) and the line-break space is dropped,
        // so the link survives intact — not "somearticle" and not "some- article".
        const pt = buildParagraphText([
            makeLine('see https://example.com/some-', 100),
            makeLine('article for details.', 115),
        ]);
        expect(pt.text).toBe('see https://example.com/some-article for details.');
    });

    it('keeps a multi-hyphen compound broken at its inner hyphen', () => {
        const vocab = collectHyphenatedCompounds(['a difference-in-differences design']);
        const pt = buildParagraphText(
            [makeLine('we use a difference-in-', 100), makeLine('differences design.', 115)],
            vocab,
        );
        expect(pt.text).toBe('we use a difference-in-differences design.');
        expect(pt.source.length).toBe(pt.text.length);
    });

    it('drops leading whitespace on the continuation line when joining', () => {
        // The continuation line is indented with a leading space; it must not
        // resurface as "con sequences".
        const pt = buildParagraphText([makeLine('focus on con-', 100), makeLine(' sequences here.', 115)]);
        expect(pt.text).toBe('focus on consequences here.');
        expect(pt.source.length).toBe(pt.text.length);
    });

    it('drops leading whitespace on the continuation line when keeping a compound', () => {
        const vocab = new Set(['broken-windows']);
        const pt = buildParagraphText(
            [makeLine('proactive or broken-', 100), makeLine('  windows policing.', 115)],
            vocab,
        );
        expect(pt.text).toBe('proactive or broken-windows policing.');
        expect(pt.source.length).toBe(pt.text.length);
    });
});

// ---------------------------------------------------------------------------
// extractPageSentences (end-to-end: sentence text is rebuilt in sentenceToBoxes)
// ---------------------------------------------------------------------------

describe('extractPageSentences line-break de-hyphenation', () => {
    it('joins a soft hyphen in the emitted sentence text and spans both lines', () => {
        const page = makeSingleBlockPage([
            makeLine('We document the con-', 100),
            makeLine('sequences of policing.', 115),
        ]);
        const result = extractPageSentences(page);
        const sentence = result.sentences[0];
        expect(sentence.text).toContain('consequences');
        // Regression guard: the source-map reconstruction must not re-insert a space.
        expect(sentence.text).not.toContain('conse quence');
        expect(sentence.text).not.toContain('con- sequence');
        // The rejoined word's highlight spans both source lines.
        expect(sentence.bboxes.length).toBe(2);
    });

    it('keeps a genuine compound (no space) in the emitted sentence text', () => {
        const vocab = new Set(['broken-windows']);
        const page = makeSingleBlockPage([
            makeLine('Aggressive broken-', 100),
            makeLine('windows policing spread.', 115),
        ]);
        const text = allSentenceText(page, vocab);
        expect(text).toContain('broken-windows');
        expect(text).not.toContain('broken- windows');
        expect(text).not.toContain('brokenwindows');
    });

    it('defaults to joining the compound when no vocabulary is supplied', () => {
        const page = makeSingleBlockPage([
            makeLine('Aggressive broken-', 100),
            makeLine('windows policing spread.', 115),
        ]);
        const text = allSentenceText(page);
        expect(text).toContain('brokenwindows');
    });

    it('keeps the space for an ordinary line break', () => {
        const page = makeSingleBlockPage([
            makeLine('The quick brown', 100),
            makeLine('fox jumped over.', 115),
        ]);
        const text = allSentenceText(page);
        expect(text).toContain('brown fox');
    });
});
