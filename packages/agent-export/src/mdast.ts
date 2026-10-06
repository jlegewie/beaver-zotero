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
export interface MdImage extends MdNodeBase { type: 'image'; url: string; alt?: string | null }
export interface MdHtml extends MdNodeBase { type: 'html'; value: string }
export interface MdInlineMath extends MdNodeBase { type: 'inlineMath'; value: string }
export interface MdFootnoteReference extends MdNodeBase { type: 'footnoteReference'; identifier: string; label?: string | null }
/** `[text][label]`; resolved against its definition while parsing. */
export interface MdLinkReference extends MdNodeBase { type: 'linkReference'; identifier: string; children: MdInline[] }
/** `![alt][label]`; resolved against its definition while parsing. */
export interface MdImageReference extends MdNodeBase { type: 'imageReference'; identifier: string; alt?: string | null }
/** A citation cluster (export-specific). */
export interface MdCitation extends MdNodeBase { type: 'citation'; clusterIndex: number }

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
    | MdCitation;

export interface MdParagraph extends MdNodeBase { type: 'paragraph'; children: MdInline[] }
export interface MdHeading extends MdNodeBase { type: 'heading'; depth: number; children: MdInline[] }
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
export interface MdTableCell extends MdNodeBase { type: 'tableCell'; children: MdInline[] }
export interface MdTableRow extends MdNodeBase { type: 'tableRow'; children: MdTableCell[] }
export interface MdTable extends MdNodeBase {
    type: 'table';
    align?: Array<'left' | 'right' | 'center' | null> | null;
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
