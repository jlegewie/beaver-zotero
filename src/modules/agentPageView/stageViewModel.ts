/**
 * Earlier stages of PDF extraction as drawable boxes: the columns a page was
 * split into, and the text lines detected in them. They explain the items the
 * agent view shows (see `agentPageViewModel.ts`) when those look wrong.
 *
 * Built from the extraction's per-page debug data, whose rects are in the same
 * public extraction frame as the structured document.
 */

import type { PageDebugData } from '@beaver/agent-core/extract/schema';
import type { AgentViewBox, ViewPage } from './agentPageViewModel';

function columnLabel(columnIndex: number): string {
    return `C${columnIndex + 1}`;
}

/** The detected columns of one page, each with the text of its lines on hover. */
export function buildColumnViewPage(page: PageDebugData): ViewPage {
    const lines = page.lines ?? [];
    const boxes = (page.columns ?? []).map((rect, columnIndex): AgentViewBox => {
        const columnLines = lines.filter((line) => line.columnIndex === columnIndex);
        const label = columnLabel(columnIndex);
        return {
            kind: 'column',
            id: label,
            rects: [rect],
            title: `Column ${label} · ${columnLines.length} lines`,
            text: columnLines.map((line) => line.text ?? '').join('\n'),
            shade: 0,
        };
    });
    return { pageIndex: page.pageIndex, width: page.width, height: page.height, boxes };
}

/** The detected lines of one page, in reading order, margin lines included. */
export function buildLineViewPage(page: PageDebugData): ViewPage {
    const boxes = (page.lines ?? []).map((line, lineIndex): AgentViewBox => {
        const label = `L${lineIndex + 1}`;
        return {
            kind: 'line',
            id: label,
            rects: [line.bbox],
            title: line.columnIndex === undefined
                ? `Line ${label}`
                : `Line ${label} · column ${columnLabel(line.columnIndex)}`,
            text: line.text ?? '',
            shade: (lineIndex % 2) as 0 | 1,
        };
    });
    return { pageIndex: page.pageIndex, width: page.width, height: page.height, boxes };
}
