/**
 * The result of a table fill cut off by a quit, derived from the table as it
 * was left: the fill's shutdown flush saved the answers it had received, so a
 * covered row with no pending cell left was filled, a failed row failed, and
 * every other row was not started.
 */

import { cellsToFill, pendingWork } from '@beaver/agent-core/layouts/tableFill';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableFillJobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import type { TableFillJobCoverage } from '../tableFills/service';

export function interruptedFillResult(
    jobId: string,
    coverage: TableFillJobCoverage,
    spec: TableSpec,
    sendable: (value: unknown) => boolean,
): TableFillJobResult {
    const pending = new Set(cellsToFill(spec).map(([row, column]) => `${row}\u0000${column}`));
    const rows = new Map(spec.rows.map((row) => [row.id, row]));
    let filled = 0;
    let failed = 0;
    const failures: Record<string, number> = {};
    let answered = 0;
    let notStarted = 0;
    const failedRowIds: string[] = [];
    for (const covered of coverage.rows) {
        const row = rows.get(covered.row);
        // A row deleted since: nothing is left to fill there.
        if (!row) continue;
        const open = covered.columns.filter((column) => pending.has(`${covered.row}\u0000${column}`)).length;
        if (row.failure != null) {
            failed += 1;
            failedRowIds.push(row.id);
            const code = row.failure.code || 'read_failed';
            failures[code] = (failures[code] ?? 0) + 1;
        } else if (open === 0) {
            filled += 1;
            answered += covered.columns.length;
        } else {
            notStarted += 1;
            answered += covered.columns.length - open;
        }
    }
    const work = pendingWork(spec);
    const total = coverage.rows_total || coverage.rows.length;
    return {
        kind: 'table_fill',
        job_id: jobId,
        status: 'done',
        interrupted: true,
        progress: {
            state: 'done',
            rows_total: total,
            rows_done: filled + failed,
            rows_failed: failed,
            in_flight: 0,
            credits_charged: 0,
            credits_planned: coverage.credits_planned,
            seconds_left: null,
        },
        result: {
            rows_answered: filled,
            answered,
            not_reported: 0,
            from_title_abstract: 0,
            documents_read: 0,
            credits_charged: 0,
            row_failures: failures,
            failed_row_ids: failedRowIds.filter((id) => sendable(id)),
            not_started: notStarted ? { shutdown: notStarted } : {},
            not_written: 0,
            skipped_cells: {},
            stopped_by: 'shutdown',
            pending: sendable(work) ? work : null,
        },
    };
}
