/**
 * The look of exported HTML/PDF documents, defined in one place.
 *
 * `HTML_THEME` holds the typographic decisions in print units and
 * `stylesheet()` turns them into the document's CSS; the writer only emits
 * semantic markup and class names. The defaults follow the Word theme
 * (`docx/theme.ts`) — a plain academic manuscript — so the two exports of the
 * same content look alike.
 */

import type { PaperSizeSetting } from '../page';
import type { BibliographyLayout } from '../types';

export interface HtmlTheme {
    fonts: {
        /** CSS font-family lists. */
        body: string;
        headings: string;
        mono: string;
        /** Chat chrome: the prompt label and tool activity lines. */
        ui: string;
    };
    /** Font sizes in points. */
    sizes: {
        body: number;
        title: number;
        heading1: number;
        heading2: number;
        heading3: number;
        /** Heading 4–6. */
        heading4: number;
        /** Endnotes. */
        note: number;
        /** Tool activity lines and prompt labels. */
        activity: number;
        code: number;
        table: number;
    };
    /** CSS colors. */
    colors: {
        text: string;
        headings: string;
        /** Secondary text: tool activity, prompt labels. */
        muted: string;
        /** The action of a tool-call line. */
        mutedStrong: string;
        link: string;
        /** Table rules, quote bars. */
        rule: string;
        codeBackground: string;
        /** Fill of a user prompt's card. */
        promptBackground: string;
    };
    /** Spacing in points; `lineHeight` is a CSS line-height multiple. */
    spacing: {
        lineHeight: number;
        paragraphAfter: number;
        titleAfter: number;
        headingBefore: number;
        headingAfter: number;
        listItemAfter: number;
        blockBefore: number;
    };
    /** Indents in inches. */
    indents: {
        list: number;
        quote: number;
    };
    page: {
        /** Inches on every side. */
        margin: number;
        /** `auto` picks US Letter for US/Canadian English citation locales, A4 otherwise. */
        size: PaperSizeSetting;
        pageNumbers: boolean;
    };
}

export const HTML_THEME: HtmlTheme = {
    fonts: {
        // A PDF embeds the fonts of the computer that prints it: Charter on
        // macOS, Cambria on Windows, then common fallbacks. Keep variable
        // fonts (Sitka, Segoe UI Variable, Bahnschrift) out of these lists:
        // Gecko prints their glyphs as outlines, so the PDF loses its text.
        body: 'Charter, "Bitstream Charter", Cambria, Georgia, "Liberation Serif", serif',
        headings: 'Charter, "Bitstream Charter", Cambria, Georgia, "Liberation Serif", serif',
        mono: 'Consolas, Menlo, "DejaVu Sans Mono", monospace',
        ui: 'system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif',
    },
    // Charter sets large for its size: 11 pt reads like 12 pt Times.
    sizes: {
        body: 11,
        title: 18,
        heading1: 14,
        heading2: 12,
        heading3: 11,
        heading4: 11,
        note: 9.5,
        activity: 8.5,
        code: 9.5,
        table: 10,
    },
    colors: {
        text: '#000000',
        headings: '#000000',
        muted: '#6B6F76',
        mutedStrong: '#3F4247',
        link: '#1F4E79',
        rule: '#808080',
        codeBackground: '#F2F2F2',
        promptBackground: '#EEF1F4',
    },
    spacing: {
        lineHeight: 1.45,
        paragraphAfter: 8,
        titleAfter: 16,
        headingBefore: 16,
        headingAfter: 6,
        listItemAfter: 4,
        blockBefore: 4,
    },
    indents: {
        list: 0.25,
        quote: 0.4,
    },
    page: {
        margin: 1,
        size: 'auto',
        pageNumbers: true,
    },
};

/** Twentieths of a point (the bibliography layout's unit) as CSS points. */
const pt = (twips: number) => `${Math.round(twips / 2) / 10}pt`;

/**
 * CSS for the bibliography layout the citation processor asked for: hanging
 * indent, line and entry spacing, and the label column of numbered styles
 * (`csl-left-margin`), sized to reach the style's tab stop.
 */
function bibliographyCss(layout: BibliographyLayout | null): string {
    if (!layout) return '';
    // Zotero's own HTML bibliography uses the CSL line spacing as the CSS
    // line-height, with a readable minimum.
    const lineHeight = Math.max(layout.lineSpacing / 240 || 1, 1.35);
    const firstLineStart = layout.indent + layout.firstLineIndent;
    const tabStop = layout.tabStops.find(position => position >= 0);
    const labelWidth = tabStop !== undefined ? tabStop - firstLineStart : 0;
    return [
        `.csl-entry { padding-left: ${pt(layout.indent)}; text-indent: ${pt(layout.firstLineIndent)}; line-height: ${lineHeight}; margin-bottom: ${pt(layout.entrySpacing)}; }`,
        labelWidth > 0 ? `.csl-left-margin { min-width: ${pt(labelWidth)}; padding-right: 0; }` : '',
    ].filter(Boolean).join('\n');
}

/** The document's stylesheet. */
export function stylesheet(theme: HtmlTheme = HTML_THEME, bibliography: BibliographyLayout | null = null): string {
    const { fonts, sizes, colors, spacing, indents } = theme;
    return `
@page { margin: ${theme.page.margin}in; }
body {
    margin: 0;
    font-family: ${fonts.body};
    font-size: ${sizes.body}pt;
    line-height: ${spacing.lineHeight};
    color: ${colors.text};
    overflow-wrap: break-word;
}
p { margin: 0 0 ${spacing.paragraphAfter}pt; orphans: 2; widows: 2; }
a { color: ${colors.link}; text-decoration: underline; }
h1, h2, h3, h4, h5, h6 {
    font-family: ${fonts.headings};
    color: ${colors.headings};
    font-weight: bold;
    line-height: 1.2;
    margin: ${spacing.headingBefore}pt 0 ${spacing.headingAfter}pt;
    break-after: avoid;
    break-inside: avoid;
}
h1 { font-size: ${sizes.heading1}pt; }
h2 { font-size: ${sizes.heading2}pt; }
h3 { font-size: ${sizes.heading3}pt; margin-top: ${spacing.headingBefore * 0.75}pt; }
h4, h5, h6 { font-size: ${sizes.heading4}pt; margin-top: ${spacing.headingBefore * 0.75}pt; }
h1.doc-title { font-size: ${sizes.title}pt; margin: 0 0 ${spacing.titleAfter}pt; }
ul, ol { margin: 0 0 ${spacing.paragraphAfter}pt; padding-left: ${indents.list * 2}in; }
li { margin: 0 0 ${spacing.listItemAfter}pt; }
li > ul, li > ol { margin: ${spacing.listItemAfter}pt 0 0; padding-left: ${indents.list}in; }
li > p { margin: 0 0 ${spacing.listItemAfter}pt; }
li > p:last-child { margin-bottom: 0; }
ul { list-style-type: disc; }
ul ul { list-style-type: "– "; }
ul ul ul { list-style-type: circle; }
ol ol { list-style-type: lower-alpha; }
ol ol ol { list-style-type: lower-roman; }
/* A bullet task item's checkbox replaces the bullet; a numbered one keeps its number. */
ul > li.task { list-style-type: none; }
blockquote {
    margin: 0 ${indents.quote}in ${spacing.paragraphAfter}pt;
    padding: 0 0 0 8pt;
    border-left: 1.5pt solid ${colors.rule};
}
blockquote blockquote { margin-right: 0; }
code, pre { font-family: ${fonts.mono}; font-size: ${sizes.code}pt; }
code { background: ${colors.codeBackground}; padding: 0 0.15em; }
pre {
    background: ${colors.codeBackground};
    margin: ${spacing.blockBefore}pt 0 ${spacing.paragraphAfter}pt;
    padding: 4pt 6pt;
    line-height: 1.2;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
pre code { background: none; padding: 0; }
hr { border: none; border-top: 0.5pt solid ${colors.rule}; margin: ${spacing.paragraphAfter}pt 0; }
table {
    width: 100%;
    border-collapse: collapse;
    border-top: 1pt solid ${colors.text};
    border-bottom: 1pt solid ${colors.text};
    margin: ${spacing.blockBefore}pt 0 ${spacing.paragraphAfter}pt;
    font-size: ${sizes.table}pt;
    line-height: 1.2;
}
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { padding: 2pt 5pt; vertical-align: top; text-align: left; }
thead th { border-bottom: 0.5pt solid ${colors.text}; }
.keep { break-inside: avoid; }
.math-display { margin: ${spacing.blockBefore}pt 0 ${spacing.paragraphAfter}pt; text-align: center; break-inside: avoid; }
.math-source { background: none; padding: 0; }
.note-ref { font-size: 0.7em; vertical-align: super; line-height: 0; }
.prompt {
    background: ${colors.promptBackground};
    border-radius: 6pt;
    padding: 7pt 10pt 8pt;
    margin: ${spacing.headingBefore}pt 0 ${spacing.paragraphAfter}pt;
}
.prompt-label {
    font-family: ${fonts.ui};
    font-size: ${sizes.activity - 1}pt;
    font-weight: bold;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${colors.muted};
    margin: 0 0 3pt;
    break-after: avoid;
}
.prompt p:last-child { margin-bottom: 0; }
.url-start { white-space: nowrap; }
.activity {
    font-family: ${fonts.ui};
    font-size: ${sizes.activity}pt;
    color: ${colors.muted};
    line-height: 1.45;
    margin: ${spacing.blockBefore}pt 0 ${spacing.paragraphAfter}pt;
    break-after: avoid;
}
.activity p { margin: 0; }
.activity-mark { color: ${colors.rule}; font-weight: 600; padding-right: 0.5em; }
.activity-action { color: ${colors.mutedStrong}; font-weight: 600; }
.notes { font-size: ${sizes.note}pt; line-height: 1.25; }
.notes ol { padding-left: 0.3in; margin: 0; }
.notes li { margin-bottom: 3pt; }
.notes li > p { margin: 0; }
.csl-left-margin { display: inline-block; text-indent: 0; padding-right: 0.5em; vertical-align: top; }
.csl-right-inline { display: inline; }
.csl-block { display: block; }
.csl-indent { display: block; margin-left: 2em; }
${bibliographyCss(bibliography)}
`.trim();
}
