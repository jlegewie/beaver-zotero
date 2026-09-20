import React, { useCallback, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getToolCallStatusFromResult, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { tableRecordFromMetadata, tableResultMessages } from '@beaver/agent-core/run-state/tableResults';
import { TOOL_BASE_LABELS } from '@beaver/agent-core/run-state/toolCallRequest';
import { getHost } from '@beaver/agent-ui/host';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { ToolResultView } from './ToolResultView';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
    ChevronIcon,
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

/**
 * A table write (`create_table`, `edit_rows`, `edit_table`, `fill_table`) as a
 * card in the run, shaped like the agent-action cards for notes: a bordered
 * header carrying the tool label and the table title, an open control beside
 * the fold toggle, and a body with the call's summary and any recovery notice.
 *
 * The header opens the current snapshot through the navigation host; the body
 * is the ordinary tool-result view, so the outcome copy is defined once.
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
    const record = result?.part_kind === 'tool-return' ? tableRecordFromMetadata(result.metadata) : null;
    const notices = hasResult ? tableResultMessages(result.content) : [];

    const expansionKey = `${runId}:${responseIndex}:${part.tool_call_id}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);

    // Both the summary and a recovery notice are short and actionable, so the
    // card opens on arrival like a created note does; the user may fold it.
    const canExpand = result?.part_kind === 'tool-return' && (record !== null || notices.length > 0);
    const isExpanded = (expansionState[expansionKey] ?? canExpand) && canExpand;
    const toggleExpanded = () => {
        if (canExpand) setExpanded({ key: expansionKey, expanded: !isExpanded });
    };

    const [isHovered, setIsHovered] = useState(false);
    const [openMessage, setOpenMessage] = useState('');
    const tableKey = record?.reference.key ?? null;
    const handleOpen = useCallback(async () => {
        if (!tableKey) return;
        const open = getHost().navigation?.openTable;
        if (!open) {
            setOpenMessage('Table provider unavailable.');
            return;
        }
        const outcome = await open(tableKey).catch(() => ({ error: 'Table provider unavailable.' }));
        setOpenMessage('error' in outcome ? outcome.error : (outcome.warning ?? ''));
    }, [tableKey]);

    const isInProgress = status === 'in_progress';
    const isShimmering = isInProgress && !hasResult && runStatus === 'in_progress';
    const getIcon = () => {
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (isHovered && canExpand) return isExpanded ? ArrowDownIcon : ArrowRightIcon;
        if (status === 'error') return AlertIcon;
        return TableIcon;
    };
    const iconClassName = status === 'error' && !(isHovered && canExpand) ? 'color-error' : undefined;

    const label = TOOL_BASE_LABELS[part.tool_name] ?? 'Table';
    // A returned record always names its table, even when the stored title is
    // empty; only a call still in flight falls back to the requested title.
    const title = record ? (record.reference.title || 'Untitled table') : requestedTitle(part);
    const progress = isInProgress && runStatus === 'in_progress' ? part.progress : undefined;

    return (
        <div
            id={`tool-${part.tool_call_id}`}
            className="agent-action-view rounded-card flex flex-col min-w-0 border-card mb-2"
        >
            <div className={`display-flex flex-row py-15 bg-senary items-start ${isExpanded ? 'border-bottom-quinary' : ''}`}>
                <button
                    type="button"
                    className={`variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015 min-w-0 ${canExpand ? 'cursor-pointer' : ''}`}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    aria-controls={`tool-result-${part.tool_call_id}`}
                    onClick={toggleExpanded}
                    disabled={!canExpand}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row ml-3 gap-2 min-w-0">
                        <div className="flex-1 display-flex mt-010 font-color-primary">
                            <Icon icon={getIcon()} className={iconClassName} />
                        </div>
                        <div className="display-flex flex-col min-w-0 gap-1">
                            <div className={`two-line-header${isShimmering ? ' shimmer-text' : ''}`}>
                                <span className="font-color-primary font-medium">{label}</span>
                                {title && <span className="font-color-secondary ml-15">{title}</span>}
                            </div>
                            {progress && (
                                <span className="font-color-tertiary shimmer-text">{progress}</span>
                            )}
                            {openMessage && (
                                <span role="status" className="font-color-tertiary">{openMessage}</span>
                            )}
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                {/* Siblings of the header button, not children: a control nested
                    in a native button is neither focusable nor keyboard-activable. */}
                <div className="display-flex flex-row items-center gap-25 mr-2 mt-015">
                    {tableKey && (
                        <Tooltip content="Open table" showArrow singleLine>
                            <IconButton
                                icon={ArrowUpRightIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-secondary scale-10"
                                onClick={handleOpen}
                                ariaLabel="Open table"
                            />
                        </Tooltip>
                    )}
                    {canExpand && (
                        <Tooltip content={isExpanded ? 'Collapse' : 'Expand'} showArrow singleLine>
                            <IconButton
                                icon={ChevronIcon}
                                variant="ghost-secondary"
                                iconClassName="scale-12"
                                onClick={toggleExpanded}
                                ariaLabel={isExpanded ? 'Collapse' : 'Expand'}
                            />
                        </Tooltip>
                    )}
                </div>
            </div>

            {isExpanded && result?.part_kind === 'tool-return' && (
                <div id={`tool-result-${part.tool_call_id}`}>
                    <ToolResultView result={result} />
                </div>
            )}
        </div>
    );
};

export default TableToolCallView;
