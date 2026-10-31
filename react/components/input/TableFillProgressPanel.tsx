import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, dismissChatFillAtom, panelFill } from '@beaver/agent-core/run-state/tableChatFills';
import { resultText, runningLabel, timeLeftText } from '@beaver/agent-core/run-state/tableFillCopy';
import { getHost } from '@beaver/agent-ui/host';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { watchChatFills } from '../../atoms/tableChatFills';
import { ArrowUpRightIcon, CancelIcon, Icon, StopStrokeIcon, TableIcon } from '../icons/icons';

/**
 * A chat fill's progress above the composer: the table, rows done of the
 * total, rows failed so far, the time left, "Open table" and "Stop fill".
 *
 * It shows only in the thread whose run started the fill, and stays through
 * the end of that run, new messages and thread switches. Stop fill stops the
 * fill only; a response waiting on it carries on and reports what was filled.
 * When the fill ends the panel becomes its result line until dismissed, so a
 * fill running in the background never ends unnoticed. It follows the job's
 * snapshots, the same the table's tab follows.
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

    const openTable = useCallback(async (event: React.SyntheticEvent) => {
        if (!tableKey) return;
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        const open = getHost().navigation?.openTable;
        if (!open) return;
        const outcome = await open(tableKey, origin).catch(() => ({ error: 'Table provider unavailable.' }));
        setOpenMessage('error' in outcome ? outcome.error : '');
    }, [tableKey]);

    const stopFill = useCallback(() => {
        if (snapshot) Zotero.Beaver.tableFills?.stop(snapshot.job_id);
    }, [snapshot]);

    if (!fill || !snapshot) return null;
    const title = snapshot.table.title || 'table';
    const total = snapshot.rows_total;
    const done = snapshot.rows_done;
    const failed = snapshot.rows_failed;
    const finished = snapshot.state === 'done';
    const share = total > 0 ? (done / total) * 100 : 0;
    const failedShare = total > 0 ? (Math.min(failed, done) / total) * 100 : 0;
    const detail = finished
        ? resultText(snapshot)
        : snapshot.state === 'stopping'
          ? runningLabel(snapshot)
          : [failed > 0 ? `${failed.toLocaleString('en-US')} failed` : null, timeLeftText(snapshot.seconds_left)]
                .filter(Boolean)
                .join(' · ');

    return (
        <div
            className="composer-docked-bar batch-progress-bar border-bottom-quinary"
            style={{ position: 'relative' }}
            role="group"
            aria-label={finished ? 'Table fill result' : 'Table fill progress'}
        >
            {!finished && (
                <div
                    className="display-flex flex-row batch-progress-hairline"
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, overflow: 'hidden', pointerEvents: 'none' }}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                    aria-valuetext={`${done} of ${total} papers filled`}
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
            )}
            <div className="display-flex flex-col px-3 py-2" style={{ gap: '0.15rem' }}>
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <Icon icon={TableIcon} className="font-color-secondary flex-none" />
                    <span className="font-color-primary font-medium text-base truncate" title={snapshot.table.title}>
                        {finished ? title : `Filling ${title}`}
                    </span>
                    {!finished && (
                        <span className="font-color-secondary text-sm flex-none">
                            {done.toLocaleString('en-US')} of {total.toLocaleString('en-US')} papers
                        </span>
                    )}
                    <div className="flex-1" />
                    <Button
                        variant="ghost"
                        rightIcon={ArrowUpRightIcon}
                        ariaLabel="Open table"
                        onClick={openTable}
                        className="flex-none"
                        style={{ padding: '1px 4px' }}
                    >
                        Open table
                    </Button>
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
                            disabled={snapshot.state === 'stopping'}
                            className="flex-none"
                            style={{ padding: '1px 4px' }}
                        >
                            Stop fill
                        </Button>
                    )}
                </div>
                {(detail || openMessage) && (
                    <div className={`font-color-secondary text-sm truncate${finished ? '' : ' opacity-60'}`} title={detail}>
                        {[openMessage, detail].filter(Boolean).join(' · ')}
                    </div>
                )}
            </div>
        </div>
    );
};

export default TableFillProgressPanel;
