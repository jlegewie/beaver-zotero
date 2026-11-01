/**
 * Hanging-indent blocks in `detectParagraphs` (references, footnotes, lists
 * whose wrapped lines sit at an inner edge), enabled by
 * `ParagraphDetectionSettings.hangingIndentBlocks`.
 */

import { describe, expect, it } from 'vitest';
import { detectParagraphs } from '../../../src/beaver-extract/ParagraphDetector';
import type { DetectedSpan, PageLine, PageLineResult } from '../../../src/beaver-extract/LineDetector';
import type { BoundingBox, TextStyle } from '@beaver/agent-core/extract/types';

const BODY: TextStyle = { size: 10, font: 'Times-Roman', bold: false, italic: false };
const LINE_HEIGHT = 12;
const LINE_GAP = 2;
const RIGHT_MARGIN = 400;
const INDENT = 12;

interface RowSpec {
    text: string;
    l: number;
    r: number;
    /** Line height (default `LINE_HEIGHT`). */
    h?: number;
    /** Gap above the line (default `LINE_GAP`). */
    gap?: number;
    /** Reported (truncated) font size (default `BODY.size`). */
    size?: number;
    /** Exact font size, recorded as a per-glyph style run. */
    exact?: number;
}

function bbox(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: 'top-left' };
}

function makeLine(spec: RowSpec, top: number): PageLine {
    const box = bbox(spec.l, top, spec.r, top + (spec.h ?? LINE_HEIGHT));
    const size = spec.size ?? BODY.size;
    const glyphs = spec.text.replace(/\s/g, '').length;
    const span: DetectedSpan = {
        text: spec.text,
        bbox: box,
        lineBBox: box,
        size,
        fontName: BODY.font,
        fontWeight: 'normal',
        fontStyle: 'normal',
        styleRuns: spec.exact === undefined ? undefined : [{
            font: { name: BODY.font, family: BODY.font, weight: 'normal', style: 'normal', size },
            exactSize: spec.exact,
            chars: glyphs,
            letters: (spec.text.match(/\p{L}/gu) ?? []).length,
        }],
    };
    return { spans: [span], bboxes: [box], bbox: box, text: spec.text, fontSize: size };
}

function makeColumn(specs: RowSpec[]): PageLineResult {
    let top = 0;
    const lines = specs.map((s, i) => {
        if (i > 0) top += s.gap ?? LINE_GAP;
        const line = makeLine(s, top);
        top = line.bbox.b;
        return line;
    });
    const bottom = lines[lines.length - 1].bbox.b;
    return {
        pageIndex: 0,
        width: 612,
        height: 792,
        columnResults: [
            { column: { x: 0, y: 0, w: RIGHT_MARGIN, h: bottom }, columnIndex: 0, lines },
        ],
        allLines: lines,
    };
}

function paragraphTexts(specs: RowSpec[], hangingIndentBlocks = true): string[] {
    return detectParagraphs(makeColumn(specs), [BODY], { hangingIndentBlocks }).items.map(it => it.text);
}

const REFERENCES: RowSpec[] = [
    { text: 'Smith, J. 2010. A long title about policing and the', l: 0, r: RIGHT_MARGIN },
    { text: 'neighborhood. Journal of Things 3: 1-10.', l: INDENT, r: 200 },
    { text: 'Jones, K. 2011. Another title that wraps onto the next', l: 0, r: RIGHT_MARGIN },
    { text: 'line here. Review of Stuff 4: 5-9.', l: INDENT, r: 180 },
    { text: 'Brown, L. 2012. A single-line reference that fills the line.', l: 0, r: RIGHT_MARGIN },
];

describe('hanging-indent blocks', () => {
    it('leaves hanging blocks to the ordinary indent rules unless enabled', () => {
        expect(paragraphTexts(REFERENCES, false)).not.toContain(
            'Smith, J. 2010. A long title about policing and the neighborhood. Journal of Things 3: 1-10.',
        );
    });

    it('joins wrapped entries at the inner edge and starts each entry at the outer edge', () => {
        expect(paragraphTexts(REFERENCES)).toEqual([
            'Smith, J. 2010. A long title about policing and the neighborhood. Journal of Things 3: 1-10.',
            'Jones, K. 2011. Another title that wraps onto the next line here. Review of Stuff 4: 5-9.',
            'Brown, L. 2012. A single-line reference that fills the line.',
        ]);
    });

    it('keeps hanging entries whose wrapped last line runs into the next entry without a period', () => {
        expect(
            paragraphTexts([
                { text: 'Welch, K. 2011. The typification of Hispanics as', l: 0, r: RIGHT_MARGIN },
                { text: 'criminals and support for punitive policies. Social Science 40 (3): 822-40', l: INDENT, r: 385 },
                { text: 'Werthman, C. 1967. Gang members and the police. In The Police: Six', l: 0, r: RIGHT_MARGIN },
                { text: 'Sociological Essays, edited by D. Bordua, 56-98. New York: Wiley', l: INDENT, r: 300 },
                { text: 'Wood, S. N. 2017. Generalized Additive Models: An Introduction with R,', l: 0, r: RIGHT_MARGIN },
                { text: 'Second Edition. Boca Raton: CRC Press', l: INDENT, r: 200 },
            ]),
        ).toEqual([
            'Welch, K. 2011. The typification of Hispanics as criminals and support for punitive policies. Social Science 40 (3): 822-40',
            'Werthman, C. 1967. Gang members and the police. In The Police: Six Sociological Essays, edited by D. Bordua, 56-98. New York: Wiley',
            'Wood, S. N. 2017. Generalized Additive Models: An Introduction with R, Second Edition. Boca Raton: CRC Press',
        ]);
    });

    it('keeps an entry whose first line ends in an abbreviation and whose last line runs into the next entry', () => {
        expect(
            paragraphTexts([
                { text: 'Jones, N. 2001. The two or more races population: Census 2000 brief. U.S.', l: 0, r: RIGHT_MARGIN },
                { text: 'Census Bureau; 2001. Retrieved from http://www.census.gov/prod/2001pubs/c2kbr01', l: INDENT, r: 385 },
                { text: 'Kao, G. 2000. Racial identity and academic performance: an examination of', l: 0, r: RIGHT_MARGIN },
                { text: 'biracial Asian and African American youth. Journal 7: 1-20.', l: INDENT, r: 250 },
                { text: 'Lee, S. 2003. Another entry that wraps onto a second line at the', l: 0, r: RIGHT_MARGIN },
                { text: 'inner edge. Journal 9: 3-4.', l: INDENT, r: 200 },
            ]),
        ).toEqual([
            'Jones, N. 2001. The two or more races population: Census 2000 brief. U.S. Census Bureau; 2001. Retrieved from http://www.census.gov/prod/2001pubs/c2kbr01',
            'Kao, G. 2000. Racial identity and academic performance: an examination of biracial Asian and African American youth. Journal 7: 1-20.',
            'Lee, S. 2003. Another entry that wraps onto a second line at the inner edge. Journal 9: 3-4.',
        ]);
    });

    it('still joins a list that follows first-line-indented prose in the same block', () => {
        expect(
            paragraphTexts([
                { text: 'The previous paragraph ends at full width here with a final sentence.', l: 0, r: RIGHT_MARGIN },
                { text: 'We thank the reviewers for their helpful comments and the', l: INDENT, r: RIGHT_MARGIN },
                { text: 'editors for support during the review process.', l: 0, r: 250 },
                ...REFERENCES,
            ]),
        ).toEqual([
            'The previous paragraph ends at full width here with a final sentence.',
            'We thank the reviewers for their helpful comments and the editors for support during the review process.',
            'Smith, J. 2010. A long title about policing and the neighborhood. Journal of Things 3: 1-10.',
            'Jones, K. 2011. Another title that wraps onto the next line here. Review of Stuff 4: 5-9.',
            'Brown, L. 2012. A single-line reference that fills the line.',
        ]);
    });

    it('keeps an indented paragraph out of the last entry when its second line opens with a capital', () => {
        const texts = paragraphTexts([
            ...REFERENCES,
            { text: 'The first line of an indented paragraph cites the study by', l: INDENT, r: RIGHT_MARGIN },
            { text: 'Smith and Jones (2010), which showed that the effect holds across', l: 0, r: RIGHT_MARGIN },
            { text: 'several samples and ends here.', l: 0, r: 200 },
        ]);
        expect(texts).toEqual([
            'Smith, J. 2010. A long title about policing and the neighborhood. Journal of Things 3: 1-10.',
            'Jones, K. 2011. Another title that wraps onto the next line here. Review of Stuff 4: 5-9.',
            'Brown, L. 2012. A single-line reference that fills the line.',
            'The first line of an indented paragraph cites the study by Smith and Jones (2010), which showed that the effect holds across several samples and ends here.',
        ]);
    });

    it('keeps a numbered entry whose first line ends a sentence and whose last line runs into the next entry', () => {
        const texts = paragraphTexts([
            { text: '24. Rahi, S. Research design and methods: a systematic review of research', l: 0, r: RIGHT_MARGIN },
            { text: 'paradigms. Int. J. Econ. 2017, 6, 2.', l: INDENT, r: 200 },
            { text: '25. Burns, M.; Bally, J. What is constructivist grounded theory?', l: 0, r: RIGHT_MARGIN },
            { text: 'Methodological choices within specific study contexts. Int. J. Qual. Methods', l: INDENT, r: 385 },
            { text: '26. Snyder, H. Literature review as a research methodology: an overview and', l: 0, r: RIGHT_MARGIN },
            { text: '27. Petticrew, M. Systematic reviews in the social sciences.', l: 0, r: 300 },
        ]);
        expect(texts.slice(0, 2)).toEqual([
            '24. Rahi, S. Research design and methods: a systematic review of research paradigms. Int. J. Econ. 2017, 6, 2.',
            '25. Burns, M.; Bally, J. What is constructivist grounded theory? Methodological choices within specific study contexts. Int. J. Qual. Methods',
        ]);
        expect(texts[2]).toMatch(/^26\. Snyder/);
    });

    it('does not read lines offset by an opening full-width bracket as entries', () => {
        // Justified CJK prose: a line opening with "（" sits half an em left of
        // the others because the bracket's glyph box includes blank space.
        // Smaller text elsewhere on the page keeps the page's median line
        // height below the paragraph's, so the offset must be measured
        // against the paragraph's own lines.
        const smallPrint: RowSpec[] = Array.from({ length: 12 }, (_, i) => ({
            text: `Small table cell ${i + 1}`, l: 0, r: 120, h: 8,
        }));
        const texts = paragraphTexts([
            ...smallPrint,
            { text: '二级公立医院民营医院卒中患者的情况与上述结果', l: 0, r: RIGHT_MARGIN, gap: 40 },
            { text: '相似卒中最主要的危险因素也是高血压的缺血性卒', l: 6, r: RIGHT_MARGIN },
            { text: '中患者的脑出血患者和蛛网膜下腔出血患者均患有', l: 6, r: RIGHT_MARGIN },
            { text: '（15 900例）的蛛网膜下腔出血患者均患有高血', l: 0, r: RIGHT_MARGIN },
            { text: '压卒中最主要并发症是肺炎肺部感染的缺血性卒中', l: 6, r: RIGHT_MARGIN },
            { text: '（89 629例）的脑出血患者和的蛛网膜下腔出血', l: 0, r: RIGHT_MARGIN },
            { text: '患者均并发肺炎医院卒中患者的危险因素及并发症', l: 6, r: RIGHT_MARGIN },
            { text: '情况见图19。', l: 6, r: 120 },
        ]);
        expect(texts.filter(t => t.startsWith('（'))).toEqual([]);
    });

    it('reads bracket-numbered entries with a narrow hanging indent as entries', () => {
        // Body lines above anchor the column's left edge, so the ordinary
        // indent rule would split the continuations; the leader rule rejoins
        // them only after a first line that does not end a sentence.
        const body: RowSpec[] = Array.from({ length: 4 }, (_, i) => ({
            text: `Body text line ${i + 1} that runs across the full width of the column and`,
            l: 0,
            r: RIGHT_MARGIN,
        }));
        const texts = paragraphTexts([
            ...body,
            { text: '[1] Zhang S, Li W. A study of the effects of stroke care on', l: 0, r: RIGHT_MARGIN, gap: 40 },
            { text: 'outcomes in hospitals. Chin J Med 2019; 3: 1-9.', l: 7, r: 200 },
            { text: '[2] Wang X. Another reference title that ends at the margin.', l: 0, r: RIGHT_MARGIN },
            { text: 'J Stroke 2020; 4: 5-9.', l: 7, r: 180 },
            { text: '[3] Li Y. A final reference with its own wrapped line in the', l: 0, r: RIGHT_MARGIN },
            { text: 'inner column. J Med 2021; 5: 2-3.', l: 7, r: 200 },
        ]);
        expect(texts.slice(-3)).toEqual([
            '[1] Zhang S, Li W. A study of the effects of stroke care on outcomes in hospitals. Chin J Med 2019; 3: 1-9.',
            '[2] Wang X. Another reference title that ends at the margin. J Stroke 2020; 4: 5-9.',
            '[3] Li Y. A final reference with its own wrapped line in the inner column. J Med 2021; 5: 2-3.',
        ]);
    });


    it('keeps an indented paragraph out of a last entry that ends without punctuation', () => {
        const texts = paragraphTexts([
            ...REFERENCES.slice(0, 4),
            { text: 'Brown, L. 2012. A single-line reference ending in https://doi.org/10.1/x', l: 0, r: RIGHT_MARGIN },
            { text: 'The first line of an indented paragraph continues on', l: INDENT, r: RIGHT_MARGIN },
            { text: 'the next line flush with the margin and ends here.', l: 0, r: 250 },
        ]);
        expect(texts.slice(-2)).toEqual([
            'Brown, L. 2012. A single-line reference ending in https://doi.org/10.1/x',
            'The first line of an indented paragraph continues on the next line flush with the margin and ends here.',
        ]);
    });

    it('keeps an indented DOI line with its reference', () => {
        // The DOI reaches the margin, and the next entry is an unpunctuated
        // one-line entry followed by another entry.
        const texts = paragraphTexts([
            REFERENCES[0],
            REFERENCES[1],
            { text: 'Jones, K. 2011. Another study title. Review of Stuff 15: 125-150.', l: 0, r: RIGHT_MARGIN },
            { text: 'https://doi.org/10.1234/review.2011.015.125.extended-identifier', l: INDENT, r: 395 },
            { text: 'Brown, L. 2012. A one-line reference that fills the line 4: 5-9', l: 0, r: RIGHT_MARGIN },
            { text: 'Davis, M. 2013. A short last reference.', l: 0, r: 250 },
        ]);
        expect(texts[1]).toBe(
            'Jones, K. 2011. Another study title. Review of Stuff 15: 125-150. https://doi.org/10.1234/review.2011.015.125.extended-identifier',
        );
        expect(texts[2]).toMatch(/^Brown, L\. 2012\./);
    });

    it('needs a finished sentence before an indented line read as a paragraph continued by a capitalised line', () => {
        // The entry's first line ends in a page range without a period, so it
        // reads as finished for the lowercase check only.
        const texts = paragraphTexts([
            REFERENCES[0],
            REFERENCES[1],
            { text: 'Jones, K. 2011. Another study title. Review of Stuff 15: 125-150', l: 0, r: RIGHT_MARGIN },
            { text: 'Edited volume with further notes on the collection and its', l: INDENT, r: 395 },
            { text: 'Brown, L. 2012. A one-line reference that fills the line 4: 5-9', l: 0, r: RIGHT_MARGIN },
            { text: 'Davis, M. 2013. A short last reference.', l: 0, r: 250 },
        ]);
        expect(texts[1]).toBe(
            'Jones, K. 2011. Another study title. Review of Stuff 15: 125-150 Edited volume with further notes on the collection and its',
        );
        expect(texts[2]).toMatch(/^Brown, L\. 2012\./);
    });


    it('treats a sentence followed by a superscript citation as finished', () => {
        const body: RowSpec[] = Array.from({ length: 5 }, (_, i) => ({
            text: `Body text line ${i + 1} runs across the full width of the column and`,
            l: 0,
            r: RIGHT_MARGIN,
        }));
        const marks = ['¹', '¹²', '¹,³'];
        const paragraph = (n: number): RowSpec[] => [
            { text: `Paragraph ${n} opens with an indent and runs on until it reaches the`, l: INDENT, r: RIGHT_MARGIN },
            { text: `Margin, then it ends close to the edge with a citation marker.${marks[n - 1]}`, l: 0, r: 390 },
        ];
        const specs = [...body, ...paragraph(1), ...paragraph(2), ...paragraph(3)];
        const expected = [1, 2, 3].map(
            n => `Paragraph ${n} opens with an indent and runs on until it reaches the Margin, then it ends close to the edge with a citation marker.${marks[n - 1]}`,
        );
        expect(paragraphTexts(specs, false).slice(-3)).toEqual(expected);
        expect(paragraphTexts(specs).slice(-3)).toEqual(expected);
    });

    it('keeps an indented line inside a paragraph after the list as a continuation', () => {
        // The middle line sits at the inner edge (as when its first word is
        // lost) but continues an unfinished sentence, so it starts nothing.
        const texts = paragraphTexts([
            ...REFERENCES,
            { text: 'A body paragraph starts at the margin and keeps going until the', l: 0, r: RIGHT_MARGIN, gap: 20 },
            { text: 'line wraps here because a word went missing from its start and', l: INDENT, r: RIGHT_MARGIN },
            { text: 'the paragraph then continues at the margin until it ends.', l: 0, r: 260 },
        ]);
        expect(texts.slice(-1)).toEqual([
            'A body paragraph starts at the margin and keeps going until the line wraps here because a word went missing from its start and the paragraph then continues at the margin until it ends.',
        ]);
    });

    it('treats a sentence followed by a spaced citation marker as finished', () => {
        // Two-line first-line-indented paragraphs whose last lines run close
        // to the margin and end ". [17]".
        const paragraph = (n: number): RowSpec[] => [
            { text: `Paragraph ${n} opens with an indent and runs on until it reaches the`, l: INDENT, r: RIGHT_MARGIN },
            { text: `Margin, then it ends close to the edge with a citation marker. [${n}]`, l: 0, r: 390 },
        ];
        // A flush-left paragraph above anchors the column's left edge, as body
        // text does on a real page.
        const body: RowSpec[] = Array.from({ length: 5 }, (_, i) => ({
            text: `Body text line ${i + 1} runs across the full width of the column and`,
            l: 0,
            r: RIGHT_MARGIN,
        }));
        const specs = [...body, ...paragraph(1), ...paragraph(2), ...paragraph(3)];
        const expected = [1, 2, 3].map(
            n => `Paragraph ${n} opens with an indent and runs on until it reaches the Margin, then it ends close to the edge with a citation marker. [${n}]`,
        );
        expect(paragraphTexts(specs, false).slice(-3)).toEqual(expected);
        expect(paragraphTexts(specs).slice(-3)).toEqual(expected);
    });

    it('keeps a first-line-indented paragraph after the list out of the last entry', () => {
        const texts = paragraphTexts([
            ...REFERENCES,
            { text: 'The first line of an indented paragraph continues on', l: INDENT, r: RIGHT_MARGIN },
            { text: 'the next line flush with the margin and ends here.', l: 0, r: 250 },
        ]);
        expect(texts).toEqual([
            'Smith, J. 2010. A long title about policing and the neighborhood. Journal of Things 3: 1-10.',
            'Jones, K. 2011. Another title that wraps onto the next line here. Review of Stuff 4: 5-9.',
            'Brown, L. 2012. A single-line reference that fills the line.',
            'The first line of an indented paragraph continues on the next line flush with the margin and ends here.',
        ]);
    });

    it('starts an author-year entry right after a one-line entry that fills its line', () => {
        expect(
            paragraphTexts([
                ...REFERENCES.slice(0, 4),
                { text: 'Sejpal, K. (2013). Modular method of teaching. Journal of Education 2(2), 169 171', l: 0, r: RIGHT_MARGIN },
                { text: 'Stone-Romero, E. F., Alvarez, K., & Thompson, L. F. (2009). The construct', l: 0, r: RIGHT_MARGIN },
                { text: 'validity of conceptual and operational definitions. Journal 3: 4-5.', l: INDENT, r: 300 },
            ]).slice(2),
        ).toEqual([
            'Sejpal, K. (2013). Modular method of teaching. Journal of Education 2(2), 169 171',
            'Stone-Romero, E. F., Alvarez, K., & Thompson, L. F. (2009). The construct validity of conceptual and operational definitions. Journal 3: 4-5.',
        ]);
    });

    it('does not split flush-left prose after the list at a sentence that names an author', () => {
        const texts = paragraphTexts([
            ...REFERENCES.slice(0, 4),
            { text: 'Brown, L. 2012. A single-line reference that fills the line and the', l: 0, r: RIGHT_MARGIN },
            { text: 'However, Smith (2009) found that the effect holds widely across all', l: 0, r: RIGHT_MARGIN },
        ]);
        expect(texts[texts.length - 1]).toContain('However, Smith (2009)');
        expect(texts[texts.length - 1]).toContain('Brown, L. 2012.');
    });

    // A two-line indented paragraph whose second line opens with a capital
    // has the same layout as an entry whose last line runs into the next
    // entry (the abbreviation case above), so it still merges into the last
    // entry before it.
    it.todo('keeps a two-line indented paragraph with a capitalised second line out of the last entry');
    // Likewise for a longer paragraph whose second line opens with a capital
    // and ends a sentence at the margin: it has the shape of an entry whose
    // last line runs into a one-line entry ending in a period, which is the
    // reading reference lists need.
    it.todo('keeps an indented paragraph out of the last entry when its capitalised second line ends a sentence');
    // Known limitation: a heading set at the inner edge directly under the
    // last entry, with no more than normal leading, reads as that entry's
    // continuation and merges into it. Font size does not separate it: within
    // reference lists, larger-set continuation lines (URLs in a wider face)
    // are far more common. `it.fails` keeps the reproduction running and
    // flags the day it starts passing.
    it.fails('keeps a larger heading set directly under the last entry as its own item', () => {
        const texts = paragraphTexts([
            ...REFERENCES.map(spec => ({ ...spec, exact: 10 })),
            { text: 'Acknowledgments', l: INDENT, r: 110, size: 11, exact: 11 },
            { text: 'We thank the reviewers for their comments.', l: 0, r: 260, exact: 10 },
        ]);
        expect(texts).toContain('## Acknowledgments');
        expect(texts).toContain('Brown, L. 2012. A single-line reference that fills the line.');
    });
});
