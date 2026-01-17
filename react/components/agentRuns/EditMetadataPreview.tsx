import React from 'react';

interface MetadataEdit {
    field: string;
    new_value: string;
}

interface EditMetadataPreviewProps {
    /** The proposed edits from action_data */
    edits: MetadataEdit[];
    /** Current values from current_value (field -> value) */
    currentValues: Record<string, string | null>;
}

/**
 * Preview component for edit_metadata actions.
 * Shows a diff-style before/after comparison for each field being edited.
 */
export const EditMetadataPreview: React.FC<EditMetadataPreviewProps> = ({ edits, currentValues }) => {
    return (
        <div className="edit-metadata-preview">
            <div className="text-sm font-color-secondary mb-2">
                Proposed metadata changes:
            </div>
            <div className="flex flex-col gap-3">
                {edits.map((edit, index) => {
                    const currentValue = currentValues[edit.field];

                    return (
                        <div
                            key={`${edit.field}-${index}`}
                            className="flex flex-col gap-1"
                        >
                            <div className="text-xs font-color-secondary font-medium mb-1">
                                {formatFieldName(edit.field)}
                            </div>
                            <div className="diff-container">
                                {/* Old value - deletion style */}
                                <div className="diff-line diff-deletion">
                                    <span className="diff-content">
                                        {currentValue ? truncateValue(currentValue) : <span className="italic opacity-60">(empty)</span>}
                                    </span>
                                </div>
                                {/* New value - addition style */}
                                <div className="diff-line diff-addition">
                                    <span className="diff-content">
                                        {edit.new_value ? truncateValue(edit.new_value) : <span className="italic opacity-60">(empty)</span>}
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
