/**
 * Convert the MathML subset KaTeX emits into Office Math Markup (OMML), the
 * native, editable equation format of Word.
 *
 * Covers tokens (`mi`, `mn`, `mo`, `mtext`, `mspace`), scripts, fractions
 * (including `\binom`'s bar-less fraction), radicals, accents and bars,
 * under/over limits and braces, n-ary operators (sums, products, integrals)
 * with their operand, function application (`\sin x`), stretchy fences
 * (`\left( … \right)`, `pmatrix`), matrices/aligned environments and boxes.
 * Anything else throws `UnsupportedMathError`, and the caller falls back to
 * the LaTeX source as text.
 */

import { elementChildren, escapeXml, textContent, type XmlElement } from './xml';

export class UnsupportedMathError extends Error {}

/** Characters of n-ary operators, which take limits and an operand. */
const NARY_CHARS = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰', '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨀', '⨄', '⨆']);
const INTEGRALS = new Set(['∫', '∬', '∭', '∮', '∯', '∰']);
/** Operators that end an n-ary operand. */
const OPERAND_TERMINATORS = new Set(['=', '<', '>', '≤', '≥', '≠', '≈', '≡', '∼', '≃', '≅', '∝', '+', '−', '-', '±', '∓', ',', ';', '→', '⇒', '⟹', '⇔', '⟺', '∈', '∉', '⊂', '⊆', '⊃', '⊇']);
/** Function application (U+2061), KaTeX's marker after an operator name. */
const FUNCTION_APPLICATION = '⁡';

/** Spacing accents KaTeX writes, mapped to the combining marks OMML expects. */
const ACCENTS: Record<string, string> = {
    '^': '̂', 'ˆ': '̂', '̂': '̂',
    '~': '̃', '˜': '̃', '̃': '̃',
    'ˉ': '̄', '¯': '̄', '̄': '̄',
    '˙': '̇', '̇': '̇',
    '¨': '̈', '̈': '̈',
    'ˇ': '̌', '̌': '̌',
    '´': '́', 'ˊ': '́', '́': '́',
    '`': '̀', 'ˋ': '̀', '̀': '̀',
    '˘': '̆', '̆': '̆',
    '˚': '̊', '̊': '̊',
    '⃗': '⃗', '→': '⃗',
};
const OVERBARS = new Set(['‾', '¯', '_', '−', '―']);
const GROUP_CHARS = new Set(['⏞', '⏟', '⏜', '⏝', '⎴', '⎵']);

const MATH_FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

type Variant = 'plain' | 'italic' | 'bold' | 'bold-italic' | 'normal-text';

function run(text: string, variant: Variant = 'italic', script?: string): string {
    if (!text) return '';
    const properties: string[] = [];
    if (variant === 'normal-text') properties.push('<m:nor/>');
    if (script) properties.push(`<m:scr m:val="${script}"/>`);
    if (variant === 'plain') properties.push('<m:sty m:val="p"/>');
    else if (variant === 'bold') properties.push('<m:sty m:val="b"/>');
    else if (variant === 'bold-italic') properties.push('<m:sty m:val="bi"/>');
    const rPr = properties.length > 0 ? `<m:rPr>${properties.join('')}</m:rPr>` : '';
    return `<m:r>${rPr}${MATH_FONT}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;
}

/** Map a MathML `mathvariant` to OMML style and script. */
function tokenStyle(element: XmlElement, text: string): { variant: Variant; script?: string } {
    const mathvariant = element.attributes.mathvariant;
    switch (mathvariant) {
        case 'normal': return { variant: 'plain' };
        case 'bold': return { variant: 'bold' };
        case 'italic': return { variant: 'italic' };
        case 'bold-italic': return { variant: 'bold-italic' };
        case 'double-struck': return { variant: 'plain', script: 'double-struck' };
        case 'script': return { variant: 'plain', script: 'script' };
        case 'bold-script': return { variant: 'bold', script: 'script' };
        case 'fraktur': return { variant: 'plain', script: 'fraktur' };
        case 'bold-fraktur': return { variant: 'bold', script: 'fraktur' };
        case 'sans-serif': return { variant: 'plain', script: 'sans-serif' };
        case 'bold-sans-serif': return { variant: 'bold', script: 'sans-serif' };
        case 'sans-serif-italic': return { variant: 'italic', script: 'sans-serif' };
        case 'monospace': return { variant: 'plain', script: 'monospace' };
        default:
            // MathML: a single-character identifier is italic, a longer one (an operator name) upright.
            return { variant: [...text].length > 1 ? 'plain' : 'italic' };
    }
}

function isElement(element: XmlElement | undefined, name: string): element is XmlElement {
    return element?.name === name;
}

/** The operator character of an n-ary operator, with or without limits. */
function naryOperator(element: XmlElement): { chr: string; base: XmlElement; sub?: XmlElement; sup?: XmlElement; underOver: boolean } | null {
    const children = elementChildren(element);
    const operatorChar = (candidate: XmlElement | undefined): string | null => {
        if (!isElement(candidate, 'mo')) return null;
        const text = textContent(candidate).trim();
        return NARY_CHARS.has(text) ? text : null;
    };
    switch (element.name) {
        case 'mo': {
            const chr = operatorChar(element);
            return chr ? { chr, base: element, underOver: false } : null;
        }
        case 'msub':
        case 'munder': {
            const chr = operatorChar(children[0]);
            return chr ? { chr, base: children[0], sub: children[1], underOver: element.name === 'munder' } : null;
        }
        case 'msup':
        case 'mover': {
            const chr = operatorChar(children[0]);
            return chr ? { chr, base: children[0], sup: children[1], underOver: element.name === 'mover' } : null;
        }
        case 'msubsup':
        case 'munderover': {
            const chr = operatorChar(children[0]);
            return chr ? { chr, base: children[0], sub: children[1], sup: children[2], underOver: element.name === 'munderover' } : null;
        }
        default:
            return null;
    }
}

class OmmlConverter {
    convertNode(element: XmlElement): string {
        switch (element.name) {
            case 'math':
            case 'mrow':
            case 'mstyle':
            case 'mpadded':
                return this.sequence(elementChildren(element));
            case 'semantics':
                return this.convertNode(elementChildren(element)[0] ?? { type: 'element', name: 'mrow', attributes: {}, children: [] });
            case 'annotation':
            case 'annotation-xml':
            case 'mphantom':
                return '';
            case 'mi':
            case 'mn':
            case 'mo':
            case 'mtext':
            case 'ms':
                return this.token(element);
            case 'mspace': {
                const width = Number.parseFloat(element.attributes.width ?? '0');
                return width >= 0.2 ? run(width >= 0.9 ? ' ' : ' ', 'plain') : '';
            }
            case 'msup':
            case 'msub':
            case 'msubsup':
            case 'munder':
            case 'mover':
            case 'munderover': {
                const nary = naryOperator(element);
                if (nary) return this.nary(nary, '');
                return this.scripts(element);
            }
            case 'mfrac': {
                const [num, den] = this.requireChildren(element, 2);
                const thickness = element.attributes.linethickness;
                const noBar = thickness !== undefined && Number.parseFloat(thickness) === 0;
                const fPr = noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : '';
                return `<m:f>${fPr}<m:num>${this.convertNode(num)}</m:num><m:den>${this.convertNode(den)}</m:den></m:f>`;
            }
            case 'msqrt':
                return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${this.sequence(elementChildren(element))}</m:e></m:rad>`;
            case 'mroot': {
                const [base, index] = this.requireChildren(element, 2);
                return `<m:rad><m:deg>${this.convertNode(index)}</m:deg><m:e>${this.convertNode(base)}</m:e></m:rad>`;
            }
            case 'mtable':
                return this.table(element);
            case 'menclose':
                return this.enclose(element);
            default:
                throw new UnsupportedMathError(`Unsupported MathML element <${element.name}>`);
        }
    }

    /** `\boxed`, and the strike-outs of `\cancel`, `\bcancel`, `\xcancel`, `\sout`. */
    private enclose(element: XmlElement): string {
        const notations = (element.attributes.notation ?? '').split(/\s+/).filter(Boolean);
        const strikes: Record<string, string> = {
            updiagonalstrike: '<m:strikeBLTR m:val="1"/>',
            downdiagonalstrike: '<m:strikeTLBR m:val="1"/>',
            horizontalstrike: '<m:strikeH m:val="1"/>',
        };
        const box = notations.includes('box');
        const properties: string[] = [];
        for (const notation of notations) {
            if (notation === 'box') continue;
            if (!strikes[notation]) throw new UnsupportedMathError(`Unsupported menclose notation ${notation}`);
            properties.push(strikes[notation]);
        }
        if (!box) {
            properties.unshift('<m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/>');
        }
        const borderBoxPr = properties.length > 0 ? `<m:borderBoxPr>${properties.join('')}</m:borderBoxPr>` : '';
        return `<m:borderBox>${borderBoxPr}<m:e>${this.sequence(elementChildren(element))}</m:e></m:borderBox>`;
    }

    private requireChildren(element: XmlElement, count: number): XmlElement[] {
        const children = elementChildren(element);
        if (children.length < count) throw new UnsupportedMathError(`<${element.name}> needs ${count} children`);
        return children;
    }

    private token(element: XmlElement): string {
        const text = textContent(element);
        if (element.name === 'mtext' || element.name === 'ms') return run(text, 'normal-text');
        // Invisible operators: function application, times, separator.
        if (element.name === 'mo' && (text === FUNCTION_APPLICATION || text === '\u2062' || text === '\u2063')) return '';
        if (element.name === 'mo' || element.name === 'mn') {
            // Numbers and operators are upright unless a variant says otherwise (`\mathbb{1}`).
            if (!element.attributes.mathvariant) return run(text, 'plain');
            const { variant, script } = tokenStyle(element, text);
            return run(text, variant, script);
        }
        const { variant, script } = tokenStyle(element, text);
        return run(text, variant, script);
    }

    /** Convert siblings, pairing n-ary operators with their operand, functions with their argument, and fences into delimiters. */
    sequence(children: XmlElement[]): string {
        const fenced = this.fence(children);
        if (fenced !== null) return fenced;
        let out = '';
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const nary = naryOperator(child);
            if (nary) {
                let end = i + 1;
                // A sign right after the operator is the operand's own (`\sum -x_i`).
                if (end < children.length && this.isSign(children[end])) end++;
                while (end < children.length && !this.endsOperand(children[end])) end++;
                out += this.nary(nary, this.sequence(children.slice(i + 1, end)));
                i = end - 1;
                continue;
            }
            const next = children[i + 1];
            if (isElement(next, 'mo') && textContent(next) === FUNCTION_APPLICATION && children[i + 2]) {
                const argument = children[i + 2];
                out += `<m:func><m:fName>${this.convertNode(child)}</m:fName><m:e>${this.convertNode(argument)}</m:e></m:func>`;
                i += 2;
                continue;
            }
            out += this.convertNode(child);
        }
        return out;
    }

    private isSign(element: XmlElement): boolean {
        return element.name === 'mo' && ['+', '-', '\u2212', '\u00b1', '\u2213'].includes(textContent(element).trim());
    }

    private endsOperand(element: XmlElement): boolean {
        return element.name === 'mo' && OPERAND_TERMINATORS.has(textContent(element).trim());
    }

    /** `(` … `)` written as stretchy fences becomes a delimiter object. */
    private fence(children: XmlElement[]): string | null {
        const first = children[0];
        const last = children[children.length - 1];
        if (children.length < 2 || !isElement(first, 'mo') || !isElement(last, 'mo')) return null;
        if (first.attributes.fence !== 'true' || last.attributes.fence !== 'true') return null;
        const inner = children.slice(1, -1);
        const begin = textContent(first);
        const end = textContent(last);
        return `<m:d><m:dPr><m:begChr m:val="${escapeXml(begin)}"/><m:endChr m:val="${escapeXml(end)}"/></m:dPr>`
            + `<m:e>${this.sequence(inner)}</m:e></m:d>`;
    }

    private nary(
        nary: { chr: string; sub?: XmlElement; sup?: XmlElement; underOver: boolean },
        operand: string,
    ): string {
        const properties = [`<m:chr m:val="${escapeXml(nary.chr)}"/>`];
        // Limits sit under/over the operator when KaTeX placed them there (display
        // sums); integrals and inline operators keep them as scripts.
        properties.push(`<m:limLoc m:val="${nary.underOver && !INTEGRALS.has(nary.chr) ? 'undOvr' : 'subSup'}"/>`);
        if (!nary.sub) properties.push('<m:subHide m:val="1"/>');
        if (!nary.sup) properties.push('<m:supHide m:val="1"/>');
        const sub = nary.sub ? this.convertNode(nary.sub) : '';
        const sup = nary.sup ? this.convertNode(nary.sup) : '';
        return `<m:nary><m:naryPr>${properties.join('')}</m:naryPr><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup><m:e>${operand}</m:e></m:nary>`;
    }

    private scripts(element: XmlElement): string {
        const children = this.requireChildren(element, element.name === 'msubsup' || element.name === 'munderover' ? 3 : 2);
        const [base, first, second] = children;
        switch (element.name) {
            case 'msup':
                return `<m:sSup><m:e>${this.convertNode(base)}</m:e><m:sup>${this.convertNode(first)}</m:sup></m:sSup>`;
            case 'msub':
                return `<m:sSub><m:e>${this.convertNode(base)}</m:e><m:sub>${this.convertNode(first)}</m:sub></m:sSub>`;
            case 'msubsup':
                return `<m:sSubSup><m:e>${this.convertNode(base)}</m:e><m:sub>${this.convertNode(first)}</m:sub><m:sup>${this.convertNode(second)}</m:sup></m:sSubSup>`;
            case 'mover':
                return this.over(element, base, first);
            case 'munder':
                return this.under(element, base, first);
            default: {
                // munderover: limits below and above.
                const lower = `<m:limLow><m:e>${this.convertNode(base)}</m:e><m:lim>${this.convertNode(first)}</m:lim></m:limLow>`;
                return `<m:limUpp><m:e>${lower}</m:e><m:lim>${this.convertNode(second)}</m:lim></m:limUpp>`;
            }
        }
    }

    private over(element: XmlElement, base: XmlElement, mark: XmlElement): string {
        const markText = isElement(mark, 'mo') ? textContent(mark).trim() : '';
        if (markText && element.attributes.accent === 'true') {
            if (OVERBARS.has(markText) && mark.attributes.stretchy === 'true') {
                return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${this.convertNode(base)}</m:e></m:bar>`;
            }
            const accent = ACCENTS[markText];
            if (accent) {
                return `<m:acc><m:accPr><m:chr m:val="${accent}"/></m:accPr><m:e>${this.convertNode(base)}</m:e></m:acc>`;
            }
        }
        if (GROUP_CHARS.has(markText)) {
            return `<m:groupChr><m:groupChrPr><m:chr m:val="${markText}"/><m:pos m:val="top"/><m:vertJc m:val="bot"/></m:groupChrPr><m:e>${this.convertNode(base)}</m:e></m:groupChr>`;
        }
        return `<m:limUpp><m:e>${this.convertNode(base)}</m:e><m:lim>${this.convertNode(mark)}</m:lim></m:limUpp>`;
    }

    private under(element: XmlElement, base: XmlElement, mark: XmlElement): string {
        const markText = isElement(mark, 'mo') ? textContent(mark).trim() : '';
        if (markText && element.attributes.accentunder === 'true' && (OVERBARS.has(markText) || markText === '_')) {
            return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${this.convertNode(base)}</m:e></m:bar>`;
        }
        if (GROUP_CHARS.has(markText)) {
            return `<m:groupChr><m:groupChrPr><m:chr m:val="${markText}"/></m:groupChrPr><m:e>${this.convertNode(base)}</m:e></m:groupChr>`;
        }
        return `<m:limLow><m:e>${this.convertNode(base)}</m:e><m:lim>${this.convertNode(mark)}</m:lim></m:limLow>`;
    }

    private table(element: XmlElement): string {
        const rows = elementChildren(element).filter(row => row.name === 'mtr' || row.name === 'mlabeledtr');
        if (rows.length === 0) return '';
        const cellsOf = (row: XmlElement) => {
            const cells = elementChildren(row).filter(cell => cell.name === 'mtd');
            // A labeled row's first cell is the equation number.
            return row.name === 'mlabeledtr' ? cells.slice(1) : cells;
        };
        const columns = Math.max(...rows.map(row => cellsOf(row).length), 1);
        const alignments = (element.attributes.columnalign ?? '').split(/\s+/).filter(Boolean);
        const columnProperties = Array.from({ length: columns }, (_, index) => {
            const align = alignments[index] ?? alignments[alignments.length - 1] ?? 'center';
            const jc = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
            return `<m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="${jc}"/></m:mcPr></m:mc>`;
        }).join('');
        const body = rows.map(row => {
            const cells = cellsOf(row);
            const converted = Array.from({ length: columns }, (_, index) =>
                `<m:e>${cells[index] ? this.sequence(elementChildren(cells[index])) : ''}</m:e>`);
            return `<m:mr>${converted.join('')}</m:mr>`;
        }).join('');
        return `<m:m><m:mPr><m:mcs>${columnProperties}</m:mcs></m:mPr>${body}</m:m>`;
    }
}

/** Convert a MathML `<math>` element to the inner content of an `m:oMath`. */
export function mathmlToOmmlContent(math: XmlElement): string {
    return new OmmlConverter().convertNode(math);
}
