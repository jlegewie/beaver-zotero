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
} from '../../../agents/agentActions';
import { AgentRun } from '../../../agents/types';
import {
    CancelIcon,
    Icon,
    Spinner,
    CheckmarkCircleIcon,
    HighlighterIcon,
    NoteIcon,
    ArrowDownIcon,
    ArrowRightIcon,
} from '../../../components/icons/icons';
import IconButton from '../../../components/ui/IconButton';
import Tooltip from '../../../components/ui/Tooltip';
import Button from '../../../components/ui/Button';
import CreateAnnotationsPreview from './CreateAnnotationsPreview';
import {
    executeCreateHighlightAnnotationsAction,
    executeCreateNoteAnnotationsAction,
    undoCreateAnnotationsAction,
} from '../../../utils/createAnnotationsActions';
import { logger } from '../../../../src/utils/logger';

type CreateAnnotationsAction =
    | CreateHighlightAnnotationsAgentAction
    | CreateNoteAnnotationsAgentAction;

type SummaryKind = 'highlight' | 'note';
type SummaryStatus = 'applied' | 'pending';

interface CreateAnnotationsAgentActionDisplayProps {
    run: AgentRun;
    actions: AgentAction[];
}

interface GroupProps {
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

function proposedCount(action: CreateAnnotationsAction): number {
    return Array.isArray(action.proposed_data?.items)
        ? action.proposed_data.items.length
        : 0;
}

function nounFor(kind: SummaryKind, count: number): string {
    if (kind === 'highlight') return count === 1 ? 'Highlight' : 'Highlights';
    return count === 1 ? 'Sticky Note' : 'Sticky Notes';
}

const CreateAnnotationsGroup: React.FC<GroupProps> = ({
    kind,
    status,
    count,
    actions,
    runId,
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'dismiss' | 'undo' | 'apply' | null>(null);

    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);

    const isApplied = status === 'applied';
    const label = `${isApplied ? 'Created' : 'Create'} ${count} ${nounFor(kind, count)}`;

    const toggleExpanded = useCallback(() => {
        if (isProcessing) return;
        setIsExpanded((prev) => !prev);
    }, [isProcessing]);

    const handleDismissAll = useCallback(() => {
        if (isProcessing) return;
        setClickedButton('dismiss');
        for (const action of actions) {
            rejectAgentAction(action.id);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [actions, isProcessing, rejectAgentAction]);

    const handleDeleteAll = useCallback(async () => {
        if (isProcessing) return;
        setIsProcessing(true);
        setClickedButton('undo');
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
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [actions, isProcessing, undoAgentAction]);

    const handleApplyAll = useCallback(async () => {
        if (isProcessing) return;
        setIsProcessing(true);
        setClickedButton('apply');
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
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [actions, ackAgentActions, isProcessing, runId, setAgentActionsToError]);

    const headerIcon = (() => {
        if (isProcessing) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (isApplied) return CheckmarkCircleIcon;
        return kind === 'highlight' ? HighlighterIcon : NoteIcon;
    })();
    const headerIconClassName = !isProcessing && !isHovered && isApplied
        ? 'font-color-green scale-11'
        : undefined;

    const showHeaderActions = !isExpanded && !isProcessing;

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
            <div
                className={`display-flex flex-row py-15 bg-senary items-start ${isExpanded ? 'border-bottom-quinary' : ''}`}
            >
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015"
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    onClick={toggleExpanded}
                    disabled={isProcessing}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row ml-3 gap-2">
                        <div className="flex-1 display-flex mt-010 font-color-primary">
                            <Icon icon={headerIcon} className={headerIconClassName} />
                        </div>
                        <div className="display-flex">
                            <span className="font-color-primary font-medium">{label}</span>
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                {showHeaderActions && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        <Tooltip content="Dismiss" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                onClick={handleDismissAll}
                                disabled={isProcessing}
                            />
                        </Tooltip>
                    </div>
                )}
            </div>

            {isExpanded && (
                <div className="display-flex flex-col">
                    <div className="display-flex flex-col">
                        {actions.map((action, idx) => (
                            <div
                                key={action.id}
                                className={idx > 0 ? 'border-top-quinary' : undefined}
                            >
                                <CreateAnnotationsPreview
                                    kind={kind}
                                    actionData={action.proposed_data as any}
                                    resultData={action.result_data as any}
                                    status={action.status as any}
                                />
                            </div>
                        ))}
                    </div>

                    <div className="display-flex flex-row gap-2 px-2 py-2">
                        <div className="flex-1" />
                        <Button
                            variant="outline"
                            onClick={handleDismissAll}
                            disabled={isProcessing}
                            loading={isProcessing && clickedButton === 'dismiss'}
                        >
                            Dismiss
                        </Button>
                        {isApplied ? (
                            <Button
                                variant="outline"
                                onClick={handleDeleteAll}
                                disabled={isProcessing}
                                loading={isProcessing && clickedButton === 'undo'}
                            >
                                Delete All
                            </Button>
                        ) : (
                            <Button
                                variant="solid"
                                onClick={handleApplyAll}
                                disabled={isProcessing}
                                loading={isProcessing && clickedButton === 'apply'}
                            >
                                Apply All
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Summary display for bulk PDF annotation actions (create_highlight_annotations
 * and create_note_annotations) at the end of a completed run. Aggregates
 * applied + pending annotations per kind and renders one expandable card per
 * status × kind bucket (e.g. "Created 4 Highlights"). Each card reuses
 * CreateAnnotationsPreview for the per-item list when expanded.
 */
const CreateAnnotationsAgentActionDisplay: React.FC<CreateAnnotationsAgentActionDisplayProps> = ({
    run,
    actions,
}) => {
    const buckets = useMemo(() => {
        const result: Record<`${SummaryStatus}-${SummaryKind}`, {
            count: number;
            actions: CreateAnnotationsAction[];
        }> = {
            'applied-highlight': { count: 0, actions: [] },
            'applied-note': { count: 0, actions: [] },
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
                const n = appliedCount(typed);
                if (n > 0) {
                    const key = `applied-${kind}` as const;
                    result[key].count += n;
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

    const groups: GroupProps[] = [];
    for (const status of ['applied', 'pending'] as const) {
        for (const kind of ['highlight', 'note'] as const) {
            const bucket = buckets[`${status}-${kind}`];
            if (bucket.count > 0) {
                groups.push({
                    kind,
                    status,
                    count: bucket.count,
                    actions: bucket.actions,
                    runId: run.id,
                });
            }
        }
    }

    if (groups.length === 0) return null;

    return (
        <>
            {groups.map((group) => (
                <CreateAnnotationsGroup
                    key={`${group.status}-${group.kind}`}
                    {...group}
                />
            ))}
        </>
    );
};

export default CreateAnnotationsAgentActionDisplay;
