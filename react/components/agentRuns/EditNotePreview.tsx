import React, { useState, useEffect, useMemo } from 'react';
import { diffWords, diffLines, diffChars } from 'diff';
import {
    getOrSimplify,
    getLatestNoteHtml,
} from '../../../src/utils/noteHtmlSimplifier';
import type { EditNoteOperation } from '../../types/agentActions/editNote';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface EditNotePreviewProps {
    /** The old string being replaced */
    oldString: string;
    /** The new replacement string */
    newString: string;
    /** Operation mode (defaults to 'str_replace') */
    operation?: EditNoteOperation;
    /** Full old content for diff display (used when operation is 'rewrite') */
    oldContent?: string;
    /** Number of occurrences replaced (from result_data) */
    occurrencesReplaced?: number;
    /** Warnings from the edit */
    warnings?: string[];
    /** Current status of the action */
    status?: ActionStatus;
    /** Library ID for fetching note context (optional) */
    libraryId?: number;
    /** Zotero key for fetching note context (optional) */
    zoteroKey?: string;
}

// ---- Diff types ----

export interface DiffSegment {
    text: string;
    highlighted: boolean;
}

export interface DiffLine {
    type: 'context' | 'addition' | 'deletion' | 'separator';
    text: string;
    segments?: DiffSegment[];
}

export interface InlineSegment {
    text: string;
    type: 'context' | 'deletion' | 'addition';
}

// ---- Formatting markers (control chars that survive the diff pipeline) ----

const BOLD_START = '\x02';
const BOLD_END = '\x03';
const HEADING_START = '\x04';
const HEADING_END = '\x05';
const ITALIC_START = '\x06';
const ITALIC_END = '\x07';
const ALL_MARKERS_RE = new RegExp(
    `[${String.fromCharCode(2)}-${String.fromCharCode(7)}]`,
    'g',
);

/**
 * Like stripHtmlTags but converts bold, italic, and heading tags to control-char
 * markers so formatting survives the diff computation and can be rendered later.
 */
function stripHtmlPreserveFormatting(html: string): string {
    const withMarkers = html
        // Headings → heading markers (must come before stripHtmlTags which converts </h> to \n)
        .replace(/<h[1-6]\b[^>]*>/gi, HEADING_START)
        .replace(/<\/h[1-6]>/gi, HEADING_END + '\n')
        // Bold
        .replace(/<(strong|b)\b[^>]*>/gi, BOLD_START)
        .replace(/<\/(strong|b)>/gi, BOLD_END)
        // Italic
        .replace(/<(em|i)\b[^>]*>/gi, ITALIC_START)
        .replace(/<\/(em|i)>/gi, ITALIC_END);
    return stripHtmlTags(withMarkers);
}

/**
 * Render a paragraph of inline-diff segments, tracking bold/italic state across
 * segment boundaries. Maintains separate old/new formatting streams so that
 * markers from deletions (old text) don't pollute the state for additions (new text).
 */
function renderFormattedParagraph(segments: InlineSegment[]): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Separate formatting streams for old (deletions) and new (additions/context) text
    let oldBold = false, oldItalic = false;
    let newBold = false, newItalic = false;
    let key = 0;

    for (const seg of segments) {
        const isDeletion = seg.type === 'deletion';
        const diffClass = isDeletion ? 'inline-diff-del'
            : seg.type === 'addition' ? 'inline-diff-add'
                : undefined;

        let bold: boolean = isDeletion ? oldBold : newBold;
        let italic: boolean = isDeletion ? oldItalic : newItalic;
        let current = '';
        let runBold = bold;
        let runItalic = italic;

        const flushRun = () => {
            if (!current) return;
            let inner: React.ReactNode = current;
            if (runBold && runItalic) inner = <strong><em>{current}</em></strong>;
            else if (runBold) inner = <strong>{current}</strong>;
            else if (runItalic) inner = <em>{current}</em>;
            nodes.push(<span key={key++} className={diffClass}>{inner}</span>);
            current = '';
        };

        for (const ch of seg.text) {
            switch (ch) {
                case BOLD_START: case HEADING_START:
                    flushRun(); bold = true; runBold = true; break;
                case BOLD_END: case HEADING_END:
                    flushRun(); bold = false; runBold = false; break;
                case ITALIC_START:
                    flushRun(); italic = true; runItalic = true; break;
                case ITALIC_END:
                    flushRun(); italic = false; runItalic = false; break;
                default: current += ch;
            }
        }
        flushRun();

        // Update the appropriate stream(s)
        if (isDeletion) {
            oldBold = bold; oldItalic = italic;
        } else if (seg.type === 'addition') {
            newBold = bold; newItalic = italic;
        } else {
            oldBold = bold; oldItalic = italic;
            newBold = bold; newItalic = italic;
        }
    }

    return nodes;
}

// ---- Component ----

export const EditNotePreview: React.FC<EditNotePreviewProps> = ({
    oldString,
    newString,
    operation = 'str_replace',
    oldContent,
    occurrencesReplaced,
    warnings,
    status = 'pending',
    libraryId,
    zoteroKey,
}) => {
    const isApplied = status === 'applied';
    const isDelete = newString === '';
    const isRewrite = operation === 'rewrite';

    // For rewrite mode when oldContent is missing (e.g. after undo),
    // fetch the current note content — the note is back to its original state.
    const needsOldContentFetch = isRewrite && !oldContent && libraryId != null && !!zoteroKey;
    const [fetchedOldContent, setFetchedOldContent] = useState<string | null>(null);

    useEffect(() => {
        if (!needsOldContentFetch) return;

        let cancelled = false;

        (async () => {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId!, zoteroKey!);
                if (!item || cancelled) return;
                await item.loadDataType('note');
                const rawHtml = getLatestNoteHtml(item);
                const noteId = `${libraryId}-${zoteroKey}`;
                const { simplified } = getOrSimplify(noteId, rawHtml, libraryId!);
                if (!cancelled) setFetchedOldContent(simplified);
            } catch {
                // Fall back to no old content
            }
        })();

        return () => { cancelled = true; };
    }, [needsOldContentFetch, libraryId, zoteroKey]);

    // For rewrite mode, use oldContent prop, fetched content, or fall back to oldString
    const effectiveOld = isRewrite && (oldContent || fetchedOldContent) ? (oldContent || fetchedOldContent!) : oldString;
    // For insert_after / insert_before, new_string is already normalized by
    // validation to merge old_string with new_string (via normalized_action_data):
    //   - insert_after:  new_string = old_string + new_string
    //   - insert_before: new_string = new_string + old_string
    // so diffWords will naturally show old_string as context and the inserted
    // text as addition.
    const strippedOld = normalizeForInlineDiff(stripHtmlPreserveFormatting(effectiveOld));
    const strippedNew = normalizeForInlineDiff(stripHtmlPreserveFormatting(newString));

    // When strippedOld is empty (old_string was pure HTML structure), fetch
    // surrounding visible text from the full note for context.
    // Skip for rewrite mode — we already have the full old content.
    const needsNoteContext = shouldFetchNoteContext({
        operation,
        strippedOld,
        effectiveOld,
        strippedNew,
    });
    const [noteContext, setNoteContext] = useState<{ before: string; after: string } | null>(null);

    useEffect(() => {
        if (!needsNoteContext || libraryId == null || !zoteroKey) return;

        let cancelled = false;

        (async () => {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
                if (!item || cancelled) return;
                await item.loadDataType('note');
                const rawHtml = getLatestNoteHtml(item);
                const noteId = `${libraryId}-${zoteroKey}`;
                const { simplified } = getOrSimplify(noteId, rawHtml, libraryId);

                // After the edit is applied, the note contains newString instead
                // of oldString. Search for the appropriate string so we get
                // surrounding context rather than the inserted text itself.
                const searchString = isApplied ? newString : effectiveOld;
                const idx = simplified.indexOf(searchString);
                if (idx === -1 || cancelled) return;

                const beforeHtml = simplified.substring(0, idx);
                const afterHtml = simplified.substring(idx + searchString.length);

                const beforeText = stripHtmlTags(beforeHtml);
                const afterText = stripHtmlTags(afterHtml);

                // Take the last non-empty line before and first non-empty line after
                const beforeLines = beforeText.split('\n').filter(l => l.trim());
                const afterLines = afterText.split('\n').filter(l => l.trim());

                if (!cancelled) {
                    setNoteContext({
                        before: beforeLines.length > 0 ? beforeLines[beforeLines.length - 1].trim() : '',
                        after: afterLines.length > 0 ? afterLines[0].trim() : '',
                    });
                }
            } catch {
                // Context is optional — silently fall back to no context
            }
        })();

        return () => { cancelled = true; };
    }, [needsNoteContext, libraryId, zoteroKey, effectiveOld, isApplied, newString]);

    const inlineSegments = useMemo(() => {
        if (needsNoteContext && noteContext && (noteContext.before || noteContext.after)) {
            // Build inline segments with surrounding context from the note.
            const segments: InlineSegment[] = [];
            if (noteContext.before) {
                segments.push({ text: truncateContext(noteContext.before, 80, true) + ' ', type: 'context' });
            }
            segments.push({ text: strippedNew, type: 'addition' });
            if (noteContext.after) {
                segments.push({ text: ' ' + truncateContext(noteContext.after), type: 'context' });
            }
            return segments;
        }

        // Formatting-only changes (e.g. bolding existing text): the plain
        // text is identical but the control-char markers differ. Word-level
        // diff garbles these because the markers land mid-word, so instead
        // we walk both strings in sync and highlight just the regions where
        // bold/italic state changed.
        const oldPlain = strippedOld.replace(ALL_MARKERS_RE, '');
        const newPlain = strippedNew.replace(ALL_MARKERS_RE, '');
        if (oldPlain && oldPlain === newPlain && strippedOld !== strippedNew) {
            const fmtDiff = computeFormattingOnlyDiff(strippedOld, strippedNew);
            if (fmtDiff.length > 0) return fmtDiff;
        }

        return computeInlineDiff(strippedOld, strippedNew);
    }, [strippedOld, strippedNew, needsNoteContext, noteContext]);

    return (
        <div className="edit-note-preview">
            <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    {/* Show header for str_replace_all mode */}
                    {operation === 'str_replace_all' && (
                        <div className="text-sm font-color-primary font-medium px-3 py-1">
                            {isDelete ? 'Delete' : 'Replace'}
                            {' (all occurrences)'}
                            {occurrencesReplaced != null && occurrencesReplaced > 0
                                ? ` — ${occurrencesReplaced} occurrence${occurrencesReplaced === 1 ? '' : 's'}`
                                : ''}
                        </div>
                    )}
                    <div className="inline-diff-container">
                        {splitIntoParagraphs(inlineSegments).map((para, pi) => {
                            const isHeading = para.length > 0
                                && para[0].text.charAt(0) === HEADING_START;
                            const cls = [
                                pi > 0 ? 'inline-diff-para' : '',
                                isHeading ? 'inline-diff-heading' : '',
                            ].filter(Boolean).join(' ') || undefined;
                            return (
                                <div key={pi} className={cls}>
                                    {renderFormattedParagraph(para)}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ---- Inline diff computation ----

/**
 * Split inline diff segments into paragraph groups at \n boundaries.
 * Each paragraph is an array of segments with no \n in their text.
 */
function splitIntoParagraphs(segments: InlineSegment[]): InlineSegment[][] {
    const paragraphs: InlineSegment[][] = [[]];
    for (const seg of segments) {
        const parts = seg.text.split('\n');
        parts.forEach((part, i) => {
            if (i > 0) paragraphs.push([]);
            if (part) paragraphs[paragraphs.length - 1].push({ text: part, type: seg.type });
        });
    }
    return paragraphs.filter(p => p.length > 0);
}

/**
 * Compute an inline (word-level) diff between two texts using jsdiff.
 * Returns a sequence of context/deletion/addition segments rendered
 * as continuous text with interwoven red+strikethrough and green spans.
 */
export function computeInlineDiff(oldText: string, newText: string): InlineSegment[] {
    if (oldText === newText) {
        return [{ text: truncateContext(oldText), type: 'context' }];
    }
    if (oldText === '') {
        return [{ text: newText, type: 'addition' }];
    }
    if (newText === '') {
        return [{ text: oldText, type: 'deletion' }];
    }

    const changes = diffWords(oldText, newText);
    const segments: InlineSegment[] = changes.map(c => ({
        text: c.value,
        type: c.added ? 'addition' : c.removed ? 'deletion' : 'context',
    }));

    return truncateInlineContext(segments);
}

export function shouldFetchNoteContext({
    operation,
    strippedOld,
    effectiveOld,
    strippedNew,
}: {
    operation: EditNoteOperation;
    strippedOld: string;
    effectiveOld: string;
    strippedNew: string;
}): boolean {
    return operation !== 'rewrite'
        && strippedOld === ''
        && effectiveOld !== ''
        && strippedNew !== '';
}

/**
 * Truncate leading, trailing, and long middle context segments for readability.
 */
function truncateInlineContext(segments: InlineSegment[], maxContext: number = 80): InlineSegment[] {
    if (segments.length === 0) return segments;

    const result = segments.map(s => ({ ...s }));

    // Truncate leading context
    if (result[0].type === 'context' && result[0].text.length > maxContext) {
        result[0].text = '…' + result[0].text.slice(-maxContext);
    }

    // Truncate trailing context
    const last = result.length - 1;
    if (last > 0 && result[last].type === 'context' && result[last].text.length > maxContext) {
        result[last].text = result[last].text.slice(0, maxContext) + '…';
    }

    // Truncate long middle context
    for (let k = 1; k < result.length - 1; k++) {
        if (result[k].type === 'context' && result[k].text.length > maxContext * 2) {
            result[k].text = result[k].text.slice(0, maxContext) + ' … ' + result[k].text.slice(-maxContext);
        }
    }

    return result;
}

// ---- Formatting-only diff ----

interface FormattedChar {
    char: string;
    bold: boolean;
    italic: boolean;
}

/**
 * Parse text containing bold/italic/heading control-char markers into a
 * sequence of characters with their associated formatting state. The
 * markers themselves are consumed.
 */
function parseFormattedText(text: string): FormattedChar[] {
    const result: FormattedChar[] = [];
    let bold = false;
    let italic = false;
    for (const ch of text) {
        switch (ch) {
            case BOLD_START:
            case HEADING_START:
                bold = true;
                break;
            case BOLD_END:
            case HEADING_END:
                bold = false;
                break;
            case ITALIC_START:
                italic = true;
                break;
            case ITALIC_END:
                italic = false;
                break;
            default:
                result.push({ char: ch, bold, italic });
        }
    }
    return result;
}

/**
 * Re-serialize a formatted-char sequence back into text with balanced markers
 * so renderFormattedParagraph can pick up the bold/italic state when it
 * walks the resulting segment.
 */
function serializeFormattedChars(chars: FormattedChar[]): string {
    let out = '';
    let bold = false;
    let italic = false;
    for (const { char, bold: b, italic: it } of chars) {
        if (b !== bold) {
            out += b ? BOLD_START : BOLD_END;
            bold = b;
        }
        if (it !== italic) {
            out += it ? ITALIC_START : ITALIC_END;
            italic = it;
        }
        out += char;
    }
    if (bold) out += BOLD_END;
    if (italic) out += ITALIC_END;
    return out;
}

/**
 * Compute a diff for edits that only change formatting (e.g. bolding or
 * italicizing existing text). The caller should only invoke this when the
 * plain text with markers stripped is identical in both sides. Walks both
 * strings in sync and emits regions whose bold/italic state differs as
 * additions so they stand out visually, while unchanged regions become
 * plain context that still renders with its original formatting.
 */
function computeFormattingOnlyDiff(
    strippedOld: string,
    strippedNew: string,
): InlineSegment[] {
    const oldChars = parseFormattedText(strippedOld);
    const newChars = parseFormattedText(strippedNew);

    // Defensive: lengths should match since the plain text is identical.
    // If they don't, bail out so the caller falls back to word-level diff.
    if (oldChars.length !== newChars.length) return [];

    const segments: InlineSegment[] = [];
    let buffer: FormattedChar[] = [];
    let bufferType: 'context' | 'addition' = 'context';

    const flush = () => {
        if (buffer.length === 0) return;
        segments.push({ text: serializeFormattedChars(buffer), type: bufferType });
        buffer = [];
    };

    for (let i = 0; i < newChars.length; i++) {
        const o = oldChars[i];
        const n = newChars[i];
        const changed = o.bold !== n.bold || o.italic !== n.italic;
        const type: 'context' | 'addition' = changed ? 'addition' : 'context';
        if (type !== bufferType) {
            flush();
            bufferType = type;
        }
        buffer.push(n);
    }
    flush();

    return segments;
}

// ---- Line-level diff computation (used by sourceUtils.ts) ----

/**
 * Compute a line-level diff with character-level highlighting for modified lines.
 * Uses jsdiff for line-level and character-level diffing.
 * Shows limited context around changes.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
    // Edge cases
    if (oldText === newText) {
        return [{ type: 'context', text: truncateContext(oldText) }];
    }
    if (newText === '') {
        return oldText.split('\n').map(line => ({
            type: 'deletion' as const,
            text: line,
            segments: [{ text: line, highlighted: true }],
        }));
    }
    if (oldText === '') {
        return newText.split('\n').map(line => ({
            type: 'addition' as const,
            text: line,
            segments: [{ text: line, highlighted: true }],
        }));
    }

    // Use jsdiff for line-level diff, then convert to per-line rawOps
    const changes = diffLines(oldText, newText);
    const rawOps: Array<{ type: 'context' | 'addition' | 'deletion'; text: string }> = [];
    for (const change of changes) {
        const type = change.added ? 'addition' : change.removed ? 'deletion' : 'context';
        // diffLines includes trailing newlines in values; split and trim the trailing one
        const lines = change.value.replace(/\n$/, '').split('\n');
        for (const line of lines) {
            rawOps.push({ type, text: line });
        }
    }

    // Pair consecutive deletion+addition blocks for character-level diff
    const result: DiffLine[] = [];
    let idx = 0;
    while (idx < rawOps.length) {
        if (rawOps[idx].type === 'deletion') {
            const deletions: string[] = [];
            while (idx < rawOps.length && rawOps[idx].type === 'deletion') {
                deletions.push(rawOps[idx].text);
                idx++;
            }
            const additions: string[] = [];
            while (idx < rawOps.length && rawOps[idx].type === 'addition') {
                additions.push(rawOps[idx].text);
                idx++;
            }
            // Pair up for char-level diff
            const pairCount = Math.min(deletions.length, additions.length);
            for (let k = 0; k < pairCount; k++) {
                const [oldSegs, newSegs] = computeCharDiff(deletions[k], additions[k]);
                const oldHasHighlight = oldSegs.some(s => s.highlighted);
                const newHasHighlight = newSegs.some(s => s.highlighted);

                if (!oldHasHighlight && newHasHighlight) {
                    result.push({ type: 'addition', text: additions[k], segments: truncateSegments(newSegs) });
                } else if (oldHasHighlight && !newHasHighlight) {
                    result.push({ type: 'deletion', text: deletions[k], segments: truncateSegments(oldSegs) });
                } else {
                    result.push({ type: 'deletion', text: deletions[k], segments: truncateSegments(oldSegs) });
                    result.push({ type: 'addition', text: additions[k], segments: truncateSegments(newSegs) });
                }
            }
            // Remaining unpaired lines
            for (let k = pairCount; k < deletions.length; k++) {
                result.push({ type: 'deletion', text: deletions[k] });
            }
            for (let k = pairCount; k < additions.length; k++) {
                result.push({ type: 'addition', text: additions[k], segments: [{ text: additions[k], highlighted: true }] });
            }
        } else {
            result.push({ type: rawOps[idx].type, text: rawOps[idx].text });
            idx++;
        }
    }

    return filterContext(result, 1);
}

/**
 * Compute character-level diff between two lines using jsdiff.
 * Returns separate old and new segment arrays with highlighted changed portions.
 */
function computeCharDiff(oldLine: string, newLine: string): [DiffSegment[], DiffSegment[]] {
    const changes = diffChars(oldLine, newLine);

    const oldSegments: DiffSegment[] = [];
    const newSegments: DiffSegment[] = [];

    for (const change of changes) {
        if (change.added) {
            newSegments.push({ text: change.value, highlighted: true });
        } else if (change.removed) {
            oldSegments.push({ text: change.value, highlighted: true });
        } else {
            oldSegments.push({ text: change.value, highlighted: false });
            newSegments.push({ text: change.value, highlighted: false });
        }
    }

    // Fallback: if no segments produced, highlight the whole line
    if (oldSegments.length === 0) oldSegments.push({ text: oldLine || ' ', highlighted: true });
    if (newSegments.length === 0) newSegments.push({ text: newLine || ' ', highlighted: true });

    return [oldSegments, newSegments];
}

/**
 * Truncate long unchanged segments around the highlighted change.
 * Keeps up to maxContext chars of prefix/suffix for readability.
 */
function truncateSegments(segments: DiffSegment[], maxContext: number = 50): DiffSegment[] {
    if (segments.length <= 1) return segments;

    return segments.map((seg, i) => {
        if (seg.highlighted) return seg;

        // First segment (prefix): show the end portion
        if (i === 0 && seg.text.length > maxContext) {
            return { ...seg, text: '…' + seg.text.slice(-maxContext) };
        }
        // Last segment (suffix): show the start portion
        if (i === segments.length - 1 && seg.text.length > maxContext) {
            return { ...seg, text: seg.text.slice(0, maxContext) + '…' };
        }
        // Middle non-highlighted segment: truncate both ends
        if (seg.text.length > maxContext * 2) {
            return { ...seg, text: seg.text.slice(0, maxContext) + '…' + seg.text.slice(-maxContext) };
        }
        return seg;
    });
}

/**
 * Filter context lines: keep only `contextSize` lines around changes.
 * Insert separators where context was skipped.
 */
function filterContext(lines: DiffLine[], contextSize: number): DiffLine[] {
    const isChange = lines.map(l => l.type !== 'context');

    // If everything is a change (no context to filter), return as-is
    if (lines.length === 0 || isChange.every(Boolean)) return lines;

    // Mark which lines to keep (changes + adjacent context)
    const keep = new Array(lines.length).fill(false);
    for (let i = 0; i < lines.length; i++) {
        if (isChange[i]) {
            keep[i] = true;
            for (let j = 1; j <= contextSize && i - j >= 0; j++) keep[i - j] = true;
            for (let j = 1; j <= contextSize && i + j < lines.length; j++) keep[i + j] = true;
        }
    }

    const result: DiffLine[] = [];
    let skippedSinceLastKept = false;

    for (let i = 0; i < lines.length; i++) {
        if (keep[i]) {
            if (skippedSinceLastKept) {
                result.push({ type: 'separator', text: '⋯' });
                skippedSinceLastKept = false;
            }
            if (lines[i].type === 'context') {
                result.push({ ...lines[i], text: truncateContext(lines[i].text) });
            } else {
                result.push(lines[i]);
            }
        } else {
            skippedSinceLastKept = true;
        }
    }

    return result;
}

/**
 * Truncate context lines to a reasonable length.
 */
function truncateContext(text: string, maxLength: number = 80, showEnd: boolean = false): string {
    if (text.length <= maxLength) return text;
    return showEnd
        ? '…' + text.slice(-maxLength)
        : text.substring(0, maxLength) + '…';
}

/**
 * Normalize stripped text for the inline diff view:
 * - Collapse consecutive newlines to a single \n (tight paragraph spacing)
 */
function normalizeForInlineDiff(text: string): string {
    return text.replace(/\n{2,}/g, '\n').trim();
}

// ---- Citation label recovery ----

/**
 * Use Zotero's citation formatter to produce a plain-text label from citation items.
 * Each item in `citationItems` must have an `itemData` property (CSL-JSON).
 * Returns null if formatting fails or produces no meaningful text.
 */
export function formatCitationText(citationItems: any[]): string | null {
    try {
        if (citationItems.length === 0) return null;
        const formatted = Zotero.EditorInstanceUtilities.formatCitation(
            { citationItems, properties: {} }
        );
        const text = formatted.replace(/<[^>]+>/g, '').trim();
        return (text && text !== '()') ? text : null;
    } catch {
        return null;
    }
}

/**
 * Look up a Zotero item by "libraryID-key" string and return a citation-item
 * object with CSL-JSON itemData, or null if the item can't be found.
 */
export function lookupCitationItem(itemId: string): { itemData: any } | null {
    try {
        const dashIdx = itemId.indexOf('-');
        if (dashIdx === -1) return null;
        const libraryID = parseInt(itemId.substring(0, dashIdx), 10);
        const key = itemId.substring(dashIdx + 1);
        const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (!item) return null;
        return { itemData: Zotero.Utilities.Item.itemToCSLJSON(item) };
    } catch {
        return null;
    }
}

/**
 * Look up a Zotero attachment by "libraryID-key" string, resolve to its parent
 * item, and return a citation-item object with CSL-JSON itemData.
 * Returns null if the attachment or parent can't be found.
 */
export function lookupCitationItemFromAttachment(attId: string): { itemData: any } | null {
    try {
        const dashIdx = attId.indexOf('-');
        if (dashIdx === -1) return null;
        const libraryID = parseInt(attId.substring(0, dashIdx), 10);
        const key = attId.substring(dashIdx + 1);
        const attachment = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (!attachment) return null;
        // Resolve to parent item for citation formatting
        const parentID = attachment.parentItemID;
        const item = parentID ? Zotero.Items.get(parentID) : attachment;
        if (!item) return null;
        return { itemData: Zotero.Utilities.Item.itemToCSLJSON(item) };
    } catch {
        return null;
    }
}

/**
 * Recover a citation label from a simplified <citation> tag's attributes
 * (item_id for single citations, att_id for attachment-based citations,
 * items for compound citations).
 */
export function recoverSimplifiedCitationLabel(tag: string): string | null {
    // Single citation: item_id="1-KEY"
    const itemIdMatch = tag.match(/\bitem_id="([^"]*)"/);
    if (itemIdMatch) {
        const ci = lookupCitationItem(itemIdMatch[1]);
        return ci ? formatCitationText([ci]) : null;
    }
    // Attachment-based citation: att_id="1-KEY" — resolve to parent item
    const attIdMatch = tag.match(/\batt_id="([^"]*)"/);
    if (attIdMatch) {
        const ci = lookupCitationItemFromAttachment(attIdMatch[1]);
        return ci ? formatCitationText([ci]) : null;
    }
    // Compound citation: items="1-KEY1:page=P1, 1-KEY2"
    const itemsMatch = tag.match(/\bitems="([^"]*)"/);
    if (itemsMatch) {
        const citationItems = itemsMatch[1].split(',')
            .map(entry => lookupCitationItem(entry.trim().split(':')[0]))
            .filter(Boolean);
        return formatCitationText(citationItems);
    }
    return null;
}

/**
 * Recover a citation label from a raw Zotero data-citation attribute
 * (URL-encoded JSON with citationItems containing URIs).
 */
export function recoverRawCitationLabel(encodedCitation: string): string | null {
    try {
        const citationData = JSON.parse(decodeURIComponent(encodedCitation));
        const citationItems = (citationData.citationItems || []).map((ci: any) => {
            if (ci.itemData) return ci;
            const uri = ci.uris?.[0];
            if (!uri) return ci;
            const itemInfo = (Zotero.URI as any).getURIItemLibraryKey(uri);
            if (!itemInfo) return ci;
            const item = Zotero.Items.getByLibraryAndKey(itemInfo.libraryID, itemInfo.key);
            if (!item) return ci;
            return { ...ci, itemData: Zotero.Utilities.Item.itemToCSLJSON(item) };
        });
        return formatCitationText(citationItems);
    } catch {
        return null;
    }
}

// ---- HTML stripping ----

/**
 * Extract the page attribute from a simplified citation tag and append it
 * to the label text so page changes are visible in the diff preview.
 */
function appendCitationPage(tag: string, label: string): string {
    const pageMatch = tag.match(/\bpage="([^"]*)"/);
    if (!pageMatch || !pageMatch[1]) return label;
    const page = pageMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    // Insert before closing paren if label ends with ')'
    if (label.endsWith(')')) {
        return label.slice(0, -1) + ', p. ' + page + ')';
    }
    return label + ' p. ' + page;
}

/**
 * Strip HTML tags for display, converting special elements to readable text.
 * - Citations (simplified): <citation ... label="(Author, 2020)"/> → (Author, 2020)
 * - Citations (raw Zotero): <span class="citation" ...>(<span class="citation-item">Author, 2024</span>)</span> → (Author, 2024)
 * - When a citation label is empty or "()", recovers a meaningful label by
 *   looking up the cited item in the Zotero library.
 * - Annotations: <annotation ...>highlighted text</annotation> → highlighted text
 * - Images: <annotation-image .../> or <image .../> → [image]
 * - Standard HTML tags are stripped, block elements add newlines.
 */
export function stripHtmlTags(html: string): string {
    return html
        // Handle full raw Zotero citation spans: match the entire span (including
        // nested citation-item spans), extract visible text, and recover if "()"
        // by looking up the item via Zotero APIs. Must come before individual tag
        // stripping to properly handle citations with empty visible text.
        .replace(
            /<span\s+class="citation"\s+data-citation="([^"]*)">((?:[^<]*(?:<span\b[^>]*>[^<]*<\/span>)?)*)<\/span>/gi,
            (_match, encodedCitation, visibleContent) => {
                const text = visibleContent.replace(/<[^>]+>/g, '').trim();
                if (text && text !== '()') return text;
                return recoverRawCitationLabel(encodedCitation) || text || '[citation]';
            }
        )
        // Convert simplified self-closing citation tags to their label text.
        // When label is empty or "()", recover by looking up the item.
        // Also appends page info from the page attribute when present.
        .replace(/<citation\b(?:[^>"']|"[^"]*"|'[^']*')*\blabel="([^"]*)"(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi,
            (match, label) => {
                const text = (label && label !== '()') ? label : (recoverSimplifiedCitationLabel(match) || label || '[citation]');
                return appendCitationPage(match, text);
            })
        // Remove simplified self-closing citation tags without a label (fallback).
        // Try to recover a meaningful label by looking up the cited item.
        .replace(/<citation\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi, (match) => {
            const text = recoverSimplifiedCitationLabel(match) || '[citation]';
            return appendCitationPage(match, text);
        })
        // Handle non-self-closing <citation> tags (preserve inner text)
        .replace(/<citation\b[^>]*>([\s\S]*?)<\/citation>/gi, '$1')
        // Convert annotation tags to their inner text
        .replace(/<annotation\b[^>]*>([\s\S]*?)<\/annotation>/gi, '$1')
        // Convert image tags to placeholder
        .replace(/<(?:annotation-image|image)\b[^>]*\/>/gi, '[image]')
        // Strip Zotero raw citation-item spans — fallback for unmatched spans
        .replace(/<span\s+class="citation-item"[^>]*>/gi, '')
        // Strip Zotero raw citation spans — fallback for unmatched spans
        .replace(/<span\s+class="citation"\s+data-citation="[^"]*"[^>]*>/gi, '')
        // Block elements → newlines
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        // Strip all remaining HTML tags. Uses alternation to correctly skip over
        // > characters that appear inside quoted attribute values.
        .replace(/<(?:[^>"']|"[^"]*"|'[^']*')+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        // Decode common HTML entities produced by escapeAttr
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
}

export default EditNotePreview;
