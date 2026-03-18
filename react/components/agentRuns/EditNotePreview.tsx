import React from 'react';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface EditNotePreviewProps {
    /** The old string being replaced */
    oldString: string;
    /** The new replacement string */
    newString: string;
    /** Whether all occurrences are replaced */
    replaceAll?: boolean;
    /** Number of occurrences replaced (from result_data) */
    occurrencesReplaced?: number;
    /** Warnings from the edit */
    warnings?: string[];
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for edit_note actions.
 * Shows a diff-style before/after comparison of the string replacement.
 */
export const EditNotePreview: React.FC<EditNotePreviewProps> = ({
    oldString,
    newString,
    replaceAll,
    occurrencesReplaced,
    warnings,
    status = 'pending',
}) => {
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';
    const isDelete = newString === '';

    return (
        <div className="edit-note-preview">
            <div className="flex flex-col gap-3">
                {/* String replacement diff */}
                <div className="flex flex-col gap-1">
                    <div className="text-sm font-color-primary font-medium px-3 py-1">
                        {isDelete ? 'Delete' : 'Replace'}
                        {replaceAll ? ' (all occurrences)' : ''}
                        {occurrencesReplaced != null && occurrencesReplaced > 0
                            ? ` — ${occurrencesReplaced} occurrence${occurrencesReplaced === 1 ? '' : 's'}`
                            : ''}
                    </div>
                    <div className="diff-container">
                        {/* Old string - deletion style */}
                        <div className={`diff-line ${isApplied ? 'diff-deletion' : isRejectedOrUndone ? 'diff-neutral' : 'diff-deletion'}`}>
                            <span className="diff-content">
                                {truncateValue(stripHtmlTags(oldString))}
                            </span>
                        </div>
                        {/* New string - addition style (skip if delete) */}
                        {!isDelete && (
                            <div className={`diff-line ${isApplied ? 'diff-addition-applied' : isRejectedOrUndone ? 'diff-ghosted' : isError ? 'diff-error' : 'diff-addition'}`}>
                                <span className="diff-content">
                                    {truncateValue(stripHtmlTags(newString))}
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Warnings */}
                {warnings && warnings.length > 0 && (
                    <div className="px-3 py-1">
                        {warnings.map((warning, i) => (
                            <div key={i} className="text-xs font-color-secondary italic">
                                {warning}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Strip HTML tags for display, keeping just the text content.
 * Preserves self-closing tags like <citation/> as-is since they're meaningful.
 */
function stripHtmlTags(html: string): string {
    // Keep simplified tags like <citation/>, <annotation/>, <image/> as-is
    // Only strip standard HTML tags like <p>, <strong>, <em>, etc.
    return html
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<(?!\/?(?:citation|annotation|image)\b)[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Truncate long values for display
 */
function truncateValue(value: string, maxLength: number = 300): string {
    if (value.length <= maxLength) {
        return value;
    }
    return value.substring(0, maxLength) + '...';
}

export default EditNotePreview;
