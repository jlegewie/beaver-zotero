/**
 * Live progress of table fills, for the panel above the composer.
 *
 * The backend sends one stamp when a fill starts (`table_fill_started`) with
 * the rows it works on. Progress is not reported by the backend: it comes from
 * the `edit` commits this client applies to the table, so the panel and the
 * table never disagree. The fill's tool return, the end of its run, or a new
 * thread retires the entry.
 */

import { atom } from 'jotai/vanilla';
import type { WSTableFillStarted } from '../protocol/tableCardProtocol';

export interface TableFillProgress {
    stamp: WSTableFillStarted;
    /** Rows a commit has written, in commit order. */
    rows: string[];
    /** Of those, the rows with a failed cell. */
    failedRows: string[];
    /** When the stamp arrived and when the last commit landed (ms since epoch). */
    startedAt: number;
    updatedAt: number;
}

/** What one `edit` commit of a fill wrote, as the store announced it. */
export interface TableFillCommit {
    /** Portable item id of the table. */
    table: string;
    run_id?: string;
    rows: string[];
    failed_rows: string[];
}

/** Live fills keyed by the tool call that runs them. */
export const tableFillProgressAtom = atom<Map<string, TableFillProgress>>(new Map());

export function startFillProgress(stamp: WSTableFillStarted, now: number): TableFillProgress {
    return { stamp, rows: [], failedRows: [], startedAt: now, updatedAt: now };
}

/**
 * Fold a commit into a fill's progress. A commit for another table or another
 * run leaves it as it is. Counting rows from commits relies on the filler
 * writing every cell of a row in one commit (it answers a row's questions in
 * one call and queues them together), so a row a commit names is done. A row
 * counts once however many commits write it; one written again without a
 * failure no longer counts as failed.
 */
export function recordFillCommit(progress: TableFillProgress, commit: TableFillCommit, now: number): TableFillProgress {
    if (commit.table !== progress.stamp.table.key) return progress;
    if (commit.run_id !== progress.stamp.run_id) return progress;
    if (!commit.rows.length) return progress;
    const rows = new Set(progress.rows);
    const failed = new Set(progress.failedRows);
    const nowFailed = new Set(commit.failed_rows);
    for (const row of commit.rows) {
        rows.add(row);
        if (nowFailed.has(row)) failed.add(row);
        else failed.delete(row);
    }
    return { ...progress, rows: [...rows], failedRows: [...failed], updatedAt: now };
}

/** Rows done of the stamp's total; a fill never reports more than its total. */
export function fillRowsDone(progress: TableFillProgress): number {
    return Math.min(progress.rows.length, progress.stamp.rows);
}

/**
 * Estimated time left, from the pace of the rows done so far; null until a
 * commit has landed or once nothing is left.
 */
export function fillRemainingMs(progress: TableFillProgress): number | null {
    const done = fillRowsDone(progress);
    const left = progress.stamp.rows - done;
    if (done === 0 || left <= 0) return null;
    const elapsed = progress.updatedAt - progress.startedAt;
    if (elapsed <= 0) return null;
    return (elapsed / done) * left;
}

/** "about 3 min left", "under a minute left", or null. */
export function formatRemaining(ms: number | null): string | null {
    if (ms === null) return null;
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return 'under a minute left';
    if (minutes < 60) return `about ${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}

export const addTableFillProgressAtom = atom(null, (get, set, stamp: WSTableFillStarted) => {
    const next = new Map(get(tableFillProgressAtom));
    next.set(stamp.toolcall_id, startFillProgress(stamp, Date.now()));
    set(tableFillProgressAtom, next);
});

export const recordTableFillCommitAtom = atom(null, (get, set, commit: TableFillCommit) => {
    const current = get(tableFillProgressAtom);
    if (!current.size) return;
    const now = Date.now();
    let changed = false;
    const next = new Map(current);
    for (const [toolcallId, progress] of current) {
        const updated = recordFillCommit(progress, commit, now);
        if (updated !== progress) {
            next.set(toolcallId, updated);
            changed = true;
        }
    }
    if (changed) set(tableFillProgressAtom, next);
});

/** Retire the fill a returning tool call ran. */
export const removeTableFillProgressAtom = atom(null, (get, set, toolcallId: string) => {
    const current = get(tableFillProgressAtom);
    if (!current.has(toolcallId)) return;
    const next = new Map(current);
    next.delete(toolcallId);
    set(tableFillProgressAtom, next);
});

export const clearTableFillProgressAtom = atom(null, (get, set) => {
    if (get(tableFillProgressAtom).size) set(tableFillProgressAtom, new Map());
});
