import React, { useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getToolCallStatusFromResult, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { tableRecordFromMetadata } from '@beaver/agent-core/run-state/tableResults';
import { chatFillsAtom, fillForToolCall } from '@beaver/agent-core/run-state/tableChatFills';
import {
    fillCallLine,
    fillSnapshotFromResult,
    fillStateFromRecord,
    fillStateFromSnapshot,
    jobCallFillState,
    openJobCallsAtom,
    type FillCallState,
} from '@beaver/agent-core/run-state/jobCalls';
import { jobIdOf } from '@beaver/agent-core/protocol/jobCallProtocol';
import { TOOL_BASE_LABELS } from '@beaver/agent-core/run-state/toolCallRequest';
import { tableMessages } from './ToolResultView';
import { TableResultView } from './toolResultViews/TableResultView';
import { TableFillReceipt } from './TableFillReceipt';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    Spinner,
    TableIcon,
} from '../icons/icons';
import { toolExpandedAtom, setToolExpandedAtom } from '../../atoms/messageUIState';
import { chatFillTableKey, jobWaitAtom, stopChatFillAtom, waitedJobsAtom } from '../../atoms/jobWait';

interface TableToolCallViewProps {
    part: ToolCallPart;
    result: ToolResult | undefined;
    runId: string;
    responseIndex: number;
    runStatus: AgentRunStatus;
}

/** The table title the model asked for, while the call has not returned yet. */
function requestedTitle(part: ToolCallPart): string | null {
    const args = part.streaming_args ?? part.args;
    try {
        const parsed = typeof args === 'string' ? JSON.parse(args) : args;
        const title = (parsed as Record<string, unknown> | undefined)?.title;
        return typeof title === 'string' && title.trim() ? title : null;
    } catch {
        return null;
    }
}

/** The stream's past-tense line for a call that returned a record. */
function doneLabel(toolName: string): string | null {
    if (toolName === 'create_table') return 'Made the table';
    if (toolName === 'edit_table') return 'Edited the table';
    if (toolName === 'fill_table') return 'Filled the table';
    return null;
}

/**
 * A table write (`create_table`, `edit_table`, `fill_table`) as a plain line
 * in the run's timeline: when it happened, not what to do about it. The
 * receipt under the answer is where the table is opened, filled or undone.
 *
 * A call that fills the table puts the fill's state in its line, live or
 * parked alike: "Filling *title*: 45 of 150 papers", "Filled *title*: 147 of
 * 150 papers", "Filling *title* on *device*" for a fill another device runs.
 * Expanding shows the fill's receipt (with Stop for a fill this device runs
 * that no window waits on) and the call's summary as it was recorded. Status
 * notices (declined, partial, rejected rows) sit under the label.
 */
export const TableToolCallView: React.FC<TableToolCallViewProps> = ({
    part,
    result,
    runId,
    responseIndex,
    runStatus,
}) => {
    const status = getToolCallStatusFromResult(result, runStatus);
    const hasResult = result !== undefined;
    const isReturn = result?.part_kind === 'tool-return';
    const record = isReturn ? tableRecordFromMetadata(result.metadata) : null;
    const notices = isReturn ? tableMessages(result) : [];

    const expansionKey = `${runId}:${responseIndex}:${part.tool_call_id}`;
    const storedExpanded = useAtomValue(useMemo(() => toolExpandedAtom(expansionKey), [expansionKey]));
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    const isLive = isInProgress && runStatus === 'in_progress' && !hasResult;

    // The fill this call started: the job this renderer follows, the result
    // stored on the parked call, or the fill the returned record describes.
    const jobCall = useAtomValue(openJobCallsAtom).find((call) => call.tool_call_id === part.tool_call_id) ?? null;
    const fills = useAtomValue(chatFillsAtom);
    const fill = (jobCall ? fills.get(jobIdOf(jobCall)) : undefined) ?? fillForToolCall(fills, part.tool_call_id, runId);
    const recordFill = record?.run === 'fill' ? record.fill ?? null : null;
    const fillState: FillCallState | null = recordFill && recordFill.status !== 'running'
        ? fillStateFromRecord(recordFill)
        : jobCall && !hasResult
          ? jobCallFillState(jobCall, fill?.snapshot)
          : fill
            ? fillStateFromSnapshot(fill.snapshot)
            : recordFill
              ? { kind: 'started' }
              : null;
    // A fill known only to have started (Zotero restarted since) does not spin.
    const fillRunning = fillState?.kind === 'running' || fillState?.kind === 'elsewhere';

    // The receipt: the live job, else the stored result read as one.
    const receiptSnapshot = fill?.snapshot
        ?? (jobCall?.result && !hasResult ? fillSnapshotFromResult(jobCall.result, jobCall.state?.title) : null);
    const tableKey = record?.reference.key
        ?? jobCall?.state?.table
        ?? (fill ? chatFillTableKey(fill.snapshot) : null);
    // Stop is in the composer of the window that waits on the fill; the
    // receipt offers it only while no window waits.
    const jobWait = useAtomValue(jobWaitAtom);
    const waitedJobs = useAtomValue(waitedJobsAtom);
    const stopFill = useSetAtom(stopChatFillAtom);
    const waited = isLive || jobWait?.toolCallId === part.tool_call_id || (!!fill && waitedJobs.has(fill.snapshot.job_id));
    const canStop = !!fill && fill.snapshot.state !== 'done' && !waited;

    const canExpand = record !== null || receiptSnapshot !== null;
    const isExpanded = (storedExpanded ?? false) && canExpand;
    const toggleExpanded = () => {
        if (canExpand) setExpanded({ key: expansionKey, expanded: !isExpanded });
    };

    const isShimmering = fillRunning ? fillState?.kind === 'running' : isLive;
    const isFailed = status === 'error' || (isReturn && !record && notices.length > 0);
    const getIcon = () => {
        if (fillRunning) return Spinner;
        if (isExpanded) return ArrowDownIcon;
        if (isHovered && canExpand) return ArrowRightIcon;
        if (fillState?.kind === 'stopped' || fillState?.kind === 'interrupted') return AlertIcon;
        if (fillState) return TableIcon;
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (isFailed) return AlertIcon;
        return TableIcon;
    };
    const iconClassName = isFailed && !(isHovered && canExpand) && !isExpanded ? 'color-error' : undefined;

    // The line renders the call as recorded, title included; only a call
    // without a record falls back to the title the model asked for.
    const title = record
        ? (record.reference.title || 'Untitled table')
        : requestedTitle(part) ?? jobCall?.state?.title ?? fill?.snapshot.table.title ?? null;
    const line = fillState
        ? fillCallLine(fillState, title)
        : {
              label: (record && doneLabel(part.tool_name)) ?? TOOL_BASE_LABELS[part.tool_name] ?? 'Table',
              title,
              detail: null,
          };
    const progress = !fillState && isLive ? part.progress : undefined;

    return (
        <div
            id={`tool-${part.tool_call_id}`}
            className={`rounded-card flex flex-col min-w-0 ${isExpanded ? 'border-card mb-2' : 'border-transparent'}`}
        >
            <div className={`display-flex flex-row py-15 ${isExpanded ? 'bg-senary border-bottom-quinary' : ''}`}>
                <button
                    type="button"
                    className={`variant-ghost-secondary display-flex flex-row py-15 gap-2 flex-1 text-left min-w-0 ${canExpand ? 'cursor-pointer' : ''}`}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    aria-controls={`tool-result-${part.tool_call_id}`}
                    onClick={toggleExpanded}
                    disabled={!canExpand}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={getIcon()} className={iconClassName} />
                        </div>
                        <div className="display-flex flex-col min-w-0 gap-1">
                            <div className={`min-w-0 truncate${isShimmering ? ' shimmer-text' : ''}`}>
                                <span>{line.label}</span>
                                {line.title && <span className="font-color-secondary ml-15">{line.title}</span>}
                                {line.detail && <span className="font-color-secondary">{line.detail}</span>}
                            </div>
                            {progress && (
                                <span className={`font-color-tertiary text-sm${isInProgress ? ' shimmer-text' : ''}`}>{progress}</span>
                            )}
                            {notices.map((line, index) => (
                                <span key={index} role="status" className="font-color-secondary text-sm">
                                    {line}
                                </span>
                            ))}
                        </div>
                    </div>
                </button>
            </div>

            {isExpanded && (
                <div id={`tool-result-${part.tool_call_id}`} className="display-flex flex-col">
                    {receiptSnapshot && (!recordFill || recordFill.status === 'running') && (
                        <TableFillReceipt
                            snapshot={receiptSnapshot}
                            tableKey={tableKey}
                            onStop={canStop ? () => stopFill(fill!.snapshot.job_id) : undefined}
                        />
                    )}
                    {record && <TableResultView view={{ view_type: 'table', record }} />}
                </div>
            )}
        </div>
    );
};

export default TableToolCallView;
