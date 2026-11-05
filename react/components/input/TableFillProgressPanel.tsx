import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, dismissChatFillAtom, panelFill } from '@beaver/agent-core/run-state/tableChatFills';
import { failedRowsLink, progressLine, resultSummary, resultTone } from '@beaver/agent-core/run-state/tableFillCopy';
import type { TableFillViewRequest } from '@beaver/agent-core/protocol/tableFillProtocol';
import { getHost } from '@beaver/agent-ui/host';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { watchChatFills } from '../../atoms/tableChatFills';
import { openPreferencesWindow } from '../../ui/openPreferencesWindow';
import {
    AlertIcon,
    ArrowUpRightIcon,
    CancelIcon,
    CheckmarkCircleIcon,
    Icon,
    StopStrokeIcon,
    TableIcon,
} from '../icons/icons';

/**
 * A chat fill's progress above the composer, on two lines: which table and
 * what can be done about it (open it, Stop), then what is happening now.
 * The rule along the top edge is the run's shape: rows filled in blue, rows
 * that could not be read in orange, a sweep until the first row finishes.
 *
 * It shows only in the thread whose run started the fill, and stays through
 * the end of that run, new messages and thread switches. Stop stops the fill
 * only; a response waiting on it carries on and reports what was filled.
 * When the fill ends the rule goes, a glyph says how it ended, and line two
 * becomes its result until dismissed, so a fill running in the background
 * never ends unnoticed. The result is short: its cost is on the tool call
 * and in the table's banner. A result with failed rows links to them in the
 * table; one that ran out of credits links to adding more. It follows the job's snapshots,
 * the same the table's tab follows.
 */
const TableFillProgressPanel: React.FC = () => {
    useEffect(() => watchChatFills(), []);
    const fills = useAtomValue(chatFillsAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    const dismiss = useSetAtom(dismissChatFillAtom);
    const [openMessage, setOpenMessage] = useState('');
    const fill = panelFill(fills, threadId);
    const snapshot = fill?.snapshot ?? null;
    const libraryRef = snapshot ? libraryRefForLibraryID(snapshot.table.libraryID) : null;
    const tableKey = snapshot && libraryRef ? `${libraryRef}-${snapshot.table.key}` : null;

    const openTable = useCallback(
        async (event: React.SyntheticEvent, request?: TableFillViewRequest) => {
            if (!tableKey) return;
            const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
            const open = getHost().navigation?.openTable;
            if (!open) return;
            const outcome = await open(tableKey, origin, request ? { request } : undefined).catch(() => ({
                error: 'Table provider unavailable.',
            }));
            setOpenMessage('error' in outcome ? outcome.error : '');
        },
        [tableKey],
    );

    const stopFill = useCallback(() => {
        if (snapshot) Zotero.Beaver.tableFills?.stop(snapshot.job_id);
    }, [snapshot]);

    if (!fill || !snapshot) return null;
    const title = snapshot.table.title || 'Table';
    const total = snapshot.rows_total;
    const done = snapshot.rows_done;
    const finished = snapshot.state === 'done';
    const stopping = snapshot.state === 'stopping';
    const result = finished ? snapshot.result : undefined;
    const failedRows = result?.failed_row_ids.length ?? 0;
    const outOfCredits = result?.stopped_by === 'insufficient_credits';
    const tone = finished ? resultTone(snapshot) : null;
    const line = finished ? { status: resultSummary(snapshot), failed: null } : progressLine(snapshot);

    const share = total > 0 ? (done / total) * 100 : 0;
    const failedShare = total > 0 ? (Math.min(snapshot.rows_failed, done) / total) * 100 : 0;

    const glyph =
        tone === 'clean' ? (
            <Icon icon={CheckmarkCircleIcon} className="table-fill-progress-glyph font-color-green" />
        ) : tone === 'warning' ? (
            <Icon icon={AlertIcon} className="table-fill-progress-glyph table-fill-progress-warning" />
        ) : (
            <Icon icon={TableIcon} className="table-fill-progress-glyph font-color-secondary" />
        );

    return (
        <div
            className="composer-docked-bar batch-progress-bar border-bottom-quinary table-fill-progress"
            role="group"
            aria-label={finished ? 'Table fill result' : 'Table fill progress'}
        >
            {!finished && (
                <div
                    className={`table-fill-progress-rule${stopping ? ' table-fill-progress-rule-stopping' : ''}`}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                    aria-valuetext={`${done} of ${total} items filled`}
                >
                    {done === 0 && !stopping ? (
                        <div className="batch-progress-indeterminate" />
                    ) : (
                        <>
                            <span className="table-fill-progress-filled" style={{ width: `${share - failedShare}%` }} />
                            <span className="table-fill-progress-failed" style={{ width: `${failedShare}%` }} />
                        </>
                    )}
                </div>
            )}
            <div className="table-fill-progress-body">
                {glyph}
                <div className="table-fill-progress-head">
                    <span className="table-fill-progress-title text-base truncate" title={title}>
                        {title}
                    </span>
                    <IconButton
                        icon={ArrowUpRightIcon}
                        variant="ghost-secondary"
                        ariaLabel="Open table"
                        title="Open table"
                        onClick={(event) => void openTable(event)}
                    />
                    {finished ? (
                        <IconButton
                            icon={CancelIcon}
                            variant="ghost-secondary"
                            ariaLabel="Dismiss"
                            onClick={() => dismiss(snapshot.job_id)}
                        />
                    ) : (
                        <Button
                            variant="ghost"
                            rightIcon={StopStrokeIcon}
                            ariaLabel="Stop fill"
                            onClick={stopFill}
                            disabled={stopping}
                            className="flex-none"
                            style={{ padding: '1px 4px' }}
                        >
                            Stop
                        </Button>
                    )}
                </div>
                <div className="table-fill-progress-status text-sm">
                    <span className="table-fill-progress-text">
                        {openMessage ? `${openMessage} · ` : ''}
                        {line.status}
                        {line.failed ? <span className="table-fill-progress-warning"> · {line.failed}</span> : null}
                    </span>
                    {outOfCredits ? (
                        <button
                            type="button"
                            className="table-fill-progress-link"
                            onClick={() => openPreferencesWindow('billing')}
                        >
                            Add credits
                        </button>
                    ) : null}
                    {failedRows > 0 ? (
                        <button
                            type="button"
                            className="table-fill-progress-link"
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
                    ) : null}
                </div>
            </div>
        </div>
    );
};

export default TableFillProgressPanel;
