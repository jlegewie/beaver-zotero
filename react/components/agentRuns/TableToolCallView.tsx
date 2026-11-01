import React, { useCallback, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getToolCallStatusFromResult, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { tableRecordFromMetadata } from '@beaver/agent-core/run-state/tableResults';
import { chatFillsAtom, fillForToolCall, fillStatusLine } from '@beaver/agent-core/run-state/tableChatFills';
import { resultText } from '@beaver/agent-core/run-state/tableFillCopy';
import { TOOL_BASE_LABELS } from '@beaver/agent-core/run-state/toolCallRequest';
import { parseItemReference, UNRESOLVED_LIBRARY_ID } from '@beaver/agent-core/identity/libraryRef';
import { getHost } from '@beaver/agent-ui/host';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { tableMessages } from './ToolResultView';
import { TableResultView } from './toolResultViews/TableResultView';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
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
 * A table write (`create_table`, `edit_table`, `fill_table`) as a card in the
 * run, shaped like the agent-action cards for notes: a bordered header with
 * the tool label and the table title, an open link on the right, and a body
 * with the call's summary above Reveal / Open buttons.
 *
 * The card starts collapsed: the table itself opens in a background tab when
 * it is created, so the summary is there on demand rather than in the way of
 * the answer. Status notices (declined, partial, rejected rows) sit under the title
 * so they read without expanding.
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
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const canExpand = record !== null;
    const isExpanded = (expansionState[expansionKey] ?? false) && canExpand;
    const toggleExpanded = () => {
        if (canExpand) setExpanded({ key: expansionKey, expanded: !isExpanded });
    };

    const [isHovered, setIsHovered] = useState(false);
    const [openMessage, setOpenMessage] = useState('');
    const tableKey = record?.reference.key ?? null;

    // The table opens beside the surface that was clicked, so the origin comes
    // from the clicked element rather than the newest window.
    const handleOpen = useCallback(async (event: React.SyntheticEvent) => {
        if (!tableKey) return;
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        const open = getHost().navigation?.openTable;
        if (!open) {
            setOpenMessage('Table provider unavailable.');
            return;
        }
        const outcome = await open(tableKey, origin, { onDownload: () => setOpenMessage('Downloading table…') })
            .catch(() => ({ error: 'Table provider unavailable.' }));
        setOpenMessage('error' in outcome ? outcome.error : (outcome.warning ?? ''));
    }, [tableKey]);

    const handleReveal = useCallback(() => {
        const parsed = tableKey ? parseItemReference(tableKey) : null;
        if (!parsed) return;
        getHost().navigation?.revealInLibrary({
            library_id: parsed.library_id ?? UNRESOLVED_LIBRARY_ID,
            library_ref: parsed.library_ref,
            zotero_key: parsed.zotero_key,
        });
    }, [tableKey]);

    // Undo of an `edit_table` call: the version it committed, while the
    // table is as it left it. Once used, the button gives way to what
    // happened.
    const [undoState, setUndoState] = useState<'idle' | 'working' | 'done'>('idle');
    const canUndo =
        part.tool_name === 'edit_table' && !!record?.edits?.length && typeof record?.version === 'number' && !!getHost().navigation?.undoTableEdit;
    const handleUndo = useCallback(async (event: React.SyntheticEvent) => {
        const undo = getHost().navigation?.undoTableEdit;
        if (!tableKey || !undo || typeof record?.version !== 'number') return;
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        setUndoState('working');
        const outcome = await undo(tableKey, { version: record.version, runId }, origin)
            .catch(() => ({ error: 'Table provider unavailable.' }));
        // A refusal keeps the button: a running fill may end, and a refused
        // Undo is refused again without harm.
        setUndoState('error' in outcome ? 'idle' : 'done');
        setOpenMessage('error' in outcome ? outcome.error : 'Undone. The table is back to the version before this edit.');
    }, [tableKey, record?.version, runId]);

    const isInProgress = status === 'in_progress';
    const isShimmering = isInProgress && !hasResult && runStatus === 'in_progress';
    const isFailed = status === 'error' || (isReturn && !record && notices.length > 0);
    const getIcon = () => {
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (isHovered && canExpand) return isExpanded ? ArrowDownIcon : ArrowRightIcon;
        if (isFailed) return AlertIcon;
        return TableIcon;
    };
    const iconClassName = isFailed && !(isHovered && canExpand) ? 'color-error' : undefined;

    const label = TOOL_BASE_LABELS[part.tool_name] ?? 'Table';
    // The card renders the call as recorded, title included; only a call
    // without a record falls back to the title the model asked for.
    const title = record
        ? (record.reference.title || 'Untitled table')
        : requestedTitle(part);
    // A fill shows a status line, never live counts: those are in the panel
    // above the composer. While the call waits on its fill, "Filling 46
    // papers…"; once it returned `running`, "Filling in the background".
    const fills = useAtomValue(chatFillsAtom);
    const fill = fillForToolCall(fills, part.tool_call_id, runId);
    const waitingOnFill = isInProgress && runStatus === 'in_progress' && !hasResult && fill !== null && fill.snapshot.state !== 'done';
    // A fill that went on in the background reads as finished once its live
    // job has ended.
    const backgroundDone = fill?.snapshot.state === 'done' ? resultText(fill.snapshot) : null;
    const progress = waitingOnFill
        ? fillStatusLine('waiting', fill!.snapshot.rows_total)
        : record?.run === 'fill' && record.fill?.status === 'running'
          ? backgroundDone ?? fillStatusLine(fill ? 'background' : 'started')
          : isInProgress && runStatus === 'in_progress' ? part.progress : undefined;
    const statusLines = [openMessage, ...notices].filter(Boolean);

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
                                <span className={`font-color-tertiary${isInProgress ? ' shimmer-text' : ''}`}>{progress}</span>
                            )}
                            {statusLines.map((line, index) => (
                                <span key={index} role="status" className="font-color-secondary text-sm">
                                    {line}
                                </span>
                            ))}
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
                </div>
            </div>

            {isExpanded && record && (
                <div id={`tool-result-${part.tool_call_id}`} className="display-flex flex-col">
                    <TableResultView view={{ view_type: 'table', record }} />
                    <div className="display-flex flex-row items-center gap-2 px-2 py-2">
                        {canUndo && undoState !== 'done' && (
                            <Button
                                variant="ghost-secondary"
                                onClick={handleUndo}
                                disabled={undoState === 'working'}
                                className="flex-none whitespace-nowrap"
                            >
                                Undo
                            </Button>
                        )}
                        <div className="flex-1" />
                        <Button variant="outline" onClick={handleReveal} className="flex-none whitespace-nowrap">
                            Reveal
                        </Button>
                        <Button variant="outline" onClick={handleOpen} className="flex-none whitespace-nowrap">
                            Open table
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TableToolCallView;
