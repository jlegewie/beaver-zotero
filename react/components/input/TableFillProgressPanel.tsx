import React, { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
    fillRemainingMs,
    fillRowsDone,
    formatRemaining,
    tableFillProgressAtom,
} from '@beaver/agent-core/run-state/tableFillProgress';
import { getHost } from '@beaver/agent-ui/host';
import Button from '@beaver/agent-ui/primitives/Button';
import { useStopRun } from '../../hooks/useStopRun';
import { ArrowUpRightIcon, Icon, StopStrokeIcon, TableIcon } from '../icons/icons';

/**
 * A table fill's progress above the composer, modelled on the batch panel:
 * the table and what is being filled, rows done of the total, rows failed so
 * far, an estimate of the time left, a link that opens the table in its tab,
 * and Stop, which is the run cancel (rows already committed stay).
 *
 * Totals come from the backend's stamp when the fill starts; progress comes
 * from the `edit` commits this client applies, so the panel never runs ahead
 * of the table. Shown in every chat surface of the window, including the
 * chat beside a table's Beaver tab.
 */
const TableFillProgressPanel: React.FC = () => {
    const fills = useAtomValue(tableFillProgressAtom);
    const stop = useStopRun('TableFillProgressPanel');
    const [openMessage, setOpenMessage] = useState('');
    // The newest fill: a run fills one table at a time.
    const progress = [...fills.values()].pop() ?? null;
    const tableKey = progress?.stamp.table.key ?? null;

    const openTable = useCallback(async (event: React.SyntheticEvent) => {
        if (!tableKey) return;
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        const open = getHost().navigation?.openTable;
        if (!open) return;
        const outcome = await open(tableKey, origin).catch(() => ({ error: 'Table provider unavailable.' }));
        setOpenMessage('error' in outcome ? outcome.error : '');
    }, [tableKey]);

    if (!progress) return null;
    const { stamp } = progress;
    const total = stamp.rows;
    const done = fillRowsDone(progress);
    const failed = progress.failedRows.length;
    const remaining = formatRemaining(fillRemainingMs(progress));
    const share = total > 0 ? (done / total) * 100 : 0;
    const failedShare = total > 0 ? (Math.min(failed, done) / total) * 100 : 0;
    const columns = stamp.columns.join(', ');
    const detail = [
        failed > 0 ? `${failed.toLocaleString('en-US')} failed` : null,
        remaining,
    ].filter(Boolean).join(' · ');

    return (
        <div
            className="composer-docked-bar batch-progress-bar border-bottom-quinary"
            style={{ position: 'relative' }}
            role="group"
            aria-label="Table fill progress"
        >
            <div
                className="display-flex flex-row batch-progress-hairline"
                style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, overflow: 'hidden', pointerEvents: 'none' }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                aria-valuetext={`${done} of ${total} rows filled`}
            >
                {done === 0 ? (
                    <div className="batch-progress-indeterminate" />
                ) : (
                    <>
                        <div style={{ width: `${share - failedShare}%`, backgroundColor: 'var(--accent-blue)' }} />
                        <div style={{ width: `${failedShare}%`, backgroundColor: 'var(--tag-orange)' }} />
                    </>
                )}
            </div>
            <div className="display-flex flex-col px-3 py-2" style={{ gap: '0.15rem' }}>
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <Icon icon={TableIcon} className="font-color-secondary flex-none" />
                    <span className="font-color-primary font-medium text-base truncate" title={stamp.table.title}>
                        Filling {stamp.table.title || 'table'}
                    </span>
                    <span className="font-color-secondary text-sm flex-none">
                        {done.toLocaleString('en-US')} of {total.toLocaleString('en-US')} rows
                    </span>
                    <div className="flex-1" />
                    <button
                        type="button"
                        className="table-card-head-action flex-none"
                        onClick={openTable}
                        title="Open the table in a Beaver tab"
                        aria-label="Open table"
                    >
                        <Icon icon={ArrowUpRightIcon} />
                    </button>
                    <Button
                        variant="ghost"
                        rightIcon={StopStrokeIcon}
                        ariaLabel="Stop the fill"
                        onClick={stop}
                        className="flex-none"
                        style={{ padding: '1px 4px' }}
                    >
                        Stop
                    </Button>
                </div>
                {(columns || detail || openMessage) && (
                    <div className="font-color-secondary text-sm truncate opacity-60" title={columns}>
                        {[openMessage || columns, detail].filter(Boolean).join(' · ')}
                    </div>
                )}
            </div>
        </div>
    );
};

export default TableFillProgressPanel;
