/**
 * The subset of mdast (remark's markdown AST, with GFM and math) the export
 * writers handle, plus the export's own `citation` node.
 *
 * Declared here rather than imported from `@types/mdast` so the package has no
 * undeclared type dependency; the shapes match what remark-parse, remark-gfm
 * and remark-math produce.
 */

export interface MdPosition {
    start: { offset?: number };
    end: { offset?: number };
}

interface MdNodeBase {
    position?: MdPosition;
}

export interface MdText extends MdNodeBase { type: 'text'; value: string }
export interface MdEmphasis extends MdNodeBase { type: 'emphasis'; children: MdInline[] }
export interface MdStrong extends MdNodeBase { type: 'strong'; children: MdInline[] }
export interface MdDelete extends MdNodeBase { type: 'delete'; children: MdInline[] }
export interface MdInlineCode extends MdNodeBase { type: 'inlineCode'; value: string }
export interface MdBreak extends MdNodeBase { type: 'break' }
export interface MdLink extends MdNodeBase { type: 'link'; url: string; title?: string | null; children: MdInline[] }
/**
 * An image. Markdown sources give a URL; Zotero notes name an asset the host
 * loads (`assetId`, see `ExportDoc.images`), with the size the note displays
 * it at in CSS pixels when the note sets one.
 */
export interface MdImage extends MdNodeBase {
    type: 'image';
    url: string;
    alt?: string | null;
    assetId?: string;
    width?: number | null;
    height?: number | null;
}
export interface MdHtml extends MdNodeBase { type: 'html'; value: string }
export interface MdInlineMath extends MdNodeBase { type: 'inlineMath'; value: string }
export interface MdFootnoteReference extends MdNodeBase { type: 'footnoteReference'; identifier: string; label?: string | null }
/** `[text][label]`; resolved against its definition while parsing. */
export interface MdLinkReference extends MdNodeBase { type: 'linkReference'; identifier: string; children: MdInline[] }
/** `![alt][label]`; resolved against its definition while parsing. */
export interface MdImageReference extends MdNodeBase { type: 'imageReference'; identifier: string; alt?: string | null }
/** A citation cluster (export-specific). */
export interface MdCitation extends MdNodeBase { type: 'citation'; clusterIndex: number }
/** Underlined text (Zotero notes), with the line's color as opaque `#rrggbb` when set. */
export interface MdUnderline extends MdNodeBase { type: 'underline'; color?: string | null; children: MdInline[] }
/** Subscript text (Zotero notes). */
export interface MdSubscript extends MdNodeBase { type: 'subscript'; children: MdInline[] }
/** Superscript text (Zotero notes). */
export interface MdSuperscript extends MdNodeBase { type: 'superscript'; children: MdInline[] }
/** Colored text (Zotero notes): text and background colors as opaque `#rrggbb`. */
export interface MdStyled extends MdNodeBase { type: 'styled'; color?: string | null; background?: string | null; children: MdInline[] }

export type MdInline =
    | MdText
    | MdEmphasis
    | MdStrong
    | MdDelete
    | MdInlineCode
    | MdBreak
    | MdLink
    | MdImage
    | MdHtml
    | MdInlineMath
    | MdFootnoteReference
    | MdLinkReference
    | MdImageReference
    | MdCitation
    | MdUnderline
    | MdSubscript
    | MdSuperscript
    | MdStyled;

/** Paragraph layout a Zotero note can set; markdown sources never do. */
export interface MdBlockLayout {
    align?: 'left' | 'right' | 'center' | 'justify' | null;
    /** Indentation steps (the note editor indents by 40 CSS pixels a step). */
    indent?: number | null;
    dir?: 'ltr' | 'rtl' | null;
}

export interface MdParagraph extends MdNodeBase, MdBlockLayout { type: 'paragraph'; children: MdInline[] }
export interface MdHeading extends MdNodeBase, MdBlockLayout { type: 'heading'; depth: number; children: MdInline[] }
export interface MdThematicBreak extends MdNodeBase { type: 'thematicBreak' }
export interface MdBlockquote extends MdNodeBase { type: 'blockquote'; children: MdBlock[] }
export interface MdListItem extends MdNodeBase { type: 'listItem'; checked?: boolean | null; children: MdBlock[] }
export interface MdList extends MdNodeBase {
    type: 'list';
    ordered?: boolean | null;
    start?: number | null;
    children: MdListItem[];
}
export interface MdCode extends MdNodeBase { type: 'code'; lang?: string | null; value: string }
/**
 * A table cell. Markdown cells hold inline content. Zotero note cells hold
 * blocks (`blocks`, which then replaces `children`), may span rows and
 * columns, may be header cells, and may have a background color.
 */
export interface MdTableCell extends MdNodeBase {
    type: 'tableCell';
    children: MdInline[];
    blocks?: MdBlock[];
    header?: boolean;
    colspan?: number;
    rowspan?: number;
    background?: string | null;
}
export interface MdTableRow extends MdNodeBase { type: 'tableRow'; children: MdTableCell[] }
/**
 * A table. Markdown tables always have a header row; a Zotero note table has
 * one only when its first row is all header cells (`headerRow: false`
 * otherwise). Rows omit the positions covered by a cell spanning into them,
 * as HTML does.
 */
export interface MdTable extends MdNodeBase {
    type: 'table';
    align?: Array<'left' | 'right' | 'center' | null> | null;
    headerRow?: boolean;
    /** Column widths in CSS pixels where the note sets them. */
    colwidths?: Array<number | null> | null;
    children: MdTableRow[];
}
/** Display math. */
export interface MdMath extends MdNodeBase { type: 'math'; value: string }
export interface MdFootnoteDefinition extends MdNodeBase { type: 'footnoteDefinition'; identifier: string; children: MdBlock[] }
/** `[label]: url`; consumed while parsing. */
export interface MdDefinition extends MdNodeBase { type: 'definition'; identifier: string; url: string; title?: string | null }

export type MdBlock =
    | MdParagraph
    | MdHeading
    | MdThematicBreak
    | MdBlockquote
    | MdList
    | MdCode
    | MdHtml
    | MdTable
    | MdMath
    | MdFootnoteDefinition
    | MdDefinition;

export interface MdRoot { type: 'root'; children: MdBlock[] }
