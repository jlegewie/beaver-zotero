import React from 'react';

interface MetadataEdit {
    field: string;
    new_value: string;
}

interface AppliedEdit {
    field: string;
    applied_value: string;
}

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface EditMetadataPreviewProps {
    /** The proposed edits from action_data */
    edits: MetadataEdit[];
    /** Current values from current_value (field -> value) */
    currentValues: Record<string, string | null>;
    /** Applied edits from result_data (when status is 'applied') */
    appliedEdits?: AppliedEdit[];
    /** Current status of the action */
    status?: ActionStatus;
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
}) => {
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';

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
                                {/* New value - addition style (highlighted for applied, crossed out for rejected) */}
                                <div className={`diff-line ${isApplied ? 'diff-addition-applied' : isRejectedOrUndone ? 'diff-deletion' : isError ? 'diff-error' : 'diff-addition'}`}>
                                    <span className={`diff-content ${isRejectedOrUndone ? 'line-through opacity-60' : ''}`}>
                                        {displayValue ? truncateValue(displayValue) : <span className="italic opacity-60">(empty)</span>}
                                    </span>
                                </div>
                            </div>
                        </div>
                    );
                })}
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

export default EditMetadataPreview;
