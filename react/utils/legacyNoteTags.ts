/**
 * Legacy `<note title="…">…</note>` sections, written by threads from before
 * note creation moved to the `create_note` tool.
 *
 * Nothing renders them as a block any more, so the tags are replaced by the
 * markup their body deserves: a rule, the title as a heading, and the body as
 * ordinary markdown.
 */

import { codeRanges } from '@beaver/agent-export/parse/markdown';

/**
 * An opening or closing legacy note tag.
 *
 * Attributes are required on the opening tag, as they were for the renderer
 * that used to display these sections: a note always carried at least a title,
 * so a bare `<note>` was literal text to the reader and stays that way.
 */
const NOTE_TAG = /<note\s+[^>]*>|<\/note>/g;
const TITLE_ATTR = /\btitle\s*=\s*"([^"]*)"/;

type Span = [start: number, end: number];

/**
 * Whether the character at `index` is markdown-escaped, i.e. preceded by an odd
 * number of backslashes — `\<note …>` is a literal the author wanted shown, but
 * the backslash of `\\<note …>` escapes itself and leaves a real tag.
 */
function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
    return backslashes % 2 === 1;
}

/** What one note tag becomes. */
function replacementFor(tag: string): string {
    if (tag.startsWith('</')) return '\n\n---\n';
    const title = TITLE_ATTR.exec(tag)?.[1]?.trim();
    return title ? `\n\n---\n## ${title}\n\n` : '\n\n---\n\n';
}

/**
 * Stands in for a blanked-out character. Markdown reads code from backticks and
 * from four leading spaces, and this is neither, so a tag cannot become code by
 * being blanked — padding with spaces would turn a tag at the start of a line
 * into an indented code block and hide the real note under it.
 */
const BLANK = '￼';

/**
 * `text` with each span blanked out: every character but a line break becomes a
 * placeholder, so offsets and line structure are unchanged.
 */
function blankOut(text: string, spans: Span[]): string {
    let out = '';
    let cursor = 0;
    for (const [start, end] of spans) {
        out += text.slice(cursor, start) + text.slice(start, end).replace(/[^\n]/g, BLANK);
        cursor = end;
    }
    return out + text.slice(cursor);
}

/**
 * Replace every legacy note tag with its heading/rule equivalent.
 *
 * The tags cannot simply be left in the text: CommonMark starts a raw HTML
 * block at an opening tag that is not followed by a blank line, so a heading,
 * list or link inside an old note would reach the reader as literal markup.
 *
 * Blank lines around each `---` keep it a thematic break rather than turning
 * the line above it into a setext heading.
 */
export function unwrapLegacyNoteTags(text: string): string {
    if (!text.includes('<note')) return text;

    const tags: Span[] = [];
    for (const match of text.matchAll(NOTE_TAG)) {
        if (match.index === undefined || isEscaped(text, match.index)) continue;
        tags.push([match.index, match.index + match[0].length]);
    }
    if (tags.length === 0) return text;

    // A note tag inside a code example documents the old syntax instead of
    // opening a note, so the code has to be located first. The tags must be out
    // of the way for that scan: the same raw-HTML-block rule that makes this
    // function necessary would otherwise swallow the fences and backticks under
    // an opening tag, and the scan would report no code at all. Blanking the
    // tags is length-preserving, so the ranges still address the original text.
    const code = codeRanges(blankOut(text, tags));
    const isInCode = ([start, end]: Span) =>
        code.some(([from, to]) => start >= from && end <= to);

    let out = '';
    let cursor = 0;
    let noteIsOpen = false;
    for (const tag of tags) {
        if (isInCode(tag)) continue;
        const [start, end] = tag;
        const tagText = text.slice(start, end);
        const closing = tagText.startsWith('</');
        // A closing tag with nothing open ends no note — a text part that
        // starts after its opening tag, say — so it is left as written.
        if (closing && !noteIsOpen) continue;
        noteIsOpen = !closing;
        out += text.slice(cursor, start) + replacementFor(tagText);
        cursor = end;
    }
    return out + text.slice(cursor);
}
