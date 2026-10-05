/**
 * The look of exported Word documents, defined in one place.
 *
 * `DOCX_THEME` holds every typographic decision (fonts, sizes, colors,
 * spacing, indents, page setup) in plain units. The functions below turn it
 * into Word styles, list numbering and section properties; the writer only
 * refers to style ids and never sets formatting of its own. To change how
 * exports look, edit the theme.
 *
 * The defaults aim for a plain academic manuscript: a serif body face, black
 * headings, modest paragraph spacing, booktabs-style tables, quiet links.
 */

import {
    AlignmentType,
    BorderStyle,
    LevelFormat,
    LineRuleType,
    ShadingType,
    UnderlineType,
    type IStylesOptions,
} from 'docx';

export interface DocxTheme {
    fonts: {
        body: string;
        headings: string;
        /** Code and inline code. */
        mono: string;
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
        footnote: number;
        /** Tool activity lines in full-response exports. */
        activity: number;
        code: number;
        table: number;
        pageNumber: number;
    };
    /** Colors as RRGGBB. */
    colors: {
        text: string;
        headings: string;
        /** Secondary text: tool activity, prompt labels. */
        muted: string;
        link: string;
        /** Table rules, quote and activity bars. */
        rule: string;
        codeBackground: string;
    };
    /** Spacing in points, line spacing as a multiple of single spacing. */
    spacing: {
        lineSpacing: number;
        paragraphAfter: number;
        titleAfter: number;
        headingBefore: number;
        headingAfter: number;
        listItemAfter: number;
        blockBefore: number;
    };
    /** Indents in inches. */
    indents: {
        /** Per list level: a level's marker sits at `list × (level + 1)`, its text `listHanging` further in. */
        list: number;
        /** Hanging indent of list markers. */
        listHanging: number;
        quote: number;
        activity: number;
    };
    page: {
        /** Inches on every side. */
        margin: number;
        /** `auto` picks US Letter for US/Canadian English citation locales, A4 otherwise. */
        size: 'auto' | 'letter' | 'a4';
        pageNumbers: boolean;
    };
}

export const DOCX_THEME: DocxTheme = {
    fonts: {
        body: 'Times New Roman',
        headings: 'Times New Roman',
        mono: 'Consolas',
    },
    sizes: {
        body: 12,
        title: 17,
        heading1: 14,
        heading2: 12.5,
        heading3: 12,
        heading4: 12,
        footnote: 10,
        activity: 10,
        code: 10,
        table: 11,
        pageNumber: 10,
    },
    colors: {
        text: '000000',
        headings: '000000',
        muted: '595959',
        link: '1F4E79',
        rule: '808080',
        codeBackground: 'F2F2F2',
    },
    spacing: {
        lineSpacing: 1.15,
        paragraphAfter: 8,
        titleAfter: 16,
        headingBefore: 16,
        headingAfter: 6,
        listItemAfter: 4,
        blockBefore: 4,
    },
    indents: {
        list: 0.25,
        listHanging: 0.25,
        quote: 0.4,
        activity: 0.15,
    },
    page: {
        margin: 1,
        size: 'auto',
        pageNumbers: true,
    },
};

/** Style ids the writer refers to (Word's built-in ids where one exists). */
export const STYLE = {
    title: 'Title',
    body: 'BodyText',
    listParagraph: 'ListParagraph',
    quote: 'Quote',
    code: 'Code',
    bibliography: 'Bibliography',
    footnoteText: 'FootnoteText',
    footnoteReference: 'FootnoteReference',
    hyperlink: 'Hyperlink',
    tableText: 'TableText',
    promptLabel: 'PromptLabel',
    activity: 'BeaverActivity',
} as const;

const halfPoints = (points: number) => Math.round(points * 2);
const twips = (points: number) => Math.round(points * 20);
const inches = (value: number) => Math.round(value * 1440);
const lineSpacing = (multiple: number) => ({ line: Math.round(240 * multiple), lineRule: LineRuleType.AUTO });

/** Word styles for the theme: document defaults, built-in overrides and Beaver's own styles. */
export function documentStyles(theme: DocxTheme = DOCX_THEME): IStylesOptions {
    const heading = (size: number, before = theme.spacing.headingBefore) => ({
        run: { font: theme.fonts.headings, size: halfPoints(size), bold: true, color: theme.colors.headings },
        paragraph: {
            spacing: { before: twips(before), after: twips(theme.spacing.headingAfter), ...lineSpacing(1) },
            keepNext: true,
            keepLines: true,
        },
    });
    return {
        default: {
            document: {
                run: { font: theme.fonts.body, size: halfPoints(theme.sizes.body), color: theme.colors.text },
                paragraph: { spacing: { after: twips(theme.spacing.paragraphAfter), ...lineSpacing(theme.spacing.lineSpacing) } },
            },
            title: {
                run: { font: theme.fonts.headings, size: halfPoints(theme.sizes.title), bold: true, color: theme.colors.headings },
                paragraph: { spacing: { before: 0, after: twips(theme.spacing.titleAfter), ...lineSpacing(1) }, keepNext: true },
            },
            heading1: heading(theme.sizes.heading1),
            heading2: heading(theme.sizes.heading2),
            heading3: heading(theme.sizes.heading3, theme.spacing.headingBefore * 0.75),
            heading4: heading(theme.sizes.heading4, theme.spacing.headingBefore * 0.75),
            heading5: heading(theme.sizes.heading4, theme.spacing.headingBefore * 0.75),
            heading6: heading(theme.sizes.heading4, theme.spacing.headingBefore * 0.75),
            listParagraph: {
                paragraph: { spacing: { before: 0, after: twips(theme.spacing.listItemAfter), ...lineSpacing(theme.spacing.lineSpacing) } },
            },
            hyperlink: {
                run: { color: theme.colors.link, underline: { type: UnderlineType.SINGLE, color: theme.colors.link } },
            },
            footnoteText: {
                run: { size: halfPoints(theme.sizes.footnote) },
                paragraph: { spacing: { after: 0, ...lineSpacing(1) } },
            },
        },
        paragraphStyles: [
            {
                // Prose. Spacing is set here as well as in the document
                // defaults, which some apps other than Word ignore.
                id: STYLE.body, name: 'Body Text', basedOn: 'Normal', next: STYLE.body, quickFormat: true,
                run: { font: theme.fonts.body, size: halfPoints(theme.sizes.body) },
                paragraph: { spacing: { before: 0, after: twips(theme.spacing.paragraphAfter), ...lineSpacing(theme.spacing.lineSpacing) } },
            },
            {
                id: STYLE.quote, name: 'Quote', basedOn: STYLE.body, next: STYLE.body, quickFormat: true,
                paragraph: {
                    indent: { left: inches(theme.indents.quote), right: inches(theme.indents.quote) },
                },
            },
            {
                id: STYLE.code, name: 'Code', basedOn: 'Normal', next: 'Normal',
                run: { font: theme.fonts.mono, size: halfPoints(theme.sizes.code) },
                paragraph: {
                    spacing: { before: twips(theme.spacing.blockBefore), after: twips(theme.spacing.paragraphAfter), ...lineSpacing(1) },
                    shading: { type: ShadingType.CLEAR, fill: theme.colors.codeBackground, color: 'auto' },
                },
            },
            {
                id: STYLE.tableText, name: 'Table Text', basedOn: 'Normal', next: STYLE.tableText,
                run: { size: halfPoints(theme.sizes.table) },
                paragraph: { spacing: { before: 0, after: 0, ...lineSpacing(1) } },
            },
            {
                id: STYLE.bibliography, name: 'Bibliography', basedOn: 'Normal', next: STYLE.bibliography, quickFormat: true,
            },
            {
                id: STYLE.promptLabel, name: 'Prompt Label', basedOn: 'Normal', next: STYLE.quote,
                run: { bold: true, color: theme.colors.muted, size: halfPoints(theme.sizes.activity) },
                paragraph: { spacing: { before: twips(theme.spacing.headingBefore), after: twips(2) }, keepNext: true },
            },
            {
                // A quiet, ruled line per tool call. Consecutive lines share the
                // rule and, through contextual spacing, sit tight together.
                id: STYLE.activity, name: 'Beaver Activity', basedOn: 'Normal', next: 'Normal',
                run: { size: halfPoints(theme.sizes.activity), color: theme.colors.muted },
                paragraph: {
                    indent: { left: inches(theme.indents.activity) },
                    spacing: { before: twips(theme.spacing.blockBefore), after: twips(theme.spacing.paragraphAfter), ...lineSpacing(1) },
                    contextualSpacing: true,
                    border: { left: { style: BorderStyle.SINGLE, size: 12, color: theme.colors.rule, space: 6 } },
                },
            },
        ],
    };
}

const BULLET_CHARS = ['•', '–', '◦'];
const ORDERED_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];

/** Numbering levels of a bullet or ordered list. `start` applies at `startLevel`. */
export function listLevels(ordered: boolean, theme: DocxTheme = DOCX_THEME, start = 1, startLevel = 0) {
    return Array.from({ length: 9 }, (_, level) => ({
        level,
        format: ordered ? ORDERED_FORMATS[level % 3] : LevelFormat.BULLET,
        text: ordered ? `%${level + 1}.` : BULLET_CHARS[level % 3],
        alignment: AlignmentType.LEFT,
        start: level === startLevel ? start : 1,
        style: {
            paragraph: {
                indent: {
                    left: inches(theme.indents.list * level + theme.indents.listHanging + theme.indents.list),
                    hanging: inches(theme.indents.listHanging),
                },
            },
        },
    }));
}

/** Left indent of a list item's continuation blocks at `depth` (aligned with the item's text). */
export function listContinuationIndent(depth: number, theme: DocxTheme = DOCX_THEME): number {
    if (depth <= 0) return 0;
    return inches(theme.indents.list * (depth - 1) + theme.indents.listHanging + theme.indents.list);
}

/**
 * Space before the first paragraph after a list or table, so the block ends
 * with a paragraph's gap. A full paragraph gap: Word adds it to the last list
 * item's own space after, other apps collapse the two like HTML margins.
 */
export function gapAfterBlock(theme: DocxTheme = DOCX_THEME): number {
    return twips(theme.spacing.paragraphAfter);
}

/** Left indent of a block quote at `depth`. */
export function quoteIndent(depth: number, theme: DocxTheme = DOCX_THEME): number {
    return inches(theme.indents.quote * depth);
}

/** Table borders: booktabs-style rules above and below, none between columns. */
export function tableBorders(theme: DocxTheme = DOCX_THEME) {
    const rule = { style: BorderStyle.SINGLE, size: 8, color: theme.colors.text };
    const none = { style: BorderStyle.NONE, size: 0, color: 'auto' };
    return {
        table: { top: rule, bottom: rule, left: none, right: none, insideHorizontal: none, insideVertical: none },
        /** Rule under the header row. */
        headerBottom: { style: BorderStyle.SINGLE, size: 4, color: theme.colors.text },
        cellMargins: { top: twips(2), bottom: twips(2), left: twips(5), right: twips(5) },
    };
}

/** Page size and margins for a citation locale. */
export function pageProperties(locale: string, theme: DocxTheme = DOCX_THEME) {
    const letter = theme.page.size === 'letter'
        || (theme.page.size === 'auto' && /^en-(US|CA)$/i.test(locale));
    const margin = inches(theme.page.margin);
    return {
        size: letter ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 },
        margin: { top: margin, right: margin, bottom: margin, left: margin },
    };
}

export const themeUnits = { halfPoints, twips, inches };
