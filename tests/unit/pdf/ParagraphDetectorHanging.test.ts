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
}

function bbox(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: 'top-left' };
}

function makeLine(spec: RowSpec, top: number): PageLine {
    const box = bbox(spec.l, top, spec.r, top + (spec.h ?? LINE_HEIGHT));
    const span: DetectedSpan = {
        text: spec.text,
        bbox: box,
        lineBBox: box,
        size: BODY.size,
        fontName: BODY.font,
        fontWeight: 'normal',
        fontStyle: 'normal',
    };
    return { spans: [span], bboxes: [box], bbox: box, text: spec.text, fontSize: BODY.size };
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

    // A two-line indented paragraph whose second line opens with a capital
    // has the same layout as an entry whose last line runs into the next
    // entry (the abbreviation case above), so it still merges into the last
    // entry before it.
    it.todo('keeps a two-line indented paragraph with a capitalised second line out of the last entry');
});
