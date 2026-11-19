import React, { useCallback } from 'react';
import type { TableFillJobSnapshot, TableFillViewRequest } from '@beaver/agent-core/protocol/tableFillProtocol';
import { creditsText, failedRowsLink, progressLine, resultSummary } from '@beaver/agent-core/run-state/tableFillCopy';
import { getHost } from '@beaver/agent-ui/host';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { FillProgressRule } from '../tables/FillProgressRule';
import { ArrowUpRightIcon, StopStrokeIcon } from '../icons/icons';

interface TableFillReceiptProps {
    /** The fill as this renderer follows it, or as its stored result reads. */
    snapshot: TableFillJobSnapshot;
    /** The table's item id (`u-KEY`), when known. */
    tableKey: string | null;
    /** Stop the fill; absent when Stop is elsewhere (the composer) or the fill is not this device's. */
    onStop?: () => void;
}

/**
 * The fill a table tool call started, in the call's expanded row: what it is
 * doing or how it ended, the credits it charged, a link to the rows that
 * failed, and the table. Stop shows only for a fill this device runs that no
 * window waits on; while the chat waits on it, Stop is in the composer.
 */
export const TableFillReceipt: React.FC<TableFillReceiptProps> = ({ snapshot, tableKey, onStop }) => {
    const finished = snapshot.state === 'done';
    const result = finished ? snapshot.result : undefined;
    const failedRows = result?.failed_row_ids.length ?? 0;
    const line = finished ? { status: resultSummary(snapshot), failed: null } : progressLine(snapshot);
    const credits = snapshot.credits_charged > 0
        ? `${creditsText(snapshot.credits_charged)}${finished ? '' : ' so far'}`
        : null;

    const openTable = useCallback(
        async (event: React.SyntheticEvent, request?: TableFillViewRequest) => {
            if (!tableKey) return;
            const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
            // The host reports a table that cannot be opened.
            await getHost().navigation?.openTable?.(tableKey, origin, request ? { request } : undefined).catch(() => undefined);
        },
        [tableKey],
    );

    return (
        <div className="table-record text-sm table-fill-receipt" role="group" aria-label="Table fill">
            {!finished && <FillProgressRule job={snapshot} />}
            <div className="table-record-section">
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <div className="table-record-label flex-1">Fill</div>
                    {tableKey && (
                        <IconButton
                            icon={ArrowUpRightIcon}
                            variant="ghost-secondary"
                            ariaLabel="Open table"
                            title="Open table"
                            onClick={(event) => void openTable(event)}
                        />
                    )}
                    {onStop && !finished && (
                        <Button
                            variant="ghost"
                            rightIcon={StopStrokeIcon}
                            ariaLabel="Stop fill"
                            onClick={onStop}
                            disabled={snapshot.state === 'stopping'}
                            className="flex-none"
                            style={{ padding: '1px 4px' }}
                        >
                            Stop
                        </Button>
                    )}
                </div>
                <div className="font-color-primary">
                    {line.status}
                    {line.failed ? <span className="table-fill-receipt-warning"> · {line.failed}</span> : null}
                </div>
                {credits && <div className="font-color-secondary">{credits}</div>}
                {failedRows > 0 && tableKey && (
                    <button
                        type="button"
                        className="table-fill-receipt-link"
                        onClick={(event) =>
                            void openTable(event, {
                                kind: 'show_failed',
                                job_id: snapshot.job_id,
                                row_ids: result?.failed_row_ids ?? [],
                            })
                        }
                    >
                        {failedRowsLink(failedRows)}
                    </button>
                )}
            </div>
        </div>
    );
};

export default TableFillReceipt;
