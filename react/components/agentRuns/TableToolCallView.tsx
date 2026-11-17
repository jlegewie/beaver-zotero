import React, { useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getToolCallStatusFromResult, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { tableRecordFromMetadata } from '@beaver/agent-core/run-state/tableResults';
import { chatFillsAtom, fillForToolCall } from '@beaver/agent-core/run-state/tableChatFills';
import { openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { TOOL_BASE_LABELS } from '@beaver/agent-core/run-state/toolCallRequest';
import { tableMessages } from './ToolResultView';
import { TableResultView } from './toolResultViews/TableResultView';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    Spinner,
    TableIcon,
} from '../icons/icons';
import { toolExpandedAtom, setToolExpandedAtom } from '../../atoms/messageUIState';

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

/** The line of a call whose fill is running, or finished and waiting to continue. */
const FILL_STATE_LABELS = {
    running: 'Filling the table',
    finished: 'Filled the table',
    stopped: 'Stopped filling the table',
} as const;

/** The stream's past-tense line for a call that returned a record. */
function doneLabel(toolName: string, fillRunning: boolean, fillStopped = false): string | null {
    if (toolName === 'create_table') return 'Made the table';
    if (toolName === 'edit_table') return 'Edited the table';
    if (toolName === 'fill_table') return fillRunning ? 'Started filling' : fillStopped ? FILL_STATE_LABELS.stopped : 'Filled the table';
    return null;
}

/**
 * A table write (`create_table`, `edit_table`, `fill_table`) as a plain line
 * in the run's timeline: when it happened, not what to do about it. The
 * receipt under the answer is where the table is opened, filled or undone,
 * so the line carries no actions of its own and does not compete with it.
 *
 * Status notices (declined, partial, rejected rows) and a fill's status sit
 * under the label so they read without expanding; expanding shows the
 * call's summary as it was recorded.
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
    const canExpand = record !== null;
    const isExpanded = (storedExpanded ?? false) && canExpand;
    const toggleExpanded = () => {
        if (canExpand) setExpanded({ key: expansionKey, expanded: !isExpanded });
    };

    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    // A fill the call waits on, live or parked as a job call. The line says
    // which state it is in, in one line; live counts are in the job bar.
    const jobCall = useAtomValue(openJobCallsAtom).find((call) => call.tool_call_id === part.tool_call_id);
    const fills = useAtomValue(chatFillsAtom);
    const fill = fillForToolCall(fills, part.tool_call_id, runId);
    const waitingOnFill = isInProgress && runStatus === 'in_progress' && !hasResult && fill !== null && fill.snapshot.state !== 'done';
    const fillRunning = record?.run === 'fill' && record.fill?.status === 'running';
    // A fill that went on without the call waiting for it (a message moved
    // the chat on, or an older backend): its live job says how it is going.
    const backgroundState = fillRunning
        ? fill?.snapshot.state === 'done'
            ? fill.snapshot.result?.stopped_by ? 'stopped' : 'finished'
            : fill ? 'running' : null
        : null;
    const fillState: 'running' | 'finished' | 'stopped' | null = jobCall && !hasResult
        ? jobCall.result
            ? jobCall.result.kind === 'table_fill' && jobCall.result.result.stopped_by ? 'stopped' : 'finished'
            : 'running'
        : waitingOnFill ? 'running' : backgroundState;
    const isShimmering = isInProgress && !hasResult && runStatus === 'in_progress';
    const isFailed = status === 'error' || (isReturn && !record && notices.length > 0);
    const getIcon = () => {
        if (fillState === 'stopped') return AlertIcon;
        if (fillState === 'finished') return TableIcon;
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (isExpanded) return ArrowDownIcon;
        if (isHovered && canExpand) return ArrowRightIcon;
        if (isFailed) return AlertIcon;
        return TableIcon;
    };
    const iconClassName = isFailed && !(isHovered && canExpand) && !isExpanded ? 'color-error' : undefined;

    const label = (fillState && FILL_STATE_LABELS[fillState])
        ?? (record && doneLabel(part.tool_name, fillRunning, !!record.fill?.stopped_by))
        ?? TOOL_BASE_LABELS[part.tool_name]
        ?? 'Table';
    // The line renders the call as recorded, title included; only a call
    // without a record falls back to the title the model asked for.
    const title = record
        ? (record.reference.title || 'Untitled table')
        : requestedTitle(part) ?? (jobCall?.state as { title?: string } | undefined)?.title ?? null;
    // One line: the label carries the fill's state. A background fill this
    // renderer no longer follows (Zotero restarted since) says it started.
    const progress = fillState || fillRunning
        ? undefined
        : isInProgress && runStatus === 'in_progress' ? part.progress : undefined;

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
                                <span>{label}</span>
                                {title && <span className="font-color-secondary ml-15">{title}</span>}
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

            {isExpanded && record && (
                <div id={`tool-result-${part.tool_call_id}`} className="display-flex flex-col">
                    <TableResultView view={{ view_type: 'table', record }} />
                </div>
            )}
        </div>
    );
};

export default TableToolCallView;
