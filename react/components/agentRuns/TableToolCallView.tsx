import React, { useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getToolCallStatusFromResult, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { tableRecordFromMetadata } from '@beaver/agent-core/run-state/tableResults';
import { chatFillsAtom, fillForToolCall } from '@beaver/agent-core/run-state/tableChatFills';
import {
    fillStateFromRecord,
    fillStateFromSnapshot,
    jobCallFillState,
    openJobCallsAtom,
    tableCallLine,
    type FillCallState,
} from '@beaver/agent-core/run-state/jobCalls';
import { jobIdOf } from '@beaver/agent-core/protocol/jobCallProtocol';
import { tableMessages } from './ToolResultView';
import { TableResultView } from './toolResultViews/TableResultView';
import { getHost } from '@beaver/agent-ui/host';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    Spinner,
    TableIcon,
} from '../icons/icons';
import { toolExpandedAtom, setToolExpandedAtom } from '../../atoms/messageUIState';
import { chatFillTableKey } from '../../atoms/jobWait';

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

/**
 * A table write (`create_table`, `edit_table`, `fill_table`) as a line in
 * the run's timeline, headed like an action card: the tool's name, then the
 * table's title or the call's status (see `tableCallLine`). The receipt under
 * the answer is where the table is opened, filled or undone.
 *
 * A call that fills the table puts the fill's state in place of the title,
 * live or parked alike: "Fill Table: 45 of 150 items complete (3 failed)",
 * or "Fill Table: running" for a fill this device does not follow. A fill
 * that completed every item shows the title again. Until the call
 * returns, clicking the line opens the table, whose own Fill control can
 * stop the fill; once it returns, the line expands to the call's summary as
 * it was recorded. Status notices (declined, partial, rejected rows) sit
 * under the label.
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

    // The fill this call started: the job this renderer follows, or the fill
    // the returned record describes.
    const jobCall = useAtomValue(openJobCallsAtom).find((call) => call.tool_call_id === part.tool_call_id) ?? null;
    const fills = useAtomValue(chatFillsAtom);
    const fill = (jobCall ? fills.get(jobIdOf(jobCall)) : undefined) ?? fillForToolCall(fills, part.tool_call_id, runId);
    const recordFill = record?.run === 'fill' ? record.fill ?? null : null;
    const fillState: FillCallState | null = recordFill && recordFill.status !== 'running'
        ? fillStateFromRecord(recordFill)
        : jobCall && !hasResult
          ? jobCallFillState(fill?.snapshot)
          : fill
            ? fillStateFromSnapshot(fill.snapshot)
            : recordFill
              ? { kind: 'started' }
              : null;
    // A fill known only to have started (Zotero restarted since) does not spin.
    const fillRunning = fillState?.kind === 'running';

    const canExpand = record !== null;
    const isExpanded = (storedExpanded ?? false) && canExpand;
    // A fill whose call has not returned opens its table: its Fill control
    // shows the fill and can stop it.
    const openKey = !record && fillState ? (jobCall?.state?.table ?? (fill ? chatFillTableKey(fill.snapshot) : null)) : null;
    const canClick = canExpand || openKey !== null;
    const handleClick = (event: React.MouseEvent) => {
        if (canExpand) {
            setExpanded({ key: expansionKey, expanded: !isExpanded });
            return;
        }
        if (!openKey) return;
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        // The host reports a table that cannot be opened.
        void getHost().navigation?.openTable?.(openKey, origin)?.catch(() => undefined);
    };

    const isShimmering = fillRunning || isLive;
    const isFailed = status === 'error' || (isReturn && !record && notices.length > 0);
    const getIcon = () => {
        if (fillRunning) return Spinner;
        if (isExpanded) return ArrowDownIcon;
        if (isHovered && canClick) return ArrowRightIcon;
        if (fillState?.kind === 'stopped' || fillState?.kind === 'interrupted') return AlertIcon;
        if (fillState) return TableIcon;
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (isFailed) return AlertIcon;
        return TableIcon;
    };
    const iconClassName = isFailed && !(isHovered && canClick) && !isExpanded ? 'color-error' : undefined;

    // The line renders the call as recorded, title included; only a call
    // without a record falls back to the title the model asked for.
    const title = record
        ? (record.reference.title || 'Untitled table')
        : requestedTitle(part) ?? jobCall?.state?.title ?? fill?.snapshot.table.title ?? null;
    const line = tableCallLine(part.tool_name, fillState, title);
    const progress = !fillState && isLive ? part.progress : undefined;

    return (
        <div
            id={`tool-${part.tool_call_id}`}
            className={`rounded-card flex flex-col min-w-0 ${isExpanded ? 'border-card mb-2' : 'border-transparent'}`}
        >
            <div className={`display-flex flex-row py-15 ${isExpanded ? 'bg-senary border-bottom-quinary' : ''}`}>
                <button
                    type="button"
                    className={`variant-ghost-secondary display-flex flex-row py-15 gap-2 flex-1 text-left min-w-0 ${canClick ? 'cursor-pointer' : ''}`}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    aria-controls={`tool-result-${part.tool_call_id}`}
                    title={openKey ? 'Open table' : undefined}
                    onClick={handleClick}
                    disabled={!canClick}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={getIcon()} className={iconClassName} />
                        </div>
                        <div className="display-flex flex-col min-w-0 gap-1">
                            <div className={`min-w-0 truncate${isShimmering ? ' shimmer-text' : ''}`}>
                                <span className="font-color-primary font-medium">{line.label}</span>
                                {line.text && <span className="font-color-secondary ml-15">{line.text}</span>}
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
