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

/** The result of the last fill, under the toolbar, until dismissed. */
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
