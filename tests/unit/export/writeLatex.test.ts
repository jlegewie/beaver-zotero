import { describe, expect, it } from 'vitest';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import { liftTags, wrappingColumns, writeLatex } from '@beaver/agent-export/latex/writeLatex';
import { escapeLatex, latexUrl } from '@beaver/agent-export/latex/escape';
import type { ExportDoc, FieldCitationItem, FormattedCitations, LatexExportOptions } from '@beaver/agent-export/types';

/** Library item ids of the test keys. */
const IDS: Record<string, number> = { AAAAAAAA: 1, BBBBBBBB: 2, CCCCCCCC: 3 };
const KEYS = { 1: 'smith_title_2004', 2: 'doe:x/y', 3: 'zed2010' };

/** Clusters whose items are the cited keys, with the pages written in the tag. */
function citations(doc: ExportDoc, styleClass: 'in-text' | 'note', citationFormat?: string): FormattedCitations {
    return {
        styleId: 'style',
        locale: 'en-US',
        styleClass,
        ...(citationFormat ? { citationFormat } : {}),
        clusters: doc.clusters.map(cluster => {
            const items: FieldCitationItem[] = cluster.items.map(occurrence => {
                const key = /u-(\w+)/.exec(occurrence.rawTag)?.[1] ?? '';
                const page = /loc="page([\d-]+)"/.exec(occurrence.rawTag)?.[1];
                return { id: IDS[key] ?? 99, uris: [], itemData: {}, ...(page ? { locator: page, label: 'page' } : {}) };
            });
            return { html: '(Smith, <i>2004</i>)', plain: '(Smith, 2004)', noteIndex: 0, items, fallbackTexts: [] };
        }),
        bibliography: null,
        documentData: null,
    };
}

const options: LatexExportOptions = {
    citationPackage: 'biblatex',
    standalone: false,
    bibFileName: 'refs.bib',
    linkItems: false,
    bibliographyTitle: 'References',
    date: 'October 5, 2026',
};

function write(markdown: string, styleClass: 'in-text' | 'note' = 'in-text', extra: Partial<LatexExportOptions> = {}, citationFormat?: string) {
    const doc = parseExportSource({ title: 'Report', blocks: [{ type: 'markdown', markdown }] });
    return writeLatex({ doc, citations: citations(doc, styleClass, citationFormat), keys: KEYS, options: { ...options, ...extra } });
}

/** The body after the header comments. */
const body = (tex: string) => tex.replace(/^(%.*\n)+\n/, '');

describe('liftTags', () => {
    it('turns an aligned block with tags into align*, where each line may carry one', () => {
        expect(liftTags(String.raw`\begin{aligned} a &= b \\ c &= d \tag{2}\end{aligned}`))
            .toBe(String.raw`\begin{align*} a &= b \\ c &= d \tag{2}\end{align*}`);
    });

    it('leaves the tags of a complete display environment where they are', () => {
        const equation = String.raw`\begin{equation}x=y\tag{A}\end{equation}`;
        expect(liftTags(equation)).toBe(equation);
        const { tex } = write('$$\\begin{equation}x=y\\tag{A}\\end{equation}$$');
        expect(tex).toContain(equation);
        expect(tex).not.toContain('\\[');
    });

    it('moves a single nested tag to the end of the display and leaves top-level tags alone', () => {
        expect(liftTags(String.raw`x = \begin{cases} 1 \tag{3} \end{cases}`)).toBe(String.raw`x = \begin{cases} 1  \end{cases} \tag{3}`);
        expect(liftTags(String.raw`E[Y] = 0 \tag{1}`)).toBe(String.raw`E[Y] = 0 \tag{1}`);
    });
});

describe('escapeLatex', () => {
    it('escapes special characters and keeps hyphen pairs apart', () => {
        expect(escapeLatex('\\ { } $ & # % _ ^ ~ < > |')).toBe(
            '\\textbackslash{} \\{ \\} \\$ \\& \\# \\% \\_ \\textasciicircum{} \\textasciitilde{} \\textless{} \\textgreater{} \\textbar{}');
        expect(escapeLatex('1990--2000')).toBe('1990-\\kern0pt-2000');
    });

    it('writes symbols the default fonts lack as math', () => {
        expect(escapeLatex('β ≈ 0.3 → up')).toBe('\\ensuremath{\\beta} \\ensuremath{\\approx} 0.3 \\ensuremath{\\rightarrow} up');
        expect(escapeLatex('über café ✓')).toBe('über café \\ensuremath{\\checkmark}');
    });

    it('writes straight double quotes as typographic quotes', () => {
        expect(escapeLatex('a "quoted" word and 5" more')).toBe('a \u201cquoted\u201d word and 5\\textquotedbl{} more');
    });

    it('makes a quoted phrase in single quotes typographic, and leaves apostrophes alone', () => {
        expect(escapeLatex("say 'single quotes' and ('x y')")).toBe('say \u2018single quotes\u2019 and (\u2018x y\u2019)');
        // Apostrophes print right in LaTeX as they are.
        expect(escapeLatex("don't, the '90s, rock 'n' roll, the students' work")).toBe("don't, the '90s, rock 'n' roll, the students' work");
    });

    it('leaves the quotes of inline code exactly as written', () => {
        const { tex } = write('Run `print(\'hi\', "x")` now.');
        expect(tex).toContain("\\texttt{print('hi', \\textquotedbl{}x\\textquotedbl{})}");
    });

    it('keeps the number of a numbered task item, with the checkbox after it', () => {
        const { tex } = write('1. [x] done\n2. [ ] open\n\n- [x] bullet');
        expect(tex).toContain('\\item $\\boxtimes$ done');
        expect(tex).toContain('\\item $\\square$ open');
        expect(tex).toContain('\\item[$\\boxtimes$] bullet');
    });
});

describe('latexUrl', () => {
    it('escapes what would end or reinterpret the argument', () => {
        expect(latexUrl('https://e.org/a b?x=1&y=2#f%20~u{}')).toBe('https://e.org/a\\%20b?x=1\\&y=2\\#f\\%20\\%7Eu\\%7B\\%7D');
    });
});

describe('writeLatex', () => {
    it('maps markdown structure to LaTeX', () => {
        const { tex } = write('Intro *em* **strong** `co_de` [web](https://example.com) <https://x.org>.\n\n## Heading\n\n### Sub\n\n- one\n- [two] items\n\n3. third\n\n> quoted\n\n```\nraw \\x\n```\n\n---\n\n- [x] done');
        expect(body(tex)).toBe([
            'Intro \\emph{em} \\textbf{strong} \\texttt{co\\_de} \\href{https://example.com}{web} \\url{https://x.org}.',
            '',
            '\\section*{Heading}',
            '',
            '\\subsection*{Sub}',
            '',
            '\\begin{itemize}',
            '\\item one',
            '\\item {}[two] items',
            '\\end{itemize}',
            '',
            '\\begin{enumerate}',
            '\\setcounter{enumi}{2}',
            '\\item third',
            '\\end{enumerate}',
            '',
            '\\begin{quote}',
            'quoted',
            '\\end{quote}',
            '',
            '\\begin{Verbatim}[breaklines,breakanywhere]',
            'raw \\x',
            '\\end{Verbatim}',
            '',
            '\\begin{center}',
            '\\rule{0.5\\linewidth}{0.4pt}',
            '\\end{center}',
            '',
            '\\begin{itemize}',
            '\\item[$\\boxtimes$] done',
            '\\end{itemize}',
            '',
        ].join('\n'));
    });

    it('cites with biblatex keys, pages as postnotes', () => {
        const { tex, stats } = write('A <citation id="u-AAAAAAAA" loc="page3-5"/>. B<citation id="u-AAAAAAAA"/><citation id="u-BBBBBBBB"/>. C <citation id="u-AAAAAAAA"/><citation id="u-BBBBBBBB" loc="page12"/>.');
        expect(body(tex)).toBe('A \\parencite[3--5]{smith_title_2004}. B \\parencite{smith_title_2004,doe:x/y}. C \\parencites{smith_title_2004}[12]{doe:x/y}.\n');
        expect(stats.citations).toBe(3);
    });

    it('cites with natbib, adding the page prefix itself', () => {
        const { tex } = write('A <citation id="u-AAAAAAAA" loc="page3"/>. B <citation id="u-AAAAAAAA" loc="page3-5"/><citation id="u-BBBBBBBB"/>. C <citation id="u-AAAAAAAA"/><citation id="u-BBBBBBBB"/>.', 'in-text', { citationPackage: 'natbib' });
        expect(body(tex)).toBe('A \\citep[p.~3]{smith_title_2004}. B \\citetext{\\citealp[pp.~3--5]{smith_title_2004}; \\citealp{doe:x/y}}. C \\citep{smith_title_2004,doe:x/y}.\n');
    });

    it('makes note-style citations footnotes, numbered with markdown footnotes', () => {
        const markdown = 'One <citation id="u-AAAAAAAA"/>. Two[^n]. Again[^n].\n\n'
            + '| Claim | Source |\n|---|---|\n| x | y <citation id="u-BBBBBBBB" loc="page2"/> |\n\nAfter <citation id="u-CCCCCCCC"/>.\n\n[^n]: A note <citation id="u-CCCCCCCC"/>.';
        const { tex, stats } = write(markdown, 'note');
        expect(body(tex)).toBe([
            '\\edef\\BeaverFootnoteBase{\\number\\value{footnote}}',
            'One\\autocite{smith_title_2004}. Two\\footnote{A note \\autocite{zed2010}.}. Again\\footnotemark[\\numexpr\\BeaverFootnoteBase+2\\relax].',
            '',
            '\\begin{longtable}[l]{@{}l l@{}}',
            '\\toprule',
            'Claim & Source \\\\',
            '\\midrule',
            '\\endhead',
            'x & y\\footnotemark[\\numexpr\\BeaverFootnoteBase+3\\relax] \\\\',
            '\\bottomrule',
            '\\end{longtable}',
            // The table's note is written at its number after the table.
            '\\setcounter{footnote}{\\numexpr\\BeaverFootnoteBase+3\\relax}\\footcitetext[2]{doe:x/y}',
            '',
            'After\\autocite{zed2010}.',
            '',
        ].join('\n'));
        expect(stats.footnotes).toBe(4);
    });

    it('writes natbib notes as footnotes it makes itself', () => {
        const { tex } = write('One <citation id="u-AAAAAAAA" loc="page4"/>.', 'note', { citationPackage: 'natbib' });
        expect(body(tex)).toBe('One\\footnote{\\citealp[p.~4]{smith_title_2004}.}.\n');
    });

    it('wraps the wide columns of a table too wide for the line', () => {
        const { tex } = write(`| A | B |\n|:-:|---|\n| 1 | ${'a cell that is long enough to need wrapping '.repeat(2)}|`);
        expect(tex).toContain('\\begin{xltabular}[l]{\\linewidth}{@{}c >{\\raggedright\\arraybackslash}X@{}}');
        expect(write('| A | B |\n|---|---|\n| 1 | a cell that fits on the line as it is |').tex).toContain('\\begin{longtable}[l]{@{}l l@{}}');
    });

    it('decides wrapping by the width of the whole table', () => {
        expect(wrappingColumns([10, 30])).toEqual([false, false]);
        // Five medium columns are too wide together.
        expect(wrappingColumns([26, 26, 26, 26, 4])).toEqual([true, true, true, true, false]);
        expect(wrappingColumns(Array(10).fill(12))).toEqual(Array(10).fill(true));
    });

    it('passes equations through, provides KaTeX shorthands, and keeps environments as displays', () => {
        const { tex } = write('Inline $x \\in \\R$.\n\n$$\\frac{a}{b}$$\n\n$$\n\\begin{align}\na &= b\n\\end{align}\n$$', 'in-text', { standalone: true });
        expect(tex).toContain('Inline \\(x \\in \\R\\).');
        expect(tex).toContain('\\[\n\\frac{a}{b}\n\\]');
        expect(tex).toContain('\n\\begin{align}\na &= b\n\\end{align}\n');
        expect(tex).toContain('\\providecommand{\\R}{\\mathbb{R}}');
    });

    it('keeps a citation without a key as its formatted text and warns', () => {
        const { tex, warnings } = write('Lost <citation id="u-ZZZZZZZZ"/>.');
        expect(body(tex)).toBe('Lost (Smith, 2004).\n');
        expect(warnings.map(warning => warning.code)).toEqual(['citations_as_text']);
    });

    it('keeps a cluster with a keyless work as text rather than dropping the work', () => {
        const { tex, warnings } = write('Both <citation id="u-AAAAAAAA"/><citation id="u-ZZZZZZZZ"/>.');
        // The work with a key still enters the bibliography.
        expect(body(tex)).toBe('Both (Smith, 2004)\\nocite{smith_title_2004}.\n');
        expect(warnings[0].count).toBe(1);
        const standalone = write('Both <citation id="u-AAAAAAAA"/><citation id="u-ZZZZZZZZ"/>.', 'in-text', { standalone: true }).tex;
        expect(standalone).toContain('\\addbibresource{refs.bib}');
        expect(standalone).toContain('\\printbibliography');
    });

    it('keeps footnotes and citations out of strikethrough', () => {
        const { tex } = write('~~Struck text[^a] and claim <citation id="u-AAAAAAAA"/> end~~.\n\n[^a]: Note.', 'note');
        expect(body(tex)).toBe('\\sout{Struck text}\\footnote{Note.}\\sout{ and claim}\\autocite{smith_title_2004}\\sout{ end}.\n');
        expect(write('~~claim<citation id="u-AAAAAAAA"/>~~').tex).toContain('\\sout{claim} \\parencite{smith_title_2004}');
        expect(write('~~plain~~').tex).toContain('\\sout{plain}');
    });

    it('writes a standalone document with the bibliography setup for the style', () => {
        const { tex } = write('A <citation id="u-AAAAAAAA"/>.', 'in-text', { standalone: true }, 'numeric');
        expect(tex).toContain('\\documentclass[11pt]{article}');
        expect(tex).toContain('\\usepackage[letterpaper,margin=1in]{geometry}');
        expect(tex).toContain('\\usepackage[backend=biber,style=numeric-comp,sorting=none,isbn=false]{biblatex}\n\\addbibresource{refs.bib}');
        // URLs and access dates only for web pages, as CSL styles show them.
        expect(tex).toContain('\\AtEveryBibitem{\\BeaverClearUrl}\n\\AtEveryCitekey{\\BeaverClearUrl}');
        expect(tex).toContain('\\usepackage{parskip}');
        expect(tex).toContain('\\title{Report}\n\\author{}\n\\date{October 5, 2026}');
        expect(tex).toContain('\\maketitle\n\nA \\parencite{smith_title_2004}.\n\n\\printbibliography[title={References}]\n\n\\end{document}\n');

        const natbib = write('A <citation id="u-AAAAAAAA"/>.', 'in-text', { standalone: true, citationPackage: 'natbib' }, 'author-date').tex;
        expect(natbib).toContain('\\usepackage[round]{natbib}');
        expect(natbib).toContain('\\bibliographystyle{plainnat}\n\\bibliography{refs}');
    });

    it('leaves the bibliography out of a document that cites nothing', () => {
        const { tex } = write('No citations.', 'in-text', { standalone: true });
        expect(tex).not.toContain('biblatex');
        expect(tex).not.toContain('printbibliography');
    });

    it('describes what the including document must provide in body-only output', () => {
        const { tex } = write('A <citation id="u-AAAAAAAA"/>.');
        expect(tex).toContain('% Cites with biblatex (style=authoryear,isbn=false); add \\addbibresource{refs.bib} to the preamble.');
        // The including document keeps its own paragraph style.
        expect(tex).not.toContain('parskip');
    });

    it('wraps long code lines and loads the package that does it', () => {
        const { tex } = write('```\nx = 1\n\\end{Verbatim}\n```', 'in-text', { standalone: true });
        expect(tex).toContain('\\usepackage{fvextra}');
        expect(tex).toContain('\\begin{Verbatim}[breaklines,breakanywhere]\nx = 1\n\\end {Verbatim}\n\\end{Verbatim}');
    });

    it('writes a tagged aligned equation as align*, without \\[ \\] around it', () => {
        const { tex } = write('$$\\begin{aligned}\na &= b \\tag{2}\n\\end{aligned}$$');
        expect(tex).toContain('\\begin{align*}\na &= b \\tag{2}\n\\end{align*}');
        expect(tex).not.toContain('\\[');
    });

    it('loads the packages of math commands beyond amsmath', () => {
        const { tex } = write('$$X \\centernot\\perp Y \\quad a \\coloneqq b$$', 'in-text', { standalone: true });
        expect(tex).toContain('\\usepackage{mathtools}');
        expect(tex).toContain('\\usepackage{centernot}');
    });

    it('sets up CJK script for LuaLaTeX and XeLaTeX, and says pdfLaTeX cannot compile it', () => {
        const chinese = write('Wang Xiaoming (王小明) argues…', 'in-text', { standalone: true }).tex;
        expect(chinese).toContain('Compile with LuaLaTeX or XeLaTeX (not pdfLaTeX');
        expect(chinese).toContain('\\usepackage{luatexja-fontspec}\n  \\ltjsetparameter{jacharrange={-9}}');
        expect(chinese).toContain('\\usepackage{xeCJK}');
        expect(chinese).toContain('\\errmessage{This document contains Chinese, Japanese or Korean text');
        // Hangul needs a font the Japanese setup and xeCJK's default lack: LuaLaTeX only.
        const korean = write('김철수 argues…', 'in-text', { standalone: true }).tex;
        expect(korean).toContain('\\usepackage{luatexko}');
        expect(korean).toContain('Compile with LuaLaTeX (the text has Korean script)');
        expect(korean).not.toContain('\\usepackage{xeCJK}');
        expect(korean).toContain('Compile it with LuaLaTeX}');
        const latin = write('Plain text.', 'in-text', { standalone: true }).tex;
        expect(latin).not.toContain('xeCJK');
        expect(latin).toContain('LuaLaTeX, XeLaTeX or pdfLaTeX');
        expect(write('王小明').tex).toContain('% Has Chinese, Japanese or Korean text: compile with LuaLaTeX (package luatexja-fontspec');
        expect(write('김철수').tex).toContain('% Has Korean text: compile with LuaLaTeX (package luatexko).');
    });

    it('numbers body-only footnotes from where the body is inserted', () => {
        const { tex } = write('A[^n]. B[^n].\n\n| x |\n|---|\n| y[^m] |\n\n[^n]: Note.\n\n[^m]: Cell note.');
        expect(tex).toContain('\\edef\\BeaverFootnoteBase{\\number\\value{footnote}}\nA\\footnote{Note.}. B\\footnotemark[\\numexpr\\BeaverFootnoteBase+1\\relax].');
        expect(tex).toContain('y\\footnotemark[\\numexpr\\BeaverFootnoteBase+2\\relax]');
        expect(tex).toContain('\\setcounter{footnote}{\\numexpr\\BeaverFootnoteBase+2\\relax}\\footnotetext{Cell note.}');
        expect(write('A[^n].\n\n[^n]: Note.').tex).not.toContain('BeaverFootnoteBase');
    });

    it('nests note headings below the note title', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'note', title: 'My note', markdown: '# Part\n\nText.' }] });
        const { tex } = writeLatex({ doc, citations: citations(doc, 'in-text'), keys: KEYS, options });
        expect(body(tex)).toBe('\\section*{My note}\n\n\\subsection*{Part}\n\nText.\n');
    });
});
