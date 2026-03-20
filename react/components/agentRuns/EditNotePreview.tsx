import React, { useState, useEffect, useMemo } from 'react';
import {
    getOrSimplify,
    getLatestNoteHtml,
} from '../../../src/utils/noteHtmlSimplifier';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface EditNotePreviewProps {
    /** The old string being replaced */
    oldString: string;
    /** The new replacement string */
    newString: string;
    /** Whether all occurrences are replaced */
    replaceAll?: boolean;
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

// ---- Component ----

export const EditNotePreview: React.FC<EditNotePreviewProps> = ({
    oldString,
    newString,
    replaceAll,
    occurrencesReplaced,
    warnings,
    status = 'pending',
    libraryId,
    zoteroKey,
}) => {
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';
    const isDelete = newString === '';

    const strippedOld = stripHtmlTags(oldString);
    const strippedNew = stripHtmlTags(newString);

    // When strippedOld is empty (old_string was pure HTML structure), fetch
    // surrounding visible text from the full note for context.
    const needsNoteContext = strippedOld === '' && oldString !== '' && strippedNew !== '';
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
                const searchString = isApplied ? newString : oldString;
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
    }, [needsNoteContext, libraryId, zoteroKey, oldString, isApplied, newString]);

    const diffLines = useMemo(() => {
        if (needsNoteContext && noteContext && (noteContext.before || noteContext.after)) {
            // Build diff with surrounding context from the note.
            // Context lines use 'addition' type without segments so they get the
            // light green background (matching the added text) but no darker
            // character-level highlight.
            const lines: DiffLine[] = [];
            if (noteContext.before) {
                lines.push({ type: 'addition', text: truncateContext(noteContext.before, 80, true) });
            }
            for (const line of strippedNew.split('\n')) {
                lines.push({ type: 'addition', text: line, segments: [{ text: line, highlighted: true }] });
            }
            if (noteContext.after) {
                lines.push({ type: 'addition', text: truncateContext(noteContext.after) });
            }
            return lines;
        }
        return computeDiff(strippedOld, strippedNew);
    }, [strippedOld, strippedNew, needsNoteContext, noteContext]);

    function getLineClass(type: DiffLine['type']): string {
        switch (type) {
            case 'deletion':
                return 'diff-deletion';
            case 'addition':
                return 'diff-addition';
            case 'context':
                return 'diff-context';
            case 'separator':
                return 'diff-separator';
        }
    }

    return (
        <div className="edit-note-preview">
            <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    {/* Only show header when replace_all is true (with occurrence count) */}
                    {replaceAll && (
                        <div className="text-sm font-color-primary font-medium px-3 py-1">
                            {isDelete ? 'Delete' : 'Replace'}
                            {' (all occurrences)'}
                            {occurrencesReplaced != null && occurrencesReplaced > 0
                                ? ` — ${occurrencesReplaced} occurrence${occurrencesReplaced === 1 ? '' : 's'}`
                                : ''}
                        </div>
                    )}
                    <div className="diff-container">
                        {diffLines.map((line, i) => (
                            <div key={i} className={`diff-line ${getLineClass(line.type)}`}>
                                <span className="diff-content">
                                    {line.type === 'separator'
                                        ? line.text
                                        : line.segments
                                            ? renderSegments(line.segments, line.type)
                                            : line.text}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Warnings */}
                {warnings && warnings.length > 0 && (
                    <div className="px-3 py-1">
                        {warnings.map((warning, i) => (
                            <div key={i} className="text-xs font-color-secondary italic">
                                {warning}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

// ---- Rendering helpers ----

function renderSegments(segments: DiffSegment[], lineType: DiffLine['type']): React.ReactNode {
    return segments.map((seg, i) => {
        if (seg.highlighted) {
            const className = lineType === 'deletion' ? 'diff-char-del' : 'diff-char-add';
            return <span key={i} className={className}>{seg.text}</span>;
        }
        return <React.Fragment key={i}>{seg.text}</React.Fragment>;
    });
}

// ---- Diff computation ----

/**
 * Compute a line-level diff with character-level highlighting for modified lines.
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

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // LCS table for line-level diff
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to get raw diff operations
    const rawOps: Array<{ type: 'context' | 'addition' | 'deletion'; text: string }> = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            rawOps.unshift({ type: 'context', text: oldLines[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            rawOps.unshift({ type: 'addition', text: newLines[j - 1] });
            j--;
        } else {
            rawOps.unshift({ type: 'deletion', text: oldLines[i - 1] });
            i--;
        }
    }

    // Pair consecutive deletion+addition blocks for character-level diff
    const diffLines: DiffLine[] = [];
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
                    // Pure addition within line: show only the addition with truncated context prefix
                    diffLines.push({ type: 'addition', text: additions[k], segments: truncateSegments(newSegs) });
                } else if (oldHasHighlight && !newHasHighlight) {
                    // Pure deletion within line: show only the deletion with truncated context suffix
                    diffLines.push({ type: 'deletion', text: deletions[k], segments: truncateSegments(oldSegs) });
                } else {
                    // Regular modification: show both deletion and addition with highlights
                    diffLines.push({ type: 'deletion', text: deletions[k], segments: truncateSegments(oldSegs) });
                    diffLines.push({ type: 'addition', text: additions[k], segments: truncateSegments(newSegs) });
                }
            }
            // Remaining unpaired lines
            for (let k = pairCount; k < deletions.length; k++) {
                diffLines.push({ type: 'deletion', text: deletions[k] });
            }
            for (let k = pairCount; k < additions.length; k++) {
                diffLines.push({ type: 'addition', text: additions[k], segments: [{ text: additions[k], highlighted: true }] });
            }
        } else {
            diffLines.push({ type: rawOps[idx].type, text: rawOps[idx].text });
            idx++;
        }
    }

    return filterContext(diffLines, 1);
}

/**
 * Compute character-level diff between two lines.
 * Finds the common prefix and suffix, highlights only the changed middle.
 */
function computeCharDiff(oldLine: string, newLine: string): [DiffSegment[], DiffSegment[]] {
    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < oldLine.length && prefixLen < newLine.length && oldLine[prefixLen] === newLine[prefixLen]) {
        prefixLen++;
    }

    // Find common suffix (not overlapping with prefix)
    let suffixLen = 0;
    while (
        suffixLen < oldLine.length - prefixLen &&
        suffixLen < newLine.length - prefixLen &&
        oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]
    ) {
        suffixLen++;
    }

    const prefix = oldLine.substring(0, prefixLen);
    const oldMiddle = oldLine.substring(prefixLen, oldLine.length - suffixLen);
    const newMiddle = newLine.substring(prefixLen, newLine.length - suffixLen);
    const suffix = oldLine.substring(oldLine.length - suffixLen);

    const oldSegments: DiffSegment[] = [];
    const newSegments: DiffSegment[] = [];

    if (prefix) {
        oldSegments.push({ text: prefix, highlighted: false });
        newSegments.push({ text: prefix, highlighted: false });
    }
    if (oldMiddle) oldSegments.push({ text: oldMiddle, highlighted: true });
    if (newMiddle) newSegments.push({ text: newMiddle, highlighted: true });
    if (suffix) {
        oldSegments.push({ text: suffix, highlighted: false });
        newSegments.push({ text: suffix, highlighted: false });
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
 * Recover a citation label from a simplified <citation> tag's attributes
 * (item_id for single citations, items for compound citations).
 */
export function recoverSimplifiedCitationLabel(tag: string): string | null {
    // Single citation: item_id="1-KEY"
    const itemIdMatch = tag.match(/\bitem_id="([^"]*)"/);
    if (itemIdMatch) {
        const ci = lookupCitationItem(itemIdMatch[1]);
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
        .replace(/<citation\b(?:[^>"']|"[^"]*"|'[^']*')*\blabel="([^"]*)"(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi,
            (match, label) => {
                if (label && label !== '()') return label;
                return recoverSimplifiedCitationLabel(match) || label || '[citation]';
            })
        // Remove simplified self-closing citation tags without a label (fallback)
        .replace(/<citation\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi, '[citation]')
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
