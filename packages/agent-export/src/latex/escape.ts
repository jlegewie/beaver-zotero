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

/** Text as LaTeX source that prints the same text. */
export function escapeLatex(text: string): string {
    return text
        // Paired straight quotes become typographic quotes.
        .replace(/"([^"\n]*)"/g, '\u201c$1\u201d')
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
