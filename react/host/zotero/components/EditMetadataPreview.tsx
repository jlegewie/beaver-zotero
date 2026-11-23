import React from 'react';
import type { MetadataEdit, AppliedMetadataEdit, CreatorJSON, FailedMetadataEdit } from '@beaver/agent-core/types/agentActions/base';
import { resolveFieldForItemType } from '../../../../src/utils/zoteroUtils';
import { formatFieldName } from '../../../utils/fieldLabels';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface EditMetadataPreviewProps {
    /** The proposed edits from action_data */
    edits: MetadataEdit[];
    /** Current values from current_value (field -> value) */
    currentValues: Record<string, string | null>;
    /** Applied edits from result_data (when status is 'applied') */
    appliedEdits?: AppliedMetadataEdit[];
    /** Edits the apply could not set, from result_data; the rest were saved. */
    failedEdits?: FailedMetadataEdit[];
    /** Current status of the action */
    status?: ActionStatus;
    /** Old creators (before edit) */
    oldCreators?: CreatorJSON[] | null;
    /** New creators (proposed or applied) */
    newCreators?: CreatorJSON[] | null;
    /**
     * Item type ID of the edited item. Used to display the field that will
     * actually change: the agent may supply a label belonging to the wrong
     * item type (e.g. `bookTitle` on a journalArticle), which the edit handler
     * remaps via the shared base field to the type's equivalent
     * (`publicationTitle`). When omitted, the agent-supplied label is shown.
     */
    itemTypeID?: number;
}

/**
 * Preview component for edit_metadata actions.
 * Shows a diff-style before/after comparison for each field being edited.
 * Adapts display based on action status.
 */
export const EditMetadataPreview: React.FC<EditMetadataPreviewProps> = ({
    edits,
    currentValues,
    appliedEdits,
    failedEdits,
    status = 'pending',
    oldCreators,
    newCreators,
    itemTypeID,
}) => {
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';

    const hasCreatorChanges = newCreators && newCreators.length > 0;
    const failureFor = (field: string) => failedEdits?.find((failed) => failed.field === field);
    const failedCount = failedEdits?.length ?? 0;
    /** The diff style of a proposed value, by the action's status and whether its field failed. */
    const newValueClass = (failed: boolean) => failed
        ? 'diff-error'
        : isApplied ? 'diff-addition-applied' : isRejectedOrUndone ? 'diff-ghosted' : isError ? 'diff-error' : 'diff-addition';

    return (
        <div className="edit-metadata-preview">
            <div className="flex flex-col gap-3">
                {edits.map((edit, index) => {
                    const currentValue = currentValues[edit.field];
                    const appliedEdit = appliedEdits?.find(ae => ae.field === edit.field);
                    const failure = failureFor(edit.field);
                    const displayValue = appliedEdit?.applied_value ?? edit.new_value;
                    // Show the field that will actually change. The edit handler
                    // remaps a wrong-type label to the type's equivalent field;
                    // mirror that here so the preview matches the real outcome.
                    // currentValues/appliedEdits stay keyed by edit.field.
                    const displayField = itemTypeID != null
                        ? (resolveFieldForItemType(itemTypeID, edit.field) ?? edit.field)
                        : edit.field;

                    return (
                        <div
                            key={`${edit.field}-${index}`}
                            className="flex flex-col gap-1"
                        >
                            <div className="text-sm font-color-primary font-medium px-3 py-1">
                                {formatFieldName(displayField)}
                            </div>
                            <div className="diff-container">
                                {/* Old value - deletion style (show crossed out for applied, normal for others) */}
                                <div className={`diff-line ${isApplied ? 'diff-deletion' : isRejectedOrUndone ? 'diff-neutral' : 'diff-deletion'}`}>
                                    <span className={`diff-content`}>
                                        {currentValue ? truncateValue(currentValue) : <span className="italic opacity-60">(empty)</span>}
                                    </span>
                                </div>
                                {/* New value - addition style (highlighted for applied, ghosted for rejected) */}
                                <div className={`diff-line ${newValueClass(!!failure && isApplied)}`}>
                                    <span className="diff-content">
                                        {displayValue ? truncateValue(displayValue) : <span className="italic opacity-60">(empty)</span>}
                                    </span>
                                </div>
                            </div>
                            {failure && isApplied && (
                                <div className="text-sm font-color-red px-3">Not changed: {truncateValue(failureText(failure.error), 120)}</div>
                            )}
                        </div>
                    );
                })}

                {hasCreatorChanges && (
                    <div className="flex flex-col gap-1">
                        <div className="text-sm font-color-primary font-medium px-3 py-1">
                            Creators
                        </div>
                        <div className="diff-container">
                            {/* Old creators */}
                            <div className={`diff-line ${isApplied ? 'diff-deletion' : isRejectedOrUndone ? 'diff-neutral' : 'diff-deletion'}`}>
                                <span className="diff-content">
                                    {oldCreators && oldCreators.length > 0
                                        ? truncateValue(formatCreatorList(oldCreators))
                                        : <span className="italic opacity-60">(empty)</span>
                                    }
                                </span>
                            </div>
                            {/* New creators */}
                            <div className={`diff-line ${newValueClass(!!failureFor('creators') && isApplied)}`}>
                                <span className="diff-content">
                                    {truncateValue(formatCreatorList(newCreators))}
                                </span>
                            </div>
                        </div>
                        {failureFor('creators') && isApplied && (
                            <div className="text-sm font-color-red px-3">Not changed: {truncateValue(failureText(failureFor('creators')!.error), 120)}</div>
                        )}
                    </div>
                )}

                {isApplied && failedCount > 0 && (
                    <div className="text-sm font-color-secondary px-3">
                        {`${failedCount} of ${edits.length + (hasCreatorChanges ? 1 : 0)} changes could not be made; the others were saved.`}
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Truncate long values for display
 */
/** A field's failure as stored (`String(error)`), without the "Error: " prefix. */
function failureText(error: string): string {
    return error.replace(/^\w*Error:\s*/, '');
}

function truncateValue(value: string, maxLength: number = 150): string {
    if (value.length <= maxLength) {
        return value;
    }
    return value.substring(0, maxLength) + '...';
}

/**
 * Format a single creator for display.
 * Person creators: "FirstName LastName (type)"
 * Organization creators: "Name (type)"
 */
function formatCreator(creator: CreatorJSON): string {
    const name = creator.name
        ? creator.name
        : [creator.firstName, creator.lastName].filter(Boolean).join(' ');
    const type = creator.creatorType !== 'author' ? ` (${creator.creatorType})` : '';
    return `${name}${type}`;
}

/**
 * Format a list of creators as a semicolon-separated string.
 */
function formatCreatorList(creators: CreatorJSON[]): string {
    return creators.map(formatCreator).join('; ');
}

export default EditMetadataPreview;
