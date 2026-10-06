/**
 * Text and URLs made safe for LaTeX source.
 *
 * Exported documents are meant to compile with LuaLaTeX or XeLaTeX and also
 * with pdfLaTeX for Latin scripts. Characters with a special meaning in
 * LaTeX are written as commands, and the symbols model output commonly uses in
 * running text (arrows, comparison signs, Greek letters) as math symbols:
 * pdfLaTeX's input encoding rejects them and the default fonts of the Unicode
 * engines lack them.
 */

const SPECIALS: Record<string, string> = {
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    $: '\\$',
    '&': '\\&',
    '#': '\\#',
    '%': '\\%',
    _: '\\_',
    '^': '\\textasciicircum{}',
    '~': '\\textasciitilde{}',
    '<': '\\textless{}',
    '>': '\\textgreater{}',
    '|': '\\textbar{}',
    // Left alone, a straight double quote prints as a closing quote.
    '"': '\\textquotedbl{}',
    ' ': '~',
};

const MATH_SYMBOLS: Record<string, string> = {
    '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow',
    '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
    '↑': '\\uparrow', '↓': '\\downarrow',
    '≈': '\\approx', '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≡': '\\equiv', '∼': '\\sim',
    '−': '-', '∞': '\\infty', '√': '\\surd', '∑': '\\sum', '∏': '\\prod', '∈': '\\in', '∉': '\\notin',
    '∂': '\\partial', '∇': '\\nabla', '∆': '\\Delta', '∝': '\\propto', '∩': '\\cap', '∪': '\\cup',
    '✓': '\\checkmark', '✔': '\\checkmark', '✗': '\\times', '✘': '\\times',
    '⊂': '\\subset', '⊆': '\\subseteq', '∀': '\\forall', '∃': '\\exists', '∅': '\\emptyset', '′': '\\prime',
    'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon', 'ζ': '\\zeta',
    'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
    'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma', 'ς': '\\varsigma',
    'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
    'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi',
    'Σ': '\\Sigma', 'Υ': '\\Upsilon', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
};

const ESCAPE_PATTERN = new RegExp(
    `[${Object.keys({ ...SPECIALS, ...MATH_SYMBOLS }).map(char => char.replace(/[\\\]^-]/g, '\\$&')).join('')}]`,
    'g',
);

/**
 * Prose as LaTeX source that prints the same text, with straight quotes made
 * typographic. A straight double quote alone prints as a closing quote, and so
 * does a single quote opening a quotation; a pair of either becomes opening and
 * closing quotes. A single quote that is not part of a quoted phrase is an
 * apostrophe (`don't`, `'90s`, `rock 'n' roll`), which LaTeX already prints.
 */
export function escapeLatex(text: string): string {
    return escapeLatexCode(text
        .replace(/"([^"\n]*)"/g, '\u201c$1\u201d')
        .replace(/(?<![\p{L}\p{N}])'([^'\s\d][^'\n]*?[^'\s])'(?![\p{L}\p{N}])/gu, '\u2018$1\u2019'));
}

/** Text as LaTeX source that prints exactly these characters (code): no typographic quotes. */
export function escapeLatexCode(text: string): string {
    return text
        .replace(ESCAPE_PATTERN, char => SPECIALS[char] ?? `\\ensuremath{${MATH_SYMBOLS[char]}}`)
        // `--` and `---` are dash ligatures; a hyphen pair as written stays two
        // hyphens. A kern separates them in every engine (LuaTeX ligatures
        // across an empty group).
        .replace(/-(?=-)/g, '-\\kern0pt');
}

/**
 * A URL as the argument of `\href` / `\url`. Characters that would end or
 * reinterpret the argument are percent-encoded or escaped the way hyperref
 * reads them back, also inside another command's argument (a footnote).
 */
export function latexUrl(url: string): string {
    return url
        .trim()
        .replace(/[\\{}^~\s]/g, char => (char === '~' ? '%7E' : encodeURIComponent(char)))
        .replace(/[#%&]/g, char => `\\${char}`);
}
