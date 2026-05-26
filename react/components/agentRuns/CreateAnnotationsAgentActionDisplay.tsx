import React, { useCallback, useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import {
    AgentAction,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    undoAgentActionAtom,
    setAgentActionsToErrorAtom,
    isCreateHighlightAnnotationsAgentAction,
    isCreateNoteAnnotationsAgentAction,
    CreateHighlightAnnotationsAgentAction,
    CreateNoteAnnotationsAgentAction,
} from '../../agents/agentActions';
import { AgentRun } from '../../agents/types';
import { CreatedAnnotation } from '../../types/agentActions/createAnnotations';
import {
    TickIcon,
    CancelIcon,
    ArrowUpRightIcon,
    Icon,
    Spinner,
    CheckmarkCircleIcon,
    AlertIcon,
    DeleteIcon,
    HighlighterIcon,
    NoteIcon,
} from '../icons/icons';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import {
    executeCreateHighlightAnnotationsAction,
    executeCreateNoteAnnotationsAction,
    undoCreateAnnotationsAction,
} from '../../utils/createAnnotationsActions';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { logger } from '../../../src/utils/logger';
import { textWithTrailingNoWrap } from '../../utils/textWithTrailingNoWrap';

type CreateAnnotationsAction =
    | CreateHighlightAnnotationsAgentAction
    | CreateNoteAnnotationsAgentAction;

interface CreateAnnotationsAgentActionDisplayProps {
    run: AgentRun;
    actions: AgentAction[];
}

type SummaryKind = 'highlight' | 'note';
type SummaryStatus = 'applied' | 'pending' | 'failed';

interface RowProps {
    kind: SummaryKind;
    status: SummaryStatus;
    count: number;
    actions: CreateAnnotationsAction[];
    runId: string;
}

function appliedCount(action: CreateAnnotationsAction): number {
    return Array.isArray(action.result_data?.created)
        ? action.result_data!.created.length
        : 0;
}

function failedCount(action: CreateAnnotationsAction): number {
    return Array.isArray(action.result_data?.failed)
        ? action.result_data!.failed.length
        : 0;
}

function proposedCount(action: CreateAnnotationsAction): number {
    return Array.isArray(action.proposed_data?.items)
        ? action.proposed_data.items.length
        : 0;
}

function pluralizeHighlights(count: number): string {
    return count === 1 ? 'Highlight' : 'Highlights';
}

function pluralizeNotes(count: number): string {
    return count === 1 ? 'Sticky Note' : 'Sticky Notes';
}

const SummaryRow: React.FC<RowProps> = ({ kind, status, count, actions, runId }) => {
    const [isBusy, setIsBusy] = useState(false);
    const [isHovered, setIsHovered] = useState(false);

    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);

    const isApplied = status === 'applied';
    const isFailed = status === 'failed';
    const noun = kind === 'highlight' ? pluralizeHighlights(count) : pluralizeNotes(count);
    const verb = isFailed ? 'Failed' : isApplied ? 'Created' : 'Create';
    const label = `${verb} ${count} ${noun}`;

    const firstCreatedRef: CreatedAnnotation | null = useMemo(() => {
        if (!isApplied) return null;
        for (const action of actions) {
            const created = action.result_data?.created;
            if (Array.isArray(created) && created.length > 0) {
                return created[0];
            }
        }
        return null;
    }, [actions, isApplied]);

    const handleReveal = useCallback(async () => {
        if (!firstCreatedRef) return;
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                firstCreatedRef.library_id,
                firstCreatedRef.zotero_key,
            );
            if (item) {
                await navigateToAnnotation(item as Zotero.Item);
            }
        } catch (err) {
            logger(`CreateAnnotationsAgentActionDisplay: reveal failed: ${err}`, 1);
        }
    }, [firstCreatedRef]);

    const handleApply = useCallback(async () => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            for (const action of actions) {
                try {
                    const result = isCreateHighlightAnnotationsAgentAction(action)
                        ? await executeCreateHighlightAnnotationsAction(action)
                        : await executeCreateNoteAnnotationsAction(action);
                    await ackAgentActions(runId, [{
                        action_id: action.id,
                        result_data: result,
                    }]);
                } catch (err: any) {
                    const errorMessage = err?.message ?? 'Failed to create annotations';
                    setAgentActionsToError([action.id], errorMessage, {
                        stack_trace: err?.stack ?? '',
                        error_name: err?.name,
                    });
                    logger(`CreateAnnotationsAgentActionDisplay: apply failed for ${action.id}: ${errorMessage}`, 1);
                }
            }
        } finally {
            setIsBusy(false);
        }
    }, [actions, ackAgentActions, isBusy, runId, setAgentActionsToError]);

    const handleDelete = useCallback(async () => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            for (const action of actions) {
                try {
                    await undoCreateAnnotationsAction(action);
                    undoAgentAction(action.id);
                } catch (err) {
                    logger(`CreateAnnotationsAgentActionDisplay: delete failed for ${action.id}: ${err}`, 1);
                }
            }
        } finally {
            setIsBusy(false);
        }
    }, [actions, isBusy, undoAgentAction]);

    const handleDismiss = useCallback(() => {
        for (const action of actions) {
            rejectAgentAction(action.id);
        }
    }, [actions, rejectAgentAction]);

    const getHeaderIcon = () => {
        if (isBusy) return Spinner;
        if (isFailed) return AlertIcon;
        if (isApplied) return CheckmarkCircleIcon;
        return kind === 'highlight' ? HighlighterIcon : NoteIcon;
    };

    const headerIconClassName = isFailed
        ? 'font-color-red scale-11'
        : isApplied
            ? 'font-color-green scale-11'
            : undefined;

    const titleClickable = isApplied && firstCreatedRef !== null;

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
            <div className="display-flex flex-row bg-senary items-start py-15 gap-1">
                <div
                    className={`display-flex flex-row ml-3 gap-2 min-w-0 ${titleClickable ? 'cursor-pointer' : ''}`}
                    onMouseEnter={() => titleClickable && setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    onClick={titleClickable ? handleReveal : undefined}
                >
                    <div className="display-flex mt-015" style={{ flexShrink: 0 }}>
                        <Icon icon={getHeaderIcon()} className={headerIconClassName} />
                    </div>
                    <div
                        className="min-w-0"
                        style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            wordBreak: 'break-word',
                        }}
                    >
                        <span
                            className={`font-medium ${isHovered ? 'font-color-primary' : 'font-color-primary'}`}
                            style={{ transition: 'color 0.15s ease' }}
                        >
                            {titleClickable
                                ? textWithTrailingNoWrap(
                                    label,
                                    <span
                                        className="font-color-secondary scale-10"
                                        style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer', marginLeft: '1px' }}
                                    >
                                        <Icon icon={ArrowUpRightIcon} />
                                    </span>,
                                )
                                : label}
                        </span>
                    </div>
                </div>

                <div className="flex-1" />

                <div className={`display-flex flex-row items-center gap-1 ${isApplied ? 'mr-2' : 'mr-3 mt-020'}`}>
                    {isApplied ? (
                        <Tooltip content={`Delete ${kind === 'highlight' ? 'highlights' : 'sticky notes'}`} showArrow singleLine>
                            <IconButton
                                icon={DeleteIcon}
                                variant="ghost-secondary"
                                onClick={handleDelete}
                                disabled={isBusy}
                                className="scale-90 mt-020"
                            />
                        </Tooltip>
                    ) : !isFailed ? (
                        <>
                            <Tooltip content="Dismiss" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-red"
                                    onClick={handleDismiss}
                                    disabled={isBusy}
                                />
                            </Tooltip>
                            <Tooltip content={`Create ${kind === 'highlight' ? 'highlights' : 'sticky notes'}`} showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-green scale-14"
                                    onClick={handleApply}
                                    disabled={isBusy}
                                />
                            </Tooltip>
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    );
};

/**
 * Summary display for bulk PDF annotation actions (create_highlight_annotations
 * and create_note_annotations) at the end of a completed run. Aggregates
 * applied, failed, and pending annotations across all batch actions and renders
 * one row per status × kind combination (e.g. "Created 4 Highlights").
 */
const CreateAnnotationsAgentActionDisplay: React.FC<CreateAnnotationsAgentActionDisplayProps> = ({ run, actions }) => {
    const buckets = useMemo(() => {
        const result: Record<`${SummaryStatus}-${SummaryKind}`, {
            count: number;
            actions: CreateAnnotationsAction[];
        }> = {
            'applied-highlight': { count: 0, actions: [] },
            'applied-note': { count: 0, actions: [] },
            'failed-highlight': { count: 0, actions: [] },
            'failed-note': { count: 0, actions: [] },
            'pending-highlight': { count: 0, actions: [] },
            'pending-note': { count: 0, actions: [] },
        };

        for (const action of actions) {
            const isHighlight = isCreateHighlightAnnotationsAgentAction(action);
            const isNote = isCreateNoteAnnotationsAgentAction(action);
            if (!isHighlight && !isNote) continue;

            const kind: SummaryKind = isHighlight ? 'highlight' : 'note';
            const typed = action as CreateAnnotationsAction;

            if (action.status === 'applied') {
                const created = appliedCount(typed);
                const failed = failedCount(typed);
                if (created > 0) {
                    const key = `applied-${kind}` as const;
                    result[key].count += created;
                    result[key].actions.push(typed);
                }
                if (created === 0 && failed > 0) {
                    const key = `failed-${kind}` as const;
                    result[key].count += failed;
                    result[key].actions.push(typed);
                }
            } else if (action.status === 'pending') {
                const n = proposedCount(typed);
                if (n > 0) {
                    const key = `pending-${kind}` as const;
                    result[key].count += n;
                    result[key].actions.push(typed);
                }
            }
        }

        return result;
    }, [actions]);

    const rows: Array<RowProps> = [];
    if (buckets['applied-highlight'].count > 0) {
        rows.push({
            kind: 'highlight',
            status: 'applied',
            count: buckets['applied-highlight'].count,
            actions: buckets['applied-highlight'].actions,
            runId: run.id,
        });
    }
    if (buckets['applied-note'].count > 0) {
        rows.push({
            kind: 'note',
            status: 'applied',
            count: buckets['applied-note'].count,
            actions: buckets['applied-note'].actions,
            runId: run.id,
        });
    }
    if (buckets['failed-highlight'].count > 0) {
        rows.push({
            kind: 'highlight',
            status: 'failed',
            count: buckets['failed-highlight'].count,
            actions: buckets['failed-highlight'].actions,
            runId: run.id,
        });
    }
    if (buckets['failed-note'].count > 0) {
        rows.push({
            kind: 'note',
            status: 'failed',
            count: buckets['failed-note'].count,
            actions: buckets['failed-note'].actions,
            runId: run.id,
        });
    }
    if (buckets['pending-highlight'].count > 0) {
        rows.push({
            kind: 'highlight',
            status: 'pending',
            count: buckets['pending-highlight'].count,
            actions: buckets['pending-highlight'].actions,
            runId: run.id,
        });
    }
    if (buckets['pending-note'].count > 0) {
        rows.push({
            kind: 'note',
            status: 'pending',
            count: buckets['pending-note'].count,
            actions: buckets['pending-note'].actions,
            runId: run.id,
        });
    }

    if (rows.length === 0) return null;

    return (
        <>
            {rows.map((row) => (
                <SummaryRow
                    key={`${row.status}-${row.kind}`}
                    {...row}
                />
            ))}
        </>
    );
};

export default CreateAnnotationsAgentActionDisplay;
