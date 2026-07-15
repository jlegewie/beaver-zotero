import React from 'react';
import { AgentRunStatus, ToolCallPart } from '../../../agents/types';
import {
    AlertIcon,
    ArrowUpRightIcon,
    CancelIcon,
    EditIcon,
    Icon,
    RepeatIcon,
    Spinner,
    TickIcon,
    UndoIcon,
} from '../../../components/icons/icons';
import IconButton from '../../../components/ui/IconButton';
import Tooltip from '../../../components/ui/Tooltip';
import { ActionPreview } from './ActionPreview';
import { useEditNoteActions } from './useEditNoteActions';
import type { EditNoteRowDescriptor } from '../../../components/agentRuns/editNoteShared';
import { buildBatchRowPreviewData } from './editNoteBatchPreviewData';

interface EditNoteRowViewProps {
    part: ToolCallPart;
    runId: string;
    runStatus: AgentRunStatus;
    disabled?: boolean;
    externalUndoError?: string | null;
    onUndoErrorChange?: (toolcallId: string, error: string | null) => void;
    /**
     * Present when this row renders a single edit within an edit_note_batch
     * action's edits[] rather than a v1 (single-edit) part. Drives the
     * preview from the edit's own fields and suppresses per-row action
     * buttons, since a batch applies/undoes atomically at the group level.
     */
    rowDescriptor?: EditNoteRowDescriptor;
}

export const EditNoteRowView: React.FC<EditNoteRowViewProps> = ({
    part,
    runId,
    runStatus,
    disabled = false,
    externalUndoError = null,
    onUndoErrorChange,
    rowDescriptor,
}) => {
    const {
        actions,
        previewData: hookPreviewData,
        previewStatus,
        previewIsStreaming,
        isProcessing,
        isStreamingPlaceholder,
        config,
        clickedButton,
        displayedUndoError,
        showApply: hookShowApply,
        showReject: hookShowReject,
        showUndo: hookShowUndo,
        showRetry: hookShowRetry,
        handleApprove,
        handleReject,
        handleApplyPending,
        handleRejectPending,
        handleUndo,
        handleRetry,
    } = useEditNoteActions({
        part,
        runId,
        runStatus,
        externalUndoError,
        onUndoErrorChange,
    });

    const isBatchRow = rowDescriptor !== undefined;
    const previewData = isBatchRow
        ? buildBatchRowPreviewData(hookPreviewData, rowDescriptor)
        : hookPreviewData;

    // A batch (edit_note_batch) is applied/undone atomically for the whole
    // action — only the group-level Apply All / Undo All / Retry All buttons
    // may act, so per-row controls are suppressed for a batch row.
    const showApply = !isBatchRow && hookShowApply;
    const showReject = !isBatchRow && hookShowReject;
    const showUndo = !isBatchRow && hookShowUndo;
    const showRetry = !isBatchRow && hookShowRetry;

    const actionButtonsDisabled = disabled || isProcessing;
    const onApply = previewStatus === 'awaiting' ? handleApprove : handleApplyPending;
    const onReject = previewStatus === 'awaiting' ? handleReject : handleRejectPending;

    return (
        <div className="agent-action-view rounded-md flex flex-col min-w-0">
            <div className="display-flex flex-row min-w-0">
                <div className="display-flex flex-col items-center gap-25 px-2 py-2 flex-shrink-0" style={{ marginLeft: '0.225rem' }}>
                    {isStreamingPlaceholder ? (
                        <div className="display-flex items-center mt-010">
                            <Spinner size={13} className="font-color-secondary scale-10" style={{ marginLeft: '0.185rem' }} />
                        </div>
                    ) : (
                        config.icon && config.icon !== Spinner ? (
                            <div className="display-flex items-center mt-010">
                                <Icon icon={config.icon} className={`${config.iconClassName}`} style={{ transform: 'scale(1)' }} />
                            </div>
                        ) : (
                            <div className="display-flex items-center mt-010 scale-10">
                                <Icon icon={EditIcon} className="font-color-secondary opacity-0" />
                            </div>
                        )
                    )}
                </div>

                <div className="flex-1 min-w-0">
                    {previewData ? (
                        <ActionPreview
                            toolName={isBatchRow ? 'edit_note_batch' : 'edit_note'}
                            previewData={previewData}
                            status={previewStatus}
                            actions={actions}
                            isStreaming={previewIsStreaming}
                        />
                    ) : (
                        <div className="px-3 py-2" style={{ minHeight: '1.4em' }} aria-hidden />
                    )}
                </div>

                <div className="display-flex flex-col gap-25 py-2 mr-2">
                    {/* A batch row never shows action buttons or its own processing
                        spinner — the whole edit_note_batch action applies/undoes
                        atomically via the group's Apply All / Undo All / Retry All. */}
                    {!isBatchRow && (isProcessing ? (
                        <>
                            {clickedButton === 'approve' && (
                                <Tooltip content="Apply" showArrow singleLine>
                                    <IconButton
                                        icon={TickIcon}
                                        variant="ghost-secondary"
                                        iconClassName="font-color-secondary scale-12"
                                        onClick={() => {}}
                                        loading={true}
                                        disabled={true}
                                    />
                                </Tooltip>
                            )}
                            {clickedButton === 'reject' && (
                                <Tooltip content="Reject" showArrow singleLine>
                                    <IconButton
                                        icon={CancelIcon}
                                        variant="ghost-secondary"
                                        iconClassName="font-color-secondary scale-90"
                                        onClick={() => {}}
                                        loading={true}
                                        disabled={true}
                                    />
                                </Tooltip>
                            )}
                            {clickedButton === 'undo' && (
                                <Tooltip content="Undo" showArrow singleLine>
                                    <IconButton
                                        icon={UndoIcon}
                                        variant="ghost-secondary"
                                        iconClassName="font-color-secondary scale-10"
                                        onClick={() => {}}
                                        loading={true}
                                        disabled={true}
                                    />
                                </Tooltip>
                            )}
                            {clickedButton === 'retry' && (
                                <Tooltip content="Try again" showArrow singleLine>
                                    <IconButton
                                        icon={RepeatIcon}
                                        variant="ghost-secondary"
                                        iconClassName="font-color-secondary scale-90"
                                        onClick={() => {}}
                                        loading={true}
                                        disabled={true}
                                    />
                                </Tooltip>
                            )}
                        </>
                    ) : (
                        <>
                            {showApply && (
                                <Tooltip content="Apply" showArrow singleLine>
                                    <IconButton
                                        icon={TickIcon}
                                        variant="ghost-secondary"
                                        iconClassName="font-color-green scale-12"
                                        onClick={onApply}
                                        disabled={actionButtonsDisabled}
                                    />
                                </Tooltip>
                            )}

                            {showReject && (
                                <Tooltip content="Reject" showArrow singleLine>
                                    <IconButton
                                        icon={CancelIcon}
                                        variant="ghost-secondary"
                                        iconClassName="font-color-red scale-90"
                                        onClick={onReject}
                                        disabled={actionButtonsDisabled}
                                    />
                                </Tooltip>
                            )}

                            {showUndo && (
                                <Tooltip content="Undo" showArrow singleLine>
                                    <IconButton
                                        icon={UndoIcon}
                                        variant="ghost-secondary"
                                        iconClassName="scale-10"
                                        onClick={handleUndo}
                                        disabled={actionButtonsDisabled}
                                    />
                                </Tooltip>
                            )}

                            {showRetry && (
                                <Tooltip content="Try again" showArrow singleLine>
                                    <IconButton
                                        icon={RepeatIcon}
                                        variant="ghost-secondary"
                                        iconClassName="scale-90"
                                        onClick={handleRetry}
                                        disabled={actionButtonsDisabled}
                                    />
                                </Tooltip>
                            )}
                        </>
                    ))}
                </div>
            </div>

            {displayedUndoError && (
                <div className="display-flex flex-row items-start gap-2 mx-3 mb-2 px-3 py-2 rounded-md bg-senary">
                    <div className="mt-010 flex-shrink-0">
                        <Icon icon={AlertIcon} className="font-color-secondary scale-90" />
                    </div>
                    <div className="text-sm font-color-secondary" style={{ lineHeight: '1.4' }}>
                        Could not undo automatically. The note may have been modified since this edit was applied. You can revert manually in the note editor.
                    </div>
                </div>
            )}
        </div>
    );
};

export default EditNoteRowView;
