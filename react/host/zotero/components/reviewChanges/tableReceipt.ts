/**
 * The table receipt under an answer: two lines and its moves.
 *
 * Line one is the thing — the table, or what the answer changed about it.
 * Line two is its condition, read from the table as it is now, so an old
 * answer never shows a filled table as empty; what is left to fill is said
 * there, and filled from the table itself. Export and Open are offered while
 * the table can be read and opened, Stop while a fill runs (with the
 * progress rule), and Undo only on an edit, while the table is still as that
 * edit left it.
 *
 * Pure: the component gathers the live state and renders what this returns.
 */

import type { TableRecord } from '@beaver/agent-core/protocol/artifactProtocol';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { tableChangeLines } from '@beaver/agent-core/run-state/tableEditCopy';
import { progressLine } from '@beaver/agent-core/run-state/tableFillCopy';
import { formatTableCounts } from '../../../../components/agentRuns/toolResultViews/TableResultView';

/** Why the table cannot be filled from here. */
export type TableReceiptBlock = 'library_excluded' | 'read_only';

/** The table as it is now, as far as the receipt needs it. */
export type TableReceiptLive =
    | {
          status: 'available';
          title: string;
          rows: number;
          /** Content columns: every column except system metadata. */
          columns: number;
          /** Question columns a fill answers. */
          questions: number;
          /** Rows with an answer and no failure. */
          readRows: number;
          /** Rows whose last fill could not read them. */
          failedRows: number;
          /** Rows the table's own Fill button counts; zero when nothing asks to be filled. */
          fillRows: number;
          /** Cells the default fill would answer: empty, out of date, or failed. */
          emptyCells: number;
          version: number;
          /** Set when Beaver may not fill this table; null when it may or the scope is not known yet. */
          blocked: TableReceiptBlock | null;
      }
    /** `openable`: the files are not on this device yet, and opening the table downloads them. */
    | { status: 'unavailable'; reason: string; openable?: boolean };

export interface TableReceiptModel {
    title: string;
    /** Line one: the edit's headline, else the title. */
    headline: string;
    /** Line two, before any warning. */
    condition: string;
    /** Line two's marked tail ("3 couldn't be read"). */
    warning: string | null;
    /** A fill runs: Stop it. */
    stop: boolean;
    /** The table can be exported: it is here, holds answers, and no fill is changing it. */
    export: boolean;
    /** The table can be opened. */
    open: boolean;
    /** Undo leads the moves. */
    undo: boolean;
    /** The table cannot be reached: the row reads muted and offers nothing. */
    muted: boolean;
}

function count(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * What an edit changed, in a few words: its first change, and how many more.
 * Null for a record that is not an edit.
 */
export function editHeadline(record: Pick<TableRecord, 'edits'>): string | null {
    const lines = tableChangeLines(record.edits ?? []);
    if (!lines.length) return null;
    // The first segment is the change; what follows " · " is its effects.
    const first = lines[0].text.split(' · ')[0];
    const more = lines.length - 1;
    return more > 0 ? `${first} and ${count(more, 'more change')}` : first;
}

export interface TableReceiptInput {
    record: TableRecord;
    /** The answer created the table, rather than editing one. */
    created: boolean;
    /** Undefined until the first read of the table resolves. */
    live: TableReceiptLive | undefined;
    /** The table's fill job, if one is running or kept. */
    job: TableFillJobSnapshot | null;
    /** The host can undo a table edit, and this one was not undone from here yet. */
    undoAvailable: boolean;
}

export function tableReceiptModel({ record, created, live, job, undoAvailable }: TableReceiptInput): TableReceiptModel {
    const available = live?.status === 'available' ? live : null;
    const title = (available ? available.title : record.reference.title) || 'Untitled table';
    const edit = created ? null : editHeadline(record);
    const headline = edit ?? title;
    // An edit's headline takes line one, so line two names the table first.
    const withTitle = (text: string) => (edit ? (text ? `${title} · ${text}` : title) : text);
    const base = { title, headline, warning: null, stop: false, export: true, open: true, undo: false, muted: false };

    if (live?.status === 'unavailable')
        return live.openable
            ? { ...base, condition: withTitle(live.reason), export: false }
            : { ...base, condition: withTitle(live.reason), export: false, open: false, muted: true };
    if (!available) return { ...base, condition: withTitle(formatTableCounts({ rows: record.summary.rows }) ?? ''), export: false, open: false };

    const running = job != null && job.state !== 'done';
    if (running) {
        const line = progressLine(job);
        // A file exported now would hold the fill half done.
        return { ...base, condition: withTitle(line.status), warning: line.failed, stop: true, export: false };
    }

    // An unread table would export only the list of its items.
    const settled = { ...base, export: available.readRows > 0 };
    const undo =
        undoAvailable
        && !created
        && !!record.edits?.length
        && typeof record.version === 'number'
        && available.version === record.version;

    if (available.fillRows > 0) {
        const pending =
            available.readRows === 0 && available.failedRows === 0
                ? `${count(available.rows, 'row')} · nothing read yet`
                : `${count(available.emptyCells, 'cell')} to fill`;
        if (available.blocked === 'library_excluded')
            return { ...settled, condition: withTitle(`${count(available.rows, 'row')} · in a library Beaver can't read`), undo };
        if (available.blocked === 'read_only')
            return { ...settled, condition: withTitle(`${count(available.rows, 'row')} · in a read-only library`), undo };
        return { ...settled, condition: withTitle(pending), undo };
    }

    if (available.failedRows > 0 && available.questions > 0) {
        return {
            ...settled,
            condition: withTitle(`${available.readRows.toLocaleString('en-US')} of ${count(available.rows, 'item')} read`),
            warning: `${available.failedRows.toLocaleString('en-US')} couldn't be read`,
            undo,
        };
    }

    const size = formatTableCounts({ rows: available.rows, contentColumns: available.columns }) ?? '';
    return { ...settled, condition: withTitle(size), undo };
}
