/**
 * LaTeX → OMML: KaTeX parses the LaTeX and emits MathML, which is converted
 * to Office Math. A construct KaTeX cannot parse, or one the converter does
 * not cover, is exported as its LaTeX source in a plain-text math run.
 */

import katex from 'katex';
import { mathmlToOmmlContent, UnsupportedMathError } from './mathmlToOmml';
import { escapeXml, parseXml, type XmlElement, type XmlNode } from './xml';

export interface OmmlResult {
    /** `m:oMath` (inline) or `m:oMathPara` (display) XML. */
    xml: string;
    /** False when the equation was exported as LaTeX text. */
    converted: boolean;
}

function findMath(nodes: XmlNode[]): XmlElement | null {
    for (const node of nodes) {
        if (node.type !== 'element') continue;
        if (node.name === 'math') return node;
        const nested = findMath(node.children);
        if (nested) return nested;
    }
    return null;
}

function wrap(content: string, display: boolean): string {
    const math = `<m:oMath>${content}</m:oMath>`;
    if (!display) return math;
    return `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${math}</m:oMathPara>`;
}

function linearText(latex: string): string {
    return `<m:r><m:rPr><m:nor/></m:rPr><m:t xml:space="preserve">${escapeXml(latex)}</m:t></m:r>`;
}

/**
 * LaTeX commands KaTeX lacks, as KaTeX equivalents. Pass a copy per render:
 * KaTeX may write `\gdef` definitions into the object.
 */
export const KATEX_MACROS: Readonly<Record<string, string>> = {
    // `centernot` package: a slash through the following relation.
    '\\centernot': '\\not',
};

/** Relations `\centernot` negates, as the negated symbol KaTeX has. */
const CENTERNOT_SYMBOLS: Record<string, string> = {
    '\\implies': '\\nRightarrow', '\\Rightarrow': '\\nRightarrow', '\\Longrightarrow': '\\nRightarrow',
    '\\Leftarrow': '\\nLeftarrow', '\\impliedby': '\\nLeftarrow',
    '\\iff': '\\nLeftrightarrow', '\\Leftrightarrow': '\\nLeftrightarrow',
    '\\rightarrow': '\\nrightarrow', '\\to': '\\nrightarrow', '\\leftarrow': '\\nleftarrow',
    '\\leftrightarrow': '\\nleftrightarrow',
    '=': '\\neq', '\\in': '\\notin', '\\sim': '\\nsim', '\\mid': '\\nmid', '\\cong': '\\ncong',
};

/**
 * LaTeX as KaTeX should read it: `\centernot` before a relation with a
 * negated symbol becomes that symbol (`\centernot\implies` → `\nRightarrow`);
 * any other `\centernot` falls back to `\not` through `KATEX_MACROS`.
 */
export function katexSource(latex: string): string {
    return latex.trim().replace(/\\centernot\s*(\\[a-zA-Z]+|=)/g, (match, relation: string) => CENTERNOT_SYMBOLS[relation] ?? match);
}

/** Convert LaTeX to OMML. Never throws. */
export function latexToOmml(latex: string, display: boolean): OmmlResult {
    const source = latex.trim();
    try {
        const mathml = katex.renderToString(katexSource(source), {
            output: 'mathml',
            displayMode: display,
            throwOnError: true,
            strict: 'ignore',
            trust: false,
            macros: { ...KATEX_MACROS },
        });
        const math = findMath(parseXml(mathml));
        if (!math) throw new UnsupportedMathError('KaTeX produced no MathML');
        return { xml: wrap(mathmlToOmmlContent(math), display), converted: true };
    } catch {
        return { xml: wrap(linearText(source), display), converted: false };
    }
}
