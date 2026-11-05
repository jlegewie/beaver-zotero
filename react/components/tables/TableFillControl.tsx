import React from 'react';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import { cellsToFill, pendingWork, retryableFailedRows } from '@beaver/agent-core/layouts/tableFill';
import {
    TABLE_FILL_CHANGED_EVENT,
    type TableFillJobSnapshot,
    type TableFillPlanSummary,
    type TableFillScope,
} from '@beaver/agent-core/protocol/tableFillProtocol';
import {
    balanceLine,
    fillActionLabel,
    fillButtonLabel,
    fillButtonRows,
    creditsText,
    pendingLines,
    planCostLine,
    planRowLine,
    pricingSentence,
    resultNeedsAttention,
    resultText,
    runningLabel,
    timeLeftText,
} from '@beaver/agent-core/run-state/tableFillCopy';
import { ArrowDownIcon, CancelIcon, Icon, PlayIcon, Spinner, StopIcon } from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import type { TableRef } from '../../../src/services/artifacts/tableItemIdentity';
import { getWindowRuntime } from '../../runtime/windowRuntime';

/**
 * The table's fill job as the tab shows it: the running job, else the last
 * finished one still kept by the plugin (its result banner). Follows the
 * job's published snapshots; nothing polls.
 */
export function useTableFillJob(tableRef: TableRef): TableFillJobSnapshot | null {
    const [job, setJob] = React.useState<TableFillJobSnapshot | null>(
        () => Zotero.Beaver.tableFills?.jobForTable(tableRef) ?? null,
    );
    React.useEffect(() => {
        setJob(Zotero.Beaver.tableFills?.jobForTable(tableRef) ?? null);
        return Zotero.Beaver.runtime.subscribeWindow(
            getWindowRuntime(),
            TABLE_FILL_CHANGED_EVENT,
            (snapshot: TableFillJobSnapshot) => {
                if (snapshot?.table?.libraryID === tableRef.libraryID && snapshot.table.key === tableRef.key) {
                    setJob(snapshot);
                }
            },
        );
    }, [tableRef.libraryID, tableRef.key]);
    return job;
}

type Popover =
    | { scope: TableFillScope; state: 'planning' }
    | { scope: TableFillScope; state: 'ready' | 'starting'; plan: TableFillPlanSummary; error?: string }
    | { scope: TableFillScope; state: 'error'; message: string };

export interface TableFillButtonProps {
    tableRef: TableRef;
    table: TableSpec;
    job: TableFillJobSnapshot | null;
    /** Rows answered from title and abstract whose item gained a document. */
    improvableRows: ReadonlySet<string>;
    /** Why the table cannot be filled (a read-only library); disables the control. */
    disabledReason?: string;
    /** The rows selected in the table, for "Fill selected rows". */
    selectedRowIds?: string[];
}

/**
 * Shows a plan in the Fill popover, asked for from elsewhere in the tab
 * (Refill row, Fill this column, the selection bar's Fill).
 */
export interface TableFillButtonHandle {
    openPlan(scope: TableFillScope): void;
}

/** The five-row trial's size. */
export const TRIAL_ROWS = 5;

const EMPTY_ROWS: string[] = [];

/**
 * The Fill split button of the table tab.
 *
 * Idle, it counts the table's new and stale work ("Fill 46 rows"), or reads
 * "Fill", muted, when everything is up to date; rows that only need a retry
 * are offered in its menu but do not light it. A click plans the fill in the
 * plugin and shows the plan in a popover: what will be filled, the row line,
 * the exact cost, the pricing sentence and how far the balance reaches. "Fill
 * N" starts exactly that plan. While a job runs it is the Stop button.
 */
export const TableFillButton = React.forwardRef<TableFillButtonHandle, TableFillButtonProps>(function TableFillButton(
    { tableRef, table, job, improvableRows, disabledReason, selectedRowIds = EMPTY_ROWS },
    ref,
): React.ReactElement {
    const [popover, setPopover] = React.useState<Popover | null>(null);
    const wrapRef = React.useRef<HTMLDivElement>(null);
    const request = React.useRef(0);
    const pending = React.useMemo(() => pendingWork(table), [table]);
    const retryRows = React.useMemo(() => retryableFailedRows(table).length, [table]);
    const alsoPending = React.useMemo(() => {
        if (!improvableRows.size) return 0;
        const selected = new Set(cellsToFill(table).map(([row]) => row));
        return [...improvableRows].filter((row) => selected.has(row)).length;
    }, [table, improvableRows]);
    const rows = fillButtonRows(pending, improvableRows.size, alsoPending);
    const running = job != null && job.state !== 'done';

    const close = React.useCallback(() => {
        request.current += 1;
        setPopover(null);
    }, []);

    // A click outside the popover, or Escape, closes it.
    React.useEffect(() => {
        if (!popover) return;
        const doc = wrapRef.current?.ownerDocument;
        if (!doc) return;
        const onPointer = (event: Event) => {
            if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close();
        };
        const onKey = (event: KeyboardEvent) => {
            // A composing IME owns Escape: it dismisses the candidate list.
            if (event.key === 'Escape' && !isImeKeyEvent(event)) {
                event.stopPropagation();
                close();
            }
        };
        doc.addEventListener('mousedown', onPointer, true);
        doc.addEventListener('keydown', onKey, true);
        return () => {
            doc.removeEventListener('mousedown', onPointer, true);
            doc.removeEventListener('keydown', onKey, true);
        };
    }, [popover != null, close]);

    // A fill that starts elsewhere (chat, another window) closes the popover.
    React.useEffect(() => {
        if (running) close();
    }, [running, close]);

    const openPlan = React.useCallback(
        async (scope: TableFillScope) => {
            const fills = Zotero.Beaver.tableFills;
            const mine = ++request.current;
            if (!fills) {
                setPopover({ scope, state: 'error', message: 'Filling is not available. Reload Beaver and try again.' });
                return;
            }
            setPopover({ scope, state: 'planning' });
            try {
                const planned = await fills.plan(tableRef, scope);
                if (mine !== request.current) return;
                setPopover(
                    planned.ok
                        ? { scope, state: 'ready', plan: planned.plan }
                        : { scope, state: 'error', message: planned.message },
                );
            } catch (error) {
                if (mine !== request.current) return;
                setPopover({ scope, state: 'error', message: String((error as Error)?.message ?? error) });
            }
        },
        [tableRef.libraryID, tableRef.key],
    );

    React.useImperativeHandle(
        ref,
        () => ({
            openPlan: (scope: TableFillScope) => {
                if (!running && !disabledReason) void openPlan(scope);
            },
        }),
        [running, disabledReason, openPlan],
    );

    const start = React.useCallback(async () => {
        if (popover?.state !== 'ready') return;
        const fills = Zotero.Beaver.tableFills;
        if (!fills) return;
        const mine = ++request.current;
        setPopover({ ...popover, state: 'starting', error: undefined });
        const started = await fills.start(popover.plan.plan_id).catch((error: unknown) => ({
            ok: false as const,
            code: 'table_unavailable' as const,
            message: String((error as Error)?.message ?? error),
        }));
        if (mine !== request.current) return;
        if (started.ok) {
            setPopover(null);
            return;
        }
        setPopover({ ...popover, state: 'ready', error: started.message });
    }, [popover]);

    if (running) {
        const stopping = job.state === 'stopping';
        return (
            <div className="bt-fill" ref={wrapRef}>
                <Button
                    variant="surface"
                    icon={stopping ? <Spinner size={12} /> : StopIcon}
                    disabled={stopping}
                    title={timeLeftText(job.seconds_left) ?? undefined}
                    ariaLabel={stopping ? runningLabel(job) : `Stop the fill, ${job.rows_done} of ${job.rows_total} rows done`}
                    onClick={() => Zotero.Beaver.tableFills?.stop(job.job_id)}
                >
                    {runningLabel(job)}
                </Button>
            </div>
        );
    }

    const lit = rows > 0;
    const count = (n: number) => n.toLocaleString('en-US');
    const selected = selectedRowIds.length;
    const menuItems: MenuItem[] = [
        {
            label: 'Fill everything pending',
            shortcut: count(pending.rows),
            onClick: () => void openPlan({ kind: 'pending' }),
        },
        {
            label: 'Try on 5 rows first',
            shortcut: count(Math.min(TRIAL_ROWS, pending.rows)),
            disabled: pending.rows === 0,
            onClick: () => void openPlan({ kind: 'pending', limit: TRIAL_ROWS }),
        },
        {
            label: 'Fill selected rows',
            shortcut: selected ? count(selected) : 'Select rows first',
            disabled: selected === 0,
            onClick: () => void openPlan({ kind: 'cells', rows: selectedRowIds }),
        },
        {
            label: 'Retry rows that failed',
            shortcut: count(retryRows),
            onClick: () => void openPlan({ kind: 'retry_failed' }),
            disabled: retryRows === 0,
        },
        { label: '', isDivider: true, onClick: () => {} },
        {
            label: 'Fill this column and Refill row live in the column and row menus.',
            disabled: true,
            onClick: () => {},
            customContent: <span className="bt-fill-menu-note">Fill this column and Refill row live in the column and row menus.</span>,
        },
    ];

    return (
        <div className="bt-fill" ref={wrapRef}>
            <div className="bt-fill-split">
                <Button
                    variant={lit ? 'solid' : 'surface'}
                    icon={PlayIcon}
                    className={`bt-fill-main${lit ? '' : ' bt-fill-idle'}`}
                    disabled={!!disabledReason}
                    title={disabledReason ?? (lit ? undefined : 'Everything is up to date')}
                    onClick={() => void openPlan({ kind: 'pending' })}
                >
                    {fillButtonLabel(rows)}
                </Button>
                <MenuButton
                    menuItems={menuItems}
                    variant={lit ? 'solid' : 'surface'}
                    icon={ArrowDownIcon}
                    className={`bt-fill-more${lit ? '' : ' bt-fill-idle'}`}
                    ariaLabel="More ways to fill"
                    disabled={!!disabledReason}
                    width="17rem"
                />
            </div>
            {popover ? (
                <FillPopover
                    popover={popover}
                    onStart={() => void start()}
                    onTrial={() => void openPlan({ kind: 'pending', limit: TRIAL_ROWS })}
                    onCancel={close}
                />
            ) : null}
        </div>
    );
});

function FillPopover({
    popover,
    onStart,
    onTrial,
    onCancel,
}: {
    popover: Popover;
    onStart: () => void;
    onTrial: () => void;
    onCancel: () => void;
}): React.ReactElement {
    let body: React.ReactNode;
    let action: React.ReactNode = null;
    let trial: React.ReactNode = null;
    if (popover.state === 'planning') {
        body = (
            <div className="bt-fill-status">
                <Spinner size={12} />
                <span>Working out what to fill…</span>
            </div>
        );
    } else if (popover.state === 'error') {
        body = <div className="bt-fill-error" role="alert">{popover.message}</div>;
    } else if (popover.plan.rows === 0) {
        body = <div className="bt-fill-status">Everything is up to date.</div>;
    } else {
        const plan = popover.plan;
        const lines = pendingLines(plan);
        const reach = balanceLine(plan);
        body = (
            <>
                <div className="bt-fill-title">{planCostLine(plan)}</div>
                {lines.length ? (
                    <ul className="bt-fill-lines">
                        {lines.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                ) : null}
                <div className="bt-fill-line">{planRowLine(plan)}.</div>
                <div className="bt-fill-note">{pricingSentence(plan.prices, plan.title_abstract)}</div>
                {reach ? (
                    <div className="bt-fill-line bt-fill-reach">{reach}.</div>
                ) : plan.balance != null ? (
                    <div className="bt-fill-note">Balance: {creditsText(plan.balance)}</div>
                ) : null}
                {popover.error ? (
                    <div className="bt-fill-error" role="alert">
                        {popover.error}
                    </div>
                ) : null}
            </>
        );
        // A whole pending fill can be tried on its first rows first.
        if (popover.scope.kind === 'pending' && !popover.scope.limit && plan.rows > TRIAL_ROWS)
            trial = (
                <Button variant="ghost-secondary" onClick={onTrial} disabled={popover.state === 'starting'}>
                    Try on 5 rows first
                </Button>
            );
        action = (
            <Button
                variant="solid"
                onClick={onStart}
                disabled={popover.state === 'starting'}
                loading={popover.state === 'starting'}
            >
                {fillActionLabel(plan)}
            </Button>
        );
    }
    return (
        <div className="bt-fill-popover" role="dialog" aria-label="Fill the table">
            {body}
            <div className="bt-fill-actions">
                {trial}
                {trial ? <span className="bt-fill-actions-gap" /> : null}
                <Button variant="ghost-secondary" onClick={onCancel}>
                    {action ? 'Cancel' : 'Close'}
                </Button>
                {action}
            </div>
        </div>
    );
}

export interface TableFillBannerProps {
    job: TableFillJobSnapshot;
    /** Whether the table shows only the rows that failed. */
    showingFailed: boolean;
    onShowFailed(show: boolean): void;
    onDismiss(): void;
}

/** The result of the last fill, over the grid, until dismissed. */
export function TableFillBanner({ job, showingFailed, onShowFailed, onDismiss }: TableFillBannerProps): React.ReactElement {
    const failed = job.result?.failed_row_ids.length ?? 0;
    return (
        <span className="bt-fill-banner">
            <span className="bt-fill-banner-text">{resultText(job)}</span>
            {failed > 0 ? (
                <button type="button" className="bt-fill-banner-link" onClick={() => onShowFailed(!showingFailed)}>
                    {showingFailed ? 'Show all' : 'Show'}
                </button>
            ) : null}
            <button type="button" className="bt-fill-banner-close" aria-label="Dismiss" onClick={onDismiss}>
                <Icon icon={CancelIcon} size={10} />
            </button>
        </span>
    );
}

/** How long a clean result stays while its tab is visible. */
export const CLEAN_RESULT_VISIBLE_MS = 10_000;

/**
 * The last fill's result banner and its "failed rows only" filter.
 *
 * A clean result (rows filled, credits charged, nothing else to say) clears
 * itself at the user's next action in the table (`onActivity`), or after
 * {@link CLEAN_RESULT_VISIBLE_MS} of the tab being visible; with `visible`
 * null (unknown) only the next action clears it. A result that needs
 * attention stays until dismissed or replaced by the next fill. Either way
 * the dismissal lets the plugin forget the job.
 *
 * The filter names its job: the chat can ask for a fill's failed rows
 * (`showFailedRows`) after that fill's banner is gone or replaced, and then
 * a strip of its own offers to show every row again. A new fill clears it.
 */
export function useFillResultBanner(
    job: TableFillJobSnapshot | null,
    visible: boolean | null,
): {
    banner: React.ReactElement | null;
    /** The finished job the banner shows; null when there is none. */
    jobId: string | null;
    /** The rows to show while "failed rows only" is on; null otherwise. */
    failedRows: ReadonlySet<string> | null;
    /** Show every row again. */
    showAllRows(): void;
    /** Show only the rows a fill could not read, asked for from outside the tab. */
    showFailedRows(jobId: string, rowIds: readonly string[]): void;
    /** The user acted on the table. */
    onActivity(): void;
} {
    const [dismissedJob, setDismissedJob] = React.useState<string | null>(null);
    const [failedFilter, setFailedFilter] = React.useState<{ jobId: string; rows: ReadonlySet<string> } | null>(null);
    const finishedJob = job?.state === 'done' && job.job_id !== dismissedJob ? job : null;
    const showFailed = !!failedFilter && failedFilter.jobId === finishedJob?.job_id;
    const failedRows = failedFilter?.rows ?? null;
    const setShowFailed = React.useCallback(
        (show: boolean) =>
            setFailedFilter(
                show && finishedJob?.result
                    ? { jobId: finishedJob.job_id, rows: new Set(finishedJob.result.failed_row_ids) }
                    : null,
            ),
        [finishedJob],
    );
    // A new fill works on every row again.
    const running = !!job && job.state !== 'done';
    React.useEffect(() => {
        if (running) setFailedFilter(null);
    }, [running]);

    const dismiss = React.useCallback((jobId: string) => {
        setDismissedJob(jobId);
        setFailedFilter((filter) => (filter?.jobId === jobId ? null : filter));
        Zotero.Beaver.tableFills?.dismiss(jobId);
    }, []);
    const cleanJob = finishedJob && !resultNeedsAttention(finishedJob) ? finishedJob.job_id : null;
    const onActivity = React.useCallback(() => {
        if (cleanJob) dismiss(cleanJob);
    }, [cleanJob, dismiss]);
    // Counts only while the tab is visible: a fill that ends in the
    // background still shows its result when the user comes back.
    React.useEffect(() => {
        if (!cleanJob || visible !== true) return;
        const timer = setTimeout(() => dismiss(cleanJob), CLEAN_RESULT_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [cleanJob, visible, dismiss]);

    const showAllRows = React.useCallback(() => setFailedFilter(null), []);
    const showFailedRows = React.useCallback((jobId: string, rowIds: readonly string[]) => {
        if (rowIds.length) setFailedFilter({ jobId, rows: new Set(rowIds) });
    }, []);
    const jobBanner = finishedJob ? (
        <TableFillBanner
            job={finishedJob}
            showingFailed={showFailed}
            onShowFailed={setShowFailed}
            onDismiss={() => dismiss(finishedJob.job_id)}
        />
    ) : null;
    // Failed rows of a fill whose banner is not the one shown: their own
    // strip, so the filter can be undone.
    const filterStrip =
        failedFilter && !showFailed ? (
            <span className="bt-fill-banner">
                <span className="bt-fill-banner-text">
                    {failedFilter.rows.size === 1
                        ? "Showing the row that couldn't be read"
                        : `Showing the ${failedFilter.rows.size.toLocaleString('en-US')} rows that couldn't be read`}
                </span>
                <button type="button" className="bt-fill-banner-link" onClick={showAllRows}>
                    Show all
                </button>
            </span>
        ) : null;
    const banner =
        jobBanner && filterStrip ? (
            <>
                {filterStrip}
                {jobBanner}
            </>
        ) : (jobBanner ?? filterStrip);
    return { banner, jobId: finishedJob?.job_id ?? null, failedRows, showAllRows, showFailedRows, onActivity };
}
