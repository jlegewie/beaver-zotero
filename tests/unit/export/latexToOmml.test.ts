import { describe, expect, it } from 'vitest';
import { latexToOmml } from '@beaver/agent-export/math/latexToOmml';

const omml = (latex: string, display = false) => latexToOmml(latex, display);

describe('latexToOmml', () => {
    it('converts fractions, roots and scripts', () => {
        const { xml, converted } = omml('\\frac{a}{b} + \\sqrt{x} + \\sqrt[3]{y} + x_i^2');
        expect(converted).toBe(true);
        expect(xml).toMatch(/^<m:oMath>/);
        expect(xml).toContain('<m:f><m:num>');
        expect(xml).toContain('<m:degHide m:val="1"/>');
        expect(xml).toContain('<m:rad><m:deg>');
        expect(xml).toContain('<m:sSubSup>');
    });

    it('wraps display math in oMathPara', () => {
        expect(omml('x', true).xml).toMatch(/^<m:oMathPara>.*<m:oMath>.*<\/m:oMathPara>$/);
    });

    it('turns sums and integrals into n-ary objects that take their operand', () => {
        const { xml } = omml('\\sum_{i=1}^{n} x_i = \\int_0^1 f(x)\\,dx', true);
        expect(xml).toContain('<m:chr m:val="∑"/><m:limLoc m:val="undOvr"/>');
        expect(xml).toContain('<m:chr m:val="∫"/><m:limLoc m:val="subSup"/>');
        // The sum's operand stops at the equals sign.
        expect(xml).toMatch(/<m:e><m:sSub>.*?<\/m:sSub><\/m:e><\/m:nary><m:r>.*?=<\/m:t>/);
    });

    it('keeps a leading sign inside the n-ary operand', () => {
        const { xml } = omml('\\sum_{i=1}^n -x_i');
        expect(xml).toMatch(/<m:e><m:r>.*?\u2212<\/m:t><\/m:r><m:sSub>/);
    });

    it('maps accents, bars, fences, matrices and functions', () => {
        expect(omml('\\hat{\\beta}').xml).toContain('<m:acc><m:accPr><m:chr m:val="̂"/>');
        expect(omml('\\overline{AB}').xml).toContain('<m:bar><m:barPr><m:pos m:val="top"/>');
        expect(omml('\\left( \\frac{1}{2} \\right)').xml).toContain('<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/>');
        const matrix = omml('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}').xml;
        expect(matrix).toContain('<m:m>');
        expect(matrix.match(/<m:mr>/g)).toHaveLength(2);
        expect(omml('\\sin x').xml).toContain('<m:func><m:fName>');
        expect(omml('\\binom{n}{k}').xml).toContain('<m:type m:val="noBar"/>');
        // A thin but visible bar keeps its bar.
        expect(omml('\\genfrac{}{}{0.4pt}{}{a}{b}').xml).not.toContain('noBar');
    });

    it('styles identifiers like MathML does', () => {
        expect(omml('\\mathbb{R}').xml).toContain('<m:scr m:val="double-struck"/>');
        expect(omml('\\mathbb{1}').xml).toContain('<m:scr m:val="double-struck"/>');
        expect(omml('\\mathbf{2}').xml).toContain('<m:sty m:val="b"/>');
        expect(omml('2+x').xml).toContain('<m:sty m:val="p"/>');
        expect(omml('\\text{if }').xml).toContain('<m:nor/>');
        expect(omml('x').xml).not.toContain('<m:sty');
    });

    it('keeps cancel notation as strike-outs', () => {
        const cancel = omml('\\cancel{x}+x=0');
        expect(cancel.converted).toBe(true);
        expect(cancel.xml).toContain('<m:strikeBLTR m:val="1"/>');
        expect(cancel.xml).toContain('<m:hideTop m:val="1"/>');
        expect(omml('\\bcancel{x}').xml).toContain('<m:strikeTLBR m:val="1"/>');
        expect(omml('\\xcancel{x}').xml).toMatch(/strikeTLBR.*strikeBLTR|strikeBLTR.*strikeTLBR/);
        expect(omml('\\boxed{x}').xml).not.toContain('hideTop');
    });

    it('falls back to the LaTeX source for input KaTeX cannot parse', () => {
        const result = omml('\\frac{a}{');
        expect(result.converted).toBe(false);
        expect(result.xml).toContain('\\frac{a}{');
    });

    it('escapes XML special characters', () => {
        expect(omml('a < b').xml).toContain('&lt;');
    });
});
