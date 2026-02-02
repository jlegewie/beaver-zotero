import React from 'react';
import type { MetadataEdit, AppliedMetadataEdit, CreatorJSON } from '../../types/agentActions/base';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface EditMetadataPreviewProps {
    /** The proposed edits from action_data */
    edits: MetadataEdit[];
    /** Current values from current_value (field -> value) */
    currentValues: Record<string, string | null>;
    /** Applied edits from result_data (when status is 'applied') */
    appliedEdits?: AppliedMetadataEdit[];
    /** Current status of the action */
    status?: ActionStatus;
    /** Old creators (before edit) */
    oldCreators?: CreatorJSON[] | null;
    /** New creators (proposed or applied) */
    newCreators?: CreatorJSON[] | null;
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
    status = 'pending',
    oldCreators,
    newCreators,
}) => {
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';

    const hasCreatorChanges = newCreators && newCreators.length > 0;

    return (
        <div className="edit-metadata-preview">
            <div className="flex flex-col gap-3">
                {edits.map((edit, index) => {
                    const currentValue = currentValues[edit.field];
                    const appliedEdit = appliedEdits?.find(ae => ae.field === edit.field);
                    const displayValue = appliedEdit?.applied_value ?? edit.new_value;

                    return (
                        <div
                            key={`${edit.field}-${index}`}
                            className="flex flex-col gap-1"
                        >
                            <div className="text-sm font-color-primary font-medium px-3 py-1">
                                {formatFieldName(edit.field)}
                            </div>
                            <div className="diff-container">
                                {/* Old value - deletion style (show crossed out for applied, normal for others) */}
                                <div className={`diff-line ${isApplied ? 'diff-deletion' : isRejectedOrUndone ? 'diff-neutral' : 'diff-deletion'}`}>
                                    <span className={`diff-content`}>
                                        {currentValue ? truncateValue(currentValue) : <span className="italic opacity-60">(empty)</span>}
                                    </span>
                                </div>
                                {/* New value - addition style (highlighted for applied, ghosted for rejected) */}
                                <div className={`diff-line ${isApplied ? 'diff-addition-applied' : isRejectedOrUndone ? 'diff-ghosted' : isError ? 'diff-error' : 'diff-addition'}`}>
                                    <span className="diff-content">
                                        {displayValue ? truncateValue(displayValue) : <span className="italic opacity-60">(empty)</span>}
                                    </span>
                                </div>
                            </div>
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
                            <div className={`diff-line ${isApplied ? 'diff-addition-applied' : isRejectedOrUndone ? 'diff-ghosted' : isError ? 'diff-error' : 'diff-addition'}`}>
                                <span className="diff-content">
                                    {truncateValue(formatCreatorList(newCreators))}
                                </span>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Format field names for display (camelCase -> Title Case)
 */
function formatFieldName(field: string): string {
    // Common field name mappings
    const fieldNames: Record<string, string> = {
        abstractNote: 'Abstract',
        publicationTitle: 'Publication',
        DOI: 'DOI',
        ISBN: 'ISBN',
        ISSN: 'ISSN',
        url: 'URL',
        shortTitle: 'Short Title',
        seriesNumber: 'Series Number',
        seriesTitle: 'Series Title',
        archiveLocation: 'Archive Location',
        callNumber: 'Call Number',
    };

    if (fieldNames[field]) {
        return fieldNames[field];
    }

    // Convert camelCase to Title Case
    return field
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, (str) => str.toUpperCase())
        .trim();
}

/**
 * Truncate long values for display
 */
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
